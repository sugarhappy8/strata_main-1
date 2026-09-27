"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const Core=require("../public/scripts/discovery-core");
const exercises=require("../public/data/exercises.json");
const {methodology,limitedConfidenceExercises}=require("../src/data/discovery-data.json");

const preferences={goal:"hypertrophy",level:"Intermediate",days:4,equipment:["Dumbbells","Bodyweight"],preferences:["stable","long-range"],limitations:[]};
const byId=(id)=>exercises.find((exercise)=>exercise.id===id);
const groups={
  chest:["Upper chest","Mid / lower chest","Serratus anterior"],
  back:["Latissimus dorsi","Upper back","Spinal erectors"],
  shoulders:["Front delts","Side delts","Rear delts","Rotator cuff"],
  arms:["Biceps","Brachialis","Triceps long head","Triceps lateral / medial","Forearms"],
  legs:["Quadriceps","Hamstrings","Adductors"],
  glutes:["Glute max","Glute med / min"],
  calves:["Gastrocnemius","Soleus","Tibialis anterior"],
  core:["Rectus abdominis","Obliques","Deep core"]
};
const fields=["id","name","group","sub","score","equipment","level","pattern","why","caution","sets","reps","rest","cues","youtube","traits","metrics"];
const equipment=new Set(["Barbell / Smith","Bench","Bodyweight","Cables","Dumbbells","Machine","Resistance band"]);

test("FitScore contributions are complete, finite, and transparent",()=>{
  assert.equal(methodology.factors.reduce((sum,factor)=>sum+factor.weight,0),100);
  assert.deepEqual(methodology.factors.map((factor)=>factor.key),Core.FACTOR_KEYS);
  for(const exercise of exercises){
    const baseline=Core.weightedBaseline(exercise,methodology),adjustment=Core.scoreAdjustment(exercise,methodology);
    assert.ok(Number.isFinite(baseline),exercise.id);
    assert.ok(Number.isFinite(adjustment),exercise.id);
    assert.ok(Math.abs(adjustment)<=4,`${exercise.id} adjustment ${adjustment}`);
  }
});

test("personal ranking excludes unavailable equipment and saved constraints",()=>{
  assert.equal(Core.personalResult(byId("flat-dumbbell-press"),preferences).eligible,true);
  assert.equal(Core.personalResult(byId("incline-smith-press"),preferences).eligible,false);
  const constrained={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))],limitations:["no-overhead","no-floor"]};
  assert.equal(Core.personalResult(byId("machine-shoulder-press"),constrained).eligible,false);
  assert.equal(Core.personalResult(byId("dead-bug"),constrained).eligible,false);
  assert.equal(Core.personalResult(byId("cable-crunch"),constrained).eligible,false);
  assert.equal(Core.personalResult(byId("pike-pushup"),constrained).eligible,false);
  assert.equal(Core.excludedByLimitations(byId("cable-crunch"),["no-floor"]),true);
  assert.equal(Core.hasTrait(byId("singleleg-dumbbell-rdl"),"unilateral"),true);
  assert.equal(Core.hasTrait(byId("singleleg-dumbbell-rdl"),"unsupported-hinge"),true);
  assert.equal(Core.personalResult(byId("machine-chest-press"),constrained).eligible,true);
});

test("movement classes apply compound and isolation preferences without biasing accessories",()=>{
  const compound=byId("flat-dumbbell-press"),isolation=byId("cable-fly"),accessory=byId("dead-bug");
  assert.equal(Core.movementClass(compound),"compound");
  assert.equal(Core.movementClass(isolation),"isolation");
  assert.equal(Core.movementClass(accessory),"accessory");

  const base={goal:"balanced",level:"Intermediate",days:4,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))],preferences:[],limitations:[]};
  const result=(exercise,preference)=>Core.personalResult(exercise,{...base,preferences:preference?[preference]:[]});

  const compoundBase=result(compound),compoundPreferred=result(compound,"compound"),compoundRejected=result(compound,"isolation");
  assert.equal(compoundPreferred.match,compoundBase.match+5);
  assert.equal(compoundRejected.match,compoundBase.match-5);
  assert.ok(compoundPreferred.reasons.includes("compound pattern preference"));
  assert.ok(!compoundRejected.reasons.includes("isolation preference"));

  const isolationBase=result(isolation),isolationPreferred=result(isolation,"isolation"),isolationRejected=result(isolation,"compound");
  assert.equal(isolationPreferred.match,isolationBase.match+5);
  assert.equal(isolationRejected.match,isolationBase.match-5);
  assert.ok(isolationPreferred.reasons.includes("isolation preference"));
  assert.ok(!isolationRejected.reasons.includes("compound pattern preference"));

  const accessoryBase=result(accessory),accessoryCompound=result(accessory,"compound"),accessoryIsolation=result(accessory,"isolation");
  assert.equal(accessoryCompound.match,accessoryBase.match);
  assert.equal(accessoryIsolation.match,accessoryBase.match);
  assert.ok(!accessoryCompound.reasons.includes("compound pattern preference"));
  assert.ok(!accessoryIsolation.reasons.includes("isolation preference"));
});

