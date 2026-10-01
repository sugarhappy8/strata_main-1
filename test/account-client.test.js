"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");

const html=fs.readFileSync(require.resolve("../public/pages/account.html"),"utf8");
const script=fs.readFileSync(require.resolve("../public/scripts/account.js"),"utf8");
const moduleScripts=["devices-core","account-logic","account-state","account-api","account-render","account-events","account-devices"].map((name)=>({name,source:fs.readFileSync(require.resolve(`../public/scripts/${name}.js`),"utf8")}));

class ClassList{
  constructor(){this.values=new Set();}
  add(...names){names.forEach((name)=>this.values.add(name));}
  remove(...names){names.forEach((name)=>this.values.delete(name));}
  contains(name){return this.values.has(name);}
  toggle(name,force=!this.values.has(name)){if(force)this.values.add(name);else this.values.delete(name);return force;}
}

class Element{
  constructor(id){
    this.id=id;this.value="";this.textContent="";this.innerHTML="";this.hidden=false;this.disabled=false;this.href="";this.max=1;
    this.dataset={};this.attributes={};this.listeners={};this.classList=new ClassList();this.values={};this.focused=false;
  }
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  async emit(type,event={}){for(const handler of this.listeners[type]||[])await handler(event);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  getAttribute(name){return this.attributes[name]??null;}
  focus(){this.focused=true;}
  scrollIntoView(){this.scrolled=true;}
  prepend(node){this.prepended=node;}
  appendChild(node){this.appended=node;}
  click(){this.clicked=true;}
  remove(){this.removed=true;}
  querySelector(selector){return selector==="span"?this.statusText:null;}
}

function jsonResponse(status,data){
  return {ok:status>=200&&status<300,status,headers:{get:(name)=>name.toLowerCase()==="content-type"?"application/json; charset=utf-8":null},json:async()=>data};
}
function exportResponse(data){
  return{ok:true,status:200,headers:{get:(name)=>({"content-type":"application/json; charset=utf-8","content-disposition":'attachment; filename="strata-account-export-2026-09-08.json"',"x-strata-export":"account-v1"}[name.toLowerCase()]||null)},blob:async()=>new Blob([JSON.stringify(data)],{type:"application/json"})};
}
function deferred(){let resolve;const promise=new Promise((done)=>{resolve=done;});return{promise,resolve};}

function createPage({search="",route}){
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map((match)=>match[1]);
  const elements=new Map(ids.map((id)=>[id,new Element(id)]));
  elements.get("accountLoading").hidden=true;
  elements.get("signedInCard").hidden=true;
  elements.get("signupMessage").hidden=true;
  elements.get("loginMessage").hidden=true;
  const authGrid=new Element("authGrid"),body=new Element("body"),navigations=[],requests=[],replaced=[],reloads=[],downloads=[],objectUrls=[],windowListeners={},documentListeners={};
  const location={search,href:`http://strata.test/account.html${search}`,assign:(path)=>navigations.push(path),replace:(path)=>navigations.push(path),reload:()=>reloads.push(true)};
  const document={
    body,hidden:false,
    getElementById:(id)=>elements.get(id)||null,
    querySelector:(selector)=>selector===".auth-grid"?authGrid:null,
    createElement:(tag)=>{const node=new Element(tag);node.click=()=>downloads.push({href:node.href,download:node.download});return node;},
    addEventListener:(type,handler)=>{(documentListeners[type]||=[]).push(handler);}
  };
  class BrowserURL extends URL{}
  BrowserURL.createObjectURL=(blob)=>{const value=`blob:strata-${objectUrls.length+1}`;objectUrls.push({value,blob});return value;};
  BrowserURL.revokeObjectURL=()=>{};
  class FakeFormData{
    constructor(form){this.values=form.values;}
    get(name){return this.values[name]??null;}
  }
  const context={
    console,document,location,URL:BrowserURL,URLSearchParams,FormData:FakeFormData,Blob,setTimeout,
    history:{replaceState:(...args)=>replaced.push(args)},
    requestAnimationFrame:(callback)=>callback(),matchMedia:()=>({matches:false}),
    addEventListener:(type,handler)=>{(windowListeners[type]||=[]).push(handler);},
    fetch:async(path,options={})=>{requests.push({path,options});return route(path,options,requests);}
  };
  context.globalThis=context;
  vm.createContext(context);
  for(const moduleScript of moduleScripts)vm.runInContext(moduleScript.source,context,{filename:`${moduleScript.name}.js`});
  vm.runInContext(script,context,{filename:"account.js"});
  return {elements,requests,navigations,replaced,reloads,downloads,objectUrls,setHidden(value){document.hidden=value===true;},async emitDocument(type,event={}){for(const handler of documentListeners[type]||[])await handler(event);},async emitWindow(type,event={}){for(const handler of windowListeners[type]||[])await handler(event);}};
}

async function settle(){
  for(let count=0;count<5;count+=1)await new Promise(setImmediate);
}

const WEEKDAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
function planFixture(dayCounts={}){
  return {version:1,restDay:null,restDays:[],days:Object.fromEntries(WEEKDAYS.map((day)=>[day,Array.from({length:dayCounts[day]||0},(_,index)=>({
    instanceId:`${day.toLowerCase()}-${index}`,exerciseId:index%2?"machine-chest-press":"flat-dumbbell-press",sets:index+2,reps:"8–12"
  }))]))};
}
function memberFixture(overrides={}){
  return {id:"member-1",name:"Ari Stone",email:"ari@example.test",createdAt:1704067200000,planCount:0,workoutDays:0,isAdmin:false,
    discovery:{active:true,accessType:"paid",pendingPurchaseCount:0},accountDeletion:{pending:false},...overrides};
}
function localKey(date){
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function thisWeekDate(day){
  const now=new Date(),todayIndex=(now.getDay()+6)%7,monday=new Date(now.getFullYear(),now.getMonth(),now.getDate()-todayIndex,12);
  return localKey(new Date(monday.getFullYear(),monday.getMonth(),monday.getDate()+WEEKDAYS.indexOf(day),12));
}
function workoutFixture(overrides={}){
  return {id:"workout-1",title:"Upper strength",planDay:"Monday",date:thisWeekDate("Monday"),status:"completed",startedAt:1,completedAt:2,elapsedSeconds:1800,totalSets:3,completedSets:3,exerciseCount:1,
    exerciseSummaries:[{exerciseId:"flat-dumbbell-press",measurement:"reps",loadType:"external",unit:"kg",completedSets:3,totalReps:24,maxReps:8,maxWeight:20,volume:480,totalSeconds:0,maxSeconds:null}],revision:1,updatedAt:2,...overrides};
}

test("native forms remain available without the JavaScript enhancement",()=>{
  assert.match(html,/<form id="signupForm" action="\/auth\/signup" method="post"/);
  assert.match(html,/<form id="loginForm" action="\/auth\/login" method="post"/);
  assert.match(html,/<section class="account-access" id="accountAccess"[^>]*>/);
  assert.doesNotMatch(html,/<section class="account-access" id="accountAccess"[^>]*hidden/);
  assert.doesNotMatch(html,/accountRetry/);
  assert.doesNotMatch(script,/accountRetry/);
});

test("a persisted account-page restore clears private DOM before reloading the current session",async()=>{
  const periodEnd=Date.now()+30*24*60*60*1000,user=memberFixture({name:"PRIVATE ACCOUNT SENTINEL",email:"private-sentinel@example.test",planCount:1,workoutDays:1,discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:{id:"sub-private",status:"active",active:true,pastDue:false,scheduledChange:null,currentPeriodEndsAt:periodEnd}}});
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"private-csrf",user});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"private-csrf",user,plan:planFixture({Monday:1}),planUpdatedAt:1});
    if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{csrfToken:"private-csrf",hasMore:false,workouts:[workoutFixture({status:"active",completedAt:null,title:"PRIVATE WORKOUT SENTINEL"})]});
    if(path==="/api/account/sessions")return jsonResponse(200,{userId:user.id,sessions:[{id:"PRIVATE-SESSION-SENTINEL",current:true,createdAt:1_700_000_000_000,expiresAt:1_800_000_000_000}]});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.match(page.elements.get("signedInIdentity").textContent,/PRIVATE ACCOUNT SENTINEL/);
  assert.match(page.elements.get("accountNextTitle").textContent,/PRIVATE WORKOUT SENTINEL/);
  await page.emitWindow("pageshow",{persisted:false});assert.equal(page.reloads.length,0);
  await page.emitWindow("pageshow",{persisted:true});assert.equal(page.reloads.length,1);
  assert.equal(page.elements.get("signedInCard").hidden,true);assert.equal(page.elements.get("accountLoading").hidden,false);
  const privateDom=[...page.elements.values()].map((node)=>`${node.textContent} ${node.innerHTML} ${node.href}`).join(" ");
  assert.doesNotMatch(privateDom,/PRIVATE ACCOUNT SENTINEL|private-sentinel@example\.test|PRIVATE WORKOUT SENTINEL|PRIVATE-SESSION-SENTINEL|sub-private/);
});

