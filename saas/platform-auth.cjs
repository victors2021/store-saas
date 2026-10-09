"use strict"
const crypto=require("node:crypto"),{promisify}=require("node:util")
const {normalizeHost}=require("./tenant-control.cjs"),{error}=require("./m5-policy.cjs")
const scrypt=promisify(crypto.scrypt),parameters={N:32768,r:8,p:1,maxmem:64*1024*1024}
const hashPattern=/^scrypt\$32768\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/
const hour=60*60*1000
function normalizeEmail(value) {
  if (typeof value!=="string" || value.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return null
  return value.trim().toLowerCase()
}
function validPassword(value) {return typeof value==="string" && value.length>=12 && value.length<=256 && Buffer.byteLength(value)<=1024}
async function hashPassword(password) {
  if (!validPassword(password)) throw new Error("Password must contain 12–256 characters")
  const salt=crypto.randomBytes(16),derived=await scrypt(password,salt,32,parameters)
  return `scrypt$32768$8$1$${salt.toString("hex")}$${derived.toString("hex")}`
}
async function verifyPassword(password,encoded) {
  const match=hashPattern.exec(encoded||""),salt=match?Buffer.from(match[1],"hex"):Buffer.alloc(16)
  const actual=await scrypt(password,salt,32,parameters),expected=match?Buffer.from(match[2],"hex"):Buffer.alloc(32)
  return crypto.timingSafeEqual(actual,expected) && !!match
}
function createPlatformAuth({pool,baseDomain,contextSecret,platformKey,platformActorId,secureCookies,getControl,rate}) {
  const cookieName=secureCookies?"__Host-store.saas.platform":"store.saas.platform"
  const cookieOptions={httpOnly:true,secure:secureCookies,sameSite:"strict",path:"/"}
  let activeHashes=0
  const digest=value=>crypto.createHmac("sha256",contextSecret).update(JSON.stringify(["platform-session-v1",value])).digest("hex")
  function host(req) {
    if (normalizeHost(req.headers.host)!==`platform.${baseDomain}`) throw error("PLATFORM_AUTHENTICATION_REQUIRED","Unauthorized",401)
    if (["x-tenant-id","tenant-id","tenant_id","x-forwarded-host"].some(k=>req.headers[k]!==undefined))
      throw error("TENANT_HEADER_FORBIDDEN","Direct platform Host required",400)
  }
  function browserOrigin(req) {
    if (secureCookies && !req.secure) throw error("PLATFORM_HTTPS_REQUIRED","Administrator login requires HTTPS",403)
    if (req.headers.origin!==`${req.protocol}://${req.headers.host.toLowerCase()}` ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"]!=="same-origin"))
      throw error("PLATFORM_ORIGIN_REQUIRED","Administrator request must originate from this platform",403)
  }
  function token(req) {
    const values=(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(x=>x.startsWith(cookieName+"="))
    if (values.length!==1) return null
    const value=values[0].slice(cookieName.length+1)
    return /^[a-f0-9]{64}$/.test(value)?value:null
  }
  async function session(req) {
    const value=token(req)
    if (!value) return null
    return (await pool.query(`SELECT s.id,s.csrf_secret,c.email,c.actor_id FROM saas_control.platform_login_session s
      JOIN saas_control.platform_credential c ON c.actor_id=s.actor_id AND c.version=s.credential_version
      JOIN saas_control.platform_identity p ON p.actor_id=c.actor_id AND p.status='active'
      WHERE s.id=$1 AND s.expires_at>now()`,[digest(value)])).rows[0]||null
  }
  function csrf(req,record) {
    browserOrigin(req)
    const value=req.headers["x-csrf-token"]
    if (typeof value!=="string" || !/^[a-f0-9]{64}$/.test(value) ||
        !crypto.timingSafeEqual(Buffer.from(value),Buffer.from(record.csrf_secret)))
      throw error("PLATFORM_CSRF_REQUIRED","Reload the platform before saving changes",403)
  }
  async function authenticate(req,res,next) {
    host(req)
    if (req.headers.authorization!==undefined) {
      const bearer=req.headers.authorization.match(/^Bearer ([^ ]+)$/)?.[1]
      if (!bearer || Buffer.byteLength(bearer)!==Buffer.byteLength(platformKey) ||
          !crypto.timingSafeEqual(Buffer.from(bearer),Buffer.from(platformKey)) ||
          !(await getControl().authorizePlatformAdmin(platformActorId)))
        throw error("PLATFORM_AUTHENTICATION_REQUIRED","Unauthorized",401)
      req.platformAdmin={actorId:platformActorId,kind:"automation"}
    } else {
      if (secureCookies && !req.secure) throw error("PLATFORM_HTTPS_REQUIRED","Administrator session requires HTTPS",403)
      const record=await session(req)
      if (!record || !(await getControl().authorizePlatformAdmin(record.actor_id)))
        throw error("PLATFORM_AUTHENTICATION_REQUIRED","Unauthorized",401)
      if (!["GET","HEAD","OPTIONS"].includes(req.method)) csrf(req,record)
      req.platformAdmin={actorId:record.actor_id,email:record.email,kind:"session",record}
    }
    next()
  }
  async function login(req,res) {
    host(req)
    if (req.headers.authorization!==undefined) throw error("PLATFORM_AUTHENTICATION_REQUIRED","Unauthorized",401)
    browserOrigin(req)
    const body=req.body||{},email=normalizeEmail(body.email)
    if (!email || !validPassword(body.password) || Object.keys(body).some(k=>!["email","password"].includes(k)))
      throw error("PLATFORM_LOGIN_FAILED","邮箱或密码不正确",401)
    const scope=value=>crypto.createHmac("sha256",contextSecret).update(value).digest("hex")
    await rate("platform-login:global",30)
    await rate("platform-login:ip:"+scope(req.ip||"unknown"),10)
    await rate("platform-login:email:"+scope(email),5)
    const credential=(await pool.query(`SELECT c.* FROM saas_control.platform_credential c
      JOIN saas_control.platform_identity p ON p.actor_id=c.actor_id AND p.status='active' WHERE c.email=$1`,[email])).rows[0]
    if (activeHashes>=4) throw error("SAAS_RATE_LIMITED","Login is busy; retry shortly",429)
    let accepted
    activeHashes++
    try {accepted=await verifyPassword(body.password,credential?.password_hash)} finally {activeHashes--}
    if (!accepted) throw error("PLATFORM_LOGIN_FAILED","邮箱或密码不正确",401)
    const value=crypto.randomBytes(32).toString("hex"),csrfSecret=crypto.randomBytes(32).toString("hex"),client=await pool.connect()
    try {
      await client.query("BEGIN")
      const current=(await client.query(`SELECT c.actor_id,c.email,c.version FROM saas_control.platform_credential c
        JOIN saas_control.platform_identity p ON p.actor_id=c.actor_id AND p.status='active'
        WHERE c.actor_id=$1 AND c.version=$2 AND c.password_hash=$3`,
        [credential.actor_id,credential.version,credential.password_hash])).rows[0]
      if (!current) throw error("PLATFORM_LOGIN_FAILED","邮箱或密码不正确",401)
      const old=token(req)
      if (old) await client.query("DELETE FROM saas_control.platform_login_session WHERE id=$1",[digest(old)])
      const inserted=await client.query(`INSERT INTO saas_control.platform_login_session(id,actor_id,credential_version,csrf_secret,expires_at)
        SELECT $1,c.actor_id,c.version,$4,now()+interval '1 hour' FROM saas_control.platform_credential c
        JOIN saas_control.platform_identity p ON p.actor_id=c.actor_id AND p.status='active'
        WHERE c.actor_id=$2 AND c.version=$3 AND c.password_hash=$5 RETURNING id`,
        [digest(value),current.actor_id,current.version,csrfSecret,credential.password_hash])
      if (!inserted.rowCount) throw error("PLATFORM_LOGIN_FAILED","邮箱或密码不正确",401)
      await client.query("INSERT INTO saas_control.audit_event(actor_id,action,details) VALUES($1,'platform.login',$2)",[current.actor_id,{method:"email_password"}])
      await client.query("COMMIT")
      res.cookie(cookieName,value,{...cookieOptions,maxAge:hour})
      res.json({administrator:{actor_id:current.actor_id,email:current.email},csrf_token:csrfSecret})
    } catch(e) {await client.query("ROLLBACK");throw e} finally {client.release()}
  }
  async function current(req,res) {
    await authenticate(req,res,()=>{})
    if (req.platformAdmin.kind!=="session") throw error("PLATFORM_AUTHENTICATION_REQUIRED","Administrator session required",401)
    res.json({administrator:{actor_id:req.platformAdmin.actorId,email:req.platformAdmin.email},csrf_token:req.platformAdmin.record.csrf_secret})
  }
  async function logout(req,res) {
    await authenticate(req,res,()=>{})
    if (req.platformAdmin.kind!=="session") throw error("PLATFORM_AUTHENTICATION_REQUIRED","Administrator session required",401)
    const client=await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("DELETE FROM saas_control.platform_login_session WHERE id=$1",[req.platformAdmin.record.id])
      await client.query("INSERT INTO saas_control.audit_event(actor_id,action,details) VALUES($1,'platform.logout','{}')",[req.platformAdmin.actorId])
      await client.query("COMMIT")
    } catch(e) {await client.query("ROLLBACK");throw e} finally {client.release()}
    res.clearCookie(cookieName,cookieOptions);res.json({logged_out:true})
  }
  return {authenticate,login,current,logout}
}
module.exports={createPlatformAuth,normalizeEmail,validPassword,hashPassword,verifyPassword}
