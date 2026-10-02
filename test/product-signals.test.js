"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const {EVENTS:SERVER_EVENTS}=require("../src/product-signals");

const ROOT=join(__dirname,"..");
const SCRIPT=readFileSync(join(ROOT,"public/scripts/product-signals.js"),"utf8");
const STORAGE_KEY="strata_product_signals_v1";
const PREFERENCE_KEY="strata_product_signals_preference_v1";
const SHARE_PREFERENCE_KEY="strata_product_signals_share_v1";

class FakeElement{
  constructor({id="",dataset={}}={}){this.id=id;this.dataset=dataset;this.checked=false;this.disabled=false;this.textContent="";this.innerHTML="";this.className="";this.attributes={};this.listeners={};}
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  matches(selector){return selector==="[data-recommendation-feedback]"&&Boolean(this.dataset.recommendationFeedback);}
  closest(){return this;}
  async emit(type){for(const handler of this.listeners[type]||[])await handler({target:this});}
}

function harness({gpc=false,dnt="",values={},blockedStorage=false,withFetch=true,csrfToken=""}={}){
  const store=new Map(Object.entries(values)),windowListeners={},documentListeners={},requests=[],identityRequests=[];
  const elements=new Map([
    "localSignalsToggle","localSignalsStatus","localSignalsSummary","localSignalsActionStatus","aggregateSignalsToggle","aggregateSignalsStatus","recommendationFeedbackStatus","clearLocalSignals","copyLocalSignals"
  ].map((id)=>[id,new FakeElement({id})]));
  const feedback=["useful","not_relevant","not_clear"].map((response)=>new FakeElement({dataset:{recommendationFeedback:response}}));
  const localStorage={
    getItem(key){if(blockedStorage)throw new Error("blocked");return store.get(key)??null;},
    setItem(key,value){if(blockedStorage)throw new Error("blocked");store.set(key,String(value));},
    removeItem(key){if(blockedStorage)throw new Error("blocked");store.delete(key);}
  };
  const body={dataset:{},append(node){elements.set(node.id,node);node.remove=()=>elements.delete(node.id);}};
  const document={
    readyState:"complete",body,
    getElementById(id){return elements.get(id)||null;},
    querySelectorAll(selector){return selector==="[data-recommendation-feedback]"?feedback:[];},
    createElement(){return new FakeElement();},
    addEventListener(type,handler){(documentListeners[type]||=[]).push(handler);}
  };
  const navigator={globalPrivacyControl:gpc,doNotTrack:dnt,clipboard:{async writeText(value){navigator.copied=value;}}};
  const context={
    document,navigator,localStorage,console,Date,
    CustomEvent:class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail;}},
    addEventListener(type,handler){(windowListeners[type]||=[]).push(handler);},
    dispatchEvent(event){for(const handler of windowListeners[event.type]||[])handler(event);return true;}
  };
  if(withFetch)context.fetch=async(path,options)=>{
    // The signed-in check reads the CSRF token from /api/me; a signed-out browser gets a 401 there.
    if(path==="/api/me"){identityRequests.push({path,options});return csrfToken?{ok:true,status:200,json:async()=>({csrfToken})}:{ok:false,status:401,json:async()=>({error:"Sign in required."})};}
    requests.push({path,options});return {ok:true,status:202};
  };
  context.globalThis=context;
  vm.createContext(context);vm.runInContext(SCRIPT,context,{filename:"product-signals.js"});
  return{
    api:context.StrataSignals,store,elements,feedback,navigator,requests,identityRequests,
    async settle(){for(let turn=0;turn<5;turn+=1)await new Promise((resolve)=>setImmediate(resolve));},
    dispatch(name,extra={}){context.dispatchEvent(new context.CustomEvent("strata:milestone",{detail:{name,...extra}}));},
    click(element){for(const handler of documentListeners.click||[])handler({target:element});}
  };
}

function plain(value){return JSON.parse(JSON.stringify(value));}