test("exercise battle supports two to four choices and gives bounded recommendations",()=>{
  const chest=[byId("flat-dumbbell-press"),byId("machine-chest-press"),byId("cable-fly"),byId("deficit-pushup")];
  for(let count=2;count<=4;count++){
    const result=Core.comparisonRecommendation(chest.slice(0,count),{...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]});
    assert.ok(result.winner);
    assert.match(result.reason,/best fit/i);
  }
  assert.match(Core.comparisonRecommendation([chest[0]],preferences).error,/two and four/i);
  const mixed=Core.comparisonRecommendation([chest[0],byId("neutral-pulldown")],preferences);
  assert.equal(mixed.winner,null);
  assert.match(mixed.reason,/different muscles|training roles/i);
});

test("exercise battle rejects incompatible targets and all-ineligible choices",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]};
  const incompatible=Core.comparisonRecommendation([byId("incline-curl"),byId("pressdown")],allEquipment);
  assert.equal(incompatible.winner,null);
  assert.match(incompatible.reason,/different muscles|training roles/i);

  const unavailable=Core.comparisonRecommendation([byId("machine-chest-press"),byId("cable-fly")],{...preferences,equipment:["Dumbbells"]});
  assert.equal(unavailable.winner,null);
  assert.match(unavailable.reason,/none|equipment|constraints/i);
});

test("session builder is deterministic, time-bounded, and varied across every focus",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]};
  const expectedCounts=new Map([[20,3],[35,4],[50,6]]);
  for(const focus of Object.keys(Core.SESSION_FOCUSES))for(const [minutes,count] of expectedCounts){
    const first=Core.buildSession({exercises,preferences:allEquipment,focus,minutes});
    const second=Core.buildSession({exercises,preferences:allEquipment,focus,minutes});
    assert.deepEqual(first.items.map((item)=>item.exerciseId),second.items.map((item)=>item.exerciseId),`${focus} ${minutes} must be deterministic`);
    assert.equal(first.items.length,count,`${focus} ${minutes} movement count`);
    assert.equal(new Set(first.items.map((item)=>item.exerciseId)).size,count,`${focus} ${minutes} must not repeat exercises`);
    assert.equal(new Set(first.items.map((item)=>item.role)).size,count,`${focus} ${minutes} must cover distinct programmed roles`);
    assert.ok(first.workingSets>=count*2&&first.workingSets<=count*4,`${focus} ${minutes} working sets`);
    assert.match(first.summary,new RegExp(`about ${minutes} minutes`));
    for(const [index,item] of first.items.entries()){
      assert.equal(Core.sessionFocusMatches(item.exercise,focus),true,`${item.exerciseId} must fit ${focus}`);
      assert.equal(Core.sessionRoleMatches(item.exercise,Core.SESSION_FOCUSES[focus].slots[index]),true,`${item.exerciseId} must fulfill ${item.role}`);
      assert.equal(Core.personalResult(item.exercise,allEquipment).eligible,true,`${item.exerciseId} must remain profile-eligible`);
      assert.ok(Number.isInteger(item.sets)&&item.sets>=1&&item.sets<=4,item.exerciseId);
      assert.equal(item.reps,item.exercise.reps);
      assert.equal(item.rest,item.exercise.rest);
      assert.ok(item.match>=40&&item.match<=99,item.exerciseId);
      assert.ok(item.reasons.length>=2,item.exerciseId);
    }
  }
});

