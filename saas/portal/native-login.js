"use strict";
window.addEventListener("DOMContentLoaded",()=>{
  if(!location.pathname.startsWith("/app/login"))return;
  const panel=document.createElement("aside"),button=document.createElement("button"),status=document.createElement("span");
  panel.setAttribute("aria-label","商家演示登录");panel.style.cssText="position:fixed;bottom:24px;left:24px;z-index:9999;background:#fff;padding:16px;border:1px solid #d1d5db;border-radius:12px;box-shadow:0 8px 30px #0001";
  button.type="button";button.textContent="演示邮箱 · 一键登录商家后台";button.style.cssText="background:#172e22;color:white;padding:12px 18px;border-radius:8px;border:0;cursor:pointer";
  panel.append(button,status);document.body.append(panel);
  const login=async()=>{
    button.disabled=true;status.textContent=" 正在登录…";
    try{
      const response=await fetch("/auth/user/demo",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:"{}"}),data=await response.json();
      if(!response.ok)throw new Error("演示登录暂不可用");
      const session=await fetch("/auth/session",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json",authorization:`Bearer ${data.token}`},body:"{}"});
      if(!session.ok)throw new Error("演示会话创建失败");location.replace("/app/");
    }catch(e){status.textContent=" "+e.message;button.disabled=false;}
  };
  button.addEventListener("click",login);if(new URLSearchParams(location.search).get("demo")==="1")login();
});
