"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),http=require("node:http")
const {promisify}=require("node:util"),exec=promisify(require("node:child_process").execFile),{Client}=require("pg")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs"),{seedM4Browser}=require("./m4-browser-seed.cjs")
const {createBackup,restoreBackup,validateTar}=require("./m5-backup.cjs"),{createM1Application}=require("./m1-application.cjs")
const PG_IMAGE="postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
const docker=(args)=>exec("docker",["--host=unix:///var/run/docker.sock",...args],{maxBuffer:1048576})
async function snapshot(client) {
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'saas_ops_audit' ORDER BY tablename")).rows
  const out={}
  for(const row of tables){if(!/^[a-zA-Z0-9_]+$/.test(row.tablename))throw new Error("Unexpected snapshot table");out[row.tablename]=(await client.query(`SELECT count(*)::int n FROM public."${row.tablename}"`)).rows[0].n}
  const tenant=(await client.query("SELECT id,slug,status FROM saas_control.tenant ORDER BY id")).rows
  const usage=(await client.query("SELECT tenant_id,product_count,upload_bytes FROM saas_control.tenant_usage ORDER BY tenant_id")).rows
  return {tables:out,tenants:tenant,usage}
}
function request(server,host,method,url,body,headers={}) {
  return new Promise((resolve,reject)=>{const payload=body?Buffer.from(JSON.stringify(body)):undefined
    const req=http.request({host:"127.0.0.1",port:server.address().port,path:url,method,headers:{host,...(payload?{"content-type":"application/json","content-length":payload.length}:{}),...headers}},res=>{
      const chunks=[];res.on("data",x=>chunks.push(x));res.on("end",()=>{const raw=Buffer.concat(chunks);let data;try{data=JSON.parse(raw)}catch{data=raw.toString()};resolve({status:res.statusCode,body:data,headers:res.headers})})
    });req.on("error",reject);req.end(payload)
  })
}
test("M5 authenticated full backup restores into an independent PostgreSQL instance",{timeout:240000},async()=>{
  if(process.env.SAAS_M5_BACKUP_TEST_RESET!=="1")throw new Error("Explicit marked backup fixture reset required")
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-m5-backup-acceptance-")),container="medusa-m5-restore-"+crypto.randomBytes(6).toString("hex"),checks=[]
  let f,stripe,source,restored,app,server,containerStarted=false,success=false,sourceClosed=false,backupMetadata,restoredTables=0,portalCookie,portalShop
  const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log("PASS",name)}
  try {
    stripe=await createStripeFixture()
    f=await createFixture({fixtureStage:"m5_backup",operations:true,payments:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"source-objects")})
    const config=f.config,[A,B]=f.tenants,role="medusa_saas_m5_backup_app",sourceUrl="postgres://postgres@localhost:5432/medusa_saas_m5_backup_http"
    const portalHost=config.baseDomain,portalOrigin="http://"+portalHost,portalCredentials={email:"backup-merchant@shops.example.test",password:"backup-merchant-password-123"}
    await check("the backup source includes a registered merchant, its owned shop and tracked sample products",async()=>{
      const registered=await f.request(portalHost,"POST","/saas/auth/register",portalCredentials,{origin:portalOrigin});f.ok(registered)
      portalCookie=registered.headers["set-cookie"][0].split(";")[0]
      const opened=await f.request(portalHost,"POST","/saas/shops",{name:"Restored merchant shop",slug:"backup-merchant",password:portalCredentials.password,idempotency_key:"backup-merchant-v1",with_demo_products:true},
        {origin:portalOrigin,cookie:portalCookie,"x-csrf-token":registered.body.csrf_token});f.ok(opened,201);portalShop=opened.body.shop;assert.equal(portalShop.demo_count,3)
    })
    await f.seedCommerce();await seedM4Browser(f,stripe)
    const owner={authorization:`Bearer ${A.ownerToken}`}
    const order=f.ok(await f.request(A.hostname,"GET",`/admin/orders/${A.orderId}?fields=${encodeURIComponent('id,*payment_collections,*payment_collections.payments')}`,null,owner)).order
    const payment=order.payment_collections[0].payments[0]
    f.ok(await f.request(A.hostname,"POST",`/admin/payments/${payment.id}/capture`,{},{...owner,"idempotency-key":"m5-backup-capture"}))
    stripe.pendNextRefund("alpha")
    assert.notEqual((await f.request(A.hostname,"POST",`/admin/payments/${payment.id}/refund`,{amount:5},{...owner,"idempotency-key":"m5-backup-refund"})).status,200)
    const operation=(await f.db.query("SELECT id FROM saas_payment_operation WHERE idempotency_key='m5-backup-refund' AND tenant_id=$1",[A.id])).rows[0]
    const data=Buffer.from([137,80,78,71,13,10,26,10])
    const file=await f.inStore(A,()=>f.app.m2Runtime.resources.file.upload({filename:"restored.png",mimeType:"image/png",content:data,isPublic:true}))
    const backupKey=crypto.randomBytes(32).toString("hex"),input=path.join(directory,"full-backup.enc"),args={databaseUrl:sourceUrl,applicationRole:role,objectRoot:config.objectRoot,output:input,backupKey,
      recoveryKeys:config,tools:{container:"medusa-baseline-postgres"}}
    await check("a busy application gate refuses backup without producing a partial output",async()=>{
      const release=await f.app.m5Runtime.sharedGate()
      try{await assert.rejects(createBackup(args),/writes are in progress/);assert(!fs.existsSync(input))}finally{await release()}
    })
    await f.close();sourceClosed=true
    source=new Client({connectionString:sourceUrl});await source.connect()
    const expected=await snapshot(source)
    await check("full database, owned objects and recovery keys are encrypted and integrity checked",async()=>{
      backupMetadata=await createBackup(args)
      assert.equal(backupMetadata.objects,1);assert.equal(fs.statSync(input).mode&0o777,0o600)
      const encrypted=fs.readFileSync(input);assert.equal(encrypted.subarray(0,8).toString(),"SAASM5B1")
      for(const value of Object.values(args.recoveryKeys).filter(x=>typeof x==="string"&&x.length>=32))assert(!encrypted.includes(Buffer.from(value)),"Runtime secret must not appear as plaintext in backup")
      await assert.rejects(createBackup(args),/already exists/)
    })
    await docker(["run","--detach","--name",container,"--label","medusa.saas.disposable=m5-restore-v1","--publish","127.0.0.1::5432","--env","POSTGRES_HOST_AUTH_METHOD=trust",PG_IMAGE]);containerStarted=true
    const binding=(await docker(["inspect","--format","{{range (index .NetworkSettings.Ports \"5432/tcp\")}}{{.HostIp}}:{{.HostPort}}{{end}}",container])).stdout.trim(),port=Number(binding.split(":")[1])
    assert(binding.startsWith("127.0.0.1:"))
    let ready=false
    for(let n=0;n<60;n++) {
      const probe=new Client({connectionString:`postgres://postgres@localhost:${port}/postgres`,connectionTimeoutMillis:1000,query_timeout:1000})
      probe.on("error",()=>{})
      try{await probe.connect();await probe.query("SELECT 1");ready=true;break}
      catch{await new Promise(resolve=>setTimeout(resolve,250))}
      finally{await probe.end().catch(()=>{})}
    }
    assert(ready)
    const targetDb="medusa_m5_restored",targetUrl=`postgres://postgres@localhost:${port}/${targetDb}`,targetObjects=path.join(directory,"restored-objects")
    const restoreArgs={input,backupKey,databaseUrl:targetUrl,applicationRole:role,objectRoot:targetObjects,confirmEmptyDatabase:targetDb,tools:{container}}
    restored=new Client({connectionString:`postgres://postgres@localhost:${port}/postgres`});await restored.connect()
    await check("remote operator control and PostgreSQL tool connections reject weaker TLS before database access",async()=>{
      for(const mode of ['disable','require','no-verify','prefer']) {
        const databaseUrl=`postgres://postgres@backup.example.invalid/${targetDb}?sslmode=${mode}`
        await assert.rejects(createBackup({...args,databaseUrl,output:path.join(directory,'remote-unused.enc')}),/verified PostgreSQL TLS/)
        await assert.rejects(restoreBackup({...restoreArgs,databaseUrl}),/verified PostgreSQL TLS/)
      }
      await assert.rejects(createBackup({...args,databaseUrl:'postgres://localhost:5432/unnamed_role',output:path.join(directory,'remote-unused.enc')}),/Explicit named/)
      assert(!fs.existsSync(path.join(directory,'remote-unused.enc')))
      assert.equal((await restored.query("SELECT 1 FROM pg_database WHERE datname=$1",[targetDb])).rowCount,0)
    })
    await check("wrong keys and modified encrypted archives fail before any database creation",async()=>{
      await assert.rejects(restoreBackup({...restoreArgs,backupKey:crypto.randomBytes(32).toString("hex")}),/authentication failed/)
      const corrupt=path.join(directory,"modified.enc"),bytes=fs.readFileSync(input);bytes[100]^=1;fs.writeFileSync(corrupt,bytes)
      await assert.rejects(restoreBackup({...restoreArgs,input:corrupt}),/authentication failed/)
      assert.equal((await restored.query("SELECT 1 FROM pg_database WHERE datname=$1",[targetDb])).rowCount,0)
    })
    await check("path traversal and symlink archive entries are rejected before extraction",async()=>{
      const bad=path.join(directory,"unsafe");fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,"manifest.json"),"{}")
      const traversal=path.join(directory,"traversal.tar");await exec("tar",["--create","--format=ustar","--file",traversal,"--directory",bad,"--transform=s,manifest.json,../escape,","manifest.json"])
      await assert.rejects(validateTar(traversal),/Unsafe/)
      fs.symlinkSync(path.join(directory,"outside-marker"),path.join(bad,"database.dump"))
      const links=path.join(directory,"symlink.tar");await exec("tar",["--create","--format=ustar","--file",links,"--directory",bad,"database.dump"])
      await assert.rejects(validateTar(links),/Unsafe/);assert(!fs.existsSync(path.join(directory,"outside-marker")))
    })
    let recovered
    await check("authenticated pg_restore recreates complete business rows and tenant quotas on a second instance",async()=>{
      recovered=await restoreBackup(restoreArgs)
      const verify=new Client({connectionString:targetUrl});await verify.connect()
      try{const actual=await snapshot(verify);assert.deepEqual(actual,expected);restoredTables=Object.keys(actual.tables).length
        assert.equal((await verify.query("SELECT count(*)::int n FROM saas_control.worker_heartbeat")).rows[0].n,0)
      }finally{await verify.end()}
      assert.equal(recovered.objects,1);assert.equal(crypto.createHash("sha256").update(JSON.stringify(recovered.keys)).digest("hex"),crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(["jwtSecret","contextSecret","namespaceSecret","platformKey","paymentKey"].map(k=>[k,config[k]])))).digest("hex"),"Recovery key digest must match")
    })
    await check("restore refuses existing databases, existing object directories and source repository key export",async()=>{
      await assert.rejects(restoreBackup(restoreArgs),/output exists/)
      await assert.rejects(restoreBackup({...restoreArgs,objectRoot:path.join(directory,"unused-objects")}),/database already exists/)
      await assert.rejects(restoreBackup({...restoreArgs,objectRoot:path.join(directory,"unused-two"),keysOutput:path.resolve("saas/forbidden-recovery-keys.json")}),/source repository/)
      const alias=path.join(directory,'repository-alias');fs.symlinkSync(path.resolve('.'),alias)
      await assert.rejects(restoreBackup({...restoreArgs,objectRoot:path.join(directory,'unused-three'),keysOutput:path.join(alias,'forbidden-recovery-keys.json')}),/symlinks/)
      assert(!fs.existsSync(path.resolve('forbidden-recovery-keys.json')))
    })
    app=await createM1Application({...config,...recovered.keys,databaseUrl:`postgres://${role}@localhost:${port}/${targetDb}`,objectRoot:targetObjects})
    server=await new Promise(resolve=>{const value=app.web.listen(0,"127.0.0.1",()=>resolve(value))})
    await check("restore revokes old portal sessions while preserving merchant login, shop ownership and removable samples",async()=>{
      assert.equal((await request(server,portalHost,"GET","/saas/shops",undefined,{cookie:portalCookie})).status,401)
      const login=await request(server,portalHost,"POST","/saas/auth/login",portalCredentials,{origin:portalOrigin});assert.equal(login.status,200)
      const cookie=login.headers["set-cookie"][0].split(";")[0],owned=await request(server,portalHost,"GET","/saas/shops",undefined,{cookie})
      assert.equal(owned.status,200);assert.equal(owned.body.shops.length,1);assert.equal(owned.body.shops[0].id,portalShop.id);assert.equal(owned.body.shops[0].demo_count,3)
      const cleared=await request(server,portalHost,"DELETE",`/saas/shops/${portalShop.id}/demo-products`,{}, {origin:portalOrigin,cookie,"x-csrf-token":login.body.csrf_token})
      assert.equal(cleared.status,200);assert.equal(cleared.body.shops[0].demo_count,0);assert.equal(cleared.body.shops[0].product_count,0)
    })
    await check("restored native SaaS starts with verified RLS and preserves owner and cross-tenant boundaries",async()=>{
      const own=await request(server,A.hostname,"GET",`/admin/orders/${A.orderId}`,null,owner);assert.equal(own.status,200)
      assert.equal((await request(server,A.hostname,"GET",`/admin/orders/${B.orderId}`,null,owner)).status,404)
      assert.equal((await app.pool.query("SELECT count(*)::int n FROM product")).rows[0].n,0)
      const health=await request(server,"localhost","GET","/health");assert.equal(health.status,503);assert.equal(health.body.checks.worker,false)
    })
    await check("restored encrypted merchant credentials and recovery operation settle once through the native provider",async()=>{
      stripe.settleRefunds("alpha")
      const result=await request(server,A.hostname,"POST",`/admin/saas/operations/${operation.id}/retry`,{},owner);assert.equal(result.status,200,JSON.stringify(result.body))
      assert.equal((await request(server,A.hostname,"POST",`/admin/saas/operations/${operation.id}/retry`,{},owner)).status,200)
      const totals=(await request(server,A.hostname,"GET","/admin/saas/metrics",null,owner)).body.currency_totals[0]
      assert.equal(totals.captured_amount,"30");assert.equal(totals.refunded_amount,"5")
      assert.equal(stripe.calls.filter(x=>x.method==='POST'&&x.path==='/v1/refunds').length,1)
    })
    await check("restored signed jobs resume with the original tenant identity",async()=>{
      let delivered=0
      for(let n=0;n<5;n++){const result=await app.m2Runtime.jobs.processNext();if(result){assert.equal(result.state,'done',JSON.stringify({error:result.error,job:result.id}));delivered++}}
      assert(delivered>0)
    })
    await check("restored media bytes match the recorded database digest",async()=>{
      const media=await request(server,A.hostname,"GET",`/store/media/${file.id}`)
      assert.equal(media.status,200)
      const local=path.join(targetObjects,crypto.createHash("sha256").update(A.id).digest("hex"),file.id)
      assert(fs.readFileSync(local).equals(data))
    })
    success=true
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));if(app)await app.close()
    if(f&&!sourceClosed)await f.close();if(source)await source.end();if(restored)await restored.end();if(stripe)await stripe.close()
    if(containerStarted)await docker(["rm","--force",container])
    fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M5_BACKUP_RESULT)fs.writeFileSync(process.env.SAAS_M5_BACKUP_RESULT,JSON.stringify({milestone:"M5",success,passed:checks.length,checks,restored_public_tables:restoredTables,
      independent_postgres_instance:true,separate_physical_host:false,off_host_copy:false,backup:backupMetadata?{bytes:backupMetadata.bytes,sha256:backupMetadata.sha256,objects:backupMetadata.objects}:null},null,2))
  }
})
