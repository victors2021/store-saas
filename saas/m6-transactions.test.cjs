"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs"),{seedM4Browser}=require("./m4-browser-seed.cjs"),{conflict,makeCart}=require("./m6-performance.cjs")
const {probe}=require("./m6-monitor.cjs")
const {startBenchmarkProcess}=require("./m6-benchmark-process.cjs")
test("M6 concurrent checkout compensation, private metrics and alert drill",{timeout:300000},async()=>{
  if(process.env.SAAS_M6_TRANSACTION_RESET!=="1")throw new Error("Explicit owned transaction fixture reset required")
  process.env.SAAS_M5_CONCURRENCY_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-m6-transactions-")),stripe=await createStripeFixture(),checks=[]
  let f,secondary,complete=false,checkout
  const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log("PASS",name)}
  try{
    f=await createFixture({fixtureStage:"m5_concurrency",fixtureVariants:2,payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    const [A,B]=f.tenants,owner=t=>({authorization:`Bearer ${t.ownerToken}`}),platform={authorization:`Bearer ${f.config.platformKey}`}
    await f.seedCommerce();await seedM4Browser(f,stripe)
    for(const t of f.tenants)t.customerToken=f.ok(await f.request(t.hostname,"POST","/auth/customer/emailpass",{email:"m4-browser-buyer@example.test",password:f.credentials.password})).token
    for(let n=0;n<1000;n++){if(!await f.app.m2Runtime.jobs.processNext())break}
    await check("two independent API processes share sessions, immediate cart writes and checkout idempotency while rejecting cross-tenant access",async()=>{
      secondary=await startBenchmarkProcess(f.config,{stage:"m5_concurrency",stripePort:stripe.port})
      for(const t of f.tenants){
        f.ok(await secondary.request(t.hostname,"GET","/admin/stores",null,owner(t)))
        const other=t===A?B:A
        assert.equal((await secondary.request(other.hostname,"GET","/admin/stores",null,owner(t))).status,401)
      }
      const session=await f.request(A.hostname,"POST","/auth/session",{},owner(A));f.ok(session)
      const cookie=session.headers["set-cookie"].map(value=>value.split(";")[0]).join("; ")
      f.ok(await secondary.request(A.hostname,"GET","/admin/stores",null,{cookie}))
      assert.equal((await secondary.request(B.hostname,"GET","/admin/stores",null,{cookie})).status,401)
      const cart=await makeCart(f,A,stripe,"m6-two-process-cart")
      const customer={authorization:`Bearer ${A.customerToken}`}
      f.ok(await secondary.request(A.hostname,"POST",`/store/carts/${cart.id}/line-items/${cart.items[0].id}`,{quantity:2},customer))
      assert.equal(f.ok(await f.request(A.hostname,"GET",`/store/carts/${cart.id}`,null,customer)).cart.items[0].quantity,2)
      assert.equal((await secondary.request(B.hostname,"GET",`/store/carts/${cart.id}`,null,{authorization:`Bearer ${B.customerToken}`})).status,404)
      // A cart edit after payment confirmation legitimately requires another
      // payment session. Test checkout on its own confirmed, unchanged cart.
      const paidCart=await makeCart(f,A,stripe,"m6-two-process-paid-cart",{payment:true})
      const headers={...customer,"idempotency-key":"m6-two-process-complete"},completePath=`/store/carts/${paidCart.id}/complete`
      const initial=await Promise.all([f.request(A.hostname,"POST",completePath,{},headers),secondary.request(A.hostname,"POST",completePath,{},headers)])
      assert(initial.every(r=>[200,409].includes(r.status)),JSON.stringify(initial.map(r=>({status:r.status,code:r.body.code}))))
      let completed
      for(let n=0;n<100;n++){
        const response=await secondary.request(A.hostname,"POST",completePath,{},headers)
        if(response.status===200){completed=response.body;break}
        assert.equal(response.status,409);await new Promise(resolve=>setTimeout(resolve,100))
      }
      assert(completed?.order)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM order_cart WHERE tenant_id=$1 AND cart_id=$2 AND deleted_at IS NULL",[A.id,paidCart.id])).rows[0].n,1)
      assert.equal(f.ok(await f.request(A.hostname,"POST",completePath,{},headers)).order.id,completed.order.id)
      assert.equal((await secondary.request(B.hostname,"GET",`/admin/orders/${completed.order.id}`,null,owner(B))).status,404)
      await f.db.query("UPDATE saas_control.platform_identity SET status='revoked' WHERE actor_id=$1",[f.config.platformActorId])
      try{assert.equal((await secondary.request("platform.shops.example.test","GET","/platform/metrics",null,platform)).status,401)}
      finally{await f.db.query("UPDATE saas_control.platform_identity SET status='active' WHERE actor_id=$1",[f.config.platformActorId])}
      secondary.assertHealthy();await secondary.close();secondary=null
    })
    await check("12 concurrent cart workflows across two tenants finish with a four-connection native pool and preserve ownership",async()=>{
      const {ContainerRegistrationKeys}=require("@medusajs/framework/utils")
      const connection=f.app.nativeApp.sharedContainer.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      assert.equal(connection.client.pool.max,4)
      const carts=[]
      for(const t of f.tenants)for(let n=0;n<6;n++)carts.push({tenant:t,cart:await makeCart(f,t,stripe,`m6-pool-cart-${t.slug}-${n}`)})
      const started=Date.now()
      const updates=await Promise.all(carts.map(({tenant:t,cart})=>f.request(t.hostname,"POST",`/store/carts/${cart.id}/line-items/${cart.items[0].id}`,{quantity:1},{authorization:`Bearer ${t.customerToken}`})))
      assert(updates.every(r=>r.status===200),JSON.stringify(updates.map(r=>({status:r.status,code:r.body.code}))))
      assert(Date.now()-started<10000,"Concurrent orchestration must not wait for the 60-second pool timeout")
      for(const {tenant:t,cart}of carts){
        f.ok(await f.request(t.hostname,"GET",`/store/carts/${cart.id}`,null,{authorization:`Bearer ${t.customerToken}`}))
        const other=t===A?B:A
        assert.equal((await f.request(other.hostname,"GET",`/store/carts/${cart.id}`,null,{authorization:`Bearer ${other.customerToken}`})).status,404)
      }
    })
    await check("20 simultaneous native checkouts settle without overselling, duplicate orders or failed compensation orphans",async()=>{
      const before=(await f.db.query('SELECT count(*)::int n FROM "order" WHERE tenant_id=$1',[A.id])).rows[0].n
      checkout=await conflict(f,stripe)
      assert.equal(checkout.createdOrders,2)
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "order" WHERE tenant_id=$1',[A.id])).rows[0].n,before+2)
      const failed=(await f.db.query("SELECT execution FROM workflow_execution WHERE workflow_id='complete-cart' AND state='failed'")).rows
      for(const row of failed)for(const step of Object.values(row.execution.steps||{}))assert.notEqual(step.compensate?.state,"failed")
    })
    await check("checkout/credential bindings and vendor SDK requests remain associated with their own merchant account",async()=>{
      const rows=(await f.db.query("SELECT b.tenant_id,c.account_id,count(*)::int n FROM saas_payment_binding b JOIN saas_payment_credential c ON c.id=b.credential_id AND c.tenant_id=b.tenant_id GROUP BY b.tenant_id,c.account_id")).rows
      for(const row of rows){const t=f.tenants.find(t=>t.id===row.tenant_id);assert(t);assert.equal(row.account_id,stripe.config(t.slug).account_id)}
      assert(stripe.calls.some(c=>c.account===stripe.config("alpha").account_id&&c.path==="/v1/payment_intents"))
      assert(stripe.calls.some(c=>c.account===stripe.config("bravo").account_id&&c.path==="/v1/payment_intents"))
    })
    await check("Prometheus metrics require persisted platform authority and never reflect bodies, query values or actor credentials",async()=>{
      assert.equal((await f.request(A.hostname,"GET","/platform/metrics",null,platform)).status,401)
      assert.equal((await f.request("platform.shops.example.test","GET","/platform/metrics",null,owner(A))).status,401)
      await f.request(A.hostname,"GET","/store/products?m6-secret-marker=PRIVATE-M6-TEST",null,owner(A))
      const r=await f.request("platform.shops.example.test","GET","/platform/metrics",null,platform)
      assert.equal(r.status,200);assert.match(r.headers["content-type"],/text\/plain/)
      for(const secret of [f.config.platformKey,f.config.contextSecret,A.ownerToken,"PRIVATE-M6-TEST","m4-browser-buyer@example.test"])assert(!r.raw.toString().includes(secret))
      assert.match(r.raw.toString(),/saas_http_requests_total\{tenant_id="tenant_/)
      assert.match(r.raw.toString(),/saas_http_duration_seconds_bucket/)
      assert.match(r.raw.toString(),/saas_db_pool_waiting [0-9]+/)
    })
    await check("the monitor detects missing/stale workers and recovery using the real authenticated platform API",async()=>{
      const options={baseUrl:`http://127.0.0.1:${f.server.address().port}`,host:"platform.shops.example.test",platformKey:f.config.platformKey,allowLoopback:true}
      const missing=await probe(options);assert(missing.alerts.some(x=>x.code==="WORKER_UNAVAILABLE"));assert.equal(missing.off_host_backup_verified,false)
      await f.app.m5Runtime.workerStarted()
      const running=await probe(options);assert(!running.alerts.some(x=>x.code==="WORKER_UNAVAILABLE"))
      await f.db.query("UPDATE saas_control.worker_heartbeat SET last_seen=now()-interval '1 minute'")
      const stale=await probe(options);assert(stale.alerts.some(x=>x.code==="WORKER_UNAVAILABLE"))
      assert.equal((await f.request("localhost","GET","/health/ready")).status,503)
      assert.equal((await f.request("localhost","GET","/health/live")).status,200)
      await f.app.m5Runtime.workerPulse();const recovered=await probe(options);assert(!recovered.alerts.some(x=>x.code==="WORKER_UNAVAILABLE"))
      assert.equal((await probe({...options,platformKey:"invalid".repeat(8)})).alerts[0].code,"MONITOR_AUTH_FAILED")
      await assert.rejects(probe({...options,allowLoopback:false}),/requires HTTPS/)
    })
    await check("the monitor reports backlog and clears it after the original tenant job actually completes",async()=>{
      const handlers=f.app.m2Runtime.jobs.handlers;handlers.set("m6.alarm.drill",async()=>({delivered:1}))
      const job=await f.inStore(B,()=>f.app.m2Runtime.jobs.enqueue("m6.alarm.drill",{}, {idempotencyKey:"m6-alarm-drill"}))
      await f.db.query("UPDATE saas_control.task_dispatch SET created_at=now()-interval '10 minutes' WHERE id=$1",[job.id])
      const options={baseUrl:`http://127.0.0.1:${f.server.address().port}`,host:"platform.shops.example.test",platformKey:f.config.platformKey,allowLoopback:true}
      assert((await probe(options)).alerts.some(x=>x.code==="QUEUE_BACKLOG"&&x.tenant_id===B.id))
      assert.equal((await f.app.m2Runtime.jobs.processNext({jobId:job.id})).state,"done")
      assert(!(await probe(options)).alerts.some(x=>x.code==="QUEUE_BACKLOG"&&x.tenant_id===B.id))
    })
    await check("old uncertain refunds without a known remote ID cannot issue a new vendor refund",async()=>{
      const order=f.ok(await f.request(A.hostname,"GET",`/admin/orders/${A.orderId}`,null,owner(A))).order
      const payment=order.payment_collections[0].payments[0]
      const mutation=(suffix,body,key)=>f.request(A.hostname,"POST",`/admin/payments/${payment.id}/${suffix}`,body,{...owner(A),"idempotency-key":key})
      f.ok(await mutation("capture",{},"m6-old-refund-capture"))
      stripe.pendNextRefund("alpha");assert.equal((await mutation("refund",{amount:5},"m6-old-refund-unknown")).status,500)
      const operation=(await f.db.query("SELECT id FROM saas_payment_operation WHERE tenant_id=$1 AND idempotency_key=$2",[A.id,"m6-old-refund-unknown"])).rows[0]
      const priorCalls=stripe.calls.filter(c=>c.method==="POST"&&c.path==="/v1/refunds").length
      await f.db.query("UPDATE saas_payment_effect SET remote_id=NULL,created_at=now()-interval '25 hours' WHERE tenant_id=$1 AND operation_id=$2",[A.id,operation.id])
      const retry=await f.request(A.hostname,"POST",`/admin/saas/operations/${operation.id}/retry`,{},owner(A))
      assert.equal(retry.status,409);assert.equal(stripe.calls.filter(c=>c.method==="POST"&&c.path==="/v1/refunds").length,priorCalls)
    })
    complete=true
  }finally{
    if(secondary)await secondary.close();if(f)await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M6_TRANSACTION_RESULT)fs.writeFileSync(process.env.SAAS_M6_TRANSACTION_RESULT,JSON.stringify({milestone:"M6",complete,passed:checks.length,checks,checkout,
      notificationsSent:false,drill:"local authenticated metrics/alert observation; no production pager/notification delivery"},null,2)+"\n")
  }
})
