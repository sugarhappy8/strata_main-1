"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EXERCISES}=require("../src/plans");
const {SHORTLIST,allowedByLimits,candidateExercises,exerciseByName,normalize,readRequest,searchCatalog}=require("../src/ai-catalog");

const byId=new Map(EXERCISES.map((exercise)=>[exercise.id,exercise]));
const groupCount=(list,group)=>list.filter((item)=>item.group===group).length;

test("names match the library regardless of case, punctuation, or plurals",()=>{
  assert.equal(normalize("Flat Dumbbell Presses"),"flat dumbbell press");
  assert.equal(normalize("Cable Crunches"),"cable crunch");
  assert.equal(normalize("Lateral raises, abs & biceps"),"lateral raise abs bicep");
  assert.equal(normalize(null),"");
  assert.equal(exerciseByName("flat dumbbell presses")?.id,"flat-dumbbell-press");
  assert.equal(exerciseByName("  BULGARIAN split-squats ")?.id,"bulgarian-split");
  assert.equal(exerciseByName("a made-up exercise"),null);
  // Every exercise stays reachable by its own name after normalization.
  const names=new Set(EXERCISES.map((exercise)=>normalize(exercise.name)));
  assert.equal(names.size,EXERCISES.length,"no two library exercises normalize to the same name");
  for(const exercise of EXERCISES)assert.equal(exerciseByName(exercise.name)?.id,exercise.id);
});

test("member words become muscle groups, equipment, and named exercises",()=>{
  const focus=readRequest("I want a bigger upper chest and side delts");
  assert.deepEqual(focus.groups,["chest","shoulders"]);assert.deepEqual(focus.subs,["Upper chest","Side delts"]);assert.equal(focus.onlyEquipment,false);
  const split=readRequest("Build me a push pull legs week using only dumbbells");
  assert.deepEqual(split.groups,[],"a named split describes the whole week, so it does not narrow the shortlist");
  assert.deepEqual(split.equipment,["Dumbbells"]);assert.equal(split.onlyEquipment,true);
  const named=readRequest("add bulgarian split squats and nordic curls please");
  assert.equal(named.named[0],"bulgarian-split");assert.ok(named.named.includes("nordic-hamstring-curl"));
  assert.deepEqual(readRequest("I want to press heavy").named,[],"generic words alone never name an exercise");
  assert.ok(readRequest("x ".repeat(2000)).named.length<=SHORTLIST.named);
});

test("the default shortlist covers every muscle group with varied equipment",()=>{
  const list=candidateExercises();
  assert.equal(list.length,8*SHORTLIST.perGroup);
  for(const group of ["chest","back","shoulders","arms","legs","glutes","calves","core"])assert.equal(groupCount(list,group),SHORTLIST.perGroup,group);
  assert.deepEqual(list.slice(0,3).map((item)=>item.code),["CH1","CH2","CH3"]);
  assert.ok(new Set(list.filter((item)=>item.group==="chest").map((item)=>item.equipment)).size>=3,"defaults start with different equipment");
  assert.equal(new Set(list.map((item)=>item.code)).size,list.length,"codes are unique");
  for(const item of list)assert.ok(byId.has(item.id));
});

test("focus, equipment, experience, and movement limits shape the shortlist",()=>{
  const glutes=candidateExercises({request:"focus on glutes"});
  assert.equal(groupCount(glutes,"glutes"),SHORTLIST.focusGroup);assert.equal(groupCount(glutes,"chest"),SHORTLIST.otherGroup);
  const home=candidateExercises({request:"only dumbbells at home"});
  assert.deepEqual([...new Set(home.map((item)=>item.equipment))].sort(),["Bodyweight","Dumbbells"]);
  assert.equal(candidateExercises({request:"using only dumbbells",pinned:["hack-squat"]}).some((item)=>item.id==="hack-squat"),false,"the editable base cannot leak incompatible equipment into an only-equipment shortlist");
  const gym=candidateExercises({equipment:["Machine","Cables"]});
  assert.deepEqual([...new Set(gym.map((item)=>item.equipment))].sort(),["Cables","Machine"]);
  const beginner=candidateExercises({experience:"beginner",pinned:["bulgarian-split"]});
  assert.ok(beginner.some((item)=>item.id==="bulgarian-split"),"an exercise already in the plan is always offered");
  assert.ok(beginner.filter((item)=>item.id!=="bulgarian-split").every((item)=>byId.get(item.id).level!=="Advanced"));
  const limited=candidateExercises({limitations:["no-overhead","no-deep-knee"],request:"bulgarian split squats"});
  assert.ok(limited.every((item)=>!byId.get(item.id).traits?.some((trait)=>trait==="overhead"||trait==="deep-knee")),"movement limits apply even to named exercises");
  const named=candidateExercises({request:"add nordic hamstring curls",equipment:["Machine"]});
  assert.ok(named.some((item)=>item.id==="nordic-hamstring-curl"),"a named exercise is offered even outside the member's equipment");
  const atHome=candidateExercises({equipment:["Dumbbells"],request:"stronger legs at home with dumbbells, include bulgarian split squats"});
  assert.equal(atHome.find((item)=>item.group==="legs")?.id,"bulgarian-split","an exercise named in full comes first");
  assert.ok(atHome.some((item)=>item.id==="front-foot-elevated-dumbbell-split-squat"),"close matches that suit the equipment rank early");
  assert.equal(atHome.some((item)=>item.id==="barbell-split-squat"),false,"close matches never bring in equipment the member lacks");
  assert.deepEqual(readRequest("bulgarian split squats").exact,["bulgarian-split"]);
  const extra=candidateExercises({extra:["landmine-rotation"]});
  assert.ok(extra.some((item)=>item.id==="landmine-rotation"));assert.equal(groupCount(extra,"core"),SHORTLIST.perGroup+1,"search results never displace default picks");
});

test("the model's searches reach the whole library but respect movement limits",()=>{
  const found=searchCatalog(["landmine press","nordic curl"]);
  assert.ok(found.includes("half-kneeling-landmine-press"));assert.ok(found.includes("nordic-hamstring-curl"));
  assert.equal(searchCatalog(["landmine press"],["no-overhead"]).some((id)=>byId.get(id).traits?.includes("overhead")),false);
  const rear=searchCatalog("rear delts");
  assert.ok(rear.length>0&&rear.every((id)=>byId.get(id).sub==="Rear delts"||/rear-delt/.test(id)),"a muscle search returns that muscle's exercises, plus exercises named for it");
  assert.ok(searchCatalog(["hamstrings"]).length<=SHORTLIST.searched);
  assert.deepEqual(searchCatalog([]),[]);
  assert.equal(allowedByLimits({traits:["floor"]},["floor"]),false);assert.equal(allowedByLimits({},["floor"]),true);
});
