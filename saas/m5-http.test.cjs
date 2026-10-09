"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto")
const Stripe=require("stripe"),jwt=require("jsonwebtoken")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs")
const {seedM4Browser}=require("./m4-browser-seed.cjs"),{tenantSQL}=require("./tenant-sql.cjs")
const {migrateM5,verifyM5Runtime}=require("./migrate-m5.cjs"),{maintenanceLock}=require("./m5-policy.cjs")
test("M5 tenant operations, atomic quotas, pause, recovery and worker acceptance",{timeout:240000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"medusa-m5-http-")),stripe=await createStripeFixture(),checks=[]
  let f,complete=false
  const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log("PASS",name)}
  try {
    f=await createFixture({payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    const [A,B]=f.tenants,owner=t=>({authorization:`Bearer ${t.ownerToken}`}),platform={authorization:`Bearer ${f.config.platformKey}`}
    const call=async(t,method,url,body,headers=owner(t))=>f.ok(await f.request(t.hostname,method,url,body,headers))
    const platformCall=async(method,url,body)=>f.ok(await f.request("platform.shops.example.test",method,url,body,platform))
    const state=t=>call(t,"GET","/admin/saas/operations")
    const plan=async(t,overrides)=>{
      const shops=await platformCall("GET","/platform/tenants"),row=shops.tenants.find(x=>x.id===t.id)
      return platformCall("POST",`/platform/tenants/${t.id}/plan`,{plan_id:"pilot",expected_version:row.version,product_limit:row.product_limit,
        upload_limit_bytes:Number(row.upload_limit_bytes),requests_per_minute:row.requests_per_minute,...overrides})
    }
    const status=(t,value)=>platformCall("POST",`/platform/tenants/${t.id}/status`,{status:value})
    const mutate=(t,url,body,key)=>call(t,"POST",url,body,{...owner(t),"idempotency-key":key})
    const verify=async()=>{const c=await f.app.pool.connect();try{await verifyM5Runtime(c)}finally{c.release()}}
    await check("M5 additive migration replays, verifies RLS and least-privilege metadata",async()=>{
      assert((await migrateM5(f.db,{applicationRole:"medusa_saas_m5_app",allowNativeReferenceSeeds:true,objectRoot:f.config.objectRoot})).every(x=>!x.applied))
      await verify()
      assert.equal((await f.db.query("SELECT count(*)::int n FROM pg_class WHERE relrowsecurity AND relforcerowsecurity")).rows[0].n,140)
      assert.equal((await f.app.pool.query("SELECT count(*)::int n FROM saas_ops_audit")).rows[0].n,0)
      await assert.rejects(f.app.pool.query("UPDATE saas_control.tenant_usage SET product_count=0"),/permission denied/)
      await assert.rejects(f.app.pool.query("DELETE FROM saas_ops_audit"),/permission denied/)
      await assert.rejects(require("./m1-application.cjs").createM1Application({...f.config,operations:false}),/M5 database requires/)
    })
    await check("disabled quota triggers and modified privileged function bodies fail startup verification",async()=>{
      await f.db.query("ALTER TABLE product DISABLE TRIGGER saas_m5_product_quota")
      try{await assert.rejects(verify,/quota trigger|schema.*drift/)}finally{await f.db.query("ALTER TABLE product ENABLE TRIGGER saas_m5_product_quota")}
      const definition=(await f.db.query("SELECT pg_get_functiondef('saas_control.clean_ephemeral()'::regprocedure) sql")).rows[0].sql
      await f.db.query(definition.replace("RETURN jsonb_build_object","PERFORM 1; RETURN jsonb_build_object"))
      try{await assert.rejects(verify,/function security drift/)}finally{await f.db.query(definition)}
      await verify()
    })
    await check("quota CHECK and ownership foreign-key drift are detected despite an unchanged ledger",async()=>{
      for(const name of ['plan_assignment_product_limit_check','plan_assignment_tenant_id_fkey']) {
        const definition=(await f.db.query("SELECT pg_get_constraintdef(oid) sql FROM pg_constraint WHERE conname=$1 AND conrelid='saas_control.plan_assignment'::regclass",[name])).rows[0].sql
        await f.db.query(`ALTER TABLE saas_control.plan_assignment DROP CONSTRAINT ${name}`)
        try{await assert.rejects(verify,/schema.*drift/)}finally{await f.db.query(`ALTER TABLE saas_control.plan_assignment ADD CONSTRAINT ${name} ${definition}`)}
      }
      await verify()
    })
    await check("platform console and metadata require the platform Host and persisted operator",async()=>{
      const list=await platformCall("GET","/platform/tenants");assert.equal(list.count,2)
      assert(list.tenants.every(x=>x.plan_id==="pilot"&&!('owner_actor_id'in x)))
      for(const headers of [{},owner(A)])assert.equal((await f.request("platform.shops.example.test","GET","/platform/tenants",null,headers)).status,401)
      assert.equal((await f.request(A.hostname,"GET","/platform/tenants",null,platform)).status,401)
      assert.equal((await f.request("platform.shops.example.test","GET","/admin/orders",null,platform)).status,404)
      assert.equal((await f.request("platform.shops.example.test","GET","/platform")).status,200)
      assert.equal((await f.request(A.hostname,"GET","/platform")).status,404)
      await f.db.query("UPDATE saas_control.platform_identity SET status='revoked' WHERE actor_id=$1",[f.config.platformActorId])
      try{assert.equal((await f.request("platform.shops.example.test","GET","/platform/tenants",null,platform)).status,401)}
      finally{await f.db.query("UPDATE saas_control.platform_identity SET status='active' WHERE actor_id=$1",[f.config.platformActorId])}
    })
    await f.seedCommerce()
    await check("manual plan updates require current version and cannot go below usage",async()=>{
      const updated=await plan(A,{product_limit:2,upload_limit_bytes:16});assert.equal(updated.plan.version,2)
      const stale=await f.request("platform.shops.example.test","POST",`/platform/tenants/${A.id}/plan`,{plan_id:"pilot",expected_version:1,product_limit:2,upload_limit_bytes:16,requests_per_minute:1200},platform)
      assert.equal(stale.status,409)
      assert.equal((await f.request(A.hostname,"POST",`/platform/tenants/${A.id}/plan`,{},owner(A))).status,401)
    })
    let extra
    await check("concurrent native product inserts cannot exceed the tenant quota",async()=>{
      const responses=await Promise.all(["quota-one","quota-two"].map(handle=>f.request(A.hostname,"POST","/admin/products",{title:handle,handle,status:"draft",options:[{title:"Size",values:["One"]}],variants:[{title:"One",manage_inventory:false,options:{Size:"One"},prices:[{amount:1,currency_code:"usd"}]}]},owner(A))))
      assert.deepEqual(responses.map(x=>x.status).sort(),[200,409],JSON.stringify(responses.map(x=>x.body)));extra=responses.find(x=>x.status===200).body.product
      assert.equal((await state(A)).quota.product_count,"2");assert.equal((await state(B)).quota.product_count,"1")
      await assert.rejects(plan(A,{product_limit:1}),/quota/)
    })
    await check("soft deletion frees capacity and native restoration is also quota checked",async()=>{
      await call(A,"DELETE",`/admin/products/${extra.id}`)
      assert.equal((await state(A)).quota.product_count,"1")
      const other=(await call(A,"POST","/admin/products",{title:"replacement",handle:"quota-replacement",status:"draft",options:[{title:"Size",values:["One"]}],variants:[{title:"One",manage_inventory:false,options:{Size:"One"},prices:[{amount:1,currency_code:"usd"}]}]})).product
      await assert.rejects(f.inStore(A,()=>f.app.nativeApp.modules.product.restoreProducts([extra.id])),/quota/i)
      await call(A,"DELETE",`/admin/products/${other.id}`)
      await f.inStore(A,()=>f.app.nativeApp.modules.product.restoreProducts([extra.id]))
      assert.equal((await state(A)).quota.product_count,"2")
    })
    let uploaded
    const upload=async(t,name)=>{
      const boundary="m5-owned-upload-boundary",image=Buffer.from([137,80,78,71,13,10,26,10])
      const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}.png"\r\nContent-Type: image/png\r\n\r\n`),image,Buffer.from(`\r\n--${boundary}--\r\n`)])
      return f.request(t.hostname,"POST","/admin/uploads",body,{...owner(t),"content-type":`multipart/form-data; boundary=${boundary}`})
    }
    await check("concurrent byte reservations charge ready files without exceeding upload caps",async()=>{
      const responses=await Promise.all(["one","two","three"].map(name=>upload(A,name)))
      assert.deepEqual(responses.map(x=>x.status).sort(),[200,200,409]);uploaded=responses.filter(x=>x.status===200).map(x=>x.body.files[0])
      assert.equal((await state(A)).quota.upload_bytes,"16")
      assert.equal((await state(B)).quota.upload_bytes,"0")
      const rows=(await f.db.query("SELECT byte_size,content_hash,storage_state FROM saas_file WHERE tenant_id=$1",[A.id])).rows
      assert(rows.every(x=>x.byte_size==='8'&&x.content_hash.length===64&&x.storage_state==='ready'))
      const foreignId='file_'+'c'.repeat(40),foreignPath=crypto.createHash('sha256').update(B.id).digest('hex')+'/'+foreignId
      await assert.rejects(f.inStore(A,()=>tenantSQL(f.app.pool,c=>c.query("INSERT INTO saas_file(id,storage_key,filename,mime_type,byte_size,storage_state,content_hash) VALUES($1,$2,'foreign','image/png',0,'pending',$3)",[foreignId,foreignPath,'c'.repeat(64)]))),/saas_m5_file_namespace/)
      assert.equal((await state(A)).quota.upload_bytes,'16')
    })
    await check("file deletion frees bytes and failed disk writes retain accurate accounting",async()=>{
      await call(A,"DELETE",`/admin/uploads/${uploaded[0].id}`);assert.equal((await state(A)).quota.upload_bytes,"8")
      assert.equal((await f.request(B.hostname,"DELETE",`/admin/uploads/${uploaded[1].id}`,null,owner(B))).status,404)
      const directoryPath=path.join(f.config.objectRoot,crypto.createHash("sha256").update(B.id).digest("hex"))
      fs.mkdirSync(path.dirname(directoryPath),{recursive:true});fs.writeFileSync(directoryPath,"fixture-blocker")
      try{assert.equal((await upload(B,"failure")).status,500);assert.equal((await state(B)).quota.upload_bytes,"8")}
      finally{fs.unlinkSync(directoryPath)}
      await f.db.query("UPDATE saas_file SET created_at=now()-interval '2 hours' WHERE tenant_id=$1 AND storage_state='pending'",[B.id])
      await f.inStore(B,()=>f.app.m2Runtime.resources.file.sweep());assert.equal((await state(B)).quota.upload_bytes,"0")
    })
    const {buyer}=await seedM4Browser(f,stripe)
    const paymentOf=async t=>(await call(t,"GET",`/admin/orders/${t.orderId}?fields=${encodeURIComponent('id,status,*payment_collections,*payment_collections.payments,*payment_collections.payments.captures,*payment_collections.payments.refunds,*items,*fulfillments')}`)).order.payment_collections[0].payments[0]
    const paymentA=await paymentOf(A),paymentB=await paymentOf(B)
    await mutate(A,`/admin/payments/${paymentA.id}/capture`,{},"m5-capture-before-pause")
    let pendingCart,pendingIntent,customerHeaders
    await check("pre-pause checkout can be prepared without acquiring a paid order",async()=>{
      customerHeaders={authorization:`Bearer ${(await call(A,"POST","/auth/customer/emailpass",buyer,{})).token}`}
      const address={first_name:"M5",last_name:"Buyer",address_1:"1 Test St",city:"Boston",postal_code:"02110",country_code:"us"}
      pendingCart=(await call(A,"POST","/store/carts",{region_id:A.region.id,items:[{variant_id:A.product.variants[0].id,quantity:1}],shipping_address:address,billing_address:address},
        {...customerHeaders,"idempotency-key":"m5-pending-cart"})).cart
      await call(A,"POST",`/store/carts/${pendingCart.id}/shipping-methods`,{option_id:A.shipping.id},customerHeaders)
      const collection=(await call(A,"POST","/store/payment-collections",{cart_id:pendingCart.id},customerHeaders)).payment_collection
      const session=(await call(A,"POST",`/store/payment-collections/${collection.id}/payment-sessions`,{provider_id:"pp_stripe_saas"},customerHeaders)).payment_collection.payment_sessions[0]
      pendingIntent=(await f.db.query("SELECT intent_id FROM saas_payment_binding WHERE tenant_id=$1 AND id=$2",[A.id,session.id])).rows[0].intent_id
      stripe.confirm("alpha",pendingIntent)
    })
    await check("pause blocks new checkout, product writes and collection while sibling shop remains active",async()=>{
      await status(A,"suspended");assert.equal((await state(A)).status,"suspended")
      for(const [url,body,headers] of [["/store/carts",{},customerHeaders],[`/store/carts/${pendingCart.id}/complete`,{}, {...customerHeaders,"idempotency-key":"m5-paused-complete"}],
        ["/admin/products",{title:"blocked"},owner(A)],[`/admin/payments/${paymentA.id}/capture`,{}, {...owner(A),"idempotency-key":"m5-paused-capture"}],
        ["/admin/saas/payments",stripe.config("alpha"),owner(A)]])assert.equal((await f.request(A.hostname,"POST",url,body,headers)).status,423,url)
      await mutate(B,`/admin/payments/${paymentB.id}/capture`,{},"m5-bravo-remains-active")
      assert.equal((await state(B)).status,"active")
    })
    await check("paused native owner authentication and audit work without accepting sibling identities",async()=>{
      const login=await call(A,"POST","/auth/user/emailpass",f.credentials,{})
      assert(login.token)
      assert.equal((await f.request(A.hostname,"GET","/admin/saas/operations",null,owner(B))).status,401)
      assert.equal((await call(A,"GET","/admin/products")).count,2)
      assert((await call(A,"GET","/admin/saas/audit")).events.length>0)
    })
    await check("paid order fulfillment and shipment remain available while paused",async()=>{
      const order=(await call(A,"GET",`/admin/orders/${A.orderId}`)).order
      const result=await mutate(A,`/admin/orders/${A.orderId}/fulfillments`,{items:[{id:order.items[0].id,quantity:1}],location_id:A.location.id},"m5-paused-fulfill")
      const fid=result.order.fulfillments[0].id
      await mutate(A,`/admin/orders/${A.orderId}/fulfillments/${fid}/shipments`,{items:[{id:order.items[0].id,quantity:1}]} ,"m5-paused-ship")
      const stored=(await f.db.query("SELECT payload FROM saas_payment_operation WHERE tenant_id=$1 AND idempotency_key='m5-paused-ship'",[A.id])).rows[0]
      assert.equal(stored.payload._fulfillment_id,fid)
    })
    let failedOperation
    await check("pending refunds remain recoverable after pause and process restart",async()=>{
      stripe.pendNextRefund("alpha")
      const pending=await f.request(A.hostname,"POST",`/admin/payments/${paymentA.id}/refund`,{amount:5},{...owner(A),"idempotency-key":"m5-paused-refund"})
      assert.notEqual(pending.status,200)
      failedOperation=(await state(A)).operations.find(x=>x.kind==='refund');assert(failedOperation)
      assert.equal((await f.request(B.hostname,"POST",`/admin/saas/operations/${failedOperation.id}/retry`,{},owner(B))).status,404)
      stripe.settleRefunds("alpha");await f.restart()
      await call(A,"POST",`/admin/saas/operations/${failedOperation.id}/retry`,{})
      await call(A,"POST",`/admin/saas/operations/${failedOperation.id}/retry`,{})
      assert.equal((await paymentOf(A)).refunds.length,1)
      assert.equal(stripe.calls.filter(x=>x.path==='/v1/refunds'&&x.method==='POST'&&x.account==='acct_alphaalphaalpha').length,1)
    })
    const hook=async(t,event)=>{
      const config=(await call(t,"GET","/admin/saas/payments")).payment,body=Buffer.from(JSON.stringify(event))
      return f.request(t.hostname,"POST",new URL(config.webhook_url).pathname,body,{"stripe-signature":Stripe.webhooks.generateTestHeaderString({payload:body.toString(),secret:stripe.config(t.slug).webhook_secret})})
    }
    await check("signed paused callbacks reconcile existing orders but cannot create a new order",async()=>{
      const before=(await f.db.query('SELECT count(*)::int n FROM "order" WHERE tenant_id=$1',[A.id])).rows[0].n
      const intent=stripe.intent("alpha",pendingIntent)
      const response=f.ok(await hook(A,{id:"evt_m5pausedcheckout",type:"payment_intent.amount_capturable_updated",livemode:false,data:{object:intent}}))
      assert.equal(response.reason,"paused_new_checkout");assert.equal(response.review_required,true)
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "order" WHERE tenant_id=$1',[A.id])).rows[0].n,before)
      const bound=(await f.db.query("SELECT intent_id FROM saas_payment_binding WHERE tenant_id=$1 AND id=$2",[A.id,paymentA.payment_session_id])).rows[0]
      const normal=f.ok(await hook(A,{id:"evt_m5pausedexisting",type:"payment_intent.succeeded",livemode:false,data:{object:stripe.intent("alpha",bound.intent_id)}}))
      assert(normal.processed)
      assert([400,404].includes((await hook(B,{id:"evt_m5wrongmerchant",type:"payment_intent.succeeded",livemode:false,data:{object:stripe.intent("alpha",bound.intent_id)}})).status))
    })
    await check("paused cancellation refunds a captured order and releases inventory",async()=>{
      await status(B,"suspended");await mutate(B,`/admin/orders/${B.orderId}/cancel`,{},"m5-paused-cancel")
      const p=(await call(B,"GET",`/admin/orders/${B.orderId}?fields=${encodeURIComponent('id,status,*payment_collections,*payment_collections.payments,*payment_collections.payments.refunds')}`)).order
      assert.equal(p.status,"canceled");assert.equal(p.payment_collections[0].payments[0].refunds.length,1)
      const levels=await call(B,"GET",`/admin/inventory-items/${B.inventoryId}/location-levels`)
      assert.equal(levels.inventory_levels[0].reserved_quantity,0)
      await status(B,"active");await status(A,"active")
    })
    await check("tenant and authentication rate windows are atomic and do not accept forwarding bypasses",async()=>{
      await plan(A,{requests_per_minute:10})
      await f.db.query("DELETE FROM saas_control.rate_window WHERE scope=$1",[`tenant:${A.id}`])
      const responses=await Promise.all(Array.from({length:15},()=>f.request(A.hostname,"GET","/store/settings")))
      assert.equal(responses.filter(x=>x.status===200).length,10);assert.equal(responses.filter(x=>x.status===429).length,5)
      assert.equal((await f.request(B.hostname,"GET","/store/settings")).status,200)
      await f.db.query("DELETE FROM saas_control.rate_window WHERE scope=$1",[`tenant:${A.id}`]);await plan(A,{requests_per_minute:1200})
      const bad=await f.request(A.hostname,"POST","/auth/user/emailpass",{email:"nobody@example.test",password:"REDACTION_SENTINEL_674936"},{"x-forwarded-host":B.hostname})
      assert.equal(bad.status,400)
      await f.db.query("DELETE FROM saas_control.rate_window WHERE scope LIKE $1",[`auth:${A.id}:%`])
      for(let i=0;i<21;i++) {
        const response=await f.request(A.hostname,"POST","/auth/user/emailpass",{email:"nobody@example.test",password:"REDACTION_SENTINEL_674936"})
        assert.equal(response.status,i===20?429:401)
      }
    })
    await check("tenant audits are append only, redact bodies and include server-generated request IDs",async()=>{
      const events=(await call(A,"GET","/admin/saas/audit?limit=100")).events
      assert(events.some(x=>x.status===423));assert(events.every(x=>/^[a-f0-9-]{36}$/.test(x.request_id)))
      assert(!JSON.stringify(events).includes("REDACTION_SENTINEL"));assert(!JSON.stringify(events).includes(f.config.paymentKey))
      const rows=await f.inStore(A,()=>tenantSQL(f.app.pool,c=>c.query("SELECT DISTINCT tenant_id FROM saas_ops_audit")))
      assert.deepEqual(rows.rows.map(x=>x.tenant_id),[A.id])
    })
    await check("health separates API, DB and worker, and stale heartbeat fails readiness",async()=>{
      assert.equal((await f.request("localhost","GET","/health/live")).status,200)
      const missing=await f.request("localhost","GET","/health/ready");assert.equal(missing.status,503);assert.deepEqual(missing.body.checks,{api:true,database:true,worker:false})
      await f.app.m5Runtime.workerStarted();assert.equal((await f.request("localhost","GET","/health")).status,200)
      await f.db.query("UPDATE saas_control.worker_heartbeat SET last_seen=now()-interval '1 minute'")
      assert.equal((await f.request("localhost","GET","/health/ready")).status,503);await f.app.m5Runtime.workerPulse()
    })
    await check("fair dispatch services another tenant before draining a noisy tenant",async()=>{
      await f.db.query("UPDATE saas_control.task_dispatch SET available_at=now()+interval '1 day' WHERE state='pending'")
      f.app.m2Runtime.jobs.handlers.set("m5.probe",async()=>({tenant:require('./tenant-context.cjs').currentTenant().tenantId}))
      for(let n=0;n<3;n++)await f.inStore(A,()=>f.app.m2Runtime.jobs.enqueue("m5.probe",{number:n},{idempotencyKey:`m5-fair-${n}`}))
      await f.inStore(B,()=>f.app.m2Runtime.jobs.enqueue("m5.probe",{number:1},{idempotencyKey:"m5-fair-bravo"}))
      await f.db.query("UPDATE saas_control.queue_schedule SET last_served_at=NULL")
      const served=[];for(let n=0;n<4;n++)served.push((await f.app.m2Runtime.jobs.processNext()).result.tenant)
      assert(new Set(served.slice(0,2)).size===2);assert.equal(served.filter(x=>x===B.id).length,1)
    })
    await check("unknown non-event job kinds do not acquire fallback handlers",async()=>{
      const name='m5.disabled-command';f.app.m2Runtime.jobs.handlers.set(name,async()=>({}))
      const job=await f.inStore(A,()=>f.app.m2Runtime.jobs.enqueue(name,{safe:true},{idempotencyKey:'m5-disabled-command'}))
      f.app.m2Runtime.jobs.handlers.delete(name)
      const result=await f.app.m2Runtime.jobs.processNext({jobId:job.id})
      assert.equal(result.state,'failed');assert.equal(result.error,'TENANT_JOB_HANDLER_DISABLED')
    })
    await check("paused ordinary jobs defer without losing their retry budget",async()=>{
      const job=await f.inStore(A,()=>f.app.m2Runtime.jobs.enqueue("m5.probe",{number:4},{idempotencyKey:"m5-paused-job"}))
      await status(A,"suspended")
      const deferred=await f.app.m2Runtime.jobs.processNext({jobId:job.id});assert.equal(deferred.state,"pending");assert.equal(deferred.error,"TENANT_PAUSED_JOB")
      assert.equal((await f.db.query("SELECT attempts FROM saas_control.task_dispatch WHERE id=$1",[job.id])).rows[0].attempts,0)
      await status(A,"active");await f.db.query("UPDATE saas_control.task_dispatch SET available_at=now() WHERE id=$1",[job.id])
      assert.equal((await f.app.m2Runtime.jobs.processNext({jobId:job.id})).state,"done")
    })
    await check("queue caps reserve capacity for verified payment events",async()=>{
      const active=(await f.db.query("SELECT count(*)::int n FROM saas_control.task_dispatch WHERE tenant_id=$1 AND state IN ('pending','blocked','running')",[A.id])).rows[0].n
      await f.db.query("INSERT INTO saas_control.task_dispatch(id,tenant_id,envelope,state,kind) SELECT 'job_m5quota'||g,$1,'not-executed-fixture','blocked','m5.probe' FROM generate_series(1,$2) g",[A.id,1000-active])
      try {
        await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.jobs.enqueue("m5.probe",{number:8},{idempotencyKey:"m5-queue-excess"})),/queue limit/)
        const callback=await f.inStore(A,()=>f.app.m2Runtime.jobs.enqueue("m4.stripe.event",{event:{}},{idempotencyKey:"m5-reserved-capacity",blocked:true}))
        assert(callback.id)
        await f.inStore(A,()=>f.app.m2Runtime.jobs.cancelGroup("unused"))
        await f.db.query("DELETE FROM saas_control.task_dispatch WHERE id=$1",[callback.id])
        await f.db.query("DELETE FROM saas_job WHERE id=$1",[callback.id])
      } finally {await f.db.query("DELETE FROM saas_control.task_dispatch WHERE id LIKE 'job_m5quota%'")}
    })
    await check("backup maintenance gate blocks writes and workers while reads stay available",async()=>{
      const c=await f.db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[maintenanceLock]);assert(c.rows[0].ok)
      try {
        assert.equal((await f.request(B.hostname,"POST","/admin/products",{title:"maintenance"},owner(B))).status,503)
        await assert.rejects(f.app.m2Runtime.jobs.processNext(),/Maintenance/)
        assert.equal((await f.request(B.hostname,"GET","/admin/orders",null,owner(B))).status,200)
      }finally{await f.db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[maintenanceLock])}
    })
    await check("client disconnect keeps the backup fence until the actual platform mutation settles",async()=>{
      const http=require('node:http')
      await f.db.query('BEGIN')
      await f.db.query('SELECT id FROM saas_control.tenant WHERE id=$1 FOR UPDATE',[B.id])
      const body=Buffer.from(JSON.stringify({status:'active'}))
      const request=http.request({hostname:'127.0.0.1',port:f.server.address().port,method:'POST',path:`/platform/tenants/${B.id}/status`,
        headers:{host:'platform.shops.example.test',...platform,'content-type':'application/json','content-length':body.length}})
      let earlyStatus
      request.on('response',response=>{earlyStatus=response.statusCode;response.resume()})
      request.on('error',()=>{});request.end(body)
      try {
        let blocked=false
        for(let n=0;n<500;n++) {
          // pg_stat_activity snapshots are cached inside this lock-holding
          // transaction; refresh the observer rather than reusing its first view.
          await f.db.query('SELECT pg_stat_clear_snapshot()')
          blocked=(await f.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='medusa_saas_m5_app' AND wait_event_type='Lock' AND query LIKE 'UPDATE saas_control.tenant SET status=%'")).rowCount>0
          if(blocked)break
          if(earlyStatus)throw new Error('Platform request returned before fault barrier: HTTP '+earlyStatus)
          await new Promise(resolve=>setTimeout(resolve,10))
        }
        assert(blocked,'Actual platform status SQL must reach the held tenant row')
        request.destroy();await new Promise(resolve=>setTimeout(resolve,30))
        assert.equal((await f.db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[maintenanceLock])).rows[0].ok,false)
      }finally{await f.db.query('COMMIT');request.destroy()}
      let released=false
      for(let n=0;n<50;n++) {
        if((await f.db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[maintenanceLock])).rows[0].ok) {
          released=true;await f.db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[maintenanceLock]);break
        }
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      assert(released,'Completed workflow must release the backup fence')
    })
    await check("bounded maintenance clears expired state while preserving uncertain payment recovery",async()=>{
      await f.inStore(A,async()=>{
        await f.app.m2Runtime.resources.cache.set("old-cache",{safe:true},1)
        await tenantSQL(f.app.pool,c=>c.query("UPDATE saas_cache SET expires_at=now()-interval '1 day' WHERE id='old-cache'"))
        await tenantSQL(f.app.pool,c=>c.query("INSERT INTO saas_file(id,storage_key,filename,mime_type,byte_size,storage_state,content_hash) VALUES($1,$2,'pending','image/png',4,'pending',$3)",["file_"+"a".repeat(40),crypto.createHash("sha256").update(A.id).digest("hex")+"/file_"+"a".repeat(40),"a".repeat(64)]))
      })
      await f.db.query("UPDATE saas_file SET created_at=now()-interval '2 hours' WHERE id=$1",["file_"+"a".repeat(40)])
      const before=(await f.db.query("SELECT count(*)::int n FROM workflow_execution")).rows[0].n
      await f.app.m5Runtime.maintenance()
      assert.equal((await state(A)).quota.upload_bytes,"8")
      assert.equal((await f.db.query("SELECT count(*)::int n FROM workflow_execution")).rows[0].n,before)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_cache WHERE id='old-cache'")).rows[0].n,0)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_payment_operation WHERE id=$1",[failedOperation.id])).rows[0].n,1)
    })
    await check("large expired cache and lock collections are reclaimed in bounded tenant-only batches",async()=>{
      await f.inStore(A,async()=>{
        await tenantSQL(f.app.pool,c=>c.query("INSERT INTO saas_cache(id,value,expires_at) SELECT 'm5-expired-cache-'||g,'{}'::jsonb,now()-interval '1 day' FROM generate_series(1,1100) g"))
        await tenantSQL(f.app.pool,c=>c.query("INSERT INTO saas_lock(id,owner_id,expires_at) SELECT 'm5-expired-lock-'||g,'fixture',now()-interval '1 day' FROM generate_series(1,1100) g"))
      })
      await f.inStore(B,()=>tenantSQL(f.app.pool,c=>c.query("INSERT INTO saas_cache(id,value,expires_at) VALUES('m5-sibling-expired','{}',now()-interval '1 day')")))
      const clean=()=>f.inStore(A,()=>tenantSQL(f.app.pool,async c=>(await c.query('SELECT saas_control.clean_tenant_ephemeral() result')).rows[0].result))
      const first=await clean();assert.equal(first.caches,1000);assert.equal(first.locks,1000)
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_cache WHERE id='m5-sibling-expired'")).rows[0].n,1)
      const second=await clean();assert.equal(second.caches,100);assert.equal(second.locks,100)
    })
    await check("platform monitoring returns queue alerts without customer or financial data",async()=>{
      const ops=await platformCall("GET","/platform/operations")
      assert(ops.health.checks.database);assert(Array.isArray(ops.queue));assert(Array.isArray(ops.alerts))
      assert(!JSON.stringify(ops).includes(buyer.email));assert(!JSON.stringify(ops).includes(paymentA.id))
    })
    complete=true
  } finally {
    if(f)await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M5_RESULT)fs.writeFileSync(process.env.SAAS_M5_RESULT,JSON.stringify({milestone:"M5",success:complete,passed:checks.length,checks},null,2))
  }
})
