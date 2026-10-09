"use strict"
// M6 keeps the verified 0007 M5 schema. A separate release gate covers external
// evidence; this launcher is also usable for isolated development rehearsals.
if(process.env.NODE_ENV==="production"||process.env.SAAS_RELEASE_MANIFEST){
  const {checkRelease}=require("./m6-release-gate.cjs"),result=checkRelease(process.env.SAAS_RELEASE_MANIFEST||"")
  if(!result.ready){console.error(JSON.stringify({code:"SAAS_RELEASE_BLOCKED",blockers:result.blockers}));process.exitCode=2}
  else require("./start-m5.cjs")
}else require("./start-m5.cjs")
