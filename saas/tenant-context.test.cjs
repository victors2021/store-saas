"use strict"

// Authority/ALS/adapter unit tests use mocked transactions, not a DB isolation proof.
const test = require("node:test")
const assert = require("node:assert/strict")
const jwt = require("jsonwebtoken")
const { setTimeout } = require("node:timers/promises")
const { createTenantVerifier, runWithTenant, currentTenant } = require("./tenant-context.cjs")
const { wrapTenantModule } = require("./tenant-module.cjs")

const secret = "test-only-tenant-secret-with-at-least-thirty-two-bytes"
const issuer = "medusa-saas-pilot"
const audience = "native-module-pilot"
function token(tenantId = "tenant-a", actorId = "user-a", options = {}) {
  return jwt.sign({ tenant_id: tenantId }, secret, {
    algorithm: "HS256", issuer, audience, subject: actorId, expiresIn: "5m", ...options,
  })
}
function verifier(lookupMembership = async () => true) {
  return createTenantVerifier({ secret, issuer, audience, lookupMembership })
}
function errorCode(code) { return (error) => error.code === code }

function mockModule(name) {
  const calls = []
  const opened = []
  class NativeModuleMock {
    async create(data, context) {
      data = this.normalizeCreateProductInput(data)
      calls.push({ data, context, identity: currentTenant() })
      return { ...data, manager: context.transactionManager }
    }
    async list(filters, config, context) { return this.create({ filters, config }, context) }
    normalizeCreateProductInput(data) { return this.normalizeUpdateProductInput(data) }
    normalizeUpdateProductInput(data) { return { ...data } }
    __joinerConfig() { return { serviceName: name } }
  }
  NativeModuleMock.prototype.MedusaContextIndex_ = { create: 1, list: 2 }
  const service = new NativeModuleMock()
  service.baseRepository_ = {
    async transaction(task) {
      const manager = {
        name, sql: [], getTransactionContext: () => ({ mock: true }),
        async execute(sql, params) { this.sql.push({ sql, params }) },
      }
      opened.push(manager)
      return task(manager)
    },
  }
  return { service, calls, opened }
}

test("verified JWT requires correct signature, HS256, issuer, audience and expiration", async () => {
  const verify = verifier()
  const invalid = [
    jwt.sign({ tenant_id: "tenant-a" }, "different-signing-secret", { issuer, audience, subject: "user-a", expiresIn: "5m" }),
    token("tenant-a", "user-a", { algorithm: "HS384" }),
    token("tenant-a", "user-a", { issuer: "wrong" }),
    token("tenant-a", "user-a", { audience: "wrong" }),
    token("tenant-a", "user-a", { expiresIn: -1 }),
    jwt.sign({ tenant_id: "tenant-a" }, secret, { issuer, audience, subject: "user-a" }),
    jwt.sign({}, secret, { issuer, audience, subject: "user-a", expiresIn: "5m" }),
    jwt.sign({ tenant_id: "tenant-a" }, secret, { issuer, audience, expiresIn: "5m" }),
  ]
  for (const candidate of invalid) {
    await assert.rejects(verify(candidate), errorCode("TENANT_AUTHENTICATION_FAILED"))
  }
})

test("membership lookup is awaited and only explicit true authorizes", async () => {
  let received
  const verify = verifier(async (identity) => {
    await setTimeout(2)
    received = identity
    return identity.tenantId === "tenant-a" && identity.actorId === "user-a"
  })
  await verify(token())
  assert.deepEqual(received, { tenantId: "tenant-a", actorId: "user-a" })
  assert.equal(Object.isFrozen(received), true)
  await assert.rejects(verify(token("tenant-b")), errorCode("TENANT_MEMBERSHIP_REQUIRED"))
  await assert.rejects(verifier(async () => ({ active: true }))(token()), errorCode("TENANT_MEMBERSHIP_REQUIRED"))
})

test("manual and copied contexts cannot establish tenant authority", async () => {
  const context = await verifier()(token())
  assert.equal(Object.isFrozen(context), true)
  assert.throws(() => runWithTenant({ ...context }, () => {}), errorCode("TENANT_CONTEXT_UNVERIFIED"))
  assert.throws(() => runWithTenant({ tenantId: "tenant-a", actorId: "user-a" }, () => {}), errorCode("TENANT_CONTEXT_UNVERIFIED"))
  assert.throws(currentTenant, errorCode("TENANT_CONTEXT_REQUIRED"))
})

test("nested tasks reject tenant or actor switches and permit the same verified identity", async () => {
  const verify = verifier()
  const a = await verify(token())
  const b = await verify(token("tenant-b", "user-b"))
  const otherActor = await verify(token("tenant-a", "user-other"))
  await runWithTenant(a, async () => {
    assert.throws(() => runWithTenant(b, () => {}), errorCode("TENANT_CONTEXT_SWITCH_FORBIDDEN"))
    assert.throws(() => runWithTenant(otherActor, () => {}), errorCode("TENANT_CONTEXT_SWITCH_FORBIDDEN"))
    await runWithTenant(a, async () => assert.equal(currentTenant(), a))
    assert.equal(currentTenant(), a)
  })
  assert.throws(currentTenant, errorCode("TENANT_CONTEXT_REQUIRED"))
})