test("session builder honors equipment and movement constraints before ranking",()=>{
  const constrained={goal:"balanced",level:"Beginner",days:3,equipment:["Dumbbells","Machine","Cables"],preferences:["stable","simple-setup"],limitations:["no-overhead","no-floor","no-unilateral"]};
  for(const focus of Object.keys(Core.SESSION_FOCUSES)){
    const session=Core.buildSession({exercises,preferences:constrained,focus,minutes:35});
    for(const item of session.items){
      assert.ok(constrained.equipment.includes(item.exercise.equipment),`${item.exerciseId} equipment`);
      assert.equal(Core.excludedByLimitations(item.exercise,constrained.limitations),false,`${item.exerciseId} constraint`);
      assert.equal(Core.personalResult(item.exercise,constrained).eligible,true,item.exerciseId);
    }
  }
  assert.throws(()=>Core.buildSession({exercises,preferences:constrained,focus:"unknown",minutes:35}),{code:"INVALID_SESSION_FOCUS"});
  assert.throws(()=>Core.buildSession({exercises,preferences:constrained,focus:"full",minutes:45}),{code:"INVALID_SESSION_LENGTH"});
  assert.throws(()=>Core.buildSession({exercises,preferences:{...constrained,equipment:[]},focus:"core",minutes:20}),{code:"SESSION_POOL_TOO_SMALL"});
  assert.throws(()=>Core.buildSession({exercises:exercises.filter((exercise)=>exercise.group!=="back"),preferences:{...preferences,equipment:[...equipment]},focus:"full",minutes:20}),{code:"SESSION_ROLE_UNAVAILABLE",message:/upper-body pull/i});
});

test("session builder rotates strong choices around exercises already in the saved week",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]},baseline=Core.buildSession({exercises,preferences:allEquipment,focus:"upper",minutes:35});
  const days=Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,[]]));
  days.Monday=baseline.items.map((item,index)=>({instanceId:`weekly-${index}-${item.exerciseId}`,exerciseId:item.exerciseId,sets:item.sets,reps:item.reps}));
  const rotated=Core.buildSession({exercises,preferences:allEquipment,focus:"upper",minutes:35,weeklyPlan:{version:1,restDay:"Sunday",days}});
  assert.notDeepEqual(rotated.items.map((item)=>item.exerciseId),baseline.items.map((item)=>item.exerciseId));
  assert.ok(rotated.items.some((item)=>item.reasons.includes("was not yet in your saved week when this session was generated")));
});

test("session anchors repeat only compatible roles without creating duplicate movements",()=>{
  const allEquipment=[...new Set(exercises.map((exercise)=>exercise.equipment))],profile={...preferences,equipment:allEquipment};
  const first=Core.buildSession({exercises,preferences:profile,focus:"full",minutes:35});
  const next=Core.buildSession({exercises,preferences:profile,focus:"full",minutes:35,weeklyPlan:{days:Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,day==="Monday"?first.items:[]]))}});
  const anchored=Core.repeatSessionAnchors(next,first.items.slice(0,2),2);
  assert.deepEqual(anchored.anchorExerciseIds,first.items.slice(0,2).map((item)=>item.exerciseId));
  assert.equal(new Set(anchored.items.map((item)=>item.exerciseId)).size,anchored.items.length);
  for(const anchor of first.items.slice(0,2)){
    const repeated=anchored.items.find((item)=>item.exerciseId===anchor.exerciseId);
    assert.equal(repeated.role,anchor.role);
    assert.ok(repeated.reasons.includes("repeated anchor for Training Memory"));
    assert.equal(Core.personalResult(repeated.exercise,profile).eligible,true);
  }
  assert.equal(anchored.workingSets,anchored.items.reduce((total,item)=>total+item.sets,0));
});

