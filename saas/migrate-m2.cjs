"use strict"
const { migrateM1, verifyM1Runtime } = require("./migrate-m1.cjs")
async function migrateM2(
  client,
  { applicationRole, allowNativeReferenceSeeds = false }
) {
  const first = await migrateM1(client, { applicationRole })
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "medusa-saas-m2-isolation",
    ])
    const results = []
    for (const m of [
      require("./migrations/0004-commerce.cjs"),
      require("./migrations/0005-runtime.cjs"),
    ]) {
      const existing = (
        await client.query(
          "SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",
          [m.id]
        )
      ).rows[0]
      if (existing && existing.checksum !== m.checksum)
        throw new Error(`Applied isolation migration changed: ${m.id}`)
      const result =
        existing?.result ||
        (await m.install(client, {
          role: applicationRole,
          allowNativeReferenceSeeds,
        }))
      await m.verify(client, { role: applicationRole })
      if (!existing)
        await client.query(
          "INSERT INTO saas_control.isolation_migration (id,checksum,result) VALUES($1,$2,$3)",
          [m.id, m.checksum, result]
        )
      results.push({ id: m.id, applied: !existing, ...result })
    }
    await client.query("COMMIT")
    return [...first, ...results]
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}
async function verifyM2Runtime(client) {
  await verifyM1Runtime(client)
  const role = (await client.query("SELECT current_user AS name")).rows[0].name
  for (const m of [
    require("./migrations/0004-commerce.cjs"),
    require("./migrations/0005-runtime.cjs"),
  ]) {
    const row = (
      await client.query(
        "SELECT checksum FROM saas_control.isolation_migration WHERE id=$1",
        [m.id]
      )
    ).rows[0]
    if (!row || row.checksum !== m.checksum)
      throw new Error(`M2 migration missing or changed: ${m.id}`)
    await m.verify(client, { role })
  }
}
module.exports = { migrateM2, verifyM2Runtime }
