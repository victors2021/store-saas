"use strict"

const { MedusaError } = require("@medusajs/framework/utils")
const { currentTenant } = require("./tenant-context.cjs")
const native = (path) => require(`@medusajs/medusa/api/${path}`)
const unavailable = () => { throw new MedusaError(MedusaError.Types.NOT_FOUND, "Object is unavailable") }
const invalid = (message) => { throw new MedusaError(MedusaError.Types.INVALID_DATA, message) }
const fields = (values) => new Set(values.flatMap((value) => [value, value.replace(/^\*/, ""), value.replace(/\.\*$/, "")]))
const routePattern = (path) => new RegExp("^" + path.split("/").map((part) =>
  part.startsWith(":") ? "[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+" : part
).join("/") + "$")

const PRODUCT_EXTRA = ["variants.id", "*categories", "*shipping_profile", "shipping_profile_id", "*variants.inventory_items",
  "*variants.inventory_items.inventory", "*variants.inventory_items.inventory.location_levels", "variants.inventory_items.required_quantity",
  "*variants.options", "variants.inventory_quantity"]
const ORDER_EXTRA = ["email", "currency_code", "customer_id", "canceled_at", "payment_status", "fulfillment_status", "*customer", "*sales_channel", "*promotions", "*order_change", "*payment_collections", "*items", "shipping_address.country_code",
  "*items.variant.options", "items.variant.manage_inventory", "*items.variant.inventory_items.inventory",
  "items.variant.inventory_items.required_quantity", "*fulfillments", "*fulfillments.items", "*fulfillments.labels",
  "fulfillments.shipping_option.service_zone.fulfillment_set.type", "*payment_collections.payment_sessions",
  "*payment_collections.payments.refunds.refund_reason", "region.automatic_taxes", "order_change", "refundable_total",
  "item_discount_total", "discount_subtotal", "shipping_discount_total", "discount_total", "discount_tax_total"]
const CART_FIELDS = ["id", "region_id", "customer_id", "sales_channel_id", "currency_code", "email", "completed_at",
  "created_at", "updated_at", "total", "subtotal", "tax_total", "discount_total", "shipping_total", "shipping_subtotal",
  "discount_tax_total", "original_total", "original_tax_total", "item_total", "item_subtotal", "item_tax_total",
  "items.id", "items.title", "items.thumbnail", "items.variant_id", "items.quantity", "items.unit_price",
  "items.total", "items.subtotal", "items.tax_total", "items.discount_total", "items.product_title", "items.variant_title",
  "items.original_total", "items.original_subtotal", "items.original_tax_total",
  "items.variant.id", "items.variant.title", "items.variant.manage_inventory", "items.variant.allow_backorder",
  "items.variant.product.id", "items.variant.product.handle", "items.variant.product.title", "items.variant.options.id",
  "items.variant.options.value", "items.variant.options.option_id", "items.variant.options.option.id", "items.variant.options.option.title",
  "region.id", "region.name", "region.currency_code", "region.automatic_taxes", "region.countries.iso_2", "region.countries.display_name",
  "shipping_address.id", "shipping_address.first_name", "shipping_address.last_name", "shipping_address.address_1",
  "shipping_address.address_2", "shipping_address.city", "shipping_address.postal_code", "shipping_address.province",
  "shipping_address.company", "shipping_address.phone", "shipping_address.country_code",
  "billing_address.id", "billing_address.first_name", "billing_address.last_name", "billing_address.address_1",
  "billing_address.address_2", "billing_address.city", "billing_address.postal_code", "billing_address.province",
  "billing_address.company", "billing_address.phone", "billing_address.country_code",
  "shipping_methods.id", "shipping_methods.name", "shipping_methods.amount", "shipping_methods.shipping_option_id",
  "payment_collection.id", "payment_collection.amount", "payment_collection.currency_code", "payment_collection.status",
  "payment_collection.payment_sessions.id", "payment_collection.payment_sessions.status", "payment_collection.payment_sessions.provider_id",
  "promotions.id", "promotions.code", "promotions.is_automatic"]
const STORE_ORDER_FIELDS = [...CART_FIELDS.filter((field) => !field.startsWith("payment_collection.") &&
  !["completed_at", "promotions.is_automatic"].includes(field)), "display_id", "status",
  "payment_status", "fulfillment_status", "payment_collections.id", "payment_collections.amount", "payment_collections.status",
  "payment_collections.payments.id", "payment_collections.payments.provider_id", "payment_collections.payments.amount", "payment_collections.payments.created_at"]
