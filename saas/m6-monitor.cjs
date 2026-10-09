"use strict"
const http=require("node:http"),https=require("node:https"),{HttpsProxyAgent}=require("https-proxy-agent"),{evaluateOperations}=require("./m6-observability.cjs")
async function probe({baseUrl,host,platformKey,allowLoopback=false}){
  const url=new URL(baseUrl)
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/"||!platformKey||Buffer.byteLength(platformKey)<32)
    throw new Error("A bare platform origin and separate operator credential are required")
  if(url.protocol!=="https:"&&!(allowLoopback&&url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname)))
    throw new Error("Remote monitoring requires HTTPS")
  if(host!==undefined&&!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host))throw new Error("Invalid explicit monitor Host")
  return new Promise(resolve=>{
    const proxy=process.env.HTTPS_PROXY||process.env.https_proxy,transport=url.protocol==="https:"?https:http
    const request=transport.get(new URL("/platform/operations",url),{headers:{authorization:`Bearer ${platformKey}`,...(host?{host}: {})},
      ...(url.protocol==="https:"&&proxy?{agent:new HttpsProxyAgent(proxy)}:{}),timeout:5000},res=>{
      const chunks=[];let bytes=0
      res.on("data",chunk=>{bytes+=chunk.length;if(bytes>1024*1024)request.destroy();else chunks.push(chunk)})
      res.on("error",()=>resolve({healthy:false,alerts:[{tenant_id:null,code:"MONITOR_TRANSPORT_FAILED"}]}))
      res.on("end",()=>{
        if(res.statusCode!==200)return resolve({healthy:false,alerts:[{tenant_id:null,code:res.statusCode===401?"MONITOR_AUTH_FAILED":"API_UNAVAILABLE"}]})
        try{const value=JSON.parse(Buffer.concat(chunks)),alerts=evaluateOperations(value);resolve({healthy:alerts.length===0,alerts,off_host_backup_verified:value.off_host_backup_verified===true})}
        catch{resolve({healthy:false,alerts:[{tenant_id:null,code:"MONITOR_RESPONSE_INVALID"}]})}
      })
    })
    request.on("error",()=>resolve({healthy:false,alerts:[{tenant_id:null,code:"API_UNREACHABLE"}]}))
    request.on("timeout",()=>request.destroy())
  })
}
if(require.main===module)probe({baseUrl:process.env.SAAS_MONITOR_BASE_URL,platformKey:process.env.SAAS_PLATFORM_KEY}).then(result=>{
  console.log(JSON.stringify({observed_at:new Date().toISOString(),...result}));if(!result.healthy)process.exitCode=2
}).catch(()=>{console.error("Monitoring configuration invalid; supply SAAS_MONITOR_BASE_URL and SAAS_PLATFORM_KEY securely");process.exitCode=1})
module.exports={probe}
