"use strict"
// Offline operator command. No HTTP endpoint can grant platform authority or reset credentials.
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path"),{Client}=require("pg")
const {normalizeEmail,hashPassword,verifyPassword}=require("./platform-auth.cjs")
async function provisionPlatformLogin(client,{actorId,email,passwordFile,resetPassword=false}) {
  email=normalizeEmail(email)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(actorId||"") || !email || !path.isAbsolute(passwordFile||""))
    throw new Error("EXPLICIT_ACTOR_EMAIL_AND_ABSOLUTE_PASSWORD_FILE_REQUIRED")
  let created=false
  await client.query("BEGIN")
  try {
    await client.query("INSERT INTO saas_control.platform_identity(actor_id,status) VALUES($1,'active') ON CONFLICT(actor_id) DO NOTHING",[actorId])
    const identity=(await client.query("SELECT status FROM saas_control.platform_identity WHERE actor_id=$1 FOR UPDATE",[actorId])).rows[0]
    if (identity?.status!=="active") throw new Error("REVOKED_OPERATOR_CANNOT_BE_REACTIVATED_BY_LOGIN_SETUP")
    const prior=(await client.query("SELECT * FROM saas_control.platform_credential WHERE actor_id=$1 FOR UPDATE",[actorId])).rows[0]
    if (!fs.existsSync(passwordFile)) {
      if (prior && !resetPassword) throw new Error("EXISTING_PASSWORD_FILE_REQUIRED_OR_EXPLICIT_PASSWORD_RESET")
      const directory=path.dirname(passwordFile)
      if (fs.realpathSync(directory)!==directory || (fs.statSync(directory).mode&0o077)!==0)
        throw new Error("PASSWORD_DIRECTORY_MUST_BE_PRIVATE_AND_CANONICAL")
      fs.writeFileSync(passwordFile,crypto.randomBytes(48).toString("base64url")+"\n",{flag:"wx",mode:0o600});created=true
    }
    const fd=fs.openSync(passwordFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
    let password
    try {
      const stat=fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink!==1 || (stat.mode&0o077)!==0 || stat.size>1026)
        throw new Error("PASSWORD_FILE_MUST_BE_A_PRIVATE_REGULAR_FILE")
      password=fs.readFileSync(fd,"utf8").replace(/\r?\n$/,"")
    } finally {fs.closeSync(fd)}
    if (prior && !resetPassword) {
      if (prior.email!==email || !(await verifyPassword(password,prior.password_hash)))
        throw new Error("CREDENTIAL_CHANGE_REQUIRES_EXPLICIT_PASSWORD_RESET")
      await client.query("COMMIT")
      return {actor_id:actorId,email,password_file:passwordFile,created:false,reset:false}
    }
    const passwordHash=await hashPassword(password)
    await client.query(`INSERT INTO saas_control.platform_credential(actor_id,email,password_hash) VALUES($1,$2,$3)
      ON CONFLICT(actor_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
        version=saas_control.platform_credential.version+1,updated_at=now()`,[actorId,email,passwordHash])
    await client.query("DELETE FROM saas_control.platform_login_session WHERE actor_id=$1",[actorId])
    await client.query("INSERT INTO saas_control.audit_event(actor_id,action,details) VALUES($1,'platform.credential_set',$2)",[actorId,{reset:!!prior}])
    await client.query("COMMIT")
    return {actor_id:actorId,email,password_file:passwordFile,created:!prior,reset:!!prior}
  } catch(e) {
    await client.query("ROLLBACK")
    if (created) fs.unlinkSync(passwordFile)
    throw e
  }
}
async function main() {
  if (!process.env.SAAS_MIGRATION_DATABASE_URL) throw new Error("EXPLICIT_MIGRATION_DATABASE_URL_REQUIRED")
  const client=new Client({connectionString:process.env.SAAS_MIGRATION_DATABASE_URL});await client.connect()
  try {
    console.log(JSON.stringify(await provisionPlatformLogin(client,{
      actorId:process.env.SAAS_PLATFORM_ACTOR_ID,email:process.env.SAAS_PLATFORM_EMAIL,
      passwordFile:process.env.SAAS_PLATFORM_PASSWORD_FILE,resetPassword:process.env.SAAS_PLATFORM_RESET_PASSWORD==="true"
    })))
  } finally {await client.end()}
}
if (require.main===module) main().catch(e=>{
  console.error({code:/^[A-Z_]+$/.test(e.message)?e.message:"PLATFORM_LOGIN_PROVISION_FAILED",name:e.name});process.exitCode=1
})
module.exports={provisionPlatformLogin}
