"use strict"
const fs=require("node:fs"),path=require("node:path")
const {assertDemoMode}=require("./self-service.cjs")
function readPrivateJson(file){
  if(!path.isAbsolute(file)||fs.realpathSync(path.dirname(file))!==path.dirname(file)||
      (fs.statSync(path.dirname(file)).mode&0o077)!==0)throw new Error("Demo configuration requires a private canonical directory")
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o077)!==0||s.size>4096)throw new Error("Demo configuration must be a private regular file")
    return JSON.parse(fs.readFileSync(fd,"utf8"))}finally{fs.closeSync(fd)}
}
function loadDemoConfig(baseDomain){
  const file=process.env.SAAS_DEMO_CONFIG_FILE;if(!file)return undefined
  assertDemoMode(baseDomain,{merchant:{email:`demo@${baseDomain}`,password:"check-password-123"},platform:{email:`demo-admin@${baseDomain}`,password:"check-password-123"}})
  const value=readPrivateJson(file);assertDemoMode(baseDomain,value);return value
}
module.exports={loadDemoConfig,readPrivateJson}