test("Account foreground recheck supersedes a delayed initial identity without exposing it",async()=>{
  const stale=deferred(),staleUser=memberFixture({id:"stale-initial",name:"STALE INITIAL ACCOUNT",email:"stale-initial@example.test"});
  const currentUser=memberFixture({id:"current-after-focus",name:"CURRENT ACCOUNT",email:"current@example.test",discovery:{active:false,accessType:null,pendingPurchaseCount:0}});
  let identityReads=0;
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me"){identityReads+=1;return identityReads===1?stale.promise:jsonResponse(200,{csrfToken:"current-csrf",user:currentUser});}
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"current-csrf",user:currentUser,plan:planFixture(),planUpdatedAt:0});
    if(path==="/api/account/sessions")return jsonResponse(200,{userId:currentUser.id,sessions:[]});
    throw new Error(`Unexpected route ${path}`);
  }});
  const focus=page.emitWindow("focus"),visibility=page.emitDocument("visibilitychange");
  await Promise.all([focus,visibility]);await settle();
  assert.equal(identityReads,2,"paired foreground events share one fresh identity request");
  assert.match(page.elements.get("signedInIdentity").textContent,/CURRENT ACCOUNT/);
  stale.resolve(jsonResponse(200,{csrfToken:"stale-csrf",user:staleUser}));await settle();
  const rendered=[...page.elements.values()].map((node)=>`${node.textContent} ${node.innerHTML}`).join(" ");
  assert.doesNotMatch(rendered,/STALE INITIAL ACCOUNT|stale-initial@example\.test/);assert.match(rendered,/CURRENT ACCOUNT/);
});

