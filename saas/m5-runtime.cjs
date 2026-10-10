"use strict"
const crypto=require("node:crypto"),{Pool}=require("pg"),{z}=require("zod")
const {tenantSQL}=require("./tenant-sql.cjs")
const {currentTenant}=require("./tenant-context.cjs")
const {normalizeHost}=require("./tenant-control.cjs")
const {maintenanceLock,error,pausedRoute}=require("./m5-policy.cjs")
const id=z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/)
const limits=z.object({plan_id:z.literal("pilot"),product_limit:z.number().int().min(1).max(100000),
  upload_limit_bytes:z.number().int().min(1).max(1099511627776),requests_per_minute:z.number().int().min(10).max(10000),
  expected_version:z.number().int().positive(),manual_reference:z.string().max(120).regex(/^[^\x00-\x1f\x7f]*$/).default("")}).strict()
const statusInput=z.object({status:z.enum(["active","suspended"])}).strict()
const safeCode=(value)=>/^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(value||"")?value:"REQUEST_FAILED"
function category(path) {
  for(const name of ["platform/tenants","platform/operations","platform/metrics","hooks/stripe","admin/saas","admin/payments","admin/orders","admin/products","admin/uploads","admin/files","store/carts","store/payment-collections","store/orders","auth/user","auth/customer","auth/session"])
    if(path===`/${name}`||path.startsWith(`/${name}/`)) return name.replaceAll("/",".")
  return path.startsWith("/admin/")?"admin.catalog":path.startsWith("/store/")?"store.catalog":"gateway"
}
function createM5Runtime({pool,databaseUrl,contextSecret,platformKey,platformActorId,baseDomain,secureCookies,getControl,m2Runtime,m4Runtime,demo}) {
  const gatePool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:2000,query_timeout:3000})
  // Reserve worker fences so HTTP requests holding their own snapshot fence
  // can dispatch jobs without waiting on a saturated HTTP connection pool.
  const workerGatePool=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:2000,query_timeout:3000})
  const metrics=require("./m6-observability.cjs").createMetrics({category})
  const pending=new Set(),workerId="worker_"+crypto.randomBytes(16).toString("hex")
  let workerEnabled=false,workerTimer,maintenanceAt=0,lastMaintenanceError=null
  let maintenanceCursor=""
  const routes=[
    ["GET",/^\/platform\/demo-config$/],["POST",/^\/platform\/auth\/demo$/],
    ["POST",/^\/platform\/auth\/login$/],["GET",/^\/platform\/auth\/session$/],["DELETE",/^\/platform\/auth\/session$/],
    ["GET",/^\/health\/(live|ready)$/],
    ["GET",/^\/platform\/tenants$/],["POST",/^\/platform\/tenants\/[a-z]+_[A-Za-z0-9]+\/(plan|status)$/],
    ["GET",/^\/platform\/operations$/],
    ["GET",/^\/platform\/metrics$/],
    ["GET",/^\/admin\/saas\/(operations|audit)$/],
    ["POST",/^\/admin\/saas\/operations\/[a-z]+_[A-Za-z0-9]+\/retry$/],
  ]
  const authentication=require("./platform-auth.cjs").createPlatformAuth({pool,baseDomain,contextSecret,platformKey,platformActorId,secureCookies,getControl,rate})
  const platformAuth=authentication.authenticate
  const platformAudit=(client,actorId,action,tenantId,details={})=>client.query(
    "INSERT INTO saas_control.audit_event(actor_id,tenant_id,action,details) VALUES($1,$2,$3,$4)",[actorId,tenantId,action,details])
  async function appendAudit(tenantId,actorId,requestId,action,route,method,status,code=null) {
    const c=await pool.connect()
    try {
      await c.query("BEGIN");await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId])
      await c.query("INSERT INTO saas_ops_audit(id,actor_id,request_id,action,route,method,status,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        ["audit_"+crypto.randomBytes(16).toString("hex"),actorId,requestId,action,route,method,status,code])
      await c.query("COMMIT")
    } catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
  }
  async function rate(scope,limit) {
    const result=await pool.query(`INSERT INTO saas_control.rate_window(scope,bucket,hits) VALUES($1,date_trunc('minute',now()),1)
      ON CONFLICT(scope,bucket) DO UPDATE SET hits=saas_control.rate_window.hits+1 WHERE saas_control.rate_window.hits<$2 RETURNING hits`,[scope,limit])
    if(!result.rowCount) throw error("SAAS_RATE_LIMITED","Request limit reached; retry in the next minute",429)
  }
  async function sharedGate({background=false}={}) {
    const selected=background?workerGatePool:gatePool,capacity=background?2:12
    let c
    try { c=await selected.connect() }
    catch(e) {
      if(e.message==="timeout exceeded when trying to connect"&&selected.totalCount>=capacity&&selected.idleCount===0)
        throw error("SAAS_ADMISSION_CONFLICT","Concurrent mutation limit reached; retry with the same idempotency key",409)
      throw error("SAAS_DATABASE_UNAVAILABLE","Mutation admission is unavailable; retry shortly",503)
    }
    let locked=false
    try {
      locked=(await c.query("SELECT pg_try_advisory_lock_shared(hashtextextended($1,0)) ok",[maintenanceLock])).rows[0].ok
      if(!locked) throw error("SAAS_MAINTENANCE","Maintenance in progress; retry shortly",503)
      return async()=>{try{await c.query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))",[maintenanceLock])}finally{c.release()}}
    } catch(e){c.release();throw e}
  }
  async function middleware(req,res,next) {
    req.saasRequestId=crypto.randomUUID();res.set("X-Request-ID",req.saasRequestId)
    if(req.path.startsWith("/health")) return next()
    const tenant=await getControl().resolveDomain(req.headers.host,{allowSuspended:true})
    const route=category(req.path),mutation=!["GET","HEAD","OPTIONS"].includes(req.method)
    if(tenant) {
      req.saasObservedTenant=tenant.id
      const plan=(await pool.query("SELECT requests_per_minute FROM saas_control.plan_assignment WHERE tenant_id=$1",[tenant.id])).rows[0]
      if(!plan) throw error("SAAS_PLAN_MISSING","Shop plan is unavailable",503)
      if(req.path.startsWith("/hooks/stripe/")) await rate(`callback:${tenant.id}`,600)
      else if(!req.path.startsWith("/app")&&!req.path.startsWith("/_next/")&&!req.path.startsWith("/admin/")) await rate(`tenant:${tenant.id}`,plan.requests_per_minute)
      if(req.path.startsWith("/auth/")) await rate("auth:"+tenant.id+":"+crypto.createHmac("sha256",contextSecret).update(req.ip||"unknown").digest("hex"),20)
    } else if(req.path.startsWith("/platform/")) await rate("platform:"+crypto.createHmac("sha256",contextSecret).update(req.ip||"unknown").digest("hex"),60)
    if(mutation) {
      const release=await sharedGate()
      let completed=false,released=false,activeHandlers=0
      const finish=()=>{if(completed&&!released&&activeHandlers===0){released=true;const promise=release().catch(()=>{});pending.add(promise);promise.finally(()=>pending.delete(promise))}}
      // A disconnected client does not cancel a native workflow. Retain the
      // backup fence until every in-flight async route handler has settled.
      req.saasTrackHandler=async invoke=>{
        activeHandlers++
        try{return await invoke()}finally{activeHandlers--;finish()}
      }
      const completedResponse=()=>{completed=true;finish()}
      res.once("finish",completedResponse);res.once("close",completedResponse)
    }
    if(tenant&&(req.path.startsWith("/admin/")||req.path.startsWith("/store/")||req.path.startsWith("/auth/")||req.path.startsWith("/hooks/"))) {
      res.once("finish",()=>{
        const record={request_id:req.saasRequestId,tenant_id:tenant.id,actor_id:req.auth_context?.actor_id||"public",route,method:req.method,status:res.statusCode,error_code:req.saasErrorCode||null}
        const promise=appendAudit(tenant.id,record.actor_id,req.saasRequestId,"request.completed",route,req.method,res.statusCode,record.error_code)
          .catch(()=>{lastMaintenanceError="AUDIT_WRITE_FAILED"})
        pending.add(promise);promise.finally(()=>pending.delete(promise))
        if(process.env.SAAS_LOG_JSON==="true") console.log(JSON.stringify({type:"saas_request",...record}))
      })
    }
    next()
  }
  async function beforeNative(req,res,next) {
    if(req.tenant.status==="suspended"&&!pausedRoute(req.method,req.path))
      throw error("TENANT_SUSPENDED","Shop is paused; new trading and configuration changes are disabled",423)
    if(req.path.startsWith("/admin/")) {
      const plan=(await pool.query("SELECT requests_per_minute FROM saas_control.plan_assignment WHERE tenant_id=$1",[req.tenant.id])).rows[0]
      await rate(`owner:${req.tenant.id}:${currentTenant().actorId}`,plan.requests_per_minute)
    }
    if(!["GET","HEAD","OPTIONS"].includes(req.method))
      await appendAudit(req.tenant.id,currentTenant().actorId,req.saasRequestId,"request.accepted",category(req.path),req.method,0)
    next()
  }
  async function readiness() {
    let database=false,worker=false
    try {
      database=(await gatePool.query("SELECT 1 ok")).rows[0].ok===1
      worker=(await gatePool.query("SELECT 1 FROM saas_control.worker_heartbeat WHERE state='running' AND last_seen>now()-interval '30 seconds' LIMIT 1")).rowCount>0
    } catch { /* A readiness failure must not expose connection details. */ }
    return {stage:"M5",ready:database&&worker,checks:{api:true,database,worker}}
  }
  async function workerPulse() {
    await pool.query("INSERT INTO saas_control.worker_heartbeat(id,state) VALUES($1,'running') ON CONFLICT(id) DO UPDATE SET state='running',last_seen=now()",[workerId])
  }
  async function workerStarted() {
    workerEnabled=true;await workerPulse()
    workerTimer=setInterval(()=>workerPulse().catch(()=>{lastMaintenanceError="WORKER_HEARTBEAT_FAILED"}),10000);workerTimer.unref()
  }
  async function workerStopped() {
    workerEnabled=false;clearInterval(workerTimer)
    await pool.query("UPDATE saas_control.worker_heartbeat SET state='stopped',last_seen=now() WHERE id=$1",[workerId])
  }
  async function claimDispatch(c,jobId) {
    const schedule=(await c.query(`SELECT s.tenant_id FROM saas_control.queue_schedule s
      WHERE EXISTS(SELECT 1 FROM saas_control.task_dispatch d WHERE d.tenant_id=s.tenant_id AND ($1::text IS NULL OR d.id=$1)
        AND ((d.state='pending' AND d.available_at<=now()) OR (d.state='running' AND d.lease_until<=now())))
      AND NOT EXISTS(SELECT 1 FROM saas_control.task_dispatch d WHERE d.tenant_id=s.tenant_id AND d.state='running' AND d.lease_until>now())
      ORDER BY s.last_served_at NULLS FIRST,s.tenant_id LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,[jobId])).rows[0]
    if(!schedule) return null
    const row=(await c.query(`SELECT * FROM saas_control.task_dispatch WHERE tenant_id=$1 AND ($2::text IS NULL OR id=$2)
      AND ((state='pending' AND available_at<=now()) OR (state='running' AND lease_until<=now()))
      ORDER BY CASE WHEN kind='m4.stripe.event' THEN 0 WHEN kind IN ('cart.complete','cart.create') THEN 1 ELSE 2 END,attempts,available_at,id
      LIMIT 1 FOR UPDATE SKIP LOCKED`,[schedule.tenant_id,jobId])).rows[0]
    if(row) await c.query("UPDATE saas_control.queue_schedule SET last_served_at=clock_timestamp() WHERE tenant_id=$1",[schedule.tenant_id])
    return row
  }
  async function queueAdmission(c,identity,kind) {
    await c.query("SELECT tenant_id FROM saas_control.queue_schedule WHERE tenant_id=$1 FOR UPDATE",[identity.tenantId])
    const {n}=(await c.query("SELECT count(*)::int n FROM saas_control.task_dispatch WHERE tenant_id=$1 AND state IN ('pending','blocked','running')",[identity.tenantId])).rows[0]
    const critical=kind==="m4.stripe.event"||/^event:(payment|order|fulfillment|refund|capture|Link[A-Za-z]*(Payment|Order|Fulfillment))/.test(kind)
    if(n>=(critical?2000:1000)) throw error("SAAS_QUEUE_QUOTA","Shop queue limit reached; payment callbacks retain a reserved capacity",429)
  }
  async function maintenance() {
    if(Date.now()-maintenanceAt<60000)return
    maintenanceAt=Date.now()
    const release=await sharedGate({background:true})
    try {
      await pool.query("SELECT saas_control.clean_ephemeral()")
      await pool.query("DELETE FROM saas_control.platform_login_session WHERE id IN (SELECT id FROM saas_control.platform_login_session WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000)")
      await pool.query("DELETE FROM saas_control.portal_session WHERE id IN (SELECT id FROM saas_control.portal_session WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000)")
      const tenants=(await pool.query("SELECT id,owner_actor_id FROM saas_control.tenant WHERE status IN ('active','suspended') AND id>$1 ORDER BY id LIMIT 20",[maintenanceCursor])).rows
      maintenanceCursor=tenants.length===20?tenants.at(-1).id:""
      const {createTenantVerifier,runWithTenant}=require("./tenant-context.cjs"),jwt=require("jsonwebtoken")
      const verifier=createTenantVerifier({secret:contextSecret,issuer:"saas-m5-maintenance",audience:"tenant-maintenance",
        lookupMembership:identity=>getControl().authorizeMembership({...identity,allowSuspended:true})})
      for(const tenant of tenants) {
        const context=await verifier(jwt.sign({tenant_id:tenant.id},contextSecret,{subject:tenant.owner_actor_id,issuer:"saas-m5-maintenance",audience:"tenant-maintenance",expiresIn:"5m"}))
        await runWithTenant(context,async()=>{
          await tenantSQL(pool,c=>c.query("SELECT saas_control.clean_tenant_ephemeral()"))
          await m2Runtime.resources.file.sweep()
        })
      }
      lastMaintenanceError=null
    } catch(e){lastMaintenanceError="CLEANUP_FAILED";throw e}finally{await release()}
  }
  function mountPlatform(web,{asyncHandler}) {
    web.get("/platform/demo-config",asyncHandler(async(req,res)=>{
      if(normalizeHost(req.headers.host)!==`platform.${baseDomain}`||["x-forwarded-host","x-tenant-id","tenant-id","tenant_id"].some(k=>req.headers[k]!==undefined))throw error("PLATFORM_HOST_REQUIRED","Platform Host required",404)
      res.json({enabled:!!demo,email:demo?.platform.email||null})
    }))
    web.post("/platform/auth/demo",asyncHandler(async(req,res)=>{
      if(!demo)throw error("PLATFORM_DEMO_DISABLED","演示入口未开启",404)
      if(Object.keys(req.body||{}).length)throw error("PLATFORM_LOGIN_FAILED","Demo request must be empty",401)
      req.body=demo.platform;return authentication.login(req,res)
    }))
    web.post("/platform/auth/login",asyncHandler(authentication.login))
    web.get("/platform/auth/session",asyncHandler(authentication.current))
    web.delete("/platform/auth/session",asyncHandler(authentication.logout))
    const path=require("node:path")
    for(const [url,file,type] of [["/platform","index.html","text/html"],["/platform/main.js","main.js","application/javascript"],["/platform/style.css","style.css","text/css"]])
      web.get(url,asyncHandler(async(req,res)=>{
        if(normalizeHost(req.headers.host)!==`platform.${baseDomain}`||["x-forwarded-host","x-tenant-id","tenant-id","tenant_id"].some(k=>req.headers[k]!==undefined))
          throw error("PLATFORM_HOST_REQUIRED","Platform console is unavailable on this Host",404)
        res.set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
        res.type(type).sendFile(path.join(__dirname,"platform",file))
      }))
    web.get("/health/live",(req,res)=>res.json({stage:"M5",live:true}))
    const ready=asyncHandler(async(req,res)=>{const result=await readiness();res.status(result.ready?200:503).json(result)})
    web.get("/health/ready",ready);web.get("/health",ready)
    web.get("/platform/metrics",asyncHandler(platformAuth),asyncHandler(async(req,res)=>{
      z.object({}).strict().parse(req.query)
      res.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.format({pool,health:await readiness()}))
    }))
    web.get("/platform/tenants",asyncHandler(platformAuth),asyncHandler(async(req,res)=>{
      const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict().parse(req.query)
      const rows=await pool.query(`SELECT t.id,t.slug,t.name,t.status,t.created_at,p.plan_id,p.product_limit,p.upload_limit_bytes::text,
        p.requests_per_minute,p.version,u.product_count::text,u.upload_bytes::text FROM saas_control.tenant t
        JOIN saas_control.plan_assignment p ON p.tenant_id=t.id JOIN saas_control.tenant_usage u ON u.tenant_id=t.id
        ORDER BY t.created_at,t.id LIMIT $1 OFFSET $2`,[q.limit,q.offset])
      res.json({tenants:rows.rows,count:(await pool.query("SELECT count(*)::int n FROM saas_control.tenant")).rows[0].n,...q})
    }))
    web.post("/platform/tenants/:id/plan",asyncHandler(platformAuth),asyncHandler(async(req,res)=>{
      id.parse(req.params.id);const data=limits.parse(req.body),c=await pool.connect()
      try{await c.query("BEGIN")
        const row=(await c.query(`UPDATE saas_control.plan_assignment SET product_limit=$2,upload_limit_bytes=$3,requests_per_minute=$4,
          manual_reference=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND version=$6 RETURNING tenant_id,plan_id,version`,
          [req.params.id,data.product_limit,data.upload_limit_bytes,data.requests_per_minute,data.manual_reference,data.expected_version])).rows[0]
        if(!row)throw error("SAAS_PLAN_VERSION_CONFLICT","Plan changed; reload before saving")
        await platformAudit(c,req.platformAdmin.actorId,"plan.changed",req.params.id,{version:row.version,product_limit:data.product_limit,upload_limit_bytes:data.upload_limit_bytes,requests_per_minute:data.requests_per_minute})
        await c.query("COMMIT");res.json({plan:row})
      }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
    }))
    web.post("/platform/tenants/:id/status",asyncHandler(platformAuth),asyncHandler(async(req,res)=>{
      id.parse(req.params.id);const {status}=statusInput.parse(req.body)
      const c=await gatePool.connect(),key=JSON.stringify(["m4-commerce",req.params.id]);let locked=false
      try {
        locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[key])).rows[0].ok
        if(!locked) throw error("SAAS_STATUS_CONFLICT","An order operation is in progress; retry after it finishes")
        const tenant=await getControl().setTenantStatus({tenantId:req.params.id,actorId:req.platformAdmin.actorId,status})
        res.json({tenant:{id:tenant.id,slug:tenant.slug,status:tenant.status}})
      } finally {try{if(locked)await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[key])}finally{c.release()}}
    }))
    web.get("/platform/operations",asyncHandler(platformAuth),asyncHandler(async(req,res)=>{
      z.object({}).strict().parse(req.query)
      const dispatch=await pool.query(`SELECT tenant_id,state,count(*)::int jobs,min(created_at) oldest_created_at FROM saas_control.task_dispatch
        WHERE state IN ('pending','blocked','running','failed') GROUP BY tenant_id,state ORDER BY tenant_id,state`)
      const backup=(await pool.query("SELECT completed_at,sha256,byte_size::text,object_count FROM saas_control.backup_receipt ORDER BY completed_at DESC LIMIT 1")).rows[0]||null
      const alerts=dispatch.rows.filter(r=>r.state==='failed'||(r.state==='pending'&&Date.now()-new Date(r.oldest_created_at).getTime()>300000)).map(r=>({tenant_id:r.tenant_id,code:r.state==='failed'?'QUEUE_FAILED':'QUEUE_BACKLOG'}))
      if(!backup)alerts.push({tenant_id:null,code:'BACKUP_MISSING'})
      else if(Date.now()-new Date(backup.completed_at).getTime()>36*3600000)alerts.push({tenant_id:null,code:'BACKUP_STALE'})
      if(lastMaintenanceError)alerts.push({tenant_id:null,code:lastMaintenanceError})
      res.json({health:await readiness(),queue:dispatch.rows,maintenance_error:lastMaintenanceError,backup,off_host_backup_verified:false,alerts})
    }))
  }
  async function state() {
    const identity=currentTenant(),tenant=await getControl().getTenant(identity.tenantId)
    const quota=(await pool.query(`SELECT p.plan_id,p.product_limit,p.upload_limit_bytes::text,p.requests_per_minute,p.version,
      u.product_count::text,u.upload_bytes::text FROM saas_control.plan_assignment p JOIN saas_control.tenant_usage u ON u.tenant_id=p.tenant_id WHERE p.tenant_id=$1`,[identity.tenantId])).rows[0]
    const operations=await tenantSQL(pool,async c=>(await c.query(`SELECT id,kind,resource_id,state,attempts,error_code,created_at,updated_at
      FROM saas_payment_operation WHERE state<>'done' ORDER BY created_at DESC LIMIT 50`)).rows)
    return {status:tenant.status,quota,operations,retention:{audit_days:90,completed_event_days:30,payment_recovery:"retained"}}
  }
  function mount(web,{asyncHandler,owner}) {
    web.use(asyncHandler(beforeNative))
    web.get("/admin/saas/operations",owner,asyncHandler(async(req,res)=>res.json(await state())))
    web.get("/admin/saas/audit",owner,asyncHandler(async(req,res)=>{
      const q=z.object({limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().parse(req.query)
      const rows=await tenantSQL(pool,async c=>(await c.query("SELECT id,actor_id,request_id,action,route,method,status,error_code,created_at FROM saas_ops_audit ORDER BY created_at DESC,id DESC LIMIT $1",[q.limit])).rows)
      res.json({events:rows})
    }))
    web.post("/admin/saas/operations/:id/retry",owner,asyncHandler(async(req,res)=>{
      id.parse(req.params.id);z.object({}).strict().parse(req.body)
      const op=await tenantSQL(pool,async c=>(await c.query("SELECT * FROM saas_payment_operation WHERE id=$1",[req.params.id])).rows[0])
      if(!op)throw error("SAAS_OPERATION_NOT_FOUND","Operation is unavailable",404)
      if(op.state==="done")return res.json({operation:{id:op.id,state:op.state}})
      await m4Runtime.retryOperation(op)
      res.json({operation:{id:op.id,state:"done"}})
    }))
  }
  return {routes,middleware,observe:metrics.observe,mount,mountPlatform,platformAuth,rate,beforeNative,readiness,state,sharedGate,claimDispatch,queueAdmission,
    workerStarted,workerStopped,workerPulse,maintenance,safeCode,
    close:async()=>{clearInterval(workerTimer);if(workerEnabled)await workerStopped();await Promise.allSettled([...pending]);await gatePool.end();await workerGatePool.end()}}
}
module.exports={createM5Runtime,category,safeCode}
