"use strict"
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),{execFileSync}=require("node:child_process"),{Client}=require("pg")
const {createFixture}=require("./m3-test-fixture.cjs"),{createStripeFixture}=require("./m4-stripe-fixture.cjs"),{seedM4Browser}=require("./m4-browser-seed.cjs"),{tenantSQL}=require("./tenant-sql.cjs"),{ROUTES}=require("./m1-application.cjs")
const root=path.resolve(__dirname,"..")
const prefixes={products:"prod",orders:"order",carts:"cart","payment-collections":"pay_col",payments:"pay","inventory-items":"iitem","stock-locations":"sloc","sales-channels":"sc",regions:"reg",tenants:"tenant",uploads:"file"}
const sample=route=>route.split("/").map((part,i,parts)=>{
  if(!part.startsWith(":"))return part
  const name=part.slice(1)
  if(name==="actor_type")return "user"
  if(name==="auth_provider")return "emailpass"
  if(name==="token")return "invalid-token"
  return (prefixes[parts[i-1]]||"prod")+"_M6Unknown"
}).join("/")
function nativeEntries(){
  const files=execFileSync("rg",["--files","packages/medusa/src/api","-g","route.ts"],{cwd:root,encoding:"utf8"}).trim().split("\n")
  return files.flatMap(file=>{const text=fs.readFileSync(path.join(root,file),"utf8"),url="/"+file.replace("packages/medusa/src/api/","").replace(/\/route.ts$/,"").replace(/\[([^\]]+)\]/g,":$1")
    const ts=require("typescript"),ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),verbs=new Set()
    for(const node of ast.statements){
      if(node.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
        if(ts.isVariableStatement(node))for(const d of node.declarationList.declarations)if(ts.isIdentifier(d.name))verbs.add(d.name.text)
        if(ts.isFunctionDeclaration(node)&&node.name)verbs.add(node.name.text)
      }
      if(ts.isExportDeclaration(node)&&node.exportClause&&ts.isNamedExports(node.exportClause))for(const e of node.exportClause.elements)verbs.add(e.name.text)
    }
    return [...verbs].filter(v=>/^(GET|POST|DELETE|PUT|PATCH|OPTIONS|HEAD)$/.test(v)).map(method=>({method,path:url,sample:sample(url),source:file}))})
}
test("M6 complete mounted/closed entry matrix, RLS and media security",{timeout:600000},async()=>{
  if(process.env.SAAS_M6_SECURITY_RESET!=="1")throw new Error("Explicit owned security fixture reset required")
  process.env.SAAS_M5_SECURITY_TEST_RESET="1"
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"saas-m6-security-")),stripe=await createStripeFixture(),checks=[],matrix=[]
  let f,complete=false
  const check=async(name,fn)=>{await fn();checks.push({name,passed:true});console.log("PASS",name)}
  try{
    f=await createFixture({fixtureStage:"m5_security",payments:true,operations:true,testStripeFactory:stripe.factory,objectRoot:path.join(directory,"objects")})
    const [A,B]=f.tenants,owner=t=>({authorization:`Bearer ${t.ownerToken}`})
    await f.seedCommerce();await seedM4Browser(f,stripe)
    const customerToken=f.ok(await f.request(B.hostname,"POST","/auth/customer/emailpass",{email:"m4-browser-buyer@example.test",password:f.credentials.password})).token
    const mounted=f.app.web._router.stack.filter(x=>x.route).flatMap(x=>Object.keys(x.route.methods).map(method=>({method:method.toUpperCase(),path:x.route.path,sample:sample(x.route.path)})))
    const unique=[...new Map(mounted.map(e=>[e.method+" "+e.path,e])).values()]
    const allowed=[...ROUTES,...f.app.m2Runtime.routes,...f.app.m3Runtime.routes,...f.app.m4Runtime.routes,...f.app.m5Runtime.routes]
    const callbacks=e=>e.path.startsWith("/hooks/stripe/"),publicHealth=e=>e.path.startsWith("/health"),publicPlatform=e=>["/platform","/platform/main.js","/platform/style.css"].includes(e.path)
    await check("every mounted business endpoint rejects a sibling merchant or customer credential",async()=>{
      for(const e of unique){
        if(callbacks(e)||publicHealth(e)||publicPlatform(e))continue
        if(matrix.length%100===0)await f.db.query("DELETE FROM saas_control.rate_window")
        const isPlatform=e.path.startsWith("/platform/"),host=isPlatform?"platform.shops.example.test":A.hostname
        const response=await f.request(host,e.method,e.sample,e.method==="GET"?undefined:{},{authorization:`Bearer ${e.path.startsWith("/store/")?customerToken:B.ownerToken}`})
        assert.ok([401,404].includes(response.status),`${e.method} ${e.path}: ${response.status}`)
        matrix.push({...e,category:isPlatform?"platform":e.path.startsWith("/store/")?"store":"merchant",probe:"sibling-bound-token",status:response.status})
      }
    })
    await check("all native entry points outside the reviewed gateway allowlist are actually closed",async()=>{
      for(const e of nativeEntries()){
        if(allowed.some(([method,re])=>method===e.method&&re.test(e.sample)))continue
        if(matrix.length%100===0)await f.db.query("DELETE FROM saas_control.rate_window")
        const response=await f.request(A.hostname,e.method,e.sample,e.method==="GET"?undefined:{},owner(A))
        assert.equal(response.status,404,`${e.method} ${e.path}`)
        matrix.push({...e,category:"native-disabled",probe:"valid-owner-on-closed-endpoint",status:response.status})
      }
    })
    await check("implicit HEAD requests cannot bypass platform authorization or tenant business routing",async()=>{
      assert.equal((await f.request("platform.shops.example.test","HEAD","/platform/tenants")).status,401)
      assert.equal((await f.request(A.hostname,"HEAD","/admin/orders",null,owner(A))).status,404)
      assert.equal((await f.request(A.hostname,"HEAD","/store/products")).status,404)
    })
    await check("all FORCE RLS tables hide sibling rows and the runtime role cannot disable or bypass RLS",async()=>{
      const tables=(await f.db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity ORDER BY c.relname")).rows
      assert.equal(tables.length,140)
      await f.inStore(A,()=>tenantSQL(f.app.pool,async c=>{for(const {relname}of tables){assert.match(relname,/^[a-zA-Z0-9_]+$/);assert.equal((await c.query(`SELECT count(*)::int n FROM "${relname}" WHERE tenant_id=$1`,[B.id])).rows[0].n,0)}}))
      const c=await f.app.pool.connect()
      try{
        for(const statement of ["SET ROLE postgres","ALTER TABLE product DISABLE ROW LEVEL SECURITY"])
          await assert.rejects(c.query(statement),e=>e.code==="42501")
        await c.query("BEGIN");await c.query("SET LOCAL row_security=off")
        await assert.rejects(c.query("SELECT count(*) FROM product"),e=>e.code==="42501");await c.query("ROLLBACK")
        assert.equal((await c.query("SELECT count(*)::int n FROM product")).rows[0].n,0)
      }finally{await c.query("ROLLBACK");c.release()}
    })
    await check("mixed tenant success/rollback traffic does not retain a tenant GUC in reused pool connections",async()=>{
      await Promise.all(Array.from({length:160},(_,n)=>f.inStore(n%2?A:B,()=>tenantSQL(f.app.pool,async c=>{
        const own=n%2?A:B,other=n%2?B:A
        assert.equal((await c.query("SELECT count(*)::int n FROM product WHERE tenant_id=$1",[own.id])).rows[0].n,1)
        assert.equal((await c.query("SELECT count(*)::int n FROM product WHERE tenant_id=$1",[other.id])).rows[0].n,0)
        if(n%7===0)throw new Error("intentional rollback")
      })).catch(e=>{if(e.message!=="intentional rollback")throw e})))
      const clients=await Promise.all(Array.from({length:4},()=>f.app.pool.connect()))
      try{for(const c of clients){assert.equal((await c.query("SELECT nullif(current_setting('app.tenant_id',true),'') tenant")).rows[0].tenant,null);assert.equal((await c.query("SELECT count(*)::int n FROM product")).rows[0].n,0)}}finally{clients.forEach(c=>c.release())}
    })
    await check("scalar catalog channel queries keep tenant RLS, product intersection and soft-deleted link filtering",async()=>{
      const lookup=(tenant,filters)=>f.inStore(tenant,()=>f.app.nativeApp.query.graph({entity:"product_sales_channel",fields:["product_id"],filters}))
      assert.deepEqual((await lookup(A,{sales_channel_id:[A.channel.id]})).data,[{product_id:A.product.id}])
      assert.deepEqual((await lookup(A,{sales_channel_id:[B.channel.id]})).data,[])
      assert.deepEqual((await lookup(A,{sales_channel_id:[A.channel.id],product_id:[B.product.id]})).data,[])
      assert.deepEqual((await lookup(A,{sales_channel_id:[A.channel.id],product_id:[]})).data,[])
      await f.inStore(A,()=>tenantSQL(f.app.pool,c=>c.query("UPDATE product_sales_channel SET deleted_at=now() WHERE product_id=$1",[A.product.id])))
      try{assert.deepEqual((await lookup(A,{sales_channel_id:[A.channel.id]})).data,[])}finally{
        await f.inStore(A,()=>tenantSQL(f.app.pool,c=>c.query("UPDATE product_sales_channel SET deleted_at=NULL WHERE product_id=$1",[A.product.id])))
      }
      assert.deepEqual((await lookup(B,{sales_channel_id:[B.channel.id]})).data,[{product_id:B.product.id}])
    })
    await check("order compensation cannot delete sibling orders or active native order links",async()=>{
      const before=(await f.db.query("SELECT tenant_id,order_id,cart_id,deleted_at FROM order_cart ORDER BY tenant_id,order_id")).rows
      // The sibling hard-delete may return an empty native result or not found;
      // neither is authority to clear links under the sibling RLS context.
      await f.inStore(B,()=>f.app.nativeApp.modules.order.deleteOrders([A.orderId])).catch(e=>{if(e.type!=="not_found"&&e.code!=="TENANT_REFERENCE_NOT_FOUND")throw e})
      assert.deepEqual((await f.db.query("SELECT tenant_id,order_id,cart_id,deleted_at FROM order_cart ORDER BY tenant_id,order_id")).rows,before)
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "order" WHERE id=$1 AND tenant_id=$2',[A.orderId,A.id])).rows[0].n,1)
      await assert.rejects(f.inStore(A,()=>f.app.nativeApp.modules.order.deleteOrders([A.orderId])))
      assert.deepEqual((await f.db.query("SELECT tenant_id,order_id,cart_id,deleted_at FROM order_cart ORDER BY tenant_id,order_id")).rows,before)
      assert.equal((await f.db.query('SELECT count(*)::int n FROM "order" WHERE id=$1 AND tenant_id=$2',[A.orderId,A.id])).rows[0].n,1)
    })
    await check("missing verified context fails at module, Query, cache, file and job boundaries",async()=>{
      for(const task of [()=>f.app.nativeApp.modules.product.listProducts({}),()=>f.app.nativeApp.query.graph({entity:"product",fields:["id"]}),
        async()=>f.app.nativeApp.modules.workflows.run("m6-missing-context",{}),
        ()=>f.app.m2Runtime.resources.cache.retrieve("missing"),()=>f.app.m2Runtime.resources.file.retrieve("file_missing"),()=>f.app.m2Runtime.jobs.enqueue("event:test",{data:{}})])
        await assert.rejects(task,e=>/^TENANT_/.test(e.code||""))
      await assert.rejects(f.inStore(A,()=>f.app.nativeApp.modules.workflows.run("m6-invalid-manager",{},{manager:{}})),e=>e.code==="TENANT_MANAGER_FORBIDDEN")
      await assert.rejects(f.inStore(A,()=>f.app.nativeApp.modules.workflows.run("m6-invalid-tenant",{input:{tenant_id:B.id}})),e=>e.code==="TENANT_FIELD_FORBIDDEN")
    })
    await check("media deletion and pending cleanup reject namespace symlinks without touching other tenant bytes or releasing quota",async()=>{
      const upload=()=>f.app.m2Runtime.resources.file.upload({filename:"m6.txt",content:Buffer.from("M6 owned object")})
      const a=await f.inStore(A,upload),b=await f.inStore(B,upload),ns=t=>crypto.createHash("sha256").update(t.id).digest("hex")
      const namespace=path.join(f.config.objectRoot,ns(A)),saved=namespace+"-saved",foreign=path.join(f.config.objectRoot,ns(B))
      fs.renameSync(namespace,saved);fs.symlinkSync(foreign,namespace,"dir")
      fs.writeFileSync(path.join(foreign,a.id),"foreign sentinel")
      try{
        await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.resources.file.delete(a.id)),/Symlink object directories/)
        assert.equal(fs.readFileSync(path.join(foreign,a.id),"utf8"),"foreign sentinel")
        await f.db.query("UPDATE saas_file SET created_at=now()-interval '2 hours' WHERE tenant_id=$1 AND id=$2",[A.id,a.id])
        await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.resources.file.sweep()),/Symlink object directories/)
        assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_file WHERE tenant_id=$1 AND id=$2",[A.id,a.id])).rows[0].n,1)
      }finally{fs.unlinkSync(namespace);fs.renameSync(saved,namespace);fs.unlinkSync(path.join(foreign,a.id))}
      const value=await f.inStore(B,()=>f.app.m2Runtime.resources.file.retrieve(b.id));assert.equal(value.content.toString(),"M6 owned object")
      await f.inStore(A,()=>f.app.m2Runtime.resources.file.sweep())
      const victim=await f.inStore(A,upload),target=path.join(namespace,victim.id),copy=target+"-copy"
      fs.renameSync(target,copy);fs.symlinkSync(path.join(foreign,b.id),target)
      try{await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.resources.file.retrieve(victim.id)),/regular owned objects/);await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.resources.file.delete(victim.id)),/regular owned objects/)}finally{fs.unlinkSync(target);fs.renameSync(copy,target)}
      await f.db.query("UPDATE saas_file SET created_at=now()-interval '2 hours' WHERE tenant_id=$1 AND id=$2",[A.id,victim.id]);await f.inStore(A,()=>f.app.m2Runtime.resources.file.sweep())
    })
    await check("bounded orphan scans advance past the first thousand recent files and reach older orphan objects",async()=>{
      const namespace=path.join(f.config.objectRoot,crypto.createHash("sha256").update(A.id).digest("hex"));fs.mkdirSync(namespace,{recursive:true})
      const names=Array.from({length:1001},(_,n)=>"file_"+n.toString(16).padStart(40,"0"))
      for(const name of names)fs.writeFileSync(path.join(namespace,name),"bounded sweep")
      fs.utimesSync(path.join(namespace,names.at(-1)),new Date(Date.now()-7*3600000),new Date(Date.now()-7*3600000))
      const first=await f.inStore(A,()=>f.app.m2Runtime.resources.file.sweep()),second=await f.inStore(A,()=>f.app.m2Runtime.resources.file.sweep())
      assert.equal(first.orphans_removed,0);assert.equal(second.orphans_removed,1);assert.ok(!fs.existsSync(path.join(namespace,names.at(-1))))
    })
    await check("stored object namespace mismatches are refused even before filesystem access",async()=>{
      await f.inStore(A,()=>f.app.m2Runtime.resources.file.upload({filename:"namespace.txt",content:Buffer.from("namespace") }))
      await assert.rejects(f.inStore(A,()=>tenantSQL(f.app.pool,c=>c.query("UPDATE saas_file SET storage_key=$1 WHERE tenant_id=$2",[crypto.createHash("sha256").update(B.id).digest("hex")+"/file_"+"a".repeat(40),A.id]))),e=>e.code==="23514")
    })
    complete=true
  }finally{
    if(f)await f.close();await stripe.close();fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M6_SECURITY_RESULT)fs.writeFileSync(process.env.SAAS_M6_SECURITY_RESULT,JSON.stringify({milestone:"M6",complete,passed:checks.length,checks,
      mountedBusinessProbes:matrix.filter(x=>x.category!=="native-disabled").length,disabledNativeProbes:matrix.filter(x=>x.category==="native-disabled").length,matrix,
      independentReview:false,limits:["This is a development acceptance suite; an independent reviewer is still required.","The browser and signed callback entry matrices are in the complete M3-M5 regressions.","The application DB role is trusted: SQL injection capable of setting arbitrary tenant GUCs remains outside RLS authority enforcement and requires independent review."]},null,2)+"\n")
  }
})
