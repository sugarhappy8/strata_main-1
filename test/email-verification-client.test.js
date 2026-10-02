"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const accountHtml=fs.readFileSync(require.resolve("../public/pages/account.html"),"utf8");
const accountScript=fs.readFileSync(require.resolve("../public/scripts/account.js"),"utf8");
const accountModules=["devices-core","entitlements","account-logic","account-state","account-api","account-render","account-events","account-devices","account-delete-dialog"].map((name)=>({name,source:fs.readFileSync(require.resolve(`../public/scripts/${name}.js`),"utf8")}));
const verifyHtml=fs.readFileSync(require.resolve("../public/pages/verify-email.html"),"utf8");
const verifyScript=fs.readFileSync(require.resolve("../public/scripts/verify-email.js"),"utf8");

class ClassList{
  constructor(){this.values=new Set();}
  add(...values){values.forEach((value)=>this.values.add(value));}
  remove(...values){values.forEach((value)=>this.values.delete(value));}
  toggle(value,force=!this.values.has(value)){if(force)this.values.add(value);else this.values.delete(value);return force;}
}

class Element{
  constructor(id){
    this.id=id;this.value="";this.href="";this.textContent="";this.hidden=false;this.disabled=false;this.focused=false;
    this.dataset={};this.attributes={};this.listeners={};this.classList=new ClassList();this.values={};this.statusText=null;
  }
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  async emit(type,event={}){for(const handler of this.listeners[type]||[])await handler(event);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  getAttribute(name){return this.attributes[name]??null;}
  focus(){this.focused=true;}
  prepend(node){this.prepended=node;}
  querySelector(selector){return selector==="span"?this.statusText:null;}
}

function response(status,data,extraHeaders={}){
  const headers={"content-type":"application/json; charset=utf-8",...extraHeaders};
  return {ok:status>=200&&status<300,status,headers:{get:(name)=>headers[name.toLowerCase()]??null},json:async()=>data};
}

function elementsFrom(html){
  return new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match)=>[match[1],new Element(match[1])]));
}

function storage(seed={}){
  const values=new Map(Object.entries(seed));
  return {
    values,
    getItem:(key)=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:(key)=>values.delete(key)
  };
}

async function settle(){for(let index=0;index<5;index+=1)await new Promise(setImmediate);}

function accountPage(route){
  const elements=elementsFrom(accountHtml),requests=[],navigations=[],sessionStorage=storage();
  elements.get("accountLoading").hidden=true;
  elements.get("signedInCard").hidden=true;
  elements.get("signupMessage").hidden=true;
  elements.get("loginMessage").hidden=true;
  const authGrid=new Element("authGrid");
  class FakeFormData{constructor(form){this.values=form.values;}get(name){return this.values[name]??null;}}
  const location={search:"?mode=signup&next=pricing",href:"https://strata.test/account.html?mode=signup&next=pricing",assign:(path)=>navigations.push(path),replace:(path)=>navigations.push(path)};
  const context={
    console,URL,URLSearchParams,FormData:FakeFormData,location,sessionStorage,
    document:{getElementById:(id)=>elements.get(id)||null,querySelector:(selector)=>selector===".auth-grid"?authGrid:null},
    history:{replaceState(){}},requestAnimationFrame:(callback)=>callback(),matchMedia:()=>({matches:false}),
    fetch:async(path,options={})=>{requests.push({path,options});return route(path,options);}
  };
  context.globalThis=context;
  vm.createContext(context);
  for(const moduleScript of accountModules)vm.runInContext(moduleScript.source,context,{filename:`${moduleScript.name}.js`});
  vm.runInContext(accountScript,context,{filename:"account.js"});
  return {elements,requests,navigations,sessionStorage};
}

function verificationPage(route,{search="?next=planner&add=flat-dumbbell-press"}={}){
  const elements=elementsFrom(verifyHtml),requests=[],navigations=[],replacements=[],timers=[],sessionStorage=storage({"strata.verification.maskedEmail":"l***@example.test"});
  elements.get("verificationMessage").hidden=true;
  elements.get("verificationSessionEnded").hidden=true;
  elements.get("verificationState").statusText=new Element("verificationStateText");
  const location={search,href:`https://strata.test/verify-email.html${search}`,assign:(path)=>navigations.push(path),replace:(path)=>replacements.push(path)};
  const context={
    console,URL,URLSearchParams,Date,location,sessionStorage,
    document:{getElementById:(id)=>elements.get(id)||null},history:{replaceState(){}},
    requestAnimationFrame:(callback)=>callback(),matchMedia:()=>({matches:false}),
    setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},clearTimeout:()=>{},
    fetch:async(path,options={})=>{requests.push({path,options});return route(path,options);}
  };
  context.globalThis=context;
  vm.createContext(context);
  vm.runInContext(verifyScript,context,{filename:"verify-email.js"});
  return {elements,requests,navigations,replacements,sessionStorage,timers};
}