test("ordinary Account foreground restores purge first and reopen only the same user",async()=>{
  const original=memberFixture({id:"foreground-original",name:"FOREGROUND PRIVATE SENTINEL",email:"foreground-private@example.test",planCount:1,workoutDays:1});
  for(const scenario of [
    {name:"focus with same account",event:"focus",next:original,reopens:true},
    {name:"visibility with changed account",event:"visibilitychange",next:memberFixture({id:"foreground-replacement",name:"REPLACEMENT PRIVATE SENTINEL"}),reopens:false}
  ]){
    let identityReads=0;const pending=deferred(),page=createPage({route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me"){identityReads+=1;return identityReads<=2?jsonResponse(200,{csrfToken:identityReads===1?"foreground-one":"foreground-two",user:original}):pending.promise;}
      if(path==="/api/plan")return jsonResponse(200,{csrfToken:"foreground-two",user:original,plan:planFixture({Monday:1}),planUpdatedAt:1});
      if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{csrfToken:"foreground-two",hasMore:false,workouts:[workoutFixture({title:"FOREGROUND WORKOUT SENTINEL"})]});
      if(path==="/api/account/sessions")return jsonResponse(200,{userId:original.id,sessions:[{id:"FOREGROUND-SESSION-SENTINEL",current:true}]});
      throw new Error(`Unexpected route ${path}`);
    }});
    await settle();const identityReadsBeforeForeground=identityReads;assert.match(page.elements.get("signedInIdentity").textContent,/FOREGROUND PRIVATE SENTINEL/,scenario.name);
    if(scenario.event==="visibilitychange"){page.setHidden(true);await page.emitDocument("visibilitychange");assert.match(page.elements.get("signedInIdentity").textContent,/FOREGROUND PRIVATE SENTINEL/);page.setHidden(false);}
    const foreground=scenario.event==="focus"?page.emitWindow("focus"):page.emitDocument("visibilitychange");
    assert.equal(page.elements.get("signedInCard").hidden,true,`${scenario.name} must lock synchronously`);assert.equal(page.elements.get("accountLoading").hidden,false,scenario.name);
    const lockedDom=[...page.elements.values()].map((node)=>`${node.textContent} ${node.innerHTML} ${node.href}`).join(" ");assert.doesNotMatch(lockedDom,/FOREGROUND PRIVATE SENTINEL|foreground-private@example\.test|FOREGROUND WORKOUT SENTINEL|FOREGROUND-SESSION-SENTINEL/,scenario.name);
    await settle();assert.equal(identityReads,identityReadsBeforeForeground+1,scenario.name);
    pending.resolve(jsonResponse(200,{csrfToken:"foreground-two",user:scenario.next}));await foreground;await settle();
    assert.equal(page.elements.get("signedInCard").hidden,!scenario.reopens,scenario.name);
    if(scenario.reopens)assert.match(page.elements.get("signedInIdentity").textContent,/FOREGROUND PRIVATE SENTINEL/,scenario.name);
    else{assert.equal(page.elements.get("accountLoadingTitle").textContent,"Account access changed.",scenario.name);assert.doesNotMatch([...page.elements.values()].map((node)=>`${node.textContent} ${node.innerHTML}`).join(" "),/REPLACEMENT PRIVATE SENTINEL/,scenario.name);}
  }
});

test("delayed private operation responses cannot outlive an account-page invalidation",async()=>{
  const user=memberFixture({discovery:{active:false,accessType:null,pendingPurchaseCount:0,subscription:{id:"sub-private-operation",status:"paused",active:false,pastDue:false,scheduledChange:null,currentPeriodEndsAt:Date.now()+86400000}}});
  const scenarios=[
    {name:"export",button:"accountExportData",path:"/api/account/export",response:()=>exportResponse({private:"DELAYED-PRIVATE-EXPORT"})},
    {name:"portal",button:"accountManageSubscription",path:"/api/billing/portal",response:()=>jsonResponse(200,{overviewUrl:"https://customer-portal.paddle.com/cpl_delayed_private"})},
    {name:"security email",button:"accountDeleteRequest",path:"/api/account/delete/request",response:()=>jsonResponse(202,{maskedEmail:"DELAYED-PRIVATE-EMAIL"})}
  ];
  for(const scenario of scenarios){
    const pending=deferred(),page=createPage({route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me")return jsonResponse(200,{csrfToken:"operation-csrf",user});if(path==="/api/plan")return jsonResponse(200,{csrfToken:"operation-csrf",user,plan:planFixture(),planUpdatedAt:0});
      if(path==="/api/account/sessions")return jsonResponse(200,{userId:user.id,sessions:[]});if(path===scenario.path)return pending.promise;
      throw new Error(`Unexpected route ${path}`);
    }});
    await settle();const button=page.elements.get(scenario.button),click=button.emit("click",{currentTarget:button});await settle();
    assert.equal(page.requests.some(({path})=>path===scenario.path),true,scenario.name);await page.emitWindow("pageshow",{persisted:true});pending.resolve(scenario.response());await click;await settle();
    assert.equal(page.reloads.length,1,scenario.name);assert.deepEqual(page.downloads,[],scenario.name);assert.deepEqual(page.navigations,[],scenario.name);assert.equal(page.objectUrls.length,0,scenario.name);
    assert.equal(page.elements.get("accountSecurityStatus").textContent,"",scenario.name);assert.equal(page.elements.get("accountDeleteCancel").hidden,true,scenario.name);
    const privateDom=[...page.elements.values()].map((node)=>`${node.textContent} ${node.innerHTML} ${node.href}`).join(" ");assert.doesNotMatch(privateDom,/DELAYED-PRIVATE|cpl_delayed_private/,scenario.name);
  }
});

