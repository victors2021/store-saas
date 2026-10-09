"use strict"
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {createFixture}=require('./m3-test-fixture.cjs'),{migrateM5}=require('./migrate-m5.cjs')
test('M4 to M5 adopts real existing object sizes and rejects incompatible old runtimes',{timeout:120000},async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'saas-m5-upgrade-')),checks=[];let f,complete=false
  const check=async(name,task)=>{await task();checks.push({name,passed:true});console.log('PASS',name)}
  try {
    f=await createFixture({fixtureStage:'m4_upgrade',payments:true,objectRoot:path.join(directory,'objects')})
    const [A]=f.tenants;await f.seedCommerce()
    const image=Buffer.from([137,80,78,71,13,10,26,10]),file=await f.inStore(A,()=>f.app.m2Runtime.resources.file.upload({filename:'old.png',mimeType:'image/png',content:image,isPublic:true}))
    const row=(await f.db.query('SELECT storage_key FROM saas_file WHERE id=$1',[file.id])).rows[0],target=path.join(f.config.objectRoot,row.storage_key)
    const options={applicationRole:'medusa_saas_m4_upgrade_app',allowNativeReferenceSeeds:true,objectRoot:f.config.objectRoot}
    await check('missing historical objects abort the additive migration without partial schema',async()=>{
      fs.renameSync(target,target+'.held')
      try{await assert.rejects(migrateM5(f.db,options))}finally{fs.renameSync(target+'.held',target)}
      assert.equal((await f.db.query("SELECT count(*)::int n FROM saas_control.isolation_migration WHERE id='0007-operations'")).rows[0].n,0)
      assert.equal((await f.db.query("SELECT to_regclass('saas_control.plan_assignment') AS name")).rows[0].name,null)
    })
    await check('existing tenant products and ready object bytes become verified quota usage',async()=>{
      const migration=await migrateM5(f.db,options);assert(migration.some(x=>x.id==='0007-operations'&&x.applied))
      const usage=(await f.db.query('SELECT product_count,upload_bytes FROM saas_control.tenant_usage WHERE tenant_id=$1',[A.id])).rows[0]
      assert.equal(usage.product_count,'1');assert.equal(usage.upload_bytes,'8')
      assert((await migrateM5(f.db,options)).every(x=>!x.applied))
    })
    await check('old upload writers fail closed rather than silently undercounting migrated bytes',async()=>{
      await assert.rejects(f.inStore(A,()=>f.app.m2Runtime.resources.file.upload({filename:'old-writer.png',mimeType:'image/png',content:image,isPublic:true})),/M5 upload reservation/)
      assert.equal((await f.db.query('SELECT count(*)::int n FROM saas_file')).rows[0].n,1)
    })
    await check('M5 restart reads the original media with the original tenant and integrity digest',async()=>{
      f.config.operations=true;await f.restart()
      const response=await f.request(A.hostname,'GET',`/store/media/${file.id}`)
      assert.equal(response.status,200);assert(response.raw.equals(image))
    })
    complete=true
  }finally{if(f)await f.close();fs.rmSync(directory,{recursive:true,force:true})
    if(process.env.SAAS_M5_UPGRADE_RESULT)fs.writeFileSync(process.env.SAAS_M5_UPGRADE_RESULT,JSON.stringify({milestone:'M5',success:complete,passed:checks.length,checks},null,2))}
})
