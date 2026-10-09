"use strict"

// M1 gateway: real native modules, HTTP handlers and synchronous workflows.
// The explicit route and field allowlists keep unported M2 domains unreachable.
const { AsyncLocalStorage } = require("node:async_hooks")
const crypto = require("node:crypto")
const express = require("express")
const session = require("express-session")
const jwt = require("jsonwebtoken")
const { Pool } = require("pg")
const {
  createTenantVerifier,
  runWithTenant,
  currentTenant,
  TenantSecurityError,
} = require("./tenant-context.cjs")
const { wrapTenantModule } = require("./tenant-module.cjs")
const {
  installTenantScopedAuth,
  runWithAuthActor,
  attachTenantActor,
} = require("./auth-integration.cjs")
const { createTenantControl } = require("./tenant-control.cjs")

const native = (path) => require(`@medusajs/medusa/api/${path}`)
const asyncHandler = (fn) => (req, res, next) => {
  const invoke = () => Promise.resolve(fn(req, res, next))
  return (req.saasTrackHandler ? req.saasTrackHandler(invoke) : invoke()).catch(next)
}
function deny(code, message) {
  throw new TenantSecurityError(code, message)
}

const ROUTES = [
  ["GET", /^\/health$/],
  ["POST", /^\/platform\/tenants$/],
  ["POST", /^\/auth\/(user|customer)\/emailpass$/],
  ["POST", /^\/auth\/customer\/emailpass\/register$/],
  ["POST", /^\/auth\/session$/],
  ["DELETE", /^\/auth\/session$/],
  ["GET", /^\/admin\/users\/me$/],
  ["GET", /^\/admin\/products$/],
  ["POST", /^\/admin\/products$/],
  ["GET", /^\/admin\/products\/prod_[A-Za-z0-9]+$/],
  ["POST", /^\/admin\/products\/prod_[A-Za-z0-9]+$/],
  ["DELETE", /^\/admin\/products\/prod_[A-Za-z0-9]+$/],
  ["GET", /^\/store\/products$/],
  ["GET", /^\/store\/products\/prod_[A-Za-z0-9]+$/],
  ["POST", /^\/store\/customers$/],
  ["GET", /^\/store\/customers\/me$/],
]
const PRODUCT_FIELDS = [
  "id",
  "title",
  "handle",
  "status",
  "subtitle",
  "description",
  "thumbnail",
  "created_at",
  "updated_at",
  "*type",
  "*collection",
  "*tags",
  "*categories",
  "*images",
  "*options",
  "*options.values",
  "*variants",
  "*variants.options",
  "*variants.images",
  "*variants.prices",
  "variants.prices.id",
  "variants.prices.amount",
  "variants.prices.currency_code",
  "variants.prices.price_rules.value",
  "variants.prices.price_rules.attribute",
]
const STORE_FIELDS = [
  "id",
  "title",
  "handle",
  "status",
  "description",
  "thumbnail",
  "images.id",
  "images.url",
  "variants.id",
  "variants.title",
  "variants.sku",
  "variants.price_set.id",
  "variants.price_set.prices.id",
  "variants.price_set.prices.amount",
  "variants.price_set.prices.currency_code",
  "options.id",
  "options.title",
  "options.values.id",
  "options.values.value",
]
const adminProductFieldsAllowed = new Set(PRODUCT_FIELDS)
const storeProductFieldsAllowed = new Set(STORE_FIELDS)

function rejectTenantInput(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (["tenant_id", "tenantId"].includes(key))
      deny("TENANT_FIELD_FORBIDDEN", "Tenant identity is managed by the server")
    rejectTenantInput(value[key], seen)
  }
}