test("exports and Paddle portal links require the original account identity immediately before use",async()=>{
  const original=memberFixture({id:"original-operation-owner",discovery:{active:false,accessType:null,pendingPurchaseCount:0,subscription:{id:"sub-original",status:"paused",active:false,pastDue:false,scheduledChange:null,currentPeriodEndsAt:Date.now()+86400000}}}),changed=memberFixture({id:"replacement-operation-owner"});
  const scenarios=[
    {name:"export",button:"accountExportData",path:"/api/account/export",response:()=>exportResponse({private:"CROSS-ACCOUNT-EXPORT"})},
    {name:"portal",button:"accountManageSubscription",path:"/api/billing/portal",response:()=>jsonResponse(200,{overviewUrl:"https://customer-portal.paddle.com/cpl_cross_account"})}
  ];
  for(const scenario of scenarios){
    let identityReads=0;const page=createPage({route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me"){identityReads+=1;return jsonResponse(200,{csrfToken:`identity-${identityReads}`,user:identityReads===1?original:changed});}
      if(path==="/api/plan")return jsonResponse(200,{csrfToken:"identity-1",user:original,plan:planFixture(),planUpdatedAt:0});
      if(path==="/api/account/sessions")return jsonResponse(200,{userId:original.id,sessions:[]});if(path===scenario.path)return scenario.response();
      throw new Error(`Unexpected route ${path}`);
    }});
    await settle();const button=page.elements.get(scenario.button);await button.emit("click",{currentTarget:button});await settle();
    assert.equal(identityReads,2,scenario.name);assert.deepEqual(page.downloads,[],scenario.name);assert.deepEqual(page.navigations,[],scenario.name);assert.equal(page.objectUrls.length,0,scenario.name);
    assert.equal(page.elements.get("signedInCard").hidden,true,scenario.name);assert.equal(page.elements.get("accountLoadingTitle").textContent,"Account access changed.",scenario.name);
  }
});