test("session merge adds the complete routine without mutating or duplicating a day",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]},session=Core.buildSession({exercises,preferences:allEquipment,focus:"full",minutes:35});
  const days=Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,[]]));
  days.Monday.push({instanceId:"existing-session-item",exerciseId:session.items[0].exerciseId,sets:2,reps:"10"});
  const plan={version:1,restDay:"Sunday",days},before=JSON.stringify(plan),merged=Core.mergeSessionIntoPlan(plan,"Monday",session,{makeInstanceId:()=>"existing-session-item"});
  assert.equal(JSON.stringify(plan),before,"merge must not mutate the loaded revision");
  assert.equal(merged.added,session.items.length-1);
  assert.equal(merged.skipped,1);
  assert.equal(merged.plan.days.Monday.length,session.items.length);
  assert.equal(new Set(merged.plan.days.Monday.map((item)=>item.exerciseId)).size,session.items.length);
  const instanceIds=Core.WEEKDAYS.flatMap((day)=>merged.plan.days[day].map((item)=>item.instanceId));
  assert.equal(new Set(instanceIds).size,instanceIds.length,"generated instance IDs must stay unique");
  assert.equal(Core.mergeSessionIntoPlan(merged.plan,"Monday",session).changed,false,"a safe retry should be a no-op");
  assert.throws(()=>Core.mergeSessionIntoPlan(plan,"Sunday",session),{code:"SESSION_REST_DAY"});
});

test("session merge fails atomically when the day or week lacks capacity",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]},session=Core.buildSession({exercises,preferences:allEquipment,focus:"full",minutes:20});
  const item=(index)=>({instanceId:`capacity-item-${index}`,exerciseId:`existing-${index}`,sets:3,reps:"8–12"});
  const fullDay={version:1,restDay:"Sunday",days:Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,day==="Monday"?Array.from({length:30},(_,index)=>item(index)):[]]))};
  assert.throws(()=>Core.mergeSessionIntoPlan(fullDay,"Monday",session),{code:"SESSION_DAY_CAPACITY"});
  const fullWeek={version:1,restDay:"Sunday",days:Object.fromEntries(Core.WEEKDAYS.map((day,dayIndex)=>[day,day==="Sunday"?[]:Array.from({length:day==="Monday"?20:24},(_,index)=>item(dayIndex*30+index))]))};
  assert.equal(Core.WEEKDAYS.reduce((sum,day)=>sum+fullWeek.days[day].length,0),140);
  assert.throws(()=>Core.mergeSessionIntoPlan(fullWeek,"Monday",session),{code:"SESSION_PLAN_CAPACITY"});
});

test("weekly pulse reports only honest today or next-session plan facts",()=>{
  const days=Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,[]]));
  days.Wednesday=[{exerciseId:"one",sets:3},{exerciseId:"two",sets:2}];days.Friday=[{exerciseId:"three",sets:4}];
  const plan={version:1,restDay:"Sunday",days},today=Core.weeklyPulse(plan,{today:"Wednesday",profileDays:4}),next=Core.weeklyPulse(plan,{today:"Thursday",profileDays:4}),wrapped=Core.weeklyPulse(plan,{today:"Saturday",profileDays:4});
  assert.deepEqual({day:today.day,isToday:today.isToday,movements:today.movements,workingSets:today.workingSets,scheduledDays:today.scheduledDays,progress:today.progressPercent},{day:"Wednesday",isToday:true,movements:2,workingSets:5,scheduledDays:2,progress:50});
  assert.equal(next.day,"Friday");assert.equal(next.offset,1);assert.equal(next.title,"Tomorrow · 1 movement.");
  assert.equal(wrapped.day,"Wednesday");assert.equal(wrapped.offset,4);
  for(const pulse of [today,next,wrapped])assert.doesNotMatch(`${pulse.title} ${pulse.detail}`,/completed|recovered|ready|readiness/i);
  const empty=Core.weeklyPulse({version:1,restDay:"Sunday",days:Object.fromEntries(Core.WEEKDAYS.map((day)=>[day,[]]))},{today:"Monday",profileDays:3});
  assert.equal(empty.day,null);assert.equal(empty.progressPercent,0);assert.match(empty.detail,/0 scheduled training days · 3-day profile target/);
});

test("alternative finder stays relevant and explains gains and losses",()=>{
  const reference=byId("flat-dumbbell-press"),items=Core.alternativesFor(reference,exercises,{...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]},4);
  assert.ok(items.length>0&&items.length<=4);
  for(const item of items){
    assert.equal(item.exercise.group,reference.group);
    assert.equal(item.exercise.sub,reference.sub);
    assert.notEqual(item.exercise.id,reference.id);
    assert.ok(item.match>=0&&item.match<=99);
    const trade=Core.gainsAndLosses(reference,item.exercise,methodology);
    assert.ok(trade.gain);
    assert.ok(trade.loss);
  }
});

