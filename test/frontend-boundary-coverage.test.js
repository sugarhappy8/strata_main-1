"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");

const DiscoverApi=require("../public/scripts/discover-api");
const DiscoverProgress=require("../public/scripts/discover-progress");
const Workout=require("../public/scripts/workout-core");
const WorkoutApi=require("../public/scripts/workout-api");
const WorkoutState=require("../public/scripts/workout-state");
const WorkoutCalendar=require("../public/scripts/workout-calendar");
const PlannerLogic=require("../public/scripts/planner-logic");
const PlannerState=require("../public/scripts/planner-state");
const PlannerApi=require("../public/scripts/planner-api");
const PricingLogic=require("../public/scripts/pricing-logic");
const PricingApi=require("../public/scripts/pricing-api");
const HomeLogic=require("../public/scripts/home-logic");
const HomeState=require("../public/scripts/home-state");

function response({ok=true,status=200,data={},jsonError=false}={}){
  return{ok,status,json:async()=>{if(jsonError)throw new Error("invalid json");return data;}};
}

test("discover transport reports actionable save boundaries and safe redirects",async()=>{
  const details=[
    [{name:"AbortError"},/timed out/],
    [{code:"NETWORK_ERROR"},/offline/],
    [{status:401},/session ended/],
    [{status:403},/save token expired/],
    [{status:409},/another tab or device/],
    [{code:"PLAN_CHANGED"},/another tab or device/],
    [{status:422,message:"Choose a valid day."},/Choose a valid day/],
    [{status:503},/could not save right now/],
    [{message:"Specific failure"},/Specific failure/],
    [{message:"Request failed."},/change was not saved/]
  ];
  for(const [error,pattern] of details)assert.match(DiscoverApi.saveErrorDetail(error),pattern);
  assert.match(DiscoverApi.saveRetryMessage({code:"NETWORK_ERROR"}),/^Couldn't save — Retry\./);
  assert.throws(()=>DiscoverApi.createClient({}),/fetch implementation/);

  let lastOptions;
  const read=DiscoverApi.createClient({
    fetchImpl:async(_path,options)=>{lastOptions=options;return response({jsonError:true});},
    getCsrfToken:()=>"",getGeneration:()=>1,redirect:()=>{}
  });
  assert.deepEqual(await read("/api/discovery"),{});
  assert.equal(lastOptions.headers["Content-Type"],undefined);
  assert.equal(lastOptions.headers["X-CSRF-Token"],undefined);

  const redirects=[];
  for(const failure of [
    {status:401,data:{error:"Sign in."},destination:"/account.html?mode=login&next=discover"},
    {status:402,data:{error:"Upgrade."},destination:"/pricing?reason=access-revoked"},
    {status:403,data:{error:"Upgrade.",code:"DISCOVERY_ACCESS_REQUIRED"},destination:"/pricing?reason=access-revoked"}
  ]){
    const client=DiscoverApi.createClient({
      fetchImpl:async()=>response({ok:false,status:failure.status,data:failure.data}),
      getCsrfToken:()=>"csrf",getGeneration:()=>1,redirect:value=>redirects.push(value)
    });
    await assert.rejects(client("/api/plan",{method:"PUT",body:"{}"}),error=>error.status===failure.status&&error.redirecting===true);
    assert.equal(redirects.at(-1),failure.destination);
  }
  const offline=DiscoverApi.createClient({fetchImpl:async()=>{throw new Error("offline");},getCsrfToken:()=>"",getGeneration:()=>1,redirect:()=>{}});
  await assert.rejects(offline("/api/discovery"),error=>error.code==="NETWORK_ERROR"&&error.cause.message==="offline");
});

test("progress logic excludes malformed history and compares each supported metric",()=>{
  assert.deepEqual(DiscoverProgress.safeWorkoutList(null),[]);
  assert.deepEqual(DiscoverProgress.safeWorkoutList([null,{id:1,status:"completed",exerciseSummaries:[]},{id:"bad",status:"deleted",exerciseSummaries:[]},{id:"good",status:"active",exerciseSummaries:[]}]).map(item=>item.id),["good"]);
  assert.equal(DiscoverProgress.formatDuration(-5),"0 sec");
  assert.equal(DiscoverProgress.formatDuration(60),"1 min");
  assert.equal(DiscoverProgress.formatDuration(125),"2m 5s");

  assert.equal(DiscoverProgress.summaryMetric(null),null);
  assert.deepEqual(DiscoverProgress.summaryMetric({completedSets:1,measurement:"timed",maxSeconds:75}),{key:"time",value:75,label:"Longest set",formatted:"1m 15s",higher:true});
  assert.equal(DiscoverProgress.summaryMetric({completedSets:1,loadType:"external",maxWeight:20,unit:"lb"}).key,"load:lb");
  assert.deepEqual(DiscoverProgress.summaryMetric({completedSets:1,loadType:"assisted",minAssistance:15,maxReps:8,unit:"kg"}),{key:"assistance:kg",value:15,label:"Assistance",formatted:"15 kg assistance",higher:false});
  assert.equal(DiscoverProgress.summaryMetric({completedSets:1,maxReps:12}).key,"reps");
  assert.equal(DiscoverProgress.summaryMetric({completedSets:1,maxReps:0}),null);

  const base={status:"completed",date:"2026-09-09",planDay:"Wednesday",exerciseSummaries:[]};
  const history=[
    {...base,id:"first",startedAt:1,exerciseSummaries:[{exerciseId:"pullup",completedSets:1,loadType:"assisted",minAssistance:30,maxReps:6,unit:"kg"}]},
    {...base,id:"second",startedAt:2,exerciseSummaries:[{exerciseId:"pullup",completedSets:1,loadType:"assisted",minAssistance:20,maxReps:8,unit:"kg"}]}
  ];
  const records=DiscoverProgress.exerciseRecords(history);
  assert.equal(records.length,1,"an assisted exercise is reported once");
  assert.equal(records[0].previous.metric.formatted,"30 kg assistance");
  assert.equal(records[0].best.metric.value,20);
  assert.deepEqual(records[0].change,{direction:"up",text:"10 kg less assistance"});
  assert.equal(records[0].newBest,true);
  assert.deepEqual(DiscoverProgress.metricChange({key:"time",value:40,higher:true},{key:"time",value:45,higher:true}),{direction:"down",text:"−5 sec"});
  assert.deepEqual(DiscoverProgress.metricChange({key:"reps",value:9,higher:true},{key:"reps",value:8,higher:true}),{direction:"up",text:"+1 rep"});
  assert.deepEqual(DiscoverProgress.metricChange({key:"load:lb",value:100,higher:true},{key:"load:lb",value:100,higher:true}),{direction:"same",text:"No change"});
  assert.deepEqual(DiscoverProgress.metricChange({key:"reps",value:9,higher:true},null),{direction:"first",text:"First log"});

  const days=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  assert.equal(DiscoverProgress.fourWeekConsistency([{date:"not-a-date",completedAt:"bad"}],days,new Date("2026-09-09T12:00:00")),0);
  const unplanned=DiscoverProgress.snapshot({workouts:[{...base,id:"session",startedAt:3}],weeklyPlan:{days:{}},days,now:new Date("2026-09-09T12:00:00"),hasMore:true});
  assert.equal(unplanned.adherence,"1");
  assert.match(unplanned.adherenceDetail,/no weekly plan/);
  assert.equal(unplanned.sessions,"1+");
});

test("workout API protects identity, access, and network error boundaries",async()=>{
  const baseState=()=>({mode:"account",user:{id:"member-1",discovery:{active:true}},csrfToken:"csrf-1"});
  let sessionBlocked=0,accessBlocked=0;
  const callbacks={onSessionBlocked:()=>sessionBlocked++,onAccessBlocked:()=>accessBlocked++};

  const local=WorkoutApi.create({state:{mode:"guest"},fetchImpl:async()=>response()});
  assert.equal(await local.assertIdentity(),undefined);

  const denied=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({ok:false,status:401,data:{error:"Sign in",code:"SESSION"}}),...callbacks});
  await assert.rejects(denied.request("/api/workouts"),error=>error.status===401&&error.code==="SESSION");
  assert.equal(sessionBlocked,1);

  const gated=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({ok:false,status:402,data:{}}),...callbacks});
  await assert.rejects(gated.request("/api/workouts"),error=>error.status===402&&/could not complete/.test(error.message));
  assert.equal(accessBlocked,1);

  const offline=WorkoutApi.create({state:baseState(),fetchImpl:async()=>{throw new TypeError("offline");}});
  await assert.rejects(offline.request("/api/workouts"),error=>error.code==="NETWORK_ERROR"&&error.cause.message==="offline");

  const changed=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({data:{user:{id:"member-2",discovery:{active:true}},csrfToken:"csrf"}}),...callbacks});
  await assert.rejects(changed.assertIdentity(),error=>error.code==="IDENTITY_CHANGED");
  assert.equal(sessionBlocked,2);

  const inactive=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({data:{user:{id:"member-1",discovery:{active:false}},csrfToken:"csrf"}}),...callbacks});
  await assert.rejects(inactive.assertIdentity(),error=>error.status===402);
  assert.equal(accessBlocked,2);

  const missingCsrf=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({data:{user:{id:"member-1",discovery:{active:true}},csrfToken:""}})});
  await assert.rejects(missingCsrf.assertIdentity(),/secure account session/);

  const absent=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({ok:false,status:404,data:{error:"Missing"}})});
  assert.equal(await absent.fetchWorkout("old/id"),null);
  const broken=WorkoutApi.create({state:baseState(),fetchImpl:async()=>response({ok:false,status:500,data:{error:"Broken"}})});
  await assert.rejects(broken.fetchWorkout("id"),error=>error.status===500);
});