test("signed-in session and JSON export controls are accessible and CSRF protected",async()=>{
  assert.match(html,/id="accountSessionsTitle"/);assert.match(html,/id="accountSessionList"[^>]*aria-label="Active signed-in sessions"/);
  assert.match(html,/id="accountRevokeOtherSessions"[^>]*aria-describedby="accountSessionStatus"/);
  assert.match(html,/id="accountExportData"[^>]*aria-describedby="accountExportStatus"/);
  const user=memberFixture({discovery:{active:false,accessType:null,pendingPurchaseCount:0}}),current={id:"session-current",current:true,createdAt:1_700_000_000_000,expiresAt:1_800_000_000_000},other={id:"session-other",current:false,createdAt:1_710_000_000_000,expiresAt:1_810_000_000_000};let identityReads=0;
  const page=createPage({route:async(path,options)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me"){identityReads+=1;return jsonResponse(200,{csrfToken:identityReads===1?"csrf-self-service":"csrf-plan-rotated",user});}
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf-plan-rotated",user,plan:planFixture(),planUpdatedAt:0});
    if(path==="/api/account/sessions"&&(!options.method||options.method==="GET"))return jsonResponse(200,{userId:user.id,sessions:[current,other],otherCount:1});
    if(path==="/api/account/sessions/revoke-others")return jsonResponse(200,{ok:true,revoked:1,sessions:[current],otherCount:0});
    if(path==="/api/account/export")return exportResponse({format:"strata-account-export",schemaVersion:1,exportedAt:"2026-09-08T00:00:00.000Z",account:{id:user.id}});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.match(page.elements.get("accountSessionList").innerHTML,/This session/);
  assert.match(page.elements.get("accountSessionList").innerHTML,/data-revoke-session="session-other"/);
  assert.equal(page.elements.get("accountRevokeOtherSessions").disabled,false);
  await page.elements.get("accountRevokeOtherSessions").emit("click",{currentTarget:page.elements.get("accountRevokeOtherSessions")});
  await settle();
  const revoke=page.requests.find(({path})=>path==="/api/account/sessions/revoke-others");
  assert.equal(revoke.options.headers["X-CSRF-Token"],"csrf-plan-rotated");assert.equal(revoke.options.body,"{}");
  assert.match(page.elements.get("accountSessionStatus").textContent,/1 other session/);
  await page.elements.get("accountExportData").emit("click",{currentTarget:page.elements.get("accountExportData")});
  await settle();
  const exported=page.requests.find(({path})=>path==="/api/account/export");
  assert.equal(exported.options.method,"POST");assert.equal(exported.options.headers["X-CSRF-Token"],"csrf-plan-rotated");
  assert.deepEqual(page.downloads,[{href:"blob:strata-1",download:"strata-account-export-2026-09-08.json"}]);
  assert.equal(page.objectUrls.length,1);assert.match(page.elements.get("accountExportStatus").textContent,/downloaded/i);
});

test("explicit account modes bring the requested form into view on every viewport",async()=>{
  for(const mode of ["signup","login"]){
    const page=createPage({
      search:`?mode=${mode}`,
      route:async(path)=>{
        if(path==="/api/status")return jsonResponse(200,{persistent:true});
        if(path==="/healthz")return jsonResponse(200,{ok:true});
        if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
        throw new Error(`Unexpected route ${path}`);
      }
    });
    await settle();
    assert.equal(page.elements.get(`${mode}Panel`).scrolled,true,`${mode} panel should scroll into view`);
    assert.equal(page.elements.get(`${mode}Title`).focused,true,`${mode} title should receive focus`);
  }
});

test("login accepts existing password lengths while new passwords keep the stronger minimum",()=>{
  const signupPassword=html.match(/<input\b[^>]*id="signupPassword"[^>]*>/)?.[0]||"";
  const loginPassword=html.match(/<input\b[^>]*id="loginPassword"[^>]*>/)?.[0]||"";
  assert.match(signupPassword,/minlength="10"/);
  assert.doesNotMatch(loginPassword,/minlength=/,"login must not reject a valid legacy password in browser validation");
  assert.match(loginPassword,/maxlength="128"/);
});

test("password visibility controls expose state without changing form behavior",async()=>{
  assert.match(html,/id="signupPasswordToggle"[^>]*type="button"[^>]*aria-controls="signupPassword"[^>]*aria-pressed="false"/);
  assert.match(html,/id="loginPasswordToggle"[^>]*type="button"[^>]*aria-controls="loginPassword"[^>]*aria-pressed="false"/);
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  const input=page.elements.get("signupPassword"),button=page.elements.get("signupPasswordToggle");
  await button.emit("click");
  assert.equal(input.type,"text");
  assert.equal(button.getAttribute("aria-pressed"),"true");
  assert.equal(button.textContent,"Hide");
  await button.emit("click");
  assert.equal(input.type,"password");
  assert.equal(button.getAttribute("aria-pressed"),"false");
  assert.equal(button.textContent,"Show");
});

test("auth submit buttons communicate progress and restore after failure",async()=>{
  let finishLogin;
  const pendingLogin=new Promise((resolve)=>{finishLogin=resolve;});
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
    if(path==="/api/login")return pendingLogin;
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  const form=page.elements.get("loginForm"),button=page.elements.get("loginSubmit");
  form.values={email:"returning@example.test",password:"existing-password"};
  const pending=form.emit("submit",{preventDefault(){}});
  await new Promise(setImmediate);
  assert.equal(button.dataset.busy,"true");
  assert.match(button.getAttribute("aria-label"),/signing in/i);
  finishLogin(jsonResponse(401,{error:"Email or password is incorrect."}));
  await pending;
  assert.equal(button.dataset.busy,undefined);
  assert.equal(button.getAttribute("aria-label"),null);
  assert.equal(button.disabled,false);
});

test("a login error stays scoped to the login form",async()=>{
  const page=createPage({
    search:"?mode=login&error=Email%20or%20password%20is%20incorrect.",
    route:async(path)=>{
      if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
      throw new Error(`Unexpected route ${path}`);
    }
  });
  await settle();
  const {elements}=page;
  assert.equal(elements.get("signupSubmit").disabled,false);
  assert.equal(elements.get("loginMessage").hidden,false);
  assert.equal(elements.get("loginMessage").textContent,"Email or password is incorrect.");

});

test("signed-in dashboard distinguishes access and plan states with a useful next action",async()=>{
  const periodEnd=Date.now()+30*24*60*60*1000,cancelAt=Date.now()+7*24*60*60*1000;
  const subscription=(status,overrides={})=>({id:`sub-${status}`,status,active:["active","trialing","past_due"].includes(status),pastDue:status==="past_due",scheduledChange:null,currentPeriodEndsAt:periodEnd,...overrides});
  const cases=[
    {
      name:"active monthly account with a populated week",planCount:6,workoutDays:3,
      discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:subscription("active")},
      access:"Active",detail:/Monthly · renews/i,primary:"Open next workout",href:/^\/workout\.html\?day=/,discoveryAction:"Open Strata+ studio →",billing:/next renewal/i,badge:"Active",cancel:true
    },
    {
      name:"active monthly account with a complimentary grant",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"paid",pendingPurchaseCount:0,adminGrant:{active:true,startedAt:Date.now(),expiresAt:cancelAt,revokedAt:null},subscription:subscription("active")},
      access:"Complimentary",detail:/Until /i,grantMessage:/monthly subscription remains separate/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/next renewal/i,badge:"Active",cancel:true
    },
    {
      name:"complimentary grant without paid billing",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"grant",pendingPurchaseCount:0,adminGrant:{active:true,startedAt:Date.now(),expiresAt:null,revokedAt:null},subscription:null},
      access:"Complimentary",detail:/Until revoked/i,grantMessage:/did not create a paid subscription/i,grantMessageNot:/manage it below/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:null
    },
    {
      name:"grandfathered lifetime account with a complimentary grant",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"paid",pendingPurchaseCount:0,adminGrant:{active:true,startedAt:Date.now(),expiresAt:cancelAt,revokedAt:null},subscription:null},
      access:"Complimentary",detail:/Until /i,grantMessage:/grandfathered lifetime access remains separate/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/prior lifetime purchase remains active/i,badge:"Grandfathered",manage:false
    },
    {
      name:"grandfathered lifetime account",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"paid",pendingPurchaseCount:0,subscription:null},
      access:"Lifetime",detail:/grandfathered · no renewal/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/prior lifetime purchase remains active/i,badge:"Grandfathered",manage:false
    },
    {
      name:"scheduled cancellation",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:subscription("active",{scheduledChange:{action:"cancel",effectiveAt:cancelAt}})},
      access:"Canceling",detail:/Access through/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/Cancellation takes effect/i,badge:"Canceling",cancel:false
    },
    {
      name:"scheduled pause",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:subscription("active",{scheduledChange:{action:"pause",effectiveAt:cancelAt}})},
      access:"Pausing",detail:/Access through/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/subscription pauses/i,badge:"Pausing",cancel:true
    },
    {
      name:"past-due subscription",planCount:0,workoutDays:0,
      discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:subscription("past_due")},
      access:"Past due",detail:/Update payment method/i,primary:"Build your week",href:/^\/onboarding\.html$/,discoveryAction:"Open Strata+ studio →",billing:/could not collect/i,badge:"Past due",update:true,cancel:true
    },
    {
      name:"expired cached subscription",planCount:0,workoutDays:0,
      discovery:{active:false,accessType:null,pendingPurchaseCount:0,subscription:subscription("active",{active:false,currentPeriodEndsAt:Date.now()-1})},
      access:"Inactive",detail:/Paid access inactive/i,primary:"Build your week",href:/^\/planner\.html$/,discoveryAction:"Manage Strata+ billing →",billing:/last verified billing period/i,badge:"Inactive",cancel:true
    },
    {
      name:"paused subscription",planCount:0,workoutDays:0,
      discovery:{active:false,accessType:null,pendingPurchaseCount:0,subscription:subscription("paused")},
      access:"Paused",detail:/Paid access inactive/i,primary:"Build your week",href:/^\/planner\.html$/,discoveryAction:"Manage Strata+ billing →",billing:/subscription is paused/i,badge:"Paused",cancel:true
    },
    {
      name:"canceled subscription",planCount:0,workoutDays:0,
      discovery:{active:false,accessType:null,pendingPurchaseCount:0,subscription:subscription("canceled")},
      access:"Canceled",detail:/No future renewals/i,primary:"Build your week",href:/^\/planner\.html$/,discoveryAction:"Restart Strata+ →",billing:/no future renewals/i,badge:"Canceled",cancel:false
    },
    {
      name:"pending purchase without a week",planCount:0,workoutDays:0,
      discovery:{active:false,accessType:null,pendingPurchaseCount:1},
      access:"Pending",detail:/checkout needs attention/i,primary:"Build your week",href:/^\/planner\.html$/,discoveryAction:"Check Strata+ subscription →",billing:null
    },
    {
      name:"free account with a populated week",planCount:2,workoutDays:2,
      discovery:{active:false,accessType:null,pendingPurchaseCount:0},
      access:"Free",detail:/rankings and plan included/i,primary:"Open your week",href:/^\/planner\.html$/,discoveryAction:"Unlock Strata+ →",billing:null
    }
  ];
  for(const [index,fixture] of cases.entries()){
    const dayCounts=fixture.planCount===6?{Monday:2,Wednesday:2,Friday:2}:fixture.planCount===2?{Tuesday:1,Thursday:1}:{};
    const user={
      id:`member-${index}`,name:"Ari",email:"ari@example.test",createdAt:1704067200000,
      planCount:fixture.planCount,workoutDays:fixture.workoutDays,isAdmin:false,discovery:fixture.discovery,accountDeletion:{pending:false}
    };
    const page=createPage({route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});
      if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf-test",user});
      if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf-test",user,plan:planFixture(dayCounts),planUpdatedAt:10});
      if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{workouts:[],hasMore:false,csrfToken:"csrf-test"});
      throw new Error(`Unexpected route ${path}`);
    }});
    await settle();
    assert.equal(page.elements.get("signedInCard").hidden,false,fixture.name);
    assert.equal(page.elements.get("accountAccess").hidden,true,fixture.name);
    assert.equal(page.elements.get("accountPlanCount").textContent,String(fixture.planCount),fixture.name);
    assert.equal(page.elements.get("accountWorkoutDays").textContent,String(fixture.workoutDays),fixture.name);
    assert.equal(page.elements.get("accountAccessState").textContent,fixture.access,fixture.name);
    assert.match(page.elements.get("accountAccessDetail").textContent,fixture.detail,fixture.name);
    if(fixture.grantMessage)assert.match(page.elements.get("accountDiscoveryStatus").textContent,fixture.grantMessage,fixture.name);
    if(fixture.grantMessageNot)assert.doesNotMatch(page.elements.get("accountDiscoveryStatus").textContent,fixture.grantMessageNot,fixture.name);
    assert.match(page.elements.get("accountMemberSince").textContent,/2024/,fixture.name);
    assert.equal(page.elements.get("accountPrimaryLabel").textContent,fixture.primary,fixture.name);
    assert.match(page.elements.get("accountPrimaryAction").href,fixture.href,fixture.name);
    assert.equal(page.elements.get("accountDiscoveryAction").textContent,fixture.discoveryAction,fixture.name);
    assert.equal(page.elements.get("accountBilling").hidden,fixture.billing===null,fixture.name);
    if(fixture.billing){
      assert.match(page.elements.get("accountBillingDetail").textContent,fixture.billing,fixture.name);
      assert.equal(page.elements.get("accountBillingBadge").textContent,fixture.badge,fixture.name);
      assert.equal(page.elements.get("accountManageSubscription").hidden,fixture.manage===false,fixture.name);
      assert.equal(page.elements.get("accountUpdatePayment").hidden,fixture.update!==true,fixture.name);
      assert.equal(page.elements.get("accountCancelSubscription").hidden,fixture.cancel!==true,fixture.name);
    }
  }
});