async function bootNative(databaseUrl, { jwtSecret, commerce = false }) {
  const { MedusaApp } = require("@medusajs/framework/modules-sdk")
  const {
    createPgConnection,
    ContainerRegistrationKeys,
    Modules,
  } = require("@medusajs/framework/utils")
  const connection = createPgConnection({
    clientUrl: databaseUrl,
    schema: "public",
    pool: { min: 0, max: 4 },
  })
  const modules = {
    product: { resolve: "@medusajs/product" },
    pricing: { resolve: "@medusajs/pricing" },
    user: { resolve: "@medusajs/user", options: { jwt_secret: jwtSecret } },
    customer: { resolve: "@medusajs/customer" },
    auth: {
      resolve: "@medusajs/auth",
      options: {
        providers: [{ resolve: "@medusajs/auth-emailpass", id: "emailpass" }],
      },
    },
    inventory: { resolve: "@medusajs/inventory" },
    event_bus: { resolve: "@medusajs/event-bus-local" },
  }
  if (commerce) {
    for (const name of [
      "cart",
      "order",
      "payment",
      "stock-location",
      "sales-channel",
      "region",
      "tax",
      "promotion",
      "api-key",
      "store",
    ]) {
      modules[name.replaceAll("-", "_")] = { resolve: `@medusajs/${name}` }
    }
    modules.fulfillment = {
      resolve: "@medusajs/fulfillment",
      options: {
        providers: [{ resolve: "@medusajs/fulfillment-manual", id: "manual" }],
      },
    }
    modules.workflows = { resolve: "@medusajs/workflow-engine-inmemory" }
  }
  const config = {
    modules,
    projectConfig: {
      http: {
        jwtSecret,
        jwtExpiresIn: "1h",
        jwtOptions: {
          algorithm: "HS256",
          issuer: "medusa-saas",
          audience: "medusa-saas-native",
        },
        cookieSecret: jwtSecret,
      },
      sessionOptions: { name: "medusa.saas.sid" },
      cookieOptions: { sameSite: "lax", httpOnly: true },
    },
  }
  const app = await MedusaApp({
    modulesConfig: modules,
    sharedResourcesConfig: {
      database: {
        clientUrl: databaseUrl,
        schema: "public",
        pool: { min: 0, max: 4 },
      },
    },
    injectedDependencies: {
      [ContainerRegistrationKeys.PG_CONNECTION]: connection,
      [ContainerRegistrationKeys.LOGGER]: console,
      [ContainerRegistrationKeys.CONFIG_MODULE]: config,
    },
  })
  return {
    app,
    connection,
    config,
    close: async () => {
      await app.onApplicationPrepareShutdown()
      await app.onApplicationShutdown()
      await connection.destroy()
      require("@medusajs/framework/modules-sdk").MedusaModule.clearInstances()
    },
  }
}

