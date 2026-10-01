"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");

const PROJECT_ROOT=path.join(__dirname,"..");
const RELEASE=require(path.join(PROJECT_ROOT,"package.json"));
const BUILD=RELEASE.strataBuild||RELEASE.version;
const html=fs.readFileSync(path.join(PROJECT_ROOT,"public","pages","index.html"),"utf8");
const appSource=fs.readFileSync(path.join(PROJECT_ROOT,"public","scripts","app.js"),"utf8");
const homeModuleNames=["entitlements.js","home-logic.js","home-state.js","home-api.js","home-render.js","home-events.js"];
const homeModuleSources=homeModuleNames.map(name=>fs.readFileSync(path.join(PROJECT_ROOT,"public","scripts",name),"utf8"));
const homeRenderSource=homeModuleSources[homeModuleNames.indexOf("home-render.js")];
const catalog=JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT,"public","data","exercises.json"),"utf8"));
const Discovery=require(path.join(PROJECT_ROOT,"public","scripts","discovery-core"));
const Preview=require(path.join(PROJECT_ROOT,"public","scripts","preview-core"));
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map((match)=>match[1]);

class ClassList{
  constructor(){this.values=new Set();}
  add(...names){names.forEach((name)=>this.values.add(name));}
  remove(...names){names.forEach((name)=>this.values.delete(name));}
  toggle(name,force){const enabled=force===undefined?!this.values.has(name):Boolean(force);if(enabled)this.values.add(name);else this.values.delete(name);return enabled;}
  contains(name){return this.values.has(name);}
}

