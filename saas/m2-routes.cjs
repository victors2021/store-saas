"use strict"
const { currentTenant } = require("./tenant-context.cjs")
const native = (p) => require(`@medusajs/medusa/api/${p}`)
const routes = [
  [
    "GET",
    /^\/admin\/(orders|regions|sales-channels|stock-locations|inventory-items|shipping-options|tax-regions|promotions)$/,
  ],
  ["GET", /^\/admin\/orders\/order_[A-Za-z0-9]+$/],
  ["POST", /^\/store\/carts$/],
  ["GET", /^\/store\/carts\/cart_[A-Za-z0-9]+$/],
  ["POST", /^\/store\/carts\/cart_[A-Za-z0-9]+$/],
  [
    "POST",
    /^\/store\/carts\/cart_[A-Za-z0-9]+\/(line-items|promotions|shipping-methods|complete)$/,
  ],
  ["POST", /^\/store\/payment-collections$/],
  [
    "POST",
    /^\/store\/payment-collections\/pay_col_[A-Za-z0-9]+\/payment-sessions$/,
  ],
  ["GET", /^\/store\/orders\/order_[A-Za-z0-9]+$/],
]
const CART_FIELDS = [
  "id",
  "region_id",
  "customer_id",
  "sales_channel_id",
  "currency_code",
  "email",
  "completed_at",
  "total",
  "subtotal",
  "tax_total",
  "discount_total",
  "shipping_total",
  "items.id",
  "items.title",
  "items.variant_id",
  "items.quantity",
  "items.unit_price",
  "items.total",
  "items.tax_total",
  "shipping_address.id",
  "shipping_address.country_code",
  "shipping_methods.id",
  "shipping_methods.amount",
  "shipping_methods.shipping_option_id",
  "payment_collection.id",
  "payment_collection.amount",
  "payment_collection.payment_sessions.id",
  "payment_collection.payment_sessions.status",
]
const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "customer_id",
  "region_id",
  "sales_channel_id",
  "currency_code",
  "email",
  "total",
  "subtotal",
  "tax_total",
  "discount_total",
  "shipping_total",
  "items.id",
  "items.title",
  "items.variant_id",
  "items.quantity",
  "items.unit_price",
  "items.total",
  "shipping_address.country_code",
  "shipping_methods.id",
  "shipping_methods.amount",
  "payment_collections.id",
  "payment_collections.amount",
  "payment_collections.status",
]
const PAYMENT_FIELDS = [
  "id",
  "amount",
  "currency_code",
  "status",
  "payment_sessions.id",
  "payment_sessions.status",
  "payment_sessions.provider_id",
]
const ADMIN = {
  regions: {
    entity: "region",
    fields: [
      "id",
      "name",
      "currency_code",
      "automatic_taxes",
      "countries.iso_2",
    ],
  },
  "sales-channels": {
    entity: "sales_channel",
    fields: ["id", "name", "is_disabled"],
  },
  "stock-locations": {
    entity: "stock_location",
    fields: ["id", "name", "address.id", "address.country_code"],
  },
  "inventory-items": {
    entity: "inventory_item",
    fields: [
      "id",
      "title",
      "sku",
      "location_levels.id",
      "location_levels.location_id",
      "location_levels.stocked_quantity",
      "location_levels.reserved_quantity",
    ],
  },
  "shipping-options": {
    entity: "shipping_option",
    fields: [
      "id",
      "name",
      "price_type",
      "shipping_profile_id",
      "service_zone_id",
      "provider_id",
    ],
  },
  "tax-regions": {
    entity: "tax_region",
    fields: ["id", "country_code", "province_code", "provider_id"],
  },
  promotions: { entity: "promotion", fields: ["id", "code", "status", "type"] },
}
function allowedFields(path) {
  if (path.startsWith("/store/carts")) return new Set(CART_FIELDS)
  if (path.includes("/orders")) return new Set(ORDER_FIELDS)
  if (path.startsWith("/store/payment-collections"))
    return new Set(PAYMENT_FIELDS)
  const match = /^\/admin\/([^/]+)$/.exec(path)
  return match && ADMIN[match[1]] ? new Set(ADMIN[match[1]].fields) : undefined
}
function mountM2Routes(
  web,
  {
    nativeApp,
    jobs,
    asyncHandler,
    owner,
    validateAndTransformBody,
    validateAndTransformQuery,
    cartFields = CART_FIELDS,
    orderFields = ORDER_FIELDS,
  m4Runtime,
  }
) {
  const { authenticate } = require("@medusajs/framework/http")
  const { MedusaError } = require("@medusajs/framework/utils")
  const customer = authenticate("customer", ["bearer", "session"])
  const cv = native("store/carts/validators"),
    ov = native("store/orders/validators"),
    pv = native("store/payment-collections/validators")
  const query = (fields) => ({
    defaults: fields,
    allowed: fields,
    isList: false,
  })
  const notFound = () => {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, "Object is unavailable")
  }
  const invalid = (message) => {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
  }
  const cartOwned = async (id, actor) => {
    const cart = await nativeApp.modules.cart.retrieveCart(id)
    if (cart.customer_id !== actor) notFound()
    return cart
  }
  const cartGuard = asyncHandler(async (req, res, next) => {
    await cartOwned(req.params.id, req.auth_context.actor_id)
    next()
  })
  const inputGuard = asyncHandler(async (req, res, next) => {
    const data = req.body || {}
    if (
      data.additional_data ||
      data.customer_id ||
      data.unit_price ||
      data.amount ||
      data.provider_credentials
    )
      invalid("Only reviewed cart input is available")
    if (data.region_id)
      await nativeApp.modules.region.retrieveRegion(data.region_id)
    if (data.sales_channel_id)
      await nativeApp.modules.sales_channel.retrieveSalesChannel(
        data.sales_channel_id
      )
    for (const field of ["shipping_address", "billing_address"]) {
      if (typeof data[field] === "string" || data[field]?.id)
        invalid(
          "Store addresses must be new address data; address IDs are not accepted"
        )
    }
    for (const item of [
      ...(data.items || []),
      ...(data.variant_id ? [data] : []),
    ]) {
      const variant = await nativeApp.modules.product.retrieveProductVariant(
        item.variant_id
      )
      const product = await nativeApp.modules.product.retrieveProduct(
        variant.product_id
      )
      if (product.status !== "published") notFound()
      if (
        !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 99 ||
        item.unit_price !== undefined
      )
        invalid("Invalid item quantity or price input")
    }
    next()
  })
  const idempotent = async (req, res, kind, payload, respond) => {
    const idempotencyKey = req.headers["idempotency-key"]
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)
    )
      invalid("An idempotency-key header of 8–128 characters is required")
    const job = await jobs.enqueue(kind, payload, { idempotencyKey })
    if (job.state !== "done") await jobs.processNext({ jobId: job.id })
    const finished = await jobs.retrieve(job.id)
    if (finished.state !== "done")
      return res.status(409).json({
        code: "CHECKOUT_JOB_PENDING",
        job_id: job.id,
        state: finished.state,
      })
    await respond(finished.result)
  }
  jobs.handlers.set("cart.create", async (payload, { jobId }) => {
    if (payload.customerId !== currentTenant().actorId) notFound()
    const { result } = await nativeApp.modules.workflows.run("create-cart", {
      input: { ...payload.data, customer_id: payload.customerId },
      transactionId: jobId,
    })
    return { cart_id: result.id }
  })
  jobs.handlers.set("cart.complete", async (payload, { jobId, attempt }) => {
    const task = async () => {
      await cartOwned(payload.cartId, currentTenant().actorId)
      const { result } = await nativeApp.modules.workflows.run("complete-cart", {
        input: { id: payload.cartId },
        transactionId: m4Runtime ? `${jobId}-${attempt}` : jobId,
      })
      return { order_id: result.id }
    }
    return m4Runtime ? m4Runtime.completeCart(payload,task) : task()
  })
  const cartResponse = async (req, res, id) =>
    native("store/carts/helpers")
      .refetchCart(id, req.scope, req.queryConfig.fields)
      .then((cart) => res.json({ cart }))
  web.post(
    "/store/carts",
    customer,
    inputGuard,
    validateAndTransformBody(cv.StoreCreateCart),
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(async (req, res) =>
      idempotent(
        req,
        res,
        "cart.create",
        { data: req.validatedBody, customerId: req.auth_context.actor_id },
        (result) => cartResponse(req, res, result.cart_id)
      )
    )
  )
  web.get(
    "/store/carts/:id",
    customer,
    cartGuard,
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(native("store/carts/[id]/route").GET)
  )
  web.post(
    "/store/carts/:id",
    customer,
    cartGuard,
    inputGuard,
    validateAndTransformBody(cv.StoreUpdateCart),
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(native("store/carts/[id]/route").POST)
  )
  web.post(
    "/store/carts/:id/line-items",
    customer,
    cartGuard,
    inputGuard,
    validateAndTransformBody(cv.StoreAddCartLineItem),
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(native("store/carts/[id]/line-items/route").POST)
  )
  web.post(
    "/store/carts/:id/promotions",
    customer,
    cartGuard,
    validateAndTransformBody(cv.StoreAddCartPromotions),
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(native("store/carts/[id]/promotions/route").POST)
  )
  web.post(
    "/store/carts/:id/shipping-methods",
    customer,
    cartGuard,
    asyncHandler(async (req, res, next) => {
      for (const method of Array.isArray(req.body) ? req.body : [req.body])
        await nativeApp.modules.fulfillment.retrieveShippingOption(
          method.option_id
        )
      next()
    }),
    validateAndTransformBody(cv.StoreAddCartShippingMethods),
    validateAndTransformQuery(cv.StoreGetCartsCart, query(cartFields)),
    asyncHandler(native("store/carts/[id]/shipping-methods/route").POST)
  )
  web.post(
    "/store/carts/:id/complete",
    customer,
    cartGuard,
    validateAndTransformQuery(ov.StoreGetOrderParams, query(orderFields)),
    asyncHandler(async (req, res) =>
      idempotent(
        req,
        res,
        "cart.complete",
        { cartId: req.params.id },
        async (result) => {
          const { data } = await nativeApp.query.graph({
            entity: "order",
            fields: req.queryConfig.fields,
            filters: { id: result.order_id },
          })
          res.json({ type: "order", order: data[0] })
        }
      )
    )
  )
  web.post(
    "/store/payment-collections",
    customer,
    validateAndTransformBody(pv.StoreCreatePaymentCollection),
    validateAndTransformQuery(
      pv.StoreGetPaymentCollectionParams,
      query(PAYMENT_FIELDS)
    ),
    asyncHandler(async (req, res) => {
      await cartOwned(req.body.cart_id, req.auth_context.actor_id)
      return native("store/payment-collections/route").POST(req, res)
    })
  )
  web.post(
    "/store/payment-collections/:id/payment-sessions",
    customer,
    validateAndTransformBody(pv.StoreCreatePaymentSession),
    validateAndTransformQuery(
      pv.StoreGetPaymentCollectionParams,
      query(PAYMENT_FIELDS)
    ),
    asyncHandler(async (req, res) => {
      if (m4Runtime) await m4Runtime.guardPaymentSession(req)
      else if (
        req.body.provider_id !== "pp_system_default" ||
        Object.keys(req.body.data || {}).length
      )
        invalid("Only the credential-free sandbox payment provider is enabled")
      const { data } = await nativeApp.query.graph({
        entity: "cart_payment_collection",
        fields: ["cart_id"],
        filters: { payment_collection_id: req.params.id },
      })
      if (!data[0]) notFound()
      const cart = await cartOwned(data[0].cart_id, req.auth_context.actor_id)
      if (m4Runtime) await m4Runtime.guardPaymentRegion(cart.region_id)
      if (m4Runtime) req.queryConfig.fields = [...PAYMENT_FIELDS,"payment_sessions.data"]
      return native(
        "store/payment-collections/[id]/payment-sessions/route"
      ).POST(req, res)
    })
  )
  web.get(
    "/store/orders/:id",
    customer,
    validateAndTransformQuery(ov.StoreGetOrderParams, query(orderFields)),
    asyncHandler(async (req, res) => {
      const order = await nativeApp.modules.order.retrieveOrder(req.params.id)
      if (order.customer_id !== req.auth_context.actor_id) notFound()
      return native("store/orders/[id]/route").GET(req, res)
    })
  )
  for (const [slug, config] of Object.entries({
    ...ADMIN,
    orders: { entity: "order", fields: ORDER_FIELDS },
  }))
    web.get(
      `/admin/${slug}`,
      owner,
      asyncHandler(async (req, res) => {
        const offset = Number(req.query.offset || 0),
          limit = Number(req.query.limit || 50)
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          invalid("Invalid pagination")
        const { data, metadata } = await nativeApp.query.graph({
          entity: config.entity,
          fields: req.query.fields?.split(",") || config.fields,
          pagination: { skip: offset, take: limit },
        })
        res.json({
          [slug.replaceAll("-", "_")]: data,
          count: metadata?.count ?? data.length,
          offset,
          limit,
        })
      })
    )
  web.get(
    "/admin/orders/:id",
    owner,
    asyncHandler(async (req, res) => {
      await nativeApp.modules.order.retrieveOrder(req.params.id)
      const { data } = await nativeApp.query.graph({
        entity: "order",
        fields: req.query.fields?.split(",") || ORDER_FIELDS,
        filters: { id: req.params.id },
      })
      res.json({ order: data[0] })
    })
  )
}
module.exports = {
  mountM2Routes,
  routes,
  allowedFields,
  CART_FIELDS,
  ORDER_FIELDS,
  PAYMENT_FIELDS,
}
