"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const logic=require("../public/scripts/account-logic");
const stateModule=require("../public/scripts/account-state");
const apiModule=require("../public/scripts/account-api");
const events=require("../public/scripts/account-events");

test("account pure logic constrains redirects and derives access state",()=>{
  assert.equal(logic.safeNext("https://evil.example/steal"),"/planner.html");
  assert.equal(logic.safeNext("planner","flat-dumbbell-press"),"/planner.html?add=flat-dumbbell-press");
  assert.equal(logic.verificationLocation("/workout.html?day=Monday",{purpose:"login"}),"/verify-email.html?next=%2Fworkout.html%3Fday%3DMonday&purpose=login");
  assert.deepEqual(logic.accountAccessSummary({discovery:{active:false,accessType:null}},false),{
    state:"Free",detail:"Rankings and Plan included",message:"The exercise index and weekly planner are free. Strata+ is available as a $2.99 USD monthly subscription."
  });
  assert.equal(logic.safePortalUrl("https://customer-portal.paddle.com/cpl_123"),"https://customer-portal.paddle.com/cpl_123");
  assert.equal(logic.safePortalUrl("https://customer-portal.paddle.com.evil.test/cpl_123"),"");
});

test("account pure logic explains every trial, grant, subscription, and legacy access state",()=>{
  const now=Date.parse("2026-09-10T12:00:00Z"),future=now+2*24*60*60*1000;
  const discovery=(value)=>({discovery:value});
  assert.deepEqual(logic.accountAccessSummary(discovery({active:true,accessType:"trial",trial:{expiresAt:future}}),false,now),{
    state:"Trial",detail:"2d 0h remaining",message:"Your free trial ends automatically and will never convert into a paid subscription."
  });
  assert.equal(logic.accountAccessSummary(discovery({active:true,adminGrant:{active:true,expiresAt:null}})).detail,"Until revoked");
  assert.match(logic.accountAccessSummary(discovery({active:true,adminGrant:{active:true,expiresAt:future},subscription:{id:"sub_1"}})).message,/subscription remains separate/);
  assert.match(logic.accountAccessSummary(discovery({active:true,accessType:"lifetime",adminGrant:{active:true,expiresAt:future}})).message,/lifetime access remains separate/);

  const subscribed=(subscription)=>discovery({active:subscription.active===true,accessType:"subscription",subscription:{id:"sub_1",...subscription}});
  assert.equal(logic.accountAccessSummary(subscribed({status:"paused",active:false})).state,"Paused");
  assert.equal(logic.accountAccessSummary(subscribed({status:"canceled",active:false})).state,"Canceled");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:false})).state,"Inactive");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,scheduledChange:{action:"cancel",effectiveAt:future}})).state,"Canceling");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,scheduledChange:{action:"pause",effectiveAt:future}})).state,"Pausing");
  assert.equal(logic.accountAccessSummary(subscribed({status:"past_due",active:true,pastDue:true})).state,"Past due");
  assert.equal(logic.accountAccessSummary(subscribed({status:"active",active:true,currentPeriodEndsAt:future})).state,"Active");
  assert.equal(logic.accountAccessSummary(discovery({active:true,accessType:"lifetime"})).state,"Lifetime");
  assert.equal(logic.accountAccessSummary(discovery({active:false}),true).state,"Pending");
});