test("subscription controls use the CSRF-protected Paddle portal and clear private data when access expires",async()=>{
  const user=memberFixture({discovery:{active:true,accessType:"subscription",pendingPurchaseCount:0,subscription:{id:"sub-active",status:"active",active:true,pastDue:false,scheduledChange:null,currentPeriodEndsAt:Date.now()+30*24*60*60*1000}}});
  let unsafe=false,sessionExpired=false;
  const page=createPage({route:async(path,options)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"billing-csrf",user});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"billing-csrf",user,plan:planFixture({Monday:1}),planUpdatedAt:10});
    if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{workouts:[],hasMore:false,csrfToken:"billing-csrf"});
    if(path==="/api/billing/portal"){
      assert.equal(options.method,"POST");assert.equal(options.headers["X-CSRF-Token"],"billing-csrf");assert.equal(options.body,"{}");
      if(sessionExpired)return jsonResponse(403,{error:"Security check expired."});
      return jsonResponse(200,{overviewUrl:unsafe?"https://attacker.test/cpl_bad":"https://customer-portal.paddle.com/cpl_overview",cancelUrl:"https://customer-portal.paddle.com/cpl_cancel",updatePaymentMethodUrl:"https://customer-portal.paddle.com/cpl_payment"});
    }
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  await page.elements.get("accountManageSubscription").emit("click",{currentTarget:page.elements.get("accountManageSubscription")});
  await settle();
  await page.elements.get("accountCancelSubscription").emit("click",{currentTarget:page.elements.get("accountCancelSubscription")});
  await settle();
  assert.deepEqual(page.navigations,["https://customer-portal.paddle.com/cpl_overview","https://customer-portal.paddle.com/cpl_cancel"]);
  unsafe=true;await page.elements.get("accountManageSubscription").emit("click",{currentTarget:page.elements.get("accountManageSubscription")});await settle();
  assert.equal(page.navigations.length,2,"an off-origin portal URL must never be opened");
  assert.match(page.elements.get("accountBillingStatus").textContent,/invalid subscription-management link/i);
  assert.equal(page.elements.get("accountBillingStatus").classList.contains("bad"),true);
  sessionExpired=true;await page.elements.get("accountManageSubscription").emit("click",{currentTarget:page.elements.get("accountManageSubscription")});await settle();
  assert.equal(page.elements.get("signedInCard").hidden,true);assert.equal(page.elements.get("accountLoadingTitle").textContent,"Account access changed.");assert.equal(page.elements.get("signedInIdentity").textContent,"");assert.equal(page.elements.get("accountBillingDetail").textContent,"");
});

