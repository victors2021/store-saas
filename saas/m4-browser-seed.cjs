"use strict"
// Seed through real tenant HTTP routes before browser-operated merchant actions.
const { providerId } = require("./m4-payment.cjs")
async function seedM4Browser(f, stripe) {
  const buyer = {
    email: "m4-browser-buyer@example.test",
    password: f.credentials.password,
  }
  for (const tenant of f.tenants) {
    const owner = { authorization: `Bearer ${tenant.ownerToken}` }
    const call = async (method, path, body, headers = owner) =>
      f.ok(await f.request(tenant.hostname, method, path, body, headers))
    await call("POST", "/admin/saas/payments", stripe.config(tenant.slug))
    const inventory = (
      await call("POST", "/admin/inventory-items", {
        sku: "M4-BROWSER-STOCK",
        title: "M4 browser inventory",
      })
    ).inventory_item
    await call(
      "POST",
      `/admin/inventory-items/${inventory.id}/location-levels`,
      { location_id: tenant.location.id, stocked_quantity: 2 }
    )
    await call(
      "POST",
      `/admin/products/${tenant.product.id}/variants/inventory-items/batch`,
      {
        create: [
          {
            variant_id: tenant.product.variants[0].id,
            inventory_item_id: inventory.id,
            required_quantity: 1,
          },
        ],
      }
    )
    await call(
      "POST",
      `/admin/products/${tenant.product.id}/variants/${tenant.product.variants[0].id}`,
      { manage_inventory: true }
    )
    const unregistered = (
      await call("POST", "/auth/customer/emailpass/register", buyer, {})
    ).token
    await call(
      "POST",
      "/store/customers",
      { email: buyer.email },
      { authorization: `Bearer ${unregistered}` }
    )
    const auth = {
      authorization: `Bearer ${
        (await call("POST", "/auth/customer/emailpass", buyer, {})).token
      }`,
    }
    const address = {
      first_name: "M4",
      last_name: "Browser",
      address_1: "1 Test St",
      city: "Boston",
      postal_code: "02110",
      country_code: "us",
    }
    const cart = (
      await call(
        "POST",
        "/store/carts",
        {
          region_id: tenant.region.id,
          email: buyer.email,
          items: [{ variant_id: tenant.product.variants[0].id, quantity: 1 }],
          shipping_address: address,
          billing_address: address,
        },
        { ...auth, "idempotency-key": `m4-browser-cart-${tenant.slug}` }
      )
    ).cart
    await call(
      "POST",
      `/store/carts/${cart.id}/shipping-methods`,
      { option_id: tenant.shipping.id },
      auth
    )
    const collection = (
      await call(
        "POST",
        "/store/payment-collections",
        { cart_id: cart.id },
        auth
      )
    ).payment_collection
    const sessions = (
      await call(
        "POST",
        `/store/payment-collections/${collection.id}/payment-sessions`,
        { provider_id: providerId },
        auth
      )
    ).payment_collection.payment_sessions
    const binding = (
      await f.db.query(
        "SELECT intent_id FROM saas_payment_binding WHERE tenant_id=$1 AND id=$2",
        [tenant.id, sessions[0].id]
      )
    ).rows[0]
    await stripe.confirm(tenant.slug, binding.intent_id)
    const order = (
      await call(
        "POST",
        `/store/carts/${cart.id}/complete`,
        {},
        { ...auth, "idempotency-key": `m4-browser-complete-${tenant.slug}` }
      )
    ).order
    tenant.orderId = order.id
    tenant.inventoryId = inventory.id
  }
  return { buyer }
}
module.exports = { seedM4Browser }
