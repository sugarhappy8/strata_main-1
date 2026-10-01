"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const W=require("../public/scripts/workout-core.js");
const realCatalog=require("../public/data/exercises.json");

const catalog=[{id:"press",name:"Press",equipment:"Dumbbells",reps:"8–12"},{id:"push-up",name:"Push-up",equipment:"Bodyweight",reps:"8–15"},{id:"plank",name:"Plank",equipment:"Bodyweight",reps:"30–60 sec"},{id:"assisted-pull-up",name:"Assisted Pull-up",equipment:"Machine",reps:"6–10"}];
function makeWorkout(){
  const plan={days:{Monday:[{exerciseId:"press",sets:2,reps:"8–12"},{exerciseId:"push-up",sets:1,reps:"8–15"},{exerciseId:"plank",sets:1,reps:"30–60 sec"},{exerciseId:"assisted-pull-up",sets:1,reps:"6–10"}]}};
  return W.createWorkout(plan,"Monday",catalog,Date.UTC(2026,8,7,10));
}
function complete(workout){
  workout.entries[0].sets[0]={reps:8,weight:25,seconds:null,completed:true};
  workout.entries[0].sets[1]={reps:100,weight:1000,seconds:null,completed:false};
  workout.entries[1].sets[0]={reps:12,weight:null,seconds:null,completed:true};
  workout.entries[2].sets[0]={reps:null,weight:null,seconds:45,completed:true};
  workout.entries[3].sets[0]={reps:10,weight:40,seconds:null,completed:true};
  workout.status="completed";workout.completedAt=workout.startedAt+600000;workout.elapsedSeconds=600;
  return workout;
}

test("workout starts from a snapshot, infers explicit formats and never invents actual results",()=>{
  const workout=makeWorkout();
  assert.equal(workout.status,"active");
  assert.deepEqual(W.progress(workout),{total:5,completed:0,percent:0});
  assert.equal(workout.entries[0].loadType,"external");
  assert.equal(workout.entries[1].loadType,"bodyweight");
  assert.equal(workout.entries[2].measurement,"timed");
  assert.equal(workout.entries[3].loadType,"assisted");
  for(const entry of workout.entries)for(const set of entry.sets)assert.deepEqual(set,{reps:null,weight:null,seconds:null,completed:false,effort:null});
  assert.throws(()=>W.createWorkout({days:{Monday:[]}},"Monday",catalog),/Add exercises/);
  assert.throws(()=>W.createWorkout({days:{Monday:[{exerciseId:"unknown",sets:3}]}},"Monday",catalog),/unavailable/);
});

test("workout guidance summarizes a plan day and identifies the next unfinished set",()=>{
  const workout=makeWorkout();
  assert.deepEqual(W.planDaySummary({days:{Monday:[{sets:3},{sets:2}]}},"Monday"),{day:"Monday",movements:2,workingSets:5});
  assert.deepEqual(W.planDaySummary({days:{Monday:[]}},"Funday"),{day:null,movements:0,workingSets:0});
  assert.deepEqual(W.nextIncompleteSet(workout),{entryIndex:0,setIndex:0,entryId:workout.entries[0].id,exerciseId:"press",remaining:5});
  workout.entries[0].sets.forEach((set)=>{set.completed=true;});
  assert.deepEqual(W.nextIncompleteSet(workout),{entryIndex:1,setIndex:0,entryId:workout.entries[1].id,exerciseId:"push-up",remaining:3});
  workout.entries.forEach((entry)=>entry.sets.forEach((set)=>{set.completed=true;}));
  assert.equal(W.nextIncompleteSet(workout),null);
});

test("superset pairs guide alternating rounds while ordinary exercises keep their simple order",()=>{
  const workout=makeWorkout(),group="superset-rounds";workout.entries[0].supersetGroup=group;workout.entries[1].supersetGroup=group;
  assert.equal(W.nextIncompleteSet(workout).entryId,workout.entries[0].id);
  workout.entries[0].sets[0].completed=true;
  assert.equal(W.nextIncompleteSet(workout).entryId,workout.entries[1].id);
  workout.entries[1].sets[0].completed=true;
  assert.equal(W.nextIncompleteSet(workout).setIndex,1);assert.equal(W.nextIncompleteSet(workout).entryId,workout.entries[0].id);
});

