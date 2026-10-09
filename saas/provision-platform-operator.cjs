"use strict"

// Offline bootstrap with the migration connection. The runtime cannot insert
// platform identities, and tenant membership never grants platform authority.
const { Client } = require("pg")
async function main() {
  const actorId = process.env.SAAS_PLATFORM_ACTOR_ID
  const databaseUrl = process.env.SAAS_MIGRATION_DATABASE_URL
  if (
    !databaseUrl ||
    typeof actorId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(actorId)
  )
    throw new Error(
      "Migration database URL and valid platform actor ID required"
    )
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await client.query(
      "INSERT INTO saas_control.platform_identity (actor_id,status) VALUES ($1,'active') ON CONFLICT (actor_id) DO NOTHING",
      [actorId]
    )
    console.log(
      "Platform operator provisioned; no tenant business access was granted"
    )
  } finally {
    await client.end()
  }
}
main().catch((error) => {
  console.error("Operator provisioning failed", {
    name: error.name,
    message: error.message,
  })
  process.exitCode = 1
})