test("verification markup stays accessible and works without JavaScript",()=>{
  assert.match(verifyHtml,/<form id="verificationForm" action="\/auth\/verify-email" method="post"/);
  assert.match(verifyHtml,/<form id="resendForm" action="\/auth\/resend-verification" method="post"/);
  assert.match(verifyHtml,/id="verificationCode"[^>]*type="text"[^>]*inputmode="numeric"[^>]*autocomplete="one-time-code"[^>]*pattern="\[0-9\]\{6\}"[^>]*maxlength="6"/);
  assert.equal((verifyHtml.match(/name="code"/g)||[]).length,1,"the code must use one paste/autofill-friendly input");
  assert.doesNotMatch(verifyHtml,/name\s*=\s*"(?:email|challenge|token)"/i,"the verification page must rely on the HttpOnly challenge cookie");
  assert.match(verifyHtml,/id="verificationSessionEnded"[^>]*role="status"[^>]*hidden/);
  assert.match(verifyHtml,/id="verificationRestart"[^>]*href="\/account\.html\?mode=signup"/);
  assert.match(verifyHtml,/id="verificationSignIn"[^>]*href="\/account\.html\?mode=login"/);
});

test("enhanced signup sends only a masked hint to verification and preserves legacy 201 support",async()=>{
  const page=accountPage(async(path)=>{
    if(path==="/api/status")return response(200,{persistent:true});
    if(path==="/healthz")return response(200,{ok:true});
    if(path==="/api/me")return response(401,{error:"Not signed in."});
    if(path==="/api/signup")return response(202,{verificationRequired:true,maskedEmail:"n***@example.test",expiresIn:600,resendAfter:60});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  const form=page.elements.get("signupForm");
  form.values={name:"New Lifter",email:"new.lifter@example.test",password:"secure-password-123"};
  await form.emit("submit",{preventDefault(){}});
  await form.emit("submit",{preventDefault(){}});
  assert.deepEqual(page.navigations,["/verify-email.html?next=pricing&purpose=signup"]);
  assert.equal(page.requests.filter(({path})=>path==="/api/signup").length,1,"navigation lock prevents a duplicate signup request");
  assert.equal(page.sessionStorage.getItem("strata.verification.maskedEmail"),"n***@example.test");
  assert.equal(page.sessionStorage.getItem("strata.verification.purpose"),"signup");
  assert.doesNotMatch(page.navigations[0],/new\s*\.lifter|secure-password|code|challenge/i);
});

test("enhanced login continues an unverified account on the verification page",async()=>{
  const page=accountPage(async(path)=>{
    if(path==="/api/status")return response(200,{persistent:true});
    if(path==="/healthz")return response(200,{ok:true});
    if(path==="/api/me")return response(401,{error:"Not signed in."});
    if(path==="/api/login")return response(202,{verificationRequired:true,maskedEmail:"n***@example.test",expiresIn:600,resendAfter:60});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  const form=page.elements.get("loginForm");
  form.values={email:"new.lifter@example.test",password:"secure-password-123"};
  await form.emit("submit",{preventDefault(){}});
  assert.deepEqual(page.navigations,["/verify-email.html?next=pricing&purpose=login"]);
  assert.equal(page.sessionStorage.getItem("strata.verification.maskedEmail"),"n***@example.test");
  assert.equal(page.sessionStorage.getItem("strata.verification.purpose"),"login");
});

test("enhanced signup carries a safe delivery failure into the verification page",async()=>{
  const account=accountPage(async(path)=>{
    if(path==="/api/status")return response(200,{persistent:true});
    if(path==="/healthz")return response(200,{ok:true});
    if(path==="/api/me")return response(401,{error:"Not signed in."});
    if(path==="/api/signup")return response(503,{
      error:"The verification email could not be sent. Please wait a moment and resend it.",
      code:"EMAIL_DELIVERY_UNAVAILABLE",
      verificationRequired:true,
      maskedEmail:"n***@example.test",
      deliveryState:"failed"
    });
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  const form=account.elements.get("signupForm");
  form.values={name:"New Lifter",email:"new.lifter@example.test",password:"secure-password-123"};
  await form.emit("submit",{preventDefault(){}});
  assert.deepEqual(account.navigations,["/verify-email.html?next=pricing&purpose=signup&delivery=failed"]);
  assert.doesNotMatch(account.navigations[0],/new\s*\.lifter|secure-password|challenge/i);

  const verification=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{
      active:true,maskedEmail:"n***@example.test",expiresAt:Date.now()+600000,resendAfter:Date.now()+60000,deliveryState:"failed",attemptsRemaining:5
    });
    throw new Error(`Unexpected path ${path}`);
  },{search:"?next=pricing&delivery=failed"});
  await settle();
  assert.equal(verification.elements.get("verificationMessage").hidden,false);
  assert.match(verification.elements.get("verificationMessage").textContent,/could not send/i);
  assert.equal(verification.elements.get("verificationState").classList.values.has("warn"),true);
  assert.match(verification.elements.get("verificationState").statusText.textContent,/could not send/i);
});

test("verification normalizes one code, posts only that code, and follows the safe destination",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,maskedEmail:"n***@example.test",expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/verify-email")return response(200,{user:{id:"user-1"}});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  const input=page.elements.get("verificationCode");
  input.value="12 a34-56";
  await input.emit("input");
  assert.equal(input.value,"123456");
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  const request=page.requests.find(({path})=>path==="/api/verify-email");
  assert.deepEqual(JSON.parse(request.options.body),{code:"123456"});
  assert.equal(page.requests.filter(({path})=>path==="/api/verify-email").length,1,"navigation lock prevents duplicate verification");
  assert.deepEqual(page.navigations,["/planner.html?add=flat-dumbbell-press"]);
  assert.equal(page.sessionStorage.getItem("strata.verification.maskedEmail"),null);
});

test("invalid codes remain retryable and resend cooldown disables only resend",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/verify-email")return response(401,{error:"Invalid code.",code:"INVALID_VERIFICATION_CODE"});
    if(path==="/api/resend-verification")return response(429,{error:"Wait.",code:"RESEND_COOLDOWN",retryAfter:45});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  page.elements.get("verificationCode").value="123456";
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  assert.match(page.elements.get("verificationMessage").textContent,/incorrect/i);
  assert.equal(page.elements.get("verificationSubmit").disabled,false);
  await page.elements.get("resendForm").emit("submit",{preventDefault(){}});
  assert.match(page.elements.get("verificationMessage").textContent,/wait/i);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
  assert.equal(page.elements.get("verificationSubmit").disabled,false);
  assert.equal(page.timers.length,1,"cooldown uses one end-of-wait update, not a per-second live timer");
});

test("verification and resend requests cannot overlap",async()=>{
  let finishVerification;
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/verify-email")return new Promise((resolve)=>{finishVerification=resolve;});
    if(path==="/api/resend-verification")return response(202,{active:true,resendAfter:60});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  page.elements.get("verificationCode").value="123456";
  const pending=page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  await new Promise(setImmediate);
  await page.elements.get("resendForm").emit("submit",{preventDefault(){}});
  assert.equal(page.requests.filter(({path})=>path==="/api/resend-verification").length,0);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("verificationSubmit").dataset.busy,"true");
  assert.match(page.elements.get("verificationSubmit").getAttribute("aria-label"),/verifying code/i);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
  finishVerification(response(400,{error:"Invalid code.",code:"INVALID_VERIFICATION_CODE",attemptsRemaining:4}));
  await pending;
  assert.equal(page.elements.get("verificationSubmit").disabled,false);
  assert.equal(page.elements.get("verificationSubmit").dataset.busy,undefined);
  assert.equal(page.elements.get("verificationSubmit").getAttribute("aria-label"),null);
  assert.equal(page.elements.get("resendSubmit").disabled,false);
});

