"use strict"
const { currentTenant } = require("./tenant-context.cjs")

async function tenantSQL(pool, task) {
  const identity = currentTenant()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [
      identity.tenantId,
    ])
    const result = await task(client, identity)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
module.exports = { tenantSQL }
