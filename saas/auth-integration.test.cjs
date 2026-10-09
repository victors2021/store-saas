"use strict"

// Real native emailpass hashing/verification, with mocked repository authority.
// The M1 native HTTP suite separately proves PostgreSQL/RLS isolation.
const test = require("node:test")
const assert = require("node:assert/strict")
const jwt = require("jsonwebtoken")
const { MedusaError } = require("@medusajs/framework/utils")
const { EmailPassAuthService } = require("../packages/modules/providers/auth-emailpass/dist/services/emailpass.js")
const { createTenantVerifier, runWithTenant, currentTenant } = require("./tenant-context.cjs")
const { installTenantScopedAuth, runWithAuthActor, attachTenantActor } = require("./auth-integration.cjs")

const signingSecret = "test-only-signing-secret-at-least-thirty-two-bytes"
const namespaceSecret = "test-only-namespace-secret-at-least-thirty-two-bytes"
async function tenant(tenantId) {
  return createTenantVerifier({ secret: signingSecret, issuer: "auth-unit", audience: "auth-unit", lookupMembership: async () => true })(
    jwt.sign({ tenant_id: tenantId }, signingSecret, { subject: "fixture-server", issuer: "auth-unit", audience: "auth-unit", expiresIn: "5m" }))
}
const as = (context, actorType, task) => runWithTenant(context, () => runWithAuthActor(actorType, task))
const code = expected => error => error.code === expected
const credentials = { email: "shared@example.com", password: "correct-password" }
const copy = object => JSON.parse(JSON.stringify(object))

function fixture({ enabled = true } = {}) {
  const identities = new Map()
  const sql = []
  let sequence = 0
  const provider = new EmailPassAuthService({ logger: console }, { hashConfig: { logN: 4, r: 8, p: 1 } })
  const visible = id => {
    const identity = identities.get(id)
    if (!identity || (enabled && identity.fixtureTenant !== currentTenant().tenantId)) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Native identity not found")
    }
    return identity
  }
  const providerService = {
    async retrieve({ entity_id }) {
      const identity = [...identities.values()].find(row => row.provider_identities[0].entity_id === entity_id &&
        (!enabled || row.fixtureTenant === currentTenant().tenantId))
      if (!identity) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Native identity not found")
      return copy(identity)
    },
    async create(data) {
      const identity = { id: `auth-${++sequence}`, app_metadata: null,
        fixtureTenant: enabled ? currentTenant().tenantId : null,
        provider_identities: [{ ...data, provider: "emailpass" }] }
      identities.set(identity.id, identity)
      return copy(identity)
    },
  }
  const service = {
    async register(_provider, input) { return provider.register(input, providerService) },
    async authenticate(_provider, input) { return provider.authenticate(input, providerService) },
    async retrieveAuthIdentity(id) { return copy(visible(id)) },
    authIdentityService_: {
      async retrieve(id) { return visible(id) },
      async update({ id, app_metadata }, sharedContext) {
        assert.ok(sharedContext.transactionManager)
        visible(id).app_metadata = copy(app_metadata)
      },
    },
    baseRepository_: {
      async transaction(task) {
        const manager = { getTransactionContext: () => ({ fixture: true }),
          async execute(statement, values) { sql.push({ statement, values }) } }
        return task(manager)
      },
    },
  }
  installTenantScopedAuth(service, { namespaceSecret, enabled })
  return { service, identities, sql }
}

test("disabled adapter preserves native emailpass behavior and original provider IDs", async () => {
  const { service } = fixture({ enabled: false })
  const registered = await service.register("emailpass", { body: credentials })
  assert.equal(registered.success, true)
  assert.equal(registered.authIdentity.provider_identities[0].entity_id, credentials.email)
  assert.equal((await service.authenticate("emailpass", { body: credentials })).success, true)
})