const STORE_PRODUCT_FIELDS = ["id", "title", "handle", "status", "subtitle", "description", "thumbnail", "created_at", "updated_at",
  "images.id", "images.url", "options.id", "options.title", "options.values.id", "options.values.value",
  "variants.id", "variants.title", "variants.sku", "variants.manage_inventory", "variants.allow_backorder",
  "variants.inventory_quantity", "variants.options.id", "variants.options.value", "variants.options.option_id",
  "variants.images.id", "variants.images.url", "variants.calculated_price.id", "variants.calculated_price.currency_code",
  "variants.calculated_price.calculated_amount", "variants.calculated_price.original_amount",
  "variants.calculated_price.calculated_amount_with_tax", "variants.calculated_price.original_amount_with_tax",
  "variants.calculated_price.calculated_amount_without_tax", "variants.calculated_price.original_amount_without_tax",
  "variants.calculated_price.is_calculated_price_tax_inclusive", "variants.calculated_price.is_original_price_tax_inclusive"]
const CUSTOMER_FIELDS = ["id", "email", "first_name", "last_name", "phone", "has_account", "created_at", "updated_at",
  "addresses.id", "addresses.first_name", "addresses.last_name", "addresses.company", "addresses.address_1", "addresses.address_2",
  "addresses.city", "addresses.postal_code", "addresses.province", "addresses.country_code", "addresses.phone",
  "addresses.address_name", "addresses.is_default_shipping", "addresses.is_default_billing"]

// Explicit operation/schema/config names, pinned to the MIT 2.18.0 APIs.
// No directory-wide native router, callbacks, exports or workflow endpoints.
const CRUD = [
  ["products", "AdminGetProductsParams", "AdminGetProductParams", "AdminCreateProduct", "AdminUpdateProduct", "listProductQueryConfig", "retrieveProductQueryConfig", "product", "retrieveProduct"],
  ["stores", "AdminGetStoresParams", "AdminGetStoreParams", null, "AdminUpdateStore", "listTransformQueryConfig", "retrieveTransformQueryConfig", "store", "retrieveStore"],
  ["regions", "AdminGetRegionsParams", "AdminGetRegionParams", "AdminCreateRegion", "AdminUpdateRegion", "listTransformQueryConfig", "retrieveTransformQueryConfig", "region", "retrieveRegion"],
  ["sales-channels", "AdminGetSalesChannelsParams", "AdminGetSalesChannelParams", "AdminCreateSalesChannel", "AdminUpdateSalesChannel", "listTransformQueryConfig", "retrieveTransformQueryConfig", "sales_channel", "retrieveSalesChannel"],
  ["stock-locations", "AdminGetStockLocationsParams", "AdminGetStockLocationParams", "AdminCreateStockLocation", "AdminUpdateStockLocation", "listTransformQueryConfig", "retrieveTransformQueryConfig", "stock_location", "retrieveStockLocation"],
  ["inventory-items", "AdminGetInventoryItemsParams", "AdminGetInventoryItemParams", "AdminCreateInventoryItem", "AdminUpdateInventoryItem", "listTransformQueryConfig", "retrieveTransformQueryConfig", "inventory", "retrieveInventoryItem"],
  ["shipping-profiles", "AdminGetShippingProfilesParams", "AdminGetShippingProfileParams", "AdminCreateShippingProfile", "AdminUpdateShippingProfile", "listTransformQueryConfig", "retrieveTransformQueryConfig", "fulfillment", "retrieveShippingProfile"],
  ["shipping-options", "AdminGetShippingOptionsParams", "AdminGetShippingOptionParams", "AdminCreateShippingOption", "AdminUpdateShippingOption", "listTransformQueryConfig", "retrieveTransformQueryConfig", "fulfillment", "retrieveShippingOption"],
  ["shipping-option-types", "AdminGetShippingOptionTypesParams", "AdminGetShippingOptionTypeParams", "AdminCreateShippingOptionType", "AdminUpdateShippingOptionType", "listShippingOptionTypesTransformQueryConfig", "retrieveShippingOptionTypeTransformQueryConfig", "fulfillment", "retrieveShippingOptionType"],
  ["collections", "AdminGetCollectionsParams", "AdminGetCollectionParams", "AdminCreateCollection", "AdminUpdateCollection", "listTransformQueryConfig", "retrieveTransformQueryConfig", "product", "retrieveProductCollection"],
  ["product-categories", "AdminProductCategoriesParams", "AdminProductCategoryParams", "AdminCreateProductCategory", "AdminUpdateProductCategory", "listProductCategoryConfig", "retrieveProductCategoryConfig", "product", "retrieveProductCategory"],
  ["product-types", "AdminGetProductTypesParams", "AdminGetProductTypeParams", "AdminCreateProductType", "AdminUpdateProductType", "listProductTypesTransformQueryConfig", "retrieveProductTypeTransformQueryConfig", "product", "retrieveProductType"],
  ["product-tags", "AdminGetProductTagsParams", "AdminGetProductTagParams", "AdminCreateProductTag", "AdminUpdateProductTag", "listProductTagsTransformQueryConfig", "retrieveProductTagTransformQueryConfig", "product", "retrieveProductTag"],
  ["product-options", "AdminGetProductOptionsParams", "AdminGetProductOptionParams", "AdminCreateProductOption", "AdminUpdateProductOption", "listProductOptionsTransformQueryConfig", "retrieveProductOptionsTransformQueryConfig", "product", "retrieveProductOption"],
  ["price-preferences", "AdminGetPricePreferencesParams", "AdminGetPricePreferenceParams", "AdminCreatePricePreference", "AdminUpdatePricePreference", "listPricePreferenceQueryConfig", "retrivePricePreferenceQueryConfig", "pricing", "retrievePricePreference"],
  ["tax-regions", "AdminGetTaxRegionsParams", "AdminGetTaxRegionParams", "AdminCreateTaxRegion", "AdminUpdateTaxRegion", "listTransformQueryConfig", "retrieveTransformQueryConfig", "tax", "retrieveTaxRegion"],
  ["customers", "AdminCustomersParams", "AdminCustomerParams", null, null, "listTransformQueryConfig", "retrieveTransformQueryConfig", "customer", "retrieveCustomer"],
  ["orders", "AdminGetOrdersParams", "AdminGetOrdersOrderParams", null, null, "listTransformQueryConfig", "retrieveTransformQueryConfig", "order", "retrieveOrder"],
]

