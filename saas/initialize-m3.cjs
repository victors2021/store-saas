"use strict"
// Explicit, idempotent M2 -> M3 business configuration upgrade. No schema reset,
// business data adoption or context-free all-tenant mutation is performed.
process.env.MEDUSA_SAAS_MODE = "true"
const jwt = require("jsonwebtoken")
const { createM1Application } = require("./m1-application.cjs")
const { runtimeConfig } = require("./m3-config.cjs")
const { createTenantVerifier, runWithTenant } = require("./tenant-context.cjs")
async function main() {
  const tenantId = process.argv[2]
  if (!/^tenant_[a-zA-Z0-9]+$/.test(tenantId || "") || process.argv.length !== 3) throw new Error("Usage: node saas/initialize-m3.cjs TENANT_ID")
  const config = runtimeConfig(), app = await createM1Application(config)
  try {
    if (!(await app.pool.query("SELECT 1 FROM saas_control.platform_identity WHERE actor_id=$1 AND status='active'", [config.platformActorId])).rowCount)
      throw new Error("An active platform operator is required")
    const tenant = await app.control.getTenant(tenantId)
    if (!tenant || tenant.status !== "active") throw new Error("An active, explicitly selected tenant is required")
    const verify = createTenantVerifier({ secret: config.contextSecret, issuer: "medusa-m3-configuration", audience: "configuration-upgrade",
      lookupMembership: (identity) => app.control.authorizeMembership(identity) })
    const context = await verify(jwt.sign({ tenant_id: tenant.id }, config.contextSecret, { subject: tenant.ownerActorId,
      issuer: "medusa-m3-configuration", audience: "configuration-upgrade", expiresIn: "5m" }))
    await runWithTenant(context, () => app.m3Runtime.initializeTenant(tenant))
    await app.pool.query("INSERT INTO saas_control.audit_event(actor_id,tenant_id,action,details) VALUES($1,$2,'tenant.m3_initialized',$3::jsonb)",
      [config.platformActorId, tenant.id, JSON.stringify({ stage: "M3" })])
    console.log(JSON.stringify({ tenant_id: tenant.id, stage: "M3", initialized: true }))
  } finally { await app.close() }
}
main().catch((error) => { console.error("M3 configuration upgrade failed", { name: error.name, message: error.message }); process.exitCode = 1 })
