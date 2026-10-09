"use strict"
process.env.MEDUSA_SAAS_MODE = "true"
process.env.NODE_ENV = "test"
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  fs = require("node:fs"),
  http = require("node:http"),
  jwt = require("jsonwebtoken")
const { Client } = require("pg")
const { fork } = require("node:child_process")
const path = require("node:path")
const { bootNative, createM1Application } = require("./m1-application.cjs")
const { migrateM2, verifyM2Runtime } = require("./migrate-m2.cjs")
const { createTenantVerifier, runWithTenant } = require("./tenant-context.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
const {
  retryWorkflowId,
  compensationWorkflowId,
} = require("./m2-workflow-fixtures.cjs")
const {
  createTenantCallbackIngress,
  callbackSignature,
} = require("./tenant-callback.cjs")
const { createTenantJobs } = require("./tenant-jobs.cjs")
const DB = "medusa_saas_m2_http",
  MARKER = "medusa-saas-m2-http-disposable-v1",
  ROLE = "medusa_saas_m2_app"
const adminUrl = `postgres://postgres@localhost:5432/${DB}`,
  appUrl = `postgres://${ROLE}@localhost:5432/${DB}`
const secrets = Object.fromEntries(
  ["jwtSecret", "contextSecret", "namespaceSecret", "platformKey"].map((k) => [
    k,
    crypto.randomBytes(48).toString("hex"),
  ])
)
const config = {
  databaseUrl: appUrl,
  baseDomain: "shops.example.test",
  platformActorId: "platform_operator",
  secureCookies: false,
  commerce: true,
  objectRoot: "/workspace/.medusa-baseline/m2-test-objects",
  ...secrets,
}
let app, server, admin
const checks = []
const processProofs = []
async function processTask(payload, { keepAlive = false } = {}) {
  const child = fork(path.join(__dirname, "m2-worker-process.cjs"), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  })
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal }))
  )
  let timer
  try {
    const message = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Acceptance worker process timed out")),
        30000
      )
      child.once("error", reject)
      child.once("exit", (code) =>
        reject(new Error(`Acceptance worker exited before response: ${code}`))
      )
      child.once("message", (value) =>
        value.error
          ? reject(
              new Error(
                `${value.error.code ?? value.error.name}: ${
                  value.error.message
                }`
              )
            )
          : resolve(value)
      )
      child.send({ config, ...payload })
    })
    if (keepAlive) return { message, child, exited }
    const status = await exited
    assert.equal(status.code, 0)
    processProofs.push({
      operation: payload.operation,
      pid: message.pid,
      exitCode: status.code,
    })
    return message
  } catch (error) {
    child.kill("SIGKILL")
    await exited
    throw error
  } finally {
    clearTimeout(timer)
  }
}
async function resetDatabase() {
  const c = new Client({
    connectionString: "postgres://postgres@localhost:5432/postgres",
  })
  await c.connect()
  try {
    const row = (
      await c.query(
        "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
        [DB]
      )
    ).rows[0]
    if (row) {
      if (row.marker !== MARKER || process.env.SAAS_M2_TEST_RESET !== "1")
        throw new Error(
          "Only a marked, explicitly authorized local M2 test DB can be reset"
        )
      await c.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
        [DB]
      )
      await c.query(`DROP DATABASE ${DB}`)
    }
    await c.query(`CREATE DATABASE ${DB}`)
    await c.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`)
    if (
      !(await c.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE]))
        .rowCount
    )
      await c.query(
        `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
      )
  } finally {
    await c.end()
  }
}
async function listen() {
  server = await new Promise((resolve) => {
    const s = app.web.listen(0, "127.0.0.1", () => resolve(s))
  })
}
async function request(host, method, path, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path,
        method,
        headers: {
          host,
          ...(data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {}),
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks = []
        res.on("data", (x) => chunks.push(x))
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              cookie: res.headers["set-cookie"]?.[0]?.split(";")[0],
            })
          } catch (e) {
            reject(e)
          }
        })
        res.on("error", reject)
      }
    )
    req.on("error", reject)
    req.end(data)
  })
}
async function check(t, name, fn) {
  let failure
  await t.test(name, async () => {
    try {
      await fn()
      checks.push(name)
    } catch (e) {
      failure = e
      throw e
    }
  })
  if (failure) throw failure
}
async function eventually(fn) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("Acceptance condition did not become ready")
}

