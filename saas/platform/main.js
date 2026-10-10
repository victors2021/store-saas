"use strict";
(() => {
  let csrfToken="",administrator=null,offset=0,editing=null,busy=false;
  const element=id=>document.getElementById(id);
  const message=(text,error=false)=>{element("message").hidden=!text;element("message").textContent=text;element("message").className=error?"error":""};
  const node=(tag,text,className)=>{const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n};
  function signedOut() {
    csrfToken="";administrator=null;editing=null;offset=0;element("dashboard").hidden=true;element("administrator").hidden=true;
    element("administrator-email").textContent="";element("login").hidden=false;element("tenants").replaceChildren();element("editor").hidden=true;
  }
  function signedIn(data) {
    administrator=data.administrator;csrfToken=data.csrf_token;element("administrator-email").textContent=administrator.email;
  }
  async function api(path,body,method=body?"POST":"GET") {
    const response=await fetch(path,{method,credentials:"same-origin",headers:{...(body?{"content-type":"application/json"}:{}),
      ...(csrfToken&&method!=="GET"?{"x-csrf-token":csrfToken}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok){
      if(response.status===401&&path!=="/platform/auth/login"&&administrator)signedOut();
      const text={PLATFORM_AUTHENTICATION_REQUIRED:"登录已失效，请重新登录",SAAS_RATE_LIMITED:"尝试次数过多，请稍后再试",PLATFORM_CSRF_REQUIRED:"请刷新页面后再保存",PLATFORM_HTTPS_REQUIRED:"请使用 HTTPS 地址登录"};
      const failure=new Error(text[data.code]||data.message||"请求失败");failure.status=response.status;throw failure;
    }
    return data;
  }
  async function action(task) {
    if(busy)return;busy=true;document.querySelectorAll("button").forEach(button=>button.disabled=true);
    try{await task()}catch(error){message(error.message,true)}finally{busy=false;document.querySelectorAll("button").forEach(button=>button.disabled=false);element("previous").disabled=offset===0}
  }
  function edit(row) {
    editing=row;element("editor").hidden=false;element("editing-shop").textContent=row.name;
    const form=element("plan-form");form.elements.product_limit.value=row.product_limit;form.elements.upload_mib.value=Number(row.upload_limit_bytes)/1048576;
    form.elements.requests_per_minute.value=row.requests_per_minute;form.elements.manual_reference.value="";element("editor").scrollIntoView({behavior:"smooth"});
  }
  async function refresh() {
    const [shops,ops]=await Promise.all([api(`/platform/tenants?limit=25&offset=${offset}`),api("/platform/operations")]);
    element("dashboard").hidden=false;element("login").hidden=true;element("administrator").hidden=false;element("count").textContent=`${shops.count} 家商户`;
    element("health").replaceChildren(...Object.entries(ops.health.checks).map(([name,ok])=>{const n=node("div","","card");n.append(node("span",{api:"API 服务",database:"数据库",worker:"任务 Worker"}[name]),node("strong",ok?"正常":"待恢复",ok?"good":"bad"));return n}));
    element("backup-status").textContent=(ops.backup?`最近加密备份：${new Date(ops.backup.completed_at).toLocaleString('zh-CN')}`:'尚未创建加密备份')+'。异机副本与恢复尚待验证。';
    const alertText={QUEUE_FAILED:'后台任务失败，请检查任务状态',QUEUE_BACKLOG:'后台任务积压超过 5 分钟',BACKUP_MISSING:'尚无加密备份，请安排备份',BACKUP_STALE:'加密备份超过 36 小时，请检查备份计划',CLEANUP_FAILED:'临时资源清理失败，请检查存储和数据库',AUDIT_WRITE_FAILED:'审计写入失败，请检查数据库',WORKER_HEARTBEAT_FAILED:'任务服务状态更新失败，请检查服务'};
    element("alerts").replaceChildren(...ops.alerts.map(row=>node("p",`${row.tenant_id?(shops.tenants.find(shop=>shop.id===row.tenant_id)?.name||'商户'):'平台'} · ${alertText[row.code]||'运营状态需要检查'}`,"bad")));
    element("tenants").replaceChildren(...shops.tenants.map(row=>{
      const tr=document.createElement("tr"),name=node("td",""),state=node("td",""),actions=node("td","");
      name.append(node("strong",row.name),node("p",`${row.slug} · ${row.plan_id}`));state.append(node("span",row.status==="suspended"?"已暂停":row.status==="active"?"运营中":row.status,"badge"+(row.status==="suspended"?" paused":"")));
      const plan=node("button","修改套餐","secondary"),toggle=node("button",row.status==="suspended"?"恢复店铺":"暂停店铺","secondary");plan.addEventListener("click",()=>edit(row));
      toggle.addEventListener("click",()=>action(async()=>{await api(`/platform/tenants/${row.id}/status`,{status:row.status==="suspended"?"active":"suspended"});await refresh();message("店铺状态已更新")}));
      actions.append(plan,toggle);tr.append(name,state,node("td",`${row.product_count} / ${row.product_limit}`),node("td",`${(Number(row.upload_bytes)/1048576).toFixed(2)} / ${(Number(row.upload_limit_bytes)/1048576).toFixed(2)} MiB`),node("td",String(row.requests_per_minute)),actions);return tr;
    }));element("previous").disabled=offset===0;element("next").hidden=offset+25>=shops.count;
  }
  element("login-form").addEventListener("submit",event=>{event.preventDefault();const credentials={email:element("email").value,password:element("password").value};element("password").value="";action(async()=>{
    signedIn(await api("/platform/auth/login",credentials));await refresh();message("");
  })});
  element("refresh").addEventListener("click",()=>action(refresh));
  element("logout").addEventListener("click",()=>action(async()=>{await api("/platform/auth/session",undefined,"DELETE");signedOut();message("")}));
  element("demo-button").addEventListener("click",()=>action(async()=>{signedIn(await api("/platform/auth/demo",{}));await refresh();message("")}));
  element("previous").addEventListener("click",()=>action(async()=>{offset=Math.max(0,offset-25);await refresh()}));
  element("next").addEventListener("click",()=>action(async()=>{offset+=25;await refresh()}));
  element("close-editor").addEventListener("click",()=>{editing=null;element("editor").hidden=true});
  element("plan-form").addEventListener("submit",event=>{event.preventDefault();action(async()=>{
    const form=event.target;await api(`/platform/tenants/${editing.id}/plan`,{plan_id:"pilot",expected_version:editing.version,product_limit:Number(form.elements.product_limit.value),
      upload_limit_bytes:Math.round(Number(form.elements.upload_mib.value)*1048576),requests_per_minute:Number(form.elements.requests_per_minute.value),manual_reference:form.elements.manual_reference.value});
    editing=null;element("editor").hidden=true;await refresh();message("人工套餐已保存");
  })});
  action(async()=>{
    const demo=await api("/platform/demo-config");element("demo-login").hidden=!demo.enabled;element("demo-email").textContent=demo.email||"";
    try{signedIn(await api("/platform/auth/session"));await refresh()}catch(error){if(error.status!==401)throw error;signedOut()}
  });
})();
