"use strict"

// Run with a dedicated migration connection, never with the HTTP runtime role.
const { installTenantControl } = require("./tenant-control.cjs")

async function migrateM1(client, { applicationRole }) {
  if (process.env.MEDUSA_SAAS_MODE !== "true")
    throw new Error("M1 requires MEDUSA_SAAS_MODE=true")
  await installTenantControl(client, { applicationRole })
  const versions = [
    require("./migrations/0002-catalog.cjs"),
    require("./migrations/0003-identity.cjs"),
  ]
  await client.query("BEGIN")
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      ["medusa-saas-m1-isolation-v1"]
    )
    await client.query(`CREATE TABLE IF NOT EXISTS saas_control.isolation_migration (
      id text PRIMARY KEY, checksum text NOT NULL, result jsonb NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const results = []
    for (const migration of versions) {
      const existing = (
        await client.query(
          "SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",
          [migration.id]
        )
      ).rows[0]
      if (existing) {
        if (existing.checksum !== migration.checksum)
          throw new Error(
            `Applied isolation migration changed: ${migration.id}`
          )
        await migration.verify(client, { role: applicationRole })
        results.push({ id: migration.id, applied: false, ...existing.result })
        continue
      }
      const result = await migration.install(client, { role: applicationRole })
      await migration.verify(client, { role: applicationRole })
      await client.query(
        "INSERT INTO saas_control.isolation_migration (id,checksum,result) VALUES ($1,$2,$3)",
        [migration.id, migration.checksum, result]
      )
      results.push({ id: migration.id, applied: true, ...result })
    }
    await client.query(
      `GRANT SELECT ON public.link_module_migrations, saas_control.isolation_migration TO "${applicationRole}"`
    )
    await client.query("COMMIT")
    return results
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

async function verifyM1Runtime(client) {
  const role = (await client.query("SELECT current_user AS name")).rows[0].name
  for (const migration of [
    require("./migrations/0002-catalog.cjs"),
    require("./migrations/0003-identity.cjs"),
  ]) {
    const row = (
      await client.query(
        "SELECT checksum FROM saas_control.isolation_migration WHERE id=$1",
        [migration.id]
      )
    ).rows[0]
    if (!row || row.checksum !== migration.checksum)
      throw new Error(`M1 migration is missing or changed: ${migration.id}`)
    await migration.verify(client, { role })
  }
}

module.exports = { migrateM1, verifyM1Runtime }