test("an unequal superset pair points only at real unfinished sets",()=>{
  const workout=makeWorkout(),group="unequal-pair";workout.entries[0].supersetGroup=group;workout.entries[1].supersetGroup=group;
  workout.entries[0].sets=[{reps:8,weight:20,seconds:null,completed:true,effort:null}];
  workout.entries[1].sets=[{reps:10,weight:null,seconds:null,completed:true,effort:null},W.blankSet()];
  assert.deepEqual(W.nextIncompleteSet(workout),{entryIndex:1,setIndex:1,entryId:workout.entries[1].id,exerciseId:"push-up",remaining:3});
  workout.entries[1].sets[1].completed=true;
  assert.equal(W.nextIncompleteSet(workout).entryId,workout.entries[2].id,"a finished unequal pair moves on to the next exercise");
  workout.entries[0].sets.push(W.blankSet(),W.blankSet());W.removeSet(workout.entries[0],2);
  assert.deepEqual(W.nextIncompleteSet(workout),{entryIndex:0,setIndex:1,entryId:workout.entries[0].id,exerciseId:"press",remaining:3});
  workout.entries.forEach((entry)=>entry.sets.forEach((set)=>{set.completed=true;}));
  assert.equal(W.nextIncompleteSet(workout),null);
});

test("live input uses the same field rules as completion, so invalid values are never applied",()=>{
  const reps={measurement:"reps",loadType:"external",effortType:"rir"},rpe={...reps,effortType:"rpe"},none={...reps,effortType:"none"};
  for(const value of [-1,0,8.5,1001,Number.NaN])assert.match(W.inputError(reps,"reps",value),/repetitions from 1 to 1,000/,String(value));
  for(const value of [0,3601,12.5])assert.match(W.inputError(reps,"seconds",value),/1 to 3,600 whole seconds/,String(value));
  for(const value of [-0.5,1000.5,2.555,Number.POSITIVE_INFINITY])assert.match(W.inputError(reps,"weight",value),/0 to 1,000/,String(value));
  assert.match(W.inputError(reps,"effort",10.5),/RIR must be from 0 to 10/);assert.match(W.inputError(rpe,"effort",0),/RPE must be from 1 to 10/);assert.match(W.inputError(reps,"effort",2.25),/half steps/);assert.match(W.inputError(none,"effort",2),/Choose RIR or RPE/);
  for(const [field,value] of [["reps",8],["seconds",45],["weight",0],["weight",37.5],["effort",2.5],["reps",null]])assert.equal(W.inputError(reps,field,value),"",`${field} ${value}`);
  assert.match(W.inputError(reps,"note","x"),/not recognized/);
  assert.equal(W.cleanNote("Brace\u202E then\u0007 press"),"Brace then press");assert.equal(W.cleanNote("x".repeat(600)).length,500);assert.equal(W.cleanNote(null),"");
});

test("a draft poisoned by an older build reopens with each invalid value cleared and listed",()=>{
  const workout=makeWorkout(),record={ownerId:"account:42",contextId:"device",workout,dirty:true};
  workout.entries[0].sets[0]={reps:-1,weight:20,seconds:null,completed:false,effort:null};
  workout.entries[1].sets[0]={reps:8.5,weight:null,seconds:null,completed:true,effort:null};
  const raw=JSON.stringify(record);
  assert.equal(W.readDraft(raw,"account:42"),null,"strict reads still refuse invalid values");
  const repaired=W.repairDraft(raw,"account:42");
  assert.deepEqual(repaired.repairs,[
    {entryId:workout.entries[0].id,exerciseId:"press",setIndex:0,field:"reps",value:-1},
    {entryId:workout.entries[1].id,exerciseId:"push-up",setIndex:0,field:"reps",value:8.5},
    {entryId:workout.entries[1].id,exerciseId:"push-up",setIndex:0,field:"completed",value:true}
  ]);
  assert.deepEqual(repaired.record.workout.entries[0].sets[0],{reps:null,weight:20,seconds:null,completed:false,effort:null});
  assert.equal(repaired.record.workout.entries[1].sets[0].completed,false);
  assert.ok(W.readDraft(JSON.stringify(repaired.record),"account:42"),"the repaired record is valid again");
  assert.deepEqual(W.repairDraft(JSON.stringify({ownerId:"account:42",workout}),"account:42").repairs.length,3);
  assert.equal(W.repairDraft(raw,"account:43"),null,"repair never crosses accounts");
  assert.equal(W.repairDraft(JSON.stringify({...record,workout:{...workout,status:"paused"}}),"account:42"),null,"structural problems still hide the draft");
  assert.deepEqual(W.repairDraft(JSON.stringify({...record,workout:makeWorkout()}),"account:42").repairs,[],"a valid draft needs no repair");
});

