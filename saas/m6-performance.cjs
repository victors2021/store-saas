"use strict"
// Destructive only to the marked owned loopback m5_perf fixture. Never accept a
// caller-provided DB URL. Real SDK/provider traffic uses the owned fixture.
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict"),{performance}=require("node:perf_hooks")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs"),{seedM4Browser}=require("./m4-browser-seed.cjs"),{tenantSQL}=require("./tenant-sql.cjs")
const {providerId}=require("./m4-payment.cjs")
const {startBenchmarkProcess}=require("./m6-benchmark-process.cjs")
const ORDINARY_P95_MS=300
const slugs=["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel","india","juliet"]
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null}
const readLimit=p=>{try{return fs.readFileSync(p,"utf8").trim()}catch{return null}}
function snapshot(){return {at:new Date().toISOString(),rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,
  cgroupMemory:readLimit("/sys/fs/cgroup/memory.current"),cpuUsage:process.cpuUsage(),load:os.loadavg()}}
async function makeCart(f,t,stripe,key,{stock=false,payment=false}={}) {
  const auth={authorization:`Bearer ${t.customerToken}`},address={first_name:"M6",last_name:"Benchmark",address_1:"1 Test St",city:"Boston",postal_code:"02110",country_code:"us"}
  const call=async(method,url,body,extra={})=>f.ok(await f.request(t.hostname,method,url,body,{...auth,...extra}))
  const cart=(await call("POST","/store/carts",{region_id:t.region.id,email:"m4-browser-buyer@example.test",
    items:[{variant_id:t.product.variants[stock?0:1].id,quantity:1}],shipping_address:address,billing_address:address},{"idempotency-key":key})).cart
  if(payment){
    await call("POST",`/store/carts/${cart.id}/shipping-methods`,{option_id:t.shipping.id})
    const collection=(await call("POST","/store/payment-collections",{cart_id:cart.id})).payment_collection
    const sessions=(await call("POST",`/store/payment-collections/${collection.id}/payment-sessions`,{provider_id:providerId})).payment_collection.payment_sessions
    const binding=(await f.db.query("SELECT intent_id FROM saas_payment_binding WHERE tenant_id=$1 AND id=$2",[t.id,sessions[0].id])).rows[0]
    stripe.confirm(t.slug,binding.intent_id)
  }
  return cart
}
async function historicalOrders(f,t,count) {
  // Native order, line, totals, address and shipping shapes copied from a real
  // workflow-produced order. No fabricated provider effect/binding is copied.
  // This history profile excludes historical payment/fulfillment event ledgers.
  const tables=["order_address","order","order_line_item","order_item","order_summary","order_shipping_method","order_shipping"]
  await f.inStore(t,()=>tenantSQL(f.app.pool,async c=>{
    const source=await c.query('SELECT * FROM "order" WHERE id=$1',[t.orderId]),order=source.rows[0]
    const itemIds=(await c.query("SELECT item_id FROM order_item WHERE order_id=$1",[t.orderId])).rows.map(x=>x.item_id)
    const shippingIds=(await c.query("SELECT shipping_method_id FROM order_shipping WHERE order_id=$1",[t.orderId])).rows.map(x=>x.shipping_method_id)
    const rows={order:source.rows}
    rows.order_address=(await c.query("SELECT * FROM order_address WHERE id=ANY($1::text[])",[[...new Set([order.shipping_address_id,order.billing_address_id].filter(Boolean))]])).rows
    rows.order_line_item=(await c.query("SELECT * FROM order_line_item WHERE id=ANY($1::text[])",[itemIds])).rows
    rows.order_shipping_method=(await c.query("SELECT * FROM order_shipping_method WHERE id=ANY($1::text[])",[shippingIds])).rows
    for(const table of ["order_item","order_summary","order_shipping"])rows[table]=(await c.query(`SELECT * FROM "${table}" WHERE order_id=$1`,[t.orderId])).rows
    const ids=new Set(Object.values(rows).flat().map(x=>x.id))
    for(const table of tables)for(const row of rows[table]){
      const replacements=Object.entries(row).filter(([k,v])=>typeof v==="string"&&ids.has(v)).flatMap(([k,v])=>[`'${k}'`,`'${v}'||'M6'||g.n`])
      if(table==="order")replacements.push("'display_id'","nextval('order_display_id_seq')","'status'","'completed'")
      replacements.push("'created_at'","now()-g.n*interval '1 minute'","'updated_at'","now()-g.n*interval '1 minute'")
      // Identifiers originate only from the fixed table list and generated
      // native IDs. Values are parameters except verified alphanumeric IDs.
      if([...ids].some(id=>! /^[A-Za-z0-9_]+$/.test(id)))throw new Error("Unexpected native fixture identifier")
      await c.query(`INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",$1::jsonb||jsonb_build_object(${replacements.join(",")}))).* FROM generate_series(2,$2) g(n)`,[JSON.stringify(row),count])
    }
  }))
}
async function catalog(f,t,count){
  // Bulk seed native graph shapes without manufacturing thousands of business
  // events. Live API requests and checkout use the actual gateway/workflows.
  await f.inStore(t,()=>tenantSQL(f.app.pool,async c=>{
    const rows={},get=async(table,where,values)=>(await c.query(`SELECT * FROM "${table}" WHERE ${where}`,values)).rows
    rows.product=await get("product","id=$1",[t.product.id])
    rows.product_product_option=await get("product_product_option","product_id=$1",[t.product.id])
    rows.product_option=await get("product_option","id=ANY($1::text[])",[rows.product_product_option.map(x=>x.product_option_id)])
    rows.product_option_value=await get("product_option_value","option_id=ANY($1::text[])",[rows.product_option.map(x=>x.id)])
    rows.product_variant=await get("product_variant","product_id=$1",[t.product.id])
    rows.product_variant_option=await get("product_variant_option","variant_id=ANY($1::text[])",[rows.product_variant.map(x=>x.id)])
    rows.product_variant_price_set=await get("product_variant_price_set","variant_id=ANY($1::text[])",[rows.product_variant.map(x=>x.id)])
    rows.price_set=await get("price_set","id=ANY($1::text[])",[rows.product_variant_price_set.map(x=>x.price_set_id)])
    rows.price=await get("price","price_set_id=ANY($1::text[])",[rows.price_set.map(x=>x.id)])
    rows.product_sales_channel=await get("product_sales_channel","product_id=$1",[t.product.id])
    rows.product_shipping_profile=await get("product_shipping_profile","product_id=$1",[t.product.id])
    const ids=new Set(Object.values(rows).flat().map(x=>x.id).filter(Boolean))
    if([...ids].some(id=>! /^[A-Za-z0-9_]+$/.test(id)))throw new Error("Unexpected native catalog identifier")
    for(const table of ["product","product_option","product_option_value","product_product_option","product_variant","product_variant_option","price_set","price","product_variant_price_set","product_sales_channel","product_shipping_profile"])
      for(const row of rows[table]){
        const replacement=Object.entries(row).filter(([k,v])=>typeof v==="string"&&ids.has(v)).flatMap(([k,v])=>[`'${k}'`,`'${v}'||'M6'||g.n`])
        if(table==="product")replacement.push("'handle'","'benchmark-'||g.n","'title'",`'${t.slug} Benchmark Product '||g.n`)
        if(table==="product_variant")replacement.push("'sku'",`'${row.id}'||'M6SKU'||g.n`,"'manage_inventory'","false")
        await c.query(`INSERT INTO "${table}" SELECT (jsonb_populate_record(NULL::"${table}",$1::jsonb||jsonb_build_object(${replacement.join(",")}))).* FROM generate_series(2,$2) g(n)`,[JSON.stringify(row),count])
      }
  }))
}
async function seed(f,stripe,products,orders){
  await f.seedCommerce();await seedM4Browser(f,stripe)
  for(const t of f.tenants){
    t.customerToken=f.ok(await f.request(t.hostname,"POST","/auth/customer/emailpass",{email:"m4-browser-buyer@example.test",password:f.credentials.password})).token
    await catalog(f,t,products)
    await historicalOrders(f,t,orders)
    t.activeCart=await makeCart(f,t,stripe,`m6-benchmark-cart-${t.slug}`)
    console.log(JSON.stringify({event:"seeded",tenant:t.slug,products,variants:products*2,orders}))
  }
  const counts=(await f.db.query(`SELECT t.slug,
    (SELECT count(*)::int FROM product p WHERE p.tenant_id=t.id AND p.deleted_at IS NULL) products,
    (SELECT count(*)::int FROM product_variant p WHERE p.tenant_id=t.id AND p.deleted_at IS NULL) variants,
    (SELECT count(*)::int FROM "order" o WHERE o.tenant_id=t.id AND o.deleted_at IS NULL) orders
    FROM saas_control.tenant t ORDER BY t.slug`)).rows
  for(const row of counts){assert.equal(row.products,products);assert.equal(row.variants,products*2);assert.equal(row.orders,orders)}
  await f.db.query("ANALYZE")
  return counts
}
async function conflict(f,stripe){
  const t=f.tenants[0],before=(await f.db.query("SELECT reserved_quantity::float8 reserved FROM inventory_level WHERE tenant_id=$1 AND inventory_item_id=$2",[t.id,t.inventoryId])).rows[0]
  f.ok(await f.request(t.hostname,"POST",`/admin/inventory-items/${t.inventoryId}/location-levels/${t.location.id}`,{stocked_quantity:before.reserved+2},{authorization:`Bearer ${t.ownerToken}`}))
  const carts=[];for(let n=0;n<20;n++)carts.push(await makeCart(f,t,stripe,`m6-conflict-cart-${n}`,{stock:true,payment:true}))
  const results=await Promise.all(carts.map(async(c,n)=>{const start=performance.now();const r=await f.request(t.hostname,"POST",`/store/carts/${c.id}/complete`,{},{authorization:`Bearer ${t.customerToken}`,"idempotency-key":`m6-conflict-complete-${n}`});return {cartId:c.id,status:r.status,code:r.body.code||null,orderId:r.body.order?.id||null,ms:performance.now()-start}}))
  // Subsequent sequential retries settle the accepted jobs; stock exhaustion
  // may be a retryable 409, never a third order or negative stock.
  for(let n=0;n<carts.length;n++)if(!results[n].orderId){const r=await f.request(t.hostname,"POST",`/store/carts/${carts[n].id}/complete`,{},{authorization:`Bearer ${t.customerToken}`,"idempotency-key":`m6-conflict-complete-${n}`});if(r.body.order)results[n].orderId=r.body.order.id;results[n].settledStatus=r.status}
  const created=(await f.db.query("SELECT order_id FROM order_cart WHERE tenant_id=$1 AND cart_id=ANY($2::text[]) AND deleted_at IS NULL",[t.id,carts.map(c=>c.id)])).rows
  const level=(await f.db.query("SELECT stocked_quantity::float8 stocked,reserved_quantity::float8 reserved FROM inventory_level WHERE tenant_id=$1 AND inventory_item_id=$2",[t.id,t.inventoryId])).rows[0]
  assert.ok(created.length<=2);assert.ok(created.length>0);assert.equal(new Set(created.map(o=>o.order_id)).size,created.length);assert.ok(level.reserved<=level.stocked)
  const orphaned=(await f.db.query(`SELECT count(*)::int n FROM "order" o WHERE o.tenant_id=$1 AND o.deleted_at IS NULL
    AND o.id NOT LIKE '%M6%' AND NOT EXISTS(SELECT 1 FROM order_cart oc WHERE oc.tenant_id=o.tenant_id AND oc.order_id=o.id AND oc.deleted_at IS NULL)`,[t.id])).rows[0].n
  assert.equal(orphaned,0,"Checkout compensation must remove unlinked orders, not just release their links")
  console.log(JSON.stringify({event:"checkout-conflict",statuses:Object.fromEntries([...new Set(results.map(r=>r.status))].map(s=>[s,results.filter(r=>r.status===s).length])),codes:[...new Set(results.map(r=>r.code))]}))
  assert.ok(results.every(r=>r.status===200||r.status===409),JSON.stringify(results.map(r=>({status:r.status,code:r.code}))))
  return {concurrent:20,availableStock:2,createdOrders:created.length,level,initial:results,p95Ms:percentile(results.map(x=>x.ms),.95),provider:"owned loopback fixture; real Stripe SDK; no external sandbox"}
}
async function load(f,{duration,rps,products},output){
  const sample=()=>{const primary=snapshot(),others=f.processSamples?.()||[];return {...primary,apiProcesses:[{rss:primary.rss,heapUsed:primary.heapUsed,cpuUsage:primary.cpuUsage},...others],totalApiRss:primary.rss+others.reduce((sum,p)=>sum+p.rss,0)}}
  const start=performance.now(),records=[],samples=[sample()],interval=setInterval(()=>{
    const value=sample(),recent=records.slice(-600);samples.push(value)
    console.log(JSON.stringify({event:"load-progress",elapsedSeconds:Math.round((performance.now()-start)/1000),completed:records.length,rss:value.rss,totalApiRss:value.totalApiRss,
      completedSoFarP95Ms:percentile(records.map(r=>r.ms),.95),recentCompletedP95Ms:percentile(recent.map(r=>r.ms),.95),non2xxSoFar:records.filter(r=>r.status<200||r.status>=300).length}))
  },30000)
  const pending=new Set();let issued=0,maximumInFlight=0
  const request=async(n)=>{
    const tenantIndex=Math.floor(n/20)%f.tenants.length,t=f.tenants[tenantIndex],kind=n%20<16?"browse":n%20<19?"cart":"order"
    let method="GET",url,headers={},body
    if(kind==="browse")url=n%2?`/store/products?limit=12&offset=${Math.floor(n/200)%Math.max(1,products-12)}`:`/store/products/${t.product.id}`
    else if(kind==="cart"){
      headers.authorization=`Bearer ${t.customerToken}`;url=`/store/carts/${t.activeCart.id}`
      if(n%3===0){method="POST";url+=`/line-items/${t.activeCart.items[0].id}`;body={quantity:1}}
    }else{headers.authorization=`Bearer ${t.ownerToken}`;url=n%40===19?"/admin/orders?limit=10&offset=100":`/admin/orders/${t.orderId}`}
    const began=performance.now();let status,code
    try{const response=await (f.loadRequest||f.request)(t.hostname,method,url,body,headers,n);status=response.status;code=response.body.code||null}
    catch{status=0;code="TRANSPORT_FAILED"}
    records.push({n,tenant:t.slug,kind,method,apiProcess:f.processForRequest?.(n)||0,status,code,ms:performance.now()-began,scheduledLagMs:began-start-n*1000/rps})
  }
  try{
    for(;issued<Math.floor(duration*rps);issued++){
      const lag=start+issued*1000/rps-performance.now();if(lag>0)await sleep(lag)
      // Open-loop issue times prevent coordinated omission. A bound reports
      // overload instead of silently slowing offered traffic.
      if(pending.size>=200){records.push({n:issued,kind:"overload",status:0,code:"LOAD_BACKPRESSURE",ms:0});continue}
      const p=request(issued);pending.add(p);p.finally(()=>pending.delete(p));maximumInFlight=Math.max(maximumInFlight,pending.size)
    }
    await Promise.all(pending)
    const remaining=start+duration*1000-performance.now();if(remaining>0)await sleep(remaining)
  }finally{clearInterval(interval);samples.push(sample())}
  const stats=values=>({requests:values.length,p50Ms:percentile(values.map(r=>r.ms),.5),p95Ms:percentile(values.map(r=>r.ms),.95),p99Ms:percentile(values.map(r=>r.ms),.99),
    errors5xx:values.filter(r=>r.status>=500).length,non2xx:values.filter(r=>r.status<200||r.status>=300).length,statuses:Object.fromEntries([...new Set(values.map(r=>r.status))].map(s=>[s,values.filter(r=>r.status===s).length]))})
  const summary={durationSeconds:duration,offeredRps:rps,elapsedSeconds:(performance.now()-start)/1000,maximumInFlight,
    all:stats(records),byKind:Object.fromEntries(["browse","cart","order"].map(k=>[k,stats(records.filter(r=>r.kind===k))])),byTenant:Object.fromEntries(f.tenants.map(t=>[t.slug,stats(records.filter(r=>r.tenant===t.slug))])),
    byProcess:Object.fromEntries([...new Set(records.map(r=>r.apiProcess).filter(p=>p!==undefined))].map(p=>[p,stats(records.filter(r=>r.apiProcess===p))])),
    byOperation:Object.fromEntries(["browse:GET","cart:GET","cart:POST","order:GET"].map(key=>[key,stats(records.filter(r=>`${r.kind}:${r.method}`===key))])),
    maxScheduledLagMs:Math.max(...records.map(r=>r.scheduledLagMs||0)),samples,
    thresholds:{ordinaryP95Ms:ORDINARY_P95_MS,error5xxRate:.01},passed:records.length===duration*rps&&percentile(records.map(r=>r.ms),.95)<=ORDINARY_P95_MS&&records.every(r=>r.status>=200&&r.status<300)}
  fs.writeFileSync(path.join(output,"performance-requests.ndjson"),records.map(r=>JSON.stringify(r)).join("\n")+"\n")
  return summary
}
async function main(){
  if(process.env.SAAS_M6_PERF_RESET!=="1")throw new Error("Explicit SAAS_M6_PERF_RESET=1 required for the owned disposable benchmark")
  const output=process.env.SAAS_ARTIFACT_DIR;if(!output||!path.isAbsolute(output))throw new Error("Absolute SAAS_ARTIFACT_DIR required")
  const quick=process.argv.includes("--quick"),duration=quick?30:1800,products=quick?10:1000,orders=quick?20:10000
  process.env.SAAS_M5_PERF_TEST_RESET="1";fs.mkdirSync(output,{recursive:true})
  const temp=await fsp.mkdtemp(path.join(os.tmpdir(),"saas-m6-perf-")),stripe=await createStripeFixture(slugs);let f,secondary,result={complete:false}
  try{
    f=await createFixture({fixtureStage:"m5_perf",fixtureTenants:slugs.map(s=>[s,`${s} Benchmark`]),fixtureVariants:2,payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(temp,"objects")})
    await f.app.m5Runtime.workerStarted()
    const dataset=await seed(f,stripe,products,orders)
    // Drain ordinary seed events fairly; the background heartbeats continue.
    for(let n=0;n<3000;n++){if(!await f.app.m2Runtime.jobs.processNext())break}
    secondary=await startBenchmarkProcess(f.config,{stage:"m5_perf",stripePort:stripe.port})
    // Pair-wise routing alternates product list/detail and order list/detail on
    // both processes. Simple n%2 routing would bias each process to one shape.
    f.processForRequest=n=>(Math.floor(n/2)+Math.floor(n/20))%2
    f.loadRequest=(host,method,url,body,headers,n)=>(f.processForRequest(n)?secondary.request:f.request)(host,method,url,body,headers)
    f.processSamples=()=>[secondary.snapshot()]
    const before=(await f.db.query("SELECT state,count(*)::int count FROM saas_control.task_dispatch GROUP BY state")).rows
    let stopWorker=false,workerFailure=null,workerRetries=0
    const worker=(async()=>{while(!stopWorker){try{const job=await f.app.m2Runtime.jobs.processNext();if(!job)await sleep(50)}catch(e){
      if(["SAAS_ADMISSION_CONFLICT","SAAS_MAINTENANCE"].includes(e.code)){workerRetries++;await sleep(100)}else{workerFailure=e;return}
    }}})()
    let performanceResult,loadQueueDrainMs=0
    try{
      performanceResult=await load(f,{duration,rps:20,products},output)
      // The final HTTP response can precede its ordinary event's dispatch.
      // Measure bounded convergence with the real worker still running rather
      // than declaring a just-enqueued event stuck at the same instant.
      const drainStarted=Date.now(),drainDeadline=drainStarted+60000
      while(Date.now()<drainDeadline&&!workerFailure){
        const active=(await f.db.query("SELECT count(*)::int n FROM saas_control.task_dispatch WHERE state IN ('pending','running','blocked')")).rows[0].n
        if(!active)break
        await sleep(50)
      }
      loadQueueDrainMs=Date.now()-drainStarted
    }finally{stopWorker=true;await worker}
    secondary.assertHealthy()
    if(workerFailure)throw workerFailure
    performanceResult.workerAdmissionRetries=workerRetries
    const afterLoad=(await f.db.query("SELECT state,count(*)::int count FROM saas_control.task_dispatch GROUP BY state")).rows
    const loadQueueConverged=afterLoad.every(r=>!["pending","running","blocked","failed"].includes(r.state))
    result={complete:false,dataset,performance:performanceResult,queue:{before,afterLoad,loadQueueConverged,loadQueueDrainMs,loadQueueDrainLimitMs:60000}}
    const checkout=await conflict(f,stripe)
    // Wait for bounded retry timers as well as currently available jobs. Stock
    // exhaustion is expected terminal failure, not a queue that stays pending.
    const drainDeadline=Date.now()+120000
    while(Date.now()<drainDeadline){
      const job=await f.app.m2Runtime.jobs.processNext()
      if(!job){
        const active=(await f.db.query("SELECT count(*)::int n FROM saas_control.task_dispatch WHERE state IN ('pending','running','blocked')")).rows[0].n
        if(!active)break
        await sleep(100)
      }
    }
    const after=(await f.db.query("SELECT state,count(*)::int count FROM saas_control.task_dispatch GROUP BY state")).rows
    const conflictQueueSettled=after.every(r=>!["pending","running","blocked"].includes(r.state))
    const terminalFailures=(await f.db.query("SELECT kind,count(*)::int count FROM saas_control.task_dispatch WHERE state='failed' GROUP BY kind")).rows
    assert(loadQueueConverged,"Ordinary load queue must converge without failures")
    assert(conflictQueueSettled,"Checkout conflict retries must settle within the bounded drain")
    assert(terminalFailures.every(r=>r.kind==="cart.complete"),"Unexpected failed event kind after checkout conflict")
    result={complete:true,profile:quick?"quick-smoke":"10-tenant-reference-data-on-observed-hardware",observedAt:new Date().toISOString(),environment:{node:process.version,cpuVisible:os.availableParallelism(),cpuQuota:readLimit("/sys/fs/cgroup/cpu.max"),memoryLimit:readLimit("/sys/fs/cgroup/memory.max"),totalMemory:os.totalmem()},dataset,
      historyProfile:"native workflow template cloned under application RLS: order/address/item/summary/shipping. Historical external payment, refund, fulfillment and workflow ledgers excluded; not a full lifecycle history benchmark.",
      mix:"80% product browse, 15% active cart read/update, 5% native Admin order read; checkout measured separately",topology:{apiProcesses:2,sharedDatabase:true,sharedObjectNamespace:true,backgroundWorkers:1,perProcessNativePoolMax:4,perProcessApplicationPoolMax:4,routing:"pair-wise alternating HTTP requests across two independent Node processes"},performance:performanceResult,checkout,
      queue:{before,afterLoad,loadQueueConverged,loadQueueDrainMs,loadQueueDrainLimitMs:60000,afterConflict:after,conflictQueueSettled,terminalFailures,
        note:"Stock-exhausted checkout jobs reach a bounded terminal failed state and require no further automatic retry; they are retained for inspection."},
      releaseQualified:false,limits:["Observed cloud CPU quota differs from the PRD 8-core reference server","Owned loopback payment provider timing is not vendor latency","History excludes older payment/fulfillment ledgers; deployment resource growth needs its own review"]}
    console.log(JSON.stringify({event:"benchmark-complete",profile:result.profile,passed:performanceResult.passed,p95Ms:performanceResult.all.p95Ms,checkoutOrders:checkout.createdOrders}))
  }finally{
    fs.writeFileSync(path.join(output,"performance.json"),JSON.stringify(result,null,2)+"\n")
    if(secondary)await secondary.close();if(f)await f.close();await stripe.close();await fsp.rm(temp,{recursive:true,force:true})
  }
  if(!result.performance?.passed)process.exitCode=1
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={historicalOrders,catalog,percentile,makeCart,conflict,load}
