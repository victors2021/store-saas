"use strict"

// No resets/backfills: existing unowned data aborts and needs reviewed migration.
const { Client } = require("pg")
const { bootNative } = require("./m1-application.cjs")
const { migrateM1 } = require("./migrate-m1.cjs")
async function main() {
  const databaseUrl = process.env.SAAS_MIGRATION_DATABASE_URL
  if (
    !databaseUrl ||
    !process.env.SAAS_JWT_SECRET ||
    !process.env.SAAS_APPLICATION_ROLE
  )
    throw new Error(
      "Migration URL, application role and signing secret are required"
    )
  if (process.env.MEDUSA_SAAS_MODE !== "true")
    throw new Error("Migration requires explicit MEDUSA_SAAS_MODE=true")
  const native = await bootNative(databaseUrl, {
    jwtSecret: process.env.SAAS_JWT_SECRET,
  })
  try {
    await native.app.runMigrations()
    const planner = native.app.linkMigrationExecutionPlanner()
    const plan = await planner.createPlan()
    if (plan.some((item) => ["notify", "delete"].includes(item.action)))
      throw new Error("Native link migration requires an explicit review")
    await planner.executePlan(plan)
  } finally {
    await native.close()
  }
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await migrateM1(client, {
      applicationRole: process.env.SAAS_APPLICATION_ROLE,
    })
    console.log(JSON.stringify(result))
  } finally {
    await client.end()
  }
}
main().catch((error) => {
  console.error("M1 migration failed", {
    name: error.name,
    message: error.message,
  })
  process.exitCode = 1
})
