"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DAYS,EXERCISES}=require("../src/plans");
const edits=require("../src/ai-plan-edits");

const firstIds=["flat-dumbbell-press","chest-supported-row","hack-squat"];
const ids=[...firstIds,...EXERCISES.map((item)=>item.id).filter((id)=>!firstIds.includes(id))].slice(0,8);
function plan(daySets={Monday:16,Wednesday:16,Friday:16}){
  const active=Object.keys(daySets),days=Object.fromEntries(DAYS.map((day)=>[day,[]]));
  for(const [day,total] of Object.entries(daySets)){
    let left=total,index=0;
    while(left>0){const sets=Math.min(6,left);days[day].push({instanceId:`${day.slice(0,3)}-${index}-item`,exerciseId:ids[index%ids.length],sets,reps:"8–12"});left-=sets;index+=1;}
    while(days[day].length<2)days[day].push({instanceId:`${day.slice(0,3)}-${days[day].length}-item`,exerciseId:ids[days[day].length],sets:1,reps:"8–12"});
  }
  const restDays=DAYS.filter((day)=>!active.includes(day));
  return {version:1,restDay:restDays[0],restDays,days};
}
function week(source){
  const trainingDays=DAYS.filter((day)=>source.days[day].length);
  return {trainingDays,plan:source,days:trainingDays.map((day)=>({day,workingSets:source.days[day].reduce((sum,item)=>sum+item.sets,0)}))};
}

test("draft plans are sanitized to bounded, catalog-only weekly plans",()=>{
  assert.equal(edits.sanitizeDraftPlan(null),null);
  const clean=edits.sanitizeDraftPlan(plan());
  assert.deepEqual(clean.restDays,["Tuesday","Thursday","Saturday","Sunday"]);
  assert.deepEqual([...edits.planExerciseIds(clean)].sort(),ids.slice(0,3).sort());
  const unknown=plan();unknown.days.Monday[0].exerciseId="invented-exercise";
  assert.throws(()=>edits.sanitizeDraftPlan(unknown),{code:"AI_INVALID_REQUEST",status:400});
  assert.throws(()=>edits.sanitizeDraftPlan(plan(Object.fromEntries(DAYS.map((day)=>[day,6])))),{code:"AI_INVALID_REQUEST",status:400});
  const tooFew=plan({Monday:6});tooFew.days.Monday=tooFew.days.Monday.slice(0,1);
  assert.throws(()=>edits.sanitizeDraftPlan(tooFew),/2 to 8 exercises/);
  const tooManySets=plan({Monday:16});tooManySets.days.Monday[0].sets=7;
  assert.throws(()=>edits.sanitizeDraftPlan(tooManySets),{code:"AI_INVALID_REQUEST",status:400});
  assert.throws(()=>edits.sanitizeDraftPlan(plan({Monday:42})),/too many working sets/);
});

test("rest-day and training-day requests become exact schedule contracts",()=>{
  const base=plan();
  const five=edits.planEditContract("I only want 2 rest days",base);assert.equal(five.trainingDays,5);assert.deepEqual(five.targetTrainingDays,["Monday","Tuesday","Wednesday","Friday","Saturday"]);
  assert.equal(edits.planEditContract("Train five days per week",base).trainingDays,5);
  assert.equal(edits.planEditContract("Make it a four training day plan",base).trainingDays,4);
  assert.equal(edits.planEditContract("Build a 5-day upper lower plan",base).trainingDays,5);
  assert.equal(edits.planEditContract("I want two days off",base).trainingDays,5);
  assert.equal(edits.planEditContract("Do 4 workouts a week",base).trainingDays,4);
  assert.equal(edits.planEditContract("Unrelated coaching advice",base),null);
});

test("relative day edits use the base plan and understand training versus rest",()=>{
  const base=plan();
  const added=edits.planEditContract("Add one more training day",base);
  assert.equal(added.trainingDays,4);assert.equal(added.requireBaseDays,true);assert.deepEqual(added.targetTrainingDays,["Monday","Wednesday","Friday","Saturday"]);
  assert.equal(edits.planEditContract("Remove a training day",base).trainingDays,2);
  assert.equal(edits.planEditContract("I want one more rest day",base).trainingDays,2);
  assert.equal(edits.planEditContract("Remove two rest days",base).trainingDays,5);
  assert.equal(edits.planEditContract("Add a day",base).trainingDays,4);
  const five=plan({Monday:16,Tuesday:16,Wednesday:16,Friday:16,Saturday:16});
  assert.equal(edits.planEditContract("Remove one training day and add one rest day",five).trainingDays,4,"equivalent inverse clauses describe one change");
  assert.equal(edits.planEditContract("Add one training day and add one rest day",five),null,"contradictory schedule clauses stay with the model");
});

