"use strict"
// Offline operator tool. No public backup/restore API and no automatic overwrite.
const fs=require("node:fs/promises"),fss=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),os=require("node:os")
const {spawn,execFile}=require("node:child_process"),{promisify}=require("node:util"),{pipeline}=require("node:stream/promises")
const {Client}=require("pg"),{maintenanceLock}=require("./m5-policy.cjs")
const exec=promisify(execFile),magic=Buffer.from("SAASM5B1"),maximum=8*1024*1024*1024
const validRole=x=>typeof x==="string"&&/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(x)
const validDatabase=x=>typeof x==="string"&&/^[a-z][a-z0-9_]{2,62}$/.test(x)&&!["postgres","template0","template1"].includes(x)
const hexKey=x=>{if(typeof x!=="string"||!/^[a-fA-F0-9]{64}$/.test(x))throw new Error("A separate 32-byte hex backup key is required");return Buffer.from(x,"hex")}
const hash=async file=>{const h=crypto.createHash("sha256");for await(const chunk of fss.createReadStream(file))h.update(chunk);return h.digest("hex")}
async function missing(target){try{await fs.lstat(target);return false}catch(e){if(e.code==="ENOENT")return true;throw e}}
async function plainParent(target) {
  const parent=path.dirname(target)
  await fs.mkdir(parent,{recursive:true,mode:0o700})
  if(await fs.realpath(parent)!==path.resolve(parent))throw new Error("Backup and restore output parents must not contain symlinks")
}
function keys(input) {
  const result={}
  for(const name of ["jwtSecret","contextSecret","namespaceSecret","platformKey","paymentKey"]){
    if(typeof input?.[name]!=="string"||Buffer.byteLength(input[name])<32)throw new Error("The complete runtime recovery key set is required")
    result[name]=input[name]
  }
  hexKey(result.paymentKey);return result
}
function protect(data,key) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(Buffer.from("saas-m5-recovery-keys-v1"))
  return Buffer.concat([iv,cipher.update(data),cipher.final(),cipher.getAuthTag()])
}
function unprotect(data,key) {
  const cipher=crypto.createDecipheriv("aes-256-gcm",key,data.subarray(0,12));cipher.setAAD(Buffer.from("saas-m5-recovery-keys-v1"));cipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()])
}
async function connectionOptions(url) {
  const parsed=new URL(url),local=['127.0.0.1','localhost'].includes(parsed.hostname)
  if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error("A PostgreSQL connection URL is required")
  const user=decodeURIComponent(parsed.username),database=decodeURIComponent(parsed.pathname.slice(1))
  if(!validRole(user)||!validDatabase(database))throw new Error("Explicit named PostgreSQL database and role are required")
  const mode=parsed.searchParams.get('sslmode')||(local?'disable':'verify-full')
  if(!['disable','verify-full'].includes(mode)||(!local&&mode!=='verify-full'))
    throw new Error("Remote backup and restore require verified PostgreSQL TLS")
  let ssl=false
  if(mode==='verify-full') {
    ssl={rejectUnauthorized:true}
    const certificate=parsed.searchParams.get('sslrootcert')
    if(certificate) {
      if(!path.isAbsolute(certificate))throw new Error("Absolute PostgreSQL CA certificate path required")
      ssl.ca=await fs.readFile(certificate,'utf8')
    }
  }
  // Construct the driver settings explicitly: URL sslmode parsing must not
  // override certificate verification on the administrative control connection.
  return {host:parsed.hostname,port:Number(parsed.port||5432),database,
    user,password:decodeURIComponent(parsed.password),ssl,connectionTimeoutMillis:10000}
}
async function pgCommand(tool,url,arguments_,tools={}) {
  const parsed=new URL(url),db=decodeURIComponent(parsed.pathname.slice(1)),user=decodeURIComponent(parsed.username)
  if(!validDatabase(db)||!validRole(user))throw new Error("Explicit named PostgreSQL database and role are required")
  const environment={...process.env,PGHOST:parsed.hostname,PGPORT:parsed.port||"5432",PGDATABASE:db,PGUSER:user,
    PGPASSWORD:decodeURIComponent(parsed.password),PGCONNECT_TIMEOUT:"10",
    PGSSLMODE:parsed.searchParams.get("sslmode")||(['127.0.0.1','localhost'].includes(parsed.hostname)?"disable":"verify-full")}
  if(!['127.0.0.1','localhost'].includes(parsed.hostname)&&environment.PGSSLMODE!=="verify-full")throw new Error("Remote backup and restore require verified PostgreSQL TLS")
  if(parsed.searchParams.get("sslrootcert"))environment.PGSSLROOTCERT=parsed.searchParams.get("sslrootcert")
  let command=tool,args=arguments_
  if(tools.container) {
    if(!/^[a-zA-Z0-9_.-]+$/.test(tools.container)||!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.password)
      throw new Error("Container PostgreSQL tools support explicit owned loopback trust fixtures only")
    const inspected=await exec("docker",["--host=unix:///var/run/docker.sock","inspect","--format","{{range (index .NetworkSettings.Ports \"5432/tcp\")}}{{.HostIp}}:{{.HostPort}}{{end}}",tools.container])
    if(inspected.stdout.trim()!==`127.0.0.1:${parsed.port||5432}`)throw new Error("PostgreSQL tool container does not match the selected database")
    command="docker";args=["--host=unix:///var/run/docker.sock","exec","-i",tools.container,tool,"--username",user,"--dbname",db,...arguments_]
  } else args=["--dbname",db,...arguments_]
  const child=spawn(command,args,{env:environment,stdio:["pipe","pipe","pipe"]})
  let stderr="";child.stderr.on("data",data=>{stderr=(stderr+data).slice(-4096)})
  const completion=new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>child.kill("SIGTERM"),600000);deadline.unref()
    child.once("error",()=>{clearTimeout(deadline);reject(new Error(`PostgreSQL ${tool} tool is unavailable`))})
    child.once("exit",code=>{clearTimeout(deadline);code===0?resolve():reject(new Error(`PostgreSQL ${tool} failed; no credential-bearing diagnostics are emitted`))})
  })
  // Observe immediately even if a streaming error finishes first.
  completion.catch(()=>{})
  return {child,completion}
}
async function createBackup({databaseUrl,applicationRole,objectRoot,output,backupKey,recoveryKeys,tools={}}) {
  const key=hexKey(backupKey),keyring=keys(recoveryKeys)
  if(Object.values(keyring).some(value=>value===backupKey||(/^[a-f0-9]{64}$/i.test(value)&&value.toLowerCase()===backupKey.toLowerCase())))throw new Error("Backup encryption key must be separate from runtime keys")
  if(!validRole(applicationRole)||!path.isAbsolute(objectRoot)||!path.isAbsolute(output))throw new Error("Explicit absolute backup paths and application role required")
  const controlConnection=await connectionOptions(databaseUrl)
  if(!(await missing(output)))throw new Error("Backup output already exists; refusing to overwrite")
  await plainParent(output)
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),"saas-m5-backup-")),staged=output+".partial-"+crypto.randomUUID()
  const client=new Client(controlConnection),objects=[];let connected=false,locked=false
  try {
    await client.connect();connected=true
    const authority=(await client.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]
    if(!authority?.rolsuper&&!authority?.rolbypassrls)throw new Error("Full backup requires an explicit administrative RLS-bypass connection")
    locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[maintenanceLock])).rows[0].ok
    if(!locked)throw new Error("Application writes are in progress; retry backup after they finish")
    const ledger=(await client.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows
    if(!ledger.some(row=>row.id==="0007-operations"&&row.checksum===require("./migrations/0007-operations.cjs").checksum))throw new Error("Backup requires the current M5 migration")
    const dumpFile=path.join(temporary,"database.dump"),dump=await pgCommand("pg_dump",databaseUrl,["--format=custom","--no-owner"],tools)
    dump.child.stdin.end()
    await Promise.all([pipeline(dump.child.stdout,fss.createWriteStream(dumpFile,{flags:"wx",mode:0o600})),dump.completion])
    await fs.mkdir(path.join(temporary,"objects"),{mode:0o700})
    const files=(await client.query("SELECT id,tenant_id,storage_key,byte_size,content_hash,storage_state FROM saas_file ORDER BY storage_key")).rows
    const resolvedRoot=files.length?await fs.realpath(objectRoot):path.resolve(objectRoot)
    if(resolvedRoot!==path.resolve(objectRoot))throw new Error("Backup object root must not contain symlinks")
    for(const row of files) {
      if(!/^[a-f0-9]{64}\/file_[a-f0-9]{40}$/.test(row.storage_key))throw new Error("Invalid backup object path")
      if(row.storage_key!==crypto.createHash('sha256').update(row.tenant_id).digest('hex')+'/'+row.id)throw new Error("Backup object namespace differs from its tenant")
      const source=path.join(resolvedRoot,row.storage_key)
      if(await missing(source)){if(row.storage_state==='ready')throw new Error("A ready object is missing; backup is incomplete");continue}
      if(await fs.realpath(source)!==source||!(await fs.lstat(source)).isFile())throw new Error("Backup excludes symlink and non-regular objects")
      const digest=await hash(source),size=(await fs.stat(source)).size
      if(size!==Number(row.byte_size)||(row.content_hash&&digest!==row.content_hash))throw new Error("Backup object integrity mismatch")
      const relative="objects/"+row.storage_key,target=path.join(temporary,relative)
      await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.copyFile(source,target,fss.constants.COPYFILE_EXCL);await fs.chmod(target,0o600)
      objects.push({path:relative,size,sha256:digest})
    }
    const recovery=path.join(temporary,"recovery-keys.enc")
    await fs.writeFile(recovery,protect(Buffer.from(JSON.stringify(keyring)),key),{flag:"wx",mode:0o600})
    const manifest={format:1,stage:"M5",created_at:new Date().toISOString(),source_database:decodeURIComponent(new URL(databaseUrl).pathname.slice(1)),application_role:applicationRole,
      isolation_migrations:ledger,objects,database_sha256:await hash(dumpFile),recovery_sha256:await hash(recovery),quiescence:"M5 business mutations and workers fenced"}
    await fs.writeFile(path.join(temporary,"manifest.json"),JSON.stringify(manifest),{flag:"wx",mode:0o600})
    const archive=path.join(temporary,"bundle.tar")
    await exec("tar",["--create","--format=ustar","--file",archive,"--directory",temporary,"database.dump","manifest.json","recovery-keys.enc","objects"])
    if((await fs.stat(archive)).size>maximum)throw new Error("Pilot backup exceeds the supported 8 GiB archive limit")
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv);cipher.setAAD(magic)
    await fs.writeFile(staged,Buffer.concat([magic,iv]),{flag:"wx",mode:0o600})
    await pipeline(fss.createReadStream(archive),cipher,fss.createWriteStream(staged,{flags:"a",mode:0o600}))
    await fs.appendFile(staged,cipher.getAuthTag())
    const handle=await fs.open(staged,"r");try{await handle.sync()}finally{await handle.close()}
    await fs.link(staged,output);await fs.unlink(staged)
    const receipt={output,sha256:await hash(output),bytes:(await fs.stat(output)).size,objects:objects.length,stage:"M5",off_host_copy:false}
    await client.query("INSERT INTO saas_control.backup_receipt(id,sha256,byte_size,object_count) VALUES($1,$2,$3,$4)",['backup_'+crypto.randomBytes(16).toString('hex'),receipt.sha256,receipt.bytes,receipt.objects])
    return receipt
  } finally {
    if(connected){try{if(locked)await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[maintenanceLock])}finally{await client.end()}}
    await fs.rm(staged,{force:true});await fs.rm(temporary,{recursive:true,force:true})
  }
}
async function validateTar(file) {
  const handle=await fs.open(file,"r"),entries=new Set();let offset=0,terminated=false
  try {
    const stat=await handle.stat();if(stat.size>maximum)throw new Error("Restore archive too large")
    while(offset+512<=stat.size) {
      const header=Buffer.alloc(512);await handle.read(header,0,512,offset)
      if(header.every(x=>x===0)){terminated=true;break}
      const string=(start,length)=>header.subarray(start,start+length).toString("utf8").split("\0")[0]
      const octal=(start,length)=>{const value=string(start,length).trim();if(!/^[0-7]+$/.test(value))throw new Error("Invalid tar numeric field");return parseInt(value,8)}
      const checksum=octal(148,8);let actual=0;for(let n=0;n<512;n++)actual+=n>=148&&n<156?32:header[n]
      if(actual!==checksum||string(257,5)!=="ustar")throw new Error("Invalid restore archive header")
      const name=(string(345,155)?string(345,155)+"/":"")+string(0,100),type=string(156,1),size=octal(124,12),normalized=name.replace(/\/$/,"")
      if(!["0","","5"].includes(type)||entries.has(normalized)||!Number.isSafeInteger(size)||size>maximum||
        !/^(database\.dump|manifest\.json|recovery-keys\.enc|objects(?:\/[a-f0-9]{64}(?:\/file_[a-f0-9]{40})?)?)$/.test(normalized))throw new Error("Unsafe or duplicate restore archive entry")
      if(type==="5"&&size!==0)throw new Error("Invalid directory entry")
      entries.add(normalized);offset+=512+Math.ceil(size/512)*512
      if(offset>stat.size)throw new Error("Truncated restore archive")
    }
    if(!terminated||!["database.dump","manifest.json","recovery-keys.enc","objects"].every(name=>entries.has(name)))throw new Error("Incomplete restore archive")
    // Ignore only zero padding after the standard archive terminator.
    while(offset<stat.size){const bytes=Buffer.alloc(Math.min(65536,stat.size-offset));await handle.read(bytes,0,bytes.length,offset);if(bytes.some(x=>x!==0))throw new Error("Unexpected data after tar terminator");offset+=bytes.length}
    return entries
  } finally{await handle.close()}
}
async function restoreBackup({input,backupKey,databaseUrl,applicationRole,objectRoot,keysOutput,confirmEmptyDatabase,tools={}}) {
  const key=hexKey(backupKey),parsed=new URL(databaseUrl),database=decodeURIComponent(parsed.pathname.slice(1))
  const targetConnection=await connectionOptions(databaseUrl)
  if(!validDatabase(database)||confirmEmptyDatabase!==database||!validRole(applicationRole)||!path.isAbsolute(input)||!path.isAbsolute(objectRoot))throw new Error("Explicit new database name, role, paths and matching restore confirmation required")
  if(!(await missing(objectRoot))||(keysOutput&&!(await missing(keysOutput))))throw new Error("Restore output exists; refusing to overwrite")
  if(keysOutput&&!path.isAbsolute(keysOutput))throw new Error("Absolute recovery key output required")
  const repositoryRoot=path.resolve(__dirname,"..")
  if(keysOutput&&(path.resolve(keysOutput)===repositoryRoot||path.resolve(keysOutput).startsWith(repositoryRoot+path.sep)))throw new Error("Recovery keys cannot be exported into the source repository")
  await plainParent(objectRoot)
  if(keysOutput)await plainParent(keysOutput)
  const temporary=await fs.mkdtemp(path.join(path.dirname(objectRoot),".saas-m5-restore-"));let admin
  try {
    const stat=await fs.lstat(input);if(!stat.isFile()||stat.size<36||stat.size>maximum+36)throw new Error("Invalid encrypted backup file")
    const handle=await fs.open(input,"r"),header=Buffer.alloc(20),tag=Buffer.alloc(16)
    try{await handle.read(header,0,20,0);await handle.read(tag,0,16,stat.size-16)}finally{await handle.close()}
    if(!header.subarray(0,8).equals(magic))throw new Error("Unsupported backup format")
    const archive=path.join(temporary,"bundle.tar"),decipher=crypto.createDecipheriv("aes-256-gcm",key,header.subarray(8));decipher.setAAD(magic);decipher.setAuthTag(tag)
    try{await pipeline(fss.createReadStream(input,{start:20,end:stat.size-17}),decipher,fss.createWriteStream(archive,{flags:"wx",mode:0o600}))}
    catch{throw new Error("Backup authentication failed; database was not touched")}
    const entries=await validateTar(archive),extracted=path.join(temporary,"extracted");await fs.mkdir(extracted,{mode:0o700})
    await exec("tar",["--extract","--file",archive,"--directory",extracted,"--no-same-owner","--no-same-permissions","--keep-old-files"])
    const manifest=JSON.parse(await fs.readFile(path.join(extracted,"manifest.json"),"utf8"))
    if(manifest.format!==1||manifest.stage!=="M5"||manifest.application_role!==applicationRole||manifest.source_database===database||!Array.isArray(manifest.objects)||!Array.isArray(manifest.isolation_migrations))throw new Error("Restore manifest does not match the selected target")
    if(await hash(path.join(extracted,"database.dump"))!==manifest.database_sha256||await hash(path.join(extracted,"recovery-keys.enc"))!==manifest.recovery_sha256)throw new Error("Restore payload hash mismatch")
    const expected=new Set(["database.dump","manifest.json","recovery-keys.enc","objects"])
    for(const row of manifest.objects){
      if(!/^objects\/[a-f0-9]{64}\/file_[a-f0-9]{40}$/.test(row.path)||!Number.isSafeInteger(row.size)||row.size<0||row.size>5242880)throw new Error("Invalid manifest object")
      expected.add(row.path);expected.add(path.posix.dirname(row.path))
      if((await fs.stat(path.join(extracted,row.path))).size!==row.size||await hash(path.join(extracted,row.path))!==row.sha256)throw new Error("Restored object hash mismatch")
    }
    if(expected.size!==entries.size||[...entries].some(name=>!expected.has(name)))throw new Error("Unlisted restore archive content")
    const keyring=keys(JSON.parse(unprotect(await fs.readFile(path.join(extracted,"recovery-keys.enc")),key).toString()))
    admin=new Client({...targetConnection,database:'postgres'});await admin.connect()
    if((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[database])).rowCount)throw new Error("Restore database already exists; refusing to overwrite")
    const authority=(await admin.query("SELECT rolsuper,rolbypassrls,rolcreatedb FROM pg_roles WHERE rolname=current_user")).rows[0]
    if(!authority?.rolsuper)throw new Error("An explicit administrative restore connection is required")
    const role=(await admin.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1",[applicationRole])).rows[0]
    if(role&&Object.values(role).some(Boolean))throw new Error("Unsafe target application role")
    if(!role)await admin.query(`CREATE ROLE "${applicationRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    await admin.query(`CREATE DATABASE "${database}"`)
    const restore=await pgCommand("pg_restore",databaseUrl,["--exit-on-error","--single-transaction","--no-owner"],tools)
    restore.child.stdout.resume()
    await Promise.all([pipeline(fss.createReadStream(path.join(extracted,"database.dump")),restore.child.stdin),restore.completion])
    const restored=new Client(targetConnection);await restored.connect()
    try {
      const ledger=(await restored.query("SELECT id,checksum FROM saas_control.isolation_migration ORDER BY id")).rows
      if(JSON.stringify(ledger)!==JSON.stringify(manifest.isolation_migrations))throw new Error("Restored migration ledger mismatch")
      await restored.query("DELETE FROM saas_control.worker_heartbeat; DELETE FROM saas_control.http_session; UPDATE saas_control.task_dispatch SET lease_until=now()-interval '1 second' WHERE state='running'")
      if ((await restored.query("SELECT to_regclass('saas_control.platform_login_session') name")).rows[0].name)
        await restored.query("DELETE FROM saas_control.platform_login_session")
      if ((await restored.query("SELECT to_regclass('saas_control.portal_session') name")).rows[0].name)
        await restored.query("DELETE FROM saas_control.portal_session")
      await restored.query(`SET ROLE "${applicationRole}"`)
      try{await require("./migrate-m5.cjs").verifyM5Runtime(restored)}finally{await restored.query("RESET ROLE")}
    }finally{await restored.end()}
    await fs.rename(path.join(extracted,"objects"),objectRoot)
    if(keysOutput){await fs.mkdir(path.dirname(keysOutput),{recursive:true,mode:0o700});await fs.writeFile(keysOutput,JSON.stringify(keyring),{flag:"wx",mode:0o600})}
    return {database,objectRoot,objects:manifest.objects.length,keys:keyring,keysOutput:keysOutput||null,stage:"M5",external_payment_reconciliation_required:true}
  }finally{if(admin)await admin.end();await fs.rm(temporary,{recursive:true,force:true})}
}
async function main() {
  const toolOptions=process.env.SAAS_BACKUP_PG_CONTAINER?{container:process.env.SAAS_BACKUP_PG_CONTAINER}:{}
  if(process.argv[2]==="create") {
    const result=await createBackup({databaseUrl:process.env.SAAS_BACKUP_DATABASE_URL,applicationRole:process.env.SAAS_APPLICATION_ROLE,objectRoot:process.env.SAAS_OBJECT_ROOT,
      output:process.env.SAAS_BACKUP_OUTPUT,backupKey:process.env.SAAS_BACKUP_KEY,tools:toolOptions,recoveryKeys:{jwtSecret:process.env.SAAS_JWT_SECRET,contextSecret:process.env.SAAS_CONTEXT_SECRET,namespaceSecret:process.env.SAAS_IDENTITY_SECRET,platformKey:process.env.SAAS_PLATFORM_KEY,paymentKey:process.env.SAAS_PAYMENT_KEY}})
    console.log(JSON.stringify(result))
  } else if(process.argv[2]==="restore") {
    const result=await restoreBackup({input:process.env.SAAS_BACKUP_INPUT,backupKey:process.env.SAAS_BACKUP_KEY,databaseUrl:process.env.SAAS_RESTORE_DATABASE_URL,
      applicationRole:process.env.SAAS_APPLICATION_ROLE,objectRoot:process.env.SAAS_RESTORE_OBJECT_ROOT,keysOutput:process.env.SAAS_RESTORE_KEYS_OUTPUT,
      confirmEmptyDatabase:process.env.SAAS_RESTORE_EMPTY_DATABASE,tools:toolOptions})
    const {keys:privateKeys,...safe}=result;console.log(JSON.stringify(safe))
  } else throw new Error("Use create or restore with explicit secure environment configuration")
}
if(require.main===module)main().catch(()=>{console.error("M5 backup or restore failed; existing targets were not overwritten. Inspect secure operator diagnostics.");process.exitCode=1})
module.exports={createBackup,restoreBackup,validateTar}