test("enabled authentication requires a verified tenant and a trusted server actor", async () => {
  const { service } = fixture()
  await assert.rejects(service.register("emailpass", { body: credentials }), code("TENANT_CONTEXT_REQUIRED"))
  const context = await tenant("a")
  await runWithTenant(context, async () => {
    await assert.rejects(service.register("emailpass", { body: credentials }), code("TENANT_AUTH_ACTOR_INVALID"))
    assert.throws(() => runWithAuthActor("admin", () => {}), code("TENANT_AUTH_ACTOR_INVALID"))
  })
})

test("the same email has different native identities across tenants and user/customer actors", async () => {
  const { service } = fixture()
  const a = await tenant("a"), b = await tenant("b")
  const results = []
  for (const [context, actor] of [[a, "user"], [a, "customer"], [b, "user"], [b, "customer"]]) {
    const result = await as(context, actor, () => service.register("emailpass", { body: credentials }))
    assert.equal(result.success, true)
    assert.equal(result.authIdentity.app_metadata.tenant_id, context.tenantId)
    assert.equal(result.authIdentity.app_metadata.saas_actor_type, actor)
    const providerIdentity = result.authIdentity.provider_identities[0]
    assert.match(providerIdentity.entity_id, /^saas:v1:[a-f0-9]{64}@identity\.invalid$/)
    assert.equal(providerIdentity.entity_id.includes(credentials.email), false)
    assert.equal(providerIdentity.provider_metadata.password, undefined)
    results.push(result.authIdentity)
  }
  assert.equal(new Set(results.map(row => row.id)).size, 4)
  assert.equal(new Set(results.map(row => row.provider_identities[0].entity_id)).size, 4)
})

test("native login selects the tenant/actor namespace and rejects a foreign tenant password", async () => {
  const { service } = fixture()
  const a = await tenant("a"), b = await tenant("b")
  const one = await as(a, "customer", () => service.register("emailpass", { body: credentials }))
  const two = await as(b, "customer", () => service.register("emailpass", { body: { ...credentials, password: "b-password" } }))
  assert.notEqual(one.authIdentity.id, two.authIdentity.id)
  assert.equal((await as(a, "customer", () => service.authenticate("emailpass", { body: credentials }))).authIdentity.id, one.authIdentity.id)
  assert.equal((await as(b, "customer", () => service.authenticate("emailpass", { body: credentials }))).success, false)
  assert.equal((await as(b, "user", () => service.authenticate("emailpass", { body: { ...credentials, password: "b-password" } }))).success, false)
})

test("email case normalization cannot create duplicate scoped identities", async () => {
  const { service } = fixture()
  const a = await tenant("a")
  await as(a, "user", () => service.register("emailpass", { body: credentials }))
  const login = await as(a, "user", () => service.authenticate("emailpass", { body: { ...credentials, email: "SHARED@example.com" } }))
  assert.equal(login.success, true)
  const duplicate = await as(a, "user", () => service.register("emailpass", { body: { ...credentials, email: "SHARED@example.com" } }))
  assert.equal(duplicate.success, false)
})

test("client tenant fields and actor mismatches are rejected before provider writes", async () => {
  const { service, identities } = fixture()
  const a = await tenant("a")
  await as(a, "customer", async () => {
    for (const body of [{ ...credentials, tenant_id: "b" }, { ...credentials, data: { tenantId: "b" } }]) {
      await assert.rejects(service.register("emailpass", { body }), code("TENANT_FIELD_FORBIDDEN"))
    }
    await assert.rejects(service.register("emailpass", { actor_type: "user", body: credentials }), code("TENANT_AUTH_ACTOR_INVALID"))
    await assert.rejects(service.register("google", { body: credentials }), code("TENANT_AUTH_PROVIDER_DISABLED"))
    await assert.rejects(service.register("emailpass", { body: { ...credentials, email: " bad@example.com" } }), code("TENANT_AUTH_EMAIL_INVALID"))
  })
  assert.equal(identities.size, 0)
})

