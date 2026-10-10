"use strict"
// The current runtime verifies M5 plus additive 0008 platform login and 0009 self-service. A release gate covers external
// evidence; this launcher is also usable for isolated development rehearsals.
if(process.env.NODE_ENV==="production"||process.env.SAAS_RELEASE_MANIFEST){
  const {checkRelease}=require("./m6-release-gate.cjs"),result=checkRelease(process.env.SAAS_RELEASE_MANIFEST||"")
  if(!result.ready){console.error(JSON.stringify({code:"SAAS_RELEASE_BLOCKED",blockers:result.blockers}));process.exitCode=2}
  else require("./start-m5.cjs")
}else require("./start-m5.cjs")