test("actual catalog timed prescriptions and compact seconds shorthand infer timed logging",()=>{
  const timedIds=["superman-hold","prone-cobra","planche-lean","wall-external-rotation-isometric","copenhagen-plank","calf-isometric-hold","seated-calf-isometric-machine","side-plank","front-plank","hollow-body-hold"];
  for(const exerciseId of timedIds){
    const exercise=realCatalog.find((item)=>item.id===exerciseId);
    assert.ok(exercise,`${exerciseId} exists in the real catalog`);
    assert.equal(W.inferFormat(exercise).measurement,"timed",`${exerciseId}: ${exercise.reps}`);
    assert.equal(W.inferFormat(exercise,"15–30s / side").measurement,"timed");
    const plan={days:{Monday:[{exerciseId,sets:2,reps:exercise.reps}]}};
    const entry=W.createWorkout(plan,"Monday",realCatalog).entries[0];
    assert.equal(entry.measurement,"timed");
    assert.equal(entry.sets[0].seconds,null);assert.equal(entry.sets[0].reps,null);
  }
  for(const prescription of ["30 s","30s","15–30sec","20 seconds","1min","2 minutes"]){
    assert.equal(W.inferFormat(catalog[0],prescription).measurement,"timed",prescription);
  }
  assert.equal(W.inferFormat(catalog[0],"8–12 / side").measurement,"reps");
  assert.equal(W.inferFormat(catalog[0],"3 sets").measurement,"reps");
});

test("support-only bench exercises default to bodyweight without hiding the external-load option",()=>{
  for(const exerciseId of ["bench-reverse-crunch","decline-bench-crunch","calf-isometric-hold"]){
    const exercise=realCatalog.find((item)=>item.id===exerciseId);
    assert.equal(W.inferFormat(exercise).loadType,"bodyweight",exerciseId);
  }
  assert.equal(W.inferFormat(realCatalog.find((item)=>item.id==="seated-calf-isometric-machine")).loadType,"external");
});

test("a requested planner day survives guest selection and reload; missing or invalid days use today",()=>{
  const sunday=new Date(2026,8,6,12);
  assert.equal(W.today(sunday),"Sunday");
  const initial=new URL("https://strata.example/workout.html?day=Monday");
  assert.equal(W.dayFromSearch(initial.search,sunday),"Monday");
  initial.searchParams.set("guest","1");
  assert.equal(W.dayFromSearch(initial.search,sunday),"Monday");
  assert.equal(W.dayFromSearch(new URL(initial.href).search,sunday),"Monday");
  initial.searchParams.set("day","Friday");
  assert.equal(W.dayFromSearch(new URL(initial.href).search,sunday),"Friday");
  assert.equal(W.dayFromSearch("",sunday),"Sunday");
  assert.equal(W.dayFromSearch("?guest=1&day=Someday",sunday),"Sunday");
  assert.equal(W.dayFromSearch("?day=monday",sunday),"Sunday");
});