test("returning dashboard prioritizes an in-progress workout as the single next action",async()=>{
  const user=memberFixture({planCount:2,workoutDays:1}),plan=planFixture({Monday:2});
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf",user});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf",user,plan,planUpdatedAt:11});
    if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{csrfToken:"csrf",hasMore:false,workouts:[workoutFixture({status:"active",completedAt:null,title:"Monday upper",completedSets:1,totalSets:5})]});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.equal(page.elements.get("accountPrimaryLabel").textContent,"Continue workout");
  assert.equal(page.elements.get("accountPrimaryAction").href,"/workout.html#resume=workout-1");
  assert.equal(page.elements.get("accountNextEyebrow").textContent,"Workout in progress");
  assert.equal(page.elements.get("accountNextTitle").textContent,"Monday upper");
  assert.match(page.elements.get("accountNextDetail").textContent,/1 of 5 sets completed/i);
});

test("a workout completed today moves Next up to the following planned day",async()=>{
  const todayIndex=(new Date().getDay()+6)%7,today=WEEKDAYS[todayIndex],next=WEEKDAYS[(todayIndex+1)%7];
  const user=memberFixture({planCount:2,workoutDays:2}),plan=planFixture({[today]:1,[next]:1});
  const latest=workoutFixture({id:"latest",planDay:today,date:thisWeekDate(today),startedAt:200,title:"Today strength",completedSets:4,totalSets:4});
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf",user});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf",user,plan,planUpdatedAt:12});
    if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{csrfToken:"csrf",hasMore:false,workouts:[latest]});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.equal(page.elements.get("accountNextTitle").textContent,`${next} workout`);
  assert.match(page.elements.get("accountNextEyebrow").textContent,/^Tomorrow/);
  assert.equal(page.elements.get("accountPrimaryLabel").textContent,"Open next workout");
});

test("free and temporarily unavailable dashboards still point to the next planned day",async()=>{
  const freeUser=memberFixture({planCount:2,workoutDays:2,discovery:{active:false,accessType:null,pendingPurchaseCount:0}}),plan=planFixture({Tuesday:1,Thursday:1});
  const free=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf",user:freeUser});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf",user:freeUser,plan});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.equal(free.requests.some(({path})=>path.startsWith("/api/workouts")),false);
  assert.match(free.elements.get("accountNextDetail").textContent,/1 movement in your saved plan/i);
  assert.equal(free.elements.get("accountPrimaryLabel").textContent,"Open your week");

  const paidUser=memberFixture({planCount:2,workoutDays:2});
  const historyUnavailable=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf",user:paidUser});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"csrf",user:paidUser,plan});
    if(path==="/api/workouts?limit=100&offset=0")throw new Error("offline");
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.match(historyUnavailable.elements.get("accountNextDetail").textContent,/Completion history is temporarily unavailable/i);
  assert.equal(historyUnavailable.elements.get("accountPrimaryLabel").textContent,"Open next workout");
});

test("dashboard refuses to combine plan or workout data across account changes",async()=>{
  const original=memberFixture({id:"original",name:"ORIGINAL PRIVATE SENTINEL",email:"original-private@example.test",planCount:1,workoutDays:1}),changed=memberFixture({id:"changed",planCount:1,workoutDays:1});
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me")return jsonResponse(200,{csrfToken:"csrf",user:original});
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"new-csrf",user:changed,plan:planFixture({Monday:1})});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.equal(page.requests.some(({path})=>path.startsWith("/api/workouts")),false);
  assert.equal(page.elements.get("signedInCard").hidden,true);
  assert.equal(page.elements.get("accountLoading").hidden,false);
  assert.equal(page.elements.get("accountLoadingTitle").textContent,"Account access changed.");
  assert.equal(page.elements.get("accountReload").hidden,false);
  assert.equal(page.elements.get("signedInIdentity").textContent,"");assert.equal(page.elements.get("accountGreeting").textContent,"");assert.equal(page.elements.get("accountPlanCount").textContent,"");
  await page.elements.get("accountReload").emit("click");
  assert.equal(page.reloads.length,1);
});

