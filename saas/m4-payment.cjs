"use strict"
const crypto = require("node:crypto")
const { AsyncLocalStorage } = require("node:async_hooks")
const { MedusaError } = require("@medusajs/framework/utils")
const Stripe = require("stripe")
const { HttpsProxyAgent } = require("https-proxy-agent")
const { tenantSQL } = require("./tenant-sql.cjs")
const { currentTenant } = require("./tenant-context.cjs")
const { providerId } = require("./migrations/0006-payments.cjs")
const invalid = (message) => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}
const unavailable = () => {
  throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment is unavailable")
}
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex")
const operations = new AsyncLocalStorage()

function createTenantPayments({
  nativeApp,
  pool,
  paymentKey,
  testStripeFactory,
}) {
  if (typeof paymentKey !== "string" || !/^[a-f0-9]{64}$/i.test(paymentKey))
    throw new TypeError(
      "A separate 32-byte hexadecimal SAAS_PAYMENT_KEY is required"
    )
  if (testStripeFactory && process.env.NODE_ENV !== "test")
    throw new Error(
      "Stripe fixture transport is only available under NODE_ENV=test"
    )
  const key = Buffer.from(paymentKey, "hex")
  const Provider = require("@medusajs/payment-stripe").default.services.find(
    (service) => service.identifier === "stripe"
  )
  if (!Provider) throw new Error("The pinned native Stripe provider is missing")
  const encode = (id, value) => {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(
      Buffer.from(JSON.stringify([currentTenant().tenantId, id, "stripe", 1]))
    )
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ])
    return [iv, cipher.getAuthTag(), body]
      .map((part) => part.toString("base64url"))
      .join(".")
  }
  const decode = (row) => {
    try {
      const [iv, tag, body] = row.ciphertext
        .split(".")
        .map((part) => Buffer.from(part, "base64url"))
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([currentTenant().tenantId, row.id, "stripe", 1])
        )
      )
      cipher.setAuthTag(tag)
      return {
        ...row,
        ...JSON.parse(
          Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8")
        ),
      }
    } catch {
      throw new Error("Payment credential cannot be decrypted")
    }
  }
  const credential = async (id) => {
    const row = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(
            `SELECT * FROM saas_payment_credential WHERE ${
              id ? "id=$1" : "active"
            } LIMIT 1`,
            id ? [id] : []
          )
        ).rows[0]
    )
    if (!row)
      invalid(
        "Configure this store's Stripe test account before accepting payment"
      )
    return decode(row)
  }
  const clientFor = (row) => {
    if (testStripeFactory) return testStripeFactory(row.apiKey)
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    return new Stripe(row.apiKey, {
      timeout: 15000,
      maxNetworkRetries: 2,
      ...(proxy ? { httpAgent: new HttpsProxyAgent(proxy) } : {}),
    })
  }
  const providerFor = (row) => {
    const provider = new Provider(
      {},
      {
        apiKey: row.apiKey,
        webhookSecret: row.webhookSecret,
        capture: false,
        automaticPaymentMethods: false,
      }
    )
    // A new provider and SDK client per call; no mutable cross-tenant singleton.
    provider.stripe_ = clientFor(row)
    return provider
  }
  const vendorCall = async (method, task) => {
    try {
      return await task()
    } catch {
      throw new Error(
        `Stripe ${method} did not finish; retry with the same idempotency key`
      )
    }
  }
  const binding = async (data) => {
    if (!data || typeof data.id !== "string") unavailable()
    const row = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(
            "SELECT * FROM saas_payment_binding WHERE intent_id=$1",
            [data.id]
          )
        ).rows[0]
    )
    if (!row || row.state === "creating") unavailable()
    return row
  }
  const publicConfig = async (hostname) => {
    const row = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(`SELECT c.id,c.account_id,c.publishable_key,c.mode,e.id AS endpoint
      FROM saas_payment_credential c JOIN saas_control.payment_endpoint e ON e.tenant_id=c.tenant_id AND e.credential_id=c.id
      WHERE c.active LIMIT 1`)
        ).rows[0]
    )
    return row
      ? {
          provider_id: providerId,
          mode: row.mode,
          account_id: row.account_id,
          publishable_key: row.publishable_key,
          ...(hostname
            ? {
                webhook_url: `https://${hostname}/hooks/stripe/${row.endpoint}`,
              }
            : {}),
        }
      : null
  }
  async function configure(input, hostname) {
    const { z } = require("zod")
    const data = z
      .object({
        api_key: z.string().regex(/^sk_test_[A-Za-z0-9]{16,256}$/),
        publishable_key: z.string().regex(/^pk_test_[A-Za-z0-9]{16,256}$/),
        webhook_secret: z.string().regex(/^whsec_[A-Za-z0-9]{16,256}$/),
        account_id: z.string().regex(/^acct_[A-Za-z0-9]{6,128}$/),
      })
      .strict()
      .parse(input)
    const api = clientFor({ apiKey: data.api_key })
    let account
    try {
      account = await api.accounts.retrieve()
    } catch {
      invalid("Stripe test account verification failed")
    }
    if (account.id !== data.account_id || account.deleted)
      invalid("Stripe credentials do not belong to this merchant account")
    const identity = currentTenant(),
      id = "spc_" + crypto.randomBytes(16).toString("hex"),
      endpoint = "pwh_" + crypto.randomBytes(24).toString("hex")
    const ciphertext = encode(id, {
      apiKey: data.api_key,
      webhookSecret: data.webhook_secret,
    })
    await tenantSQL(pool, async (client) => {
      const prior = (
        await client.query(
          "SELECT account_id,tenant_id FROM saas_control.payment_account WHERE account_id=$1 OR tenant_id=$2",
          [account.id, identity.tenantId]
        )
      ).rows
      if (
        prior.some(
          (row) =>
            row.tenant_id !== identity.tenantId || row.account_id !== account.id
        )
      )
        invalid(
          "A merchant account must belong to exactly one store; rotation must keep the same account"
        )
      await client.query(
        "INSERT INTO saas_control.payment_account(account_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [account.id, identity.tenantId]
      )
      const bound = (
        await client.query(
          "SELECT tenant_id FROM saas_control.payment_account WHERE account_id=$1",
          [account.id]
        )
      ).rows[0]
      if (bound?.tenant_id !== identity.tenantId)
        invalid("This merchant account is already assigned")
      await client.query(
        "INSERT INTO saas_payment_credential(id,account_id,publishable_key,ciphertext,mode,active) VALUES($1,$2,$3,$4,'test',false)",
        [id, account.id, data.publishable_key, ciphertext]
      )
      await client.query(
        "INSERT INTO saas_control.payment_endpoint(id,tenant_id,credential_id,account_id) VALUES($1,$2,$3,$4)",
        [endpoint, identity.tenantId, id, account.id]
      )
    })
    // Existing sessions retain their credential version; only new sessions change.
    for (const region of await nativeApp.modules.region.listRegions({})) {
      const links = await nativeApp.query.graph({
        entity: "region_payment_provider",
        fields: ["payment_provider_id"],
        filters: { region_id: region.id },
      })
      for (const link of links.data)
        if (link.payment_provider_id !== providerId)
          await nativeApp.link.dismiss({
            region: { region_id: region.id },
            payment: { payment_provider_id: link.payment_provider_id },
          })
      if (!links.data.some((link) => link.payment_provider_id === providerId))
        await nativeApp.link.create({
          region: { region_id: region.id },
          payment: { payment_provider_id: providerId },
        })
    }
    await tenantSQL(pool, async (client) => {
      await client.query(
        "UPDATE saas_payment_credential SET active=false WHERE active"
      )
      await client.query(
        "UPDATE saas_payment_credential SET active=true WHERE id=$1",
        [id]
      )
    })
    return publicConfig(hostname)
  }
  const effect = async (method, row, input, task) => {
    const op = operations.getStore()
    const source =
      op?.id ||
      input.context?.idempotency_key ||
      (["cancelPayment", "deletePayment"].includes(method)
        ? `session-${row.id}`
        : null)
    if (!source)
      throw new Error("A durable payment operation identity is required")
    const id =
      "spe_" +
      digest(
        JSON.stringify([
          currentTenant().tenantId,
          source,
          method,
          row.id,
          input.amount ?? null,
        ])
      ).slice(0, 40)
    const fingerprint = digest(
      JSON.stringify([method, row.id, input.amount ?? null])
    )
    const prior = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(
            "INSERT INTO saas_payment_effect(id,fingerprint,binding_id,operation_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET id=excluded.id RETURNING *",
            [id, fingerprint, row.id, op?.id?.startsWith("spo_") ? op.id : null]
          )
        ).rows[0]
    )
    if (prior.fingerprint !== fingerprint)
      invalid("Payment operation parameters changed")
    if (prior.result) return prior.result
    // Vendor idempotency survives native workflow compensation and process restarts.
    const result = await task({
      ...input,
      context: { ...input.context, idempotency_key: id },
    })
    await tenantSQL(pool, (client) =>
      client.query("UPDATE saas_payment_effect SET result=$2 WHERE id=$1", [
        id,
        result,
      ])
    )
    return result
  }
  async function initiatePayment(input) {
    const sessionId = input.data?.session_id
    if (
      typeof sessionId !== "string" ||
      !/^payses_[A-Za-z0-9]+$/.test(sessionId)
    )
      unavailable()
    const active = await credential()
    const row = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(
            `INSERT INTO saas_payment_binding(id,credential_id,amount,currency_code)
      VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,id) DO UPDATE SET id=excluded.id RETURNING *`,
            [sessionId, active.id, String(input.amount), input.currency_code]
          )
        ).rows[0]
    )
    if (
      String(row.amount) !== String(input.amount) ||
      row.currency_code !== input.currency_code
    )
      invalid("Payment session parameters changed")
    const chosen = await credential(row.credential_id),
      provider = providerFor(chosen)
    const result = await vendorCall("initiate", () =>
      effect("initiate", row, input, (safe) =>
        provider.initiatePayment({
          ...safe,
          data: {
            session_id: sessionId,
            payment_method_types: ["card"],
            capture_method: "manual",
          },
          context: { idempotency_key: safe.context.idempotency_key },
        })
      )
    )
    if (
      !result.data?.id ||
      !result.data?.client_secret ||
      result.data?.indeterminate_due_to
    )
      throw new Error(
        "Stripe payment creation requires reconciliation before retry"
      )
    await tenantSQL(pool, (client) =>
      client.query(
        "UPDATE saas_payment_binding SET intent_id=$2,state='ready' WHERE id=$1",
        [sessionId, result.data.id]
      )
    )
    return {
      ...result,
      data: { ...result.data, publishable_key: chosen.publishable_key },
    }
  }
  const facade = { initiatePayment }
  for (const method of [
    "authorizePayment",
    "getPaymentStatus",
    "capturePayment",
    "refundPayment",
    "cancelPayment",
    "deletePayment",
    "updatePayment",
    "retrievePayment",
  ]) {
    facade[method] = async (input) => {
      const row = await binding(input.data),
        chosen = await credential(row.credential_id),
        provider = providerFor(chosen)
      if (method === "updatePayment") {
        if (input.currency_code !== row.currency_code)
          invalid("Payment session currency cannot change")
        const amount = String(input.amount)
        const pending = await tenantSQL(pool, async (client) => {
          const current = (
            await client.query(
              "SELECT * FROM saas_payment_binding WHERE id=$1 FOR UPDATE",
              [row.id]
            )
          ).rows[0]
          if (
            current.update_amount !== null &&
            Number(current.update_amount) !== Number(amount)
          )
            invalid(
              "Retry the pending payment update before changing its amount"
            )
          return (
            await client.query(
              `UPDATE saas_payment_binding SET update_revision=update_revision+CASE WHEN update_amount IS NULL THEN 1 ELSE 0 END,
            update_amount=$2 WHERE id=$1 RETURNING *`,
              [row.id, amount]
            )
          ).rows[0]
        })
        // A -> B -> A is a new update, rather than a replay of an older Stripe result.
        const idempotency_key =
          "spu_" +
          digest(
            JSON.stringify([
              currentTenant().tenantId,
              row.id,
              pending.update_revision,
            ])
          ).slice(0, 40)
        const result = await vendorCall(method, () =>
          provider.updatePayment({
            ...input,
            data: { id: row.intent_id },
            context: { ...input.context, idempotency_key },
          })
        )
        const expected =
          require("@medusajs/payment-stripe/dist/utils/get-smallest-unit").getSmallestUnit(
            input.amount,
            input.currency_code
          )
        if (
          result.data?.id !== row.intent_id ||
          result.data.amount !== expected
        )
          invalid("Stripe payment amount update requires reconciliation")
        await tenantSQL(pool, (client) =>
          client.query(
            "UPDATE saas_payment_binding SET amount=$2,update_amount=NULL WHERE id=$1 AND update_revision=$3",
            [row.id, amount, pending.update_revision]
          )
        )
        return {
          ...result,
          data: { ...result.data, publishable_key: chosen.publishable_key },
        }
      }
      if (method === "authorizePayment" || method === "getPaymentStatus") {
        const result = await vendorCall(method, () => provider[method](input))
        const intent = result.data
        const expected =
          require("@medusajs/payment-stripe/dist/utils/get-smallest-unit").getSmallestUnit(
            row.amount,
            row.currency_code
          )
        if (
          intent.id !== row.intent_id ||
          intent.metadata?.session_id !== row.id ||
          intent.currency !== row.currency_code ||
          intent.amount !== expected ||
          intent.livemode
        )
          invalid(
            "Stripe payment does not match the store's session and amount"
          )
        return result
      }
      if (method === "retrievePayment")
        return vendorCall(method, () => provider.retrievePayment(input))
      return effect(method, row, input, async (safe) => {
        if (method === "refundPayment") {
          const create = provider.stripe_.refunds.create.bind(
            provider.stripe_.refunds
          )
          provider.stripe_.refunds.create = async (...args) => {
            let refund
            try {
              const prior=await tenantSQL(pool,async client=>(await client.query("SELECT remote_id,created_at FROM saas_payment_effect WHERE id=$1",[safe.context.idempotency_key])).rows[0])
              // Persisted vendor IDs outlive Stripe's idempotency cache. Never
              // create a second refund when a pending remote refund is known.
              if(!prior?.remote_id&&Date.now()-new Date(prior.created_at).getTime()>23*3600000)
                throw new Error("Old uncertain refund requires merchant reconciliation before retry")
              refund = prior?.remote_id ? await provider.stripe_.refunds.retrieve(prior.remote_id) : await create(...args)
              if(refund.payment_intent!==row.intent_id||refund.currency!==row.currency_code||Number(refund.amount)!==Number(args[0].amount))
                throw new Error("Remote refund does not match the saved operation")
            } catch {
              throw new Error("Stripe refund result needs reconciliation")
            }
            await tenantSQL(pool, (client) =>
              client.query(
                "UPDATE saas_payment_effect SET remote_id=$2 WHERE id=$1",
                [safe.context.idempotency_key, refund.id]
              )
            )
            if (refund.status === "pending")
              refund = await provider.stripe_.refunds.retrieve(refund.id)
            if (refund.status !== "succeeded")
              throw new Error(
                "Stripe refund has not settled; retry this operation after reconciliation"
              )
            return refund
          }
        }
        try {
          const result = await provider[method](safe)
          if (method === "capturePayment") {
            const expected =
              require("@medusajs/payment-stripe/dist/utils/get-smallest-unit").getSmallestUnit(
                row.amount,
                row.currency_code
              )
            if (result.data?.amount_received !== expected)
              throw new Error("External partial capture needs reconciliation")
          }
          return result
        } catch {
          throw new Error(
            `Stripe ${method} did not finish; retry with the same idempotency key`
          )
        }
      })
    }
  }
  const providers = nativeApp.modules.payment.paymentProviderService_
  const originalRetrieve = providers.retrieveProvider.bind(providers)
  providers.retrieveProvider = (id) =>
    id === providerId ? (currentTenant(), facade) : originalRetrieve(id)
  return {
    providerId,
    credential,
    binding,
    publicConfig,
    configure,
    providerFor,
    clientFor,
    withOperation: (operation, task) => operations.run(operation, task),
  }
}
module.exports = { createTenantPayments, digest, providerId }
