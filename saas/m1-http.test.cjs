"use strict"

process.env.MEDUSA_SAAS_MODE = "true"
process.env.NODE_ENV = "test"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const crypto = require("node:crypto")
const { Client } = require("pg")
const jwt = require("jsonwebtoken")
const http = require("node:http")
const { bootNative, createM1Application } = require("./m1-application.cjs")
const { migrateM1 } = require("./migrate-m1.cjs")

const DB = "medusa_saas_m1_http"
const MARKER = "medusa-saas-m1-http-disposable-v1"
const ROLE = "medusa_saas_m1_app"
const adminUrl = `postgres://postgres@localhost:5432/${DB}`
const appUrl = `postgres://${ROLE}@localhost:5432/${DB}`
const secrets = Object.fromEntries(
  ["jwtSecret", "contextSecret", "namespaceSecret", "platformKey"].map(
    (name) => [name, crypto.randomBytes(48).toString("hex")]
  )
)
const config = {
  databaseUrl: appUrl,
  baseDomain: "shops.example.test",
  platformActorId: "platform_operator",
  secureCookies: false,
  ...secrets,
}
let app, server, admin
const checks = []

async function disposableDatabase() {
  const client = new Client({
    connectionString: "postgres://postgres@localhost:5432/postgres",
  })
  await client.connect()
  try {
    const row = (
      await client.query(
        "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",
        [DB]
      )
    ).rows[0]
    if (row) {
      if (process.env.SAAS_M1_TEST_RESET !== "1" || row.marker !== MARKER)
        throw new Error(
          "Only the explicitly marked M1 test database can be reset"
        )
      await client.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
        [DB]
      )
      await client.query(`DROP DATABASE ${DB}`)
    }
    await client.query(`CREATE DATABASE ${DB}`)
    await client.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`)
    if (
      !(await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE]))
        .rowCount
    )
      await client.query(
        `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
      )
  } finally {
    await client.end()
  }
}

async function request(host, method, url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: url,
        method,
        headers: {
          host,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
            })
          } catch (error) {
            reject(error)
          }
        })
        response.on("error", reject)
      }
    )
    req.on("error", reject)
    req.end(payload)
  })
}

