"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DAILY_MOVEMENT_PAL,RESISTANCE_MET,activityBudget,netActivityKcal}=require("../src/energy-activity-core");

const profile=(overrides={})=>({age:35,weightKg:75,rmrKcal:1650,dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",...overrides});
const session=(overrides={})=>({day:"Monday",status:"ready",estimatedDurationMinutes:60,exercises:[{id:"press"}],...overrides});

test("structured movement anchors are monotonic and exclude workouts",()=>{
  const values=Object.keys(DAILY_MOVEMENT_PAL).map(dailyMovement=>activityBudget(profile({dailyMovement}),null).targetKcal);
  assert.deepEqual([...values].sort((a,b)=>a-b),values);assert.equal(new Set(values).size,values.length);
  assert.equal(activityBudget(profile(),null).plannedTrainingWeekKcal,0);
});

test("generated sessions and separately entered activity contribute once",()=>{
  const base=activityBudget(profile(),{sessions:[]}),one=activityBudget(profile(),{sessions:[session()]}),two=activityBudget(profile(),{sessions:[session(),session({day:"Thursday",estimatedDurationMinutes:45})]}),extra=activityBudget(profile({additionalActivityMinutesPerWeek:150}),{sessions:[session()]});
  assert.equal(base.nonWorkoutKcal,2227.5);assert.equal(base.targetKcal,2227.5);assert.equal(one.plannedTrainingWeekKcal,206.875);assert.equal(two.plannedTrainingWeekKcal,362.03125);assert.equal(extra.additionalActivityWeekKcal,714.0625);
  for(const result of [base,one,two,extra]){assert.equal(result.activityWeekKcal,result.plannedTrainingWeekKcal+result.additionalActivityWeekKcal);assert.ok(Math.abs(result.targetKcal-result.nonWorkoutKcal-result.activityWeekKcal/7)<1e-9,"the weekly activity contribution must be added exactly once as a daily average");}
});

test("unavailable sessions add zero and partial sessions use actual generated minutes",()=>{
  const unavailable=activityBudget(profile(),{sessions:[session({status:"unavailable",estimatedDurationMinutes:90,exercises:[]})]}),partial=activityBudget(profile(),{sessions:[session({status:"partial",estimatedDurationMinutes:20})]});
  assert.equal(unavailable.plannedTrainingWeekKcal,0);assert.equal(unavailable.sessions.length,0);assert.equal(partial.sessions[0].minutes,20);assert.ok(partial.plannedTrainingWeekKcal>0);
});

test("older-adult activity uses its age-specific Compendium oxygen reference",()=>{
  const adult=netActivityKcal({age:59,weightKg:75,rmrKcal:1500,minutes:60,met:3.5}),older=netActivityKcal({age:60,weightKg:75,rmrKcal:1500,minutes:60,met:4.3,oxygenMlPerKgMinute:2.7});
  assert.equal(RESISTANCE_MET.adult,3.5);assert.equal(RESISTANCE_MET.older_adult,4.3);assert.ok(Math.abs(adult-213.125)<1e-9);assert.ok(Math.abs(older-198.725)<1e-9);
});

test("generic activity keeps its standard MET units across age 60",()=>{
  for(const additionalActivityIntensity of ["light","moderate","vigorous"]){
    const adult=activityBudget(profile({age:59,additionalActivityMinutesPerWeek:420,additionalActivityIntensity})),older=activityBudget(profile({age:60,additionalActivityMinutesPerWeek:420,additionalActivityIntensity}));
    assert.equal(older.additionalActivityWeekKcal,adult.additionalActivityWeekKcal,"a birthday must not change the units of an identical activity");
    assert.equal(older.additionalOxygenMlPerKgMinute,3.5);assert.equal(older.resistanceOxygenMlPerKgMinute,2.7);
  }
  const older=activityBudget(profile({age:60,rmrKcal:1500}),{sessions:[session()]});
  assert.ok(Math.abs(older.plannedTrainingWeekKcal-198.725)<1e-9,"the actual older-adult resistance row retains its own reference");
});

test("session energy uses exact planned seconds rather than rounded display minutes",()=>{
  const exact=activityBudget(profile(),{sessions:[session({estimatedDurationMinutes:31,estimatedDurationSeconds:1801})]}),legacy=activityBudget(profile(),{sessions:[session({estimatedDurationMinutes:31})]});
  assert.equal(exact.sessions[0].durationSeconds,1801);
  assert.ok(exact.plannedTrainingWeekKcal<legacy.plannedTrainingWeekKcal);
  assert.ok(Math.abs(exact.plannedTrainingWeekKcal-(3.5*3.5*75/200-1650/1440)*1801/60)<1e-9);
});
