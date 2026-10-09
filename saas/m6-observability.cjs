"use strict"
const {performance}=require("node:perf_hooks")
const buckets=[.05,.1,.3,.8,1,2,5]
const escape=value=>String(value).replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/"/g,'\\"')
function createMetrics({category,maxSeries=10000}){
  const series=new Map(),started=Date.now();let dropped=0
  const observe=(req,res,next)=>{
    const began=performance.now();let recorded=false
    const finish=()=>{
      if(recorded)return;recorded=true
      const tenant=/^[a-z]+_[A-Za-z0-9]{1,128}$/.test(req.saasObservedTenant||"")?req.saasObservedTenant:"none"
      const route=category(req.path),method=["GET","POST","DELETE","PATCH","PUT","HEAD","OPTIONS"].includes(req.method)?req.method:"OTHER"
      const status=res.writableFinished?Math.floor(res.statusCode/100)+"xx":"499",key=JSON.stringify([tenant,route,method,status])
      let row=series.get(key)
      if(!row&&series.size>=maxSeries){dropped++;return}
      if(!row){row={tenant,route,method,status,count:0,sum:0,buckets:buckets.map(()=>0)};series.set(key,row)}
      const seconds=(performance.now()-began)/1000;row.count++;row.sum+=seconds
      buckets.forEach((upper,i)=>{if(seconds<=upper)row.buckets[i]++})
    }
    res.once("finish",finish);res.once("close",finish);next()
  }
  function format({pool,health}){
    const lines=["# HELP saas_http_requests_total Bounded request categories; excludes query values, paths, actors and payloads.","# TYPE saas_http_requests_total counter",
      "# TYPE saas_http_duration_seconds histogram","# TYPE saas_metrics_dropped_total counter",`saas_metrics_dropped_total ${dropped}`]
    for(const row of series.values()){
      const labels=`tenant_id="${escape(row.tenant)}",route="${escape(row.route)}",method="${row.method}",status="${row.status}"`
      lines.push(`saas_http_requests_total{${labels}} ${row.count}`)
      buckets.forEach((upper,i)=>lines.push(`saas_http_duration_seconds_bucket{${labels},le="${upper}"} ${row.buckets[i]}`))
      lines.push(`saas_http_duration_seconds_bucket{${labels},le="+Inf"} ${row.count}`,`saas_http_duration_seconds_count{${labels}} ${row.count}`,`saas_http_duration_seconds_sum{${labels}} ${row.sum}`)
    }
    const gauges={saas_process_started_seconds:started/1000,saas_process_rss_bytes:process.memoryUsage().rss,
      saas_process_heap_used_bytes:process.memoryUsage().heapUsed,saas_db_pool_total:pool.totalCount,saas_db_pool_idle:pool.idleCount,
      saas_db_pool_waiting:pool.waitingCount,saas_metrics_series:series.size,saas_ready:health.ready?1:0,
      saas_database_ready:health.checks.database?1:0,saas_worker_ready:health.checks.worker?1:0}
    for(const [name,value]of Object.entries(gauges))lines.push(`# TYPE ${name} gauge`,`${name} ${value}`)
    return lines.join("\n")+"\n"
  }
  return {observe,format}
}
// Safe alert codes only; notification transport is operator-configured. This
// module never sends mail, Slack messages or other external notifications.
function evaluateOperations(snapshot){
  const alerts=[...(Array.isArray(snapshot?.alerts)?snapshot.alerts:[])]
  if(!snapshot?.health?.checks?.database)alerts.push({tenant_id:null,code:"DATABASE_UNAVAILABLE"})
  if(!snapshot?.health?.checks?.worker)alerts.push({tenant_id:null,code:"WORKER_UNAVAILABLE"})
  return [...new Map(alerts.filter(x=>/^[A-Z][A-Z_]{0,63}$/.test(x.code||"")&&
    (x.tenant_id===null||/^[a-z]+_[A-Za-z0-9]{1,128}$/.test(x.tenant_id||""))).map(x=>[JSON.stringify([x.tenant_id,x.code]),{tenant_id:x.tenant_id,code:x.code}])).values()]
}
module.exports={createMetrics,evaluateOperations}
