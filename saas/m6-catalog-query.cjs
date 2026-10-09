"use strict"
const {tenantSQL}=require("./tenant-sql.cjs")

// The native storefront channel filter needs one scalar column, not a graph
// of thousands of hydrated Link entities on every catalog page. Keep this
// exact projection/filter shape inside a verified application-role RLS tx.
// Other Query shapes/options retain the native implementation.
async function catalogChannelIds(pool,input,options={}) {
  if(input?.entity!=="product_sales_channel"||!Array.isArray(input.fields)||input.fields.length!==1||input.fields[0]!=="product_id"||
    Object.keys(input).some(k=>!["entity","fields","filters"].includes(k))||Object.keys(options).length)return null
  const filters=input.filters
  if(!filters||typeof filters!=="object"||Array.isArray(filters)||!Object.hasOwn(filters,"sales_channel_id")||
    Object.keys(filters).some(k=>!["sales_channel_id","product_id"].includes(k)))return null
  const ids=value=>typeof value==="string"?[value]:Array.isArray(value)&&value.every(x=>typeof x==="string")?value:null
  const channels=ids(filters.sales_channel_id),products=Object.hasOwn(filters,"product_id")?ids(filters.product_id):undefined
  if(!channels||products===null)return null
  const data=await tenantSQL(pool,async client=>(await client.query(
    "SELECT product_id FROM product_sales_channel WHERE deleted_at IS NULL AND sales_channel_id=ANY($1::text[])"+
      (products!==undefined?" AND product_id=ANY($2::text[])":""),products!==undefined?[channels,products]:[channels]
  )).rows)
  return {data}
}
module.exports={catalogChannelIds}
