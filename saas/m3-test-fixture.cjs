"use strict"
process.env.MEDUSA_SAAS_MODE = "true"
process.env.NODE_ENV = "test"
const { Client } = require("pg")
const crypto = require("node:crypto")
const http = require("node:http")
const { bootNative, createM1Application } = require("./m1-application.cjs")
const { migrateM2 } = require("./migrate-m2.cjs")
const { runWithTenant, createTenantVerifier } = require("./tenant-context.cjs")
const jwt = require("jsonwebtoken")
const credentials = { email: "shared@example.test", password: "correct-test-password-123" }

async function createFixture(options = {}) {
  const stage = options.fixtureStage || (options.operations ? "m5" : options.payments ? "m4" : "m3")
  if(!/^(m3|m4|m5)(_[a-z]+)?$/.test(stage)) throw new Error("Invalid disposable fixture stage")
  const DB = `medusa_saas_${stage}_http`, ROLE = `medusa_saas_${stage}_app`, MARKER = `medusa-saas-${stage}-http-disposable-v1`
  const admin = new Client({ connectionString: "postgres://postgres@localhost:5432/postgres" })
  await admin.connect()
  try {
    const row = (await admin.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [DB])).rows[0]
    if (row) {
      if (row.marker !== MARKER || process.env[`SAAS_${stage.toUpperCase()}_TEST_RESET`] !== "1")
        throw new Error("Only a marked, explicitly authorized local M3 test DB can be reset")
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [DB])
      await admin.query(`DROP DATABASE ${DB}`)
    }
    await admin.query(`CREATE DATABASE ${DB}`)
    await admin.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`)
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE])).rowCount)
      await admin.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
  } finally { await admin.end() }
  const secrets = Object.fromEntries(["jwtSecret", "contextSecret", "namespaceSecret", "platformKey"].map((key) => [key, crypto.randomBytes(48).toString("hex")]))
  const adminUrl = `postgres://postgres@localhost:5432/${DB}`
  const config = { databaseUrl: `postgres://${ROLE}@localhost:5432/${DB}`, baseDomain: "shops.example.test",
    platformActorId: "m3_platform_operator", secureCookies: false, commerce: true, browser: true,
    objectRoot: process.env.SAAS_M3_OBJECT_ROOT || "/tmp/medusa-saas-m3-objects", ...secrets,
    ...(options.payments ? {paymentKey:crypto.randomBytes(32).toString("hex")} : {}), ...options }
  const boot = await bootNative(adminUrl, { ...secrets, commerce: true })
  try { await boot.app.runMigrations(); const p = boot.app.linkMigrationExecutionPlanner(); await p.executePlan(await p.createPlan()) }
  finally { await boot.close() }
  const db = new Client({ connectionString: adminUrl })
  await db.connect()
  await (options.operations ? require("./migrate-m5.cjs").migrateM5 : options.payments ? require("./migrate-m4.cjs").migrateM4 : migrateM2)(db, { applicationRole: ROLE, allowNativeReferenceSeeds: true, objectRoot:config.objectRoot })
  await db.query("INSERT INTO saas_control.platform_identity(actor_id,status) VALUES($1,'active')", [config.platformActorId])
  let app, server
  try {
    app = await createM1Application(config)
    server = await new Promise((resolve) => { const s = app.web.listen(0, "127.0.0.1", () => resolve(s)) })
    const request = (host, method, path, body, extra = {}) => new Promise((resolve, reject) => {
      const data = Buffer.isBuffer(body) ? body : body === undefined || body === null ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request({ hostname: "127.0.0.1", port: server.address().port, method, path,
        headers: { host, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...extra } }, (res) => {
        const chunks = []
        res.on("data", (data) => chunks.push(data)); res.on("error", reject)
        res.on("end", () => { const raw = Buffer.concat(chunks); let value
          try { value = JSON.parse(raw.toString()) } catch { value = raw.toString() }
          resolve({ status: res.statusCode, body: value, headers: res.headers, raw }) })
      })
      req.on("error", reject); req.end(data)
    })
    const ok = (response, status = 200) => {
      if (response.status !== status) throw new Error(`Unexpected HTTP ${response.status}: ${JSON.stringify(response.body)}`)
      return response.body
    }
    const tenants = []
    for (const [slug, name] of [["alpha", "Alpha Shop"], ["bravo", "Bravo Shop"]]) {
      const tenant = ok(await request("platform.shops.example.test", "POST", "/platform/tenants", {
        slug, name, ...credentials, idempotency_key: `m3-open-${slug}` }, { authorization: `Bearer ${secrets.platformKey}` }), 201).tenant
      const ownerToken = ok(await request(tenant.hostname, "POST", "/auth/user/emailpass", credentials)).token
      const auth = { authorization: `Bearer ${ownerToken}` }
      const stores = ok(await request(tenant.hostname, "GET", "/admin/stores", null, auth)).stores
      const channels = ok(await request(tenant.hostname, "GET", "/admin/sales-channels", null, auth)).sales_channels
      const regions = ok(await request(tenant.hostname, "GET", "/admin/regions", null, auth)).regions
      const locations = ok(await request(tenant.hostname, "GET", "/admin/stock-locations", null, auth)).stock_locations
      const profiles = ok(await request(tenant.hostname, "GET", "/admin/shipping-profiles", null, auth)).shipping_profiles
      tenants.push({ ...tenant, ownerToken, store: stores[0], channel: channels[0], region: regions[0], location: locations[0], profile: profiles[0] })
    }
    const verifier = createTenantVerifier({ secret: secrets.contextSecret, issuer: "medusa-m3-test", audience: "fixture-context",
      lookupMembership: (identity) => app.control.authorizeMembership({...identity,allowSuspended:!!options.operations}) })
    const inStore = async (tenant, task) => {
      const row = await app.control.getTenant(tenant.id)
      const context = await verifier(jwt.sign({ tenant_id: tenant.id }, secrets.contextSecret, {
        subject: row.ownerActorId, issuer: "medusa-m3-test", audience: "fixture-context", expiresIn: "5m" }))
      return runWithTenant(context, task)
    }
    const seedCommerce = async () => {
      for (const tenant of tenants) {
        const headers = { authorization: `Bearer ${tenant.ownerToken}` }
        const call = async (method, path, body) => ok(await request(tenant.hostname, method, path, body, headers))
        await call("POST", `/admin/stock-locations/${tenant.location.id}/sales-channels`, { add: [tenant.channel.id] })
        await call("POST", `/admin/stock-locations/${tenant.location.id}/fulfillment-providers`, { add: ["manual_manual"] })
        const location = (await call("POST", `/admin/stock-locations/${tenant.location.id}/fulfillment-sets?fields=${encodeURIComponent("+fulfillment_sets,+fulfillment_sets.service_zones")}`, {
          name: "Standard shipping", type: "shipping",
        })).stock_location
        tenant.fulfillmentSet = location.fulfillment_sets[0]
        const set = (await call("POST", `/admin/fulfillment-sets/${tenant.fulfillmentSet.id}/service-zones`, {
          name: "US", geo_zones: [{ type: "country", country_code: "us" }],
        })).fulfillment_set
        tenant.serviceZone = set.service_zones[0]
        tenant.shipping = (await call("POST", "/admin/shipping-options", {
          name: "Standard shipping", service_zone_id: tenant.serviceZone.id,
          shipping_profile_id: tenant.profile.id, provider_id: "manual_manual", price_type: "flat",
          type: { label: "Standard", description: "M3 test shipping", code: "standard" },
          prices: [{ amount: 5, currency_code: "usd" }],
        })).shipping_option
        tenant.product = (await call("POST", "/admin/products", {
          title: `${tenant.slug === "alpha" ? "Alpha" : "Bravo"} Cotton Shirt`, handle: "cotton-shirt", status: "published",
          description: "M3 tenant acceptance product", options: [{ title: "Size", values: ["One"] }],
          sales_channels: [{ id: tenant.channel.id }], shipping_profile_id: tenant.profile.id,
          variants: [{ title: "One", sku: "SHARED-SKU", manage_inventory: false, options: { Size: "One" },
            prices: [{ currency_code: "usd", amount: tenant.slug === "alpha" ? 25 : 37 }] }],
        })).product
      }
    }
    const fixture = { app, server, db, config, tenants, request, ok, inStore, credentials, seedCommerce,
      restart: async () => {
        await new Promise((resolve) => server.close(resolve)); await app.close()
        app=await createM1Application(config)
        server=await new Promise((resolve) => {const s=app.web.listen(0,"127.0.0.1",()=>resolve(s))})
        fixture.app=app;fixture.server=server
      },
      close: async () => { await new Promise((resolve) => server.close(resolve)); await app.close(); await db.end() } }
    return fixture
  } catch (error) {
    if (server) await new Promise((resolve) => server.close(resolve))
    if (app) await app.close()
    await db.end()
    throw error
  }
}
module.exports = { createFixture, credentials }
