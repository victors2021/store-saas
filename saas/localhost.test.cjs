"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs")
const {createDevelopmentHosts}=require("./development-hosts.cjs"),{provisionDemo}=require("./provision-demo.cjs"),{readPrivateJson}=require("./demo-config.cjs")

test("localhost aliases remain development-only and preserve the native tenant boundaries",{timeout:240000},async()=>{
  if(process.env.SAAS_LOCALHOST_TEST_RESET!=="1")throw new Error("Explicit owned localhost fixture reset required")
  process.env.SAAS_M5_LOCALHOST_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-localhost-")),stripe=await createStripeFixture(),checks=[]
  const previousMode=process.env.NODE_ENV,previousRelease=process.env.SAAS_RELEASE_MANIFEST
  let f,complete=false,account,shop
  const host="localhost:9443",origin="http://"+host,password="localhost-merchant-password-123"
  const check=async(name,task)=>{if(f)await f.db.query("DELETE FROM saas_control.rate_window");await task();checks.push({name,passed:true});console.log("PASS",name)}
  const headers=()=>({origin,cookie:account.cookie,"x-csrf-token":account.csrf})
  try{
    await check("production, release manifests, public domains and ambiguous flags cannot enable aliases",async()=>{
      process.env.NODE_ENV="production";assert.throws(()=>createDevelopmentHosts({baseDomain:"shops.example.test",enabled:true}),/development/)
      process.env.NODE_ENV="development";process.env.SAAS_RELEASE_MANIFEST="release.json"
      assert.throws(()=>createDevelopmentHosts({baseDomain:"shops.example.test",enabled:true}),/development/)
      delete process.env.SAAS_RELEASE_MANIFEST
      assert.throws(()=>createDevelopmentHosts({baseDomain:"shops.example.com",enabled:true}),/development/)
      assert.throws(()=>createDevelopmentHosts({baseDomain:"shops.example.test",enabled:"true"}),/boolean/)
      const hosts=createDevelopmentHosts({baseDomain:"shops.example.test",enabled:true})
      assert.equal(hosts.canonicalHost(host),"shops.example.test")
      assert.equal(hosts.canonicalHost("alpha.shops.localhost:9443"),"alpha.shops.example.test")
      for(const bad of ["localhost:0","localhost:65536","localhost:9443@evil.test","localhost,evil.test","https://localhost:9443","alpha..localhost"])
        assert.throws(()=>hosts.canonicalHost(bad))
      assert.notEqual(hosts.canonicalHost("alpha.shops.localhost.evil.test"),"alpha.shops.example.test")
      assert.notEqual(hosts.canonicalHost("nested.alpha.shops.localhost"),"alpha.shops.example.test")
    })
    process.env.NODE_ENV="test"
    f=await createFixture({fixtureStage:"m5_localhost",payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    await f.seedCommerce()
    await check("the unchanged default runtime does not expose localhost aliases",async()=>{
      assert.notEqual((await f.request(host,"GET","/saas/config")).status,200)
      assert.equal((await f.request("alpha.shops.localhost:9443","GET","/store/products")).status,404)
    })
    f.config.localhostAccess=true;await f.restart()
    await check("localhost serves the landing, dashboard and links without changing canonical domain rows",async()=>{
      for(const url of ["/","/login","/register","/dashboard"]){const r=await f.request(host,"GET",url);assert.equal(r.status,200);assert.match(r.body,/Store SaaS/)}
      const cfg=f.ok(await f.request(host,"GET","/saas/config"));assert.equal(cfg.base_domain,"shops.localhost");assert.equal(cfg.platform_url,"http://platform.shops.localhost:9443/platform")
      const original=f.ok(await f.request("shops.example.test:9443","GET","/saas/config"));assert.equal(original.base_domain,"shops.example.test")
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_control.domain WHERE hostname LIKE '%localhost%'")).rows[0].n,0)
    })
    await check("localhost registration and shop initialization require exact Origin, CSRF and owned credentials",async()=>{
      const body={email:"local-owner@shops.example.test",password}
      for(const foreign of ["http://shops.example.test:9443","http://alpha.shops.localhost:9443","http://localhost:9444"])
        assert.equal((await f.request(host,"POST","/saas/auth/register",body,{origin:foreign})).status,403)
      assert.equal((await f.request(host,"POST","/saas/auth/register",body,{origin,"x-tenant-id":f.tenants[0].id})).status,400)
      assert.equal((await f.request(host,"POST","/saas/auth/register",body,{origin,"x-forwarded-host":"shops.example.test"})).status,400)
      const registered=await f.request(host,"POST","/saas/auth/register",body,{origin});f.ok(registered)
      account={cookie:registered.headers["set-cookie"][0].split(";")[0],csrf:registered.body.csrf_token}
      const input={name:"Local Shop",slug:"local-shop",password,idempotency_key:"localhost-shop-v1",with_demo_products:true}
      assert.equal((await f.request(host,"POST","/saas/shops",input,{origin,cookie:account.cookie})).status,403)
      const opened=f.ok(await f.request(host,"POST","/saas/shops",input,headers()),201);shop=opened.shop
      assert.equal(shop.admin_url,"http://local-shop.shops.localhost:9443/app/");assert.equal(shop.demo_count,3)
      const domains=(await f.db.query("SELECT hostname FROM saas_control.domain WHERE tenant_id=$1",[shop.id])).rows
      assert.deepEqual(domains,[{hostname:"local-shop.shops.example.test"}])
    })
    await check("existing native catalogs and shop ownership resolve identically through each alias",async()=>{
      const alpha=f.ok(await f.request("alpha.shops.localhost:9443","GET","/store/products"))
      const canonical=f.ok(await f.request("alpha.shops.example.test:9443","GET","/store/products"))
      assert.deepEqual(alpha.products.map(p=>p.id),canonical.products.map(p=>p.id));assert.equal(alpha.products[0].id,f.tenants[0].product.id)
      assert.equal((await f.request("missing.shops.localhost:9443","GET","/store/products")).status,404)
      for(const foreign of ["nested.alpha.shops.localhost:9443","alpha.shops.localhost.evil.test:9443"])
        assert.equal((await f.request(foreign,"GET","/store/products")).status,404)
      const local=f.ok(await f.request("local-shop.shops.localhost:9443","POST","/auth/user/emailpass",{email:"local-owner@shops.example.test",password},{origin:"http://local-shop.shops.localhost:9443"}))
      assert(local.token);assert.equal((await f.request("bravo.shops.localhost:9443","GET","/admin/products",null,{authorization:`Bearer ${local.token}`})).status,401)
    })
    await check("native sessions cannot cross shop or control-plane hosts and mutations keep exact origins",async()=>{
      const a=f.tenants[0],nativeHost="alpha.shops.localhost:9443",nativeOrigin="http://"+nativeHost
      const login=f.ok(await f.request(nativeHost,"POST","/auth/user/emailpass",f.credentials,{origin:nativeOrigin}))
      const session=await f.request(nativeHost,"POST","/auth/session",{}, {origin:nativeOrigin,authorization:`Bearer ${login.token}`});f.ok(session)
      const cookie=session.headers["set-cookie"][0].split(";")[0]
      f.ok(await f.request(nativeHost,"GET","/admin/products",null,{cookie}))
      for(const foreign of ["bravo.shops.localhost:9443","alpha.shops.example.test:9443"])
        assert.equal((await f.request(foreign,"GET","/admin/products",null,{cookie})).status,401)
      assert.equal((await f.request(host,"GET","/saas/shops",null,{cookie})).status,401)
      assert.equal((await f.request("platform.shops.localhost:9443","GET","/platform/tenants",null,{cookie})).status,401)
      for(const foreign of [origin,"http://alpha.shops.example.test:9443","http://bravo.shops.localhost:9443"])
        assert.equal((await f.request(nativeHost,"POST",`/admin/products/${a.product.id}`,{title:"Rejected"},{cookie,origin:foreign})).status,403)
      assert.equal((await f.request(nativeHost,"GET","/admin/products",null,{cookie,"x-forwarded-host":"bravo.shops.example.test"})).status,400)
    })
    await check("old same-shop sample images use local paths while saved URLs and metadata remain intact",async()=>{
      const a=f.tenants[0],url="https://alpha.shops.example.test:9443/images/demo-shirt.svg",auth={authorization:`Bearer ${a.ownerToken}`}
      f.ok(await f.request(a.hostname,"POST",`/admin/products/${a.product.id}`,{thumbnail:url,images:[{url}],metadata:{literal:url}},auth))
      const original=f.ok(await f.request(a.hostname,"GET",`/admin/products/${a.product.id}`,null,auth)).product
      const local=f.ok(await f.request("alpha.shops.localhost:9443","GET",`/admin/products/${a.product.id}`,null,auth)).product
      assert.equal(original.thumbnail,url);assert.equal(local.thumbnail,"/images/demo-shirt.svg")
      assert.equal(local.images[0].url,"/images/demo-shirt.svg");assert.equal(local.metadata.literal,url)
      assert.equal((await f.db.query("SELECT thumbnail FROM product WHERE id=$1",[a.product.id])).rows[0].thumbnail,url)
      assert.equal((await f.request("bravo.shops.localhost:9443","GET",`/admin/products/${a.product.id}`,null,{authorization:`Bearer ${f.tenants[1].ownerToken}`})).status,404)
    })
    await check("platform alias retains independent demo credentials and host-scoped authorization",async()=>{
      const demo=await provisionDemo(f.db,{baseDomain:f.config.baseDomain,directory});f.config.demo=readPrivateJson(demo.config_file);await f.restart()
      const platform="platform.shops.localhost:9443",pOrigin="http://"+platform
      const r=await f.request(platform,"POST","/platform/auth/demo",{},{origin:pOrigin});f.ok(r)
      const cookie=r.headers["set-cookie"][0].split(";")[0];assert.equal(r.body.administrator.email,"demo-admin@shops.example.test")
      f.ok(await f.request(platform,"GET","/platform/tenants",null,{cookie}))
      assert.equal((await f.request(host,"GET","/saas/shops",null,{cookie})).status,401)
      assert.equal((await f.request("alpha.shops.localhost:9443","GET","/admin/products",null,{cookie})).status,401)
      assert.equal((await f.request(platform,"POST","/platform/auth/demo",{},{origin})).status,403)
    })
    await check("turning aliases off preserves canonical access and all existing tenant records",async()=>{
      const before=(await f.db.query("SELECT id,slug,status FROM saas_control.tenant ORDER BY id")).rows
      f.config.localhostAccess=false;await f.restart()
      assert.notEqual((await f.request(host,"GET","/saas/config")).status,200)
      assert.equal((await f.request("alpha.shops.localhost:9443","GET","/store/products")).status,404)
      assert.equal((await f.request("shops.example.test:9443","GET","/saas/config")).status,200)
      assert.deepEqual((await f.db.query("SELECT id,slug,status FROM saas_control.tenant ORDER BY id")).rows,before)
    })
    complete=true
  }finally{
    if(f)await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode
    if(previousRelease===undefined)delete process.env.SAAS_RELEASE_MANIFEST;else process.env.SAAS_RELEASE_MANIFEST=previousRelease
    if(process.env.SAAS_LOCALHOST_RESULT)fs.writeFileSync(process.env.SAAS_LOCALHOST_RESULT,JSON.stringify({complete,passed:checks.length,checks,independentReview:false},null,2)+"\n")
  }
})
