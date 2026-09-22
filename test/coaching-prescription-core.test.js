"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EXERCISES}=require("../src/plans");
const {exerciseFormat,estimatedSeconds,prepareEvidence,startingPrescription,withPerformance}=require("../src/coaching-prescription-core");
const Workout=require("../public/scripts/workout-core");

const WEEK="2026-09-14";
function prescription(id){
  const exercise=EXERCISES.find(item=>item.id===id),profile={experience:"intermediate",trainingGoal:"balanced",usualExercises:[]},format=exerciseFormat(exercise,"kg");
  return {exerciseId:id,...format,...startingPrescription(profile,exercise,format)};
}
function workout(item,values,date="2026-09-11"){
  return {id:`workout-${date}`,date,status:"completed",startedAt:Date.parse(`${date}T12:00:00Z`),completedAt:Date.parse(`${date}T13:00:00Z`),entries:[{id:`entry-${date}`,exerciseId:item.exerciseId,measurement:item.measurement,loadType:item.loadType,unit:item.unit,prescribedReps:item.reps,sets:values.map(value=>({completed:true,reps:item.measurement==="reps"?value:null,seconds:item.measurement==="timed"?value:null,weight:item.loadType==="bodyweight"?null:40,effort:null}))}]};
}
function recommend(item,workouts){return withPerformance(item,prepareEvidence({workouts},WEEK,"UTC"),WEEK);}

test("bench-supported bodyweight exercises use the same load category as the workout logger",()=>{
  const benchExercises=EXERCISES.filter(exercise=>exercise.equipment==="Bench");
  assert.ok(benchExercises.some(exercise=>exercise.id==="hands-elevated-push-up"));
  for(const exercise of benchExercises){
    const format=exerciseFormat(exercise,"kg");
    assert.equal(format.loadType,"bodyweight",exercise.id);assert.equal(format.loadType,Workout.inferFormat(exercise).loadType,exercise.id);
  }
  for(const [id,expected] of [["flat-dumbbell-press","external"],["neutral-pulldown","external"],["band-chest-press","external"],["assisted-pull-up-machine","assisted"]]){
    const exercise=EXERCISES.find(item=>item.id===id);
    assert.equal(exerciseFormat(exercise,"kg").loadType,expected,id);assert.equal(exerciseFormat(exercise,"kg").loadType,Workout.inferFormat(exercise).loadType,id);
  }
});

test("complete bench bodyweight workouts from the logger support comparable rep targets",()=>{
  const item=prescription("hands-elevated-push-up"),recordedValue=item.range.low;
  const histories=["2026-09-11","2026-09-04"].map(date=>{
    const startedAt=Date.parse(`${date}T12:00:00Z`),logged=Workout.createWorkout({days:{Friday:[{exerciseId:item.exerciseId,sets:item.sets,reps:item.reps}]}},"Friday",EXERCISES,startedAt);
    Object.assign(logged,{id:`logged-${date}`,date,status:"completed",completedAt:startedAt+3600000});
    for(const set of logged.entries[0].sets)Object.assign(set,{completed:true,reps:recordedValue});
    assert.equal(logged.entries[0].loadType,"bodyweight");
    return logged;
  });
  const result=recommend(item,histories);
  assert.equal(result.performance.action,"increase_reps");assert.equal(result.suggestedStartingLoad,null);
  assert.deepEqual(result.targetSets.map(set=>set.reps),[recordedValue+1,recordedValue,recordedValue]);
  assert.ok(result.targetSets.every(set=>set.weight===null));
});

test("recorded time above the prescription cannot silently enlarge the session budget",()=>{
  const item=prescription("front-plank"),history=workout(item,[120,120,120]),original=structuredClone(history),result=recommend(item,[history]);
  assert.equal(item.range.high,60);
  assert.equal(result.performance.status,"reference_only");assert.equal(result.targetSets,null);assert.equal(result.suggestedStartingLoad,null);
  assert.match(result.loadingGuidance,/exceed this prescription/);
  assert.equal(estimatedSeconds(result),estimatedSeconds(item));assert.deepEqual(result.range,item.range);assert.deepEqual(history,original);
});

test("one out-of-range recorded rep target retains the budgeted starting prescription",()=>{
  const item=prescription("flat-dumbbell-press"),result=recommend(item,[workout(item,[item.range.high,item.range.high+1,item.range.high])]);
  assert.equal(result.performance.status,"reference_only");assert.equal(result.targetSets,null);assert.equal(result.suggestedStartingLoad,null);
  assert.equal(result.reps,item.reps);assert.equal(result.sets,item.sets);
});

test("within-range targets and lower recorded baselines remain usable",()=>{
  const item=prescription("front-plank");
  for(const value of [item.range.high,item.range.low-1]){
    const result=recommend(item,[workout(item,Array(item.sets).fill(value))]);
    assert.equal(result.performance.status,"repeat");assert.deepEqual(result.targetSets.map(set=>set.seconds),Array(item.sets).fill(value));
  }
});

test("a load progression that returns reps to the current range still fits the prescription",()=>{
  const item=prescription("flat-dumbbell-press"),values=Array(item.sets).fill(item.range.high+1),result=recommend(item,[workout(item,values),workout(item,values,"2026-09-04")]);
  assert.equal(result.performance.action,"increase_load");assert.equal(result.suggestedStartingLoad.value,42.5);
  assert.deepEqual(result.targetSets.map(set=>set.reps),Array(item.sets).fill(item.range.low));
});
