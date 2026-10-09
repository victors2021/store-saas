"use strict"
const crypto = require("node:crypto")
const express = require("express")
const jwt = require("jsonwebtoken")
const { MedusaError } = require("@medusajs/framework/utils")
const {
  createTenantVerifier,
  currentTenant,
  runWithTenant,
} = require("./tenant-context.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
const { createTenantPayments, digest, providerId } = require("./m4-payment.cjs")
const { z } = require("zod")
const invalid = (message) => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}
const missing = () => {
  throw new MedusaError(MedusaError.Types.NOT_FOUND, "Object is unavailable")
}
const conflict = (message) => {
  const error = new Error(message)
  error.code = "M4_OPERATION_CONFLICT"
  throw error
}
const identifier = z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/)
const money = z.number().finite().positive().max(10000000)
const item = z
  .object({ id: identifier, quantity: z.number().int().positive().max(999) })
  .strict()
const empty = z.object({}).strict()
const schemas = {
  capture: z.object({ amount: money.optional() }).strict(),
  refund: z
    .object({ amount: money, note: z.string().max(400).optional() })
    .strict(),
  fulfillment: z
    .object({
      items: z.array(item).min(1).max(100),
      location_id: identifier,
      shipping_option_id: identifier.optional(),
      no_notification: z.boolean().optional(),
    })
    .strict(),
  shipment: z
    .object({
      items: z.array(item).min(1).max(100),
      labels: z
        .array(
          z
            .object({
              tracking_number: z.string().min(1).max(128),
              tracking_url: z
                .string()
                .url()
                .regex(/^https?:\/\//),
              label_url: z
                .string()
                .url()
                .regex(/^https?:\/\//),
            })
            .strict()
        )
        .max(5)
        .optional(),
      no_notification: z.boolean().optional(),
    })
    .strict(),
  cancel: empty,
  cancelFulfillment: empty,
}
const PAYMENT_FIELDS = [
  "id",
  "amount",
  "currency_code",
  "provider_id",
  "captured_at",
  "canceled_at",
  "captures.id",
  "captures.amount",
  "refunds.id",
  "refunds.amount",
  "refunds.note",
]
const actionRoutes = [
  ["capture", "/admin/payments/:id/capture", "capture-payment-workflow"],
  ["refund", "/admin/payments/:id/refund", "refund-payment-workflow"],
  ["fulfillment", "/admin/orders/:id/fulfillments", "create-order-fulfillment"],
  [
    "shipment",
    "/admin/orders/:id/fulfillments/:fulfillment_id/shipments",
    "create-order-shipment",
  ],
  ["cancel", "/admin/orders/:id/cancel", "cancel-order"],
  [
    "cancelFulfillment",
    "/admin/orders/:id/fulfillments/:fulfillment_id/cancel",
    "cancel-order-fulfillment",
  ],
]
const pattern = (path) =>
  new RegExp(
    "^" +
      path
        .split("/")
        .map((p) => (p.startsWith(":") ? "[a-z]+_[A-Za-z0-9]+" : p))
        .join("/") +
      "$"
  )

function createM4Runtime({
  nativeApp,
  pool,
  m2Runtime,
  contextSecret,
  paymentKey,
  getControl,
  testStripeFactory,
  operations = false,
}) {
  require("@medusajs/core-flows") // Register reviewed native workflows, never synthetic orders/payments.
  const payments = createTenantPayments({
    nativeApp,
    pool,
    paymentKey,
    testStripeFactory,
  })
  const { WorkflowManager } = require("@medusajs/framework/orchestration")
  for (const [, , workflow] of actionRoutes) {
    const definition = WorkflowManager.getWorkflow(workflow)
    if (!definition) throw new Error("Reviewed M4 workflow is not registered")
    WorkflowManager.update(workflow, definition.flow_, definition.handlers_, {
      ...definition.options,
      store: true,
      retentionTime: 7 * 24 * 60 * 60,
    })
  }
  const routes = [
    ["GET", /^\/admin\/saas\/payments$/],
    ["POST", /^\/admin\/saas\/payments$/],
    ["GET", /^\/admin\/saas\/metrics$/],
    ["GET", /^\/store\/saas\/payments$/],
    ...actionRoutes.map(([, path]) => ["POST", pattern(path)]),
  ]
  async function enabledForRegion(regionId) {
    await nativeApp.modules.region.retrieveRegion(regionId)
    if (!(await payments.publicConfig())) return false
    const links = await nativeApp.query.graph({
      entity: "region_payment_provider",
      fields: ["region_id"],
      filters: { region_id: regionId, payment_provider_id: providerId },
    })
    return links.data.length > 0
  }
  async function tradeLock(task) {
    const client = await pool.connect(),
      key = JSON.stringify(["m4-commerce", currentTenant().tenantId])
    let locked = false
    try {
      locked = (
        await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          [key]
        )
      ).rows[0].locked
      if (!locked)
        conflict(
          "Another checkout or order operation is running; retry with the same idempotency key"
        )
      return await task()
    } finally {
      if (locked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1,0))",
          [key]
        )
      client.release()
    }
  }
  async function runOperation(kind, resourceId, key, payload, task) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
      invalid("An idempotency-key header of 8–128 characters is required")
    const fingerprint = digest(JSON.stringify([kind, resourceId, payload]))
    return tradeLock(async () => {
      const row = await tenantSQL(
        pool,
        async (client) =>
          (
            await client.query(
              `INSERT INTO saas_payment_operation(id,kind,resource_id,idempotency_key,fingerprint,payload)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,kind,idempotency_key) DO UPDATE SET id=saas_payment_operation.id RETURNING *`,
              [
                "spo_" + crypto.randomBytes(16).toString("hex"),
                kind,
                resourceId,
                key,
                fingerprint,
                payload,
              ]
            )
          ).rows[0]
      )
      if (row.fingerprint !== fingerprint)
        conflict("This idempotency key was used for a different operation")
      if (row.state === "done") return row.result
      const attempt = row.attempts + 1
      await tenantSQL(pool, (client) =>
        client.query(
          "UPDATE saas_payment_operation SET state='pending',attempts=$2,error_code=NULL,updated_at=now() WHERE id=$1",
          [row.id, attempt]
        )
      )
      try {
        const result = await payments.withOperation(row, () =>
          task({ ...row, attempt })
        )
        await tenantSQL(pool, (client) =>
          client.query(
            "UPDATE saas_payment_operation SET state='done',result=$2,updated_at=now() WHERE id=$1",
            [row.id, result]
          )
        )
        return result
      } catch (error) {
        await tenantSQL(pool, (client) =>
          client.query(
            "UPDATE saas_payment_operation SET state='failed',error_code=$2,updated_at=now() WHERE id=$1",
            [row.id, error.type || error.code || error.name]
          )
        )
        throw error
      }
    })
  }
  const graphOne = async (entity, id, fields) => {
    const { data } = await nativeApp.query.graph({
      entity,
      fields,
      filters: { id },
      options: { throwIfKeyNotFound: true },
    })
    if (!data[0]) missing()
    return data[0]
  }
  async function orderForPayment(id) {
    const payment = await nativeApp.modules.payment.retrievePayment(id, {
      relations: ["captures", "refunds"],
    })
    const { data } = await nativeApp.query.graph({
      entity: "order_payment_collection",
      fields: ["order.id"],
      filters: { payment_collection_id: payment.payment_collection_id },
    })
    if (!data[0]?.order?.id) missing()
    const order = await nativeApp.modules.order.retrieveOrder(data[0].order.id)
    if (payment.provider_id !== providerId || order.status === "canceled")
      invalid("Only an active order's tenant Stripe payment is available")
    await payments.binding(payment.data)
    return { payment, order }
  }
  async function action(kind, req, payload, op, workflow) {
    const {_fulfillment_id:fulfillmentId,...businessPayload}=payload
    payload=businessPayload
    if(fulfillmentId) req={...req,params:{...req.params,fulfillment_id:fulfillmentId}}
    const result = () =>
      kind === "capture" || kind === "refund"
        ? graphOne("payment", req.params.id, PAYMENT_FIELDS).then(
            (payment) => ({ payment })
          )
        : graphOne("order", req.params.id, [
            "id",
            "status",
            "payment_status",
            "fulfillment_status",
            "items.id",
            "items.quantity",
            "fulfillments.id",
            "fulfillments.shipped_at",
            "fulfillments.canceled_at",
            "fulfillments.items.line_item_id",
            "fulfillments.items.quantity",
          ]).then((order) => ({ order }))
    if (op.attempt > 1) {
      const prefix =
        "t" +
        crypto
          .createHmac("sha256", contextSecret)
          .update(currentTenant().tenantId)
          .digest("hex")
          .slice(0, 24) +
        "-" +
        op.id +
        "-"
      const completed = await tenantSQL(
        pool,
        async (client) =>
          (
            await client.query(
              `SELECT 1 FROM workflow_execution
        WHERE workflow_id=$1 AND left(transaction_id,length($2))=$2 AND state='done' AND deleted_at IS NULL LIMIT 1`,
              [workflow, prefix]
            )
          ).rowCount > 0
      )
      if (completed) return result()
    }
    if(operations && (await getControl().getTenant(currentTenant().tenantId))?.status==="suspended") {
      if(kind==="capture") await require("./m5-policy.cjs").requireActive(getControl())
      if(["fulfillment","shipment"].includes(kind)) await require("./m5-policy.cjs").paidOrder(nativeApp,req.params.id)
    }
    let input
    if (["capture", "refund"].includes(kind)) {
      const { payment } = await orderForPayment(req.params.id)
      const captured = payment.captures.reduce(
        (sum, row) => sum + Number(row.amount),
        0
      )
      const refunded = payment.refunds.reduce(
        (sum, row) => sum + Number(row.amount),
        0
      )
      if (kind === "capture") {
        if (payment.canceled_at) invalid("Canceled payments cannot be captured")
        if (
          payload.amount !== undefined &&
          payload.amount !== Number(payment.amount)
        )
          invalid("M4 supports full authorization capture only")
        input = { payment_id: payment.id, captured_by: currentTenant().actorId }
      } else {
        const unit = require("@medusajs/payment-stripe/dist/utils/get-smallest-unit")
        const precision = unit.getSmallestUnit(
          payload.amount,
          payment.currency_code
        )
        if (
          !Number.isSafeInteger(precision) ||
          Math.abs(
            unit.getAmountFromSmallestUnit(precision, payment.currency_code) -
              payload.amount
          ) > 1e-9
        )
          invalid("Refund amount exceeds currency precision")
        const prior = payment.refunds.find(
          (refund) => refund.metadata?.saas_operation === op.id
        )
        if (!prior && payload.amount > captured - refunded + 1e-9)
          invalid("Refund exceeds the remaining captured amount")
        input = {
          payment_id: payment.id,
          created_by: currentTenant().actorId,
          ...payload,
          metadata: { saas_operation: op.id },
        }
      }
    } else {
      const order = await graphOne("order", req.params.id, [
        "id",
        "status",
        "items.*",
        "items.detail.*",
        "fulfillments.id",
        "fulfillments.canceled_at",
        "fulfillments.shipped_at",
        "fulfillments.items.line_item_id",
        "fulfillments.items.quantity",
      ])
      if (order.status === "canceled" && kind !== "cancel")
        invalid("Canceled orders cannot be fulfilled")
      if (payload.items) {
        if (
          new Set(payload.items.map((row) => row.id)).size !==
          payload.items.length
        )
          invalid("Duplicate order item")
        for (const row of payload.items)
          if (
            !order.items.some(
              (item) => item.id === row.id && row.quantity <= item.quantity
            )
          )
            missing()
      }
      if (req.params.fulfillment_id) {
        const fulfillment = order.fulfillments.find(
          (row) => row.id === req.params.fulfillment_id
        )
        if (!fulfillment) missing()
        if (
          kind === "shipment" &&
          (fulfillment.shipped_at || fulfillment.canceled_at)
        )
          invalid("This fulfillment cannot be shipped")
        if (kind === "shipment")
          for (const row of payload.items)
            if (
              !fulfillment.items.some(
                (item) =>
                  item.line_item_id === row.id && row.quantity <= item.quantity
              )
            )
              missing()
      }
      if (payload.location_id)
        await nativeApp.modules.stock_location.retrieveStockLocation(
          payload.location_id
        )
      if (payload.shipping_option_id) {
        const option =
          await nativeApp.modules.fulfillment.retrieveShippingOption(
            payload.shipping_option_id
          )
        if (option.provider_id !== "manual_manual")
          invalid("Only native manual shipment is available")
      }
      input = {
        ...payload,
        order_id: order.id,
        ...(req.params.fulfillment_id
          ? { fulfillment_id: req.params.fulfillment_id }
          : {}),
        ...(["cancel", "cancelFulfillment"].includes(kind)
          ? { canceled_by: currentTenant().actorId }
          : { created_by: currentTenant().actorId }),
      }
    }
    await nativeApp.modules.workflows.run(workflow, {
      input,
      transactionId: `${op.id}-${op.attempt}`,
    })
    return result()
  }
  // A refund step may have committed before its workflow checkpoint was saved.
  // Reuse the native refund row stamped by the server's operation ID on recovery.
  const refundPayment = nativeApp.modules.payment.refundPayment.bind(
    nativeApp.modules.payment
  )
  nativeApp.modules.payment.refundPayment = async (input, ...args) => {
    const operation = input.metadata?.saas_operation
    if (operation) {
      const rows = await nativeApp.modules.payment.listRefunds({
        payment_id: input.payment_id,
      })
      if (rows.some((row) => row.metadata?.saas_operation === operation))
        return nativeApp.modules.payment.retrievePayment(input.payment_id, {
          relations: ["captures", "refunds"],
        })
    }
    return refundPayment(input, ...args)
  }
  async function completeCart(payload, task) {
    return tradeLock(() =>
      payments.withOperation({ id: `checkout-${payload.cartId}` }, async () => {
        const cart = await nativeApp.modules.cart.retrieveCart(payload.cartId)
        if (cart.customer_id !== currentTenant().actorId) missing()
        const linked = await nativeApp.query.graph({
          entity: "order_cart",
          fields: ["order_id"],
          filters: { cart_id: cart.id },
        })
        if (linked.data[0]?.order_id)
          return { order_id: linked.data[0].order_id }
        if(operations) await require("./m5-policy.cjs").requireActive(getControl())
        return task()
      })
    )
  }
  function mount(web, { asyncHandler, owner }) {
    web.use((req, res, next) => {
      if (req.path.startsWith("/store/")) {
        const json = res.json.bind(res)
        res.json = (body) => {
          for (const collection of [
            body?.cart?.payment_collection,
            body?.payment_collection,
          ])
            for (const session of collection?.payment_sessions || [])
              if (session.data)
                session.data =
                  session.provider_id === providerId
                    ? {
                        client_secret: session.data.client_secret,
                        publishable_key: session.data.publishable_key,
                      }
                    : {}
          return json(body)
        }
      }
      next()
    })
    web.get(
      "/admin/saas/payments",
      owner,
      asyncHandler(async (req, res) =>
        res.json({ payment: await payments.publicConfig(req.tenant.hostname) })
      )
    )
    web.post(
      "/admin/saas/payments",
      owner,
      asyncHandler(async (req, res) =>
        res.json({
          payment: await tradeLock(() =>
            payments.configure(req.body, req.tenant.hostname)
          ),
        })
      )
    )
    web.get(
      "/store/saas/payments",
      asyncHandler(async (req, res) =>
        res.json({ payment: await payments.publicConfig() })
      )
    )
    web.get(
      "/admin/saas/metrics",
      owner,
      asyncHandler(async (req, res) => res.json(await metrics()))
    )
    // Override the global provider directory with this store's enabled provider.
    web.get(
      "/store/payment-providers",
      asyncHandler(async (req, res) => {
        if (typeof req.query.region_id !== "string")
          invalid("region_id is required")
        const enabled = await enabledForRegion(req.query.region_id)
        res.json({
          payment_providers: enabled
            ? [{ id: providerId, is_enabled: true }]
            : [],
          count: enabled ? 1 : 0,
          offset: 0,
          limit: 100,
        })
      })
    )
    for (const [kind, path, workflow] of actionRoutes)
      web.post(
        path,
        owner,
        asyncHandler(async (req, res) => {
          const body = schemas[kind].parse(req.body)
          const payload = req.params.fulfillment_id ? {...body,_fulfillment_id:req.params.fulfillment_id} : body
          const result = await runOperation(
            kind,
            req.params.id,
            req.headers["idempotency-key"],
            payload,
            (op) => action(kind, req, payload, op, workflow)
          )
          res.json(result)
        })
      )
  }
  async function metrics() {
    return tenantSQL(pool, async (client) => {
      const totals = await client.query(
        `WITH amounts AS (
        SELECT o.currency_code,count(*)::numeric AS orders,count(*) FILTER(WHERE o.status='canceled')::numeric AS canceled,
          0::numeric AS captured,0::numeric AS refunded FROM "order" o
          WHERE o.deleted_at IS NULL AND NOT o.is_draft_order GROUP BY o.currency_code
        UNION ALL
        SELECT p.currency_code,0,0,sum(c.amount),0 FROM capture c JOIN payment p ON p.tenant_id=c.tenant_id AND p.id=c.payment_id
          WHERE c.deleted_at IS NULL AND p.deleted_at IS NULL AND p.provider_id=$1 GROUP BY p.currency_code
        UNION ALL
        SELECT p.currency_code,0,0,0,sum(r.amount) FROM refund r JOIN payment p ON p.tenant_id=r.tenant_id AND p.id=r.payment_id
          WHERE r.deleted_at IS NULL AND p.deleted_at IS NULL AND p.provider_id=$1 GROUP BY p.currency_code
      ) SELECT currency_code,sum(orders)::integer AS orders,sum(canceled)::integer AS canceled_orders,
        sum(captured)::text AS captured_amount,sum(refunded)::text AS refunded_amount,
        (sum(captured)-sum(refunded))::text AS net_received FROM amounts GROUP BY currency_code ORDER BY currency_code`,
        [providerId]
      )
      const attention = (
        await client.query(`SELECT
        (SELECT count(*)::integer FROM saas_payment_operation WHERE state='failed') AS failed_operations,
        (SELECT count(*)::integer FROM saas_payment_operation WHERE state='pending') AS pending_operations,
        (SELECT count(*)::integer FROM saas_payment_webhook WHERE state='pending') AS pending_webhooks,
        (SELECT count(*)::integer FROM saas_payment_webhook WHERE result->>'review_required'='true') AS review_required`)
      ).rows[0]
      return {
        currency_totals: totals.rows,
        payment_attention: attention,
        definition:
          "All-time native order counts and Stripe test capture/refund amounts; major currency units; currencies never combined",
      }
    })
  }
  m2Runtime.jobs.handlers.set("m4.stripe.event", async (payload) => {
    const credential = await payments.credential(payload.credentialId),
      provider = payments.providerFor(credential)
    const result = isRefundEvent(payload.event.type)
      ? await reconcileRefund(payload.event, provider, credential)
      : await tradeLock(() =>
          payments.withOperation({ id: payload.webhookId }, () =>
            processEvent(payload.event, provider, credential)
          )
        )
    await tenantSQL(pool, (client) =>
      client.query(
        "UPDATE saas_payment_webhook SET state='done',result=$2 WHERE id=$1",
        [payload.webhookId, result]
      )
    )
    return result
  })
  // Raw vendor payload is mounted before JSON/session/auth middleware.
  function mountCallbacks(web, { asyncHandler }) {
    web.post(
      "/hooks/stripe/:endpoint",
      express.raw({ type: "application/json", limit: "256kb" }),
      asyncHandler(async (req, res) => {
        const endpoint = req.params.endpoint
        if (!/^pwh_[a-f0-9]{48}$/.test(endpoint) || !Buffer.isBuffer(req.body))
          missing()
        const entry = (
          await pool.query(
            "SELECT * FROM saas_control.payment_endpoint WHERE id=$1",
            [endpoint]
          )
        ).rows[0]
        const tenant = entry && (await getControl().getTenant(entry.tenant_id))
        const host =
          entry && (await getControl().resolveDomain(req.headers.host,{allowSuspended:operations}))
        if (!tenant || !["active",...(operations?["suspended"]:[])].includes(tenant.status) || host?.id !== tenant.id)
          missing()
        const verifier = createTenantVerifier({
          secret: contextSecret,
          issuer: "medusa-m4-callback",
          audience: "payment-callback",
          lookupMembership: (identity) =>
            getControl().authorizeMembership({...identity,allowSuspended:operations}),
        })
        const context = await verifier(
          jwt.sign({ tenant_id: tenant.id }, contextSecret, {
            algorithm: "HS256",
            subject: tenant.ownerActorId,
            issuer: "medusa-m4-callback",
            audience: "payment-callback",
            expiresIn: "5m",
          })
        )
        const result = await runWithTenant(context, async () => {
          const cred = await payments.credential(entry.credential_id),
            provider = payments.providerFor(cred)
          let event
          try {
            event = provider.constructWebhookEvent({
              rawData: req.body,
              headers: req.headers,
            })
          } catch {
            invalid("Stripe webhook signature verification failed")
          }
          if (
            event.livemode ||
            (event.account && event.account !== entry.account_id) ||
            !/^evt_[A-Za-z0-9]+$/.test(event.id)
          )
            invalid("Stripe event account or mode does not match this store")
          if (
            event.type.startsWith("payment_intent.") ||
            isRefundEvent(event.type)
          ) {
            const binding = await payments.binding({
              id: isRefundEvent(event.type)
                ? event.data.object.payment_intent
                : event.data.object.id,
            })
            if (
              binding.credential_id !== entry.credential_id ||
              (!isRefundEvent(event.type) &&
                event.data.object.metadata?.session_id !== binding.id)
            )
              invalid(
                "Stripe event does not belong to this merchant credential and session"
              )
          }
          const fingerprint = digest(req.body),
            id =
              "spw_" +
              digest(
                JSON.stringify([tenant.id, entry.credential_id, event.id])
              ).slice(0, 40)
          const row = await tenantSQL(
            pool,
            async (client) =>
              (
                await client.query(
                  `INSERT INTO saas_payment_webhook(id,credential_id,event_id,fingerprint)
          VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,credential_id,event_id) DO UPDATE SET id=saas_payment_webhook.id RETURNING *`,
                  [id, entry.credential_id, event.id, fingerprint]
                )
              ).rows[0]
          )
          if (row.fingerprint !== fingerprint)
            conflict("Stripe event ID was reused with another payload")
          if (row.state === "done") return { received: true, duplicate: true }
          const object = event.data?.object || {}
          const safeEvent = {
            id: event.id,
            type: event.type,
            data: {
              object: {
                id: object.id,
                amount: object.amount,
                currency: object.currency,
                payment_intent: object.payment_intent,
                metadata: { session_id: object.metadata?.session_id },
              },
            },
          }
          const job = await m2Runtime.jobs.enqueue(
            "m4.stripe.event",
            {
              event: safeEvent,
              credentialId: entry.credential_id,
              webhookId: id,
            },
            { idempotencyKey: `stripe-${entry.credential_id}-${event.id}` }
          )
          if (job.state !== "done")
            await m2Runtime.jobs.processNext({ jobId: job.id })
          const done = await m2Runtime.jobs.retrieve(job.id)
          if (done.state !== "done")
            throw new Error("Stripe event is persisted for retry")
          return { received: true, ...done.result }
        })
        res.json(result)
      })
    )
  }
  async function processEvent(event, provider, credential) {
    if (!event.type.startsWith("payment_intent.")) return { ignored: true }
    const object = event.data.object
    const bound = await payments.binding({ id: object.id })
    if (
      bound.credential_id !== credential.id ||
      object.metadata?.session_id !== bound.id
    )
      invalid(
        "Stripe event does not belong to this payment credential and session"
      )
    const session = (
      await nativeApp.modules.payment.listPaymentSessions({ id: bound.id })
    )[0]
    if (!session) return { ignored: true, reason: "session_closed" }
    if (session.provider_id !== providerId) missing()
    const payment = (
      await nativeApp.modules.payment.listPayments({
        payment_session_id: bound.id,
      })
    )[0]
    if (payment?.canceled_at) return { ignored: true, reason: "payment_closed" }
    let existingOrder=false
    if (payment) {
      const linked = await nativeApp.query.graph({
        entity: "order_payment_collection",
        fields: ["order.status","order.id"],
        filters: { payment_collection_id: payment.payment_collection_id },
      })
      if (linked.data[0]?.order?.status === "canceled")
        return { ignored: true, reason: "order_closed" }
      existingOrder=!!linked.data[0]?.order?.id
    }
    if(operations && !existingOrder && (await getControl().getTenant(currentTenant().tenantId))?.status==="suspended")
      return {ignored:true,review_required:true,reason:"paused_new_checkout"}
    // Current merchant API state wins over stale/out-of-order event JSON.
    let current
    try {
      current = await provider.getPaymentStatus({ data: { id: object.id } })
    } catch {
      throw new Error(
        "Stripe event status verification failed; event will retry"
      )
    }
    const expected =
      require("@medusajs/payment-stripe/dist/utils/get-smallest-unit").getSmallestUnit(
        bound.amount,
        bound.currency_code
      )
    if (
      current.data.livemode ||
      current.data.currency !== bound.currency_code ||
      current.data.amount !== expected ||
      current.data.metadata?.session_id !== bound.id
    )
      invalid("Stripe webhook amount, currency or session verification failed")
    if (object.amount !== expected || object.currency !== bound.currency_code)
      return { ignored: true, reason: "stale_event_amount" }
    if (!["authorized", "captured"].includes(current.status))
      return { ignored: true, status: current.status }
    if (
      current.status === "captured" &&
      current.data.amount_received !== expected
    )
      return { review_required: true, reason: "partial_external_capture" }
    const action = current.status === "captured" ? "successful" : "authorized"
    await nativeApp.modules.workflows.run("process-payment-workflow", {
      input: {
        action,
        data: { session_id: bound.id, amount: Number(bound.amount) },
      },
    })
    return { processed: true, status: current.status }
  }
  function isRefundEvent(type) {
    return [
      "refund.created",
      "refund.updated",
      "refund.failed",
      "charge.refund.updated",
    ].includes(type)
  }
  async function reconcileRefund(event, provider, credential) {
    const binding = await payments.binding({
      id: event.data.object.payment_intent,
    })
    if (binding.credential_id !== credential.id) missing()
    let refund
    try {
      refund = await provider.stripe_.refunds.retrieve(event.data.object.id)
    } catch {
      throw new Error("Stripe refund state verification failed")
    }
    if (
      refund.payment_intent !== binding.intent_id ||
      refund.currency !== binding.currency_code
    )
      invalid("Stripe refund does not match this merchant's bound payment")
    const operation = await tenantSQL(
      pool,
      async (client) =>
        (
          await client.query(
            `SELECT o.* FROM saas_payment_effect e
      JOIN saas_payment_operation o ON o.tenant_id=e.tenant_id AND o.id=e.operation_id
      WHERE e.binding_id=$1 AND e.remote_id=$2 AND o.kind='refund'`,
            [binding.id, refund.id]
          )
        ).rows[0]
    )
    if (!operation)
      return {
        review_required: true,
        reason: "external_refund_requires_reconciliation",
      }
    if (refund.status !== "succeeded")
      return { ignored: true, status: refund.status }
    const expected =
      require("@medusajs/payment-stripe/dist/utils/get-smallest-unit").getSmallestUnit(
        operation.payload.amount,
        binding.currency_code
      )
    if (refund.amount !== expected)
      invalid("Stripe refund amount does not match the pending operation")
    await runOperation(
      "refund",
      operation.resource_id,
      operation.idempotency_key,
      operation.payload,
      (op) =>
        action(
          "refund",
          { params: { id: operation.resource_id } },
          operation.payload,
          op,
          "refund-payment-workflow"
        )
    )
    return { processed: true, status: "refunded" }
  }
  return {
    routes,
    payments,
    runOperation,
    completeCart,
    mount,
    mountCallbacks,
    metrics,
    retryOperation:async op=>{
      const entry=actionRoutes.find(([kind])=>kind===op.kind)
      if(!entry) invalid("This operation is not available for recovery")
      if(["shipment","cancelFulfillment"].includes(op.kind)&&!op.payload._fulfillment_id)
        invalid("Legacy fulfillment recovery requires its original verified request")
      return runOperation(op.kind,op.resource_id,op.idempotency_key,op.payload,
        next=>action(op.kind,{params:{id:op.resource_id}},op.payload,next,entry[2]))
    },
    allowedFields: (path) =>
      path.startsWith("/admin/payments/") ? new Set(PAYMENT_FIELDS) : undefined,
    guardPaymentSession: async (req) => {
      if (
        req.body.provider_id !== providerId ||
        Object.keys(req.body.data || {}).length
      )
        invalid(
          "Use this store's Stripe provider without client-controlled payment data"
        )
      if (!(await payments.publicConfig()))
        invalid("Stripe is not configured for this store")
    },
    guardPaymentRegion: async (regionId) => {
      if (!(await enabledForRegion(regionId)))
        invalid("Stripe is disabled for this store region")
    },
  }
}
module.exports = { createM4Runtime, schemas, actionRoutes }
