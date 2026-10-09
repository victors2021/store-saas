"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),{spawnSync}=require("node:child_process")
const {sourceManifest,gates,checkRelease}=require("./m6-release-gate.cjs")
const hash=b=>crypto.createHash("sha256").update(b).digest("hex")
test("release gate rejects missing, stale, different-source and local-only external evidence",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"saas-m6-gates-")),now=Date.now(),checked=[]
  try{
    const manifest=sourceManifest();fs.writeFileSync(path.join(dir,"source.sha256"),manifest)
    const sha=hash(manifest),record={format:1,target:"pilot",source_manifest:{file:"source.sha256",sha256:sha},gates:Object.fromEntries(gates.map(g=>[g,{status:"pending"}]))},filename=path.join(dir,"release.json")
    const check=()=>{fs.writeFileSync(filename,JSON.stringify(record));return checkRelease(filename,{now})}
    assert.equal(check().ready,false);assert.equal(check().blockers.length,gates.length);checked.push("all missing external gates remain blocking")
    const name="off_host_restore",report={complete:true,source_sha256:sha,separate_physical_host:false,actual_copy_and_restore:false}
    fs.writeFileSync(path.join(dir,"local-restore.json"),JSON.stringify(report))
    record.gates[name]={status:"passed",observed_at:new Date(now).toISOString(),source_sha256:sha,evidence:{file:"local-restore.json",sha256:hash(JSON.stringify(report))}}
    assert.equal(check().blockers.find(g=>g.gate===name).code,"LOCAL_RESTORE_IS_NOT_OFF_HOST_ACCEPTANCE");checked.push("same-host restoration cannot masquerade as off-host acceptance")
    record.gates[name].status="deferred";assert.equal(check().blockers.find(g=>g.gate===name).code,"DEFERRED_RELEASE_ACCEPTANCE")
    record.gates[name].status="passed";record.gates[name].observed_at=new Date(now-8*86400000).toISOString();assert.equal(check().blockers.find(g=>g.gate===name).code,"EVIDENCE_STALE_OR_UNDATED");checked.push("deferred and stale evidence remains blocking")
    const performanceReport={complete:true,source_sha256:sha,queue_converged:true,resource_growth_reviewed:true}
    fs.writeFileSync(path.join(dir,"performance.json"),JSON.stringify(performanceReport))
    record.gates.reference_performance={status:"passed",observed_at:new Date(now).toISOString(),source_sha256:sha,evidence:{file:"performance.json",sha256:hash(JSON.stringify(performanceReport))}}
    assert.equal(check().blockers.find(g=>g.gate==="reference_performance").code,"PERFORMANCE_NOT_QUALIFIED")
    checked.push("missing numeric thresholds, reference hardware and reviewed history cannot qualify performance")
    Object.assign(performanceReport,{duration_seconds:1800,rps:20,tenants:10,products_per_tenant:1000,variants_per_tenant:2000,orders_per_tenant:10000,p95_ms:300,error_5xx_rate:0,checkout_concurrent:20,checkout_no_oversell:true,reference_hardware_verified:true,history_profile_reviewed:true})
    const savePerformance=()=>{const bytes=JSON.stringify(performanceReport);fs.writeFileSync(path.join(dir,"performance.json"),bytes);record.gates.reference_performance.evidence.sha256=hash(bytes)}
    savePerformance();assert(!check().blockers.some(g=>g.gate==="reference_performance"))
    performanceReport.p95_ms=301;savePerformance();assert.equal(check().blockers.find(g=>g.gate==="reference_performance").code,"PERFORMANCE_NOT_QUALIFIED")
    checked.push("the updated ordinary API target accepts 300 ms and rejects 301 ms even with all other performance facts satisfied")
    record.source_manifest.sha256="0".repeat(64);assert.equal(check().blockers[0].code,"EVIDENCE_DIGEST_MISMATCH");checked.push("changed artifact content fails before gate evaluation")
    const child=spawnSync(process.execPath,["saas/start-m6.cjs"],{cwd:path.resolve(__dirname,".."),env:{...process.env,NODE_ENV:"production",SAAS_RELEASE_MANIFEST:""},encoding:"utf8"})
    assert.equal(child.status,2);assert.match(child.stderr,/SAAS_RELEASE_BLOCKED/);checked.push("production M6 launcher refuses pending release before database/network startup")
    if(process.env.SAAS_M6_GATE_RESULT)fs.writeFileSync(process.env.SAAS_M6_GATE_RESULT,JSON.stringify({milestone:"M6",complete:true,passed:checked.length,checks:checked.map(name=>({name,passed:true}))},null,2)+"\n")
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