test("dashboard rechecks identity after workout history before combining private account data",async()=>{
  const original=memberFixture({id:"original",planCount:1,workoutDays:1}),changed=memberFixture({id:"changed",planCount:1,workoutDays:1});let identityReads=0;
  const page=createPage({route:async(path)=>{
    if(path==="/api/status")return jsonResponse(200,{persistent:true});
    if(path==="/healthz")return jsonResponse(200,{ok:true});
    if(path==="/api/me"){identityReads+=1;return jsonResponse(200,identityReads===1?{csrfToken:"original-csrf",user:original}:{csrfToken:"changed-csrf",user:changed});}
    if(path==="/api/plan")return jsonResponse(200,{csrfToken:"original-csrf",user:original,plan:planFixture({Monday:1})});
    if(path==="/api/workouts?limit=100&offset=0")return jsonResponse(200,{csrfToken:"changed-csrf",hasMore:false,workouts:[workoutFixture({status:"active",completedAt:null,title:"CHANGED ACCOUNT PRIVATE TITLE"})]});
    throw new Error(`Unexpected route ${path}`);
  }});
  await settle();
  assert.equal(identityReads,2);
  assert.equal(page.elements.get("signedInCard").hidden,true);
  assert.equal(page.elements.get("accountLoadingTitle").textContent,"Account access changed.");
  assert.doesNotMatch(page.elements.get("accountNextTitle").textContent,/CHANGED ACCOUNT PRIVATE TITLE/);
});

test("enhanced signup reports an inline error, recovers, and retries",async()=>{
  let signupAttempts=0;
  const page=createPage({
    route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});
      if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
      if(path==="/api/signup"){
        signupAttempts+=1;
        return signupAttempts===1
          ?jsonResponse(409,{error:"An account with that email already exists."})
          :jsonResponse(201,{user:{id:"user-1"}});
      }
      throw new Error(`Unexpected route ${path}`);
    }
  });
  await settle();
  const form=page.elements.get("signupForm");
  form.values={name:"New Lifter",email:"lifter@example.test",password:"secure-password-123"};
  let prevented=false;
  await form.emit("submit",{preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  const firstRequest=page.requests.find((request)=>request.path==="/api/signup");
  assert.equal(firstRequest.options.method,"POST");
  assert.equal(firstRequest.options.credentials,"same-origin");
  assert.equal(firstRequest.options.headers["Content-Type"],"application/json");
  assert.deepEqual(JSON.parse(firstRequest.options.body),{email:"lifter@example.test",password:"secure-password-123",name:"New Lifter"});
  assert.equal(page.elements.get("signupMessage").textContent,"An account with that email already exists.");
  assert.equal(page.elements.get("loginMessage").hidden,true);
  assert.equal(page.elements.get("signupSubmit").disabled,false);
  await form.emit("input");
  assert.equal(page.elements.get("signupMessage").hidden,true);
  await form.emit("submit",{preventDefault(){}});
  assert.equal(signupAttempts,2);
  assert.deepEqual(page.navigations,["/planner.html"]);
});

test("enhanced login uses its own endpoint and keeps failures retryable",async()=>{
  const page=createPage({
    search:"?mode=login&next=planner&add=flat-dumbbell-press",
    route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});
      if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
      if(path==="/api/login")return jsonResponse(401,{error:"Email or password is incorrect."});
      throw new Error(`Unexpected route ${path}`);
    }
  });
  await settle();
  const form=page.elements.get("loginForm");
  form.values={email:"returning@example.test",password:"incorrect-password"};
  await form.emit("submit",{preventDefault(){}});
  const loginRequest=page.requests.find((request)=>request.path==="/api/login");
  assert.deepEqual(JSON.parse(loginRequest.options.body),{email:"returning@example.test",password:"incorrect-password"});
  assert.equal(page.elements.get("loginMessage").hidden,false);
  assert.equal(page.elements.get("signupMessage").hidden,true);
  assert.equal(page.elements.get("loginSubmit").disabled,false);
  assert.equal(form.getAttribute("aria-busy"),null);
  assert.deepEqual(page.navigations,[]);
});

test("enhanced login and verification preserve only exact workout and onboarding destinations",async()=>{
  const destinations=[
    ["workout","/workout.html"],["/workout.html","/workout.html"],
    ["onboarding","/onboarding.html"],["/onboarding.html","/onboarding.html"],
    ["https://outside.test/workout.html","/planner.html"],["//outside.test/onboarding.html","/planner.html"],
    ["/workout.html?day=Monday","/workout.html?day=Monday"],["/workout.html?day=Funday","/planner.html"],["/workout.html?day=Monday&next=//outside.test","/planner.html"],
    ["/workout.html?next=https://outside.test","/planner.html"],["/onboarding.html/../../outside","/planner.html"]
  ];
  for(const [requested,destination] of destinations)for(const verify of [false,true]){
    const page=createPage({search:`?mode=login&next=${encodeURIComponent(requested)}`,route:async(path)=>{
      if(path==="/api/status")return jsonResponse(200,{persistent:true});
      if(path==="/healthz")return jsonResponse(200,{ok:true});
      if(path==="/api/me")return jsonResponse(401,{error:"Not signed in."});
      if(path==="/api/login")return verify?jsonResponse(202,{verificationRequired:true,purpose:"login",maskedEmail:"r***@example.test"}):jsonResponse(200,{user:{id:"returning"}});
      throw new Error(`Unexpected route ${path}`);
    }});
    await settle();
    assert.equal(page.elements.get("loginNext").value,destination);
    const form=page.elements.get("loginForm");form.values={email:"returning@example.test",password:"existing-password"};
    await form.emit("submit",{preventDefault(){}});
    assert.deepEqual(page.navigations,[verify?`/verify-email.html?${new URLSearchParams({next:destination.includes("?")?destination:destination.slice(1,-5),purpose:"login"})}`:destination]);
  }
});
