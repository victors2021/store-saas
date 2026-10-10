"use strict"
const crypto=require("node:crypto"),path=require("node:path"),express=require("express"),jwt=require("jsonwebtoken")
const {normalizeEmail,validPassword,hashPassword,verifyPassword}=require("./platform-auth.cjs")
const {normalizeHost,slugValue}=require("./tenant-control.cjs"),{error}=require("./m5-policy.cjs")
const {createTenantVerifier,runWithTenant}=require("./tenant-context.cjs"),{runWithAuthActor}=require("./auth-integration.cjs")
const {tenantSQL}=require("./tenant-sql.cjs")
const templates=[
  {key:"shirt",title:"演示 · 简约棉质 T 恤",price:29,image:"demo-shirt.svg"},
  {key:"mug",title:"演示 · 日常陶瓷杯",price:18,image:"demo-mug.svg"},
  {key:"bag",title:"演示 · 轻便帆布袋",price:39,image:"demo-bag.svg"},
]
function assertDemoMode(baseDomain,demo){
  if(demo && (process.env.NODE_ENV==="production"||process.env.SAAS_RELEASE_MANIFEST||!/(^|\.)example\.test$/.test(baseDomain)))
    throw new Error("Demo login is restricted to local development on example.test")
  if(demo && (!normalizeEmail(demo.merchant?.email)||!validPassword(demo.merchant?.password)||
      !normalizeEmail(demo.platform?.email)||!validPassword(demo.platform?.password)))throw new Error("Explicit private demo credentials required")
  if(demo&&(demo.merchant.email!==`demo@${baseDomain}`||demo.platform.email!==`demo-admin@${baseDomain}`))throw new Error("Demo accounts must use the dedicated demo email identities")
}
function createSelfService({pool,baseDomain,contextSecret,namespaceSecret,secureCookies,getControl,openShop,nativeApp,rate,demo}){
  assertDemoMode(baseDomain,demo)
  const cookieName=secureCookies?"__Host-store.saas.account":"store.saas.account"
  const cookieOptions={path:"/",httpOnly:true,secure:secureCookies,sameSite:"strict"}
  const digest=(purpose,value)=>crypto.createHmac("sha256",contextSecret).update(JSON.stringify([purpose,value])).digest("hex")
  const accountDTO=a=>({id:a.id,email:a.email})
  let activeHashes=0
  async function passwordCheck(password,hash){
    if(activeHashes>=4)throw error("SAAS_RATE_LIMITED","登录繁忙，请稍后重试",429)
    activeHashes++;try{return await verifyPassword(password,hash)}finally{activeHashes--}
  }
  function origin(req){
    if(normalizeHost(req.headers.host)!==baseDomain)throw error("PORTAL_HOST_REQUIRED","请从 SaaS 官网访问",404)
    if(["x-tenant-id","tenant-id","tenant_id","x-forwarded-host"].some(k=>req.headers[k]!==undefined))throw error("TENANT_HEADER_FORBIDDEN","Direct Host required",400)
    if(secureCookies&&!req.secure)throw error("PORTAL_HTTPS_REQUIRED","请使用 HTTPS 登录",403)
    if(!["GET","HEAD"].includes(req.method)&&(req.headers.origin!==`${req.protocol}://${req.headers.host.toLowerCase()}`||
        (req.headers["sec-fetch-site"]&&req.headers["sec-fetch-site"]!=="same-origin")))throw error("PORTAL_ORIGIN_REQUIRED","请求来源不正确",403)
  }
  function input(body,keys){
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))throw error("PORTAL_INVALID_INPUT","请检查提交内容",400)
    return body
  }
  function token(req){const values=(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(x=>x.startsWith(cookieName+"="));
    return values.length===1&&/^[a-f0-9]{64}$/.test(values[0].slice(cookieName.length+1))?values[0].slice(cookieName.length+1):null}
  async function session(req){
    const t=token(req);if(!t)return null
    return (await pool.query(`SELECT a.*,s.id session_id,s.csrf_secret FROM saas_control.portal_session s
      JOIN saas_control.portal_account a ON a.id=s.account_id AND a.version=s.account_version AND a.status='active'
      WHERE s.id=$1 AND s.expires_at>now()`,[digest("portal-session",t)])).rows[0]||null
  }
  async function requireAccount(req){
    origin(req)
    if(req.headers.authorization!==undefined)throw error("PORTAL_AUTH_REQUIRED","请登录商家账号",401)
    const a=await session(req);if(!a)throw error("PORTAL_AUTH_REQUIRED","请登录商家账号",401)
    if(!["GET","HEAD"].includes(req.method)){
      const t=req.headers["x-csrf-token"]
      if(typeof t!=="string"||!/^[a-f0-9]{64}$/.test(t)||!crypto.timingSafeEqual(Buffer.from(t),Buffer.from(a.csrf_secret)))throw error("PORTAL_CSRF_REQUIRED","请刷新页面后重试",403)
    }
    return a
  }
  async function loginRate(req,email){
    await rate("portal-auth:global",60);await rate("portal-auth:ip:"+digest("ip",req.ip||"unknown"),15)
    await rate("portal-auth:email:"+digest("email",email),8)
  }
  async function issueSession(req,res,a){
    const raw=crypto.randomBytes(32).toString("hex"),csrf=crypto.randomBytes(32).toString("hex"),c=await pool.connect()
    try{await c.query("BEGIN")
      const prior=token(req);if(prior)await c.query("DELETE FROM saas_control.portal_session WHERE id=$1",[digest("portal-session",prior)])
      const inserted=await c.query(`INSERT INTO saas_control.portal_session(id,account_id,account_version,csrf_secret,expires_at)
        SELECT $1,id,version,$3,now()+interval '1 hour' FROM saas_control.portal_account WHERE id=$2 AND status='active' AND version=$4 RETURNING id`,[digest("portal-session",raw),a.id,csrf,a.version])
      if(!inserted.rowCount)throw error("PORTAL_AUTH_REQUIRED","登录状态已失效",401)
      await c.query("INSERT INTO saas_control.audit_event(actor_id,action,details) VALUES($1,'portal.login','{}')",[a.id])
      await c.query("COMMIT")
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
    res.cookie(cookieName,raw,{...cookieOptions,maxAge:3600000});res.json({account:accountDTO(a),csrf_token:csrf})
  }
  async function register(req,res){
    origin(req);if(req.headers.authorization!==undefined)throw error("PORTAL_INVALID_INPUT","注册使用邮箱和密码",400)
    const b=input(req.body,["email","password"]),email=normalizeEmail(b.email)
    if(!email||!validPassword(b.password))throw error("PORTAL_INVALID_INPUT","请输入有效邮箱和至少 12 位密码",400)
    await loginRate(req,email);await rate("portal-register:global",20)
    if(demo&&[demo.merchant.email,demo.platform.email].includes(email))throw error("PORTAL_REGISTER_FAILED","该邮箱不可注册，请登录或使用演示入口",409)
    if(activeHashes>=4)throw error("SAAS_RATE_LIMITED","注册繁忙，请稍后重试",429)
    let hash;activeHashes++;try{hash=await hashPassword(b.password)}finally{activeHashes--}
    let a
    try{a=(await pool.query("INSERT INTO saas_control.portal_account(id,email,password_hash) VALUES($1,$2,$3) RETURNING *",["acct_"+crypto.randomBytes(16).toString("hex"),email,hash])).rows[0]}
    catch(e){if(e.code==="23505")throw error("PORTAL_REGISTER_FAILED","该邮箱不可注册，请尝试登录",409);throw e}
    await issueSession(req,res,a)
  }
  async function login(req,res){
    origin(req);if(req.headers.authorization!==undefined)throw error("PORTAL_AUTH_REQUIRED","请使用邮箱登录",401)
    const b=input(req.body,["email","password"]),email=normalizeEmail(b.email)
    if(!email||!validPassword(b.password))throw error("PORTAL_LOGIN_FAILED","邮箱或密码不正确",401)
    await loginRate(req,email)
    const a=(await pool.query("SELECT * FROM saas_control.portal_account WHERE email=$1 AND status='active'",[email])).rows[0]
    if(!await passwordCheck(b.password,a?.password_hash))throw error("PORTAL_LOGIN_FAILED","邮箱或密码不正确",401)
    await issueSession(req,res,a)
  }
  const demoAccount=a=>!!demo&&a.email===demo.merchant.email
  function urls(req,slug){
    const port=new URL(`${req.protocol}://${req.headers.host}`).port,origin=`${req.protocol}://${slug}.${baseDomain}${port?":"+port:""}`
    return {storefront_url:origin+"/",admin_url:origin+"/app/",demo_admin_url:origin+"/app/login?demo=1"}
  }
  async function shops(a){return (await pool.query(`SELECT p.request_key,p.slug,p.name,p.created_at,t.id,t.status,t.owner_actor_id,t.initialization_error_code,
    coalesce(u.product_count,0)::int product_count,(SELECT count(*)::int FROM saas_control.portal_demo_product d WHERE d.tenant_id=t.id) demo_count
    FROM saas_control.portal_shop p LEFT JOIN saas_control.tenant t ON t.owner_actor_id=p.owner_actor_id AND t.slug=p.slug
    LEFT JOIN saas_control.tenant_usage u ON u.tenant_id=t.id WHERE p.account_id=$1 ORDER BY p.created_at DESC`,[a.id])).rows}
  async function list(req,res){const a=await requireAccount(req);res.json({shops:(await shops(a)).map(s=>({...s,...urls(req,s.slug),is_demo:demoAccount(a)})),max_shops:3})}
  async function createShop(req,res){
    const a=await requireAccount(req),b=input(req.body,["name","slug","password","idempotency_key","with_demo_products"])
    if(typeof b.name!=="string"||!b.name.trim()||b.name.length>120||/[\x00-\x1f\x7f]/.test(b.name)||
        typeof b.slug!=="string"||!/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(b.slug)||
        typeof b.idempotency_key!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(b.idempotency_key)||
        (b.with_demo_products!==undefined&&typeof b.with_demo_products!=="boolean"))throw error("PORTAL_INVALID_INPUT","店名、网址或创建请求不正确",400)
    slugValue(b.slug)
    const password=demoAccount(a)?demo.merchant.password:b.password
    if(!validPassword(password)||!await passwordCheck(password,a.password_hash))throw error("PORTAL_PASSWORD_REQUIRED","请确认账号登录密码",401)
    await rate("portal-open:"+a.id,5)
    const owner="usr_"+crypto.createHmac("sha256",namespaceSecret).update(JSON.stringify(["portal-owner",a.id,b.idempotency_key])).digest("hex").slice(0,26)
    const name=b.name.trim().normalize("NFC"),fingerprint=digest("portal-shop",JSON.stringify([name,b.slug])),c=await pool.connect()
    try{await c.query("BEGIN");await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["portal-open:"+a.id])
      const existing=(await c.query("SELECT * FROM saas_control.portal_shop WHERE account_id=$1 AND request_key=$2",[a.id,b.idempotency_key])).rows[0]
      if(existing&&existing.input_fingerprint!==fingerprint)throw error("PORTAL_OPEN_CONFLICT","此创建请求已绑定其他店铺信息",409)
      if(!existing){if((await c.query("SELECT count(*)::int n FROM saas_control.portal_shop WHERE account_id=$1",[a.id])).rows[0].n>=3)throw error("PORTAL_SHOP_LIMIT","当前每个账号最多创建 3 家网店",409)
        await c.query("INSERT INTO saas_control.portal_shop(account_id,request_key,owner_actor_id,slug,name,input_fingerprint) VALUES($1,$2,$3,$4,$5,$6)",[a.id,b.idempotency_key,owner,b.slug,name,fingerprint])}
      await c.query("COMMIT")
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
    const t=await openShop({email:a.email,password,ownerActorId:owner,actorId:owner,name,slug:b.slug,idempotencyKey:"portal_"+owner.slice(4)})
    let demoError=null
    if(t.status==="active"&&b.with_demo_products){try{await sampleProducts(a,t,"add",req)}catch(e){demoError="模拟商品未全部添加，可在工作台重试"}}
    const row=(await shops(a)).find(s=>s.id===t.id)
    res.status(t.status==="active"?201:202).json({shop:{...row,...urls(req,t.slug),is_demo:demoAccount(a)},demo_error:demoError})
  }
  const verifier=createTenantVerifier({secret:contextSecret,issuer:"saas-portal",audience:"portal-operation",lookupMembership:i=>getControl().authorizeMembership(i)})
  async function sampleProducts(a,t,action,req){
    const lock=await pool.connect(),key=JSON.stringify(["m4-commerce",t.id]);let locked=false
    try{
      locked=(await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok",[key])).rows[0].ok
      if(!locked)throw error("PORTAL_SHOP_BUSY","店铺正在处理其他操作，请稍后重试",409)
      const current=await getControl().getTenant(t.id)
      if(current?.status!=="active"||current.ownerActorId!==t.owner_actor_id&&current.ownerActorId!==t.ownerActorId)throw error("PORTAL_SHOP_UNAVAILABLE","店铺当前不可修改",423)
      const context=await verifier(jwt.sign({tenant_id:t.id},contextSecret,{subject:current.ownerActorId,issuer:"saas-portal",audience:"portal-operation",expiresIn:"5m"}))
      await runWithTenant(context,()=>runWithAuthActor("user",async()=>{
        const flows=require("@medusajs/core-flows"),product=nativeApp.modules.product
        for(const spec of templates){
          let tracked=(await pool.query("SELECT product_id FROM saas_control.portal_demo_product WHERE tenant_id=$1 AND template_key=$2",[t.id,spec.key])).rows[0]
          const live=tracked?(await product.listProducts({id:tracked.product_id}))[0]:null
          if(action==="remove"){
            if(live)await flows.deleteProductsWorkflow(nativeApp.sharedContainer).run({input:{ids:[live.id]}})
            if(tracked)await pool.query("DELETE FROM saas_control.portal_demo_product WHERE tenant_id=$1 AND template_key=$2",[t.id,spec.key])
            continue
          }
          if(live)continue
          if(tracked){
            const deleted=await tenantSQL(pool,c=>c.query("SELECT deleted_at FROM product WHERE id=$1",[tracked.product_id]))
            if(deleted.rows[0]?.deleted_at){await pool.query("DELETE FROM saas_control.portal_demo_product WHERE tenant_id=$1 AND template_key=$2",[t.id,spec.key]);tracked=null}
          }
          if(!tracked){const id="prod_"+crypto.randomBytes(13).toString("hex");await pool.query("INSERT INTO saas_control.portal_demo_product(tenant_id,template_key,product_id) VALUES($1,$2,$3)",[t.id,spec.key,id]);tracked={product_id:id}}
          const channels=await nativeApp.modules.sales_channel.listSalesChannels({}),profiles=await nativeApp.modules.fulfillment.listShippingProfiles({type:"default"})
          const image=urls(req,t.slug).storefront_url+"images/"+spec.image
          await flows.createProductsWorkflow(nativeApp.sharedContainer).run({input:{products:[{id:tracked.product_id,title:spec.title,handle:"demo-"+spec.key+"-"+tracked.product_id.slice(-8),status:"published",
            description:"这是用于体验商城功能的模拟商品，可在工作台一键清除。图片和价格仅用于演示。",thumbnail:image,images:[{url:image}],
            shipping_profile_id:profiles[0].id,sales_channels:[{id:channels[0].id}],options:[{title:"款式",values:["标准"]}],
            variants:[{title:"标准",manage_inventory:false,options:{"款式":"标准"},prices:[{currency_code:"usd",amount:spec.price}]}]}]}})
        }
      }))
      await pool.query("INSERT INTO saas_control.audit_event(actor_id,tenant_id,action,details) VALUES($1,$2,$3,'{}')",[a.id,t.id,"portal.demo_products."+action])
    }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[key])}finally{lock.release()}}
  }
  async function changeSamples(req,res,action){
    const a=await requireAccount(req);input(req.body||{},[])
    const s=(await shops(a)).find(s=>s.id===req.params.id)
    if(!s)throw error("PORTAL_SHOP_NOT_FOUND","网店不存在",404)
    await rate("portal-samples:"+a.id,10);await sampleProducts(a,s,action,req);await list(req,res)
  }
  async function isDemoStore(t){return !!demo&&(await pool.query(`SELECT 1 FROM saas_control.portal_shop p JOIN saas_control.portal_account a ON a.id=p.account_id
    WHERE p.owner_actor_id=$1 AND p.slug=$2 AND a.email=$3 AND a.status='active'`,[t.ownerActorId,t.slug,demo.merchant.email])).rowCount===1}
  function mount(web,{asyncHandler}){
    const router=express.Router()
    router.use((req,res,next)=>{try{origin(req);if(req.headers.authorization!==undefined)throw error("PORTAL_AUTH_REQUIRED","请使用商家账号登录",401);next()}catch(e){next(e)}})
    router.use(express.json({limit:"16kb",strict:true}))
    router.get("/saas/config",(req,res)=>res.json({base_domain:baseDomain,platform_url:urls(req,"platform").storefront_url+"platform",demo_enabled:!!demo,
      demo_email:demo?.merchant.email||null,platform_demo_email:demo?.platform.email||null}))
    router.post("/saas/auth/register",asyncHandler(register));router.post("/saas/auth/login",asyncHandler(login))
    router.post("/saas/auth/demo",asyncHandler(async(req,res)=>{input(req.body||{},[]);if(!demo)throw error("PORTAL_DEMO_DISABLED","演示入口未开启",404);req.body=demo.merchant;await login(req,res)}))
    router.get("/saas/auth/session",asyncHandler(async(req,res)=>{const a=await requireAccount(req);res.json({account:accountDTO(a),csrf_token:a.csrf_secret,is_demo:demoAccount(a)})}))
    router.delete("/saas/auth/session",asyncHandler(async(req,res)=>{const a=await requireAccount(req);await pool.query("DELETE FROM saas_control.portal_session WHERE id=$1",[a.session_id]);res.clearCookie(cookieName,cookieOptions);res.json({logged_out:true})}))
    router.get("/saas/shops",asyncHandler(list));router.post("/saas/shops",asyncHandler(createShop))
    router.post("/saas/shops/:id/demo-products",asyncHandler((req,res)=>changeSamples(req,res,"add")))
    router.delete("/saas/shops/:id/demo-products",asyncHandler((req,res)=>changeSamples(req,res,"remove")))
    for(const [url,file,type]of [["/","index.html","text/html"],["/login","index.html","text/html"],["/register","index.html","text/html"],["/dashboard","index.html","text/html"],
      ["/saas-assets/main.js","main.js","application/javascript"],["/saas-assets/style.css","style.css","text/css"]])
      router.get(url,(req,res)=>{res.set("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");res.type(type).sendFile(path.join(__dirname,"portal",file))})
    router.get("/platform",(req,res)=>res.redirect(302,urls(req,"platform").storefront_url+"platform"))
    router.use((req,res)=>res.status(404).json({code:"PORTAL_ROUTE_UNAVAILABLE",message:"页面不存在"}))
    web.use((req,res,next)=>{
      if(["/health","/health/live","/health/ready"].includes(req.path))return next()
      let apex=false
      try{apex=normalizeHost(req.headers.host)===baseDomain}catch{}
      return apex?router(req,res,next):next()
    })
  }
  return {mount,isDemoStore}
}
module.exports={createSelfService,assertDemoMode}
