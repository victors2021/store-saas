"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),http=require("node:http"),https=require("node:https"),{execFileSync}=require("node:child_process")
const {Client}=require("pg"),{createFixture}=require("./m3-test-fixture.cjs"),{createM1Application}=require("./m1-application.cjs"),{createBackup,restoreBackup}=require("./m5-backup.cjs")
function tlsRequest(port,host,url,{method="GET",headers={},body,ca,servername=host}={}){
  return new Promise((resolve,reject)=>{
    const data=body?Buffer.from(JSON.stringify(body)):undefined
    const request=https.request({hostname:"127.0.0.1",port,servername,ca,rejectUnauthorized:true,path:url,method,
      headers:{host,...(data?{"content-type":"application/json","content-length":data.length}:{}),...headers}},response=>{
      const chunks=[];response.on("data",d=>chunks.push(d));response.on("error",reject);response.on("end",()=>{
        const raw=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(raw)}catch{value=raw};resolve({status:response.statusCode,body:value,headers:response.headers})
      })
    });request.on("error",reject);request.end(data)
  })
}
test("M6 verified TLS ingress, failed configuration and matching snapshot rollback rehearsal",{timeout:240000},async()=>{
  if(process.env.SAAS_M6_DEPLOYMENT_RESET!=="1")throw new Error("Explicit owned deployment fixture reset required")
  process.env.SAAS_M5_DEPLOY_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-m6-deploy-")),checks=[],backupKey=crypto.randomBytes(32).toString("hex")
  let f,app,server,ingress,backendPort,sourceClosed=false,complete=false,backup
  const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log("PASS",name)}
  try{
    f=await createFixture({fixtureStage:"m5_deploy",payments:true,operations:true,secureCookies:true,trustedProxy:["127.0.0.1/32"],objectRoot:path.join(directory,"objects")})
    await f.seedCommerce();const [A,B]=f.tenants
    const file=await f.inStore(A,()=>f.app.m2Runtime.resources.file.upload({filename:"rollback.txt",content:Buffer.from("snapshot media"),isPublic:false}))
    const certificate=path.join(directory,"certificate.pem"),key=path.join(directory,"key.pem")
    execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",certificate,"-days","1","-subj","/CN=*.shops.example.test","-addext","subjectAltName=DNS:*.shops.example.test"],{stdio:"ignore"})
    fs.chmodSync(key,0o600);const ca=fs.readFileSync(certificate);backendPort=f.server.address().port
    ingress=https.createServer({key:fs.readFileSync(key),cert:ca},(req,res)=>{
      const host=req.headers.host
      if(![A.hostname,B.hostname,"platform.shops.example.test"].includes(host)){res.writeHead(404);return res.end()}
      const headers={...req.headers,"x-forwarded-proto":"https","x-forwarded-for":req.socket.remoteAddress}
      delete headers["x-forwarded-host"]
      const upstream=http.request({hostname:"127.0.0.1",port:backendPort,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res)})
      upstream.on("error",()=>{res.writeHead(503);res.end()});req.pipe(upstream)
    })
    await new Promise(r=>ingress.listen(0,"127.0.0.1",r));const port=ingress.address().port
    const get=(host,url,options={})=>tlsRequest(port,host,url,{ca,...options})
    await check("real TLS verifies the owned certificate and rejects an incorrect server identity",async()=>{
      assert.equal((await get(A.hostname,"/store/products")).status,200)
      await assert.rejects(get(A.hostname,"/store/products",{servername:"outside.example.test"}),e=>e.code==="ERR_TLS_CERT_ALTNAME_INVALID")
      assert.equal((await get("unknown.shops.example.test","/store/products")).status,404)
    })
    await check("ingress preserves Host, replaces forwarding claims, binds Secure cookies and rejects cross-store origins",async()=>{
      const owner={authorization:`Bearer ${A.ownerToken}`}
      const r=await get(A.hostname,"/auth/session",{method:"POST",headers:{...owner,origin:`https://${A.hostname}`},body:{}})
      assert.equal(r.status,200);assert(r.headers["set-cookie"].some(c=>c.includes("Secure")&&c.includes("HttpOnly")&&c.includes("SameSite=Lax")))
      assert.equal((await get(A.hostname,"/admin/products",{method:"POST",headers:{...owner,origin:`https://${B.hostname}`},body:{title:"wrong origin"}})).status,403)
      const own=await get(A.hostname,"/admin/products",{headers:{...owner,"x-forwarded-host":B.hostname,"x-forwarded-for":"198.51.100.99"}})
      assert.equal(own.status,200);assert.equal(own.body.products[0].id,A.product.id)
      assert.equal((await get(B.hostname,"/admin/products",{headers:owner})).status,401)
    })
    const input=path.join(directory,"snapshot.enc"),sourceUrl="postgres://postgres@localhost:5432/medusa_saas_m5_deploy_http"
    await f.close();sourceClosed=true
    await check("stopped-writer backup captures matching database, media and persistent runtime keys",async()=>{
      backup=await createBackup({databaseUrl:sourceUrl,applicationRole:"medusa_saas_m5_deploy_app",objectRoot:f.config.objectRoot,output:input,backupKey,recoveryKeys:f.config,tools:{container:"medusa-baseline-postgres"}})
      assert.equal(backup.objects,1);assert.equal(fs.statSync(input).mode&0o777,0o600)
    })
    app=await createM1Application({...f.config,namespaceSecret:crypto.randomBytes(48).toString("hex")})
    server=await new Promise(r=>{const s=app.web.listen(0,"127.0.0.1",()=>r(s))});backendPort=server.address().port
    await check("a candidate with a mismatched identity key cannot authenticate the existing merchant",async()=>{
      assert.equal((await get(A.hostname,"/auth/user/emailpass",{method:"POST",body:f.credentials})).status,401)
    })
    await new Promise(r=>server.close(r));server=null;await app.close();app=null
    const source=new Client({connectionString:sourceUrl});await source.connect()
    try{await source.query("UPDATE product SET title='state after snapshot' WHERE tenant_id=$1",[A.id])}finally{await source.end()}
    const target="medusa_saas_m6_restored_"+crypto.randomBytes(5).toString("hex"),objects=path.join(directory,"restored-objects"),keysOutput=path.join(directory,"restored-keys.json")
    const restored=await restoreBackup({input,backupKey,databaseUrl:`postgres://postgres@localhost:5432/${target}`,applicationRole:"medusa_saas_m5_deploy_app",objectRoot:objects,keysOutput,confirmEmptyDatabase:target,tools:{container:"medusa-baseline-postgres"}})
    await check("matching empty-target snapshot restore restores media/key hashes and removes obsolete sessions",async()=>{
      assert.equal(fs.statSync(keysOutput).mode&0o777,0o600)
      assert(restored.keys.namespaceSecret===f.config.namespaceSecret,"Identity key must match the protected snapshot")
      assert.equal(fs.readFileSync(path.join(objects,crypto.createHash("sha256").update(A.id).digest("hex"),file.id),"utf8"),"snapshot media")
      const c=new Client({connectionString:`postgres://postgres@localhost:5432/${target}`});await c.connect()
      try{assert.equal((await c.query("SELECT count(*)::int n FROM saas_control.http_session")).rows[0].n,0);assert.notEqual((await c.query("SELECT title FROM product WHERE tenant_id=$1",[A.id])).rows[0].title,"state after snapshot")}finally{await c.end()}
    })
    app=await createM1Application({...f.config,...restored.keys,databaseUrl:`postgres://medusa_saas_m5_deploy_app@localhost:5432/${target}`,objectRoot:objects})
    server=await new Promise(r=>{const s=app.web.listen(0,"127.0.0.1",()=>r(s))});backendPort=server.address().port
    await check("restored M6 code/data/objects/keys authenticate correctly with sibling access still denied",async()=>{
      assert.equal((await get(A.hostname,"/auth/user/emailpass",{method:"POST",body:f.credentials})).status,200)
      assert.equal((await get(B.hostname,"/admin/products",{headers:{authorization:`Bearer ${A.ownerToken}`}})).status,401)
      assert.equal((await get(A.hostname,"/admin/products",{headers:{authorization:`Bearer ${A.ownerToken}`}})).status,200)
      await app.m5Runtime.workerStarted();assert.equal((await get(A.hostname,"/health/ready")).status,200)
    })
    complete=true
  }finally{
    if(ingress)await new Promise(r=>ingress.close(r));if(server)await new Promise(r=>server.close(r));if(app)await app.close();if(f&&!sourceClosed)await f.close()
    fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M6_DEPLOYMENT_RESULT)fs.writeFileSync(process.env.SAAS_M6_DEPLOYMENT_RESULT,JSON.stringify({milestone:"M6",complete,passed:checks.length,checks,
      encryptedBackup:backup?{sha256:backup.sha256,bytes:backup.bytes,objects:backup.objects}:null,separate_physical_host:false,
      deployment:"owned loopback HTTPS ingress, certificate verification, wrong-key candidate and matching current M6 snapshot recovery; not a public production rollout or M5 dependency downgrade",
      externalAcceptance:false},null,2)+"\n")
  }
})
