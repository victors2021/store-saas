"use strict"
const {migrateM4,verifyM4Runtime}=require("./migrate-m4.cjs")
const migration=require("./migrations/0007-operations.cjs")
const fs=require("node:fs/promises"),path=require("node:path"),crypto=require("node:crypto")
async function legacyManifest(client,objectRoot) {
  const rows=(await client.query("SELECT id,tenant_id,storage_key FROM saas_file ORDER BY id")).rows
  if(rows.length&&!objectRoot) throw new Error("SAAS_OBJECT_ROOT required to validate existing objects")
  const out=[]
  for(const row of rows) {
    if(!/^[a-f0-9]{64}\/file_[a-f0-9]{40}$/.test(row.storage_key)) throw new Error("Invalid existing object path")
    if(row.storage_key!==crypto.createHash('sha256').update(row.tenant_id).digest('hex')+'/'+row.id)throw new Error("Existing object namespace does not match its tenant")
    const root=await fs.realpath(objectRoot),target=path.join(root,row.storage_key),real=await fs.realpath(target)
    if(real!==target) throw new Error("Legacy object symlinks are not supported")
    const stat=await fs.lstat(target)
    if(!stat.isFile()||stat.size>5242880) throw new Error("Legacy object missing or oversized")
    const data=await fs.readFile(target)
    out.push({...row,byteSize:data.length,hash:crypto.createHash("sha256").update(data).digest("hex")})
  }
  return out
}
async function migrateM5(client,options) {
  const results=await migrateM4(client,options)
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["medusa-saas-m5-operations"])
    // Native product/file writes must be stopped while adopting their counters.
    await client.query("LOCK TABLE saas_control.tenant,public.product,public.saas_file IN SHARE ROW EXCLUSIVE MODE")
    const prior=(await client.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
    if(prior&&prior.checksum!==migration.checksum) throw new Error("Applied M5 migration changed")
    const result=prior?.result||await migration.install(client,{role:options.applicationRole,legacyFiles:await legacyManifest(client,options.objectRoot)})
    await migration.verify(client,{role:options.applicationRole,expectedFingerprint:result.schemaFingerprint})
    if(!prior) await client.query("INSERT INTO saas_control.isolation_migration(id,checksum,result) VALUES($1,$2,$3)",[migration.id,migration.checksum,result])
    await client.query("COMMIT")
    const login=await require("./migrate-platform-login.cjs").migratePlatformLogin(client,options)
    return [...results,{id:migration.id,applied:!prior,...result},login]
  } catch(e){await client.query("ROLLBACK");throw e}
}
async function verifyM5Runtime(client) {
  await verifyM4Runtime(client)
  const role=(await client.query("SELECT current_user name")).rows[0].name
  const row=(await client.query("SELECT checksum,result FROM saas_control.isolation_migration WHERE id=$1",[migration.id])).rows[0]
  if(row?.checksum!==migration.checksum||!row.result?.schemaFingerprint)
    throw new Error("M5 migration is missing or changed")
  await migration.verify(client,{role,expectedFingerprint:row.result.schemaFingerprint})
  await require("./migrate-platform-login.cjs").verifyPlatformLogin(client)
}
module.exports={migrateM5,verifyM5Runtime,legacyManifest}
