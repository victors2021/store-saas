"use strict"
// Persistent, owned loopback demonstration. This is not a public deployment launcher.
const fs=require("node:fs"),path=require("node:path"),http=require("node:http"),https=require("node:https"),{spawn}=require("node:child_process"),{Client}=require("pg")
const {readPrivateJson}=require("./demo-config.cjs"),{assertDemoMode}=require("./self-service.cjs"),{port}=require("./m3-config.cjs")
const {createDevelopmentHosts}=require("./development-hosts.cjs"),{ensureLocalhostTLS}=require("./localhost-tls.cjs")
async function main(){
  if(process.env.NODE_ENV!=="development"||process.env.SAAS_RELEASE_MANIFEST)throw new Error("Explicit development mode without a release manifest required")
  const directory=process.env.SAAS_PREVIEW_DIRECTORY
  if(!directory)throw new Error("SAAS_PREVIEW_DIRECTORY required")
  const runtime=readPrivateJson(path.join(directory,"runtime.json")),demo=readPrivateJson(path.join(directory,"demo-config.json")),baseDomain=process.env.SAAS_BASE_DOMAIN||"shops.example.test"
  assertDemoMode(baseDomain,demo)
  if(process.env.SAAS_LOCALHOST_ACCESS&&!['true','false'].includes(process.env.SAAS_LOCALHOST_ACCESS))throw new Error("SAAS_LOCALHOST_ACCESS must be true or false")
  const localhostAccess=process.env.SAAS_LOCALHOST_ACCESS!=="false",developmentHosts=createDevelopmentHosts({baseDomain,enabled:localhostAccess})
  for(const key of ["jwtSecret","contextSecret","namespaceSecret","platformKey"])if(typeof runtime[key]!=="string"||runtime[key].length<32)throw new Error("Stable development keyring required")
  if(!/^[a-f0-9]{64}$/.test(runtime.paymentKey||""))throw new Error("Independent stable payment key required")
  const databaseUrl=process.env.SAAS_DATABASE_URL||"postgres://medusa_saas_preview_app@localhost:5432/medusa_saas_preview",dbUrl=new URL(databaseUrl)
  if(!["localhost","127.0.0.1"].includes(dbUrl.hostname))throw new Error("Only the owned loopback preview database is accepted")
  const c=new Client({connectionString:databaseUrl});await c.connect()
  try{const marker=(await c.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()" )).rows[0]?.marker
    if(marker!=="store-saas-persistent-local-development-v1")throw new Error("Owned persistent preview database marker required")
  }finally{await c.end()}
  const gatewayPort=port("PORT",9130),nextPort=port("SAAS_STOREFRONT_PORT",8130),tlsPort=port("SAAS_PREVIEW_TLS_PORT",9443)
  if(new Set([gatewayPort,nextPort,tlsPort]).size!==3)throw new Error("Preview ports must differ")
  const keyFile=path.join(directory,"tls-demo-key.pem"),certFile=path.join(directory,"tls-demo-cert.pem")
  if(!localhostAccess){const keyStat=fs.lstatSync(keyFile)
    if(!keyStat.isFile()||keyStat.nlink!==1||(keyStat.mode&0o077)!==0)throw new Error("Private regular TLS key required")}
  const tls=localhostAccess?ensureLocalhostTLS(directory,baseDomain):{key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)}
  const ingress=https.createServer(tls,(req,res)=>{
    let host
    try{host=developmentHosts.canonicalHost(req.headers.host)}catch{res.writeHead(404);return res.end()}
    if(host!==baseDomain&&(!host.endsWith("."+baseDomain)||host.slice(0,-baseDomain.length-1).includes("."))){res.writeHead(404);return res.end()}
    const headers={...req.headers}
    for(const k of ["forwarded","x-forwarded-host","x-forwarded-for","x-forwarded-proto","x-forwarded-port","x-real-ip"])delete headers[k]
    headers["x-forwarded-proto"]="https"
    const upstream=http.request({hostname:"127.0.0.1",port:gatewayPort,path:req.url,method:req.method,headers,timeout:30000},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)})
    upstream.on("timeout",()=>upstream.destroy());upstream.on("error",()=>{if(!res.headersSent)res.writeHead(503);res.end()});req.on("aborted",()=>upstream.destroy());req.pipe(upstream)
  })
  // Default loopback-only. Cloud Agents that forward ports to the user's browser
  // set SAAS_CLOUD_LOCAL_BROWSE=1 so TLS/API bind 0.0.0.0 (still no public DNS).
  const cloudBrowse=process.env.SAAS_CLOUD_LOCAL_BROWSE==="1"
  const bindHost=cloudBrowse?"0.0.0.0":"127.0.0.1"
  const trustedProxy=cloudBrowse?"127.0.0.1/32,::1/128":"127.0.0.1/32"
  await new Promise((resolve,reject)=>{ingress.once("error",reject);ingress.listen(tlsPort,bindHost,resolve)})
  const env={...process.env,PORT:String(gatewayPort),SAAS_STOREFRONT_PORT:String(nextPort),SAAS_BIND_HOST:bindHost,SAAS_SECURE_COOKIES:"true",SAAS_TRUSTED_PROXY:trustedProxy,SAAS_RUN_WORKER:"true",
    SAAS_LOCALHOST_ACCESS:String(localhostAccess),
    SAAS_DATABASE_URL:databaseUrl,SAAS_BASE_DOMAIN:baseDomain,SAAS_PLATFORM_ACTOR_ID:process.env.SAAS_PLATFORM_ACTOR_ID||"platform_admin",SAAS_OBJECT_ROOT:path.join(directory,"objects"),SAAS_DEMO_CONFIG_FILE:path.join(directory,"demo-config.json"),
    SAAS_JWT_SECRET:runtime.jwtSecret,SAAS_CONTEXT_SECRET:runtime.contextSecret,SAAS_IDENTITY_SECRET:runtime.namespaceSecret,SAAS_PLATFORM_KEY:runtime.platformKey,SAAS_PAYMENT_KEY:runtime.paymentKey}
  const child=spawn(process.execPath,[path.join(__dirname,"start-m6.cjs")],{cwd:path.join(__dirname,".."),env,stdio:["ignore","inherit","inherit"]})
  let stopping=false
  const stop=()=>{if(stopping)return;stopping=true;ingress.close();child.kill("SIGTERM")}
  process.once("SIGTERM",stop);process.once("SIGINT",stop)
  child.once("exit",()=>{ingress.close();process.exitCode=child.exitCode||0});child.once("error",()=>{stop();process.exitCode=1})
  console.log(JSON.stringify({mode:cloudBrowse?"cloud-local-browse-development":"owned-loopback-development",bind_host:bindHost,tls_port:tlsPort,gateway_port:gatewayPort,localhost_access:localhostAccess,merchant_email:demo.merchant.email,platform_demo_email:demo.platform.email,production_release:false}))
}
if(require.main===module)main().catch(()=>{console.error("Local demonstration startup failed; private credentials were not printed");process.exitCode=1})
module.exports={main}