test("the final incorrect attempt locks verification and guides the user to resend",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0,deliveryState:"sent",attemptsRemaining:1});
    if(path==="/api/verify-email")return response(400,{error:"Invalid code.",code:"INVALID_VERIFICATION_CODE",attemptsRemaining:0});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  page.elements.get("verificationCode").value="123456";
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.match(page.elements.get("verificationMessage").textContent,/too many incorrect attempts/i);
  assert.match(page.elements.get("verificationState").statusText.textContent,/request a fresh code/i);
});

test("a missing or consumed challenge stays on the page with explicit recovery actions",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:false});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  assert.deepEqual(page.navigations,[]);
  assert.deepEqual(page.replacements,[]);
  assert.equal(page.elements.get("verificationSessionEnded").hidden,false);
  assert.equal(page.elements.get("verificationSessionEnded").focused,true);
  assert.match(page.elements.get("verificationEndedMessage").textContent,/no longer active/i);
  assert.equal(page.elements.get("verificationCode").disabled,true);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
  assert.equal(page.elements.get("verificationRestart").href,"/account.html?mode=signup&next=planner&add=flat-dumbbell-press");
  assert.equal(page.elements.get("verificationSignIn").href,"/account.html?mode=login&next=planner&add=flat-dumbbell-press");
  assert.equal(page.sessionStorage.getItem("strata.verification.maskedEmail"),null);
});

