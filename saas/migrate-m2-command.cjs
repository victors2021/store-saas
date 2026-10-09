"use strict"
process.env.MEDUSA_SAAS_MODE = "true"
const { Client } = require("pg"),
  { bootNative } = require("./m1-application.cjs"),
  { migrateM2 } = require("./migrate-m2.cjs")
async function main() {
  const url = process.env.SAAS_MIGRATION_DATABASE_URL,
    role = process.env.SAAS_APPLICATION_ROLE,
    jwtSecret = process.env.SAAS_JWT_SECRET
  if (!url || !role || !jwtSecret)
    throw new Error(
      "Explicit migration URL, runtime role and JWT secret are required"
    )
  const boot = await bootNative(url, { jwtSecret, commerce: true })
  try {
    await boot.app.runMigrations()
    const planner = boot.app.linkMigrationExecutionPlanner(),
      plan = await planner.createPlan()
    if (plan.some?.((x) => ["delete", "notify"].includes(x.action)))
      throw new Error(
        "Review destructive native Link migration before M2 install"
      )
    await planner.executePlan(plan)
  } finally {
    await boot.close()
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const results = await migrateM2(client, {
      applicationRole: role,
      allowNativeReferenceSeeds:
        process.env.SAAS_ALLOW_NATIVE_REFERENCE_SEEDS === "true",
    })
    console.log(
      JSON.stringify(
        results.map((r) => ({
          id: r.id,
          applied: r.applied,
          tables: r.tables?.length,
        })),
        null,
        2
      )
    )
  } finally {
    await client.end()
  }
}
main().catch((e) => {
  console.error("M2 migration failed", { name: e.name, message: e.message })
  process.exitCode = 1
})
