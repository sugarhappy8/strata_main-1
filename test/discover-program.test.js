"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {planFromWeek,createController}=require("../public/scripts/discover-program");
const Monthly=require("../public/scripts/monthly-plan-core");
const week=()=>({training:{summary:{reviewNeeded:false},sessions:[{day:"Monday",exercises:[{exerciseId:"plank",sets:3,reps:"30–45 sec"}]},{day:"Thursday",exercises:[{exerciseId:"goblet-squat",sets:3,reps:"8–12"}]}]}});
function fixture(api){
  const nodes=new Map(),element=id=>{if(!nodes.has(id))nodes.set(id,{id,hidden:false,open:false,disabled:false,dataset:{},listeners:{},setAttribute(){},addEventListener(type,fn){this.listeners[type]=fn;}});return nodes.get(id);};
  let currentWeek=week(),generation=1,syncs=0;const state={user:{id:"owner"},weeklyPlanUpdatedAt:12,exercises:[]};
  const controller=createController({element,api,state,getWeek:()=>currentWeek,getGeneration:()=>generation,monthly:Monthly,openDialog:node=>{node.open=true;},closeDialog:id=>{element(id).open=false;},syncPlanViews:()=>{syncs++;}});
  return {controller,state,element,newWeek:()=>{currentWeek=week();},resetAccount:()=>{generation++;state.user={id:"other"};controller.reset();},syncs:()=>syncs};
}
test("a coaching week becomes one weekly plan with exact sets and measurement text",()=>{
  const source=week(),plan=planFromWeek(source);assert.equal(plan.days.Monday[0].reps,"30–45 sec");assert.equal(plan.days.Thursday[0].sets,3);assert.deepEqual(plan.restDays,["Tuesday","Wednesday","Friday","Saturday","Sunday"]);assert.equal(Object.keys(plan.days).length,7);assert.equal(source.training.sessions[0].exercises[0].instanceId,undefined);
  assert.deepEqual(Monthly.normalizeWeeklyPlan(plan).days,plan.days);
});
test("incomplete or malformed suggestions cannot replace a saved week",()=>{
  assert.throws(()=>planFromWeek(null),/Build/);const partial=week();partial.training.summary.reviewNeeded=true;assert.throws(()=>planFromWeek(partial),/gaps/);
  for(const change of [s=>s.day="Unknown",s=>s.exercises=[],s=>s.status="partial",s=>s.exercises[0].sets=0,s=>s.exercises[0].reps="",s=>s.exercises[0].exerciseId="../bad"]){const invalid=week();change(invalid.training.sessions[0]);assert.throws(()=>planFromWeek(invalid),/review/i);}
  const duplicate=week();duplicate.training.sessions.push(duplicate.training.sessions[0]);assert.throws(()=>planFromWeek(duplicate),/review/);
});
test("review and cancellation make no writes; confirmation saves against the reviewed revision",async()=>{
  let calls=0,payload;const f=fixture(async(_url,options)=>{calls++;payload=JSON.parse(options.body);return {plan:payload.plan,planUpdatedAt:13};});
  await f.controller.save();assert.equal(calls,0);f.controller.review();assert.equal(calls,0);assert.equal(f.element("programApplyDialog").open,true);assert.match(f.element("programApplySummary").textContent,/Monday: 1 exercises · 3 sets/);
  await f.controller.save();assert.equal(payload.expectedPlanUpdatedAt,12);assert.equal(calls,1);assert.equal(f.state.weeklyPlanUpdatedAt,13);assert.equal(f.syncs(),1);assert.equal(f.element("programApplyDialog").open,false);assert.match(f.element("programApplyStatus").textContent,/Open Train/);
});
test("a locally changed plan or regenerated week needs a new review",async()=>{
  const f=fixture(()=>{throw new Error("Unexpected write");});f.controller.review();f.newWeek();await f.controller.save();assert.match(f.element("programApplyError").textContent,/review.*again/);
  f.controller.review();f.state.weeklyPlanUpdatedAt++;await f.controller.save();assert.match(f.element("programApplyError").textContent,/changed/);
});
test("remote plan conflicts load the current week and require another review",async()=>{
  const latest=planFromWeek(week());latest.days.Monday[0].sets=4;
  const f=fixture(async()=>{throw Object.assign(new Error("Changed"),{code:"PLAN_CHANGED",payload:{plan:latest,planUpdatedAt:14}});});f.controller.review();await f.controller.save();assert.equal(f.state.weeklyPlan.days.Monday[0].sets,4);assert.equal(f.state.weeklyPlanUpdatedAt,14);assert.match(f.element("programApplyError").textContent,/changed elsewhere/);assert.equal(f.element("programApplyConfirm").disabled,false);
});
test("late writes never repopulate a different account; duplicate submissions are ignored",async()=>{
  let resolve,calls=0;const f=fixture(()=>{calls++;return new Promise(done=>{resolve=done;});});f.controller.review();const saving=f.controller.save();await f.controller.save();f.controller.review();assert.equal(calls,1);
  let prevented=false;f.element("programApplyDialog").listeners.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);f.resetAccount();resolve({plan:planFromWeek(week()),planUpdatedAt:20});await saving;assert.equal(f.state.weeklyPlan,undefined);assert.equal(f.syncs(),0);assert.equal(f.element("programApplyDialog").open,false);
});
test("failed requests preserve the reviewed plan and allow retry",async()=>{
  const f=fixture(async()=>{throw new Error("Offline. Try again.");});f.controller.review();await f.controller.save();assert.match(f.element("programApplyError").textContent,/Offline/);assert.equal(f.element("programApplyDialog").open,true);assert.equal(f.element("programApplyConfirm").disabled,false);
});
