"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const Monthly=require("../public/scripts/monthly-plan-core");
const exercises=require("../public/data/exercises.json");

const ALL_EQUIPMENT=[...new Set(exercises.map((exercise)=>exercise.equipment))];
const preferences={goal:"hypertrophy",level:"Intermediate",days:4,equipment:ALL_EQUIPMENT,preferences:["stable","long-range"],limitations:[]};
const byId=(id)=>exercises.find((exercise)=>exercise.id===id);

function emptyWeeklyPlan(){return{version:1,restDay:"Sunday",days:Object.fromEntries(Monthly.DAYS.map((day)=>[day,[]]))};}
function scheduleWith(training={Monday:["chest"]}){
  return Object.fromEntries(Monthly.DAYS.map((day)=>[day,training[day]?{rest:false,targets:training[day],sourceItems:[]}:{rest:true,targets:[],sourceItems:[]} ]));
}

test("monthly target helpers distinguish arm muscles and broad groups",()=>{
  assert.equal(Monthly.inferTarget(byId("incline-curl")),"biceps");
  assert.equal(Monthly.inferTarget(byId("hammer-curl")),"biceps");
  assert.equal(Monthly.inferTarget(byId("pressdown")),"triceps");
  assert.equal(Monthly.inferTarget(byId("reverse-curl")),"forearms");
  assert.equal(Monthly.inferTarget(byId("flat-dumbbell-press")),"chest");
  assert.equal(Monthly.matchesTarget(byId("pressdown"),"biceps"),false);
  assert.equal(Monthly.matchesTarget(byId("bulgarian-split"),"legs"),true);
  assert.deepEqual(Monthly.TARGET_KEYS,["chest","back","shoulders","biceps","triceps","forearms","legs","glutes","calves","core"]);
});

test("UTC date helpers always produce 31 consecutive calendar dates across boundaries",()=>{
  const cases=[
    ["2026-12-20","2027-01-19"],
    ["2028-02-10","2028-03-11"],
    ["2026-03-01","2026-03-31"],
    ["2026-10-25","2026-11-24"]
  ];
  for(const [start,end] of cases){
    const dates=Monthly.dateRange(start,31);
    assert.equal(dates.length,31);
    assert.equal(dates[0],start);
    assert.equal(dates.at(-1),end);
    for(let index=1;index<dates.length;index++)assert.equal(dates[index],Monthly.addUtcDays(dates[index-1],1));
  }
  assert.equal(Monthly.addUtcDays("2028-02-28",1),"2028-02-29");
  assert.equal(Monthly.addUtcDays("2028-02-28",2),"2028-03-01");
  assert.throws(()=>Monthly.parseIsoDate("2027-02-29"),/valid start date/i);
});