async function createM1Application({
  databaseUrl,
  baseDomain,
  jwtSecret,
  contextSecret,
  namespaceSecret,
  platformKey,
  platformActorId,
  secureCookies = true,
  commerce = false,
  objectRoot,
  browser = false,
  trustedProxy = false,
  frontend,
  payments = false,
  paymentKey,
  testStripeFactory,
  operations = false,
}) {
  if (process.env.MEDUSA_SAAS_MODE !== "true")
    throw new Error("M1 requires MEDUSA_SAAS_MODE=true before loading modules")
  if (browser && !commerce) throw new Error("M3 requires the M2 commerce boundary")
  if (payments && !browser) throw new Error("M4 requires the M3 browser boundary")
  if (operations && !payments) throw new Error("M5 requires the M4 payment boundary")
  if(operations && (typeof objectRoot!=="string"||!require("node:path").isAbsolute(objectRoot)))throw new Error("M5 requires an absolute SAAS_OBJECT_ROOT")
  if (
    typeof databaseUrl !== "string" ||
    !databaseUrl ||
    typeof platformActorId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(platformActorId)
  ) {
    throw new TypeError(
      "Runtime database URL and platform actor ID are required"
    )
  }
  for (const [name, secret] of Object.entries({
    jwtSecret,
    contextSecret,
    namespaceSecret,
    platformKey,
  })) {
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
      throw new TypeError(`${name} must contain at least 32 bytes`)
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const verificationConnection = await pool.connect()
  try {
    await require("./migrate-m1.cjs").verifyM1Runtime(verificationConnection)
    if (commerce)
      await require("./migrate-m2.cjs").verifyM2Runtime(verificationConnection)
    if (payments)
      await require("./migrate-m4.cjs").verifyM4Runtime(verificationConnection)
    if (operations)
      await require("./migrate-m5.cjs").verifyM5Runtime(verificationConnection)
    else if((await verificationConnection.query("SELECT 1 FROM saas_control.isolation_migration WHERE id='0007-operations'")).rowCount)
      throw new Error("An M5 database requires the M5 runtime; restore a matching backup for code rollback")
  } catch (error) {
    verificationConnection.release()
    await pool.end()
    throw error
  }
  verificationConnection.release()
  let nativeResources
  try {
    nativeResources = await bootNative(databaseUrl, { jwtSecret, commerce })
    const { app: nativeApp, config, close: closeNative } = nativeResources
    const { MedusaModule } = require("@medusajs/framework/modules-sdk")
    const { ContainerRegistrationKeys } = require("@medusajs/framework/utils")
    const { asValue } = require("@medusajs/framework/awilix")
    const wrapModule = (module) => wrapTenantModule(module, {
      orchestrationMethods: module === nativeApp.modules.workflows
        ? ["run", "getRunningTransaction", "retryStep", "setStepSuccess", "setStepFailure"]
        : [],
    })
    for (const module of Object.values(nativeApp.modules))
      if (module.baseRepository_) wrapModule(module)
    for (const loaded of MedusaModule.getLoadedModules()) {
      for (const module of Object.values(loaded))
        if (module?.baseRepository_) wrapModule(module)
    }
    const { auth, user, customer } = nativeApp.modules
    installTenantScopedAuth(auth, { namespaceSecret, enabled: true })
    const query = nativeApp.query
    const originalGraph = query.graph.bind(query)
    query.graph = async (input, options = {}) => {
      currentTenant()
      const catalog = await require("./m6-catalog-query.cjs").catalogChannelIds(pool,input,options)
      if (catalog) return catalog
      return originalGraph(input, { ...options, cache: { enable: false } })
    }
    const remoteQuery = (input, options) => {
      currentTenant()
      // Native catalog workflows ask optional M2 links for an empty ID set.
      // An empty conjunctive selection cannot return any records; avoid resolving
      // a disabled module. Nonempty queries retain the native implementation.
      const filters = input.variables?.filters ?? input.variables
      if (
        filters &&
        Object.keys(filters).every((key) => !key.startsWith("$")) &&
        Object.values(filters).some(
          (value) => Array.isArray(value) && !value.length
        ) &&
        !options?.throwIfKeyNotFound &&
        !options?.throwIfRelationNotFound
      )
        return Promise.resolve([])
      return query(input, options)
    }
    nativeApp.sharedContainer.register({
      [ContainerRegistrationKeys.QUERY]: asValue(query),
      [ContainerRegistrationKeys.REMOTE_QUERY]: asValue(remoteQuery),
      [ContainerRegistrationKeys.LINK]: asValue(nativeApp.link),
      [ContainerRegistrationKeys.REMOTE_LINK]: asValue(nativeApp.link),
    })
    const openingCredentials = new AsyncLocalStorage()
    let control, m5Runtime
    const m2Runtime = commerce
      ? require("./m2-runtime.cjs").installM2Runtime({
          nativeApp,
          pool,
          contextSecret,
          objectRoot,
          getControl: () => control,
          getOperations: () => m5Runtime,
        })
      : undefined
    const m3Runtime = browser
      ? require("./m3-runtime.cjs").createM3Runtime({ nativeApp, m2Runtime, payments })
      : undefined
    const m4Runtime = payments
      ? require("./m4-runtime.cjs").createM4Runtime({nativeApp,pool,m2Runtime,contextSecret,paymentKey,testStripeFactory,getControl:() => control,operations})
      : undefined
    const issueContext = (tenantId, actorId) =>
      jwt.sign({ tenant_id: tenantId }, contextSecret, {
        algorithm: "HS256",
        subject: actorId,
        issuer: "medusa-saas-context",
        audience: "internal-context",
        expiresIn: "5m",
      })
    const publicVerifier = createTenantVerifier({
      secret: contextSecret,
      issuer: "medusa-saas-context",
      audience: "internal-context",
      lookupMembership: async ({ tenantId, actorId }) =>
        actorId === "public" &&
        ["active", ...(operations ? ["suspended"] : [])].includes((await control.getTenant(tenantId))?.status),
    })
    const bootstrapVerifier = createTenantVerifier({
      secret: contextSecret,
      issuer: "medusa-saas-context",
      audience: "internal-context",
      lookupMembership: async ({ tenantId, actorId }) => {
        const row = await control.getTenant(tenantId)
        return (
          row?.ownerActorId === actorId &&
          ["pending", "failed", "active"].includes(row.status)
        )
      },
    })
    control = createTenantControl(pool, {
      baseDomain,
      initializeTenant: async (tenant) => {
        const credentials = openingCredentials.getStore()
        if (!credentials)
          deny(
            "TENANT_INITIALIZER_REQUIRED",
            "Server owner credentials are required for initialization"
          )
        const context = await bootstrapVerifier(
          issueContext(tenant.tenantId, tenant.ownerActorId)
        )
        await runWithTenant(context, () =>
          runWithAuthActor("user", async () => {
            let actors = await user.listUsers({ id: tenant.ownerActorId })
            if (!actors.length)
              actors = [
                await user.createUsers({
                  id: tenant.ownerActorId,
                  email: credentials.email.toLowerCase(),
                }),
              ]
            if (actors[0].email !== credentials.email.toLowerCase())
              deny(
                "TENANT_INITIALIZATION_CONFLICT",
                "Owner credentials changed"
              )
            // register verifies the existing password before binding an identity
            // left unbound by a crash. A fully bound identity then falls back to login.
            let result = await auth.register("emailpass", { body: credentials })
            if (!result.success)
              result = await auth.authenticate("emailpass", {
                body: credentials,
              })
            if (!result.success)
              deny(
                "TENANT_INITIALIZATION_FAILED",
                "Owner authentication could not be initialized"
              )
            await attachTenantActor(auth, {
              authIdentityId: result.authIdentity.id,
              actorType: "user",
              actorId: tenant.ownerActorId,
              actorService: user,
            })
            if (m2Runtime) await m2Runtime.initializeTenant(tenant)
            if (m3Runtime) await m3Runtime.initializeTenant(tenant)
          })
        )
      },
    })
    if (operations) m5Runtime = require("./m5-runtime.cjs").createM5Runtime({pool,databaseUrl,contextSecret,platformKey,platformActorId,baseDomain:control.baseDomain,getControl:()=>control,m2Runtime,m4Runtime})
    const web = express()
    web.disable("x-powered-by")
    if (m5Runtime) web.use(m5Runtime.observe)
    web.use(require("./browser-security.cjs").configureBrowserSecurity(web, trustedProxy))
    if (m5Runtime) web.use(asyncHandler(m5Runtime.middleware))
    if (frontend) {
      if (!m3Runtime) throw new Error("Frontend routing requires M3")
      require("./m3-frontend.cjs").mountFrontend(web, control, {...frontend,operations})
    }
    if (m4Runtime) m4Runtime.mountCallbacks(web,{asyncHandler})
    web.use(express.json({ limit: "256kb", strict: true }))
    if (m5Runtime) m5Runtime.mountPlatform(web,{asyncHandler})
    const persistentSession = commerce
      ? require("./tenant-session.cjs").createTenantSessionStore({
          pool,
          secret: contextSecret,
        })
      : undefined
    if (persistentSession) web.use(persistentSession.middleware)
    web.use(
      session({
        name: "medusa.saas.sid",
        secret: contextSecret,
        resave: false,
        saveUninitialized: false,
        ...(persistentSession ? { store: persistentSession.store } : {}),
        cookie: {
          httpOnly: true,
          sameSite: "lax",
          secure: secureCookies,
          maxAge: 60 * 60 * 1000,
        },
      })
    )
    web.use((req, res, next) => {
      if (
        ![...ROUTES, ...(m2Runtime?.routes || []), ...(m3Runtime?.routes || []), ...(m4Runtime?.routes || []), ...(m5Runtime?.routes || [])].some(
          ([method, path]) => method === req.method && path.test(req.path)
        )
      )
        return res.status(404).json({
          code: "M1_ROUTE_DISABLED",
          message: "Endpoint is unavailable",
        })
      next()
    })
    if (!m5Runtime) web.get("/health", (req, res) =>
      res.json({ stage: payments ? "M4" : browser ? "M3" : commerce ? "M2" : "M1", ready: true })
    )
    web.post(
      "/platform/tenants",
      asyncHandler(async (req, res) => {
        if(m5Runtime) await m5Runtime.platformAuth(req,res,()=>{})
        const token = req.headers.authorization?.match(/^Bearer ([^ ]+)$/)?.[1]
        if (
          !token ||
          Buffer.byteLength(token) !== Buffer.byteLength(platformKey) ||
          !crypto.timingSafeEqual(
            Buffer.from(token),
            Buffer.from(platformKey)
          ) ||
          !(await control.authorizePlatformAdmin(platformActorId))
        ) {
          return res.status(401).json({
            code: "PLATFORM_AUTHENTICATION_REQUIRED",
            message: "Unauthorized",
          })
        }
        rejectTenantInput(req.body)
        const {
          slug,
          name,
          email,
          password,
          idempotency_key: key,
          ...unknown
        } = req.body || {}
        if (
          Object.keys(unknown).length ||
          typeof key !== "string" ||
          !/^[A-Za-z0-9_-]{8,128}$/.test(key) ||
          typeof email !== "string" ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          typeof password !== "string" ||
          password.length < 12 ||
          password.length > 256
        ) {
          return res.status(400).json({
            code: "INVALID_OPEN_TENANT",
            message:
              "Valid owner email, password and idempotency_key are required",
          })
        }
        const ownerActorId =
          "usr_" +
          crypto
            .createHmac("sha256", namespaceSecret)
            .update(JSON.stringify(["owner", key]))
            .digest("hex")
            .slice(0, 26)
        const initializationFingerprint = crypto
          .createHmac("sha256", namespaceSecret)
          .update(JSON.stringify([email.toLowerCase(), password]))
          .digest("hex")
        const tenant = await openingCredentials.run({ email, password }, () =>
          control.openTenant({
            ownerActorId,
            actorId: platformActorId,
            slug,
            name,
            idempotencyKey: key,
            initializationFingerprint,
          })
        )
        res.status(tenant.status === "active" ? 201 : 202).json({
          tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            status: tenant.status,
            public_key: tenant.publicKey,
            hostname: `${tenant.slug}.${baseDomain}`,
          },
        })
      })
    )
    web.use(
      asyncHandler(async (req, res, next) => {
        rejectTenantInput(req.body)
        rejectTenantInput(req.query)
        for (const header of [
          "x-tenant-id",
          "tenant-id",
          "tenant_id",
          "x-forwarded-host",
        ]) {
          if (req.headers[header] !== undefined)
            deny(
              "TENANT_HEADER_FORBIDDEN",
              "Tenant and forwarded host headers are not accepted"
            )
        }
        const tenant = await control.resolveDomain(req.headers.host,{allowSuspended:operations})
        if (!tenant)
          return res
            .status(404)
            .json({ code: "TENANT_NOT_FOUND", message: "Store is unavailable" })
        if (
          ["x-publishable-api-key", "x-publishable-key"].some((name) =>
            req.headers[name] !== undefined && req.headers[name] !== tenant.publicKey
          )
        ) {
          deny(
            "TENANT_PUBLISHABLE_KEY_MISMATCH",
            "Store key does not match the hostname"
          )
        }
        const context = await publicVerifier(issueContext(tenant.id, "public"))
        req.scope = nativeApp.sharedContainer.createScope()
        req.scope.register({
          [ContainerRegistrationKeys.CONFIG_MODULE]: asValue(config),
        })
        req.tenant = tenant
        req.locale = undefined
        let verifiedClaims
        await runWithTenant(context, async () => {
          let claims
          const header = req.headers.authorization
          if (header !== undefined) {
            const token = header.match(/^Bearer ([^ ]+)$/)?.[1]
            if (!token)
              deny(
                "TENANT_AUTHENTICATION_FAILED",
                "Only bound bearer or session authentication is accepted"
              )
            try {
              claims = jwt.verify(token, jwtSecret, {
                algorithms: ["HS256"],
                issuer: "medusa-saas",
                audience: "medusa-saas-native",
              })
            } catch {
              deny("TENANT_AUTHENTICATION_FAILED", "Invalid or expired session")
            }
          } else if (req.session.auth_context) claims = req.session.auth_context
          if (claims) {
            if (
              !Number.isSafeInteger(claims.exp) ||
              claims.exp * 1000 <= Date.now() ||
              claims.app_metadata?.tenant_id !== tenant.id ||
              claims.app_metadata?.saas_actor_type !== claims.actor_type ||
              !["user", "customer"].includes(claims.actor_type)
            ) {
              deny(
                "TENANT_AUTH_SCOPE_MISMATCH",
                "Session does not belong to this store"
              )
            }
            const identity = await auth.retrieveAuthIdentity(
              claims.auth_identity_id
            )
            const metadata = identity.app_metadata || {}
            if (
              metadata.tenant_id !== tenant.id ||
              metadata.saas_actor_type !== claims.actor_type ||
              (metadata[`${claims.actor_type}_id`] || "") !== claims.actor_id
            )
              deny("TENANT_AUTH_SCOPE_MISMATCH", "Identity binding is invalid")
            if (claims.actor_id) {
              const actors = claims.actor_type === "user" ? user : customer
              await actors[
                claims.actor_type === "user"
                  ? "retrieveUser"
                  : "retrieveCustomer"
              ](claims.actor_id)
              if (
                claims.actor_type === "user" &&
                (claims.actor_id !== tenant.ownerActorId ||
                  !(await control.authorizeMembership({
                    tenantId: tenant.id,
                    actorId: claims.actor_id,
                    allowSuspended:operations,
                  })))
              )
                deny(
                  "TENANT_MEMBERSHIP_REQUIRED",
                  "Active owner membership is required"
                )
            }
            req.auth_context = claims
            verifiedClaims = claims
          }
          if (
            req.path.startsWith("/admin/") &&
            (!claims?.actor_id || claims.actor_type !== "user")
          )
            deny(
              "TENANT_AUTHENTICATION_FAILED",
              "Store owner authentication required"
            )
          if (
            req.path === "/store/customers/me" &&
            (!claims?.actor_id || claims.actor_type !== "customer")
          )
            deny(
              "TENANT_AUTHENTICATION_FAILED",
              "Customer authentication required"
            )
          if (
            req.path === "/store/customers" &&
            (!claims?.auth_identity_id ||
              claims.actor_type !== "customer" ||
              claims.actor_id)
          )
            deny(
              "TENANT_AUTHENTICATION_FAILED",
              "Unregistered customer token required"
            )
          if (req.path === "/auth/session" && !claims?.actor_id)
            deny("TENANT_AUTHENTICATION_FAILED", "Registered actor required")
          if (req.query.fields !== undefined) {
            const allowedFields =
              m4Runtime?.allowedFields(req.path, req.method) ||
              m3Runtime?.allowedFields(req.path, req.method) ||
              m2Runtime?.allowedFields(req.path) ||
              (req.path.startsWith("/store/") ? storeProductFieldsAllowed : adminProductFieldsAllowed)
            if (
              typeof req.query.fields !== "string" ||
              req.query.fields
                .split(",")
                .some((field) => !allowedFields.has(field.replace(/^[+-]/, "")))
            ) {
              deny("M1_FIELD_DISABLED", "Only reviewed fields are available")
            }
          }
        })
        const actorId =
          verifiedClaims?.actor_id ||
          verifiedClaims?.auth_identity_id ||
          "public"
        const requestVerifier = createTenantVerifier({
          secret: contextSecret,
          issuer: "medusa-saas-context",
          audience: "internal-context",
          lookupMembership: async (identity) =>
            identity.tenantId === tenant.id && identity.actorId === actorId,
        })
        const requestContext = await requestVerifier(
          issueContext(tenant.id, actorId)
        )
        const actorType = /^\/auth\/(user|customer)\//.exec(req.path)?.[1]
        return runWithTenant(requestContext, () =>
          actorType ? runWithAuthActor(actorType, next) : next()
        )
      })
    )
    const {
      authenticate,
      validateAndTransformBody,
      validateAndTransformQuery,
    } = require("@medusajs/framework/http")
    const pv = native("admin/products/validators")
    const sv = native("store/products/validators")
    const productConfig = (isList) => ({
      defaults: PRODUCT_FIELDS,
      allowed: PRODUCT_FIELDS,
      isList,
      defaultLimit: 50,
    })
    const storeConfig = (isList) => ({
      defaults: STORE_FIELDS,
      allowed: STORE_FIELDS,
      isList,
      defaultLimit: 50,
    })
    const owner = authenticate("user", ["bearer", "session"])
    const catGuard = asyncHandler(async (req, res, next) => {
      const data = req.body || {}
      if (
        !commerce &&
        (data.shipping_profile_id ||
          data.sales_channels?.length ||
          data.additional_data ||
          data.variants?.some(
            (v) =>
              v.manage_inventory !== false ||
              v.inventory_items?.length ||
              v.price_set_id
          ))
      ) {
        return res.status(400).json({
          code: "M1_COMMERCE_FEATURE_DISABLED",
          message:
            "Inventory, fulfillment and sales channels are enabled in M2",
        })
      }
      const productService = nativeApp.modules.product
      if (commerce) await m2Runtime.guardProduct(data)
      if (data.collection_id)
        await productService.retrieveProductCollection(data.collection_id)
      if (data.type_id) await productService.retrieveProductType(data.type_id)
      for (const tag of data.tags || [])
        if (tag.id) await productService.retrieveProductTag(tag.id)
      for (const category of data.categories || [])
        if (category.id)
          await productService.retrieveProductCategory(category.id)
      for (const option of data.options || [])
        if (option.id) await productService.retrieveProductOption(option.id)
      for (const variant of data.variants || [])
        if (variant.id) {
          const existing = await productService.retrieveProductVariant(
            variant.id
          )
          if (!req.params.id || existing.product_id !== req.params.id) {
            const { MedusaError } = require("@medusajs/framework/utils")
            throw new MedusaError(
              MedusaError.Types.NOT_FOUND,
              "Variant does not belong to the requested product"
            )
          }
        }
      next()
    })
    if (m5Runtime) m5Runtime.mount(web,{asyncHandler,owner})
    if (m4Runtime) m4Runtime.mount(web,{asyncHandler,owner})
    if (m3Runtime)
      m3Runtime.mount(web, { asyncHandler, owner, catGuard,
        validateAndTransformBody, validateAndTransformQuery })
    const authRoute = native("auth/[actor_type]/[auth_provider]/route")
    const registerRoute = native(
      "auth/[actor_type]/[auth_provider]/register/route"
    )
    web.post(
      "/auth/:actor_type/emailpass",
      (req, res, next) => {
        req.params.auth_provider = "emailpass"
        next()
      },
      asyncHandler(authRoute.POST)
    )
    web.post(
      "/auth/customer/emailpass/register",
      (req, res, next) => {
        req.params.actor_type = "customer"
        req.params.auth_provider = "emailpass"
        next()
      },
      asyncHandler(registerRoute.POST)
    )
    const sessionRoute = native("auth/session/route")
    web.post(
      "/auth/session",
      asyncHandler(async (req, res) => {
        await new Promise((resolve, reject) =>
          req.session.regenerate((error) => (error ? reject(error) : resolve()))
        )
        return sessionRoute.POST(req, res)
      })
    )
    web.delete("/auth/session", asyncHandler(sessionRoute.DELETE))
    web.get(
      "/admin/users/me",
      owner,
      (req, res, next) => {
        req.queryConfig = { fields: ["id", "email", "first_name", "last_name"] }
        next()
      },
      asyncHandler(native("admin/users/me/route").GET)
    )
    const catalog = native("admin/products/route")
    const productRoute = native("admin/products/[id]/route")
    web.get(
      "/admin/products",
      owner,
      validateAndTransformQuery(pv.AdminGetProductsParams, productConfig(true)),
      asyncHandler(catalog.GET)
    )
    web.post(
      "/admin/products",
      owner,
      catGuard,
      validateAndTransformBody(pv.AdminCreateProduct),
      validateAndTransformQuery(pv.AdminGetProductParams, productConfig(false)),
      asyncHandler(catalog.POST)
    )
    web.get(
      "/admin/products/:id",
      owner,
      validateAndTransformQuery(pv.AdminGetProductParams, productConfig(false)),
      asyncHandler(productRoute.GET)
    )
    web.post(
      "/admin/products/:id",
      owner,
      catGuard,
      validateAndTransformBody(pv.AdminUpdateProduct),
      validateAndTransformQuery(pv.AdminGetProductParams, productConfig(false)),
      asyncHandler(productRoute.POST)
    )
    web.delete(
      "/admin/products/:id",
      owner,
      asyncHandler(async (req, res) => {
        await nativeApp.modules.product.retrieveProduct(req.params.id)
        return productRoute.DELETE(req, res)
      })
    )
    const published = (req, res, next) => {
      req.filterableFields.status = "published"
      next()
    }
    web.get(
      "/store/products",
      validateAndTransformQuery(sv.StoreGetProductsParams, storeConfig(true)),
      published,
      asyncHandler(native("store/products/route").GET)
    )
    web.get(
      "/store/products/:id",
      validateAndTransformQuery(sv.StoreGetProductsParams, storeConfig(false)),
      published,
      asyncHandler(native("store/products/[id]/route").GET)
    )
    const cv = native("store/customers/validators")
    web.post(
      "/store/customers",
      validateAndTransformBody(cv.StoreCreateCustomer),
      asyncHandler(async (req, res) => {
        const identity = await auth.retrieveAuthIdentity(
          req.auth_context.auth_identity_id,
          { relations: ["provider_identities"] }
        )
        const email = req.validatedBody.email?.toLowerCase()
        const digest = crypto
          .createHmac("sha256", namespaceSecret)
          .update(JSON.stringify(["v1", req.tenant.id, "customer", email]))
          .digest("hex")
        if (
          !email ||
          !identity.provider_identities?.some(
            (provider) =>
              provider.provider === "emailpass" &&
              provider.entity_id === `saas:v1:${digest}@identity.invalid`
          )
        ) {
          deny(
            "TENANT_AUTH_EMAIL_MISMATCH",
            "Customer email must match the registered identity"
          )
        }
        // Registration is idempotent by auth identity; deterministic native ID
        // prevents duplicate actors if a retry follows an interrupted attachment.
        const id =
          "cus_" +
          crypto
            .createHash("sha256")
            .update(identity.id)
            .digest("hex")
            .slice(0, 26)
        let actors = await customer.listCustomers({ id })
        if (!actors.length)
          actors = [
            await customer.createCustomers({
              id,
              ...req.validatedBody,
              has_account: true,
            }),
          ]
        await attachTenantActor(auth, {
          authIdentityId: identity.id,
          actorType: "customer",
          actorId: id,
          actorService: customer,
        })
        const { tenant_id, ...dto } = actors[0]
        res.json({ customer: dto })
      })
    )
    web.get(
      "/store/customers/me",
      asyncHandler(async (req, res) => {
        const { tenant_id, ...dto } = await customer.retrieveCustomer(
          req.auth_context.actor_id
        )
        res.json({ customer: dto })
      })
    )
    if (m2Runtime)
      m2Runtime.mount(web, {
        asyncHandler,
        owner,
        validateAndTransformBody,
        validateAndTransformQuery,
        cartFields: m3Runtime?.cartFields,
        orderFields: m3Runtime?.orderFields,
        m4Runtime,
      })
    web.use((error, req, res, next) => {
      const status =
        operations && error.statusCode ? error.statusCode :
        error.code === "P5001" ? 409 :
        error.code === "M1_FIELD_DISABLED" ||
        error.code?.includes("FIELD_FORBIDDEN") ||
        error.code?.includes("HEADER_FORBIDDEN")
          ? 400
          : error.code === "TENANT_BROWSER_ORIGIN_FORBIDDEN"
          ? 403
          : error.type === "entity.too.large" || error.code === "LIMIT_FILE_SIZE"
          ? 413
          : error.type === "entity.parse.failed" || error.name === "MulterError"
          ? 400
          : error.code === "TENANT_FILE_NOT_FOUND"
          ? 404
          : error.code?.endsWith("_CONFLICT")
          ? 409
          : error.name === "TenantSecurityError"
          ? 401
          : error.type === "not_found"
          ? 404
          : ["invalid_data", "invalid_argument"].includes(error.type) ||
            error.name === "ZodError"
          ? 400
          : error.type === "unauthorized"
          ? 401
          : error.type === "not_allowed"
          ? 409
          : error.type === "duplicate_error" ||
            error.code?.includes("CONFLICT") ||
            error.code === "23505" ||
            error.constructor.name === "UniqueConstraintViolationException"
          ? 409
          : error.name === "TenantControlError"
          ? 400
          : 500
      if (status === 500)
        console.error("M1 request failed", {
          type: error.type,
          code: error.code,
          name: error.name,
          ...(!operations ? {message: error.message} : {}),
        })
      if(operations) req.saasErrorCode=m5Runtime.safeCode(error.code||error.type||error.name)
      if(status===429)res.set("Retry-After","60")
      if(error.code==="SAAS_ADMISSION_CONFLICT")res.set("Retry-After","1")
      res.status(status).json({
        code: operations ? (error.code==="P5001"?"SAAS_QUOTA_EXCEEDED":req.saasErrorCode) : error.code || error.type || "M1_REQUEST_FAILED",
        message: error.code==="P5001" ? "Plan quota exceeded or below current usage" : status === 500 ? "Request failed" : error.message,
      })
    })
    await nativeApp.onApplicationStart()
    return {
      web,
      nativeApp,
      control,
      pool,
      m2Runtime,
      m3Runtime,
      m4Runtime,
      m5Runtime,
      close: async () => {
        if(m5Runtime) await m5Runtime.close()
        await pool.end()
        await closeNative()
      },
    }
  } catch (error) {
    await pool.end()
    if (nativeResources) await nativeResources.close()
    throw error
  }
}

module.exports = { bootNative, createM1Application, ROUTES }
