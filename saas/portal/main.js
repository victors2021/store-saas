"use strict";
(()=>{
  const el=id=>document.getElementById(id),node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  let account=null,csrf="",config=null,isDemo=false,busy=false,creationKey=null,removing=null;
  function notice(text,err=false){el("notice").hidden=!text;el("notice").textContent=text;el("notice").className="notice"+(err?" error":"");}
  function signedOut(){account=null;csrf="";isDemo=false;el("nav-dashboard").hidden=true;el("logout").hidden=true;el("nav-login").hidden=false;el("nav-start").hidden=false;el("shop-list").replaceChildren();}
  function signedIn(data){account=data.account;csrf=data.csrf_token;isDemo=data.is_demo??account.email===config.demo_email;el("nav-dashboard").hidden=false;el("logout").hidden=false;el("nav-login").hidden=true;el("nav-start").hidden=true;el("account-email").textContent=account.email;el("create-password-label").hidden=isDemo;el("create-form").elements.password.required=!isDemo;}
  async function api(path,body,method=body===undefined?"GET":"POST"){
    const response=await fetch(path,{method,credentials:"same-origin",headers:{...(body!==undefined?{"content-type":"application/json"}:{}),...(csrf&&method!=="GET"?{"x-csrf-token":csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok){if(response.status===401&&!["/saas/auth/login","/saas/auth/register","/saas/auth/demo"].includes(path)&&data.code!=="PORTAL_PASSWORD_REQUIRED")signedOut();
      const messages={TENANT_OPEN_CONFLICT:"这个店铺网址已被使用，请选择其他网址。",INVALID_CONTROL_HOST:"这个店铺网址不可用，请换一个名称。",INVALID_CONTROL_INPUT:"请检查店铺名称和网址。",TENANT_INITIALIZATION_FAILED:"店铺初始化失败，可在工作台重试。",SAAS_RATE_LIMITED:"操作过于频繁，请稍后重试。"};
      const error=new Error(messages[data.code]||data.message||"请求失败，请重试");error.status=response.status;throw error;}return data;
  }
  async function action(task){if(busy)return;busy=true;document.querySelectorAll("button").forEach(n=>n.disabled=true);try{await task();}catch(e){notice(e.message,true);if(!account&&location.pathname==="/dashboard")route("/login");}finally{busy=false;document.querySelectorAll("button").forEach(n=>n.disabled=false);}}
  function route(path,replace=false){if(location.pathname!==path)history[replace?"replaceState":"pushState"]({},"",path);render();}
  function render(){
    const pathname=location.pathname,auth=pathname==="/register"||pathname==="/login",register=pathname==="/register";
    el("home-view").hidden=pathname!=="/";el("auth-view").hidden=!auth;el("dashboard-view").hidden=pathname!=="/dashboard";
    if(auth){el("auth-title").textContent=register?"创建账号与网店":"登录商家账号";el("auth-description").textContent=register?"注册后自动初始化你的网店。":"继续管理你的店铺与商品。";el("register-fields").hidden=!register;
      el("register-name").required=register;el("register-slug").required=register;el("auth-password").autocomplete=register?"new-password":"current-password";
      el("auth-submit").textContent=register?"注册并创建网店 →":"登录用户后台 →";el("auth-switch").replaceChildren(node("span",register?"已有账号？ ":"还没有账号？ "));const a=node("a",register?"登录":"注册并开店");a.href=register?"/login":"/register";el("auth-switch").append(a);}
    if(pathname==="/dashboard"&&!account){route("/login",true);return;}
    document.title=pathname==="/dashboard"?"我的网店 · Store SaaS":auth?(register?"注册并开店":"商家登录")+" · Store SaaS":"Store SaaS · 让品牌拥有自己的网店";
  }
  function link(label,url,cls="button secondary"){const a=node("a",label,cls);a.href=url;return a;}
  async function refresh(){
    const data=await api("/saas/shops"),shops=data.shops;el("shop-count").textContent=shops.length;el("product-count").textContent=shops.reduce((n,s)=>n+s.product_count,0);el("sample-count").textContent=shops.reduce((n,s)=>n+s.demo_count,0);el("empty-shops").hidden=shops.length>0;
    el("shop-list").replaceChildren(...shops.map(s=>{
      const card=node("article",undefined,"shop-card"),heading=node("div",undefined,"shop-card-heading"),title=node("div"),state={active:"已就绪",suspended:"已暂停",pending:"初始化中",failed:"初始化失败"}[s.status]||"等待初始化";
      title.append(node("h2",s.name),node("p",new URL(s.storefront_url).host,"shop-address"));heading.append(title,node("span",state,"status-badge"+(s.status==="active"?"":" warn")));
      card.append(heading,node("p",`${s.product_count} 件商品 · ${s.demo_count} 件模拟商品 · 固定响应式模板`,"shop-counts"));const actions=node("div",undefined,"shop-actions");
      if(s.status==="active"){
        actions.append(link("打开网店 ↗",s.storefront_url,"button"),link("进入商家后台 →",s.is_demo?s.demo_admin_url:s.admin_url));
        const add=node("button","添加模拟商品","text-button");add.addEventListener("click",()=>action(async()=>{notice("正在添加模拟商品…");await api(`/saas/shops/${s.id}/demo-products`,{});await refresh();notice("模拟商品已准备好，可打开网店查看。");}));actions.append(add);
        if(s.demo_count){const remove=node("button","清除模拟商品","text-button");remove.addEventListener("click",()=>{removing=s;el("remove-dialog").showModal();});actions.append(remove);}
      }else if(s.status!=="suspended"){
        const retry=node("button","重试初始化","button secondary");retry.addEventListener("click",()=>openCreate(s));actions.append(retry);
      }
      card.append(actions);return card;
    }));return shops;
  }
  function openCreate(shop){creationKey=shop?.request_key||crypto.randomUUID();const f=el("create-form");f.elements.name.value=shop?.name||"";f.elements.slug.value=shop?.slug||"";f.elements.password.value="";f.elements.with_demo_products.checked=true;el("create-section").hidden=false;f.elements.name.focus();}
  async function create(fields){notice("正在初始化网店和模板，请稍候…");const data=await api("/saas/shops",fields);el("create-section").hidden=true;creationKey=null;await refresh();notice(data.demo_error||"网店已创建，开始设置品牌和商品吧。",!!data.demo_error);return data.shop;}
  async function demoLogin(destination="dashboard"){
    signedIn(await api("/saas/auth/demo",{}));const shops=await refresh();let shop=shops.find(s=>s.status==="active");
    if(!shop)shop=await create({name:"雾森生活 · 演示店",slug:"demo-store",idempotency_key:"portal-demo-store-v1",with_demo_products:true});
    if(destination==="native")location.assign(shop.demo_admin_url);else if(destination==="storefront")location.assign(shop.storefront_url);else{notice("");route("/dashboard");}
  }
  el("auth-form").addEventListener("submit",event=>{event.preventDefault();const register=location.pathname==="/register",credentials={email:el("auth-email").value,password:el("auth-password").value},fields={name:el("register-name").value,slug:el("register-slug").value,password:credentials.password,idempotency_key:crypto.randomUUID(),with_demo_products:el("register-demo").checked};el("auth-password").value="";
    action(async()=>{signedIn(await api(register?"/saas/auth/register":"/saas/auth/login",credentials));notice("");route("/dashboard");await refresh();if(register){try{await create(fields);}catch(e){await refresh();throw e;}}});});
  el("create-form").addEventListener("submit",event=>{event.preventDefault();const f=event.target,fields={name:f.elements.name.value,slug:f.elements.slug.value,password:f.elements.password.value,idempotency_key:creationKey||crypto.randomUUID(),with_demo_products:f.elements.with_demo_products.checked};f.elements.password.value="";action(async()=>{try{await create(fields);}catch(e){await refresh();throw e;}});});
  el("logout").addEventListener("click",()=>action(async()=>{await api("/saas/auth/session",{},"DELETE");signedOut();notice("");route("/login");}));
  for(const id of ["new-shop","empty-create"])el(id).addEventListener("click",()=>openCreate());el("close-create").addEventListener("click",()=>el("create-section").hidden=true);
  el("cancel-remove").addEventListener("click",()=>el("remove-dialog").close());el("confirm-remove").addEventListener("click",()=>{const shop=removing;el("remove-dialog").close();action(async()=>{notice("正在清除本店模拟商品…");await api(`/saas/shops/${shop.id}/demo-products`,{},"DELETE");await refresh();notice("模拟商品已清除，其他商品和订单保留。");});});
  for(const id of ["hero-demo","demo-merchant","auth-demo"])el(id).addEventListener("click",()=>action(()=>demoLogin()));el("demo-native").addEventListener("click",()=>action(()=>demoLogin("native")));el("demo-storefront").addEventListener("click",()=>action(()=>demoLogin("storefront")));
  document.addEventListener("click",event=>{const a=event.target.closest("a");if(!a||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const u=new URL(a.href,location.href);if(u.origin===location.origin&&!u.hash&&["/","/login","/register","/dashboard"].includes(u.pathname)){event.preventDefault();notice("");route(u.pathname);if(u.pathname==="/dashboard"&&account)action(refresh);}});window.addEventListener("popstate",render);
  action(async()=>{config=await api("/saas/config");for(const n of document.querySelectorAll(".domain-label"))n.textContent="."+config.base_domain;
    for(const id of ["platform-link","footer-platform","demo-platform"])el(id).href=config.platform_url;
    for(const id of ["hero-demo","demo","auth-demo"])el(id).hidden=!config.demo_enabled;el("merchant-demo-email").textContent=config.demo_email||"";el("native-demo-email").textContent=config.demo_email||"";el("platform-demo-email").textContent=config.platform_demo_email||"";
    try{signedIn(await api("/saas/auth/session"));}catch(e){if(e.status!==401)throw e;signedOut();}render();if(account&&location.pathname==="/dashboard")await refresh();});
})();