test("offline authorization ends at the earliest verified grant, period, cancel, or pause boundary",()=>{
  const now=Date.UTC(2026,8,8,12),hour=60*60*1000;
  assert.equal(W.offlineAccessUntil({active:false},now),0);
  assert.equal(W.offlineAccessUntil({active:true,accessType:"grant",adminGrant:{active:true,expiresAt:now+30*60*1000}},now),now+30*60*1000);
  assert.equal(W.offlineAccessUntil({active:true,accessType:"paid",subscription:null},now),now+24*hour,"grandfathered access keeps the bounded device window");
  assert.equal(W.offlineAccessUntil({active:true,accessType:"paid",subscription:{currentPeriodEndsAt:now+48*hour,scheduledChange:null}},now),now+24*hour);
  for(const action of ["cancel","pause"]){
    assert.equal(W.offlineAccessUntil({active:true,accessType:"paid",subscription:{currentPeriodEndsAt:now+48*hour,scheduledChange:{action,effectiveAt:now+2*hour}}},now),now+2*hour,action);
    assert.equal(W.offlineAccessUntil({active:true,accessType:"paid",subscription:{currentPeriodEndsAt:now+48*hour,scheduledChange:{action,effectiveAt:now}}},now),0,`${action} at the current boundary fails closed`);
  }
  assert.equal(W.offlineAccessUntil({active:true,accessType:"paid",subscription:{currentPeriodEndsAt:now}},now),0,"an ended or missing billing period cannot authorize offline use");
});

test("offline authorization for App Store members ends at the verified expiry, within the same device window",()=>{
  const now=Date.UTC(2026,8,8,12),hour=60*60*1000,apple=(value)=>({active:true,accessType:"apple",subscription:null,apple:{active:true,productId:"online.stratafitness.app.plus.monthly",expiresAt:now+2*hour,autoRenew:true,inGracePeriod:false,environment:"Production",revoked:false,...value}});
  assert.equal(W.offlineAccessUntil(apple({}),now),now+2*hour,"a period ending sooner than the device window ends offline use with it");
  assert.equal(W.offlineAccessUntil(apple({expiresAt:now+30*24*hour}),now),now+24*hour,"a long App Store period keeps the bounded device window");
  assert.equal(W.offlineAccessUntil(apple({autoRenew:false,expiresAt:now+3*hour}),now),now+3*hour,"a cancelled subscription still runs to its expiry");
  assert.equal(W.offlineAccessUntil(apple({inGracePeriod:true,expiresAt:now-hour}),now),now+24*hour,"Apple's billing grace period keeps access within the device window");
  for(const [label,value] of [["expired",{expiresAt:now}],["revoked",{revoked:true}],["inactive",{active:false}],["no expiry",{expiresAt:null}],["malformed expiry",{expiresAt:"soon"}]])assert.equal(W.offlineAccessUntil(apple(value),now),0,label);
  assert.equal(W.offlineAccessUntil({active:true,accessType:"apple",apple:null,subscription:{currentPeriodEndsAt:now+48*hour}},now),0,"a missing App Store summary never falls back to another billing record");
});

test("complete sets require actual positive reps or seconds and an explicit external or assisted load",()=>{
  const [external,bodyweight,timed,assisted]=makeWorkout().entries;
  assert.match(W.actualError(external,{reps:null,weight:null}),/repetitions/);
  assert.match(W.actualError(external,{reps:8,weight:null}),/explicit load/);
  assert.equal(W.actualError(external,{reps:8,weight:0}),"");
  assert.match(W.actualError(external,{reps:8,weight:2.555}),/decimal places/);
  assert.match(W.actualError(external,{reps:8.5,weight:20}),/repetitions/);
  assert.equal(W.actualError(bodyweight,{reps:12,weight:null}),"");
  assert.equal(W.actualError(timed,{seconds:60,weight:null}),"");
  assert.match(W.actualError(timed,{seconds:0,weight:null}),/actual time/);
  assert.match(W.actualError(assisted,{reps:10,weight:null}),/explicit load/);
  assert.equal(W.actualError(assisted,{reps:10,weight:40}),"");
});

test("history counts only checked sets and excludes assisted/bodyweight/timed fake volume",()=>{
  const workout=complete(makeWorkout()),summary=W.summary(workout);
  assert.equal(summary.totalSets,5);assert.equal(summary.completedSets,4);
  const [external,bodyweight,timed,assisted]=summary.exerciseSummaries;
  assert.equal(external.totalReps,8);assert.equal(external.maxWeight,25);assert.equal(external.volume,200);
  assert.equal(bodyweight.totalReps,12);assert.equal(bodyweight.volume,0);assert.equal(bodyweight.maxWeight,null);
  assert.equal(timed.totalReps,0);assert.equal(timed.totalSeconds,45);assert.equal(timed.volume,0);assert.equal(timed.maxReps,null);
  assert.equal(assisted.totalReps,10);assert.equal(assisted.volume,0);assert.equal(assisted.maxWeight,null);
  assert.equal(W.metrics(assisted).some((metric)=>metric.key==="volume"||metric.key==="maxWeight"),false);
  assert.equal(W.metrics(timed).some((metric)=>metric.key==="volume"||metric.key==="maxWeight"),false);
});

