"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs")
const {provisionPlatformLogin}=require("./provision-platform-login.cjs"),{startBenchmarkProcess}=require("./m6-benchmark-process.cjs")
test("platform email login, isolated authority, session revocation and migration security",{timeout:180000},async()=>{
  if (process.env.SAAS_PLATFORM_LOGIN_TEST_RESET!=="1") throw new Error("Explicit owned platform login fixture reset required")
  process.env.SAAS_M5_LOGIN_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-platform-login-")),stripe=await createStripeFixture(),checks=[]
  const actor="email_platform_admin",email="admin@shops.example.test",passwordFile=path.join(directory,"password.txt")
  const host="platform.shops.example.test",origin=`http://${host}`
  let f,peer,password,cookie,csrf,complete=false
  const check=async(name,task)=>{await f.db.query("DELETE FROM saas_control.rate_window");await task();checks.push({name,passed:true});console.log("PASS",name)}
  const sessionHeaders=()=>({cookie,origin,"x-csrf-token":csrf})
  const login=async(extra={})=>{
    const response=await f.request(host,"POST","/platform/auth/login",{email,password},{origin,...extra})
    f.ok(response);cookie=response.headers["set-cookie"][0].split(";")[0];csrf=response.body.csrf_token;return response
  }
  try {
    f=await createFixture({fixtureStage:"m5_login",payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    const [A,B]=f.tenants
    await check("additive migration is recorded and repeated install does not change historical checksums",async()=>{
      const before=(await f.db.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows
      assert(before.some(row=>row.id==="0008-platform-login"))
      const result=await require("./migrate-m5.cjs").migrateM5(f.db,{applicationRole:"medusa_saas_m5_login_app",allowNativeReferenceSeeds:true,objectRoot:f.config.objectRoot})
      assert(result.every(row=>!row.applied));assert.deepEqual((await f.db.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows,before)
    })
    await check("offline bootstrap creates a private random password and a normalized administrator with a password hash",async()=>{
      const result=await provisionPlatformLogin(f.db,{actorId:actor,email:" Admin@Shops.Example.Test ",passwordFile})
      assert.equal(result.email,email);assert(result.created)
      assert.equal(fs.statSync(passwordFile).mode&0o777,0o600);password=fs.readFileSync(passwordFile,"utf8").trimEnd()
      const row=(await f.db.query("SELECT email,password_hash,version FROM saas_control.platform_credential WHERE actor_id=$1",[actor])).rows[0]
      assert.equal(row.email,email);assert.notEqual(row.password_hash,password);assert.match(row.password_hash,/^scrypt\$/);assert.equal(row.version,1)
      assert.equal((await provisionPlatformLogin(f.db,{actorId:actor,email,passwordFile})).created,false)
      assert.equal((await f.db.query("SELECT version FROM saas_control.platform_credential WHERE actor_id=$1",[actor])).rows[0].version,1)
    })
    await check("runtime cannot grant platform authority or change administrator credentials",async()=>{
      await assert.rejects(f.app.pool.query("UPDATE saas_control.platform_identity SET status='active' WHERE actor_id=$1",[actor]),e=>e.code==="42501")
      await assert.rejects(f.app.pool.query("UPDATE saas_control.platform_credential SET version=version+1 WHERE actor_id=$1",[actor]),e=>e.code==="42501")
      await assert.rejects(f.app.pool.query("INSERT INTO saas_control.platform_credential(actor_id,email,password_hash) SELECT actor_id,'other@example.test',password_hash FROM saas_control.platform_credential LIMIT 1"),e=>e.code==="42501")
    })
    await check("login rejects tenant Hosts, client tenant headers, missing origins and cross-site origins",async()=>{
      for (const [hostname,headers,status] of [[A.hostname,{origin:`http://${A.hostname}`},401],[host,{origin,"x-tenant-id":A.id},400],
        [host,{},403],[host,{origin:`http://${B.hostname}`},403],[host,{origin,"sec-fetch-site":"cross-site"},403]])
        assert.equal((await f.request(hostname,"POST","/platform/auth/login",{email,password},headers)).status,status)
    })
    await check("wrong passwords and unknown emails return the same failure without revealing credentials",async()=>{
      const wrong=await f.request(host,"POST","/platform/auth/login",{email,password:"wrong-password-123"},{origin})
      const unknown=await f.request(host,"POST","/platform/auth/login",{email:"absent@example.test",password:"wrong-password-123"},{origin})
      assert.equal(wrong.status,401);assert.equal(unknown.status,401);assert.equal(wrong.body.code,unknown.body.code);assert.equal(wrong.body.message,unknown.body.message)
      assert(!JSON.stringify(wrong.body).includes(password));assert(!wrong.headers["set-cookie"])
    })
    await check("native merchant email/password and tenant JWT never grant platform access",async()=>{
      assert.equal((await f.request(host,"POST","/platform/auth/login",f.credentials,{origin})).status,401)
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{authorization:`Bearer ${A.ownerToken}`})).status,401)
      assert.equal((await f.request(host,"POST","/platform/auth/login",{email,password},{origin,authorization:`Bearer ${A.ownerToken}`})).status,401)
    })
    await check("email login creates an HttpOnly host-only fixed one-hour session and displays its real administrator",async()=>{
      const response=await f.request(host,"POST","/platform/auth/login",{email:" Admin@Shops.Example.Test ",password},{origin})
      f.ok(response);cookie=response.headers["set-cookie"][0].split(";")[0];csrf=response.body.csrf_token
      assert.equal(response.body.administrator.actor_id,actor);assert.equal(response.body.administrator.email,email)
      assert.match(response.headers["set-cookie"][0],/HttpOnly/);assert.match(response.headers["set-cookie"][0],/SameSite=Strict/)
      assert.match(response.headers["set-cookie"][0],/Max-Age=3600/);assert(!response.headers["set-cookie"][0].includes("Domain="))
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie})).status,200)
      assert.equal((await f.request(host,"GET","/platform/auth/session",null,{cookie})).body.administrator.email,email)
      const row=(await f.db.query("SELECT id,expires_at-created_at AS ttl FROM saas_control.platform_login_session WHERE actor_id=$1",[actor])).rows[0]
      assert.notEqual(row.id,cookie.split("=")[1]);assert(!JSON.stringify(response.body).includes(password))
    })
    await check("a platform cookie is not a merchant session and another tenant cookie cannot become a platform session",async()=>{
      assert.equal((await f.request(A.hostname,"GET","/admin/stores",null,{cookie})).status,401)
      assert.equal((await f.request(B.hostname,"GET","/platform/tenants",null,{cookie})).status,401)
      const merchant=await f.request(A.hostname,"POST","/auth/session",{},{authorization:`Bearer ${A.ownerToken}`});f.ok(merchant)
      const own=merchant.headers["set-cookie"][0].split(";")[0]
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie:own})).status,401)
    })
    await check("session mutations enforce same-origin and CSRF while audit records use the authenticated actor",async()=>{
      const url=`/platform/tenants/${A.id}/status`
      for (const headers of [{cookie},{cookie,origin},{...sessionHeaders(),"x-csrf-token":"0".repeat(64)},
        {...sessionHeaders(),origin:`http://${B.hostname}`}])
        assert.equal((await f.request(host,"POST",url,{status:"suspended"},headers)).status,403)
      f.ok(await f.request(host,"POST",url,{status:"suspended"},sessionHeaders()))
      f.ok(await f.request(host,"POST",url,{status:"active"},sessionHeaders()))
      const row=(await f.db.query("SELECT actor_id FROM saas_control.audit_event WHERE tenant_id=$1 AND action='tenant.status_changed' ORDER BY id DESC LIMIT 1",[A.id])).rows[0]
      assert.equal(row.actor_id,actor)
    })
    await check("administrator cookie can open a tenant without the automation key",async()=>{
      const result=await f.request(host,"POST","/platform/tenants",{slug:"charlie",name:"Charlie Shop",...f.credentials,idempotency_key:"email-open-charlie"},sessionHeaders())
      f.ok(result,201);assert.equal(result.body.tenant.slug,"charlie")
    })
    await check("opaque cookies and CSRF replay remain invalid after logout on both independent API processes",async()=>{
      peer=await startBenchmarkProcess(f.config,{stage:"m5_login",stripePort:stripe.port})
      assert.equal((await peer.request(host,"GET","/platform/auth/session",null,{cookie})).body.administrator.email,email)
      const oldCookie=cookie,oldCsrf=csrf
      assert.equal((await peer.request(host,"DELETE","/platform/auth/session",null,sessionHeaders())).status,200)
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie:oldCookie})).status,401)
      assert.equal((await peer.request(host,"GET","/platform/tenants",null,{cookie:oldCookie})).status,401)
      assert.equal((await f.request(host,"POST",`/platform/tenants/${A.id}/status`,{status:"suspended"},{cookie:oldCookie,origin,"x-csrf-token":oldCsrf})).status,401)
      peer.assertHealthy();await peer.close();peer=null;await login()
    })
    await check("re-login rotates the session and invalidates the previous cookie",async()=>{
      const oldCookie=cookie;await login({cookie:oldCookie})
      assert.notEqual(cookie,oldCookie);assert.equal((await f.request(host,"GET","/platform/auth/session",null,{cookie:oldCookie})).status,401)
    })
    await check("persistent administrator revocation is checked on every request and bootstrap cannot reactivate it",async()=>{
      await f.db.query("UPDATE saas_control.platform_identity SET status='revoked' WHERE actor_id=$1",[actor])
      try {
        assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie})).status,401)
        assert.equal((await f.request(host,"POST","/platform/auth/login",{email,password},{origin})).status,401)
        await assert.rejects(provisionPlatformLogin(f.db,{actorId:actor,email,passwordFile}),/REVOKED_OPERATOR/)
      } finally {await f.db.query("UPDATE saas_control.platform_identity SET status='active' WHERE actor_id=$1",[actor])}
    })
    await check("explicit password reset invalidates every prior session and the previous password",async()=>{
      const nextFile=path.join(directory,"next-password.txt"),oldPassword=password,oldCookie=cookie
      const result=await provisionPlatformLogin(f.db,{actorId:actor,email,passwordFile:nextFile,resetPassword:true});assert(result.reset)
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie:oldCookie})).status,401)
      assert.equal((await f.request(host,"POST","/platform/auth/login",{email,password:oldPassword},{origin})).status,401)
      password=fs.readFileSync(nextFile,"utf8").trimEnd();await login()
    })
    await check("database expiry invalidates a cookie immediately and reads do not extend its lifetime",async()=>{
      const before=(await f.db.query("SELECT expires_at FROM saas_control.platform_login_session WHERE actor_id=$1",[actor])).rows[0].expires_at
      f.ok(await f.request(host,"GET","/platform/auth/session",null,{cookie}))
      assert.equal((await f.db.query("SELECT expires_at FROM saas_control.platform_login_session WHERE actor_id=$1",[actor])).rows[0].expires_at.getTime(),before.getTime())
      await f.db.query("UPDATE saas_control.platform_login_session SET expires_at=now()-interval '1 second' WHERE actor_id=$1",[actor])
      assert.equal((await f.request(host,"GET","/platform/tenants",null,{cookie})).status,401)
    })
    await check("shared database login throttling blocks the sixth password attempt for an email",async()=>{
      for (let n=0;n<5;n++) assert.equal((await f.request(host,"POST","/platform/auth/login",{email,password:"wrong-password-123"},{origin})).status,401)
      assert.equal((await f.request(host,"POST","/platform/auth/login",{email,password},{origin})).status,429)
    })
    await check("read-only monitoring automation remains compatible and still checks persisted platform revocation",async()=>{
      const automation={authorization:`Bearer ${f.config.platformKey}`}
      assert.equal((await f.request(host,"GET","/platform/metrics",null,automation)).status,200)
      await f.db.query("UPDATE saas_control.platform_identity SET status='revoked' WHERE actor_id=$1",[f.config.platformActorId])
      try {assert.equal((await f.request(host,"GET","/platform/metrics",null,automation)).status,401)}
      finally {await f.db.query("UPDATE saas_control.platform_identity SET status='active' WHERE actor_id=$1",[f.config.platformActorId])}
    })
    await check("runtime start fails closed if login table grants drift",async()=>{
      await f.db.query('GRANT UPDATE ON saas_control.platform_credential TO medusa_saas_m5_login_app')
      try {
        const client=await f.app.pool.connect()
        try {await assert.rejects(require("./migrate-platform-login.cjs").verifyPlatformLogin(client),/privilege drift/)} finally {client.release()}
      } finally {await f.db.query('REVOKE UPDATE ON saas_control.platform_credential FROM medusa_saas_m5_login_app')}
    })
    complete=true
  } finally {
    if (peer) await peer.close();if (f) await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if (process.env.SAAS_PLATFORM_LOGIN_RESULT) fs.writeFileSync(process.env.SAAS_PLATFORM_LOGIN_RESULT,JSON.stringify({complete,passed:checks.length,checks,independentReview:false},null,2)+"\n")
  }
})