test(
  "M2 native commerce tenant acceptance",
  { timeout: 600_000 },
  async (t) => {
    let A,
      B,
      ownerA,
      ownerB,
      customerA,
      customerB,
      productA,
      productB,
      cartA,
      cartB,
      orderA,
      orderB,
      collectionA,
      collectionB,
      inventoryA,
      inventoryB,
      locationA,
      locationB
    const credentials = {
      email: "shared@example.test",
      password: "correct-test-password-123",
    }
    const verifier = createTenantVerifier({
      secret: secrets.contextSecret,
      issuer: "medusa-m2-test",
      audience: "test-context",
      lookupMembership: (identity) => app.control.authorizeMembership(identity),
    })
    const inStore = async (tenant, fn) => {
      const row = await app.control.getTenant(tenant.id)
      const context = await verifier(
        jwt.sign({ tenant_id: tenant.id }, secrets.contextSecret, {
          subject: row.ownerActorId,
          issuer: "medusa-m2-test",
          audience: "test-context",
          expiresIn: "10m",
        })
      )
      return runWithTenant(context, fn)
    }
    const customerLogin = async (tenant) => {
      const registered = await request(
        tenant.hostname,
        "POST",
        "/auth/customer/emailpass/register",
        credentials
      )
      assert.equal(registered.status, 200, JSON.stringify(registered.body))
      const created = await request(
        tenant.hostname,
        "POST",
        "/store/customers",
        { email: credentials.email },
        { token: registered.body.token }
      )
      assert.equal(created.status, 200, JSON.stringify(created.body))
      const login = await request(
        tenant.hostname,
        "POST",
        "/auth/customer/emailpass",
        credentials
      )
      assert.equal(login.status, 200)
      return login.body.token
    }
    const apiProduct = async (tenant, token) => {
      const channels = await request(
        tenant.hostname,
        "GET",
        "/admin/sales-channels",
        null,
        { token }
      )
      assert.equal(channels.status, 200, JSON.stringify(channels.body))
      const r = await request(
        tenant.hostname,
        "POST",
        "/admin/products",
        {
          title: "Shared product",
          handle: "shared-handle",
          status: "published",
          options: [{ title: "Size", values: ["One"] }],
          sales_channels: [{ id: channels.body.sales_channels[0].id }],
          variants: [
            {
              title: "One",
              sku: "SAME-SKU",
              manage_inventory: false,
              options: { Size: "One" },
              prices: [{ currency_code: "usd", amount: 100 }],
            },
          ],
        },
        { token }
      )
      assert.equal(r.status, 200, JSON.stringify(r.body))
      return r.body.product
    }
    try {
      await resetDatabase()
      const boot = await bootNative(adminUrl, { ...secrets, commerce: true })
      try {
        await boot.app.runMigrations()
        const p = boot.app.linkMigrationExecutionPlanner()
        await p.executePlan(await p.createPlan())
      } finally {
        await boot.close()
      }
      admin = new Client({ connectionString: adminUrl })
      await admin.connect()
      await assert.rejects(
        () => migrateM2(admin, { applicationRole: ROLE }),
        /reference seed conversion/
      )
      const first = await migrateM2(admin, {
          applicationRole: ROLE,
          allowNativeReferenceSeeds: true,
        }),
        second = await migrateM2(admin, { applicationRole: ROLE })
      assert(
        first
          .filter((x) => x.id.startsWith("0004") || x.id.startsWith("0005"))
          .every((x) => x.applied)
      )
      assert(second.every((x) => !x.applied))
      const regeneration = await bootNative(adminUrl, {
        ...secrets,
        commerce: true,
      })
      let linkPlan
      try {
        const planner = regeneration.app.linkMigrationExecutionPlanner()
        linkPlan = await planner.createPlan()
        assert(linkPlan.length > 0)
        assert.deepEqual(
          [...new Set(linkPlan.map((row) => row.action))],
          ["noop"]
        )
        await planner.executePlan(linkPlan)
      } finally {
        await regeneration.close()
      }
      await admin.query(
        "INSERT INTO saas_control.platform_identity(actor_id,status) VALUES($1,'active')",
        [config.platformActorId]
      )
      app = await createM1Application(config)
      await listen()
      await check(
        t,
        "M2 migrations replay and protect commerce tables and cross-module references",
        async () => {
          const m = first.find((x) => x.id === "0004-commerce")
          assert(m.tables.length > 100)
          assert(m.compositeForeignKeys.length > 80)
          assert.equal(
            (await request("localhost", "GET", "/health")).body.stage,
            "M2"
          )
          const pkey = (
            await admin.query(
              "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='region_country'::regclass AND contype='p'"
            )
          ).rows[0]
          assert(pkey.def.includes("tenant_id"))
        }
      )
      await check(
        t,
        "startup rejects RLS primary-key control-grant and shared-provider drift",
        async () => {
          const switchedRole =
            "m2_switch_" + crypto.randomBytes(8).toString("hex")
          for (const [ddl, message] of [
            [
              "ALTER TABLE cart DISABLE ROW LEVEL SECURITY",
              /security metadata drift/,
            ],
            [
              "ALTER TABLE saas_cache DROP CONSTRAINT saas_cache_pkey; ALTER TABLE saas_cache ADD PRIMARY KEY(id)",
              /primary key drift/,
            ],
            [
              "GRANT SELECT ON saas_control.http_session TO PUBLIC",
              /table grant drift/,
            ],
            [
              `GRANT UPDATE ON payment_provider TO ${ROLE}`,
              /read-only provider|read.only|privilege/i,
            ],
            [`GRANT TRUNCATE ON cart TO ${ROLE}`, /table grant drift/],
            ["GRANT SELECT ON cart TO PUBLIC", /table grant drift/],
            [
              `CREATE ROLE ${switchedRole} NOLOGIN; GRANT TRUNCATE ON cart TO ${switchedRole}; ALTER ROLE ${ROLE} NOINHERIT; GRANT ${switchedRole} TO ${ROLE}`,
              /table grant drift/,
            ],
          ]) {
            await admin.query("BEGIN")
            try {
              await admin.query(ddl)
              await admin.query(`SET LOCAL ROLE ${ROLE}`)
              await assert.rejects(() => verifyM2Runtime(admin), message)
            } finally {
              await admin.query("ROLLBACK")
            }
          }
        }
      )
      await check(
        t,
        "native initialization owns countries region store and default channel per tenant",
        async () => {
          for (const slug of ["m2alpha", "m2beta"]) {
            const r = await request(
              "localhost",
              "POST",
              "/platform/tenants",
              {
                slug,
                name: slug,
                ...credentials,
                idempotency_key: `opening_${slug}`,
              },
              { token: secrets.platformKey }
            )
            assert.equal(r.status, 201, JSON.stringify(r.body))
            if (!A) A = r.body.tenant
            else B = r.body.tenant
          }
          assert.equal(
            (
              await admin.query(
                "SELECT count(DISTINCT tenant_id)::integer AS count FROM region_country WHERE iso_2='us'"
              )
            ).rows[0].count,
            2
          )
          ownerA = (
            await request(
              A.hostname,
              "POST",
              "/auth/user/emailpass",
              credentials
            )
          ).body.token
          ownerB = (
            await request(
              B.hostname,
              "POST",
              "/auth/user/emailpass",
              credentials
            )
          ).body.token
          assert(ownerA && ownerB)
          customerA = await customerLogin(A)
          customerB = await customerLogin(B)
        }
      )
      await check(
        t,
        "native product workflows and channel links permit identical per-store handle and SKU",
        async () => {
          productA = await apiProduct(A, ownerA)
          productB = await apiProduct(B, ownerB)
          assert.notEqual(productA.id, productB.id)
        }
      )
      await check(
        t,
        "native product text search and list counts remain scoped",
        async () => {
          for (const [tenant, own, foreign] of [
            [A, productA, productB],
            [B, productB, productA],
          ])
            await inStore(tenant, async () => {
              const [rows, count] =
                await app.nativeApp.modules.product.listAndCountProducts({
                  q: "Shared",
                })
              assert.equal(count, 1)
              assert.equal(rows.length, 1)
              assert.equal(rows[0].id, own.id)
              const graph = await app.nativeApp.query.graph({
                entity: "product",
                fields: ["id"],
                filters: { id: foreign.id },
                pagination: { take: 10 },
              })
              assert.equal(graph.data.length, 0)
            })
        }
      )
      await check(
        t,
        "same idempotency key creates independent native carts with isolated prices and customers",
        async () => {
          for (const [tenant, token, product] of [
            [A, customerA, productA],
            [B, customerB, productB],
          ]) {
            const r = await request(
              tenant.hostname,
              "POST",
              "/store/carts",
              { items: [{ variant_id: product.variants[0].id, quantity: 2 }] },
              { token, headers: { "idempotency-key": "shared_cart_key" } }
            )
            assert.equal(r.status, 200, JSON.stringify(r.body))
            assert.equal(Number(r.body.cart.total), 200)
            if (tenant === A) cartA = r.body.cart
            else cartB = r.body.cart
          }
          assert.notEqual(cartA.id, cartB.id)
          assert.notEqual(cartA.customer_id, cartB.customer_id)
          const replay = await request(
            A.hostname,
            "POST",
            "/store/carts",
            { items: [{ variant_id: productA.variants[0].id, quantity: 2 }] },
            {
              token: customerA,
              headers: { "idempotency-key": "shared_cart_key" },
            }
          )
          assert.equal(replay.body.cart.id, cartA.id)
        }
      )
      await check(
        t,
        "foreign carts variants regions addresses and price input are rejected before partial writes",
        async () => {
          for (const [method, path, body] of [
            ["GET", `/store/carts/${cartB.id}`],
            [
              "POST",
              `/store/carts/${cartB.id}`,
              { email: "changed@example.test" },
            ],
            [
              "POST",
              `/store/carts/${cartB.id}/line-items`,
              { variant_id: productA.variants[0].id, quantity: 1 },
            ],
            ["POST", `/store/carts/${cartB.id}/complete`, {}],
          ])
            assert.equal(
              (
                await request(A.hostname, method, path, body, {
                  token: customerA,
                  headers: { "idempotency-key": "foreign_cart_key" },
                })
              ).status,
              404
            )
          assert.equal(
            (
              await request(
                B.hostname,
                "GET",
                `/store/carts/${cartA.id}`,
                null,
                { token: customerA }
              )
            ).status,
            401
          )
          const before = (
            await admin.query("SELECT count(*)::integer AS n FROM cart")
          ).rows[0].n
          const foreign = await request(
            A.hostname,
            "POST",
            "/store/carts",
            { items: [{ variant_id: productB.variants[0].id, quantity: 1 }] },
            {
              token: customerA,
              headers: { "idempotency-key": "foreign_variant_key" },
            }
          )
          assert.equal(foreign.status, 404)
          const address = await request(
            A.hostname,
            "POST",
            `/store/carts/${cartA.id}`,
            {
              shipping_address: {
                id: cartB.shipping_address.id,
                country_code: "us",
              },
            },
            { token: customerA }
          )
          assert.equal(address.status, 400)
          const amount = await request(
            A.hostname,
            "POST",
            "/store/carts",
            {
              items: [
                {
                  variant_id: productA.variants[0].id,
                  quantity: 1,
                  unit_price: 0,
                },
              ],
            },
            {
              token: customerA,
              headers: { "idempotency-key": "forged_price_key" },
            }
          )
          assert.equal(amount.status, 400)
          assert.equal(
            (await admin.query("SELECT count(*)::integer AS n FROM cart"))
              .rows[0].n,
            before
          )
        }
      )
      await check(
        t,
        "idempotency conflicts and customer ownership cannot expose another cart",
        async () => {
          assert.equal(
            (
              await request(
                A.hostname,
                "POST",
                "/store/carts",
                {
                  items: [{ variant_id: productA.variants[0].id, quantity: 1 }],
                },
                {
                  token: customerA,
                  headers: { "idempotency-key": "shared_cart_key" },
                }
              )
            ).status,
            409
          )
          assert.equal(
            (await request(A.hostname, "GET", `/store/carts/${cartA.id}`))
              .status,
            401
          )
          assert.equal(
            (
              await request(
                A.hostname,
                "GET",
                `/store/carts/${cartA.id}`,
                null,
                { token: ownerA }
              )
            ).status,
            401
          )
        }
      )
      await check(
        t,
        "same coupon code and native promotion calculations remain per tenant",
        async () => {
          for (const tenant of [A, B])
            await inStore(tenant, () =>
              app.nativeApp.modules.promotion.createPromotions({
                code: "SHARED",
                type: "standard",
                status: "active",
                application_method: {
                  type: "percentage",
                  target_type: "items",
                  allocation: "across",
                  value: 10,
                },
              })
            )
          for (const [tenant, token, cart] of [
            [A, customerA, cartA],
            [B, customerB, cartB],
          ]) {
            const r = await request(
              tenant.hostname,
              "POST",
              `/store/carts/${cart.id}/promotions`,
              { promo_codes: ["SHARED"] },
              { token }
            )
            assert.equal(r.status, 200, JSON.stringify(r.body))
            assert.equal(Number(r.body.cart.total), 180)
          }
        }
      )
      await check(
        t,
        "native payment collections and sandbox sessions validate cart ownership",
        async () => {
          for (const [tenant, token, cart] of [
            [A, customerA, cartA],
            [B, customerB, cartB],
          ]) {
            const r = await request(
              tenant.hostname,
              "POST",
              "/store/payment-collections",
              { cart_id: cart.id },
              { token }
            )
            assert.equal(r.status, 200, JSON.stringify(r.body))
            assert.equal(Number(r.body.payment_collection.amount), 180)
            if (tenant === A) collectionA = r.body.payment_collection
            else collectionB = r.body.payment_collection
            const s = await request(
              tenant.hostname,
              "POST",
              `/store/payment-collections/${r.body.payment_collection.id}/payment-sessions`,
              { provider_id: "pp_system_default" },
              { token }
            )
            assert.equal(s.status, 200, JSON.stringify(s.body))
            assert.equal(s.body.payment_collection.payment_sessions.length, 1)
          }
          assert.equal(
            (
              await request(
                A.hostname,
                "POST",
                "/store/payment-collections",
                { cart_id: cartB.id },
                { token: customerA }
              )
            ).status,
            404
          )
          assert.equal(
            (
              await request(
                A.hostname,
                "POST",
                `/store/payment-collections/${collectionB.id}/payment-sessions`,
                { provider_id: "pp_system_default" },
                { token: customerA }
              )
            ).status,
            404
          )
          assert.equal(
            (
              await request(
                A.hostname,
                "POST",
                `/store/payment-collections/${collectionA.id}/payment-sessions`,
                { provider_id: "pp_stripe_secret" },
                { token: customerA }
              )
            ).status,
            400
          )
        }
      )
      await check(
        t,
        "two stores complete native checkout with independent orders payments and identical request keys",
        async () => {
          for (const [tenant, token, cart] of [
            [A, customerA, cartA],
            [B, customerB, cartB],
          ]) {
            const r = await request(
              tenant.hostname,
              "POST",
              `/store/carts/${cart.id}/complete`,
              {},
              { token, headers: { "idempotency-key": "shared_checkout_key" } }
            )
            assert.equal(r.status, 200, JSON.stringify(r.body))
            assert.equal(r.body.type, "order")
            assert.equal(Number(r.body.order.total), 180)
            if (tenant === A) orderA = r.body.order
            else orderB = r.body.order
          }
          assert.notEqual(orderA.id, orderB.id)
          const replay = await request(
            A.hostname,
            "POST",
            `/store/carts/${cartA.id}/complete`,
            {},
            {
              token: customerA,
              headers: { "idempotency-key": "shared_checkout_key" },
            }
          )
          assert.equal(replay.body.order.id, orderA.id)
          assert.equal(
            (await admin.query('SELECT count(*)::integer AS n FROM "order"'))
              .rows[0].n,
            2
          )
          assert.equal(
            (await admin.query("SELECT count(*)::integer AS n FROM payment"))
              .rows[0].n,
            2
          )
        }
      )
      await check(
        t,
        "known foreign order IDs and unopened callback export and workflow routes fail closed",
        async () => {
          assert.equal(
            (
              await request(
                A.hostname,
                "GET",
                `/admin/orders/${orderB.id}`,
                null,
                { token: ownerA }
              )
            ).status,
            404
          )
          assert.equal(
            (
              await request(
                A.hostname,
                "GET",
                `/store/orders/${orderB.id}`,
                null,
                { token: customerA }
              )
            ).status,
            404
          )
          const own = await request(
            A.hostname,
            "GET",
            `/store/orders/${orderA.id}`,
            null,
            { token: customerA }
          )
          assert.equal(own.status, 200, JSON.stringify(own.body))
          assert.equal(own.body.order.id, orderA.id)
          const list = await request(A.hostname, "GET", "/admin/orders", null, {
            token: ownerA,
          })
          assert.equal(list.status, 200)
          assert.equal(list.body.orders.length, 1)
          for (const path of [
            "/hooks/payment",
            "/admin/orders/export",
            "/admin/workflows",
            "/admin/uploads",
            "/admin/api-keys",
          ])
            assert.equal(
              (await request(A.hostname, "POST", path, {}, { token: ownerA }))
                .status,
              404
            )
          assert.equal(
            (
              await request(
                A.hostname,
                "GET",
                "/admin/orders?fields=customer.auth_identity",
                null,
                { token: ownerA }
              )
            ).status,
            400
          )
        }
      )
      await check(
        t,
        "inventory raw SQL uses the transaction and warehouses and SKU are tenant local",
        async () => {
          for (const [tenant, quantity] of [
            [A, 50],
            [B, 90],
          ])
            await inStore(tenant, async () => {
              const location =
                await app.nativeApp.modules.stock_location.createStockLocations(
                  {
                    name: "Shared warehouse",
                    address: { address_1: "1 Test St", country_code: "us" },
                  }
                )
              const item =
                await app.nativeApp.modules.inventory.createInventoryItems({
                  sku: "SAME-INVENTORY",
                  title: "Shared stock",
                })
              await app.nativeApp.modules.inventory.createInventoryLevels({
                inventory_item_id: item.id,
                location_id: location.id,
                stocked_quantity: quantity,
              })
              const available =
                await app.nativeApp.modules.inventory.retrieveAvailableQuantity(
                  item.id,
                  [location.id]
                )
              assert.equal(Number(available), quantity)
              if (tenant === A) {
                inventoryA = item
                locationA = location
              } else {
                inventoryB = item
                locationB = location
              }
            })
          await inStore(A, async () => {
            await assert.rejects(() =>
              app.nativeApp.modules.inventory.retrieveInventoryItem(
                inventoryB.id
              )
            )
            await assert.rejects(() =>
              app.nativeApp.modules.inventory.createInventoryLevels({
                inventory_item_id: inventoryA.id,
                location_id: locationB.id,
                stocked_quantity: 10,
              })
            )
            const list =
              await app.nativeApp.modules.inventory.listAndCountInventoryItems({
                sku: "SAME-INVENTORY",
              })
            assert.equal(list[1], 1)
            await app.nativeApp.modules.inventory.softDeleteInventoryItems([
              inventoryA.id,
            ])
            assert.equal(
              (
                await app.nativeApp.modules.inventory.listInventoryItems({
                  id: inventoryA.id,
                })
              ).length,
              0
            )
            await app.nativeApp.modules.inventory.restoreInventoryItems([
              inventoryA.id,
            ])
            assert.equal(
              (
                await app.nativeApp.modules.inventory.listInventoryItems({
                  id: inventoryA.id,
                })
              ).length,
              1
            )
          })
        }
      )
      await check(
        t,
        "a mixed-tenant native inventory batch rolls back all its writes",
        async () => {
          await inStore(A, async () => {
            const first =
                await app.nativeApp.modules.inventory.createInventoryItems({
                  sku: "BATCH-ONE",
                }),
              second =
                await app.nativeApp.modules.inventory.createInventoryItems({
                  sku: "BATCH-TWO",
                })
            await assert.rejects(() =>
              app.nativeApp.modules.inventory.createInventoryLevels([
                {
                  inventory_item_id: first.id,
                  location_id: locationA.id,
                  stocked_quantity: 10,
                },
                {
                  inventory_item_id: second.id,
                  location_id: locationB.id,
                  stocked_quantity: 10,
                },
              ])
            )
            assert.equal(
              (
                await app.nativeApp.modules.inventory.listInventoryLevels({
                  inventory_item_id: [first.id, second.id],
                })
              ).length,
              0
            )
          })
          await inStore(B, async () => {
            assert.equal(
              Number(
                await app.nativeApp.modules.inventory.retrieveAvailableQuantity(
                  inventoryB.id,
                  [locationB.id]
                )
              ),
              90
            )
          })
        }
      )
      await check(
        t,
        "country assignment and tax configuration can differ independently in the two stores",
        async () => {
          let taxB
          for (const tenant of [A, B])
            await inStore(tenant, async () => {
              const tr = await app.nativeApp.modules.tax.createTaxRegions({
                country_code: "us",
                provider_id: "tp_system",
              })
              await app.nativeApp.modules.tax.createTaxRates({
                tax_region_id: tr.id,
                code: "SHARED",
                name: "Sales tax",
                rate: tenant === A ? 5 : 9,
                is_default: true,
              })
              if (tenant === B) taxB = tr
            })
          await inStore(A, async () => {
            await assert.rejects(() =>
              app.nativeApp.modules.tax.retrieveTaxRegion(taxB.id)
            )
            await app.nativeApp.modules.region.createRegions({
              name: "Extra",
              currency_code: "usd",
              countries: ["gb"],
              automatic_taxes: false,
            })
          })
          await inStore(B, async () => {
            const [country] = await app.nativeApp.modules.region.listCountries({
              iso_2: "gb",
            })
            assert.equal(country.region_id, null)
            assert.equal(
              (await app.nativeApp.modules.tax.listTaxRates({ code: "SHARED" }))
                .length,
              1
            )
          })
        }
      )
      await check(
        t,
        "fulfillment configuration price links and warehouse relations reject a foreign endpoint",
        async () => {
          const { Modules } = require("@medusajs/framework/utils")
          let setB, shippingB
          for (const [tenant, location] of [
            [A, locationA],
            [B, locationB],
          ])
            await inStore(tenant, async () => {
              const set =
                await app.nativeApp.modules.fulfillment.createFulfillmentSets({
                  name: "Shared shipping",
                  type: "shipping",
                  service_zones: [
                    {
                      name: "US",
                      geo_zones: [{ type: "country", country_code: "us" }],
                    },
                  ],
                })
              const profile =
                await app.nativeApp.modules.fulfillment.createShippingProfiles({
                  name: "Shared profile",
                  type: "default",
                })
              await app.nativeApp.link.create({
                [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
                [Modules.FULFILLMENT]: { fulfillment_set_id: set.id },
              })
              await app.nativeApp.link.create({
                [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
                [Modules.FULFILLMENT]: {
                  fulfillment_provider_id: "manual_manual",
                },
              })
              const { result } = await require("@medusajs/core-flows")
                .createShippingOptionsWorkflow(app.nativeApp.sharedContainer)
                .run({
                  input: [
                    {
                      name: "Shared shipping",
                      service_zone_id: set.service_zones[0].id,
                      shipping_profile_id: profile.id,
                      provider_id: "manual_manual",
                      type: {
                        label: "Standard",
                        description: "Test shipping",
                        code: "standard",
                      },
                      price_type: "flat",
                      prices: [{ amount: 20, currency_code: "usd" }],
                    },
                  ],
                })
              if (tenant === B) {
                setB = set
                shippingB = result[0]
              }
            })
          await inStore(A, async () => {
            await assert.rejects(() =>
              app.nativeApp.link.create({
                [Modules.STOCK_LOCATION]: { stock_location_id: locationA.id },
                [Modules.FULFILLMENT]: { fulfillment_set_id: setB.id },
              })
            )
            await assert.rejects(() =>
              app.nativeApp.modules.fulfillment.retrieveShippingOption(
                shippingB.id
              )
            )
            const { data } = await app.nativeApp.query.graph({
              entity: "shipping_option",
              fields: ["id", "prices.amount"],
            })
            assert.equal(data.length, 1)
            assert.equal(Number(data[0].prices[0].amount), 20)
          })
        }
      )
      await check(
        t,
        "same cache and lock keys are isolated and absent context cannot access resources",
        async () => {
          const { cache, locking } = app.m2Runtime.resources
          await inStore(A, async () => {
            await cache.set("shared-key", { shop: "A" })
            await locking.acquire("shared-key", { ownerId: "test-owner-a" })
          })
          await inStore(B, async () => {
            await cache.set("shared-key", { shop: "B" })
            await locking.acquire("shared-key", { ownerId: "test-owner-b" })
            assert.equal((await cache.retrieve("shared-key")).shop, "B")
          })
          await inStore(A, async () => {
            assert.equal((await cache.retrieve("shared-key")).shop, "A")
            await assert.rejects(() =>
              locking.acquire("shared-key", { ownerId: "other-owner" })
            )
            assert.equal(
              await locking.release("shared-key", { ownerId: "test-owner-b" }),
              false
            )
            assert.equal(
              await locking.release("shared-key", { ownerId: "test-owner-a" }),
              true
            )
            await cache.invalidate("shared-key")
          })
          await inStore(B, async () => {
            assert.equal((await cache.retrieve("shared-key")).shop, "B")
            await locking.release("shared-key", { ownerId: "test-owner-b" })
          })
          await assert.rejects(
            () => cache.retrieve("shared-key"),
            /verified tenant context/
          )
          await assert.rejects(
            () => locking.acquire("shared-key"),
            /verified tenant context/
          )
        }
      )
      await check(
        t,
        "private file metadata content and signed links cannot cross a store boundary",
        async () => {
          const file = app.m2Runtime.resources.file
          let fa, fb, link
          await inStore(A, async () => {
            fa = await file.upload({
              filename: "same.txt",
              content: Buffer.from("A private"),
            })
            link = file.sign(fa.id)
            assert.equal(
              (await file.download(link)).content.toString(),
              "A private"
            )
          })
          await inStore(B, async () => {
            fb = await file.upload({
              filename: "same.txt",
              content: Buffer.from("B private"),
            })
            await assert.rejects(() => file.retrieve(fa.id))
            await assert.rejects(() => file.download(link))
            assert.equal(
              (await file.retrieve(fb.id)).content.toString(),
              "B private"
            )
            assert.equal(await file.delete(fa.id), false)
          })
          await inStore(A, async () => {
            assert.equal(
              (await file.retrieve(fa.id)).content.toString(),
              "A private"
            )
            await assert.rejects(() =>
              file.retrieve(fa.id, { publicOnly: true })
            )
            await file.delete(fa.id)
          })
          await inStore(B, () => file.delete(fb.id))
          await assert.rejects(() => file.retrieve(fa.id))
        }
      )
      await check(
        t,
        "worker signatures bind job data tenant and actor and missing context is rejected",
        async () => {
          const jobs = app.m2Runtime.jobs
          jobs.handlers.set("test.record", async (payload) => ({
            value: payload.value,
          }))
          await assert.rejects(() =>
            jobs.enqueue(
              "test.record",
              { value: "missing" },
              { idempotencyKey: "same-key" }
            )
          )
          let a, b, changed
          await inStore(A, async () => {
            a = await jobs.enqueue(
              "test.record",
              { value: "A" },
              { idempotencyKey: "shared-job-key" }
            )
            changed = await jobs.enqueue(
              "test.record",
              { value: "safe" },
              { idempotencyKey: "tampered-job-key" }
            )
          })
          await inStore(B, async () => {
            b = await jobs.enqueue(
              "test.record",
              { value: "B" },
              { idempotencyKey: "shared-job-key" }
            )
            assert.equal(await jobs.retrieve(a.id), undefined)
          })
          assert.notEqual(a.id, b.id)
          assert.equal(
            (await jobs.processNext({ jobId: a.id })).result.value,
            "A"
          )
          assert.equal(
            (await jobs.processNext({ jobId: b.id })).result.value,
            "B"
          )
          await admin.query("UPDATE saas_job SET payload=$2 WHERE id=$1", [
            changed.id,
            { value: "forged" },
          ])
          const forged = await jobs.processNext({ jobId: changed.id })
          assert.equal(forged.state, "failed")
          assert.equal(forged.error, "TENANT_JOB_PAYLOAD_INVALID")
          let envelope
          await inStore(A, async () => {
            envelope = await jobs.enqueue(
              "test.record",
              { value: "untrusted" },
              { idempotencyKey: "bad-envelope-key" }
            )
          })
          await admin.query(
            "UPDATE saas_control.task_dispatch SET tenant_id=$2 WHERE id=$1",
            [envelope.id, B.id]
          )
          assert.equal(
            (await jobs.processNext({ jobId: envelope.id })).error,
            "TENANT_JOB_ENVELOPE_INVALID"
          )
        }
      )
      await check(
        t,
        "worker claims exclude concurrent delivery and a recovered lease fences an old acknowledgment",
        async () => {
          const jobs = app.m2Runtime.jobs
          let release,
            started,
            calls = 0
          const blocked = new Promise((resolve) => (release = resolve)),
            ready = new Promise((resolve) => (started = resolve))
          jobs.handlers.set("test.lease", async () => {
            calls++
            if (calls === 1) {
              started()
              await blocked
              return { delivery: "old" }
            }
            return { delivery: "recovered" }
          })
          const job = await inStore(A, () =>
            jobs.enqueue(
              "test.lease",
              { value: "A" },
              { idempotencyKey: "lease-recovery" }
            )
          )
          const first = jobs.processNext({ jobId: job.id })
          try {
            await ready
            assert.equal(await jobs.processNext({ jobId: job.id }), null)
            await admin.query(
              "UPDATE saas_control.task_dispatch SET lease_until=now()-interval '1 second' WHERE id=$1",
              [job.id]
            )
            const second = await jobs.processNext({ jobId: job.id })
            assert.equal(second.state, "done")
            assert.equal(second.result.delivery, "recovered")
            const rejection = assert.rejects(
              () => first,
              (e) => e.code === "TENANT_JOB_STALE_LEASE"
            )
            release()
            await rejection
            await inStore(A, async () => {
              const saved = await jobs.retrieve(job.id)
              assert.equal(saved.state, "done")
              assert.equal(saved.result.delivery, "recovered")
            })
          } finally {
            release()
            await first.catch(() => {})
          }
        }
      )
      await check(
        t,
        "worker heartbeats prevent a live task from being reclaimed after its initial lease",
        async () => {
          const handlers = new Map([
            [
              "test.heartbeat",
              async () => {
                await new Promise((resolve) => setTimeout(resolve, 3000))
                return { completed: true }
              },
            ],
          ])
          const jobs = createTenantJobs({
            pool: app.pool,
            secret: secrets.contextSecret,
            handlers,
            leaseSeconds: 2,
            lookupMembership: (identity) =>
              app.control.authorizeMembership(identity),
          })
          const queued = await inStore(A, () =>
            jobs.enqueue(
              "test.heartbeat",
              { value: "A" },
              { idempotencyKey: "heartbeat-check" }
            )
          )
          const first = jobs.processNext({ jobId: queued.id })
          try {
            await new Promise((resolve) => setTimeout(resolve, 2200))
            assert.equal(await jobs.processNext({ jobId: queued.id }), null)
            assert.equal((await first).state, "done")
            await inStore(A, async () =>
              assert.equal((await jobs.retrieve(queued.id)).attempts, 1)
            )
          } finally {
            await first.catch(() => {})
          }
        }
      )
      await check(
        t,
        "module SQL and Graph bypasses reject foreign relationships and do not retain pool context",
        async () => {
          await inStore(A, async () => {
            await assert.rejects(() =>
              app.nativeApp.modules.cart.createCarts({
                currency_code: "usd",
                customer_id: cartB.customer_id,
              })
            )
            const { data } = await app.nativeApp.query.graph({
              entity: "order_cart",
              fields: ["cart_id", "order.id", "order.customer_id"],
              filters: { cart_id: cartB.id },
            })
            assert.equal(data.length, 0)
            await tenantSQL(app.pool, (c) => c.query("SELECT 1 FROM cart"))
          })
          const connection = await app.pool.connect()
          try {
            assert.equal(
              (
                await connection.query(
                  "SELECT count(*)::integer AS n FROM cart"
                )
              ).rows[0].n,
              0
            )
            await assert.rejects(() =>
              connection.query(
                "INSERT INTO cart(id,currency_code) VALUES('cart_missing','usd')"
              )
            )
          } finally {
            connection.release()
          }
          await assert.rejects(() =>
            app.nativeApp.query.graph({ entity: "cart", fields: ["id"] })
          )
          await assert.rejects(() => app.nativeApp.modules.order.listOrders())
        }
      )
      await check(
        t,
        "callback credential signatures select the tenant and account while replay is idempotent",
        async () => {
          const jobs = app.m2Runtime.jobs
          const bindingA = {
            status: "active",
            secret: crypto.randomBytes(48).toString("hex"),
            tenantId: A.id,
            actorId: (await app.control.getTenant(A.id)).ownerActorId,
            accountId: "sandbox-account-a",
          }
          const bindingB = {
            ...bindingA,
            secret: crypto.randomBytes(48).toString("hex"),
            tenantId: B.id,
            actorId: (await app.control.getTenant(B.id)).ownerActorId,
            accountId: "sandbox-account-b",
          }
          const registry = new Map([
            ["credential-a", bindingA],
            ["credential-b", bindingB],
          ])
          jobs.handlers.set("callback.payment", async ({ event }) => ({
            orderId: (
              await app.nativeApp.modules.order.retrieveOrder(event.order_id)
            ).id,
          }))
          const ingress = createTenantCallbackIngress({
            lookupCredential: async (key) => registry.get(key),
            lookupAuthority: async (identity) =>
              (await app.control.getTenant(identity.tenantId))?.status ===
                "active" && (await app.control.authorizeMembership(identity)),
            contextSecret: secrets.contextSecret,
            jobs,
          })
          const signed = (credentialKey, binding, event) => {
            const rawBody = Buffer.from(JSON.stringify(event)),
              timestamp = Math.floor(Date.now() / 1000)
            return {
              credentialKey,
              timestamp,
              rawBody,
              signature: callbackSignature(
                binding.secret,
                credentialKey,
                timestamp,
                rawBody
              ),
            }
          }
          const requestA = signed("credential-a", bindingA, {
            event_id: "same-event",
            account_id: bindingA.accountId,
            order_id: orderA.id,
          })
          const requestB = signed("credential-b", bindingB, {
            event_id: "same-event",
            account_id: bindingB.accountId,
            order_id: orderB.id,
          })
          const a = await ingress(requestA),
            b = await ingress(requestB)
          assert.notEqual(a.id, b.id)
          assert.equal((await ingress(requestA)).id, a.id)
          await assert.rejects(
            () => ingress({ ...requestA, credentialKey: "credential-b" }),
            (e) => e.code === "TENANT_CALLBACK_SIGNATURE_INVALID"
          )
          await assert.rejects(
            () => ingress({ ...requestA, signature: "0".repeat(64) }),
            (e) => e.code === "TENANT_CALLBACK_SIGNATURE_INVALID"
          )
          await assert.rejects(
            () =>
              ingress(
                signed("credential-a", bindingA, {
                  event_id: "account-mismatch",
                  account_id: bindingB.accountId,
                  order_id: orderB.id,
                })
              ),
            (e) => e.code === "TENANT_CALLBACK_ACCOUNT_INVALID"
          )
          await assert.rejects(
            () =>
              ingress(
                signed("credential-a", bindingA, {
                  event_id: "tenant-forgery",
                  account_id: bindingA.accountId,
                  tenant_id: B.id,
                })
              ),
            (e) => e.code === "TENANT_JOB_AUTHORITY_FORBIDDEN"
          )
          await assert.rejects(
            () =>
              ingress(
                signed("credential-a", bindingA, {
                  event_id: "same-event",
                  account_id: bindingA.accountId,
                  order_id: orderB.id,
                })
              ),
            (e) => e.code === "TENANT_IDEMPOTENCY_CONFLICT"
          )
          assert.equal(
            (await jobs.processNext({ jobId: a.id })).result.orderId,
            orderA.id
          )
          assert.equal(
            (await jobs.processNext({ jobId: b.id })).result.orderId,
            orderB.id
          )
          const cross = await ingress(
            signed("credential-a", bindingA, {
              event_id: "foreign-order",
              account_id: bindingA.accountId,
              order_id: orderB.id,
            })
          )
          assert.notEqual(
            (await jobs.processNext({ jobId: cross.id })).state,
            "done"
          )
        }
      )
      await check(
        t,
        "40 parallel commerce reads preserve tenant and customer scope",
        async () => {
          const reads = await Promise.all(
            Array.from({ length: 40 }, (_, i) => {
              const shop = i % 2 ? A : B
              return request(
                shop.hostname,
                "GET",
                `/store/orders/${i % 2 ? orderA.id : orderB.id}`,
                null,
                { token: i % 2 ? customerA : customerB }
              )
            })
          )
          for (let i = 0; i < reads.length; i++) {
            assert.equal(reads[i].status, 200)
            assert.equal(reads[i].body.order.id, i % 2 ? orderA.id : orderB.id)
          }
        }
      )
      await check(
        t,
        "native workflow compensation changes only the originating tenant",
        async () => {
          let preserved
          await inStore(B, async () => {
            preserved =
              await app.nativeApp.modules.inventory.createInventoryItems({
                sku: "COMPENSATION-SAME",
              })
          })
          await inStore(A, async () => {
            const result = await app.nativeApp.modules.workflows.run(
              compensationWorkflowId,
              {
                transactionId: "same-compensation",
                input: { sku: "COMPENSATION-SAME" },
                throwOnError: false,
              }
            )
            assert(result.transaction.hasFinished())
            assert(result.errors.length > 0)
            assert.equal(
              (
                await app.nativeApp.modules.inventory.listInventoryItems({
                  sku: "COMPENSATION-SAME",
                })
              ).length,
              0
            )
          })
          await inStore(B, async () => {
            assert.equal(
              (
                await app.nativeApp.modules.inventory.retrieveInventoryItem(
                  preserved.id
                )
              ).sku,
              "COMPENSATION-SAME"
            )
          })
        }
      )
      await check(
        t,
        "native step retries and grouped event recipients retain tenant across restart",
        async () => {
          const pending = []
          for (const [tenant, order] of [
            [A, orderA],
            [B, orderB],
          ])
            await inStore(tenant, async () => {
              const result = await app.nativeApp.modules.workflows.run(
                retryWorkflowId,
                {
                  transactionId: "same-retry",
                  input: { sku: "RETRY-SAME" },
                  throwOnError: false,
                }
              )
              assert.equal(result.transaction.hasFinished(), false)
              const retries = await eventually(async () => {
                const rows = await tenantSQL(
                  app.pool,
                  async (c) =>
                    (
                      await c.query(
                        "SELECT id FROM saas_job WHERE kind='native.resume' AND payload->>'workflowId'=$1",
                        [retryWorkflowId]
                      )
                    ).rows
                )
                return rows.length ? rows : false
              })
              assert.equal(retries.length, 1)
              const [eventId] = await app.nativeApp.modules.event_bus.emit({
                name: "acceptance.order-export",
                data: { orderId: order.id },
                metadata: { eventGroupId: "same-event-group" },
              })
              const ownerId = (await app.control.getTenant(tenant.id))
                .ownerActorId
              const token = jwt.sign(
                { tenant_id: tenant.id },
                secrets.contextSecret,
                {
                  subject: ownerId,
                  issuer: "m2-worker-fixture",
                  audience: "acceptance",
                  expiresIn: "5m",
                }
              )
              pending.push({
                tenant,
                retryId: retries[0].id,
                eventId,
                order,
                token,
              })
            })
          await inStore(A, () =>
            app.nativeApp.modules.event_bus.releaseGroupedEvents(
              "same-event-group"
            )
          )
          assert.equal(
            (
              await admin.query(
                "SELECT state FROM saas_control.task_dispatch WHERE id=$1",
                [pending[1].eventId]
              )
            ).rows[0].state,
            "blocked"
          )
          await new Promise((resolve) => server.close(resolve))
          server = null
          await app.close()
          app = null
          await new Promise((resolve) => setTimeout(resolve, 1100))
          await admin.query(
            "UPDATE saas_control.task_dispatch SET available_at=now() WHERE id=ANY($1::text[])",
            [pending.map((row) => row.retryId)]
          )
          const resumed = await processTask({
            operation: "retry-and-events",
            workflowId: retryWorkflowId,
            targets: pending.map((row) => ({
              retryId: row.retryId,
              eventId: row.eventId,
              token: row.token,
            })),
          })
          assert.notEqual(resumed.pid, process.pid)
          const delivered = resumed.result.delivered
          app = await createM1Application(config)
          await listen()
          for (const row of pending) {
            await inStore(row.tenant, async () => {
              assert.equal(
                (
                  await app.nativeApp.modules.inventory.listInventoryItems({
                    sku: "RETRY-SAME",
                  })
                ).length,
                1
              )
              assert.equal(
                await app.m2Runtime.resources.cache.retrieve(
                  "acceptance:retry:RETRY-SAME"
                ),
                2
              )
            })
          }
          assert.deepEqual(
            delivered.map((row) => row.orderId),
            [orderA.id, orderB.id]
          )
          assert.deepEqual(
            delivered.map((row) => row.customerId),
            [cartA.customer_id, cartB.customer_id]
          )
          assert.deepEqual(
            delivered.map((row) => row.exportOrderIds),
            [[orderA.id], [orderB.id]]
          )
          assert(delivered.every((row) => row.email === credentials.email))
          await assert.rejects(() =>
            app.nativeApp.modules.event_bus.emit({
              name: "acceptance.order-export",
              data: { orderId: orderA.id },
            })
          )
        }
      )
      await check(
        t,
        "persisted Session and queued native work survive an application restart without duplication",
        async () => {
          const login = await request(
            A.hostname,
            "POST",
            "/auth/session",
            {},
            { token: ownerA }
          )
          assert.equal(login.status, 200)
          const cookie = login.cookie
          let queued, resultBefore
          // Execute a native persistent create-cart workflow, then crash before its
          // job result is acknowledged. This proves checkpoint-based recovery.
          const customerId = jwt.verify(customerA, secrets.jwtSecret).actor_id
          const cv = createTenantVerifier({
            secret: secrets.contextSecret,
            issuer: "customer-fixture",
            audience: "fixture",
            lookupMembership: async () => true,
          })
          const customerContext = await cv(
            jwt.sign({ tenant_id: A.id }, secrets.contextSecret, {
              subject: customerId,
              issuer: "customer-fixture",
              audience: "fixture",
              expiresIn: "10m",
            })
          )
          await runWithTenant(customerContext, async () => {
            queued = await app.m2Runtime.jobs.enqueue(
              "cart.create",
              {
                data: {
                  items: [{ variant_id: productA.variants[0].id, quantity: 1 }],
                },
                customerId,
              },
              { idempotencyKey: "restart-native-cart" }
            )
          })
          await new Promise((resolve) => server.close(resolve))
          server = null
          await app.close()
          app = null
          const crashed = await processTask(
            { operation: "cart-crash-window", jobId: queued.id },
            { keepAlive: true }
          )
          try {
            resultBefore = crashed.message.result
            assert.equal(resultBefore.state, "unacknowledged")
          } finally {
            crashed.child.kill("SIGKILL")
            const status = await crashed.exited
            assert.equal(status.signal, "SIGKILL")
            processProofs.push({
              operation: "cart-crash-window",
              pid: crashed.message.pid,
              signal: status.signal,
            })
          }
          const count = (
            await admin.query("SELECT count(*)::integer AS n FROM cart")
          ).rows[0].n
          await admin.query(
            "UPDATE saas_control.task_dispatch SET lease_until=now()-interval '1 second' WHERE id=$1",
            [queued.id]
          )
          const replayed = await processTask({
            operation: "cart-replay",
            jobId: queued.id,
          })
          assert.notEqual(replayed.pid, crashed.message.pid)
          assert.notEqual(replayed.pid, process.pid)
          const after = replayed.result
          app = await createM1Application(config)
          await listen()
          assert.equal(after.state, "done", JSON.stringify(after))
          assert.equal(after.result.cart_id, resultBefore.result.cart_id)
          assert.equal(
            (await admin.query("SELECT count(*)::integer AS n FROM cart"))
              .rows[0].n,
            count
          )
          const own = await request(
            A.hostname,
            "GET",
            "/admin/users/me",
            null,
            { headers: { cookie } }
          )
          assert.equal(own.status, 200)
          assert.equal(
            (
              await request(B.hostname, "GET", "/admin/users/me", null, {
                headers: { cookie },
              })
            ).status,
            401
          )
        }
      )
      if (process.env.SAAS_M2_RESULT)
        fs.writeFileSync(
          process.env.SAAS_M2_RESULT,
          JSON.stringify(
            {
              success: true,
              passed: checks.length,
              checks,
              workerProcesses: processProofs,
              migrations: first,
              linkPlan: linkPlan.map((row) => ({ action: row.action })),
            },
            null,
            2
          ) + "\n"
        )
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve))
      if (app) await app.close()
      if (admin) await admin.end()
    }
  }
)