test("workout state and calendar helpers keep recovery data safe at malformed edges",()=>{
  assert.equal(WorkoutState.deepLinkedDay({search:"",hash:"#start=%E0%A4%A"},Workout),Workout.today());
  assert.deepEqual(WorkoutState.readPreferences("not-json"),{});
  assert.deepEqual(WorkoutState.readPreferences(JSON.stringify({version:2,autoRest:true,restDuration:60})),{});
  assert.deepEqual(WorkoutState.readPreferences(JSON.stringify({version:1,autoRest:true,restDuration:999})),{autoRest:true});
  for(const [error,pattern] of [
    [{status:401},/session changed/],[{code:"IDENTITY_CHANGED"},/session changed/],[{status:403},/secure session/],
    [{code:"NETWORK_ERROR"},/Not saved/],[{message:"Specific"},/Specific/],[{},/could not be saved/]
  ])assert.match(WorkoutState.saveError(error),pattern);

  assert.equal(WorkoutCalendar.weeklySchedule({days:{}},Workout.DAYS),null,"an empty week has no calendar file");
  assert.equal(WorkoutCalendar.weeklySchedule({days:{Tuesday:[{sets:"2"}]}},Workout.DAYS,{time:"25:00"}),null,"an invalid time has no calendar file");
});

test("planner boundaries preserve explicit conflicts and guest storage fallbacks",async()=>{
  const empty=PlannerLogic.emptyPlan();
  assert.equal(PlannerLogic.nextScheduledDay(empty,new Date(2026,8,7)),null);
  empty.days.Monday.push({instanceId:"one",exerciseId:"press",sets:3,reps:"8"});
  assert.deepEqual(PlannerLogic.nextScheduledDay(empty,new Date(2026,8,7)),{day:"Monday",movements:1,isToday:true});
  assert.deepEqual(PlannerLogic.selectedDayHandoff({},"Funday"),{day:"Monday",count:0,addLabel:"Add to Monday",viewLabel:"View Monday · 0 exercises"});
  for(const [error,pattern] of [
    [{code:"GUEST_PLAN_CHANGED"},/another tab/],[{status:401},/session ended/],[{status:403},/save token/],
    [{status:413},/too large/],[{status:400,message:"Invalid plan"},/Invalid plan/],[{status:500},/could not save/],
    [{message:"Specific"},/Specific/],[{},/not saved/]
  ])assert.match(PlannerLogic.saveErrorMessage(error),pattern);

  const throwingStorage={getItem(){throw new Error("blocked");},setItem(){throw new Error("blocked");}};
  const recoveryMonday=PlannerLogic.updateRestDays(PlannerLogic.copyPlan(empty),["Monday"]);
  assert.equal(PlannerState.readSelectedDay(throwingStorage,{guest:true},recoveryMonday),"Tuesday");
  assert.equal(PlannerState.writeSelectedDay(throwingStorage,{guest:true},recoveryMonday,"Tuesday"),false);
  assert.equal(PlannerState.writeSelectedDay(throwingStorage,{guest:true},recoveryMonday,"Monday"),false);
  assert.throws(()=>PlannerApi.createClient({fetchImpl:async()=>{}}),/fetch and session access/);

  let verified=0,lastOptions;
  const reader=PlannerApi.createClient({
    fetchImpl:async(_path,options)=>{lastOptions=options;return response({jsonError:true});},
    getSession:()=>({guest:false,userId:"member",csrfToken:"csrf"}),verifyIdentity:async()=>{verified++;}
  });
  assert.deepEqual(await reader.request("/api/plan"),{});
  assert.equal(verified,0);
  assert.equal(lastOptions.headers["X-CSRF-Token"],undefined);
  assert.equal(lastOptions.headers["X-Strata-User"],undefined);
});