class Element{
  constructor(id){
    this.id=id;this.value="";this.innerHTML="";this.textContent="";this.hidden=false;this.open=false;this.disabled=false;
    this.dataset={};this.attributes={};this.classList=new ClassList();this.listeners={};this.parentElement={classList:new ClassList()};
  }
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  focus(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  querySelector(){return null;}
  querySelectorAll(){return [];}
  get options(){return [...this.innerHTML.matchAll(/<option value="([^"]+)"/g)].map(match=>({value:match[1]}));}
  getBoundingClientRect(){return{left:0,right:1000,top:0,bottom:1000};}
}

function jsonResponse(status,data){
  return{ok:status>=200&&status<300,status,json:async()=>data};
}

function deferred(){
  let resolve,reject;
  const promise=new Promise((onResolve,onReject)=>{resolve=onResolve;reject=onReject;});
  return{promise,resolve,reject};
}

function createRuntime({meResponse,guestPlan=null,serverUser=null,activation=false}={}){
  const elements=new Map(ids.map((id)=>[id,new Element(id)]));
  const starters=["dumbbells","bodyweight","barbell"].map(name=>{const button=new Element(name);button.dataset.previewStarter=name;return button;});
  const storage=new Map();
  const documentListeners={},windowListeners={};
  const document={
    body:new Element("body"),
    visibilityState:"visible",
    getElementById(id){return elements.get(id)||null;},
    addEventListener(type,handler){(documentListeners[type]||=[]).push(handler);},
    querySelectorAll(selector){return selector==="[data-preview-starter]"?starters:[];}
  };
  if(serverUser){
    elements.get("accountButton").textContent=`${serverUser.name} profile`;
    elements.get("accountButton").href="/account.html";
    elements.get("accountButton").classList.add("signed-in");
    elements.get("signupButton").hidden=true;
    elements.get("discoverButton").hidden=false;
    elements.get("discoverButton").href="/discover.html";
    elements.get("discoverButton").textContent="Strata+";
    elements.get("planCount").textContent=String(serverUser.planCount);
    elements.get("planButton").href="/planner.html";
    elements.get("planButton").setAttribute("aria-label",`Open weekly planner, ${serverUser.planCount} exercises`);
  }
  const context={
    console,document,location:{search:""},history:{replaceState(){}},requestAnimationFrame:(callback)=>callback(),setTimeout,clearTimeout,URLSearchParams,
    window:{location:{assign(){}},StrataDiscovery:Discovery,StrataPreview:Preview,addEventListener(type,handler){(windowListeners[type]||=[]).push(handler);}},
    localStorage:{getItem(key){return key==="strata_guest_plan_v1"&&guestPlan!==null?guestPlan:storage.get(key)??null;},setItem(key,value){storage.set(key,value);},removeItem(key){storage.delete(key);}},
    fetch:async(pathname)=>{
      if(pathname==="/api/me")return typeof meResponse==="function"?meResponse():meResponse;
      if(pathname===`/exercises.json?v=${BUILD}`)return jsonResponse(200,catalog);
      return jsonResponse(404,{error:"Not found."});
    }
  };
  context.globalThis=context;
  vm.createContext(context);
  if(activation){
    context.StrataDiscovery=Discovery;context.StrataPreview=Preview;
    context.StrataOnboarding=require("../public/scripts/onboarding-core");
    for(const script of ["activation-core.js","activation-home.js"])vm.runInContext(fs.readFileSync(path.join(PROJECT_ROOT,"public/scripts",script),"utf8"),context,{filename:script});
    context.window.StrataHomeActivation=context.StrataHomeActivation;
  }
  for(let index=0;index<homeModuleNames.length;index+=1)vm.runInContext(homeModuleSources[index],context,{filename:homeModuleNames[index]});
  vm.runInContext(appSource,context,{filename:"app.js"});
  return{
    context,elements,starters,
    emitVisibility(value){document.visibilityState=value;for(const handler of documentListeners.visibilitychange||[])handler();},
    emitWindow(type,event={}){for(const handler of windowListeners[type]||[])handler(event);}
  };
}

async function settle(){
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

test("homepage preserves its server-rendered account header while account state is pending or unavailable",async()=>{
  const pending=deferred();
  const serverUser={name:"Saeed",planCount:4};
  const {context,elements}=createRuntime({meResponse:()=>pending.promise,serverUser});
  await settle();

  assert.equal(vm.runInContext("state.accountStatus",context),"loading");
  assert.equal(elements.get("accountButton").textContent,"Saeed profile");
  assert.equal(elements.get("signupButton").hidden,true);
  assert.equal(elements.get("planCount").textContent,"4");
  assert.doesNotMatch(elements.get("exerciseList").innerHTML,/data-compare=/);

  pending.reject(new TypeError("offline"));
  await settle();

  assert.equal(vm.runInContext("state.accountStatus",context),"unavailable");
  assert.equal(elements.get("accountButton").textContent,"Saeed profile");
  assert.equal(elements.get("signupButton").hidden,true);
  assert.equal(elements.get("discoverButton").textContent,"Strata+");
  assert.equal(elements.get("planCount").textContent,"4");
  assert.doesNotMatch(elements.get("exerciseList").innerHTML,/data-compare=/);
});

test("homepage treats a confirmed 401 as signed out and counts the saved guest plan",async()=>{
  const first=catalog[0].id,second=catalog[1].id,third=catalog[2].id;
  const guestPlan=JSON.stringify({days:{
    Monday:[{exerciseId:first},{exerciseId:second}],
    Tuesday:[{exerciseId:third},{exerciseId:"unknown-exercise"},null],
    Wednesday:"not-an-array"
  }});
  const {context,elements}=createRuntime({meResponse:jsonResponse(401,{error:"Not signed in."}),guestPlan,serverUser:{name:"Stale",planCount:9}});
  await settle();

  assert.equal(vm.runInContext("state.accountStatus",context),"anonymous");
  assert.equal(elements.get("accountButton").textContent,"Log in");
  assert.equal(elements.get("accountButton").href,"/account.html?mode=login");
  assert.equal(elements.get("signupButton").hidden,false);
  assert.equal(elements.get("discoverButton").hidden,true);
  assert.equal(elements.get("planCount").textContent,3);
  assert.equal(elements.get("planButton").getAttribute("aria-label"),"Open weekly planner, 3 exercises");
});

test("homepage clears stale account chrome on foreground before confirming a switched account",async()=>{
  const next=deferred(),responses=[jsonResponse(200,{user:{id:"first",name:"First Member",planCount:7,discovery:{active:true}}}),next.promise];
  const guestPlan=JSON.stringify({days:{Monday:[{exerciseId:catalog[0].id},{exerciseId:catalog[1].id}]}});
  const r=createRuntime({meResponse:()=>responses.shift(),guestPlan});await settle();
  assert.equal(r.elements.get("accountButton").textContent,"First profile");
  assert.equal(r.elements.get("planCount").textContent,7);
  r.elements.get("quickPreviewSummary").textContent="My private device preview";
  r.emitVisibility("hidden");
  assert.equal(r.elements.get("accountButton").textContent,"First profile");
  r.emitVisibility("visible");
  r.emitWindow("focus");
  assert.equal(responses.length,0,"paired visibility and focus events share one account request");
  assert.equal(r.elements.get("accountButton").textContent,"Log in");
  assert.equal(r.elements.get("planCount").textContent,2);
  assert.equal(r.elements.get("quickPreviewSummary").textContent,"My private device preview");
  assert.match(r.elements.get("quickPreviewContinue").innerHTML,/Keep this exact week/);
  next.resolve(jsonResponse(200,{user:{id:"second",name:"Second Member",planCount:3,discovery:{active:false}}}));await settle();
  assert.equal(r.elements.get("accountButton").textContent,"Second profile");
  assert.equal(r.elements.get("planCount").textContent,3);
});

test("homepage window focus clears and restores the same account without touching its guest preview",async()=>{
  const same=deferred(),member={id:"same",name:"Same Member",planCount:4,discovery:{active:true}},responses=[jsonResponse(200,{user:member}),same.promise];
  const r=createRuntime({meResponse:()=>responses.shift()});await settle();
  r.elements.get("quickPreviewSummary").textContent="Keep this preview";
  r.emitWindow("focus");
  assert.equal(r.elements.get("accountButton").textContent,"Log in");
  assert.equal(r.elements.get("quickPreviewSummary").textContent,"Keep this preview");
  same.resolve(jsonResponse(200,{user:member}));await settle();
  assert.equal(r.elements.get("accountButton").textContent,"Same profile");
  assert.equal(r.elements.get("planCount").textContent,4);
});

test("homepage foreground logout settles on guest-safe chrome without clearing its preview",async()=>{
  const responses=[jsonResponse(200,{user:{id:"member",name:"Signed Member",planCount:5,discovery:{active:true}}}),jsonResponse(401,{error:"Not signed in."})];
  const r=createRuntime({meResponse:()=>responses.shift()});await settle();
  r.elements.get("quickPreviewResults").innerHTML="<li>Preserved preview</li>";
  r.emitVisibility("visible");await settle();
  assert.equal(vm.runInContext("state.accountStatus",r.context),"anonymous");
  assert.equal(r.elements.get("accountButton").textContent,"Log in");
  assert.equal(r.elements.get("signupButton").hidden,false);
  assert.equal(r.elements.get("planCount").textContent,0);
  assert.equal(r.elements.get("quickPreviewResults").innerHTML,"<li>Preserved preview</li>");
});

test("homepage persisted pageshow rechecks logout while ordinary pageshow stays calm",async()=>{
  let requests=0;
  const responses=[jsonResponse(200,{user:{id:"member",name:"Cached Member",planCount:5,discovery:{active:true}}}),jsonResponse(401,{error:"Not signed in."})];
  const r=createRuntime({meResponse:()=>{requests+=1;return responses.shift();}});await settle();
  r.emitWindow("pageshow",{persisted:false});await settle();
  assert.equal(requests,1);
  assert.equal(r.elements.get("accountButton").textContent,"Cached profile");
  r.emitWindow("pageshow",{persisted:true});await settle();
  assert.equal(requests,2);
  assert.equal(r.elements.get("accountButton").textContent,"Log in");
});

test("homepage ignores a stale initial identity response after a newer focus recheck",async()=>{
  const stale=deferred(),fresh=deferred(),responses=[stale.promise,fresh.promise];
  const r=createRuntime({meResponse:()=>responses.shift(),serverUser:{name:"Server",planCount:8}});await settle();
  r.emitWindow("focus");
  fresh.resolve(jsonResponse(200,{user:{id:"fresh",name:"Fresh Member",planCount:2,discovery:{active:false}}}));await settle();
  assert.equal(r.elements.get("accountButton").textContent,"Fresh profile");
  stale.resolve(jsonResponse(200,{user:{id:"stale",name:"Stale Member",planCount:9,discovery:{active:true}}}));await settle();
  assert.equal(r.elements.get("accountButton").textContent,"Fresh profile");
  assert.equal(r.elements.get("planCount").textContent,2);
});

test("homepage rankings carry no comparison controls; Strata+ members get one link to the Library's Compare",async()=>{
  for(const meResponse of [jsonResponse(401,{error:"Not signed in."}),jsonResponse(200,{user:{id:"free",name:"Free Member",discovery:{active:false}}})]){
    const {context,elements}=createRuntime({meResponse});await settle();
    assert.doesNotMatch(elements.get("exerciseList").innerHTML,/data-compare=/);
    vm.runInContext(`openDetail(${JSON.stringify(catalog[0].id)})`,context);
    assert.doesNotMatch(elements.get("detailContent").innerHTML,/discover\.html#battle/,"members without Strata+ see no comparison hand-off");
  }
  const {context,elements}=createRuntime({meResponse:jsonResponse(200,{user:{id:"plus",name:"Plus Member",discovery:{active:true}}})});await settle();
  assert.doesNotMatch(elements.get("exerciseList").innerHTML,/data-compare=/,"the homepage no longer runs its own two-exercise comparison");
  assert.equal(elements.get("compareDock"),undefined);assert.equal(elements.get("compareDialog"),undefined);
  vm.runInContext(`openDetail(${JSON.stringify(catalog[0].id)})`,context);
  assert.match(elements.get("detailContent").innerHTML,/<a class="button"[^>]*href="\/discover\.html#battle">Compare in Strata\+/);
});

test("homepage hides the Strata+ hand-off during a recheck and removes it when access is revoked",async()=>{
  const refreshed=deferred(),responses=[jsonResponse(200,{user:{id:"member",name:"Member",discovery:{active:true}}}),refreshed.promise];
  const {context,elements,emitWindow}=createRuntime({meResponse:()=>responses.shift()});await settle();
  vm.runInContext(`openDetail(${JSON.stringify(catalog[0].id)})`,context);
  assert.match(elements.get("detailContent").innerHTML,/discover\.html#battle/);
  emitWindow("focus");
  assert.equal(vm.runInContext("state.accountStatus",context),"rechecking");
  assert.equal(elements.get("detailDialog").open,true,"the detail stays open; only account-bound controls disappear");
  assert.doesNotMatch(elements.get("detailContent").innerHTML,/discover\.html#battle/);
  refreshed.resolve(jsonResponse(200,{user:{id:"member",name:"Member",discovery:{active:false}}}));await settle();
  assert.equal(vm.runInContext("state.accountStatus",context),"authenticated");
  assert.doesNotMatch(elements.get("detailContent").innerHTML,/discover\.html#battle/);
});

test("homepage preserves focus inside an open detail while account access rerenders",async()=>{
  const refreshed=deferred(),member={id:"member",name:"Member",discovery:{active:true}},responses=[jsonResponse(200,{user:member}),refreshed.promise];
  const {context,elements,emitWindow}=createRuntime({meResponse:()=>responses.shift()});await settle();
  vm.runInContext(`openDetail(${JSON.stringify(catalog[0].id)})`,context);
  const focused={getAttribute:name=>name==="data-add-planner"?catalog[0].id:null,focus(){}};
  const replacement={focused:false,getAttribute:name=>name==="data-add-planner"?catalog[0].id:null,focus(){this.focused=true;}};
  context.document.activeElement=focused;elements.get("detailDialog").contains=control=>control===focused;elements.get("detailDialog").querySelectorAll=selector=>selector==="[data-add-planner]"?[replacement]:[];
  emitWindow("focus");
  assert.equal(replacement.focused,true);assert.equal(elements.get("detailDialog").open,true);assert.doesNotMatch(elements.get("detailContent").innerHTML,/discover\.html#battle/);
  refreshed.resolve(jsonResponse(200,{user:member}));await settle();
  assert.equal(elements.get("detailDialog").open,true);assert.match(elements.get("detailContent").innerHTML,/discover\.html#battle/);
});

test("homepage exercise details expose setup, cues, common mistakes and equipment-equivalent swaps",async()=>{
  const {context,elements}=createRuntime({meResponse:jsonResponse(401,{error:"Not signed in."})});
  await settle();
  vm.runInContext(`openDetail(${JSON.stringify(catalog[0].id)})`,context);
  const detail=elements.get("detailContent").innerHTML;
  assert.match(detail,/>Set up</);
  assert.match(detail,/>Technique cues</);
  assert.match(detail,/Caution \/ Common mistake:/);
  assert.match(detail,/General catalog range/);
  assert.match(detail,/Same target, different equipment/);
  assert.equal((detail.match(/data-detail=/g)||[]).length,3);
});

test("homepage creates a real no-account shortlist with reasons and trade-offs",async()=>{
  const {context,elements}=createRuntime({meResponse:jsonResponse(401,{error:"Not signed in."})});
  await settle();
  elements.get("quickPreviewGoal").value="hypertrophy";
  elements.get("quickPreviewGroup").value="chest";
  vm.runInContext("updatePreviewEquipmentOptions()",context);
  elements.get("quickPreviewEquipment").value="Dumbbells";
  elements.get("quickPreviewLevel").value="Intermediate";
  vm.runInContext("generateQuickPreview()",context);

  assert.match(elements.get("quickPreviewSummary").textContent,/Build muscle · Chest · Dumbbells · Intermediate/);
  assert.equal((elements.get("quickPreviewResults").innerHTML.match(/class="preview-result"/g)||[]).length,3);
  assert.match(elements.get("quickPreviewResults").innerHTML,/Why this moved up/);
  assert.match(elements.get("quickPreviewResults").innerHTML,/Trade-off:/);
  assert.match(elements.get("quickPreviewResults").innerHTML,/Personal match/);
  assert.match(elements.get("quickPreviewResults").innerHTML,/FitScore/);
  assert.equal(elements.get("quickPreviewActions").hidden,false);
  assert.match(elements.get("quickPreviewStatus").textContent,/Shortlist ready/);
});

test("homepage has one score ring and lets JavaScript create the equipment default once",()=>{
  assert.equal((html.match(/class="score-ring"/g)||[]).length,1);
  const equipmentSelect=html.match(/<select id="equipmentFilter">([\s\S]*?)<\/select>/);
  assert.ok(equipmentSelect,"equipment select");
  assert.doesNotMatch(equipmentSelect[1],/All equipment/);
  assert.equal((homeRenderSource.match(/<option value="all">All equipment<\/option>/g)||[]).length,1);
});

test("each starter builds and preserves a real three-day week using its stated equipment",async()=>{
  const {context,elements,starters}=createRuntime({meResponse:jsonResponse(401,{error:"Not signed in."}),activation:true});
  await settle();
  const equipment={dumbbells:"Dumbbells",bodyweight:"Bodyweight",barbell:"Barbell / Smith"};
  for(const button of starters){
    assert.equal(button.disabled,false);
    for(const handler of button.listeners.click)handler();
    const intent=context.StrataActivation.readIntent(context.localStorage);
    assert.ok(intent,`${button.id} must save a recoverable preview`);
    assert.equal(intent.profile.equipment[0],equipment[button.id]);
    const days=Object.values(intent.plan.days).filter(items=>items.length);
    assert.equal(days.length,3);
    for(const item of days.flat())assert.equal(catalog.find(exercise=>exercise.id===item.exerciseId).equipment,equipment[button.id]);
    assert.equal(elements.get("quickWeekPreview").hidden,false);
    assert.equal(elements.get("quickPreviewActions").hidden,false);
    assert.match(elements.get("quickPreviewSummary").textContent,/3-day week ready/);
  }
});

test("the ranking shows the ten best matches first and the rest on request",async()=>{
  const {context,elements}=createRuntime({meResponse:jsonResponse(401,{error:"Sign in"})});
  await settle();
  const rows=()=>(elements.get("exerciseList").innerHTML.match(/class="exercise-row"/g)||[]).length,chest=catalog.filter((item)=>item.group==="chest").length;
  assert.ok(chest>10,"the fixture needs more than ten chest exercises");
  assert.equal(rows(),10);assert.equal(elements.get("exerciseListMore").hidden,false);assert.equal(elements.get("showAllExercises").textContent,`Show all ${chest} exercises`);
  assert.equal(elements.get("resultCount").textContent,chest,"the count still reports every match");
  for(const handler of elements.get("showAllExercises").listeners.click)handler();
  assert.equal(rows(),chest);assert.equal(elements.get("exerciseListMore").hidden,true);
  vm.runInContext('selectGroup("back",false)',context);
  assert.equal(rows(),10,"another muscle group starts again from its top ten");
  context.document.getElementById("searchInput").value="zzzz-no-match";for(const handler of elements.get("searchInput").listeners.input)handler({target:elements.get("searchInput")});
  assert.equal(rows(),0);assert.equal(elements.get("exerciseListMore").hidden,true,"nothing to expand when every match is shown");
});
