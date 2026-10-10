"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs")
const {provisionDemo}=require("./provision-demo.cjs"),{readPrivateJson}=require("./demo-config.cjs"),{assertDemoMode}=require("./self-service.cjs")
test("public merchant registration, isolated shop creation and removable demonstration catalog",{timeout:240000},async()=>{
  if(process.env.SAAS_SELF_SERVICE_TEST_RESET!=="1")throw new Error("Explicit owned self-service fixture reset required")
  process.env.SAAS_M5_PORTAL_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-self-service-")),stripe=await createStripeFixture(),checks=[]
  const host="shops.example.test",origin=`http://${host}`,password="self-service-owner-password-123"
  let f,A,B,shop,complete=false
  const headers=a=>({origin,cookie:a.cookie,"x-csrf-token":a.csrf})
  const check=async(name,task)=>{await f.db.query("DELETE FROM saas_control.rate_window");await task();checks.push({name,passed:true});console.log("PASS",name)}
  const register=async email=>{const r=await f.request(host,"POST","/saas/auth/register",{email,password},{origin});f.ok(r);return {id:r.body.account.id,email,cookie:r.headers["set-cookie"][0].split(";")[0],csrf:r.body.csrf_token}}
  const open=async(a,slug,key,extra={})=>f.request(host,"POST","/saas/shops",{name:slug+" Shop",slug,password,idempotency_key:key,with_demo_products:true,...extra},headers(a))
  try{
    f=await createFixture({fixtureStage:"m5_portal",payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    await check("new migration is additive and repeated migration preserves recorded checksums",async()=>{
      const before=(await f.db.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows;assert(before.some(r=>r.id==="0009-self-service"))
      const result=await require("./migrate-m5.cjs").migrateM5(f.db,{applicationRole:"medusa_saas_m5_portal_app",allowNativeReferenceSeeds:true,objectRoot:f.config.objectRoot})
      assert(result.every(r=>!r.applied));assert.deepEqual((await f.db.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows,before)
    })
    await check("apex serves the real landing and email forms without exposing merchant data",async()=>{
      for(const url of ["/","/register","/login","/dashboard"]){const r=await f.request(host,"GET",url);assert.equal(r.status,200);assert.match(r.body,/Store SaaS/);assert.match(r.headers["content-security-policy"],/script-src 'self'/)}
      const cfg=f.ok(await f.request(host,"GET","/saas/config"));assert.equal(cfg.demo_enabled,false);assert(!JSON.stringify(cfg).includes("password"))
      assert.equal((await f.request(host,"GET","/health/live")).status,200)
      assert.equal((await f.request(host,"GET","/saas/shops")).status,401)
    })
    await check("registration rejects foreign origins, tenant Hosts and privileged body fields",async()=>{
      assert.equal((await f.request(host,"POST","/saas/auth/register",{email:"a@example.test",password})).status,403)
      assert.equal((await f.request(host,"POST","/saas/auth/register",{email:"a@example.test",password},{origin:"http://alpha.shops.example.test"})).status,403)
      assert.equal((await f.request("alpha.shops.example.test","POST","/saas/auth/register",{email:"a@example.test",password},{origin:"http://alpha.shops.example.test"})).status,404)
      assert.equal((await f.request(host,"POST","/saas/auth/register",{email:"a@example.test",password,role:"platform_admin"},{origin})).status,400)
      assert.equal((await f.request(host,"POST","/saas/auth/register",{email:"a@example.test",password},{origin,"x-tenant-id":f.tenants[0].id})).status,400)
    })
    await check("email accounts persist hashed credentials and fixed host-only sessions",async()=>{
      A=await register("first@example.test");B=await register("second@example.test")
      const row=(await f.db.query("SELECT password_hash FROM saas_control.portal_account WHERE id=$1",[A.id])).rows[0];assert.match(row.password_hash,/^scrypt\$/);assert.notEqual(row.password_hash,password)
      const r=await f.request(host,"GET","/saas/auth/session",undefined,{cookie:A.cookie});assert.equal(r.body.account.email,A.email);assert(!JSON.stringify(r.body).includes("password"));assert.equal((await f.request("platform."+host,"GET","/platform/tenants",undefined,{cookie:A.cookie})).status,401)
      const d=await f.request(host,"POST","/saas/auth/register",{email:A.email,password},{origin});assert.equal(d.status,409)
    })
    await check("shop creation verifies CSRF and password before initializing native tenant resources",async()=>{
      const body={name:"Cedar",slug:"cedar",password,idempotency_key:"portal-cedar-v1",with_demo_products:true}
      assert.equal((await f.request(host,"POST","/saas/shops",body,{origin,cookie:A.cookie})).status,403)
      assert.equal((await open(A,"cedar","portal-cedar-v1",{password:"wrong-password-123"})).status,401)
      const r=await open(A,"cedar","portal-cedar-v1");f.ok(r,201);shop=r.body.shop;assert.equal(r.body.demo_error,null);assert.equal(shop.status,"active");assert.equal(shop.demo_count,3);assert.equal(shop.product_count,3)
      const own=f.ok(await f.request(shop.slug+"."+host,"POST","/auth/user/emailpass",{email:A.email,password}));assert(own.token)
    })
    await check("identical opening and repeated sample requests remain idempotent",async()=>{
      const r=await open(A,"cedar","portal-cedar-v1");f.ok(r,201);assert.equal(r.body.shop.id,shop.id);assert.equal(r.body.shop.product_count,3)
      f.ok(await f.request(host,"POST",`/saas/shops/${shop.id}/demo-products`,{},headers(A)))
      assert.equal(f.ok(await f.request(host,"GET","/saas/shops",undefined,{cookie:A.cookie})).shops[0].product_count,3)
    })
    await check("a sibling account cannot list or modify another shop or submit a chosen tenant",async()=>{
      assert.equal(f.ok(await f.request(host,"GET","/saas/shops",undefined,{cookie:B.cookie})).shops.length,0)
      for(const method of ["POST","DELETE"])assert.equal((await f.request(host,method,`/saas/shops/${shop.id}/demo-products`,{},headers(B))).status,404)
      assert.equal((await open(B,"willow","portal-willow-v1",{tenant_id:shop.id})).status,400)
      assert.equal((await open(B,"cedar","another-cedar-v1")).status,409)
    })
    await check("client opening keys are namespaced by account and reserved slugs do not consume shop slots",async()=>{
      const before=(await f.db.query("SELECT count(*)::int n FROM saas_control.portal_shop WHERE account_id=$1",[A.id])).rows[0].n
      assert.equal((await open(A,"platform","reserved-platform-v1")).status,400)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_control.portal_shop WHERE account_id=$1",[A.id])).rows[0].n,before)
      const r=await open(B,"willow","portal-cedar-v1",{with_demo_products:false});f.ok(r,201);assert.notEqual(r.body.shop.id,shop.id)
      assert.equal(f.ok(await f.request(host,"GET","/saas/shops",undefined,{cookie:B.cookie})).shops.filter(s=>s.status==='active').length,1)
    })
    await check("concurrent opening requests cannot exceed the three-shop account limit",async()=>{
      const results=await Promise.all(["ash","maple","elm"].map(slug=>open(A,slug,"portal-limit-"+slug,{with_demo_products:false})))
      assert.equal(results.filter(r=>r.status===201).length,2);assert.equal(results.filter(r=>r.status===409&&r.body.code==='PORTAL_SHOP_LIMIT').length,1)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_control.portal_shop WHERE account_id=$1",[A.id])).rows[0].n,3)
    })
    await check("published samples appear through the tenant storefront catalog",async()=>{
      const r=f.ok(await f.request("cedar."+host,"GET","/store/products"));assert.equal(r.products.length,3);assert(r.products.every(p=>p.title.startsWith("演示")))
      const foreign=f.ok(await f.request("bravo."+host,"GET","/store/products"));assert.equal(foreign.products.length,0)
    })
    await check("clearing samples preserves ordinary products even if their metadata imitates a demo marker",async()=>{
      const login=f.ok(await f.request("cedar."+host,"POST","/auth/user/emailpass",{email:A.email,password})),h={authorization:`Bearer ${login.token}`}
      const r=f.ok(await f.request("cedar."+host,"POST","/admin/products",{title:"Real product",handle:"real-product",status:"draft",metadata:{demo:true},options:[{title:"Size",values:["One"]}],variants:[{title:"One",manage_inventory:false,options:{Size:"One"},prices:[{currency_code:"usd",amount:99}]}]},h),200)
      f.ok(await f.request(host,"DELETE",`/saas/shops/${shop.id}/demo-products`,{},headers(A)))
      const rows=f.ok(await f.request("cedar."+host,"GET","/admin/products",undefined,h)).products;assert.equal(rows.length,1);assert.equal(rows[0].id,r.product.id)
      const catalog=f.ok(await f.request("cedar."+host,"GET","/store/products"));assert.equal(catalog.products.length,0)
      f.ok(await f.request(host,"DELETE",`/saas/shops/${shop.id}/demo-products`,{},headers(A)))
      f.ok(await f.request(host,"POST",`/saas/shops/${shop.id}/demo-products`,{},headers(A)));assert.equal(f.ok(await f.request("cedar."+host,"GET","/admin/products",undefined,h)).products.length,4)
    })
    await check("paused shops reject sample writes and maintain owner-only native access",async()=>{
      await f.db.query("UPDATE saas_control.tenant SET status='suspended' WHERE id=$1",[shop.id])
      try{assert.equal((await f.request(host,"DELETE",`/saas/shops/${shop.id}/demo-products`,{},headers(A))).status,423)}finally{await f.db.query("UPDATE saas_control.tenant SET status='active' WHERE id=$1",[shop.id])}
      assert.equal((await f.request("cedar."+host,"GET","/admin/products",undefined,{cookie:A.cookie})).status,401)
    })
    await check("login failure is uniform and logout invalidates the saved session",async()=>{
      const bad=await f.request(host,"POST","/saas/auth/login",{email:A.email,password:"wrong-password-123"},{origin}),unknown=await f.request(host,"POST","/saas/auth/login",{email:"absent@example.test",password:"wrong-password-123"},{origin})
      assert.equal(bad.status,401);assert.deepEqual(bad.body,unknown.body)
      f.ok(await f.request(host,"DELETE","/saas/auth/session",{},headers(B)));assert.equal((await f.request(host,"GET","/saas/shops",undefined,{cookie:B.cookie})).status,401)
    })
    await check("account revocation and version changes are checked on every portal request",async()=>{
      await f.db.query("UPDATE saas_control.portal_account SET status='revoked' WHERE id=$1",[A.id]);try{assert.equal((await f.request(host,"GET","/saas/shops",undefined,{cookie:A.cookie})).status,401)}finally{await f.db.query("UPDATE saas_control.portal_account SET status='active' WHERE id=$1",[A.id])}
      await f.db.query("UPDATE saas_control.portal_account SET version=version+1 WHERE id=$1",[A.id]);assert.equal((await f.request(host,"GET","/saas/shops",undefined,{cookie:A.cookie})).status,401)
    })
    await check("demo bootstrap uses dedicated accounts and keeps credentials in private files",async()=>{
      const result=await provisionDemo(f.db,{baseDomain:host,directory});assert(result.created);assert.equal(fs.statSync(result.config_file).mode&0o777,0o600)
      assert.equal((await provisionDemo(f.db,{baseDomain:host,directory})).created,false)
      f.config.demo=readPrivateJson(result.config_file);await f.restart()
      const cfg=f.ok(await f.request(host,"GET","/saas/config"));assert(cfg.demo_enabled);assert.equal(cfg.demo_email,"demo@shops.example.test");assert(!JSON.stringify(cfg).includes(f.config.demo.merchant.password))
    })
    await check("demo merchant opens a sample shop and native quick login is limited to its bound owner",async()=>{
      const r=await f.request(host,"POST","/saas/auth/demo",{},{origin});f.ok(r);const D={cookie:r.headers["set-cookie"][0].split(";")[0],csrf:r.body.csrf_token}
      const opened=await f.request(host,"POST","/saas/shops",{slug:"demo-store",name:"Demo",idempotency_key:"demo-store-v1",with_demo_products:true},headers(D));f.ok(opened,201);assert.equal(opened.body.shop.demo_count,3)
      assert.equal((await f.request("demo-store."+host,"POST","/auth/user/demo",{},{origin:"http://demo-store."+host})).status,200)
      assert.equal((await f.request("cedar."+host,"POST","/auth/user/demo",{},{origin:"http://cedar."+host})).status,401)
      assert.equal((await f.request("demo-store."+host,"POST","/auth/user/demo",{})).status,403)
    })
    await check("platform demo uses a separate administrator and public signup never grants that identity",async()=>{
      const platform="platform."+host,origin="http://"+platform
      const r=await f.request(platform,"POST","/platform/auth/demo",{},{origin});f.ok(r);assert.equal(r.body.administrator.actor_id,"demo_platform_admin");assert.equal(r.body.administrator.email,"demo-admin@shops.example.test")
      const cookie=r.headers["set-cookie"][0].split(";")[0];assert.equal((await f.request(platform,"GET","/platform/tenants",undefined,{cookie})).status,200)
      assert.equal((await f.request(host,"GET","/saas/shops",undefined,{cookie})).status,401)
      assert.equal((await f.request(host,"POST","/saas/auth/register",{email:"demo-admin@shops.example.test",password},{origin:"http://"+host})).status,409)
    })
    await check("demo logins disappear when disabled and are rejected for production or custom public domains",async()=>{
      const mode=process.env.NODE_ENV;try{process.env.NODE_ENV="production";assert.throws(()=>assertDemoMode(host,f.config.demo),/restricted/)}finally{process.env.NODE_ENV=mode}
      assert.throws(()=>assertDemoMode("public-shop.com",f.config.demo),/restricted/)
      delete f.config.demo;await f.restart();assert.equal((await f.request(host,"POST","/saas/auth/demo",{},{origin})).status,404)
      assert.equal((await f.request("platform."+host,"POST","/platform/auth/demo",{},{origin:"http://platform."+host})).status,404)
    })
    await check("runtime grants cannot modify account privileges and schema drift blocks startup",async()=>{
      await assert.rejects(f.app.pool.query("UPDATE saas_control.portal_account SET status='active'"),e=>e.code==="42501")
      await f.db.query("GRANT UPDATE ON saas_control.portal_account TO medusa_saas_m5_portal_app")
      try{await assert.rejects(require("./migrate-self-service.cjs").verifySelfService(f.app.pool),/privilege drift/)}finally{await f.db.query("REVOKE UPDATE ON saas_control.portal_account FROM medusa_saas_m5_portal_app")}
    })
    complete=true
  }finally{
    if(f)await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_SELF_SERVICE_RESULT)fs.writeFileSync(process.env.SAAS_SELF_SERVICE_RESULT,JSON.stringify({complete,passed:checks.length,checks,independentReview:false},null,2)+"\n")
  }
})
