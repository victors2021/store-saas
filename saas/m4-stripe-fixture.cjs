"use strict"
// Owned loopback protocol fixture. Native Medusa Stripe provider + real Stripe
// SDK make HTTP requests here; this is never described as Stripe sandbox acceptance.
const http = require("node:http"),
  crypto = require("node:crypto")
const Stripe = require("stripe"),
  qs = require("qs")
async function createStripeFixture(slugs = ["alpha", "bravo"]) {
  if (!Array.isArray(slugs) || !slugs.length || slugs.some(s=>typeof s!=="string" || !/^[a-z]{4,16}$/.test(s)) || new Set(slugs).size!==slugs.length)
    throw new Error("Explicit unique owned fixture accounts required")
  const accounts = new Map(),
    calls = [],
    idempotency = new Map(),
    failures = new Map(),
    pendingRefunds = new Set()
  for (const slug of slugs)
    accounts.set(`sk_test_${slug.repeat(6)}`, {
      id: `acct_${slug.repeat(3)}`,
      intents: new Map(),
      refunds: new Map(),
      next: 0,
    })
  const server = http.createServer(async (req, res) => {
    const parts = []
    for await (const part of req) parts.push(part)
    const key = req.headers.authorization?.replace(/^Bearer /, ""),
      account = accounts.get(key),
      body = qs.parse(Buffer.concat(parts).toString()),
      path = req.url.split("?")[0]
    const reply = (status, data) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "request-id": "req_fixture",
      })
      res.end(JSON.stringify(data))
    }
    if (!account)
      return reply(401, {
        error: {
          type: "authentication_error",
          message: "Invalid fixture credential",
        },
      })
    calls.push({
      account: account.id,
      method: req.method,
      path,
      body,
      idempotencyKey: req.headers["idempotency-key"],
    })
    const failKey = JSON.stringify([account.id, path]),
      failure = failures.get(failKey)
    if (failure) {
      failures.delete(failKey)
      return reply(failure, {
        error: { type: "api_error", message: "Fixture transient failure" },
      })
    }
    const cacheKey = JSON.stringify([
      account.id,
      path,
      req.headers["idempotency-key"],
    ])
    if (
      req.method === "POST" &&
      req.headers["idempotency-key"] &&
      idempotency.has(cacheKey)
    ) {
      const prior = idempotency.get(cacheKey)
      if (JSON.stringify(prior.input) !== JSON.stringify(body))
        return reply(400, {
          error: {
            type: "idempotency_error",
            message: "Fixture parameters changed",
          },
        })
      return reply(200, prior.output)
    }
    let output
    if (path === "/v1/account" && req.method === "GET")
      output = {
        id: account.id,
        object: "account",
        charges_enabled: true,
        details_submitted: true,
      }
    else if (path === "/v1/payment_intents" && req.method === "POST") {
      const id = `pi_fixture${++account.next}`
      output = {
        id,
        object: "payment_intent",
        amount: Number(body.amount),
        currency: body.currency,
        status: "requires_payment_method",
        client_secret: `${id}_secret_fixture${account.id}`,
        metadata: body.metadata || {},
        capture_method: body.capture_method,
        amount_received: 0,
        amount_capturable: 0,
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        payment_method: null,
      }
      account.intents.set(id, output)
    } else if (
      /^\/v1\/payment_intents\/[^/]+(?:\/(capture|cancel))?$/.test(path)
    ) {
      const parts = path.split("/"),
        intent = account.intents.get(parts[3])
      if (!intent)
        return reply(404, {
          error: {
            type: "invalid_request_error",
            message: "No such fixture payment intent",
          },
        })
      if (req.method === "POST" && parts[4] === "capture") {
        if (intent.status !== "requires_capture")
          return reply(400, {
            error: {
              type: "invalid_request_error",
              code: "payment_intent_unexpected_state",
              payment_intent: intent,
              message: "Fixture cannot capture",
            },
          })
        intent.status = "succeeded"
        intent.amount_received = intent.amount
        intent.amount_capturable = 0
      } else if (req.method === "POST" && parts[4] === "cancel") {
        if (intent.status === "succeeded")
          return reply(400, {
            error: {
              type: "invalid_request_error",
              message: "Fixture captured intent cannot cancel",
            },
          })
        intent.status = "canceled"
        intent.amount_capturable = 0
      } else if (req.method === "POST") {
        intent.amount = Number(body.amount)
        intent.metadata = { ...intent.metadata, ...body.metadata }
      }
      output = { ...intent }
    } else if (path === "/v1/refunds" && req.method === "POST") {
      const intent = account.intents.get(body.payment_intent),
        amount = Number(body.amount)
      const refunded = [...account.refunds.values()]
        .filter((row) => row.payment_intent === body.payment_intent)
        .reduce((sum, row) => sum + row.amount, 0)
      if (!intent || amount + refunded > intent.amount_received)
        return reply(400, {
          error: {
            type: "invalid_request_error",
            message: "Fixture refund exceeds captured amount",
          },
        })
      output = {
        id: "re_" + crypto.randomBytes(8).toString("hex"),
        object: "refund",
        payment_intent: intent.id,
        amount,
        currency: intent.currency,
        status: pendingRefunds.delete(account.id) ? "pending" : "succeeded",
      }
      account.refunds.set(output.id, output)
    } else if (
      /^\/v1\/refunds\/re_[A-Za-z0-9]+$/.test(path) &&
      req.method === "GET"
    ) {
      output = account.refunds.get(path.split("/")[3])
      if (!output)
        return reply(404, {
          error: {
            type: "invalid_request_error",
            message: "Fixture refund unavailable",
          },
        })
    } else
      return reply(404, {
        error: {
          type: "invalid_request_error",
          message: "Fixture endpoint unsupported",
        },
      })
    if (req.method === "POST" && req.headers["idempotency-key"])
      idempotency.set(cacheKey, { input: body, output })
    reply(200, output)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const factory = (key) =>
    new Stripe(key, {
      host: "127.0.0.1",
      port: server.address().port,
      protocol: "http",
      maxNetworkRetries: 0,
      timeout: 3000,
    })
  return {
    port: server.address().port,
    factory,
    calls,
    accounts,
    config: (slug) => ({
      api_key: `sk_test_${slug.repeat(6)}`,
      publishable_key: `pk_test_${slug.repeat(6)}`,
      webhook_secret: `whsec_${slug.repeat(6)}`,
      account_id: `acct_${slug.repeat(3)}`,
    }),
    confirm: (slug, id) => {
      const intent = accounts.get(`sk_test_${slug.repeat(6)}`).intents.get(id)
      intent.status = "requires_capture"
      intent.amount_capturable = intent.amount
      return intent
    },
    intent: (slug, id) =>
      accounts.get(`sk_test_${slug.repeat(6)}`).intents.get(id),
    failNext: (slug, path, status = 503) =>
      failures.set(JSON.stringify([`acct_${slug.repeat(3)}`, path]), status),
    pendNextRefund: (slug) => pendingRefunds.add(`acct_${slug.repeat(3)}`),
    settleRefunds: (slug) => {
      for (const refund of accounts
        .get(`sk_test_${slug.repeat(6)}`)
        .refunds.values())
        refund.status = "succeeded"
    },
    rotate: (slug) => {
      const next = {
        api_key: `sk_test_${slug.repeat(4)}rotation00000000`,
        publishable_key: `pk_test_${slug.repeat(4)}rotation00000000`,
        webhook_secret: `whsec_${slug.repeat(4)}rotation00000000`,
        account_id: `acct_${slug.repeat(3)}`,
      }
      accounts.set(next.api_key, accounts.get(`sk_test_${slug.repeat(6)}`))
      return next
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
module.exports = { createStripeFixture }
