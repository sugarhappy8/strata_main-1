"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {fallbackPlanResponse}=require("../src/ai-plan-fallback");
const {interpretReply}=require("../src/ai-core");
const {planEditContract,planEditIssue}=require("../src/ai-plan-edits");
const {DAYS,EXERCISES}=require("../src/plans");

const ids=["flat-dumbbell-press","chest-supported-row","hack-squat"];
const candidates=EXERCISES.slice(0,24).map((item,index)=>({...item,code:`X${index+1}`}));
for(const id of ids)if(!candidates.some((item)=>item.id===id)){const item=EXERCISES.find((entry)=>entry.id===id);candidates.push({...item,code:`X${candidates.length+1}`});}
function plan(){const days=Object.fromEntries(DAYS.map((day)=>[day,[]]));for(const day of ["Monday","Wednesday","Friday"])days[day]=ids.map((exerciseId,index)=>({instanceId:`${day}-${index}`,exerciseId,sets:[6,5,5][index],reps:"8–12"}));return {version:1,restDay:"Tuesday",restDays:["Tuesday","Thursday","Saturday","Sunday"],days};}
function interpreted(base,contract,list=candidates){const data=fallbackPlanResponse({basePlan:base,contract,candidates:list});return data&&interpretReply(data,{candidates:list,plan:null,limitations:[]});}

test("fallback schedule edits preserve the base days and add a balanced exact schedule",()=>{
  const base=plan(),snapshot=JSON.stringify(base),contract=planEditContract("I only want 2 rest days",base),result=interpreted(base,contract);
  assert.ok(result?.week);assert.deepEqual(result.week.trainingDays,["Monday","Tuesday","Wednesday","Friday","Saturday"]);assert.equal(planEditIssue(contract,result.week),null);
  assert.deepEqual(result.week.plan.days.Monday.map((item)=>item.exerciseId),ids);assert.deepEqual(result.week.plan.days.Tuesday.map((item)=>item.exerciseId),ids);
  assert.equal(JSON.stringify(base),snapshot,"the trusted draft is never mutated");
});

test("fallback duration edits keep the days and reach the exact working-set target",()=>{
  const base=plan(),contract=planEditContract("Make sessions longer",base),result=interpreted(base,contract);
  assert.ok(result?.week);assert.deepEqual(result.week.trainingDays,["Monday","Wednesday","Friday"]);assert.equal(result.week.sessionMinutes,60);assert.ok(result.week.days.every((day)=>day.workingSets===22));assert.equal(planEditIssue(contract,result.week),null);
});

test("fallback handles mixed day and duration contracts and refuses impossible capacity",()=>{
  const base=plan(),contract=planEditContract("Make it five training days with 75 minute sessions",base),result=interpreted(base,contract);
  assert.ok(result?.week);assert.equal(result.week.trainingDays.length,5);assert.ok(result.week.days.every((day)=>day.workingSets===28));assert.equal(planEditIssue(contract,result.week),null);
  const impossible=plan(),long=planEditContract("Make every session 90 minutes",impossible);
  assert.equal(fallbackPlanResponse({basePlan:impossible,contract:long,candidates:[]}),null);
  const qualitative=planEditContract("Make it five training days using only dumbbells",base);
  assert.equal(fallbackPlanResponse({basePlan:base,contract:qualitative,candidates}),null,"unsupported qualitative clauses must never be silently ignored");
});