test("chart comparisons isolate exercise, measurement, load type and unit, and exclude active sessions",()=>{
  const base=complete(makeWorkout()),higher=W.copy(base),pounds=W.copy(base),active=W.copy(base),assisted=W.copy(base);
  higher.id="higher-session";higher.startedAt+=86400000;higher.entries[0].sets[0].weight=30;
  pounds.id="pounds-session";pounds.entries[0].unit="lb";pounds.entries[0].sets[0].weight=100;
  active.id="active-session";active.status="active";active.entries[0].sets[0].weight=200;
  assisted.id="assisted-session";assisted.entries[0].loadType="assisted";assisted.entries[0].sets[0].weight=300;
  const points=W.series([pounds,active,higher,assisted,base].map(W.summary),W.formatKey(base.entries[0]),"maxWeight");
  assert.deepEqual(points.map((point)=>point.value),[25,30]);
  assert.equal(W.bestInWindow(points),30);
  assert.equal(W.bestInWindow([]),null);
  assert.deepEqual(W.series([W.summary(assisted)],W.formatKey(assisted.entries[0]),"volume"),[]);
});

test("repeated exercise entries aggregate correctly without duplicate session chart points",()=>{
  const workout=complete(makeWorkout()),entry=W.copy(workout.entries[0]);
  entry.id="second-press";entry.sets=[{reps:6,weight:30,seconds:null,completed:true}];workout.entries.push(entry);
  const summary=W.summary(workout),press=summary.exerciseSummaries.find((item)=>item.exerciseId==="press");
  assert.equal(press.completedSets,2);assert.equal(press.totalReps,14);assert.equal(press.volume,380);
  assert.equal(press.maxWeight,30);
  assert.equal(W.series([summary],W.formatKey(entry),"volume").length,1);
});

test("absolute rest deadlines survive delayed ticks and background time without drift",()=>{
  const started=1000000,deadline=started+90000;
  assert.equal(W.remainingSeconds(deadline,started),90);
  assert.equal(W.remainingSeconds(deadline,started+40500),50);
  assert.equal(W.remainingSeconds(deadline,started+90001),0);
  assert.equal(W.remainingSeconds(null,started),0);
  const paused=W.remainingSeconds(deadline,started+30000),resumedDeadline=started+500000+paused*1000;
  assert.equal(W.remainingSeconds(resumedDeadline,started+500000),60);
  assert.equal(W.duration(3661),"1:01:01");assert.equal(W.duration(-1),"0:00");
});

test("draft recovery requires the exact account owner and rejects malformed numeric payloads",()=>{
  const workout=makeWorkout(),record={ownerId:"account:42",workout,dirty:true};
  assert.ok(W.readDraft(JSON.stringify(record),"account:42"));
  assert.equal(W.readDraft(JSON.stringify(record),"account:43"),null);
  assert.equal(W.readDraft(JSON.stringify(record),"guest"),null);
  assert.notEqual(W.draftPrefix("account:42"),W.draftPrefix("account:43"));
  assert.notEqual(W.draftPrefix("account:42"),W.draftPrefix("guest"));
  assert.throws(()=>W.draftPrefix(""),/explicit storage owner/);
  workout.entries[0].sets[0].weight='" autofocus onfocus="bad';
  assert.equal(W.readDraft(JSON.stringify(record),"account:42"),null);
  assert.equal(W.readDraft("not json","account:42"),null);
});