test("pricing and homepage pure boundaries normalize legacy-shaped input safely",async()=>{
  assert.equal(PricingLogic.discoveryIsActive(null),false);
  assert.equal(PricingLogic.subscriptionFor({discovery:{subscription:{}}}),null);
  assert.equal(PricingLogic.billingDate("bad"),"the date Paddle shows");
  assert.equal(PricingLogic.checkoutTransactionId({id:"txn_legacy"}),"txn_legacy");
  const normalized=PricingLogic.normalizedConfig({billing:{
    configured:true,mode:"SANDBOX",client_token:"test_fixture",product:`pro_${"a".repeat(24)}`,
    price_id:`pri_${"b".repeat(24)}`,price:{amount:"2.99",currency:"usd",interval:"MONTH",frequency:"1"}
  }});
  assert.equal(normalized.environment,"sandbox");
  assert.equal(PricingLogic.validateConfig(normalized),normalized);
  assert.throws(()=>PricingLogic.validateConfig({...normalized,enabled:false}),/temporarily unavailable/);
  assert.throws(()=>PricingLogic.validateConfig({...normalized,priceId:PricingLogic.RETIRED_ONE_TIME_PRICE_ID}),/recurring test product/);

  let options;
  const pricingRequest=PricingApi.createRequestJson(async(_path,value)=>{options=value;return response({data:{ok:true}});});
  assert.deepEqual(await pricingRequest("/api/trial",{method:"POST",body:"{}",headers:{"X-CSRF-Token":"csrf"}}),{ok:true});
  assert.equal(options.headers["Content-Type"],"application/json");
  assert.equal(options.headers["X-CSRF-Token"],"csrf");

  assert.deepEqual(HomeLogic.previewProfile({group:"invalid",days:99,minutes:15}),{goal:"balanced",group:"chest",equipment:"",level:"Intermediate",days:5,minutes:35});
  assert.deepEqual(HomeLogic.previewStarter("dumbbells"),{equipment:"Dumbbells",level:"Intermediate",minutes:35,goal:"balanced"});
  assert.equal(HomeLogic.previewStarter("unknown"),null);
  assert.equal(HomeLogic.nextGroupForKey("chest","Home"),"chest");
  assert.equal(HomeLogic.nextGroupForKey("chest","End"),"core");
  assert.equal(HomeLogic.nextGroupForKey("core","ArrowRight"),"chest");
  assert.equal(HomeLogic.nextGroupForKey("chest","ArrowLeft"),"core");
  assert.equal(HomeLogic.nextGroupForKey("back","Escape"),"back");
  assert.equal(HomeLogic.guestPlanCount({days:{Monday:[{exerciseId:"press"}]}},null),1);
  const state=HomeState.createState();
  HomeState.setAccount(state,null);assert.equal(state.accountStatus,"anonymous");
  HomeState.resetFilters(Object.assign(state,{sub:"x",equipment:"x",level:"x",query:"x"}));
  assert.deepEqual({sub:state.sub,equipment:state.equipment,level:state.level,query:state.query},{sub:"all",equipment:"all",level:"all",query:""});
});
