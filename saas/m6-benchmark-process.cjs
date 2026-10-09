"use strict"
// A second real application process for owned, disposable acceptance fixtures.
// It never migrates/resets a DB and never calls an external payment endpoint.
const {fork}=require("node:child_process"),http=require("node:http")
const {Client}=require("pg")
const stages=new Set(["m5_perf","m5_concurrency","m5_login"])
const configKeys=["databaseUrl","baseDomain","jwtSecret","contextSecret","namespaceSecret","platformKey","platformActorId","secureCookies","commerce","browser","objectRoot","payments","paymentKey","operations"]
function requestAt(port,host,method,path,body,extra={}){
  return new Promise((resolve,reject)=>{
    const data=Buffer.isBuffer(body)?body:body==null?undefined:Buffer.from(JSON.stringify(body))
    const req=http.request({hostname:"127.0.0.1",port,method,path,headers:{host,...(data?{"content-type":"application/json","content-length":data.length}:{}),...extra}},res=>{
      const chunks=[];res.on("data",b=>chunks.push(b));res.on("error",reject)
      res.on("end",()=>{const raw=Buffer.concat(chunks);let value;try{value=JSON.parse(raw)}catch{value=raw.toString()};resolve({status:res.statusCode,body:value,headers:res.headers,raw})})
    })
    req.setTimeout(30000,()=>req.destroy(new Error("Owned benchmark request timed out")))
    req.on("error",reject);req.end(data)
  })
}
async function startBenchmarkProcess(config,{stage,stripePort}){
  if(!stages.has(stage)||!Number.isInteger(stripePort)||stripePort<1||stripePort>65535)throw new TypeError("Owned fixture stage and loopback provider port required")
  const child=fork(__filename,[],{env:{...process.env,SAAS_M6_BENCHMARK_CHILD:"1",MEDUSA_SAAS_MODE:"true",NODE_ENV:"test"},stdio:["ignore","inherit","inherit","ipc"]})
  let stats=null,failed=null,closing=false,readyResolve,readyReject
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject})
  const deadline=setTimeout(()=>readyReject(new Error("Second benchmark process startup timed out")),60000)
  child.on("message",message=>{
    if(message.type==="ready")readyResolve(message.port)
    if(message.type==="stats")stats=message.value
    if(message.type==="failed"){failed=new Error("Second benchmark process failed");readyReject(failed)}
  })
  child.on("error",()=>{failed=new Error("Second benchmark process unavailable");readyReject(failed)})
  const exited=new Promise(resolve=>child.once("exit",(code,signal)=>{if(!closing){failed=new Error("Second benchmark process exited");readyReject(failed)};resolve({code,signal})}))
  const close=async()=>{
    if(closing)return exited;closing=true
    if(child.exitCode===null&&!child.signalCode){if(child.connected)child.send({type:"stop"});else child.kill("SIGTERM")}
    const force=setTimeout(()=>child.kill("SIGKILL"),15000)
    try{const result=await exited;if(result.code!==0||result.signal)throw new Error("Second benchmark process did not stop cleanly");return result}finally{clearTimeout(force)}
  }
  child.send({type:"start",stage,stripePort,config:Object.fromEntries(configKeys.filter(k=>Object.hasOwn(config,k)).map(k=>[k,config[k]]))})
  try{
    const port=await ready
    return {request:(...args)=>{if(failed)throw failed;return requestAt(port,...args)},snapshot:()=>stats,assertHealthy:()=>{if(failed)throw failed},close}
  }catch(error){await close();throw error}finally{clearTimeout(deadline)}
}
async function childMain(){
  if(process.env.SAAS_M6_BENCHMARK_CHILD!=="1"||!process.send)throw new Error("Explicit owned fixture IPC launch required")
  let app,server,timer,started=false,stopping=false
  async function stop(){
    if(stopping)return;stopping=true;clearInterval(timer)
    if(server)await new Promise(resolve=>server.close(resolve))
    if(app)await app.close()
    if(process.connected)process.disconnect()
  }
  const fail=async()=>{if(process.connected)process.send({type:"failed"});process.exitCode=1;await stop()}
  process.once("SIGTERM",()=>stop().catch(()=>{process.exitCode=1}))
  process.once("disconnect",()=>stop().catch(()=>{process.exitCode=1}))
  process.on("message",async message=>{
    try{
      if(message.type==="stop")return await stop()
      if(message.type!=="start"||started||!stages.has(message.stage))throw new Error("Invalid owned benchmark start")
      started=true
      const {config,stripePort,stage}=message
      if(config.databaseUrl!==`postgres://medusa_saas_${stage}_app@localhost:5432/medusa_saas_${stage}_http`||config.baseDomain!=="shops.example.test"||!Number.isInteger(stripePort)||stripePort<1||stripePort>65535)throw new Error("Only fixed owned fixture endpoints accepted")
      const db=new Client({connectionString:config.databaseUrl});await db.connect()
      try{
        const row=(await db.query("SELECT shobj_description(d.oid,'pg_database') marker,r.rolsuper,r.rolbypassrls FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user")).rows[0]
        if(row?.marker!==`medusa-saas-${stage}-http-disposable-v1`||row.rolsuper||row.rolbypassrls)throw new Error("Owned non-bypass fixture identity required")
      }finally{await db.end()}
      const Stripe=require("stripe")
      app=await require("./m1-application.cjs").createM1Application({...config,testStripeFactory:key=>new Stripe(key,{host:"127.0.0.1",port:stripePort,protocol:"http",maxNetworkRetries:0,timeout:3000})})
      server=await new Promise((resolve,reject)=>{const s=app.web.listen(0,"127.0.0.1",()=>resolve(s));s.once("error",reject)})
      const sample=()=>{const value={at:new Date().toISOString(),rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,cpuUsage:process.cpuUsage()};if(process.connected)process.send({type:"stats",value})}
      sample();timer=setInterval(sample,1000)
      process.send({type:"ready",port:server.address().port})
    }catch{await fail()}
  })
}
if(require.main===module)childMain().catch(()=>{process.exitCode=1})
module.exports={startBenchmarkProcess,requestAt}