test("save confirmation compares canonical semantic fields and detects an old POST replay result",()=>{
  const original=makeWorkout(),saved={...W.copy(original),revision:1,updatedAt:2000000};
  saved.entries[0].sets[0]={completed:false,seconds:null,weight:null,reps:null};
  assert.equal(W.matches(saved,original),true);
  saved.entries[0].sets[0]={reps:10,weight:25,seconds:null,completed:true};
  saved.revision=2;
  assert.equal(W.matches(saved,original),false);
  assert.equal(Object.hasOwn(W.payload(saved),"revision"),false);
  assert.equal(Object.hasOwn(W.payload(saved),"updatedAt"),false);
});

test("Workout Memory uses only the latest exact exercise, measurement, load-type and unit match",()=>{
  const current=makeWorkout(),older=complete(makeWorkout()),newer=complete(makeWorkout()),pounds=complete(makeWorkout());
  older.id="older";older.date="2026-09-01";older.startedAt=100;older.entries[0].sets[0]={reps:8,weight:25,seconds:null,completed:true,effort:2};older.entries[0].effortType="rir";
  newer.id="newer";newer.date="2026-09-05";newer.startedAt=200;newer.entries[0].sets[0]={reps:10,weight:27.5,seconds:null,completed:true,effort:null};
  pounds.id="pounds";pounds.startedAt=300;pounds.entries[0].unit="lb";pounds.entries[0].sets[0].weight=80;
  const memory=W.previousComparable([W.summary(older),W.summary(pounds),W.summary(newer)],current.entries[0],current.id);
  assert.equal(memory.workoutId,"newer");assert.equal(memory.date,"2026-09-05");assert.deepEqual(memory.sets[0],{reps:10,weight:27.5,seconds:null,effort:null,effortType:"none"});
  const target=W.suggestedTargets(current.entries[0],memory);assert.equal(target.source,"previous");assert.equal(target.sets[0].weight,27.5);assert.equal(target.sets[0].reps,10);
  W.applyTargets(current.entries[0],target.sets);assert.equal(current.entries[0].sets[1].weight,27.5);
  assert.throws(()=>W.applyTargets(current.entries[0],target.sets),/Clear this exercise/);
  assert.equal(W.previousComparable([W.summary(pounds)],current.entries[0]),null);
});

test("set editing is explicit, bounded and never treats a copied set as completed",()=>{
  const entry=makeWorkout().entries[0];entry.sets[0]={reps:8,weight:20,seconds:null,completed:false,effort:null};
  assert.equal(W.duplicateSet(entry,0),1);assert.deepEqual(entry.sets[1],{reps:8,weight:20,seconds:null,completed:false,effort:null});
  assert.equal(W.addSet(entry),3);assert.deepEqual(entry.sets[3],W.blankSet());
  assert.equal(W.removeSet(entry,3),2);entry.sets[0].completed=true;
  assert.throws(()=>W.removeSet(entry,0),/Uncheck/);
  entry.sets=Array.from({length:10},W.blankSet);assert.throws(()=>W.addSet(entry),/at most 10/);assert.throws(()=>W.duplicateSet(entry,0),/at most 10/);
});

test("optional effort, notes and grouping survive canonical payload and account-scoped recovery",()=>{
  const workout=makeWorkout(),entry=workout.entries[0];entry.note="Seat notch 4\nControlled lowering";entry.effortType="rpe";entry.supersetGroup="superset-a";entry.replacedFromExerciseId="push-up";entry.sets[0].effort=8.5;
  assert.equal(W.effortError(entry,entry.sets[0]),"");assert.match(W.effortError({...entry,effortType:"rir"},{effort:10.5}),/RIR/);assert.match(W.effortError({...entry,effortType:"none"},{effort:5}),/Choose/);
  const payload=W.payload(workout);assert.equal(payload.entries[0].note,entry.note);assert.equal(payload.entries[0].sets[0].effort,8.5);
  const record=W.readDraft(JSON.stringify({ownerId:"account:42",workout:payload,dirty:true}),"account:42");assert.equal(record.workout.entries[0].supersetGroup,"superset-a");assert.equal(record.workout.entries[0].sets[0].effort,8.5);
  assert.equal(W.readDraft(JSON.stringify({ownerId:"account:other",workout:payload,dirty:true}),"account:42"),null);
});