test("longer and shorter edits move exactly one 15-minute session bucket",()=>{
  const base=plan();
  const longer=edits.planEditContract("Make sessions longer",base);
  assert.equal(longer.sessionMinutes,60);assert.equal(longer.preserveDays,true);
  assert.equal(edits.planEditContract("Make each workout shorter",base).sessionMinutes,30);
  assert.equal(edits.planEditContract("Shorten the sessions",base).sessionMinutes,30);
  assert.equal(edits.planEditContract("Make every session 75 minutes",base).sessionMinutes,75);
  assert.equal(edits.planEditContract("Increase sessions to 75 minutes",base).sessionMinutes,75);
  assert.equal(edits.planEditContract("Extend workouts to 90 minutes",base).sessionMinutes,90);
  assert.equal(edits.planEditContract("Increase sessions by 30 minutes",base).sessionMinutes,75);
  assert.equal(edits.planEditContract("Add 15 minutes to each session",base).sessionMinutes,60);
  assert.equal(edits.planEditContract("Make sessions 15 minutes shorter",base).sessionMinutes,30);
  assert.equal(edits.planEditContract("Set calories for my 75 minute workouts",base),null,"nutrition context is not a plan edit");
});

test("deterministic fallback is limited to pure measurable edits",()=>{
  assert.equal(edits.planEditContract("Make it five training days",plan()).fallbackSafe,true);
  const equipment=edits.planEditContract("Make it five training days using only dumbbells",plan());
  assert.equal(equipment.fallbackSafe,false);assert.equal(equipment.replySafe,true);assert.deepEqual(equipment.equipmentOnly,["Dumbbells","Bodyweight"]);
  assert.equal(edits.planEditContract("Make sessions longer and replace squats",plan()).fallbackSafe,false);
  assert.equal(edits.planEditContract("Longer sessions with no overhead work",plan()).fallbackSafe,false);
});

test("medical context stays on the model's safety-response path",()=>{
  assert.equal(edits.planEditContract("My knee hurts, make my sessions shorter",plan()),null);
  assert.equal(edits.planEditContract("I am pregnant; make workouts longer",plan()),null);
});

test("edit context includes the complete base plan with codes or exact names",()=>{
  const base=plan({Monday:8,Thursday:8}),contract=edits.planEditContract("I only want 2 rest days",base);
  const text=edits.planEditContext({basePlan:base,source:"latest proposal",candidates:[{id:"flat-dumbbell-press",code:"CH9"}],contract});
  assert.match(text,/Base source: latest proposal/);assert.match(text,/Monday: CH9 6x8–12; Chest-supported Row 2x8–12/);
  assert.match(text,/Tuesday: NO WORKOUT — omit from week\.days/);assert.match(text,/Thursday:/);assert.match(text,/exactly 5 training days and 2 rest days/);assert.match(text,/Omit .* from week\.days because omitted days are rest days/);
});

test("contract validation rejects wrong counts, dropped base days, changed duration days, and short sessions",()=>{
  const base=plan();
  const fiveDays=edits.planEditContract("I only want 2 rest days",base);
  assert.match(edits.planEditIssue(fiveDays,week(plan())),/exactly 5 training days/);
  const added=edits.planEditContract("Add a training day",base);
  assert.match(edits.planEditIssue(added,week(plan({Tuesday:16,Wednesday:16,Friday:16,Saturday:16}))),/Use exactly these training days/);
  assert.equal(edits.planEditIssue(added,week(plan({Monday:16,Wednesday:16,Friday:16,Saturday:16}))),null);
  const longer=edits.planEditContract("Make sessions longer",base);
  assert.match(edits.planEditIssue(longer,week(plan({Tuesday:20,Wednesday:20,Friday:20}))),/Use exactly these training days/);
  assert.match(edits.planEditIssue(longer,week(base)),/Monday must estimate to the 60-minute bucket/);
  assert.equal(edits.planEditIssue(longer,week(plan({Monday:20,Wednesday:20,Friday:20}))),null);
  assert.match(edits.planEditReply(fiveDays,week(plan({Monday:16,Tuesday:16,Wednesday:16,Friday:16,Saturday:16}))),/5 training days with 2 rest days/);
  const equipment=edits.planEditContract("Make it five training days using only dumbbells",base),fiveWithMachines=week(plan({Monday:16,Tuesday:16,Wednesday:16,Friday:16,Saturday:16}));
  assert.match(edits.planEditIssue(equipment,fiveWithMachines),/must use only Dumbbells or Bodyweight/);
  assert.match(edits.planEditContext({basePlan:base,candidates:[],contract:equipment}),/Use only this equipment: Dumbbells, Bodyweight/);
});
