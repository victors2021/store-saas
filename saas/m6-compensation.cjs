"use strict"
// Medusa Link.dismiss soft-deletes its rows. Same-tenant ownership FKs still
// reference a target through these tombstones. A compensating native hard
// delete must remove only dismissed links in its SAME module transaction.
// Active links and financial/cart recovery ledgers remain protected by FKs.
const orderLinks=["order_cart","order_fulfillment","order_payment_collection","order_promotion"]
async function clearOrderLinkTombstones(manager,tenantId,values){
  const ids=Array.isArray(values)?values:[values]
  if(!ids.length)return
  if(ids.some(id=>typeof id!=="string"||!/^order_[A-Za-z0-9]+$/.test(id)))throw new TypeError("Native order IDs required")
  // The native DAL expands arrays while interpolating `?`; use scalar bound
  // IDs so a single-element array cannot become a malformed PG array literal.
  const slots=ids.map(()=>"?").join(",")
  for(const table of orderLinks)await manager.execute(`DELETE FROM public.${table} WHERE tenant_id=? AND order_id IN (${slots}) AND deleted_at IS NOT NULL`,[tenantId,...ids])
}
module.exports={clearOrderLinkTombstones}
