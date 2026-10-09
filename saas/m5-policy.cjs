"use strict"
const { MedusaError }=require("@medusajs/framework/utils")
const maintenanceLock="medusa-saas-m5-backup-gate-v1"
function error(code,message,status=409) { const e=new Error(message); e.code=code;e.statusCode=status;return e }
function pausedRoute(method,path) {
  if(method==="GET") return path.startsWith("/admin/") || path.startsWith("/store/orders") || path==="/store/customers/me"
  if(path==="/auth/session") return ["POST","DELETE"].includes(method)
  if(method!=="POST") return false
  return /^\/auth\/(user|customer)\/emailpass$/.test(path) ||
    /^\/admin\/payments\/[a-z]+_[A-Za-z0-9]+\/refund$/.test(path)||
    /^\/admin\/orders\/[a-z]+_[A-Za-z0-9]+\/(cancel|fulfillments(?:\/[a-z]+_[A-Za-z0-9]+\/(shipments|cancel))?)$/.test(path)||
    /^\/admin\/saas\/operations\/[a-z]+_[A-Za-z0-9]+\/retry$/.test(path)
}
async function requireActive(control) {
  const {currentTenant}=require("./tenant-context.cjs")
  if((await control.getTenant(currentTenant().tenantId))?.status!=="active")
    throw error("TENANT_SUSPENDED","Shop is paused; new checkout and collection are disabled",423)
}
const paidOrder=async(nativeApp,id)=>{
  const {data}=await nativeApp.query.graph({entity:"order",fields:["id","status","payment_collections.amount","payment_collections.payments.provider_id","payment_collections.payments.captures.amount"],filters:{id},options:{throwIfKeyNotFound:true}})
  if(!data[0]) throw new MedusaError(MedusaError.Types.NOT_FOUND,"Order is unavailable")
  const collections=data[0].payment_collections||[]
  const settled=collections.length>0&&collections.every(collection=>{
    const captured=(collection.payments||[]).filter(payment=>payment.provider_id==='pp_stripe_saas')
      .reduce((sum,payment)=>sum+(payment.captures||[]).reduce((sum,row)=>sum+Number(row.amount),0),0)
    return Number.isFinite(Number(collection.amount))&&captured+1e-9>=Number(collection.amount)
  })
  if(!settled)
    throw error("TENANT_PAUSED_ORDER_UNPAID","Paused shops can fulfill orders with settled payment only",423)
}
module.exports={maintenanceLock,error,pausedRoute,requireActive,paidOrder}