test("40 concurrent tasks retain immutable ALS identities across await boundaries", async () => {
  const verify = verifier()
  const contexts = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    verify(token(`tenant-${index % 2}`, `user-${index % 2}`))))
  await Promise.all(contexts.map((context, index) => runWithTenant(context, async () => {
    assert.equal(currentTenant(), context)
    await setTimeout(index % 5)
    assert.equal(currentTenant(), context)
    await Promise.resolve()
    assert.equal(currentTenant(), context)
  })))
  assert.throws(currentTenant, errorCode("TENANT_CONTEXT_REQUIRED"))
})

test("in-place wrapping is idempotent and protects existing module references", async () => {
  const fixture = mockModule("product")
  const existingReference = fixture.service
  assert.equal(wrapTenantModule(existingReference, { name: "product" }), existingReference)
  const wrappedCreate = existingReference.create
  wrapTenantModule(existingReference, { name: "product" })
  assert.equal(existingReference.create, wrappedCreate)
  assert.deepEqual(existingReference.__joinerConfig(), { serviceName: "product" })
  await assert.rejects(existingReference.create({ title: "product" }), errorCode("TENANT_CONTEXT_REQUIRED"))
  const context = await verifier()(token())
  await runWithTenant(context, async () => {
    await existingReference.list({}, {})
  })
  assert.equal(fixture.opened.length, 1)
  assert.deepEqual(fixture.opened[0].sql, [{
    sql: "select set_config('app.tenant_id', ?, true)", params: ["tenant-a"],
  }])
  assert.equal(fixture.calls[0].context.transactionManager, fixture.opened[0])
})

test("native normalization helpers without MedusaContext remain intact on indirect calls", async () => {
  const fixture = mockModule("product")
  const normalizeCreate = fixture.service.normalizeCreateProductInput
  const normalizeUpdate = fixture.service.normalizeUpdateProductInput
  wrapTenantModule(fixture.service)
  assert.equal(fixture.service.normalizeCreateProductInput, normalizeCreate)
  assert.equal(fixture.service.normalizeUpdateProductInput, normalizeUpdate)
  const context = await verifier()(token())
  const created = await runWithTenant(context, () => fixture.service.create({ title: "Normalized" }))
  assert.equal(created.title, "Normalized")
  assert.equal(fixture.opened.length, 1)
  assert.equal(fixture.calls.length, 1)
})

test("data cannot override tenant_id, and supplied transaction managers are refused", async () => {
  const fixture = mockModule("product")
  const service = wrapTenantModule(fixture.service)
  const context = await verifier()(token())
  await runWithTenant(context, async () => {
    await assert.rejects(service.create({ tenant_id: "tenant-b" }), errorCode("TENANT_FIELD_FORBIDDEN"))
    await assert.rejects(service.create({ variants: [{ tenant_id: "tenant-b" }] }), errorCode("TENANT_FIELD_FORBIDDEN"))
    await assert.rejects(service.create({ tenantId: "tenant-b" }), errorCode("TENANT_FIELD_FORBIDDEN"))
    await assert.rejects(service.create({}, { transactionManager: {} }), errorCode("TENANT_MANAGER_FORBIDDEN"))
    await assert.rejects(service.create({}, { manager: {} }), errorCode("TENANT_MANAGER_FORBIDDEN"))
  })
  assert.equal(fixture.opened.length, 0)
  assert.equal(fixture.calls.length, 0)
})

test("each module opens its own transaction and 40 concurrent calls do not share managers", async () => {
  const product = mockModule("product")
  const pricing = mockModule("pricing")
  wrapTenantModule(product.service)
  wrapTenantModule(pricing.service)
  const verify = verifier()
  const a = await verify(token())
  const b = await verify(token("tenant-b", "user-b"))
  await Promise.all(Array.from({ length: 40 }, (_, index) => runWithTenant(index % 2 ? b : a, async () => {
    const p = await product.service.create({ id: `p-${index}` })
    await setTimeout(index % 3)
    const price = await pricing.service.create({ id: `price-${index}` })
    assert.notEqual(p.manager, price.manager)
    assert.equal(p.manager.sql[0].params[0], currentTenant().tenantId)
    assert.equal(price.manager.sql[0].params[0], currentTenant().tenantId)
  })))
  assert.equal(product.opened.length, 40)
  assert.equal(pricing.opened.length, 40)
  assert.equal(new Set([...product.opened, ...pricing.opened]).size, 80)
})

test("adapter refuses a repository callback without a bound SQL transaction", async () => {
  const fixture = mockModule("product")
  fixture.service.baseRepository_.transaction = (task) => task({
    execute: async () => {}, getTransactionContext: () => undefined,
  })
  wrapTenantModule(fixture.service)
  const context = await verifier()(token())
  await runWithTenant(context, () => assert.rejects(
    fixture.service.create({}), errorCode("TENANT_TRANSACTION_REQUIRED")))
  assert.equal(fixture.calls.length, 0)
})
