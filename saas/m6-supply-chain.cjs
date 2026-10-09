"use strict"
// Inventory the frozen lock graphs, including nested/virtual/optional packages.
// Registry advisories are observations, not a runtime reachability assessment.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), https = require("node:https")
const YAML = require("yaml"), semver = require("semver"), { HttpsProxyAgent } = require("https-proxy-agent")
const root = path.resolve(__dirname, "..")
const hash = data => crypto.createHash("sha256").update(data).digest("hex")
function inventory(directory, scope) {
  const lockPath = path.join(directory, "yarn.lock"), lock = YAML.parse(fs.readFileSync(lockPath, "utf8"))
  const resolutions = JSON.parse(fs.readFileSync(path.join(directory,"package.json"),"utf8")).resolutions || {}
  const state = YAML.parse(fs.readFileSync(path.join(directory, "node_modules/.yarn-state.yml"), "utf8"))
  const installed = new Map(), evidence = [], nativeBundles = new Map()
  for (const value of Object.values(state)) for (const location of value.locations || []) {
    const base = path.resolve(directory, location), manifest = path.join(base, "package.json")
    if (!fs.existsSync(manifest)) throw new Error("Installed dependency metadata missing")
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")), files = fs.readdirSync(base).filter(n => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(n))
    const texts = files.filter(n => fs.statSync(path.join(base, n)).isFile()).map(n => {
      const data = fs.readFileSync(path.join(base, n))
      return { path: path.relative(root, path.join(base, n)), sha256: hash(data), text: data.toString("utf8") }
    })
    const workspace = !location.includes("node_modules/") || fs.realpathSync(base).startsWith(path.join(root, "packages/"))
    let license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type || pkg.licenses?.map(x => x.type).join(" OR ")
    if (!license && workspace) license = "MIT"
    if (!license && texts.some(t => t.text.includes("Permission is hereby granted, free of charge"))) license = "MIT"
    installed.set(`${pkg.name}@${pkg.version}`, { license, workspace, location: path.relative(root, base), files: texts.map(({text,...x})=>x) })
    if(pkg.name.startsWith("@img/sharp-libvips-")&&fs.existsSync(path.join(base,"versions.json"))){
      const versionBytes=fs.readFileSync(path.join(base,"versions.json"))
      const binaries=fs.readdirSync(path.join(base,"lib")).filter(n=>/\.so[.0-9]*$|\.dylib$|\.dll$/.test(n)).map(n=>{
        const filename=path.join(base,"lib",n),bytes=fs.readFileSync(filename)
        return {path:path.relative(root,filename),bytes:bytes.length,sha256:hash(bytes)}
      })
      nativeBundles.set(`${pkg.name}@${pkg.version}`,{scope,parent:`${pkg.name}@${pkg.version}`,bundleLicense:license||null,
        versionFile:{path:path.relative(root,path.join(base,"versions.json")),sha256:hash(versionBytes)},binaries,versions:JSON.parse(versionBytes)})
    }
    if (!workspace) for (const file of texts) evidence.push({ package: `${pkg.name}@${pkg.version}`, ...file })
  }
  const components = [], aliases = new Map(), entries = []
  for (const [key, value] of Object.entries(lock)) {
    if (key === "__metadata") continue
    const descriptor = key.split(", ")[0], name = /^(@[^/]+\/[^@]+|[^@]+)@/.exec(descriptor)?.[1]
    if(!name)throw new Error("Invalid lockfile package descriptor")
    const ref = `${scope}:${value.resolution}`, metadata = installed.get(`${name}@${value.version}`)
    const workspace = value.resolution.includes("@workspace:")
    const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${value.version}`
    const properties = [{ name: "saas:scope", value: scope }, { name: "saas:resolution", value: value.resolution },
      { name: "saas:installed", value: String(!!metadata) }, { name: "saas:optional-platform-package", value: String(!!value.conditions) }]
    if (value.checksum) properties.push({name:"yarn:checksum",value:String(value.checksum)})
    if (metadata) properties.push({name:"saas:installed-path",value:metadata.location})
    const license = metadata?.license || (workspace ? "MIT" : undefined)
    let licenseEntry
    if(license){try{require("spdx-expression-parse")(license);licenseEntry={expression:license}}catch{licenseEntry={license:{name:license}}}}
    components.push({ type: "library", "bom-ref": ref, name, version: value.version, purl,
      ...(licenseEntry ? { licenses: [licenseEntry] } : {}), properties })
    for (const alias of key.split(", ")) aliases.set(alias, ref)
    entries.push({ref,name,value,license,evidence:metadata?.files||[]})
  }
  const dependencies = entries.map(({ref,name:parent,value}) => ({ref,dependsOn:Object.entries(value.dependencies||{}).map(([name,range])=>{
    range=String(range)
    const override = resolutions[`${parent}/${name}`] || resolutions[`${name}@${range.replace(/^npm:/,"")}`] || resolutions[name]
    const selected = override || range
    const patchAlias=override?.startsWith("patch:") ? [...aliases.keys()].filter(k=>k.startsWith(`${name}@${selected}::`)) : []
    const resolved = aliases.get(`${name}@${selected}`) || aliases.get(`${name}@npm:${selected}`) || (patchAlias.length===1?aliases.get(patchAlias[0]):undefined) ||
      (override && entries.filter(e=>e.name===name).length===1 ? entries.find(e=>e.name===name).ref : undefined)
    if (!resolved) throw new Error(`Unresolved lock graph edge: ${name}@${range}`)
    return resolved
  }).filter((x,i,a)=>a.indexOf(x)===i)}))
  for(const bundle of nativeBundles.values())for(const [name,version]of Object.entries(bundle.versions)){
    const ref=`${scope}:embedded:${bundle.parent}:${name}`
    components.push({type:"library","bom-ref":ref,name,version:String(version),purl:`pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
      properties:[{name:"saas:scope",value:scope},{name:"saas:embedded-in",value:bundle.parent},{name:"saas:individual-license-review",value:"pending"}]})
    dependencies.push({ref,dependsOn:[]})
    for(const parent of entries.filter(e=>`${e.name}@${e.value.version}`===bundle.parent))dependencies.find(d=>d.ref===parent.ref).dependsOn.push(ref)
  }
  return {scope,lockSha256:hash(fs.readFileSync(lockPath)),components,dependencies,entries,evidence,nativeBundles:[...nativeBundles.values()],
    installedPairs:[...installed.keys()],workspaceCount:entries.filter(e=>e.value.resolution.includes("@workspace:")).length}
}
function registryAudit(versions) {
  const data = Buffer.from(JSON.stringify(versions)), proxy = process.env.HTTPS_PROXY || process.env.https_proxy
  return new Promise((resolve,reject)=>{
    const request = https.request("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
      method:"POST",...(proxy?{agent:new HttpsProxyAgent(proxy)}:{}),
      headers:{"content-type":"application/json","content-length":data.length,"user-agent":"store-saas-m6-inventory"},timeout:30000
    }, res=>{const chunks=[];res.on("data",d=>chunks.push(d));res.on("error",reject);res.on("end",()=>{
      if(res.statusCode!==200)return reject(new Error(`Registry advisory HTTP ${res.statusCode}`))
      try{resolve(JSON.parse(Buffer.concat(chunks)))}catch{reject(new Error("Invalid registry advisory response"))}
    })})
    request.on("error",()=>reject(new Error("Registry advisory transport failed; check managed proxy/policy")))
    request.on("timeout",()=>request.destroy());request.end(data)
  })
}
async function main(output) {
  if (!output || !path.isAbsolute(output) || output===root || output.startsWith(root+"/node_modules/")) throw new Error("An explicit absolute artifact directory is required")
  fs.mkdirSync(output,{recursive:true})
  const graphs=[inventory(root,"backend-admin"),inventory(path.join(__dirname,"storefront"),"storefront")]
  const versions={}
  for(const graph of graphs)for(const entry of graph.entries)if(!entry.value.resolution.includes("@workspace:")&&semver.valid(entry.value.version))
    (versions[entry.name]??=new Set()).add(entry.value.version)
  const observedAt=new Date().toISOString(), advisory=await registryAudit(Object.fromEntries(Object.entries(versions).map(([k,v])=>[k,[...v].sort()])))
  const findings=[]
  for(const [name,items]of Object.entries(advisory))for(const item of items) {
    const affected=graphs.flatMap(g=>g.entries.filter(e=>e.name===name&&semver.satisfies(e.value.version,item.vulnerable_versions,{includePrerelease:true})).map(e=>({scope:g.scope,version:e.value.version,ref:e.ref})))
    if(affected.length)findings.push({...item,name,affected,assessment:"untriaged"})
  }
  const licenses=graphs.flatMap(g=>g.entries.map(e=>({scope:g.scope,name:e.name,version:e.value.version,resolution:e.value.resolution,license:e.license||null,files:e.evidence})))
  const evidence=new Map()
  for(const graph of graphs)for(const item of graph.evidence)evidence.set(item.package+":"+item.sha256,item)
  fs.writeFileSync(path.join(output,"THIRD-PARTY-NOTICES.txt"),["Store SaaS installed dependency license/NOTICE texts. This is not legal clearance of optional uninstalled packages or base images.",...([...evidence.values()].map(e=>`\n===== ${e.package} | ${e.path} | SHA256 ${e.sha256} =====\n${e.text}`))].join("\n"))
  const sbom={bomFormat:"CycloneDX",specVersion:"1.6",version:1,metadata:{timestamp:observedAt,component:{type:"application",name:"store-saas",version:"M6"}},
    components:graphs.flatMap(g=>g.components),dependencies:graphs.flatMap(g=>g.dependencies)}
  const summary={observedAt,registry:"https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",scopes:graphs.map(g=>({scope:g.scope,lockSha256:g.lockSha256,components:g.components.length,installedNameVersions:g.installedPairs.length,workspaces:g.workspaceCount})),
    missingLicenseMetadata:licenses.filter(x=>!x.license).map(({scope,name,version,resolution})=>({scope,name,version,resolution})),
    advisories:findings.length,severity:Object.fromEntries(["critical","high","moderate","low"].map(s=>[s,findings.filter(f=>f.severity===s).length])),
    nativeBundles:graphs.flatMap(g=>g.nativeBundles).length,nativeEmbeddedComponents:graphs.flatMap(g=>g.nativeBundles).reduce((n,b)=>n+Object.keys(b.versions).length,0),
    releaseClearance:false,limits:["Advisories must be assessed against gateway, storefront and build paths; counts are not exploitability.","The npm advisory query covers lock packages, not embedded native libraries; native and image/OS vulnerabilities need separate review.","Optional uninstalled packages and image/OS components need separate distribution review.","Sharp/libvips native versions and binary hashes are inventoried; bundle LGPL and individual embedded-library source/NOTICE obligations still require actual-distribution review.","Installed notices must accompany distributed artifacts; this inventory does not certify legal compliance."]}
  for(const [name,value]of Object.entries({"sbom.cdx.json":sbom,"dependency-licenses.json":licenses,"dependency-advisories.json":findings,"native-components.json":graphs.flatMap(g=>g.nativeBundles),"supply-chain-summary.json":summary}))
    fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+"\n")
  console.log(JSON.stringify({...summary,missingLicenseMetadata:summary.missingLicenseMetadata.length}))
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={inventory,registryAudit}