test("an ended login verification offers sign-in recovery instead of signup copy",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:false,purpose:"login"});
    throw new Error(`Unexpected path ${path}`);
  },{search:"?next=pricing&purpose=login"});
  await settle();
  assert.equal(page.elements.get("verificationSessionEnded").hidden,false);
  assert.match(page.elements.get("verificationEndedMessage").textContent,/sign-in verification/i);
  assert.equal(page.elements.get("verificationRestart").href,"/account.html?mode=login&next=pricing");
  assert.match(String(page.elements.get("verificationRestart").innerHTML),/start sign-in again/i);
  assert.match(page.elements.get("verificationStatus").textContent,/start sign-in again/i);
});

test("verification keeps safe new destinations in completion and account recovery links",async()=>{
  const destinations=[
    ["workout","/workout.html"],["/workout.html","/workout.html"],
    ["/workout.html?day=Monday","/workout.html?day=Monday"],["/workout.html?day=Sunday","/workout.html?day=Sunday"],
    ["onboarding","/onboarding.html"],["/onboarding.html","/onboarding.html"],
    ["/workout.html?day=Funday","/planner.html"],["/workout.html?day=Monday&next=//outside.test","/planner.html"],
    ["//outside.test/workout.html","/planner.html"],["/onboarding.html?url=//outside.test","/planner.html"]
  ];
  for(const [requested,destination] of destinations){
    for(const active of [false,true]){
      const page=verificationPage(async(path)=>{
        if(path==="/api/verification-status")return response(200,{active,expiresAt:Date.now()+600000,resendAfter:0});
        if(path==="/api/verify-email")return response(200,{user:{id:"verified-user"}});
        throw new Error(`Unexpected path ${path}`);
      },{search:`?next=${encodeURIComponent(requested)}`});
      await settle();
      assert.equal(page.elements.get("verificationNext").value,destination);
      assert.equal(page.elements.get("resendNext").value,destination);
      if(active){
        page.elements.get("verificationCode").value="123456";
        await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
        assert.deepEqual(page.navigations,[destination]);
      }else{
        const accountNext=destination.includes("?")?destination:destination.slice(1,-5);
        assert.equal(page.elements.get("verificationRestart").href,`/account.html?${new URLSearchParams({mode:"signup",next:accountNext})}`);
        assert.equal(page.elements.get("verificationSignIn").href,`/account.html?${new URLSearchParams({mode:"login",next:accountNext})}`);
      }
    }
  }
});

test("an expired code disables verification but keeps resend available",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()-1000,resendAfter:Date.now()+60000});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  assert.deepEqual(page.navigations,[]);
  assert.equal(page.elements.get("verificationSessionEnded").hidden,true);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
  assert.match(page.elements.get("verificationState").statusText.textContent,/code has expired/i);
  assert.equal(page.timers.length,1);
  page.timers[0].callback();
  assert.equal(page.elements.get("resendSubmit").disabled,false);
});

test("a code-expired API response remains recoverable through resend",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/verify-email")return response(410,{error:"Expired.",code:"VERIFICATION_CODE_EXPIRED"});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  page.elements.get("verificationCode").value="123456";
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  assert.deepEqual(page.navigations,[]);
  assert.deepEqual(page.replacements,[]);
  assert.equal(page.elements.get("verificationSessionEnded").hidden,true);
  assert.match(page.elements.get("verificationMessage").textContent,/expired/i);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("resendSubmit").disabled,false);
});

test("a hard-expired verification session is terminal and never redirects",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/verify-email")return response(410,{error:"Session expired.",code:"VERIFICATION_EXPIRED"});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  page.elements.get("verificationCode").value="123456";
  await page.elements.get("verificationForm").emit("submit",{preventDefault(){}});
  assert.deepEqual(page.navigations,[]);
  assert.deepEqual(page.replacements,[]);
  assert.equal(page.elements.get("verificationSessionEnded").hidden,false);
  assert.match(page.elements.get("verificationEndedMessage").textContent,/signup verification expired/i);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
});

test("resend with no active challenge explains recovery instead of redirecting",async()=>{
  const page=verificationPage(async(path)=>{
    if(path==="/api/verification-status")return response(200,{active:true,expiresAt:Date.now()+600000,resendAfter:0});
    if(path==="/api/resend-verification")return response(404,{error:"No active challenge.",code:"NO_ACTIVE_VERIFICATION"});
    throw new Error(`Unexpected path ${path}`);
  });
  await settle();
  await page.elements.get("resendForm").emit("submit",{preventDefault(){}});
  assert.deepEqual(page.navigations,[]);
  assert.deepEqual(page.replacements,[]);
  assert.equal(page.elements.get("verificationSessionEnded").hidden,false);
  assert.match(page.elements.get("verificationEndedMessage").textContent,/no longer active/i);
  assert.equal(page.elements.get("verificationSubmit").disabled,true);
  assert.equal(page.elements.get("resendSubmit").disabled,true);
});