test("alternative finder excludes exercises with incompatible targets",()=>{
  const allEquipment={...preferences,equipment:[...new Set(exercises.map((exercise)=>exercise.equipment))]};
  for(const id of ["cable-serratus-punch","tibialis-raise"]){
    const reference=byId(id),items=Core.alternativesFor(reference,exercises,allEquipment,exercises.length);
    assert.ok(items.length>=2,`${id} must now have useful alternatives`);
    assert.ok(items.every(({exercise})=>exercise.group===reference.group&&exercise.sub===reference.sub),`${id} alternatives must preserve the exact target`);
  }
});

test("exercise guidance is catalog-backed and offers same-target equipment swaps",()=>{
  for(const exercise of exercises){
    const guidance=Core.exerciseGuidance(exercise,exercises);
    assert.match(guidance.setup,new RegExp(exercise.equipment,"i"));
    assert.equal(guidance.cues.length,2,`${exercise.id} should keep two concise technique cues after setup`);
    assert.equal(guidance.mistake,exercise.caution);
    assert.match(guidance.prescription,new RegExp(exercise.reps.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.match(guidance.purpose,new RegExp(exercise.sub.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"));
    assert.ok(guidance.alternatives.length>=2&&guidance.alternatives.length<=3,`${exercise.id} alternatives`);
    for(const alternative of guidance.alternatives){
      assert.notEqual(alternative.exercise.equipment,exercise.equipment);
      assert.equal(alternative.exercise.group,exercise.group);
      assert.equal(alternative.exercise.sub,exercise.sub);
      assert.match(alternative.reason,/same .+ target with/i);
    }
  }
  assert.equal(Core.exerciseGuidance(null,exercises),null);
});

test("search, collections, filters, and sorts return the expected library slices",()=>{
  const aggregate=new Map([["flat-dumbbell-press",{exercise_id:"flat-dumbbell-press",rating_count:2,overall:5}]]),aggregateFor=(id)=>aggregate.get(id)||null;
  const base={collection:"all",query:"",group:"all",equipment:"all",pattern:"all",level:"all",sort:"personal"};
  const shoulderResults=Core.filterExercises(exercises,{...base,query:"shoulders"},preferences,aggregateFor);
  assert.ok(shoulderResults.length>0,"Shoulder search must not silently return an empty result");
  assert.ok(shoulderResults.every((exercise)=>exercise.group==="shoulders"));

  const dumbbellResults=Core.filterExercises(exercises,{...base,equipment:"Dumbbells"},preferences,aggregateFor);
  assert.equal(dumbbellResults.length,exercises.filter((exercise)=>exercise.equipment==="Dumbbells").length);
  assert.ok(dumbbellResults.length>0,"Dumbbell filter must return matching exercises");
  assert.ok(dumbbellResults.every((exercise)=>exercise.equipment==="Dumbbells"));

  const beginnerResults=Core.filterExercises(exercises,{...base,level:"Beginner"},preferences,aggregateFor);
  assert.equal(beginnerResults.length,exercises.filter((exercise)=>exercise.level==="Beginner").length);
  assert.ok(beginnerResults.length>0,"Beginner filter must return matching exercises");
  assert.ok(beginnerResults.every((exercise)=>exercise.level==="Beginner"));

  const bodyweightResults=Core.filterExercises(exercises,{...base,collection:"bodyweight"},preferences,aggregateFor);
  assert.equal(bodyweightResults.length,exercises.filter((exercise)=>exercise.equipment==="Bodyweight").length);
  assert.ok(bodyweightResults.every((exercise)=>exercise.equipment==="Bodyweight"));

  assert.deepEqual(Core.filterExercises(exercises,{...base,collection:"community",sort:"community"},preferences,aggregateFor).map((exercise)=>exercise.id),["flat-dumbbell-press"]);
  const saved=["flat-dumbbell-press","dead-bug"];
  assert.deepEqual(Core.filterExercises(exercises,{...base,collection:"saved",saved},preferences,aggregateFor).map((exercise)=>exercise.id).sort(),["dead-bug","flat-dumbbell-press"]);
  const scores=Core.filterExercises(exercises,{...base,sort:"score"},preferences,aggregateFor).map((exercise)=>exercise.score);
  assert.equal(scores.length,exercises.length,"Score sort must retain the complete library");
  assert.deepEqual(scores,[...scores].sort((a,b)=>b-a));
});

test("decision board normalization is bounded, unique, and limited to real catalog IDs",()=>{
  const requested=["flat-dumbbell-press","missing-exercise","dead-bug","flat-dumbbell-press","cable-fly","pullup","pressdown"];
  assert.deepEqual(Core.normalizeShortlist(requested,exercises,4),["flat-dumbbell-press","dead-bug","cable-fly","pullup"]);
  assert.deepEqual(Core.normalizeShortlist("flat-dumbbell-press",exercises,4),[]);
  assert.deepEqual(Core.normalizeShortlist(requested,exercises,2),["flat-dumbbell-press","dead-bug"]);
});

test("all exercises retain complete YouTube, scoring, and instruction data",()=>{
  assert.equal(exercises.length,320);
  assert.equal(new Set(exercises.map((exercise)=>exercise.id)).size,exercises.length,"Exercise IDs must be unique");
  assert.equal(new Set(exercises.map((exercise)=>exercise.name.toLowerCase())).size,exercises.length,"Exercise names must be unique");
  assert.deepEqual(Object.fromEntries(Object.keys(groups).map((group)=>[group,exercises.filter((exercise)=>exercise.group===group).length])),{chest:41,back:42,shoulders:41,arms:41,legs:41,glutes:41,calves:32,core:41});
  assert.deepEqual(Object.fromEntries(Object.keys(groups).map((group)=>[group,exercises.filter((exercise)=>exercise.group===group&&exercise.equipment==="Bodyweight").length])),{chest:8,back:7,shoulders:7,arms:6,legs:10,glutes:10,calves:10,core:13});
  assert.equal(exercises.filter((exercise)=>exercise.equipment==="Bodyweight").length,71);
  for(const [group,targets] of Object.entries(groups))for(const target of targets)assert.ok(exercises.filter((exercise)=>exercise.group===group&&exercise.sub===target).length>=3,`${group} / ${target} needs at least three choices`);
  for(const exercise of exercises){
    assert.deepEqual(Object.keys(exercise),fields,`${exercise.id} field order`);
    assert.match(exercise.id,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(groups[exercise.group]?.includes(exercise.sub),`${exercise.id} target`);
    assert.ok(equipment.has(exercise.equipment),`${exercise.id} equipment`);
    assert.ok(["Beginner","Intermediate","Advanced"].includes(exercise.level),`${exercise.id} level`);
    assert.equal(exercise.youtube,`https://www.youtube.com/results?search_query=${encodeURIComponent(`${exercise.name} exercise form tutorial`)}`);
    assert.deepEqual(Object.keys(exercise.metrics),["stimulus","stability","progression","range","fatigue"],`${exercise.id} metric keys`);
    for(const [key,value] of Object.entries(exercise.metrics))assert.ok(Number.isFinite(value)&&value>=0&&value<=100,`${exercise.id} ${key} metric ${value}`);
    assert.ok(Number.isFinite(exercise.score)&&exercise.score>=0&&exercise.score<=100,`${exercise.id} score ${exercise.score}`);
    assert.equal(exercise.cues.length,3,`${exercise.id} cues`);
    assert.ok(exercise.cues.every((cue)=>typeof cue==="string"&&cue.length>=8),`${exercise.id} cue quality`);
    assert.ok(exercise.why.length>20);
    assert.ok(exercise.caution.length>20);
    assert.equal(new Set(exercise.traits).size,exercise.traits.length,`${exercise.id} duplicate traits`);
    assert.ok(exercise.traits.every((trait)=>Core.TRAIT_KEYS.includes(trait)),`${exercise.id} traits`);
  }
});

test("limited-confidence exercise metadata references unique catalog entries",()=>{
  assert.equal(new Set(limitedConfidenceExercises).size,limitedConfidenceExercises.length,"Limited-confidence IDs must be unique");
  const exerciseIds=new Set(exercises.map((exercise)=>exercise.id));
  for(const id of limitedConfidenceExercises)assert.ok(exerciseIds.has(id),`Unknown limited-confidence exercise: ${id}`);
});
