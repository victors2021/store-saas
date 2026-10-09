"use strict"

function mountStoreProducts(web, { nativeApp, asyncHandler, validateAndTransformQuery, productFields }) {
  const { maybeApplyLinkFilter, applyDefaultFilters, clearFiltersByKey, applyParamsAsFilters } = require("@medusajs/framework/http")
  const { MedusaError } = require("@medusajs/framework/utils")
  const helpers = require("@medusajs/medusa/api/utils/middlewares/index")
  const { StoreGetProductsParams } = require("@medusajs/medusa/api/store/products/validators")
  const prepare = asyncHandler(async (req, res, next) => {
    const stores = await nativeApp.modules.store.listStores({})
    if (!stores[0]?.default_sales_channel_id) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Store channel is unavailable")
    const channel = await nativeApp.modules.sales_channel.retrieveSalesChannel(stores[0].default_sales_channel_id)
    if (channel.is_disabled) throw new MedusaError(MedusaError.Types.NOT_FOUND, "Store channel is unavailable")
    req.publishable_key_context = { sales_channel_ids: [channel.id] }
    if (!req.query.region_id) req.query.region_id = stores[0].default_region_id
    if (req.query.region_id) await nativeApp.modules.region.retrieveRegion(req.query.region_id)
    if (req.query.cart_id) {
      const cart = await nativeApp.modules.cart.retrieveCart(req.query.cart_id)
      if (req.auth_context?.actor_type !== "customer" || cart.customer_id !== req.auth_context.actor_id)
        throw new MedusaError(MedusaError.Types.NOT_FOUND, "Cart is unavailable")
    }
    next()
  })
  for (const path of ["/store/products", "/store/products/:id"]) {
    const isList = !path.endsWith(":id")
    const middleware = [prepare, validateAndTransformQuery(StoreGetProductsParams, {
      defaults: productFields, allowed: productFields, isList, defaultLimit: 50,
    }), ...(isList ? [] : [applyParamsAsFilters({ id: "id" })]), helpers.filterByValidSalesChannels(),
    maybeApplyLinkFilter({ entryPoint: "product_sales_channel", resourceId: "product_id", filterableField: "sales_channel_id" }),
    applyDefaultFilters({ status: "published", categories: (filters) => {
      const ids = filters.category_id
      delete filters.category_id
      if (ids) return { id: ids, is_internal: false, is_active: true }
    } }), helpers.normalizeDataForContext(), helpers.setPricingContext(), helpers.setTaxContext(),
    clearFiltersByKey(["region_id", "country_code", "province", "cart_id"])]
    web.get(path, ...middleware.map(asyncHandler),
      asyncHandler(require(`@medusajs/medusa/api/store/products/${isList ? "" : "[id]/"}route`).GET))
  }
}
module.exports = { mountStoreProducts }
