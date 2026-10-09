"use strict"
// Optional real Stripe *test-mode* API acceptance. Credentials are process
// inputs, never command arguments, source, screenshots or persisted receipts.
const fs = require("node:fs")
const names = ["ALPHA", "BRAVO"].flatMap((slug) =>
  ["API_KEY", "PUBLISHABLE_KEY", "WEBHOOK_SECRET", "ACCOUNT_ID"].map(
    (name) => `SAAS_STRIPE_${slug}_${name}`
  )
)
async function main() {
  const missing = names.filter((name) => !process.env[name])
  if (missing.length) {
    console.log(
      JSON.stringify({
        status: "pending",
        reason: "Independent Stripe test credentials are not configured",
        required: missing,
      })
    )
    process.exitCode = 2
    return
  }
  if (process.env.SAAS_M4_TEST_RESET !== "1")
    throw new Error("Explicit marked M4 test database reset flag is required")
  const configs = Object.fromEntries(
    ["alpha", "bravo"].map((slug) => [
      slug,
      {
        api_key: process.env[`SAAS_STRIPE_${slug.toUpperCase()}_API_KEY`],
        publishable_key:
          process.env[`SAAS_STRIPE_${slug.toUpperCase()}_PUBLISHABLE_KEY`],
        webhook_secret:
          process.env[`SAAS_STRIPE_${slug.toUpperCase()}_WEBHOOK_SECRET`],
        account_id: process.env[`SAAS_STRIPE_${slug.toUpperCase()}_ACCOUNT_ID`],
      },
    ])
  )
  if (
    Object.values(configs).some(
      (row) =>
        !row.api_key.startsWith("sk_test_") ||
        !row.publishable_key.startsWith("pk_test_")
    )
  )
    throw new Error("Only Stripe test keys are accepted")
  if (configs.alpha.account_id === configs.bravo.account_id)
    throw new Error("Two independent merchant test accounts are required")
  const { createFixture } = require("./m3-test-fixture.cjs"),
    { seedM4Browser } = require("./m4-browser-seed.cjs")
  const f = await createFixture({ payments: true }),
    checks = []
  try {
    await f.seedCommerce()
    await seedM4Browser(f, {
      config: (slug) => configs[slug],
      confirm: async (slug, id) => {
        const client = f.app.m4Runtime.payments.clientFor({
          apiKey: configs[slug].api_key,
        })
        await client.paymentIntents.confirm(
          id,
          { payment_method: "pm_card_visa" },
          { idempotencyKey: `m4-test-confirm-${slug}-${id}` }
        )
      },
    })
    checks.push(
      "two real Stripe test accounts verified and native managed orders authorized"
    )
    for (const tenant of f.tenants) {
      const headers = { authorization: `Bearer ${tenant.ownerToken}` }
      const call = async (method, path, body, key) =>
        f.ok(
          await f.request(tenant.hostname, method, path, body, {
            ...headers,
            ...(key ? { "idempotency-key": key } : {}),
          })
        )
      const order = (await call("GET", `/admin/orders/${tenant.orderId}`))
          .order,
        payment = order.payment_collections[0].payments[0]
      const capture = await call(
        "POST",
        `/admin/payments/${payment.id}/capture`,
        {},
        `m4-test-capture-${tenant.slug}`
      )
      const replay = await call(
        "POST",
        `/admin/payments/${payment.id}/capture`,
        {},
        `m4-test-capture-${tenant.slug}`
      )
      if (
        capture.payment.captures.length !== 1 ||
        replay.payment.captures.length !== 1
      )
        throw new Error("Sandbox duplicate capture failed")
      const refund = await call(
        "POST",
        `/admin/payments/${payment.id}/refund`,
        { amount: Number(payment.amount) },
        `m4-test-refund-${tenant.slug}`
      )
      if (refund.payment.refunds.length !== 1)
        throw new Error("Sandbox refund reconciliation failed")
      checks.push(
        `${tenant.slug}: native full capture, duplicate protection and full refund through its own merchant test account`
      )
    }
    const result = {
      status: "passed",
      sandbox_api_verified: true,
      official_webhook_delivery_verified: false,
      stripe_elements_browser_verified: false,
      real_money_moved: false,
      checks,
      remaining:
        "Real vendor webhook delivery and browser Elements require configured test keys and a reviewed reachable TLS deployment",
    }
    if (process.env.SAAS_M4_SANDBOX_RESULT)
      fs.writeFileSync(
        process.env.SAAS_M4_SANDBOX_RESULT,
        JSON.stringify(result, null, 2) + "\n"
      )
    console.log(JSON.stringify(result))
  } finally {
    await f.close()
  }
}
main().catch((error) => {
  console.error("Stripe sandbox acceptance failed", {
    name: error.name,
    code: error.code,
  })
  process.exitCode = 1
})