test("M1 native HTTP tenant acceptance", { timeout: 300_000 }, async (t) => {
  async function check(name, fn) {
    await t.test(name, async () => {
      await fn()
      checks.push(name)
    })
  }
  let A, B, tokenA, tokenB, pa, pb
  const credentials = {
    email: "shared@example.test",
    password: "correct-test-password-123",
  }
  try {
    await disposableDatabase()
    const migrationBoot = await bootNative(adminUrl, secrets)
    try {
      await migrationBoot.app.runMigrations()
      const planner = migrationBoot.app.linkMigrationExecutionPlanner()
      await planner.executePlan(await planner.createPlan())
    } finally {
      await migrationBoot.close()
    }
    admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    const first = await migrateM1(admin, { applicationRole: ROLE })
    const second = await migrateM1(admin, { applicationRole: ROLE })
    assert(first.every((result) => result.applied))
    assert(second.every((result) => !result.applied))
    await admin.query(
      "INSERT INTO saas_control.platform_identity (actor_id,status) VALUES ($1,'active')",
      [config.platformActorId]
    )
    app = await createM1Application(config)
    server = await new Promise((resolve) => {
      const listener = app.web.listen(0, "127.0.0.1", () => resolve(listener))
    })
    await check(
      "versioned migrations replay safely and runtime role cannot bypass RLS",
      async () => {
        const role = (
          await app.pool.query(
            "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user"
          )
        ).rows[0]
        assert(Object.values(role).every((value) => value === false))
        assert.equal(
          (await app.pool.query("SELECT count(*)::int n FROM product")).rows[0]
            .n,
          0
        )
      }
    )
    await check(
      "only persisted platform operator can provision tenants",
      async () => {
        const body = {
          slug: "alpha",
          name: "Alpha",
          idempotency_key: "create_alpha_001",
          ...credentials,
        }
        assert.equal(
          (
            await request(
              "platform.shops.example.test",
              "POST",
              "/platform/tenants",
              body
            )
          ).status,
          401
        )
        const response = await request(
          "platform.shops.example.test",
          "POST",
          "/platform/tenants",
          body,
          { token: secrets.platformKey }
        )
        assert.equal(response.status, 201, JSON.stringify(response.body))
        A = response.body.tenant
        const repeat = await request(
          "platform.shops.example.test",
          "POST",
          "/platform/tenants",
          body,
          { token: secrets.platformKey }
        )
        assert.equal(repeat.status, 201, JSON.stringify(repeat.body))
        assert.equal(repeat.body.tenant.id, A.id)
        const changed = await request(
          "platform.shops.example.test",
          "POST",
          "/platform/tenants",
          { ...body, password: "changed-password-123" },
          { token: secrets.platformKey }
        )
        assert.equal(changed.status, 409, JSON.stringify(changed.body))
        const b = await request(
          "platform.shops.example.test",
          "POST",
          "/platform/tenants",
          {
            ...body,
            slug: "bravo",
            name: "Bravo",
            idempotency_key: "create_bravo_001",
          },
          { token: secrets.platformKey }
        )
        assert.equal(b.status, 201, JSON.stringify(b.body))
        B = b.body.tenant
      }
    )
    await check(
      "opening retries recover an identity committed before its metadata binding",
      async () => {
        const body = {
          slug: "recover",
          name: "Recover",
          idempotency_key: "create_recover_001",
          ...credentials,
        }
        const service = app.nativeApp.modules.auth.authIdentityService_
        const originalUpdate = service.update
        let faultInjected = false
        service.update = async function interruptBinding(data, context) {
          if (!faultInjected && data.app_metadata?.tenant_id) {
            faultInjected = true
            throw new Error("TEST_IDENTITY_BINDING_INTERRUPTED")
          }
          return Reflect.apply(originalUpdate, this, [data, context])
        }
        try {
          const result = await request(
            "platform.shops.example.test",
            "POST",
            "/platform/tenants",
            body,
            { token: secrets.platformKey }
          )
          assert.equal(result.status, 400, JSON.stringify(result.body))
          assert(faultInjected)
        } finally {
          service.update = originalUpdate
        }
        const failed = (
          await admin.query(
            "SELECT id,status FROM saas_control.tenant WHERE slug='recover'"
          )
        ).rows[0]
        assert.equal(failed.status, "failed")
        const orphan = (
          await admin.query(
            "SELECT app_metadata FROM auth_identity WHERE tenant_id=$1",
            [failed.id]
          )
        ).rows[0]
        assert.equal(orphan.app_metadata, null)
        const retry = await request(
          "platform.shops.example.test",
          "POST",
          "/platform/tenants",
          body,
          { token: secrets.platformKey }
        )
        assert.equal(retry.status, 201, JSON.stringify(retry.body))
        assert.equal(retry.body.tenant.id, failed.id)
        const login = await request(
          retry.body.tenant.hostname,
          "POST",
          "/auth/user/emailpass",
          credentials
        )
        assert.equal(login.status, 200, JSON.stringify(login.body))
        assert.equal(
          (
            await request(
              retry.body.tenant.hostname,
              "GET",
              "/admin/users/me",
              null,
              { token: login.body.token }
            )
          ).status,
          200
        )
      }
    )
    await check(
      "native owner emailpass and Admin me separate identical emails",
      async () => {
        const a = await request(
          A.hostname,
          "POST",
          "/auth/user/emailpass",
          credentials
        )
        const b = await request(
          B.hostname,
          "POST",
          "/auth/user/emailpass",
          credentials
        )
        assert.equal(a.status, 200, JSON.stringify(a.body))
        assert.equal(b.status, 200, JSON.stringify(b.body))
        tokenA = a.body.token
        tokenB = b.body.token
        const ua = await request(A.hostname, "GET", "/admin/users/me", null, {
          token: tokenA,
        })
        const ub = await request(B.hostname, "GET", "/admin/users/me", null, {
          token: tokenB,
        })
        assert.equal(ua.status, 200, JSON.stringify(ua.body))
        assert.equal(ub.status, 200, JSON.stringify(ub.body))
        assert.equal(ua.body.user.email, credentials.email)
        assert.equal(ub.body.user.email, credentials.email)
        assert.notEqual(ua.body.user.id, ub.body.user.id)
        assert.equal(
          (
            await request(A.hostname, "POST", "/auth/user/emailpass", {
              ...credentials,
              password: "wrong",
            })
          ).status,
          401
        )
      }
    )
    await check(
      "native Admin product workflow creates identical handles and SKUs per tenant",
      async () => {
        const body = {
          title: "Alpha product",
          handle: "same-handle",
          status: "published",
          options: [{ title: "Size", values: ["One"] }],
          variants: [
            {
              title: "One",
              sku: "SAME-SKU",
              options: { Size: "One" },
              manage_inventory: false,
              prices: [{ currency_code: "usd", amount: 100 }],
            },
          ],
        }
        const a = await request(A.hostname, "POST", "/admin/products", body, {
          token: tokenA,
        })
        const b = await request(
          B.hostname,
          "POST",
          "/admin/products",
          { ...body, title: "Bravo product" },
          { token: tokenB }
        )
        assert.equal(a.status, 200, JSON.stringify(a.body))
        assert.equal(b.status, 200, JSON.stringify(b.body))
        pa = a.body.product
        pb = b.body.product
        assert.notEqual(pa.id, pb.id)
        assert.equal(pa.variants[0].prices[0].amount, 100)
      }
    )
    await check(
      "native list/count and deep price relations are tenant local",
      async () => {
        for (const [tenant, token, own] of [
          [A, tokenA, pa],
          [B, tokenB, pb],
        ]) {
          const response = await request(
            tenant.hostname,
            "GET",
            "/admin/products",
            null,
            { token }
          )
          assert.equal(response.status, 200, JSON.stringify(response.body))
          assert.equal(response.body.count, 1)
          assert.deepEqual(
            response.body.products.map((product) => product.id),
            [own.id]
          )
          assert.equal(
            response.body.products[0].variants[0].prices[0].amount,
            100
          )
        }
        const duplicate = await request(
          A.hostname,
          "POST",
          "/admin/products",
          {
            title: "Duplicate",
            handle: "same-handle",
            options: [{ title: "Size", values: ["One"] }],
          },
          { token: tokenA }
        )
        assert(
          [400, 409].includes(duplicate.status),
          JSON.stringify(duplicate.body)
        )
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/products", null, {
              token: tokenA,
            })
          ).body.count,
          1
        )
      }
    )
    await check(
      "known foreign product IDs cannot be retrieved updated or deleted",
      async () => {
        for (const [method, body] of [
          ["GET", null],
          ["POST", { title: "ATTACK" }],
          ["DELETE", null],
        ]) {
          const result = await request(
            A.hostname,
            method,
            `/admin/products/${pb.id}`,
            body,
            { token: tokenA }
          )
          assert.equal(result.status, 404, JSON.stringify(result.body))
        }
        assert.equal(
          (
            await request(B.hostname, "GET", `/admin/products/${pb.id}`, null, {
              token: tokenB,
            })
          ).body.product.title,
          "Bravo product"
        )
      }
    )
    await check(
      "foreign native collection and variant relations are rejected before any partial write",
      async () => {
        const {
          createTenantVerifier,
          runWithTenant,
        } = require("./tenant-context.cjs")
        const owner = jwt.decode(tokenB).actor_id
        const verifier = createTenantVerifier({
          secret: secrets.contextSecret,
          issuer: "medusa-saas-context",
          audience: "internal-context",
          lookupMembership: (identity) =>
            app.control.authorizeMembership(identity),
        })
        const context = await verifier(
          jwt.sign({ tenant_id: B.id }, secrets.contextSecret, {
            subject: owner,
            issuer: "medusa-saas-context",
            audience: "internal-context",
            expiresIn: "1m",
          })
        )
        const collection = await runWithTenant(context, () =>
          app.nativeApp.modules.product.createProductCollections({
            title: "Bravo only",
            handle: "bravo-only",
          })
        )
        const response = await request(
          A.hostname,
          "POST",
          "/admin/products",
          {
            title: "Foreign relation",
            collection_id: collection.id,
            options: [{ title: "Size", values: ["One"] }],
          },
          { token: tokenA }
        )
        assert.equal(response.status, 404, JSON.stringify(response.body))
        const update = await request(
          A.hostname,
          "POST",
          `/admin/products/${pa.id}`,
          {
            title: "ATTACK",
            variants: [
              {
                id: pb.variants[0].id,
                title: "Foreign",
                manage_inventory: false,
              },
            ],
          },
          { token: tokenA }
        )
        assert.equal(update.status, 404, JSON.stringify(update.body))
        const own = await request(A.hostname, "GET", "/admin/products", null, {
          token: tokenA,
        })
        assert.equal(own.body.count, 1)
        assert.equal(own.body.products[0].title, "Alpha product")
      }
    )
    await check("same-tenant update and delete remain functional", async () => {
      const update = await request(
        A.hostname,
        "POST",
        `/admin/products/${pa.id}`,
        { title: "Updated Alpha" },
        { token: tokenA }
      )
      assert.equal(update.status, 200, JSON.stringify(update.body))
      assert.equal(update.body.product.title, "Updated Alpha")
      const temp = await request(
        A.hostname,
        "POST",
        "/admin/products",
        {
          title: "Temporary",
          handle: "temporary",
          options: [{ title: "Size", values: ["One"] }],
        },
        { token: tokenA }
      )
      assert.equal(temp.status, 200, JSON.stringify(temp.body))
      const deleted = await request(
        A.hostname,
        "DELETE",
        `/admin/products/${temp.body.product.id}`,
        null,
        { token: tokenA }
      )
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    })
    await check(
      "store hostname and native Store handlers return only published local products",
      async () => {
        for (const [tenant, own] of [
          [A, pa],
          [B, pb],
        ]) {
          const result = await request(
            tenant.hostname,
            "GET",
            "/store/products"
          )
          assert.equal(result.status, 200, JSON.stringify(result.body))
          assert.equal(result.body.count, 1)
          assert.deepEqual(
            result.body.products.map((p) => p.id),
            [own.id]
          )
        }
        assert.equal(
          (await request(A.hostname, "GET", `/store/products/${pb.id}`)).status,
          404
        )
        assert.equal(
          (
            await request(
              "unknown.shops.example.test",
              "GET",
              "/store/products"
            )
          ).status,
          404
        )
      }
    )
    await check(
      "body query header and nested metadata cannot supply tenant authority",
      async () => {
        for (const body of [
          { title: "Attack", tenant_id: B.id },
          { title: "Attack", metadata: { nested: { tenantId: B.id } } },
        ]) {
          assert.equal(
            (
              await request(A.hostname, "POST", "/admin/products", body, {
                token: tokenA,
              })
            ).status,
            400
          )
        }
        assert.equal(
          (
            await request(
              A.hostname,
              "GET",
              `/admin/products?tenant_id=${B.id}`,
              null,
              { token: tokenA }
            )
          ).status,
          400
        )
        for (const headers of [
          { "x-tenant-id": B.id },
          { "x-forwarded-host": B.hostname },
        ])
          assert.equal(
            (
              await request(A.hostname, "GET", "/admin/products", null, {
                token: tokenA,
                headers,
              })
            ).status,
            400
          )
        assert.equal(
          (
            await request(A.hostname, "GET", "/store/products", null, {
              headers: { "x-publishable-key": B.public_key },
            })
          ).status,
          401
        )
      }
    )
    await check(
      "foreign forged expired and unbound native tokens are rejected",
      async () => {
        assert.equal(
          (
            await request(B.hostname, "GET", "/admin/products", null, {
              token: tokenA,
            })
          ).status,
          401
        )
        const claims = jwt.decode(tokenA)
        delete claims.iat
        delete claims.exp
        delete claims.aud
        delete claims.iss
        for (const [token, label] of [
          [
            jwt.sign(claims, crypto.randomBytes(48).toString("hex"), {
              expiresIn: "1h",
            }),
            "forged",
          ],
          [
            jwt.sign(claims, secrets.jwtSecret, {
              issuer: "medusa-saas",
              audience: "medusa-saas-native",
              expiresIn: -1,
            }),
            "expired",
          ],
          [
            jwt.sign(
              {
                actor_type: "user",
                actor_id: claims.actor_id,
                auth_identity_id: claims.auth_identity_id,
              },
              secrets.jwtSecret,
              {
                issuer: "medusa-saas",
                audience: "medusa-saas-native",
                expiresIn: "1h",
              }
            ),
            "unbound",
          ],
        ])
          assert.equal(
            (
              await request(A.hostname, "GET", "/admin/products", null, {
                token,
              })
            ).status,
            401,
            label
          )
      }
    )
    await check(
      "native Admin session login binds cookies to tenant and expiration",
      async () => {
        const login = await request(A.hostname, "POST", "/auth/session", null, {
          token: tokenA,
        })
        assert.equal(login.status, 200, JSON.stringify(login.body))
        assert(login.cookie)
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/users/me", null, {
              headers: { cookie: login.cookie },
            })
          ).status,
          200
        )
        assert.equal(
          (
            await request(B.hostname, "GET", "/admin/users/me", null, {
              headers: { cookie: login.cookie },
            })
          ).status,
          401
        )
        const rotated = await request(
          A.hostname,
          "POST",
          "/auth/session",
          null,
          { token: tokenA, headers: { cookie: login.cookie } }
        )
        assert.equal(rotated.status, 200, JSON.stringify(rotated.body))
        assert(rotated.cookie)
        assert.notEqual(rotated.cookie, login.cookie)
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/users/me", null, {
              headers: { cookie: login.cookie },
            })
          ).status,
          401
        )
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/users/me", null, {
              headers: { cookie: rotated.cookie },
            })
          ).status,
          200
        )
        assert.equal(
          (
            await request(A.hostname, "DELETE", "/auth/session", null, {
              headers: { cookie: rotated.cookie },
            })
          ).status,
          200
        )
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/users/me", null, {
              headers: { cookie: rotated.cookie },
            })
          ).status,
          401
        )
      }
    )
    await check(
      "native consumer registration and login isolate same email and owner identity",
      async () => {
        let consumers = []
        for (const tenant of [A, B]) {
          const register = await request(
            tenant.hostname,
            "POST",
            "/auth/customer/emailpass/register",
            credentials
          )
          assert.equal(register.status, 200, JSON.stringify(register.body))
          const create = await request(
            tenant.hostname,
            "POST",
            "/store/customers",
            { email: credentials.email, first_name: tenant.slug },
            { token: register.body.token }
          )
          assert.equal(create.status, 200, JSON.stringify(create.body))
          const login = await request(
            tenant.hostname,
            "POST",
            "/auth/customer/emailpass",
            credentials
          )
          assert.equal(login.status, 200, JSON.stringify(login.body))
          const me = await request(
            tenant.hostname,
            "GET",
            "/store/customers/me",
            null,
            { token: login.body.token }
          )
          assert.equal(me.status, 200, JSON.stringify(me.body))
          assert.equal(me.body.customer.email, credentials.email)
          assert.equal(
            (
              await request(tenant.hostname, "GET", "/admin/products", null, {
                token: login.body.token,
              })
            ).status,
            401
          )
          consumers.push({ token: login.body.token, id: me.body.customer.id })
        }
        assert.notEqual(consumers[0].id, consumers[1].id)
        assert.equal(
          (
            await request(B.hostname, "GET", "/store/customers/me", null, {
              token: consumers[0].token,
            })
          ).status,
          401
        )
      }
    )
    await check(
      "customer registration token cannot bind an unrelated email or create a partial actor",
      async () => {
        const register = await request(
          A.hostname,
          "POST",
          "/auth/customer/emailpass/register",
          { ...credentials, email: "new@example.test" }
        )
        assert.equal(register.status, 200, JSON.stringify(register.body))
        const before = (
          await admin.query(
            "SELECT count(*)::int n FROM customer WHERE tenant_id=$1",
            [A.id]
          )
        ).rows[0].n
        const wrong = await request(
          A.hostname,
          "POST",
          "/store/customers",
          { email: "victim@example.test" },
          { token: register.body.token }
        )
        assert.equal(wrong.status, 401, JSON.stringify(wrong.body))
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM customer WHERE tenant_id=$1",
              [A.id]
            )
          ).rows[0].n,
          before
        )
      }
    )
    await check(
      "unported transaction export upload OAuth MFA and field pivots fail closed",
      async () => {
        for (const [method, url] of [
          ["GET", "/admin/orders"],
          ["POST", "/store/carts"],
          ["POST", "/admin/products/export"],
          ["POST", "/admin/uploads"],
          ["GET", "/auth/user/google"],
          ["POST", "/auth/user/emailpass/register"],
          ["GET", "/auth/mfa/factors"],
        ]) {
          assert.equal(
            (await request(A.hostname, method, url, null, { token: tokenA }))
              .status,
            404,
            url
          )
        }
        for (const field of [
          "*sales_channels",
          "variants.inventory_items.inventory.location_levels",
          "variants.product.variants.price_set",
          "*",
        ])
          assert.equal(
            (
              await request(
                A.hostname,
                "GET",
                `/admin/products?fields=${encodeURIComponent(field)}`,
                null,
                { token: tokenA }
              )
            ).status,
            400
          )
      }
    )
    await check(
      "40 parallel owner requests preserve tenant scope and pooled SQL is unscoped",
      async () => {
        await Promise.all(
          Array.from({ length: 40 }, (_, index) => {
            const [tenant, token, own] =
              index % 2 ? [A, tokenA, pa] : [B, tokenB, pb]
            return request(tenant.hostname, "GET", "/admin/products", null, {
              token,
            }).then((result) => {
              assert.equal(result.status, 200, JSON.stringify(result.body))
              assert.equal(result.body.count, 1)
              assert.deepEqual(
                result.body.products.map((p) => p.id),
                [own.id]
              )
            })
          })
        )
        assert.equal(
          (await app.pool.query("SELECT count(*)::int n FROM product")).rows[0]
            .n,
          0
        )
        const nativeManager =
          app.nativeApp.modules.product.baseRepository_.getFreshManager()
        assert.equal(
          (
            await nativeManager.execute("SELECT count(*)::int n FROM product")
          )[0].n,
          0
        )
      }
    )
    await check(
      "40 parallel native HTTP writes preserve local uniqueness and counts",
      async () => {
        await Promise.all(
          Array.from({ length: 40 }, (_, index) => {
            const [tenant, token] = index % 2 ? [A, tokenA] : [B, tokenB]
            const body = {
              title: tenant.slug,
              handle: `parallel-${Math.floor(index / 2)}`,
              options: [{ title: "Size", values: ["One"] }],
            }
            return request(tenant.hostname, "POST", "/admin/products", body, {
              token,
            }).then((result) =>
              assert.equal(result.status, 200, JSON.stringify(result.body))
            )
          })
        )
        for (const [tenant, token] of [
          [A, tokenA],
          [B, tokenB],
        ]) {
          const result = await request(
            tenant.hostname,
            "GET",
            "/admin/products?limit=50",
            null,
            { token }
          )
          assert.equal(result.status, 200, JSON.stringify(result.body))
          assert.equal(result.body.count, 21)
          assert.equal(
            result.body.products.filter((product) =>
              product.handle.startsWith("parallel-")
            ).length,
            20
          )
        }
      }
    )
    await check(
      "runtime startup and direct native calls reject privileged or missing tenant authority",
      async () => {
        await assert.rejects(
          createM1Application({ ...config, databaseUrl: adminUrl }),
          /Unsafe runtime role/
        )
        await assert.rejects(
          app.nativeApp.modules.product.listProducts(),
          (error) => error.code === "TENANT_CONTEXT_REQUIRED"
        )
        await assert.rejects(
          app.pool.query(
            "INSERT INTO product(id,title,handle) VALUES('missing-context','Missing','missing')"
          ),
          (error) => ["42501", "23502"].includes(error.code)
        )
      }
    )
    await check(
      "persisted tenant suspension immediately invalidates owner access without affecting another tenant",
      async () => {
        await app.control.setTenantStatus({
          tenantId: A.id,
          actorId: config.platformActorId,
          status: "suspended",
        })
        assert.equal(
          (
            await request(A.hostname, "GET", "/admin/products", null, {
              token: tokenA,
            })
          ).status,
          404
        )
        assert.equal(
          (
            await request(B.hostname, "GET", "/admin/products", null, {
              token: tokenB,
            })
          ).status,
          200
        )
      }
    )
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (app) await app.close()
    if (admin) await admin.end()
    if (process.env.SAAS_M1_RESULT)
      fs.writeFileSync(
        process.env.SAAS_M1_RESULT,
        JSON.stringify(
          {
            success: checks.length === 20,
            total: 20,
            passed: checks.length,
            checks,
            scope:
              "M1 native catalog/auth/me HTTP acceptance; full native Admin UI and M2 transaction domains not accepted",
          },
          null,
          2
        ) + "\n"
      )
  }
})
