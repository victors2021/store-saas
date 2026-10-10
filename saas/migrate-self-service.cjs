"use strict"
const migration=require("./migrations/0009-self-service.cjs")
async function migrateSelfService(c,{applicationRole}){
  await c.query("BEGIN")
  try{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[migration.id])
    const prior=(await c.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
    if(prior&&prior.checksum!==migration.checksum)throw new Error("Applied self-service migration changed")
    const result=prior?.result||await migration.install(c,{role:applicationRole})
    await migration.verify(c,{role:applicationRole,expectedFingerprint:result.schemaFingerprint})
    if(!prior)await c.query("INSERT INTO saas_control.isolation_migration(id,checksum,result) VALUES($1,$2,$3)",[migration.id,migration.checksum,result])
    await c.query("COMMIT");return {id:migration.id,applied:!prior,...result}
  }catch(e){await c.query("ROLLBACK");throw e}
}
async function verifySelfService(c){
  const row=(await c.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
  if(row?.checksum!==migration.checksum)throw new Error("Self-service migration missing or changed; run migrate-m5-command.cjs")
  await migration.verify(c,{role:(await c.query("SELECT current_user name")).rows[0].name,expectedFingerprint:row.result?.schemaFingerprint})
}
module.exports={migrateSelfService,verifySelfService}