test("warm-up and plate calculators are deterministic and reject impossible inputs",()=>{
  assert.deepEqual(W.warmupSets(100),[{percent:40,load:40,reps:8},{percent:60,load:60,reps:5},{percent:80,load:80,reps:3}]);
  assert.deepEqual(W.warmupSets(0),[]);
  assert.deepEqual(W.plateBreakdown(100,20),{pairs:[{plate:25,count:1},{plate:15,count:1}],remainder:0,achievable:true});
  assert.deepEqual(W.plateInventory("lb"),[45,35,25,10,5,2.5]);assert.deepEqual(W.plateInventory("kg"),[25,20,15,10,5,2.5,1.25]);assert.deepEqual(W.plateInventory("stone"),W.plateInventory("kg"));
  assert.deepEqual(W.plateBreakdown(135,45,W.plateInventory("lb")),{pairs:[{plate:45,count:1}],remainder:0,achievable:true});
  assert.deepEqual(W.plateBreakdown(225,45,W.plateInventory("lb")),{pairs:[{plate:45,count:2}],remainder:0,achievable:true});
  assert.deepEqual(W.plateBreakdown(136,45,W.plateInventory("lb")),{pairs:[{plate:45,count:1}],remainder:.5,achievable:false});
  assert.deepEqual(W.plateBreakdown(21,20),{pairs:[],remainder:.5,achievable:false});
  assert.equal(W.plateBreakdown(10,20).remainder,null);
});

test("exercise swap explains trade-offs and Plan proposals remain immutable until approval",()=>{
  const reference={id:"press",group:"chest",sub:"Upper chest",equipment:"Dumbbells",score:90,metrics:{stability:80}},candidate={id:"machine",group:"chest",sub:"Upper chest",equipment:"Machine",score:94,metrics:{stability:95}};
  const comparison=W.swapComparison(reference,candidate);assert.equal(comparison.compatible,true);assert.equal(comparison.fitDelta,4);assert.equal(comparison.stabilityDelta,15);assert.match(comparison.explanation,/Same upper chest target/);
  const workout=makeWorkout(),plan={version:1,days:{Monday:[{instanceId:"plan-press",exerciseId:"press",sets:2,reps:"8–12"}]}};workout.entries[0].planInstanceId="plan-press";
  const proposal=W.planSwapProposal(plan,"Monday",workout.entries[0],"machine");assert.equal(plan.days.Monday[0].exerciseId,"press");assert.equal(proposal.plan.days.Monday[0].exerciseId,"machine");assert.equal(proposal.before,"press");
});


test("memory uses the latest earlier exposure even when it has no completed sets",()=>{
  const current=makeWorkout(),entry=current.entries[0],format={exerciseId:entry.exerciseId,measurement:entry.measurement,loadType:entry.loadType,unit:entry.unit};
  const row=(id,startedAt,setValues)=>({id,startedAt,date:"2026-09-05",status:"completed",exerciseSummaries:[{...format,setValues}]});
  const good=row("old",1000,[{reps:12,weight:40,seconds:null}]),unfinished=row("latest",2000,[]),future=row("future",4000,[{reps:12,weight:80,seconds:null}]);
  const latest=W.previousComparable([good,future,unfinished],entry,current.id,3000);
  assert.equal(latest.workoutId,"latest");assert.deepEqual(latest.sets,[]);
  assert.equal(W.previousComparable([future],entry,current.id,3000),null);
});

test("workout dates display like the rest of STRATA and keep the year only when it differs",()=>{
  const now=new Date(2026,8,30,9);
  const expected=(options,date)=>new Intl.DateTimeFormat(undefined,options).format(date);
  assert.equal(W.displayDate("2026-09-30",{now}),expected({weekday:"short",month:"short",day:"numeric"},new Date(2026,8,30,12)));
  assert.equal(W.displayDate("2025-12-31",{now}),expected({weekday:"short",month:"short",day:"numeric",year:"numeric"},new Date(2025,11,31,12)));
  assert.equal(W.displayDate("2026-09-01",{weekday:false,now}),expected({month:"short",day:"numeric"},new Date(2026,8,1,12)));
  assert.equal(W.displayDate("not-a-date",{now}),"not-a-date");
  assert.equal(W.displayDate(null,{now}),"");
});
