"use strict"
// Explicit offline provisioning of dedicated development identities. Existing administrators are untouched.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{Client}=require("pg")
const {hashPassword,verifyPassword}=require("./platform-auth.cjs"),{provisionPlatformLogin}=require("./provision-platform-login.cjs")
const {assertDemoMode}=require("./self-service.cjs"),{readPrivateJson}=require("./demo-config.cjs")
async function provisionDemo(c,{baseDomain,directory}){
  const merchantEmail=`demo@${baseDomain}`,platformEmail=`demo-admin@${baseDomain}`
  assertDemoMode(baseDomain,{merchant:{email:merchantEmail,password:"check-password-123"},platform:{email:platformEmail,password:"check-password-123"}})
  if(!path.isAbsolute(directory)||fs.realpathSync(directory)!==directory||(fs.statSync(directory).mode&0o077)!==0)throw new Error("Private canonical demo directory required")
  const configFile=path.join(directory,"demo-config.json")
  if(fs.existsSync(configFile)){
    const cfg=readPrivateJson(configFile);assertDemoMode(baseDomain,cfg)
    const a=(await c.query("SELECT password_hash,status FROM saas_control.portal_account WHERE email=$1",[merchantEmail])).rows[0]
    const p=(await c.query("SELECT c.password_hash,p.status,c.actor_id FROM saas_control.platform_credential c JOIN saas_control.platform_identity p USING(actor_id) WHERE c.email=$1",[platformEmail])).rows[0]
    if(!a||a.status!=="active"||!p||p.status!=="active"||p.actor_id!=="demo_platform_admin"||!await verifyPassword(cfg.merchant.password,a.password_hash)||!await verifyPassword(cfg.platform.password,p.password_hash))throw new Error("Existing demo identities changed; explicit operator repair required")
    return {merchant_email:merchantEmail,platform_email:platformEmail,config_file:configFile,created:false}
  }
  const existing=(await c.query("SELECT 1 FROM saas_control.portal_account WHERE email=$1",[merchantEmail])).rowCount
  if(existing)throw new Error("Refusing to adopt an existing merchant email as a demo identity")
  const password=crypto.randomBytes(36).toString("base64url"),platformFile=path.join(directory,"demo-platform-password.txt")
  await provisionPlatformLogin(c,{actorId:"demo_platform_admin",email:platformEmail,passwordFile:platformFile})
  const fd=fs.openSync(platformFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let platformPassword
  try{platformPassword=fs.readFileSync(fd,"utf8").trimEnd()}finally{fs.closeSync(fd)}
  await c.query("INSERT INTO saas_control.portal_account(id,email,password_hash) VALUES($1,$2,$3)",["acct_"+crypto.randomBytes(16).toString("hex"),merchantEmail,await hashPassword(password)])
  const cfg={merchant:{email:merchantEmail,password},platform:{email:platformEmail,password:platformPassword}}
  fs.writeFileSync(configFile,JSON.stringify(cfg)+"\n",{flag:"wx",mode:0o600})
  return {merchant_email:merchantEmail,platform_email:platformEmail,config_file:configFile,created:true}
}
async function main(){
  if(!process.env.SAAS_MIGRATION_DATABASE_URL)throw new Error("Explicit migration connection required")
  const c=new Client({connectionString:process.env.SAAS_MIGRATION_DATABASE_URL});await c.connect()
  try{console.log(JSON.stringify(await provisionDemo(c,{baseDomain:process.env.SAAS_BASE_DOMAIN,directory:process.env.SAAS_DEMO_DIRECTORY})))}finally{await c.end()}
}
if(require.main===module)main().catch(()=>{console.error("Demo provisioning failed; private credentials were not printed");process.exitCode=1})
module.exports={provisionDemo}