test("local milestones accept only coarse names and discard arbitrary event detail",()=>{
  const page=harness();
  page.dispatch("preview_generated",{exerciseId:"private-exercise",plan:{Monday:["private"]},email:"person@example.test"});
  page.dispatch("preview_generated",{url:"/private/path"});
  page.dispatch("invented_event",{name:"invented_event",secret:"do-not-store"});

  const stored=JSON.parse(page.store.get(STORAGE_KEY));
  assert.deepEqual(Object.keys(stored.milestones),["preview_generated"]);
  assert.equal(stored.milestones.preview_generated.count,2);
  assert.match(stored.milestones.preview_generated.firstDay,/^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(JSON.stringify(stored),/private-exercise|person@example|private\/path|do-not-store|invented_event/);
  assert.equal(page.api.record("not_allowlisted"),false);
  assert.equal(page.requests.length,0,"nothing is sent before an explicit aggregate-sharing choice");
});

test("normalization drops unknown fields, clamps counters, and exposes a reviewable summary",()=>{
  const page=harness({values:{
    [STORAGE_KEY]:JSON.stringify({version:99,milestones:{plan_saved:{count:9000,firstDay:"bad",lastDay:"2026-09-07",payload:{sets:12}},unknown:{count:1}},recommendationFeedback:{response:"not_clear",day:"2026-09-06",exerciseId:"secret"},accountId:"account-a"})
  }});
  const snapshot=plain(page.api.snapshot());
  assert.equal(snapshot.version,1);
  assert.deepEqual(Object.keys(snapshot.milestones),["plan_saved"]);
  assert.equal(snapshot.milestones.plan_saved.count,999);
  assert.equal(snapshot.milestones.plan_saved.lastDay,"2026-09-07");
  assert.deepEqual(snapshot.recommendationFeedback,{response:"not_clear",day:"2026-09-06"});
  assert.doesNotMatch(page.api.summary(),/secret|account-a|sets/);
  assert.match(page.api.summary(),/Weekly plan saved: 999/);
  assert.match(page.api.summary(),/Future aggregate count sharing: not chosen/);
});

test("privacy signals and explicit opt-out stop local storage and aggregate sharing",async()=>{
  const gpc=harness({gpc:true,values:{[SHARE_PREFERENCE_KEY]:"on"}});
  assert.equal(gpc.api.enabled(),false);
  assert.equal(gpc.api.sharingEnabled(),false);
  assert.equal(gpc.api.record("plan_saved"),false);
  assert.equal(gpc.api.setEnabled(true),false);
  assert.equal(gpc.api.setSharing(true),false);
  assert.equal(gpc.store.has(STORAGE_KEY),false);
  assert.equal(gpc.elements.get("localSignalsToggle").disabled,true);
  assert.match(gpc.elements.get("localSignalsStatus").textContent,/privacy signal/i);
  assert.equal(gpc.requests.length,0);

  const page=harness({values:{[SHARE_PREFERENCE_KEY]:"on"}});page.api.record("workout_started");await page.settle();
  assert.equal(page.requests.length,1);
  assert.equal(page.api.setEnabled(false),true);
  assert.equal(page.store.get(PREFERENCE_KEY),"off");
  assert.equal(page.store.get(SHARE_PREFERENCE_KEY),"off");
  assert.equal(page.store.has(STORAGE_KEY),false);
  assert.equal(page.api.record("workout_completed"),false);
  assert.equal(page.api.feedback("useful"),false);
  await page.settle();
  assert.equal(page.requests.length,1);

  const blocked=harness({blockedStorage:true});
  assert.equal(blocked.api.enabled(),false);
  assert.equal(blocked.api.clear(),false);
  assert.equal(blocked.elements.get("localSignalsToggle").checked,false);
  assert.equal(blocked.elements.get("localSignalsToggle").disabled,true);
  assert.match(blocked.elements.get("localSignalsStatus").textContent,/blocked local storage/i);
});

test("recommendation feedback stores only the latest allowlisted answer",()=>{
  const page=harness();
  assert.equal(page.api.feedback("useful"),true);
  assert.equal(page.api.feedback("free text with private details"),false);
  page.click(page.feedback[1]);
  const stored=JSON.parse(page.store.get(STORAGE_KEY));
  assert.deepEqual(Object.keys(stored.recommendationFeedback).sort(),["day","response"]);
  assert.equal(stored.recommendationFeedback.response,"not_relevant");
  assert.equal(page.feedback[1].getAttribute("aria-pressed"),"true");
  assert.match(page.elements.get("recommendationFeedbackStatus").textContent,/choose whether to share/i);
  assert.equal(page.requests.length,0);
});

test("aggregate transport starts only after consent and sends one allowlisted name",async()=>{
  const page=harness();
  page.dispatch("preview_generated",{email:"private@example.test",url:"/account"});
  assert.ok(page.elements.has("productSignalsConsent"),"a non-blocking consent region should appear after a relevant action");
  assert.equal(page.requests.length,0);

  page.click(new FakeElement({dataset:{signalConsent:"share"}}));
  await page.settle();
  assert.equal(page.store.get(SHARE_PREFERENCE_KEY),"on");
  assert.equal(page.requests.length,1);
  assert.equal(page.requests[0].path,"/api/product-signals");
  assert.equal(page.requests[0].options.method,"POST");
  assert.equal(page.requests[0].options.credentials,"omit","a signed-out browser sends no cookie");
  assert.equal(page.requests[0].options.headers["X-CSRF-Token"],undefined);
  assert.equal(page.requests[0].options.referrerPolicy,"no-referrer");
  assert.deepEqual(JSON.parse(page.requests[0].options.body),{event:"preview_generated"});
  assert.doesNotMatch(page.requests[0].options.body,/private@example|account/);

  page.api.feedback("not_clear");
  await page.settle();
  assert.deepEqual(JSON.parse(page.requests[1].options.body),{event:"recommendation_feedback_not_clear"});
  assert.equal(page.api.feedback("private free text"),false);
  await page.settle();
  assert.equal(page.requests.length,2);
  assert.equal(page.identityRequests.length,1,"the sign-in check runs once per page");
});

test("a signed-in browser sends its session and CSRF token so the count is marked signed in",async()=>{
  const page=harness({csrfToken:"member-token",values:{[SHARE_PREFERENCE_KEY]:"on"}});
  page.api.record("plan_saved");page.api.record("workout_started");
  await page.settle();
  assert.equal(page.identityRequests.length,1);
  assert.equal(page.identityRequests[0].options.credentials,"same-origin");
  assert.equal(page.requests.length,2);
  for(const request of page.requests){
    assert.equal(request.options.credentials,"same-origin");
    assert.equal(request.options.headers["X-CSRF-Token"],"member-token");
    assert.equal(request.options.referrerPolicy,"no-referrer");
  }
  assert.deepEqual(page.requests.map((request)=>JSON.parse(request.options.body)),[{event:"plan_saved"},{event:"workout_started"}]);
});

test("keeping insights on-device records the choice without transmitting",()=>{
  const page=harness();
  page.dispatch("plan_saved");
  page.click(new FakeElement({dataset:{signalConsent:"local"}}));
  assert.equal(page.store.get(SHARE_PREFERENCE_KEY),"off");
  page.dispatch("workout_started");
  assert.equal(page.requests.length,0);
  assert.equal(page.elements.has("productSignalsConsent"),false);
});

test("the consent region can be deferred without changing a preference",()=>{
  const page=harness();
  page.dispatch("plan_saved");
  page.click(new FakeElement({dataset:{signalConsent:"later"}}));
  assert.equal(page.store.has(SHARE_PREFERENCE_KEY),false);
  assert.equal(page.elements.has("productSignalsConsent"),false);
  page.dispatch("workout_started");
  assert.equal(page.elements.has("productSignalsConsent"),false,"not now should suppress another prompt for the current page session");
  assert.equal(page.requests.length,0);
});

test("browser transport and server storage share one exact allowlist",async()=>{
  const page=harness();
  assert.equal(page.api.setSharing(true),true);
  for(const name of page.api.MILESTONES)page.api.record(name);
  for(const response of page.api.FEEDBACK)page.api.feedback(response);
  await page.settle();
  const sent=page.requests.map((entry)=>JSON.parse(entry.options.body).event).sort();
  assert.deepEqual(sent,[...SERVER_EVENTS].sort());
});

test("funnel pages load both isolated signal assets and use the strict event contract",()=>{
  const pages=["index.html","onboarding.html","planner.html","workout.html","pricing.html","discover.html","privacy.html"];
  for(const page of pages){
    const html=readFileSync(join(ROOT,"public/pages",page),"utf8");
    assert.match(html,/product-signals\.js\?v=/,`${page} must load the isolated product-signal module`);
    assert.match(html,/product-signals\.css\?v=/,`${page} must style the optional consent region`);
    if(page!=="privacy.html")assert.match(html,/data-product-signals-consent-host/,`${page} must provide an inline consent host near the relevant workflow`);
  }
  const integrations={
    "public/scripts/onboarding.js":["onboarding_previewed","onboarding_saved"],
    "public/scripts/planner.js":["plan_saved"],
    "public/scripts/workout-events.js":["workout_started","workout_completed"],
    "public/scripts/pricing.js":["upgrade_viewed","checkout_opened","upgrade_activated"]
  };
  for(const [file,names] of Object.entries(integrations)){
    const source=readFileSync(join(ROOT,file),"utf8");
    for(const name of names)assert.match(source,new RegExp(`signal\\("${name}"\\)`),`${file} ${name}`);
  }
  assert.match(readFileSync(join(ROOT,"public/scripts/app.js"),"utf8"),/strata:milestone[\s\S]*preview_generated/);
});

test("public trust copy separates evidence types and states aggregate limitations",()=>{
  const policies=readFileSync(join(ROOT,"public/pages/policies.html"),"utf8");
  const privacy=readFileSync(join(ROOT,"public/pages/privacy.html"),"utf8");
  for(const heading of ["Official FitScore","Personal match","Community rating","Recommendation check","Product activity counts"])assert.match(policies,new RegExp(heading));
  assert.match(policies,/no cited source claims STRATA’s exact numerical ranking/i);
  assert.match(policies,/does not alter FitScore, diagnose injury risk, predict an individual result, or inspect private workout history/i);
  assert.match(policies,/does not train or automatically change the ranking model/i);
  assert.match(policies,/not unique people, conversion cohorts, clinical outcomes, or proof of effectiveness/i);
  assert.match(privacy,/never stores exercise identifiers, recommendation contents, plan contents, set, repetition, load or duration data, page URLs, account identifiers, names, or contact details/i);
  assert.match(privacy,/Each same-origin request contains exactly one allowlisted action name/i);
  assert.match(privacy,/action counts, not unique people or conversion cohorts/i);
  assert.match(privacy,/expire within 90 days/i);
  assert.match(privacy,/does not send these events to a third-party analytics service/i);
  assert.match(privacy,/Global Privacy Control or Do Not Track/i);
});
