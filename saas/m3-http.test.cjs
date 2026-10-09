"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const { createFixture } = require("./m3-test-fixture.cjs")
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64")

test("M3 native Admin and storefront HTTP acceptance", { timeout: 120000 }, async (t) => {
  const f = await createFixture(), [A, B] = f.tenants, results = []
  const owner = (tenant) => ({ authorization: `Bearer ${tenant.ownerToken}` })
  const call = async (tenant, method, path, body, headers = owner(tenant)) => f.ok(await f.request(tenant.hostname, method, path, body, headers))
  const denied = (response, codes = [400, 401, 403, 404]) => assert(codes.includes(response.status), `Unexpected HTTP ${response.status}: ${JSON.stringify(response.body)}`)
  const check = async (name, fn) => t.test(name, async () => { await fn(); results.push({ name, passed: true }) })
  const register = async (tenant, email = "buyer@example.test") => {
    const token = (await call(tenant, "POST", "/auth/customer/emailpass/register", { email, password: f.credentials.password }, {})).token
    const customer = (await call(tenant, "POST", "/store/customers", { email, first_name: "Test", last_name: "Buyer" },
      { authorization: `Bearer ${token}` })).customer
    const logged = (await call(tenant, "POST", "/auth/customer/emailpass", { email, password: f.credentials.password }, {})).token
    return { customer, headers: { authorization: `Bearer ${logged}` } }
  }
  const multipart = (content, type = "image/png", name = "logo.png") => {
    const boundary = "m3-public-test-boundary"
    return { body: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`), content,
      Buffer.from(`\r\n--${boundary}--\r\n`)]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } }
  }
  let buyerA, buyerB, secondA, cartA, cartB, fileA, inventoryA, orderA, orderB
  try {
    await f.seedCommerce()
    await check("native route/schema bindings boot and M3 health identifies browser integration", async () => {
      assert.equal((await f.request("localhost", "GET", "/health")).body.stage, "M3")
      assert(f.app.m3Runtime.contract.length > 70)
    })
    await check("standard SDK publishable key remains bound to the verified Host", async () => {
      const own = await f.request(A.hostname, "GET", `/store/products?region_id=${A.region.id}`, null, { "x-publishable-api-key": A.public_key })
      assert.equal(own.status, 200, JSON.stringify(own.body))
      assert.equal(own.body.products.length, 1)
      assert.equal(own.body.products[0].title, "Alpha Cotton Shirt")
      assert.equal(own.body.products[0].variants[0].calculated_price.calculated_amount, 25)
      denied(await f.request(A.hostname, "GET", "/store/products", null, { "x-publishable-api-key": B.public_key }))
      denied(await f.request(A.hostname, "GET", "/store/products", null, { "x-publishable-api-key": A.public_key, "x-publishable-key": B.public_key }))
    })
    await check("public product pricing and region lookups never return the sibling store", async () => {
      const other = (await f.request(B.hostname, "GET", `/store/products?region_id=${B.region.id}`)).body.products
      assert.equal(other[0].title, "Bravo Cotton Shirt")
      assert.equal(other[0].variants[0].calculated_price.calculated_amount, 37)
      denied(await f.request(A.hostname, "GET", `/store/products/${B.product.id}`))
      denied(await f.request(A.hostname, "GET", `/store/products?region_id=${B.region.id}`))
      denied(await f.request(A.hostname, "GET", "/store/products?fields=metadata,*variants.prices"))
    })
    await check("draft products and disabled channels are absent from the public store", async () => {
      await call(A, "POST", `/admin/products/${A.product.id}`, { status: "draft" })
      assert.equal((await f.request(A.hostname, "GET", "/store/products")).body.products.length, 0)
      await call(A, "POST", `/admin/products/${A.product.id}`, { status: "published" })
      await call(A, "POST", `/admin/sales-channels/${A.channel.id}`, { is_disabled: true })
      denied(await f.request(A.hostname, "GET", "/store/products"))
      await call(A, "POST", `/admin/sales-channels/${A.channel.id}`, { is_disabled: false })
    })
    await check("Host-bound SQL sessions tolerate DNS case, ports and trailing dot but reject another store", async () => {
      const login = await f.request(A.hostname, "POST", "/auth/session", undefined, owner(A))
      assert.equal(login.status, 200)
      const cookie = login.headers["set-cookie"][0].split(";")[0]
      assert(login.headers["set-cookie"][0].includes("HttpOnly"))
      const same = await f.request(`${A.hostname.toUpperCase()}.:4443`, "GET", "/admin/users/me", null, { cookie })
      assert.equal(same.status, 200)
      denied(await f.request(B.hostname, "GET", "/admin/users/me", null, { cookie }))
      denied(await f.request(B.hostname, "GET", "/admin/users/me", null, owner(A)))
      assert.equal((await f.request(A.hostname, "DELETE", "/auth/session", null, { cookie })).status, 200)
      denied(await f.request(A.hostname, "GET", "/admin/users/me", null, { cookie }))
    })
    await check("browser mutations require the exact store origin even between sibling subdomains", async () => {
      denied(await f.request(A.hostname, "POST", "/auth/session", undefined, { ...owner(A), origin: `http://${B.hostname}` }), [403])
      denied(await f.request(A.hostname, "POST", "/auth/session", undefined, { ...owner(A), origin: "https://evil.example" }), [403])
      denied(await f.request(A.hostname, "POST", "/auth/session", undefined, { ...owner(A), "sec-fetch-site": "same-site" }), [403])
      assert.equal((await f.request(A.hostname, "POST", "/auth/session", undefined, { ...owner(A), origin: `http://${A.hostname}` })).status, 200)
    })
    await check("public media and theme settings are tenant-scoped with an explicit safe DTO", async () => {
      const upload = multipart(PNG)
      fileA = (await call(A, "POST", "/admin/uploads", upload.body, { ...owner(A), ...upload.headers })).files[0]
      const settings = { name: "Alpha Brand", logo: fileA.url, primary_color: "#135790", seo_description: "Alpha only" }
      assert.deepEqual((await call(A, "POST", "/admin/saas/settings", settings)).settings, settings)
      const publicSettings = await f.request(A.hostname, "GET", "/store/settings")
      assert.deepEqual(publicSettings.body.settings, settings)
      assert.equal(publicSettings.headers["cache-control"], "private, no-store")
      const media = await f.request(A.hostname, "GET", fileA.url)
      assert.equal(media.status, 200); assert(media.raw.equals(PNG)); assert.equal(media.headers["x-content-type-options"], "nosniff")
      denied(await f.request(B.hostname, "GET", fileA.url), [404])
      denied(await f.request(B.hostname, "POST", "/admin/saas/settings", { ...settings, name: "Bravo Brand" }, owner(B)), [404])
      assert.equal((await f.request(B.hostname, "GET", "/store/settings")).body.settings.name, "Bravo Shop")
      const svg = multipart(Buffer.from("<svg onload='alert(1)'/>"), "image/svg+xml", "attack.svg")
      denied(await f.request(A.hostname, "POST", "/admin/uploads", svg.body, { ...owner(A), ...svg.headers }), [400])
      denied(await f.request(A.hostname, "POST", "/admin/saas/settings", { ...settings, tenant_id: B.id }, owner(A)), [400])
    })
    await check("nested variants enforce their parent and reusable options remain tenant-scoped", async () => {
      const another = (await call(A, "POST", "/admin/products", { title: "Another", handle: "another", options: [{ title: "Size", values: ["Two"] }],
        variants: [{ title: "Two", options: { Size: "Two" }, manage_inventory: false, prices: [{ currency_code: "usd", amount: 9 }] }] })).product
      for (const method of ["GET", "POST", "DELETE"]) denied(await f.request(A.hostname, method,
        `/admin/products/${A.product.id}/variants/${another.variants[0].id}`, method === "POST" ? { title: "Wrong" } : null, owner(A)), [404])
      denied(await f.request(A.hostname, "POST", `/admin/products/${A.product.id}`, { options: [{ id: B.product.options[0].id, value_ids: B.product.options[0].values.map((value) => value.id) }] }, owner(A)), [400])
      const unchanged = (await call(A, "GET", `/admin/products/${another.id}`)).product
      assert.equal(unchanged.variants[0].title, "Two"); assert.equal(unchanged.options[0].title, "Size")
      await call(A, "DELETE", `/admin/products/${another.id}`)
    })
    await check("single warehouse, native stock adjustments and links reject foreign endpoints before writes", async () => {
      denied(await f.request(A.hostname, "POST", "/admin/stock-locations", { name: "Second warehouse" }, owner(A)), [400])
      inventoryA = (await call(A, "POST", "/admin/inventory-items", { title: "Inventory Test", sku: "SHARED-INVENTORY" })).inventory_item
      await call(A, "POST", `/admin/inventory-items/${inventoryA.id}/location-levels`, { location_id: A.location.id, stocked_quantity: 20 })
      await call(A, "POST", `/admin/inventory-items/${inventoryA.id}/location-levels/${A.location.id}`, { stocked_quantity: 17 })
      denied(await f.request(A.hostname, "POST", `/admin/inventory-items/${inventoryA.id}/location-levels`, { location_id: B.location.id, stocked_quantity: 999 }, owner(A)), [404])
      denied(await f.request(A.hostname, "POST", `/admin/stock-locations/${A.location.id}/sales-channels`, { add: [A.channel.id, B.channel.id] }, owner(A)), [404])
      const levels = (await call(A, "GET", `/admin/inventory-items/${inventoryA.id}/location-levels`)).inventory_levels
      assert.equal(levels.length, 1); assert.equal(levels[0].stocked_quantity, 17)
      const batchItem = (await call(A, "POST", "/admin/inventory-items", { title: "Batch stock", sku: "BATCH-STOCK" })).inventory_item
      const created = await call(A, "POST", `/admin/inventory-items/${batchItem.id}/location-levels/batch`, {
        create: [{ location_id: A.location.id, stocked_quantity: 11 }],
      })
      assert.equal(created.created[0].stocked_quantity, 11)
      denied(await f.request(A.hostname, "POST", `/admin/inventory-items/${batchItem.id}/location-levels/batch`, {
        create: [{ location_id: B.location.id, stocked_quantity: 999 }],
      }, owner(A)), [404])
      await call(A, "DELETE", `/admin/inventory-items/${batchItem.id}`)
      denied(await f.request(A.hostname, "GET", `/admin/stock-locations/${B.location.id}`, null, owner(A)), [404])
    })
    await check("native inventory grid batches validate every tenant and leave no partial stock changes", async () => {
      const payload = { update: [{ inventory_item_id: inventoryA.id, location_id: A.location.id, stocked_quantity: 19 }],
        create: [{ inventory_item_id: inventoryA.id, location_id: B.location.id, stocked_quantity: 999 }], force: true }
      denied(await f.request(A.hostname, "POST", "/admin/inventory-items/location-levels/batch", payload, owner(A)), [404])
      let levels = (await call(A, "GET", `/admin/inventory-items/${inventoryA.id}/location-levels`)).inventory_levels
      assert.equal(levels[0].stocked_quantity, 17)
      const batch = await call(A, "POST", "/admin/inventory-items/location-levels/batch", { update: payload.update, force: true })
      assert.equal(batch.updated.length, 1)
      levels = (await call(A, "GET", `/admin/inventory-items/${inventoryA.id}/location-levels`)).inventory_levels
      assert.equal(levels[0].stocked_quantity, 19)
      denied(await f.request(A.hostname, "POST", `/admin/products/${A.product.id}/variants/inventory-items/batch`, {
        create: [{ variant_id: B.product.variants[0].id, inventory_item_id: inventoryA.id, required_quantity: 1 }],
      }, owner(A)), [404])
    })
    await check("actual native Admin list and option form selectors stay inside the reviewed DTOs", async () => {
      const selectors = "id,title,handle,status,*collection,*sales_channels,variants.id,thumbnail,-type,-options,-tags,-images,-variants"
      const products = (await call(A, "GET", `/admin/products?fields=${encodeURIComponent(selectors)}`)).products
      assert.equal(products.length, 1)
      const options = (await call(A, "GET", "/admin/product-options?fields=id,title,values.id,values.value,values.rank")).product_options
      assert(options.length > 0)
      const option = (await call(A, "POST", "/admin/product-options", {
        title: "Reusable", values: ["One"], is_exclusive: false,
      })).product_option
      const temporary = (await call(A, "POST", "/admin/products", {
        title: "Reusable option test", handle: "reusable-option-test", status: "draft",
        options: [{ title: "Temporary", values: ["One"] }],
      })).product
      const linked = (await call(A, "POST", `/admin/products/${temporary.id}/options/batch`, {
        add: [{ id: option.id, value_ids: option.values.map((value) => value.id) }],
      })).product
      assert(linked.options.some((row) => row.id === option.id))
      denied(await f.request(A.hostname, "POST", `/admin/products/${A.product.id}/options/batch`, { add: [B.product.options[0].id] }, owner(A)), [404])
      await call(A, "DELETE", `/admin/products/${temporary.id}`)
      await call(A, "DELETE", `/admin/product-options/${option.id}`)
    })
    await check("public categories remove internal and inactive children and private metadata", async () => {
      const parent = (await call(A, "POST", "/admin/product-categories", { name: "Visible", handle: "visible", is_active: true })).product_category
      await call(A, "POST", "/admin/product-categories", { name: "Hidden child", handle: "hidden-child", is_active: true, is_internal: true, parent_category_id: parent.id, metadata: { private_note: "do not expose" } })
      await call(A, "POST", "/admin/product-categories", { name: "Inactive child", handle: "inactive-child", is_active: false, parent_category_id: parent.id })
      const child = (await call(A, "POST", "/admin/product-categories", { name: "Visible child", handle: "visible-child", is_active: true, parent_category_id: parent.id })).product_category
      const categories = (await f.request(A.hostname, "GET", "/store/product-categories")).body.product_categories
      assert.equal(categories.length, 2)
      const selected = categories.find((row) => row.id === parent.id)
      assert.deepEqual(selected.category_children.map((row) => row.id), [child.id])
      assert(!JSON.stringify(categories).includes("Hidden child")); assert(!JSON.stringify(categories).includes("private_note"))
      assert(!JSON.stringify(categories).includes("Inactive child"))
      denied(await f.request(A.hostname, "GET", "/store/product-categories?fields=metadata"), [400])
    })
    await check("existing tenant M3 configuration is idempotent and preserves saved branding", async () => {
      await f.inStore(A, () => f.app.m3Runtime.initializeTenant(A))
      await f.inStore(A, () => f.app.m3Runtime.initializeTenant(A))
      assert.equal((await f.request(A.hostname, "GET", "/store/settings")).body.settings.name, "Alpha Brand")
      assert.equal((await call(A, "GET", "/admin/stock-locations")).stock_locations.length, 1)
      assert.equal((await call(A, "GET", "/admin/shipping-profiles")).shipping_profiles.length, 1)
    })
    await check("same customer email creates independent tenant identities and profiles", async () => {
      buyerA = await register(A); buyerB = await register(B); secondA = await register(A, "another-buyer@example.test")
      assert.notEqual(buyerA.customer.id, buyerB.customer.id)
      const profile = (await call(A, "POST", "/store/customers/me", { first_name: "Alpha Buyer" }, buyerA.headers)).customer
      assert.equal(profile.first_name, "Alpha Buyer")
      denied(await f.request(B.hostname, "GET", "/store/customers/me", null, buyerA.headers))
      denied(await f.request(A.hostname, "POST", "/store/customers/me", { email: "another@example.test" }, buyerA.headers), [400])
    })
    await check("address CRUD enforces the customer as well as the tenant", async () => {
      const address = { first_name: "Test", last_name: "Buyer", address_1: "1 Test St", city: "Boston", postal_code: "02110", country_code: "us" }
      const customer = (await call(A, "POST", "/store/customers/me/addresses", address, buyerA.headers)).customer
      const id = customer.addresses[0].id
      denied(await f.request(A.hostname, "GET", `/store/customers/me/addresses/${id}`, null, secondA.headers), [404])
      denied(await f.request(A.hostname, "POST", `/store/customers/me/addresses/${id}`, { city: "Wrong" }, secondA.headers), [404])
      denied(await f.request(A.hostname, "DELETE", `/store/customers/me/addresses/${id}`, null, secondA.headers), [404])
      denied(await f.request(B.hostname, "GET", `/store/customers/me/addresses/${id}`, null, buyerB.headers), [404])
      assert.equal((await call(A, "POST", `/store/customers/me/addresses/${id}`, { city: "Cambridge" }, buyerA.headers)).customer.addresses[0].city, "Cambridge")
      await call(A, "DELETE", `/store/customers/me/addresses/${id}`, null, buyerA.headers)
      assert.equal((await call(A, "GET", "/store/customers/me", null, buyerA.headers)).customer.addresses.length, 0)
    })
    await check("native carts, quantity edits and deletion keep customer ownership and server prices", async () => {
      for (const [tenant, buyer] of [[A, buyerA], [B, buyerB]]) {
        const cart = (await call(tenant, "POST", "/store/carts", { region_id: tenant.region.id,
          items: [{ variant_id: tenant.product.variants[0].id, quantity: 1 }] }, { ...buyer.headers, "idempotency-key": "m3-shared-cart-create" })).cart
        if (tenant === A) cartA = cart; else cartB = cart
      }
      assert.equal(cartA.total, 25); assert.equal(cartB.total, 37)
      cartA = (await call(A, "POST", `/store/carts/${cartA.id}/line-items/${cartA.items[0].id}`, { quantity: 2 }, buyerA.headers)).cart
      assert.equal(cartA.total, 50)
      denied(await f.request(A.hostname, "POST", `/store/carts/${cartA.id}/line-items/${cartA.items[0].id}`, { quantity: 3 }, secondA.headers), [404])
      denied(await f.request(A.hostname, "POST", `/store/carts/${cartA.id}/line-items/${cartB.items[0].id}`, { quantity: 3 }, buyerA.headers), [404])
      denied(await f.request(A.hostname, "POST", `/store/carts/${cartA.id}/line-items/${cartA.items[0].id}`, { quantity: 0 }, buyerA.headers), [400])
      const removed = await call(A, "DELETE", `/store/carts/${cartA.id}/line-items/${cartA.items[0].id}`, null, buyerA.headers)
      assert.equal(removed.parent.items.length, 0)
      cartA = (await call(A, "POST", `/store/carts/${cartA.id}/line-items`, { variant_id: A.product.variants[0].id, quantity: 1 }, buyerA.headers)).cart
    })
    await check("shipping choices, system test payments and order completion use native workflows for both stores", async () => {
      for (const [tenant, buyer, cart] of [[A, buyerA, cartA], [B, buyerB, cartB]]) {
        const address = { first_name: "Test", last_name: "Buyer", address_1: "1 Test St", city: "Boston", postal_code: "02110", country_code: "us" }
        await call(tenant, "POST", `/store/carts/${cart.id}`, { email: buyer.customer.email, shipping_address: address, billing_address: address }, buyer.headers)
        const options = (await call(tenant, "GET", `/store/shipping-options?cart_id=${cart.id}`, null, buyer.headers)).shipping_options
        assert.equal(options.length, 1); assert.equal(options[0].id, tenant.shipping.id)
        await call(tenant, "POST", `/store/carts/${cart.id}/shipping-methods`, { option_id: options[0].id }, buyer.headers)
        const payment = (await call(tenant, "POST", "/store/payment-collections", { cart_id: cart.id }, buyer.headers)).payment_collection
        await call(tenant, "POST", `/store/payment-collections/${payment.id}/payment-sessions`, { provider_id: "pp_system_default" }, buyer.headers)
        const completion = await call(tenant, "POST", `/store/carts/${cart.id}/complete`, {}, { ...buyer.headers, "idempotency-key": "m3-shared-completion" })
        assert.equal(completion.type, "order"); assert.equal(completion.order.total, tenant === A ? 30 : 42)
        if (tenant === A) orderA = completion.order; else orderB = completion.order
      }
      assert.notEqual(orderA.id, orderB.id)
    })
    await check("order lists, details and Admin queries reject cross-store and same-store customer access", async () => {
      const own = (await call(A, "GET", "/store/orders", null, buyerA.headers)).orders
      assert.equal(own.length, 1); assert.equal(own[0].id, orderA.id)
      assert.equal((await call(A, "GET", "/store/orders", null, secondA.headers)).orders.length, 0)
      denied(await f.request(A.hostname, "GET", `/store/orders/${orderA.id}`, null, secondA.headers), [404])
      denied(await f.request(A.hostname, "GET", `/store/orders/${orderB.id}`, null, buyerA.headers), [404])
      const admin = (await call(A, "GET", "/admin/orders")).orders
      assert.equal(admin.length, 1); assert.equal(admin[0].id, orderA.id)
      denied(await f.request(A.hostname, "GET", `/admin/orders/${orderB.id}`, null, owner(A)), [404])
    })
    await check("unreviewed Admin and public operations stay closed at the gateway", async () => {
      for (const path of ["/admin/products/export", "/admin/api-keys", "/admin/workflows", "/admin/users", "/store/orders/transfer", "/hooks/payment/stripe", "/admin/search"]) {
        denied(await f.request(A.hostname, "GET", path, null, owner(A)), [404])
      }
      denied(await f.request(A.hostname, "POST", `/admin/products/${A.product.id}`, { additional_data: { payload: true } }, owner(A)), [400])
      denied(await f.request(A.hostname, "GET", "/admin/products?limit=1001", null, owner(A)), [400])
      denied(await f.request(A.hostname, "GET", "/store/products", null, { "x-forwarded-host": B.hostname }), [400])
    })
  } finally {
    if (process.env.SAAS_M3_RESULT) fs.writeFileSync(process.env.SAAS_M3_RESULT, JSON.stringify({ milestone: "M3", nativeVersion: "2.18.0", checks: results,
      passed: results.length, routeContract: f.app.m3Runtime.contract, testPaymentOnly: true }, null, 2))
    await f.close()
  }
})
