"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const htmlByPage={
  "forgot-password":fs.readFileSync(require.resolve("../public/pages/forgot-password.html"),"utf8"),
  "reset-password":fs.readFileSync(require.resolve("../public/pages/reset-password.html"),"utf8"),
  "delete-account":fs.readFileSync(require.resolve("../public/pages/delete-account.html"),"utf8")
};
const script=fs.readFileSync(require.resolve("../public/scripts/account-recovery.js"),"utf8");
const validToken="A".repeat(43);

class ClassList{
  constructor(){this.values=new Set();}
  add(...names){names.forEach((name)=>this.values.add(name));}
  remove(...names){names.forEach((name)=>this.values.delete(name));}
  contains(name){return this.values.has(name);}
}

class Element{
  constructor(id,{hidden=false}={}){
    this.id=id;this.value="";this.textContent="";this.hidden=hidden;this.disabled=false;this.focused=false;
    this.dataset={};this.attributes={};this.listeners={};this.classList=new ClassList();this.statusText=null;
  }
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  async emit(type,event={}){for(const handler of this.listeners[type]||[])await handler(event);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  getAttribute(name){return this.attributes[name]??null;}
  focus(){this.focused=true;}
  querySelector(selector){return selector==="span"?this.statusText:null;}
}

function elementsFrom(html){
  const elements=new Map();
  for(const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){
    elements.set(match[1],new Element(match[1],{hidden:/\shidden(?:\s|>|=)/.test(match[0])}));
  }
  return elements;
}

function jsonResponse(status,data){
  return {
    ok:status>=200&&status<300,
    status,
    headers:{get:(name)=>name.toLowerCase()==="content-type"?"application/json; charset=utf-8":null},
    json:async()=>data
  };
}

function storage(seed={}){
  const values=new Map(Object.entries(seed));
  return {
    values,
    getItem:(key)=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:(key)=>values.delete(key),
    clear:()=>values.clear()
  };
}

function createPage(page,route,{hash="",search="",sessionSeed={}}={}){
  const html=htmlByPage[page];
  const elements=elementsFrom(html),requests=[],historyReplacements=[];
  const pathname=`/${page}`;
  const location={pathname,search,hash,href:`https://strata.test${pathname}${search}${hash}`};
  const sessionStorage=storage(sessionSeed);
  if(elements.has("resetState"))elements.get("resetState").statusText=new Element("resetStateText");
  if(elements.has("deleteState"))elements.get("deleteState").statusText=new Element("deleteStateText");
  const context={
    console,URLSearchParams,location,sessionStorage,
    document:{body:{dataset:{accountPage:page}},getElementById:(id)=>elements.get(id)||null},
    history:{replaceState:(...args)=>historyReplacements.push(args)},
    requestAnimationFrame:(callback)=>callback(),
    fetch:async(path,options={})=>{
      requests.push({path,options});
      return route(path,options,requests);
    }
  };
  context.globalThis=context;
  vm.createContext(context);
  vm.runInContext(script,context,{filename:"account-recovery.js"});
  return {elements,requests,historyReplacements,sessionStorage};
}

async function settle(){for(let index=0;index<5;index+=1)await new Promise(setImmediate);}

test("recovery pages keep guidance, fallback, and retention copy explicit",()=>{
  assert.match(htmlByPage["forgot-password"],/id="recoveryTitle"[^>]*>Send reset link</);
  assert.match(htmlByPage["reset-password"],/<noscript>[\s\S]*JavaScript required[\s\S]*Request a new link/);
  assert.match(htmlByPage["reset-password"],/id="newPasswordToggle"[^>]*type="button"[^>]*aria-controls="newPassword"/);
  assert.match(htmlByPage["reset-password"],/id="confirmPasswordToggle"[^>]*type="button"[^>]*aria-controls="confirmPassword"/);
  assert.match(htmlByPage["delete-account"],/copied by somebody else remain as independent copies/i);
  assert.match(htmlByPage["delete-account"],/support records, administrator security logs, and provider records may be retained/i);
  assert.match(htmlByPage["delete-account"],/Paddle’s merchant-of-record records are not deleted/i);
});

test("forgot-password gives a generic success and blocks a double submission",async()=>{
  let finishRequest;
  const pendingResponse=new Promise((resolve)=>{finishRequest=resolve;});
  const page=createPage("forgot-password",async(path)=>{
    if(path==="/api/password-reset/request")return pendingResponse;
    throw new Error(`Unexpected path ${path}`);
  });
  const form=page.elements.get("forgotPasswordForm");
  const email=page.elements.get("recoveryEmail");
  email.value="person@example.test";

  const first=form.emit("submit",{preventDefault(){}});
  const duplicate=form.emit("submit",{preventDefault(){}});
  await duplicate;

  assert.equal(page.requests.length,1,"an in-flight recovery request cannot be submitted twice");
  assert.equal(page.elements.get("recoverySubmit").disabled,true);
  assert.equal(form.getAttribute("aria-busy"),"true");
  assert.equal(page.elements.get("recoverySubmit").dataset.busy,"true");
  assert.match(page.elements.get("recoverySubmit").getAttribute("aria-label"),/sending reset link/i);
  assert.deepEqual(JSON.parse(page.requests[0].options.body),{email:"person@example.test"});
  assert.equal(page.requests[0].options.method,"POST");
  assert.equal(page.requests[0].options.credentials,"same-origin");

  finishRequest(jsonResponse(202,{ok:true,message:"If an account uses that email, a reset link was sent."}));
  await first;

  assert.equal(form.hidden,true);
  assert.equal(email.value,"");
  assert.equal(page.elements.get("recoverySuccess").hidden,false);
  assert.equal(page.elements.get("recoverySuccess").focused,true);
  assert.match(page.elements.get("recoverySuccess").textContent||htmlByPage["forgot-password"],/if an account uses that email/i);
  assert.equal(page.elements.get("recoverySubmit").disabled,false);
  assert.equal(page.elements.get("recoverySubmit").dataset.busy,undefined);
  assert.equal(page.elements.get("recoverySubmit").getAttribute("aria-label"),null);
  assert.equal(form.getAttribute("aria-busy"),null);
});

test("reset strips the bearer fragment before checking link status",async()=>{
  const page=createPage("reset-password",async(path)=>{
    if(path==="/api/password-reset/status")return jsonResponse(200,{active:true,maskedEmail:"p***@example.test"});
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`,search:"?source=email"});
  await settle();

  assert.equal(page.historyReplacements.length,1);
  assert.equal(page.historyReplacements[0][2],"/reset-password?source=email");
  assert.equal(page.requests.length,1);
  assert.equal(page.requests[0].path,"/api/password-reset/status");
  assert.equal(page.requests[0].options.method,"POST");
  assert.deepEqual(JSON.parse(page.requests[0].options.body),{token:validToken});
  assert.equal(page.elements.get("resetToken").value,validToken);
  assert.equal(page.elements.get("resetPasswordForm").hidden,false);
  assert.equal(page.elements.get("resetState").classList.contains("good"),true);
  assert.match(page.elements.get("resetState").statusText.textContent,/ready/i);
  assert.match(page.elements.get("resetIntro").textContent,/p\*\*\*@example\.test/);
});

test("reset rejects mismatched passwords without consuming the link",async()=>{
  const page=createPage("reset-password",async(path)=>{
    if(path==="/api/password-reset/status")return jsonResponse(200,{active:true});
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`});
  await settle();

  page.elements.get("newPassword").value="new-password-123";
  page.elements.get("confirmPassword").value="different-password";
  await page.elements.get("resetPasswordForm").emit("submit",{preventDefault(){}});

  assert.equal(page.requests.filter(({path})=>path==="/api/password-reset/complete").length,0);
  assert.equal(page.elements.get("resetMessage").hidden,false);
  assert.match(page.elements.get("resetMessage").textContent,/do not match/i);
  assert.equal(page.elements.get("confirmPassword").focused,true);
  assert.equal(page.elements.get("confirmPassword").getAttribute("aria-invalid"),"true");
  assert.equal(page.elements.get("resetMessage").focused,false,"focus should remain on the field that needs correction");
  await page.elements.get("resetPasswordForm").emit("input");
  assert.equal(page.elements.get("confirmPassword").getAttribute("aria-invalid"),null);
});

test("reset password visibility controls keep independent pressed states",async()=>{
  const page=createPage("reset-password",async(path)=>{
    if(path==="/api/password-reset/status")return jsonResponse(200,{active:true});
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`});
  await settle();
  const newPassword=page.elements.get("newPassword"),newToggle=page.elements.get("newPasswordToggle");
  const confirmation=page.elements.get("confirmPassword"),confirmToggle=page.elements.get("confirmPasswordToggle");
  await newToggle.emit("click");
  assert.equal(newPassword.type,"text");
  assert.equal(newToggle.getAttribute("aria-pressed"),"true");
  assert.notEqual(confirmToggle.getAttribute("aria-pressed"),"true");
  await confirmToggle.emit("click");
  assert.equal(confirmation.type,"text");
  assert.equal(confirmToggle.getAttribute("aria-pressed"),"true");
});

test("reset submits once and shows success after the password changes",async()=>{
  let finishReset;
  const pendingReset=new Promise((resolve)=>{finishReset=resolve;});
  const page=createPage("reset-password",async(path)=>{
    if(path==="/api/password-reset/status")return jsonResponse(200,{active:true});
    if(path==="/api/password-reset/complete")return pendingReset;
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`});
  await settle();
  const form=page.elements.get("resetPasswordForm");
  page.elements.get("newPassword").value="new-password-123";
  page.elements.get("confirmPassword").value="new-password-123";

  const first=form.emit("submit",{preventDefault(){}});
  const duplicate=form.emit("submit",{preventDefault(){}});
  await duplicate;
  assert.equal(page.requests.filter(({path})=>path==="/api/password-reset/complete").length,1);
  const completion=page.requests.find(({path})=>path==="/api/password-reset/complete");
  assert.deepEqual(JSON.parse(completion.options.body),{
    token:validToken,password:"new-password-123",confirmation:"new-password-123"
  });

  finishReset(jsonResponse(200,{ok:true}));
  await first;
  assert.equal(form.hidden,true);
  assert.equal(page.elements.get("resetSuccess").hidden,false);
  assert.equal(page.elements.get("resetSuccess").focused,true);
  assert.equal(page.elements.get("resetToken").value,"");
  assert.equal(page.elements.get("newPassword").value,"");
  assert.equal(page.elements.get("confirmPassword").value,"");
  assert.match(page.elements.get("resetState").statusText.textContent,/updated securely/i);
});

test("an invalid reset link never exposes the password form",async()=>{
  const page=createPage("reset-password",async(path)=>{
    if(path==="/api/password-reset/status")return jsonResponse(400,{error:"Invalid reset link.",code:"INVALID_RESET_LINK"});
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`});
  await settle();

  assert.equal(page.elements.get("resetPasswordForm").hidden,true);
  assert.equal(page.elements.get("resetUnavailable").hidden,false);
  assert.equal(page.elements.get("resetUnavailable").focused,true);
  assert.equal(page.elements.get("resetState").classList.contains("bad"),true);
  assert.equal(page.requests.filter(({path})=>path==="/api/password-reset/complete").length,0);
});

test("opening a deletion link only checks status and cannot delete the account",async()=>{
  const page=createPage("delete-account",async(path)=>{
    if(path==="/api/account/delete/status")return jsonResponse(200,{active:true,maskedEmail:"p***@example.test"});
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`});
  await settle();

  assert.match(htmlByPage["delete-account"],/Opening this page does not delete anything\./);
  assert.match(htmlByPage["delete-account"],/<form id="deleteAccountForm" action="\/auth\/account-delete\/complete" method="post"/);
  assert.deepEqual(page.requests.map(({path})=>path),["/api/account/delete/status"]);
  assert.equal(page.requests[0].options.method,"POST");
  assert.deepEqual(JSON.parse(page.requests[0].options.body),{token:validToken});
  assert.equal(page.elements.get("deleteAccountForm").hidden,false);
  assert.match(page.elements.get("deleteState").statusText.textContent,/awaiting confirmation/i);
});

test("deletion requires typed DELETE, submits once, and clears client state on success",async()=>{
  let finishDeletion;
  const pendingDeletion=new Promise((resolve)=>{finishDeletion=resolve;});
  const page=createPage("delete-account",async(path)=>{
    if(path==="/api/account/delete/status")return jsonResponse(200,{active:true});
    if(path==="/api/account/delete/complete")return pendingDeletion;
    throw new Error(`Unexpected path ${path}`);
  },{hash:`#token=${validToken}`,sessionSeed:{"strata.user":"cached","strata.plan":"cached"}});
  await settle();
  const form=page.elements.get("deleteAccountForm");
  const confirmation=page.elements.get("deleteConfirmation");

  confirmation.value="DELET";
  await form.emit("submit",{preventDefault(){}});
  assert.equal(page.requests.filter(({path})=>path==="/api/account/delete/complete").length,0);
  assert.match(page.elements.get("deleteMessage").textContent,/Type DELETE exactly/i);
  assert.equal(confirmation.focused,true);

  confirmation.value="delete!";
  await confirmation.emit("input");
  assert.equal(confirmation.value,"DELETE");
  const first=form.emit("submit",{preventDefault(){}});
  const duplicate=form.emit("submit",{preventDefault(){}});
  await duplicate;
  assert.equal(page.requests.filter(({path})=>path==="/api/account/delete/complete").length,1);
  const completion=page.requests.find(({path})=>path==="/api/account/delete/complete");
  assert.deepEqual(JSON.parse(completion.options.body),{token:validToken,confirmation:"DELETE"});

  finishDeletion(jsonResponse(200,{ok:true}));
  await first;
  assert.equal(form.hidden,true);
  assert.equal(page.elements.get("deleteSuccess").hidden,false);
  assert.equal(page.elements.get("deleteSuccess").focused,true);
  assert.equal(page.elements.get("deleteToken").value,"");
  assert.equal(confirmation.value,"");
  assert.equal(page.sessionStorage.values.size,0);
  assert.match(page.elements.get("deleteState").statusText.textContent,/permanently deleted/i);
});
