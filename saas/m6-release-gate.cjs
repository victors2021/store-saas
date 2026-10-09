"use strict"
// Fail-closed operator gate. File hashes bind evidence to reviewed source; they
// do not authenticate a reviewer or replace payment/restore/TLS observations.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{execFileSync}=require("node:child_process")
const root=path.resolve(__dirname,".."),hash=data=>crypto.createHash("sha256").update(data).digest("hex")
const ORDINARY_P95_MS=300
const gates=["tenant_isolation","dependency_security","distribution_license","reference_performance","stripe_sandbox","authorized_live_payment","off_host_restore","deployment_tls_and_rollback","independent_security_review","merchant_pilot_feedback"]
function sourceManifest(){
  const files=execFileSync("git",["ls-files","-z","--cached","--others","--exclude-standard","--","saas","packages","integration-tests",".yarn","LICENSE","package.json","yarn.lock",".yarnrc.yml"],{cwd:root,encoding:"utf8",maxBuffer:16*1024*1024}).split("\0").filter(Boolean)
  const selected=[...new Set(files)].filter(p=>/^(saas\/|packages\/|integration-tests\/|\.yarn\/|LICENSE$|package.json$|yarn.lock$|\.yarnrc.yml$)/.test(p)).sort()
  return selected.map(p=>{
    const filename=path.join(root,p)
    if(!fs.lstatSync(filename).isFile()||fs.realpathSync(filename)!==filename)throw new Error("SOURCE_PATH_INVALID")
    return `${hash(fs.readFileSync(filename))}  ${p}`
  }).join("\n")+"\n"
}
function evidenceFile(base,evidence){
  if(!evidence||typeof evidence.file!=="string"||!evidence.file||path.isAbsolute(evidence.file)||! /^[a-f0-9]{64}$/.test(evidence.sha256||""))throw new Error("EVIDENCE_REFERENCE_INVALID")
  const filename=path.resolve(base,evidence.file)
  if(!filename.startsWith(base+path.sep)||fs.realpathSync(filename)!==filename||!fs.lstatSync(filename).isFile())throw new Error("EVIDENCE_PATH_INVALID")
  const bytes=fs.readFileSync(filename);if(hash(bytes)!==evidence.sha256)throw new Error("EVIDENCE_DIGEST_MISMATCH")
  return bytes
}
function checkRelease(filename,{now=Date.now()}={}){
  const blockers=[];let record,base
  try{
    if(!path.isAbsolute(filename))throw new Error("ABSOLUTE_RELEASE_RECORD_REQUIRED")
    base=path.dirname(fs.realpathSync(filename));record=JSON.parse(fs.readFileSync(filename,"utf8"))
    if(record.format!==1||record.target!=="pilot")throw new Error("RELEASE_RECORD_INVALID")
    const manifest=evidenceFile(base,record.source_manifest)
    if(!manifest.equals(Buffer.from(sourceManifest())))throw new Error("SOURCE_MANIFEST_MISMATCH")
    if(hash(fs.readFileSync(path.join(root,"LICENSE")))!=="f792b19e548b936c2a9a8e489e2f21e3b5a91e482910c57d9c9508f8933789af")throw new Error("MIT_PROVENANCE_MISMATCH")
    if(fs.existsSync(path.join(root,"ENTERPRISE-LICENSE.md")))throw new Error("UNREVIEWED_ENTERPRISE_SOURCE")
  }catch(e){return {ready:false,blockers:[{gate:"release_record",code:/^[A-Z_]+$/.test(e.message)?e.message:"RELEASE_RECORD_UNREADABLE"}],checked_at:new Date(now).toISOString()}}
  for(const name of gates){
    const gate=record.gates?.[name]
    try{
      if(gate?.status!=="passed")throw new Error(gate?.status==="deferred"?"DEFERRED_RELEASE_ACCEPTANCE":"ACCEPTANCE_PENDING")
      const observed=Date.parse(gate.observed_at)
      if(!Number.isFinite(observed)||observed>now+60000||now-observed>7*86400000)throw new Error("EVIDENCE_STALE_OR_UNDATED")
      if(gate.source_sha256!==record.source_manifest.sha256)throw new Error("EVIDENCE_SOURCE_MISMATCH")
      const report=JSON.parse(evidenceFile(base,gate.evidence))
      if(report.complete!==true||report.source_sha256!==record.source_manifest.sha256)throw new Error("REPORT_INCOMPLETE_OR_DIFFERENT_SOURCE")
      if(name==="reference_performance"&&(!["duration_seconds","rps","tenants","products_per_tenant","variants_per_tenant","orders_per_tenant","p95_ms","error_5xx_rate","checkout_concurrent"].every(k=>Number.isFinite(report[k])&&report[k]>=0)||report.duration_seconds<1800||report.rps<20||report.tenants<10||report.products_per_tenant<1000||report.variants_per_tenant<2000||report.orders_per_tenant<10000||report.p95_ms>ORDINARY_P95_MS||report.error_5xx_rate>=.01||report.checkout_concurrent<20||report.checkout_no_oversell!==true||report.reference_hardware_verified!==true||report.history_profile_reviewed!==true||report.queue_converged!==true||report.resource_growth_reviewed!==true))throw new Error("PERFORMANCE_NOT_QUALIFIED")
      if(name==="dependency_security"&&report.unresolved_runtime_high_critical!==0)throw new Error("DEPENDENCY_RISK_UNRESOLVED")
      if(name==="distribution_license"&&report.actual_distributed_artifacts_reviewed!==true)throw new Error("DISTRIBUTION_REVIEW_PENDING")
      if(name==="stripe_sandbox"&&(report.real_stripe!==true||report.independent_accounts!==2||report.official_tls_callbacks!==true||report.elements_3ds!==true))throw new Error("PAYMENT_FIXTURE_IS_NOT_VENDOR_ACCEPTANCE")
      if(name==="authorized_live_payment"&&(report.user_authorized!==true||report.actual_payment_and_refund!==true))throw new Error("LIVE_PAYMENT_ACCEPTANCE_PENDING")
      if(name==="off_host_restore"&&(report.separate_physical_host!==true||report.actual_copy_and_restore!==true))throw new Error("LOCAL_RESTORE_IS_NOT_OFF_HOST_ACCEPTANCE")
      if(name==="deployment_tls_and_rollback"&&(report.actual_target_tls_host_ingress!==true||report.matching_code_database_objects_keys_rollback!==true||report.actual_alarm_delivery!==true))throw new Error("TARGET_DEPLOYMENT_ACCEPTANCE_PENDING")
      if(name==="independent_security_review"&&(report.independent_reviewer!==true||report.unresolved_severe_findings!==0))throw new Error("INDEPENDENT_REVIEW_PENDING")
      if(name==="merchant_pilot_feedback"&&report.actual_merchant_walkthrough!==true)throw new Error("MERCHANT_WALKTHROUGH_PENDING")
    }catch(e){blockers.push({gate:name,code:/^[A-Z_]+$/.test(e.message)?e.message:"EVIDENCE_UNREADABLE"})}
  }
  return {ready:blockers.length===0,blockers,checked_at:new Date(now).toISOString(),source_sha256:record.source_manifest.sha256}
}
if(require.main===module){
  if(process.argv[2]==="manifest")process.stdout.write(sourceManifest())
  else {const result=checkRelease(process.argv[2]||"");console.log(JSON.stringify(result,null,2));if(!result.ready)process.exitCode=2}
}
module.exports={gates,sourceManifest,checkRelease}
