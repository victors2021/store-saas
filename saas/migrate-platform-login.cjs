"use strict"
const migration=require("./migrations/0008-platform-login.cjs")
async function migratePlatformLogin(client,{applicationRole}) {
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[migration.id])
    const prior=(await client.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
    if (prior && prior.checksum!==migration.checksum) throw new Error("Applied platform login migration changed")
    const result=prior?.result||await migration.install(client,{role:applicationRole})
    await migration.verify(client,{role:applicationRole,expectedFingerprint:result.schemaFingerprint})
    if (!prior) await client.query("INSERT INTO saas_control.isolation_migration(id,checksum,result) VALUES($1,$2,$3)",[migration.id,migration.checksum,result])
    await client.query("COMMIT")
    return {id:migration.id,applied:!prior,...result}
  } catch(e) {await client.query("ROLLBACK");throw e}
}
async function verifyPlatformLogin(client) {
  const row=(await client.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
  if (row?.checksum!==migration.checksum) throw new Error("Platform login migration is missing or changed; run migrate-m5-command.cjs")
  const role=(await client.query("SELECT current_user name")).rows[0].name
  await migration.verify(client,{role,expectedFingerprint:row.result?.schemaFingerprint})
}
module.exports={migratePlatformLogin,verifyPlatformLogin}