test("weekly plan import accepts raw and exported wrapper JSON and normalizes prescriptions",()=>{
  const weekly=emptyWeeklyPlan();
  weekly.days.Monday.push({instanceId:"weekly-press-1",exerciseId:"flat-dumbbell-press",sets:3.6,reps:" 8–12 "});
  const raw=Monthly.parseWeeklyPlanFile(`\uFEFF${JSON.stringify(weekly)}`,exercises);
  const wrapped=Monthly.parseWeeklyPlanFile({format:"strata-weekly-plan",version:1,plan:weekly},exercises);
  assert.deepEqual(raw,wrapped);
  assert.deepEqual(raw.days.Monday[0],{instanceId:"weekly-press-1",exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"});

  const schedule=Monthly.scheduleFromWeeklyPlan(wrapped,exercises);
  assert.deepEqual(schedule.Monday,{rest:false,targets:["chest"],sourceItems:[{exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"}]});
  assert.deepEqual(schedule.Sunday,{rest:true,targets:[],sourceItems:[]});
});

test("weekly plan import rejects malformed, unknown, oversized, and conflicting files",()=>{
  assert.throws(()=>Monthly.parseWeeklyPlanFile("not json",exercises),/valid JSON/i);
  assert.throws(()=>Monthly.parseWeeklyPlanFile({format:"something-else",version:1,plan:emptyWeeklyPlan()},exercises),/not a supported/i);
  const missing=emptyWeeklyPlan();delete missing.days.Wednesday;
  assert.throws(()=>Monthly.parseWeeklyPlanFile(missing,exercises),/missing Wednesday/i);
  const unknown=emptyWeeklyPlan();unknown.days.Monday.push({exerciseId:"unknown-movement",sets:3,reps:"10"});
  assert.throws(()=>Monthly.parseWeeklyPlanFile(unknown,exercises),/not in STRATA's library/i);
  const conflict=emptyWeeklyPlan();conflict.days.Sunday.push({exerciseId:"dead-bug",sets:3,reps:"10"});
  assert.throws(()=>Monthly.parseWeeklyPlanFile(conflict,exercises),/recovery day must not contain/i);
  assert.throws(()=>Monthly.parseWeeklyPlanFile(" ".repeat(256*1024+1),exercises),/larger than 256 KB/i);
});

test("generator creates exactly 31 days with explicit rest and multiple muscle groups",()=>{
  const schedule=scheduleWith({Monday:["legs","glutes"],Tuesday:["biceps","triceps"],Thursday:["back","biceps"]});
  const plan=Monthly.generateMonthPlan({title:"September block",startDate:"2026-09-07",exercisesPerTarget:2,schedule,exercises,preferences});
  assert.equal(plan.days.length,31);
  assert.equal(plan.days[0].weekday,"Monday");
  assert.deepEqual(plan.days[0].targets,["legs","glutes"]);
  assert.equal(plan.days[0].exercises.length,4);
  assert.equal(new Set(plan.days[0].exercises.map(({exerciseId})=>exerciseId)).size,4);
  assert.ok(plan.days[0].exercises.some(({exerciseId})=>Monthly.matchesTarget(byId(exerciseId),"legs")));
  assert.ok(plan.days[0].exercises.some(({exerciseId})=>Monthly.matchesTarget(byId(exerciseId),"glutes")));
  const sunday=plan.days.find((day)=>day.weekday==="Sunday");
  assert.equal(sunday.rest,true);
  assert.deepEqual(sunday.exercises,[]);
  assert.equal(plan.days.at(-1).date,"2026-10-07");
});

test("selection is deterministic and respects personal equipment eligibility",()=>{
  const input={
    title:"Bodyweight month",
    startDate:"2026-09-07",
    exercisesPerTarget:2,
    schedule:scheduleWith({Monday:["chest","triceps"],Wednesday:["back","biceps"],Friday:["legs","core"]}),
    exercises,
    preferences:{...preferences,equipment:["Bodyweight"],limitations:[]}
  };
  const first=Monthly.generateMonthPlan(input),second=Monthly.generateMonthPlan(input);
  assert.deepEqual(first,second);
  const selected=first.days.flatMap((day)=>day.exercises);
  assert.ok(selected.length>0);
  assert.ok(selected.every(({exerciseId})=>byId(exerciseId).equipment==="Bodyweight"));
  assert.ok(first.days.every((day)=>new Set(day.exercises.map(({exerciseId})=>exerciseId)).size===day.exercises.length));
});

test("imported weekly exercises and prescriptions repeat exactly on matching weekdays",()=>{
  const weekly=emptyWeeklyPlan();
  weekly.days.Monday.push({instanceId:"weekly-import-1",exerciseId:"flat-dumbbell-press",sets:5,reps:"5–8"});
  const schedule=Monthly.scheduleFromWeeklyPlan(weekly,exercises);
  const plan=Monthly.generateMonthPlan({
    title:"Imported month",
    startDate:"2026-09-07",
    exercisesPerTarget:1,
    schedule,
    exercises,
    preferences
  });
  const mondays=plan.days.filter((day)=>day.weekday==="Monday");
  assert.equal(mondays.length,5);
  for(const day of mondays)assert.deepEqual(day.exercises,[{exerciseId:"flat-dumbbell-press",sets:5,reps:"5–8"}]);
  assert.ok(plan.days.filter((day)=>day.weekday!=="Monday").every((day)=>day.rest&&day.exercises.length===0));
});

test("generator rejects incomplete schedules and plans without recovery",()=>{
  const missing=scheduleWith();delete missing.Friday;
  assert.throws(()=>Monthly.generateMonthPlan({startDate:"2026-09-07",exercisesPerTarget:2,schedule:missing,exercises,preferences}),/Friday/i);
  const noRest=Object.fromEntries(Monthly.DAYS.map((day)=>[day,{rest:false,targets:["chest"],sourceItems:[]} ]));
  assert.throws(()=>Monthly.generateMonthPlan({startDate:"2026-09-07",exercisesPerTarget:1,schedule:noRest,exercises,preferences}),/at least one rest day/i);
  const noTarget=scheduleWith();noTarget.Monday={rest:false,targets:[],sourceItems:[]};
  assert.throws(()=>Monthly.generateMonthPlan({startDate:"2026-09-07",exercisesPerTarget:1,schedule:noTarget,exercises,preferences}),/at least one muscle group/i);
});

test("share text includes dates, rest days, targets, and exercise prescriptions",()=>{
  const plan=Monthly.generateMonthPlan({title:"Saeed's month",startDate:"2026-09-07",exercisesPerTarget:1,schedule:scheduleWith({Monday:["chest","triceps"]}),exercises,preferences});
  const text=Monthly.shareText(plan,exercises);
  assert.match(text,/Saeed's month/);
  assert.match(text,/September 7, 2026 – October 7, 2026/);
  assert.match(text,/Day 01 · Monday/);
  assert.match(text,/Chest \+ Triceps/);
  assert.match(text,/• .+ — \d+ × .+/);
  assert.match(text,/Rest and recovery/);
  assert.match(text,/Created with STRATA/);
});


test("imported exercises cannot bypass current movement constraints or equipment",()=>{
  for(const [exerciseId,target,profile] of [
    ["machine-shoulder-press","shoulders",{...preferences,limitations:["no-overhead"]}],
    ["flat-dumbbell-press","chest",{...preferences,equipment:["Bodyweight"]}]
  ]){
    const schedule=scheduleWith({Monday:[target]});
    schedule.Monday.sourceItems=[{exerciseId,sets:5,reps:"5–8"}];
    assert.throws(()=>Monthly.generateMonthPlan({startDate:"2026-09-07",exercisesPerTarget:1,schedule,exercises,preferences:profile}),/Monday's imported .+ does not match your saved equipment or movement constraints/);
    assert.deepEqual(schedule.Monday.sourceItems,[{exerciseId,sets:5,reps:"5–8"}],"rejected generation preserves the imported draft");
  }
});

test("eligibility failures never silently admit unverified exercises",()=>{
  const broken={...byId("machine-shoulder-press"),metrics:null};
  assert.throws(()=>Monthly.generateMonthPlan({startDate:"2026-09-07",exercisesPerTarget:1,schedule:scheduleWith({Monday:["shoulders"]}),exercises:[broken],preferences}),/Could not verify the saved equipment and movement constraints/);
});