function createM3Runtime({ nativeApp, m2Runtime }) {
  const entries = []
  const entry = (method, path, { slug, validator, config, body, retrieve, handler, extra = [] } = {}) => {
    const qc = config ? native(`${slug}/query-config`)[config] : { defaults: [], isList: false }
    if (!qc) throw new Error(`Missing reviewed query config: ${slug}/${config}`)
    const defaults = (qc.defaults || []).filter((field) => field !== "*supported_currencies.currency" &&
      !(slug?.startsWith("store/") && ["metadata", "deleted_at"].includes(field)))
    if (slug === "store/product-categories") {
      const index = defaults.findIndex((value) => value === "*parent_category")
      if (index >= 0) defaults.splice(index, 1)
      const childIndex = defaults.findIndex((value) => value === "*category_children")
      if (childIndex >= 0) defaults.splice(childIndex, 1)
      defaults.push("parent_category.id", "parent_category.name", "parent_category.handle", "parent_category.is_internal", "parent_category.is_active",
        "category_children.id", "category_children.name", "category_children.handle", "category_children.is_internal", "category_children.is_active")
    }
    const permitted = fields([...defaults, ...(qc.allowed || []), ...extra])
    entries.push({ method, path, pattern: routePattern(path), slug, validator, body, retrieve, handler,
      queryConfig: { ...qc, defaults, allowed: [...permitted] }, permitted })
  }
  for (const [slug, list, detail, create, update, listConfig, detailConfig, module, retrieve] of CRUD) {
    const extra = slug === "products" ? PRODUCT_EXTRA : slug === "orders" ? ORDER_EXTRA :
      slug === "stores" ? ["*default_sales_channel", "default_sales_channel"] :
      slug === "stock-locations" ? ["*sales_channels", "*fulfillment_sets", "*fulfillment_sets.service_zones", "*fulfillment_providers"] :
      slug === "inventory-items" ? ["*variants", "*variants.product", "*variants.options", "stock_locations.id", "stock_locations.name"] :
      slug === "customers" ? ["*addresses", "*groups"] : slug === "product-options" ? ["values.id", "values.value", "values.rank"] : []
    const base = { slug: `admin/${slug}`, extra }
    entry("GET", `/admin/${slug}`, { ...base, validator: list, config: listConfig })
    entry("GET", `/admin/${slug}/:id`, { ...base, validator: detail, config: detailConfig, retrieve: [module, retrieve, "id"] })
    if (create) entry("POST", `/admin/${slug}`, { ...base, validator: detail, config: detailConfig, body: create })
    if (update) entry("POST", `/admin/${slug}/:id`, { ...base, validator: detail, config: detailConfig, body: update, retrieve: [module, retrieve, "id"] })
    if (create && !["stock-locations", "tax-regions"].includes(slug))
      entry("DELETE", `/admin/${slug}/:id`, { ...base, validator: detail, config: detailConfig, retrieve: [module, retrieve, "id"] })
  }
  const pv = "admin/products"
  entry("GET", "/admin/products/:id/variants", { slug: pv, validator: "AdminGetProductVariantsParams",
    config: "listVariantConfig", retrieve: ["product", "retrieveProduct", "id"], extra: ["*inventory_items", "*inventory_items.inventory", "*inventory_items.inventory.location_levels", "inventory_quantity"] })
  entry("POST", "/admin/products/:id/variants", { slug: pv, validator: "AdminGetProductParams", config: "retrieveProductQueryConfig",
    body: "AdminCreateProductVariant", retrieve: ["product", "retrieveProduct", "id"], extra: PRODUCT_EXTRA })
  for (const method of ["GET", "POST", "DELETE"]) entry(method, "/admin/products/:id/variants/:variant_id", {
    slug: pv, validator: method === "GET" ? "AdminGetProductVariantParams" : "AdminGetProductParams",
    config: method === "GET" ? "retrieveVariantConfig" : "retrieveProductQueryConfig",
    body: method === "POST" ? "AdminUpdateProductVariant" : null, retrieve: ["product", "retrieveProduct", "id"], extra: PRODUCT_EXTRA })
  entry("GET", "/admin/inventory-items/:id/location-levels", { slug: "admin/inventory-items", validator: "AdminGetInventoryLocationLevelsParams",
    config: "listLocationLevelsTransformQueryConfig", retrieve: ["inventory", "retrieveInventoryItem", "id"], extra: ["stock_locations.id", "stock_locations.name"] })
  entry("POST", "/admin/inventory-items/:id/location-levels", { slug: "admin/inventory-items", validator: "AdminGetInventoryItemParams",
    config: "retrieveTransformQueryConfig", body: "AdminCreateInventoryLocationLevel", retrieve: ["inventory", "retrieveInventoryItem", "id"] })
  entry("POST", "/admin/inventory-items/:id/location-levels/:location_id", { slug: "admin/inventory-items", validator: "AdminGetInventoryItemParams",
    config: "retrieveTransformQueryConfig", body: "AdminUpdateInventoryLocationLevel", retrieve: ["inventory", "retrieveInventoryItem", "id"] })
  entry("POST", "/admin/inventory-items/location-levels/batch", { slug: "admin/inventory-items",
    body: "AdminBatchInventoryItemLevels" })
  entry("POST", "/admin/inventory-items/:id/location-levels/batch", { slug: "admin/inventory-items",
    body: "AdminBatchInventoryItemLocationsLevel", retrieve: ["inventory", "retrieveInventoryItem", "id"] })
  entry("POST", "/admin/products/:id/options/batch", { slug: pv, body: "AdminLinkProductOptions", validator: "AdminGetProductParams",
    config: "retrieveProductQueryConfig", retrieve: ["product", "retrieveProduct", "id"], extra: PRODUCT_EXTRA })
  entry("POST", "/admin/products/:id/variants/inventory-items/batch", { slug: pv, body: "$variantInventoryBatch",
    retrieve: ["product", "retrieveProduct", "id"] })
  entry("POST", "/admin/stock-locations/:id/fulfillment-sets", { slug: "admin/stock-locations", validator: "AdminGetStockLocationParams",
    config: "retrieveTransformQueryConfig", body: "AdminCreateStockLocationFulfillmentSet", retrieve: ["stock_location", "retrieveStockLocation", "id"],
    extra: ["*fulfillment_sets", "*fulfillment_sets.service_zones"] })
  for (const suffix of ["sales-channels", "fulfillment-providers"])
    entry("POST", `/admin/stock-locations/:id/${suffix}`, { slug: "admin/stock-locations", validator: "AdminGetStockLocationParams",
      config: "retrieveTransformQueryConfig", body: "$link", retrieve: ["stock_location", "retrieveStockLocation", "id"],
      extra: ["*sales_channels", "*fulfillment_providers"] })
  entry("POST", "/admin/fulfillment-sets/:id/service-zones", { slug: "admin/fulfillment-sets", validator: "AdminFulfillmentSetParams",
    config: "retrieveTransformQueryConfig", body: "AdminCreateFulfillmentSetServiceZonesSchema", retrieve: ["fulfillment", "retrieveFulfillmentSet", "id"] })
  entry("GET", "/admin/product-variants", { slug: "admin/product-variants", validator: "AdminGetProductVariantsParams",
    config: "listProductVariantQueryConfig", extra: ["*inventory_items", "*inventory_items.inventory", "*inventory_items.inventory.location_levels", "inventory_quantity"] })
  for (const [slug, list, detail, lc, dc, extra] of [
    ["regions", "StoreGetRegionsParams", "StoreGetRegionParams", "listTransformQueryConfig", "retrieveTransformQueryConfig", []],
    ["collections", "StoreGetCollectionsParams", "StoreGetCollectionParams", "listTransformQueryConfig", "retrieveTransformQueryConfig", []],
    ["product-categories", "StoreProductCategoriesParams", "StoreProductCategoryParams", "listProductCategoryConfig", "retrieveProductCategoryConfig", []],
  ]) {
    entry("GET", `/store/${slug}`, { slug: `store/${slug}`, validator: list, config: lc, extra })
    entry("GET", `/store/${slug}/:id`, { slug: `store/${slug}`, validator: detail, config: dc, extra })
  }
  entry("GET", "/store/orders", { slug: "store/orders", validator: "StoreGetOrdersParams", config: "listTransformQueryConfig", extra: STORE_ORDER_FIELDS })
  entry("GET", "/store/shipping-options", { slug: "store/shipping-options", validator: "StoreGetShippingOptions", config: "listTransformQueryConfig" })
  entry("GET", "/store/payment-providers", { slug: "store/payment-providers", validator: "StoreGetPaymentProvidersParams", config: "listTransformPaymentProvidersQueryConfig" })
  for (const method of ["GET", "POST"]) entry(method, "/store/customers/me", { slug: "store/customers", validator: "StoreGetCustomerParams",
    config: "retrieveTransformQueryConfig", body: method === "POST" ? "StoreUpdateCustomer" : null, extra: CUSTOMER_FIELDS })
  entry("GET", "/store/customers/me/addresses", { slug: "store/customers", validator: "StoreGetCustomerAddressesParams", config: "listAddressesTransformQueryConfig" })
  entry("POST", "/store/customers/me/addresses", { slug: "store/customers", validator: "StoreGetCustomerParams",
    config: "retrieveTransformQueryConfig", body: "StoreCreateCustomerAddress", extra: CUSTOMER_FIELDS })
  for (const method of ["GET", "POST", "DELETE"]) entry(method, "/store/customers/me/addresses/:address_id", { slug: "store/customers",
    validator: method === "GET" ? "StoreGetCustomerAddressParams" : "StoreGetCustomerParams",
    config: method === "GET" ? "retrieveAddressTransformQueryConfig" : "retrieveTransformQueryConfig",
    body: method === "POST" ? "StoreUpdateCustomerAddress" : null, extra: method === "GET" ? [] : CUSTOMER_FIELDS })
  for (const method of ["POST", "DELETE"]) entry(method, "/store/carts/:id/line-items/:line_id", {
    slug: "store/carts", validator: "StoreGetCartsCart", body: method === "POST" ? "StoreUpdateCartLineItem" : null,
    config: "retrieveTransformQueryConfig", extra: CART_FIELDS })
  const custom = [
    ["GET", "/admin/feature-flags"], ["GET", "/admin/currencies"], ["GET", "/admin/payments/payment-providers"],
    ["GET", "/admin/fulfillment-providers"], ["GET", "/admin/tax-providers"],
    ["GET", "/admin/fulfillment-providers/:id/options"],
    ["GET", "/admin/saas/settings"], ["POST", "/admin/saas/settings"],
    ["POST", "/admin/uploads"], ["DELETE", "/admin/uploads/:id"],
    ["GET", "/store/settings"], ["GET", "/store/media/:id"],
  ].map(([method, path]) => [method, routePattern(path)])
  const routes = [...entries.map((e) => [e.method, e.pattern]), ...custom]
  function allowedFields(path, method) {
    if (path === "/admin/currencies") return fields(["code", "name", "symbol", "symbol_native", "decimal_digits", "rounding"])
    if (["/admin/fulfillment-providers", "/admin/tax-providers", "/admin/payments/payment-providers", "/store/payment-providers"].includes(path))
      return fields(["id", "is_enabled"])
    if (path.startsWith("/store/products")) return fields(STORE_PRODUCT_FIELDS)
    if (path === "/store/customers/me") return fields(CUSTOMER_FIELDS)
    if (path.startsWith("/store/carts")) return fields(CART_FIELDS)
    if (path.startsWith("/store/orders")) return fields(STORE_ORDER_FIELDS)
    const selected = entries.find((e) => e.method === method && e.pattern.test(path))
    return selected?.permitted
  }
  async function initializeTenant(tenant) {
    const { region, store, fulfillment, stock_location: location } = nativeApp.modules
    const regions = await region.listRegions({ name: "Default" })
    const stores = await store.listStores({})
    if (!stores.length || !regions.length) throw new Error("M2 native initialization must finish first")
    const profiles = await fulfillment.listShippingProfiles({ type: "default" })
    const profile = profiles[0] || await fulfillment.createShippingProfiles({ name: "Default", type: "default" })
    const locations = await location.listStockLocations({})
    if (locations.length > 1) invalid("Review an existing multi-warehouse tenant before upgrading the single-warehouse MVP")
    const warehouse = locations[0] || await location.createStockLocations({ name: "Default", address: { address_1: "", country_code: "us" } })
    // The fixed theme starts with the native system test provider and one manual
    // fulfillment provider. Merchant shipping zones are configured using the
    // native location/settings APIs. Independent merchant accounts are M4.
    const links = await nativeApp.query.graph({ entity: "region_payment_provider", fields: ["region_id", "payment_provider_id"],
      filters: { region_id: regions[0].id, payment_provider_id: "pp_system_default" } })
    if (!links.data.length) await nativeApp.link.create({ region: { region_id: regions[0].id }, payment: { payment_provider_id: "pp_system_default" } })
    await store.updateStores(stores[0].id, { default_region_id: regions[0].id,
      default_location_id: warehouse.id, metadata: { ...(stores[0].metadata || {}), saas_theme: {
        primary_color: "#111827", logo: null, seo_description: "", ...(stores[0].metadata?.saas_theme || {}) } } })
    return { profile, warehouse }
  }
  function mount(web, { asyncHandler, owner, catGuard, validateAndTransformBody, validateAndTransformQuery }) {
    for (const e of entries) {
      // Express also matches literal "batch" with a parameter route. Select the
      // reviewed ID pattern before parsing its body so static routes can run.
      const middleware = [(req, res, next) => e.pattern.test(req.path) ? next() : next("route")]
      if (e.path.startsWith("/admin/")) middleware.push(owner)
      if (e.body) middleware.push(validateAndTransformBody(e.body === "$link"
        ? require("@medusajs/medusa/api/utils/validators").createLinkBody()
        : e.body === "$variantInventoryBatch" ? require("@medusajs/medusa/api/utils/validators").createBatchBody(
          native(`${pv}/validators`).AdminBatchCreateVariantInventoryItem, native(`${pv}/validators`).AdminBatchUpdateVariantInventoryItem,
          native(`${pv}/validators`).AdminBatchDeleteVariantInventoryItem)
        : native(`${e.slug}/validators`)[e.body]))
      middleware.push(asyncHandler(async (req, res, next) => {
        const limitCap = e.path.startsWith("/admin/") ? 1000 : 100
        if (req.query.limit !== undefined && (!/^\d+$/.test(String(req.query.limit)) || Number(req.query.limit) > limitCap))
          invalid(`Pagination limit must be between 0 and ${limitCap}`)
        if (req.body?.additional_data !== undefined) invalid("Unreviewed workflow hook data is unavailable")
        if (e.retrieve) await nativeApp.modules[e.retrieve[0]][e.retrieve[1]](req.params[e.retrieve[2]])
        if (e.path.endsWith("/location-levels/batch")) {
          const body = req.body || {}, inventory = nativeApp.modules.inventory
          if ([...(body.create || []), ...(body.update || []), ...(body.delete || [])].length > 1000) invalid("Stock batch is too large")
          for (const row of [...(body.create || []), ...(body.update || [])]) {
            const itemId = req.params.id || row.inventory_item_id
            await inventory.retrieveInventoryItem(itemId)
            await nativeApp.modules.stock_location.retrieveStockLocation(row.location_id)
            const existing = await inventory.listInventoryLevels({ inventory_item_id: itemId, location_id: row.location_id })
            if (row.stocked_quantity !== undefined && (!Number.isFinite(row.stocked_quantity) || row.stocked_quantity < (existing[0]?.reserved_quantity || 0)))
              invalid("Stocked quantity cannot be below reserved stock")
          }
          for (const id of body.delete || []) {
            const rows = await inventory.listInventoryLevels({ id })
            if (!rows[0] || (req.params.id && rows[0].inventory_item_id !== req.params.id)) unavailable()
            if (rows[0].reserved_quantity > 0) invalid("Reserved stock cannot be deleted")
          }
        }
        if (e.body === "$variantInventoryBatch") for (const row of [...(req.body?.create || []), ...(req.body?.update || []), ...(req.body?.delete || [])]) {
          const variant = await nativeApp.modules.product.retrieveProductVariant(row.variant_id)
          if (variant.product_id !== req.params.id) unavailable()
          await nativeApp.modules.inventory.retrieveInventoryItem(row.inventory_item_id)
          if (row.required_quantity !== undefined && (!Number.isSafeInteger(row.required_quantity) || row.required_quantity < 1)) invalid("Invalid inventory requirement")
        }
        if (e.path.endsWith("/options/batch")) {
          for (const row of [...(req.body?.add || []), ...(req.body?.remove || []), ...(req.body?.update || [])]) {
            const id = typeof row === "string" ? row : row.id || row.product_option_id
            if (id) {
              await nativeApp.modules.product.retrieveProductOption(id)
              for (const valueId of [...(row.value_ids || []), ...(row.remove || []), ...(row.add || []).filter((value) => typeof value === "string")]) {
                const value = await nativeApp.modules.product.retrieveProductOptionValue(valueId)
                if (value.option_id !== id) unavailable()
              }
            }
          }
        }
        if (e.path.includes("/variants") && e.method === "POST" && e.body !== "$variantInventoryBatch") await m2Runtime.guardProduct({ variants: [req.body] })
        if (req.params.variant_id) {
          const variant = await nativeApp.modules.product.retrieveProductVariant(req.params.variant_id)
          if (variant.product_id !== req.params.id) unavailable()
        }
        if (req.params.location_id) await nativeApp.modules.stock_location.retrieveStockLocation(req.params.location_id)
        if (req.body?.location_id) await nativeApp.modules.stock_location.retrieveStockLocation(req.body.location_id)
        if (e.body === "$link") for (const id of [...(req.body?.add || []), ...(req.body?.remove || [])]) {
          if (e.path.endsWith("/sales-channels")) await nativeApp.modules.sales_channel.retrieveSalesChannel(id)
          else if (id !== "manual_manual") invalid("Only the native manual fulfillment provider is available")
        }
        if (e.path.startsWith("/admin/stores")) {
          for (const [field, module, retrieve] of [["default_region_id", "region", "retrieveRegion"],
            ["default_location_id", "stock_location", "retrieveStockLocation"], ["default_sales_channel_id", "sales_channel", "retrieveSalesChannel"]])
            if (req.body?.[field]) await nativeApp.modules[module][retrieve](req.body[field])
        }
        if (e.path.startsWith("/store/orders")) requireCustomer(req)
        if (e.path.startsWith("/store/customers/me")) {
          requireCustomer(req)
          if (req.body?.email) {
            const customer = await nativeApp.modules.customer.retrieveCustomer(req.auth_context.actor_id)
            if (req.body.email.toLowerCase() !== customer.email.toLowerCase()) invalid("Authentication email changes require a separate verified flow")
          }
          if (req.params.address_id) {
            const address = await nativeApp.modules.customer.retrieveCustomerAddress(req.params.address_id)
            if (address.customer_id !== req.auth_context.actor_id) unavailable()
          }
        }
        if (e.path === "/store/shipping-options" || e.path.startsWith("/store/carts")) {
          requireCustomer(req)
          const cart = await nativeApp.modules.cart.retrieveCart(req.params.id || req.query.cart_id)
          if (cart.customer_id !== req.auth_context.actor_id) unavailable()
          if (req.params.line_id) {
            const item = await nativeApp.modules.cart.retrieveLineItem(req.params.line_id)
            if (item.cart_id !== cart.id) unavailable()
          }
          if (req.body?.quantity !== undefined && (!Number.isSafeInteger(req.body.quantity) || req.body.quantity < 1 || req.body.quantity > 99))
            invalid("Invalid item quantity")
        }
        if (e.path === "/store/payment-providers") await nativeApp.modules.region.retrieveRegion(req.query.region_id)
        next()
      }))
      if (e.path.startsWith("/admin/products") && e.method === "POST" && !e.path.includes("/variants")) middleware.push(catGuard)
      if (e.validator) {
        const source = e.validator === "AdminGetProductVariantsParams" ? "admin/product-variants" : e.slug
        middleware.push(validateAndTransformQuery(native(`${source}/validators`)[e.validator], e.queryConfig))
      }
      middleware.push((req, res, next) => {
        if (e.path === "/store/customers/me" || (e.path.includes("/addresses") && e.method !== "GET"))
          req.queryConfig.fields = CUSTOMER_FIELDS
        if (e.path.startsWith("/store/carts")) req.queryConfig.fields = CART_FIELDS
        if (e.path === "/store/orders") {
          req.filterableFields.customer_id = req.auth_context.actor_id
          req.queryConfig.fields = STORE_ORDER_FIELDS
        }
        if (e.path.startsWith("/store/product-categories")) {
          Object.assign(req.filterableFields, { is_active: true, is_internal: false })
          req.queryConfig.fields = e.queryConfig.defaults
          const json = res.json.bind(res)
          res.json = (data) => {
            const clean = (category) => {
              const visible = (row) => row && row.is_active && !row.is_internal
              const dto = (row) => visible(row) ? { id: row.id, name: row.name, handle: row.handle } : null
              const parent = dto(category.parent_category)
              return { ...category, parent_category: parent, parent_category_id: parent?.id || null,
                category_children: (category.category_children || []).map(dto).filter(Boolean) }
            }
            if (data.product_categories) data.product_categories = data.product_categories.map(clean)
            if (data.product_category) data.product_category = clean(data.product_category)
            return json(data)
          }
        }
        next()
      })
      const route = e.path.replace(/:([a-z_]+)/g, "[$1]")
      const handler = native(`${route.slice(1)}/route`)[e.method]
      if (typeof handler !== "function") throw new Error(`Missing reviewed native handler: ${e.method} ${e.path}`)
      middleware.push(asyncHandler(async (req, res) => {
        if (e.path === "/admin/stock-locations" && e.method === "POST")
          return m2Runtime.resources.locking.execute("m3-single-warehouse", async () => {
            if ((await nativeApp.modules.stock_location.listStockLocations({})).length)
              invalid("The MVP supports one stock location per store")
            return handler(req, res)
          })
        return handler(req, res)
      }))
      web[e.method.toLowerCase()](e.path, ...middleware)
    }
    require("./m3-custom-routes.cjs").mountCustomRoutes(web, { nativeApp, m2Runtime, asyncHandler, owner })
    require("./m3-store-products.cjs").mountStoreProducts(web, { nativeApp, asyncHandler, validateAndTransformQuery,
      productFields: STORE_PRODUCT_FIELDS })
  }
  return { routes, allowedFields, initializeTenant, mount, cartFields: CART_FIELDS, orderFields: STORE_ORDER_FIELDS,
    contract: entries.map((e) => ({ method: e.method, path: e.path, bodySchema: e.body, querySchema: e.validator,
      allowedFields: [...e.permitted] })) }
}
function requireCustomer(req) {
  if (!req.auth_context?.actor_id || req.auth_context.actor_type !== "customer")
    throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Store customer authentication required")
}
module.exports = { createM3Runtime, requireCustomer, STORE_PRODUCT_FIELDS, CART_FIELDS, STORE_ORDER_FIELDS }
