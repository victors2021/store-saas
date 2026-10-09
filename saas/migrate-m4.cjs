"use strict"
const { migrateM2, verifyM2Runtime } = require("./migrate-m2.cjs")
const migration = require("./migrations/0006-payments.cjs")
async function migrateM4(client, options) {
  const results = await migrateM2(client, options)
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "medusa-saas-m4-payments",
    ])
    const prior = (
      await client.query(
        "SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",
        [migration.id]
      )
    ).rows[0]
    if (prior && prior.checksum !== migration.checksum)
      throw new Error("Applied M4 migration changed")
    const result =
      prior?.result ||
      (await migration.install(client, { role: options.applicationRole }))
    await migration.verify(client, { role: options.applicationRole })
    if (!prior)
      await client.query(
        "INSERT INTO saas_control.isolation_migration(id,checksum,result) VALUES($1,$2,$3)",
        [migration.id, migration.checksum, result]
      )
    await client.query("COMMIT")
    return [...results, { id: migration.id, applied: !prior, ...result }]
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
async function verifyM4Runtime(client) {
  await verifyM2Runtime(client)
  const role = (await client.query("SELECT current_user AS name")).rows[0].name
  const row = (
    await client.query(
      "SELECT checksum FROM saas_control.isolation_migration WHERE id=$1",
      [migration.id]
    )
  ).rows[0]
  if (row?.checksum !== migration.checksum)
    throw new Error("M4 migration is missing or changed")
  await migration.verify(client, { role })
}
module.exports = { migrateM4, verifyM4Runtime }