test("account pure logic covers safe handoffs, useful errors, plan timing, and comparable records",()=>{
  for(const [input,expected] of [["pricing","/pricing"],["discover","/discover.html"],["admin","/admin"],["workout","/workout.html"],["onboarding","/onboarding.html"]]){
    assert.equal(logic.safeNext(input),expected);
  }
  assert.equal(logic.safeNext("/workout.html?day=Friday"),"/workout.html?day=Friday");
  assert.match(logic.verificationLocation("/pricing",{deliveryState:"failed"}),/next=pricing.*delivery=failed/);
  assert.match(logic.verificationLocation("/discover.html"),/next=discover/);
  assert.match(logic.verificationLocation("/admin"),/next=admin/);
  assert.match(logic.verificationLocation("/onboarding.html"),/next=onboarding/);
  assert.match(logic.verificationLocation("/planner.html?add=bench-press"),/next=planner.*add=bench-press/);
  assert.equal(logic.safeQueryError(""),"");
  assert.equal(logic.safeQueryError("untrusted"),"Unable to complete the account request. Please try again.");
  assert.match(logic.friendlyAuthError({code:"EMAIL_DELIVERY_FAILED"},"signup"),/verification email/);
  assert.match(logic.friendlyAuthError({status:404},"login"),/Node Web Service/);
  assert.match(logic.friendlyAuthError({code:"network"},"login"),/Check your connection/);
  assert.match(logic.friendlyAuthError({status:503},"signup"),/temporarily unavailable/);
  assert.match(logic.friendlyAuthError({},"signup"),/Could not create/);

  const plan={days:Object.fromEntries(logic.WEEKDAYS.map(day=>[day,day==="Monday"?[{exerciseId:"bench-press"}]:[]]))};
  assert.equal(logic.validPlan(plan),plan);assert.equal(logic.validPlan({days:{}}),null);
  assert.deepEqual(logic.planSummary(plan),{scheduled:["Monday"],movements:1});
  const week=logic.weekContext(new Date(2026,8,7,8));
  assert.equal(logic.nextPlannedDay(plan,new Set(),week).day,"Monday");
  assert.equal(logic.completedThisWeek([{status:"completed",date:logic.localDateKey(week.today)},{status:"active",date:logic.localDateKey(week.today)}],week).length,1);
  assert.equal(logic.formatDuration(59),"59 sec");assert.equal(logic.formatDuration(125),"2m 5s");
  assert.equal(logic.recordMetric({completedSets:1,measurement:"timed",loadType:"bodyweight",maxSeconds:45}).formatted,"45 sec");
  assert.equal(logic.recordMetric({completedSets:1,measurement:"reps",loadType:"external",maxWeight:22.5,unit:"lb"}).formatted,"22.5 lb");
  assert.equal(logic.recordMetric({completedSets:1,measurement:"reps",loadType:"bodyweight",maxReps:12}).formatted,"12 reps");
  assert.equal(logic.recordMetric({completedSets:0}),null);
  const records=logic.recentRecords([
    {status:"completed",date:"2026-09-01",startedAt:1,exerciseSummaries:[{exerciseId:"bench-press",completedSets:1,measurement:"reps",loadType:"external",maxWeight:20,unit:"kg"}]},
    {status:"completed",date:"2026-09-08",startedAt:2,exerciseSummaries:[{exerciseId:"bench-press",completedSets:1,measurement:"reps",loadType:"external",maxWeight:25,unit:"kg"}]}
  ],false);
  assert.equal(records[0].exercise,"Bench Press");assert.equal(records[0].scope,"Saved-history best");
  assert.equal(logic.safePortalUrl("not a url"),"");
  assert.equal(logic.accountBoundaryChanged({status:401}),true);assert.equal(logic.accountBoundaryChanged({status:403}),true);assert.equal(logic.accountBoundaryChanged({code:"account-changed"}),true);
  assert.match(logic.securityError({status:409,message:"Pending"}),/Pending/);
  assert.match(logic.selfServiceError({status:429},"session"),/Too many session/);
  assert.match(logic.billingError({code:"SUBSCRIPTION_NOT_FOUND"}),/No monthly subscription/);
});

test("account state invalidates stale private requests and clears CSRF",()=>{
  const state=stateModule.createState({pendingQueryError:"Try again."});
  const identity=state.beginIdentity();state.setPrivateUser("member-one");const dashboard=state.beginDashboard(),sessions=state.beginSessionList(),operation=state.beginPrivateOperation();
  state.setCsrfToken("csrf-one");
  assert.equal(state.isCurrentIdentity(identity),true);assert.equal(state.isCurrentDashboard(dashboard),true);assert.equal(state.isCurrentSessionList(sessions),true);
  assert.equal(state.isCurrentPrivateOperation(operation),true);
  state.invalidatePrivateRequests();
  assert.equal(state.isCurrentIdentity(identity),false);assert.equal(state.isCurrentDashboard(dashboard),false);assert.equal(state.isCurrentSessionList(sessions),false);assert.equal(state.getCsrfToken(),"");
  assert.equal(state.isCurrentPrivateOperation(operation),false);assert.equal(state.isCurrentPrivateOperation(state.beginPrivateOperation()),false);
  assert.equal(state.takePendingError(),"Try again.");assert.equal(state.takePendingError(),"");
});

test("account API owns endpoint details and attaches current CSRF",async()=>{
  const calls=[];
  const client=apiModule.createClient({
    getCsrfToken:()=>"csrf-current",
    fetchImpl:async(path,options)=>{calls.push({path,options});return{ok:true,status:200,headers:{get:()=>"application/json"},json:async()=>({ok:true,sessions:[]})};}
  });
  await client.revokeSession("session-2");await client.requestDeletion();
  assert.deepEqual(calls.map(({path})=>path),["/api/account/sessions/revoke","/api/account/delete/request"]);
  assert.equal(calls[0].options.headers["X-CSRF-Token"],"csrf-current");
  assert.equal(calls[0].options.body,JSON.stringify({sessionId:"session-2"}));
  assert.equal(calls[1].options.body,"{}");
});

test("account event module binds controls without owning business logic",async()=>{
  class Node{
    constructor(){this.listeners={};this.attributes={};this.textContent="";this.type="password";}
    addEventListener(type,handler){this.listeners[type]=handler;}
    getAttribute(name){return this.attributes[name]??null;}
    setAttribute(name,value){this.attributes[name]=String(value);}
  }
  const input=new Node(),button=new Node();
  events.setupPasswordToggle({input,button,description:"account password"});
  button.listeners.click();
  assert.equal(input.type,"text");assert.equal(button.textContent,"Hide");assert.equal(button.getAttribute("aria-label"),"Hide account password");
});

test("account page loads modules in dependency order before its coordinator",()=>{
  const html=fs.readFileSync(require.resolve("../public/pages/account.html"),"utf8");
  const expected=["devices-core.js","account-logic.js","account-state.js","account-api.js","account-render.js","account-events.js","account-devices.js","account.js"];
  const positions=expected.map((asset)=>html.indexOf(`src="${asset}`));
  assert.ok(positions.every((position)=>position>=0));
  assert.deepEqual(positions,positions.slice().sort((a,b)=>a-b));
});
