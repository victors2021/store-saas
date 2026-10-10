"use strict"
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),http=require("node:http"),https=require("node:https"),{spawn,execFileSync}=require("node:child_process")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs"),{provisionDemo}=require("./provision-demo.cjs"),{readPrivateJson}=require("./demo-config.cjs")
console.log=(...args)=>console.error(...args)
async function main(){
  if(process.env.SAAS_SELF_SERVICE_BROWSER_RESET!=="1")throw new Error("Explicit disposable browser fixture reset required")
  process.env.SAAS_M5_PORTALBROWSER_TEST_RESET="1"
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"saas-portal-browser-")),stripe=await createStripeFixture(),nextPort=Number(process.env.SAAS_SELF_SERVICE_NEXT_PORT||8214)
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",path.join(dir,"key.pem"),"-out",path.join(dir,"cert.pem"),"-days","2","-subj","/CN=shops.example.test","-addext","subjectAltName=DNS:shops.example.test,DNS:*.shops.example.test"],{stdio:"ignore"})
  const f=await createFixture({fixtureStage:"m5_portalbrowser",secureCookies:true,trustedProxy:["127.0.0.1/32"],payments:true,operations:true,testStripeFactory:stripe.factory,
    objectRoot:path.join(dir,"objects"),frontend:{adminDirectory:path.join(__dirname,"admin-dist"),storefrontOrigin:`http://127.0.0.1:${nextPort}`}})
  const provisioned=await provisionDemo(f.db,{baseDomain:f.config.baseDomain,directory:dir});f.config.demo=readPrivateJson(provisioned.config_file);await f.restart()
  await f.app.m5Runtime.workerStarted()
  let work;const timer=setInterval(()=>{if(!work)work=f.app.m2Runtime.jobs.processNext().catch(()=>{}).finally(()=>work=null)},200)
  const ingress=https.createServer({key:fs.readFileSync(path.join(dir,"key.pem")),cert:fs.readFileSync(path.join(dir,"cert.pem"))},(req,res)=>{
    if(!/^(?:[a-z0-9-]+\.)?shops\.example\.test(?::\d+)?$/.test(req.headers.host||"")){res.writeHead(404);return res.end()}
    const headers={...req.headers};for(const k of ["forwarded","x-forwarded-host","x-forwarded-for","x-forwarded-proto","x-forwarded-port","x-real-ip"])delete headers[k];headers["x-forwarded-proto"]="https";
    const proxy=http.request({hostname:"127.0.0.1",port:f.server.address().port,path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});proxy.on("error",()=>{if(!res.headersSent)res.writeHead(503);res.end()});req.pipe(proxy)
  })
  await new Promise(resolve=>ingress.listen(0,"127.0.0.1",resolve))
  const env={...process.env,NODE_ENV:"production",MEDUSA_BACKEND_URL:`http://127.0.0.1:${f.server.address().port}`,SAAS_BASE_DOMAIN:f.config.baseDomain}
  for(const k of Object.keys(env))if(k.startsWith("SAAS_")&&k!=="SAAS_BASE_DOMAIN")delete env[k]
  const next=spawn(process.execPath,[path.join(__dirname,"storefront/node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(nextPort)],{cwd:path.join(__dirname,"storefront"),env,stdio:["ignore",2,2]})
  process.stdout.write(JSON.stringify({ready:true,port:ingress.address().port,certificate:path.join(dir,"cert.pem"),gateway_port:f.server.address().port,merchant_email:f.config.demo.merchant.email,platform_email:f.config.demo.platform.email})+"\n")
  let stopping=false
  async function stop(){if(stopping)return;stopping=true;clearInterval(timer);if(work)await work;next.kill("SIGTERM");await new Promise(r=>next.exitCode!==null||next.signalCode?r():next.once("exit",r));await new Promise(r=>ingress.close(r));await f.close();await stripe.close();fs.rmSync(dir,{recursive:true,force:true})}
  process.once("SIGTERM",()=>stop().catch(()=>process.exitCode=1));process.once("SIGINT",()=>stop().catch(()=>process.exitCode=1));next.once("exit",()=>{if(!stopping){process.exitCode=1;stop().catch(()=>{})}})
}
main().catch(e=>{console.error("Portal browser fixture failed",{name:e.name,code:e.code});process.exitCode=1})