test("successful provider responses cannot authenticate an unbound or mismatched identity", async () => {
  const { service, identities } = fixture()
  const a = await tenant("a")
  const created = await as(a, "user", () => service.register("emailpass", { body: credentials }))
  const identity = identities.get(created.authIdentity.id)
  identity.app_metadata = null
  await assert.rejects(as(a, "user", () => service.authenticate("emailpass", { body: credentials })), code("TENANT_AUTH_SCOPE_MISMATCH"))
  identity.app_metadata = { tenant_id: "b", saas_actor_type: "user" }
  await assert.rejects(as(a, "user", () => service.authenticate("emailpass", { body: credentials })), code("TENANT_AUTH_SCOPE_MISMATCH"))
})

test("trusted metadata writes use a transaction-local tenant setting and lock the visible identity", async () => {
  const { service, sql } = fixture()
  const a = await tenant("a")
  const created = await as(a, "customer", () => service.register("emailpass", { body: credentials }))
  assert.deepEqual(sql, [
    { statement: "select set_config('app.tenant_id', ?, true)", values: ["a"] },
    { statement: "select id from auth_identity where id = ? for update", values: [created.authIdentity.id] },
  ])
})

test("actor attachment verifies native visibility and forbids rebinding or a foreign auth identity", async () => {
  const { service } = fixture()
  const a = await tenant("a"), b = await tenant("b")
  const identity = await as(a, "user", () => service.register("emailpass", { body: credentials }))
  const actorService = { async retrieveUser(id) {
    if (currentTenant().tenantId !== "a" || !["user-a", "user-a2", "user-wrong-email"].includes(id)) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Foreign actor")
    return { id, email: id === "user-wrong-email" ? "different@example.com" : credentials.email }
  } }
  const attach = actorId => attachTenantActor(service, { authIdentityId: identity.authIdentity.id, actorType: "user", actorId, actorService })
  await as(a, "user", () => attach("user-a"))
  await as(a, "user", () => attach("user-a"))
  await assert.rejects(as(a, "user", () => attach("user-wrong-email")), code("TENANT_AUTH_ACTOR_EMAIL_MISMATCH"))
  await assert.rejects(as(a, "user", () => attach("user-a2")), code("TENANT_AUTH_ACTOR_ALREADY_BOUND"))
  await assert.rejects(as(a, "user", () => attach("foreign-user")), error => error.type === "not_found")
  await assert.rejects(as(b, "user", () => attachTenantActor(service, { authIdentityId: identity.authIdentity.id,
    actorType: "user", actorId: "user-b", actorService: { retrieveUser: async id => ({ id, email: credentials.email }) } })), error => error.type === "not_found")
  const loggedIn = await as(a, "user", () => service.authenticate("emailpass", { body: credentials }))
  assert.equal(loggedIn.authIdentity.app_metadata.user_id, "user-a")
  assert.equal(loggedIn.authIdentity.provider_identities[0].provider_metadata.password, undefined)
})

test("40 concurrent logins keep tenant and actor namespaces separate", async () => {
  const { service } = fixture()
  const contexts = [await tenant("a"), await tenant("b")]
  const registered = []
  for (const context of contexts) registered.push(await as(context, "customer", () => service.register("emailpass", { body: credentials })))
  await Promise.all(Array.from({ length: 40 }, (_, i) => as(contexts[i % 2], "customer", async () => {
    const result = await service.authenticate("emailpass", { body: credentials })
    assert.equal(result.authIdentity.id, registered[i % 2].authIdentity.id)
    assert.equal(result.authIdentity.app_metadata.tenant_id, contexts[i % 2].tenantId)
  })))
})

test("installation is idempotent and rejects changing the persistent namespace secret", async () => {
  const { service } = fixture()
  const original = service.register
  installTenantScopedAuth(service, { namespaceSecret, enabled: true })
  assert.equal(service.register, original)
  assert.throws(() => installTenantScopedAuth(service, { namespaceSecret: `${namespaceSecret}-changed`, enabled: true }), /cannot change/)
  const a = await tenant("a")
  await as(a, "user", () => assert.throws(() => runWithAuthActor("customer", () => {}), code("TENANT_AUTH_ACTOR_SWITCH_FORBIDDEN")))
})
