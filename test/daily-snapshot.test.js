"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {composeSnapshot,snapshotRow}=require("../src/daily-snapshot");

const night={night_date:"2026-09-30",recovery_status:5,ans_charge:4.2,ans_charge_status:4,sleep_charge:3,heart_rate_avg:52,hrv_avg:68,breathing_rate_avg:14,sleep_score:81,asleep_seconds:27000,deep_seconds:5400,rem_seconds:6000,light_seconds:15600,interruption_seconds:900,sleep_start:"2026-09-29T23:00:00",sleep_end:"2026-09-30T07:00:00"};

test("a snapshot carries Polar sleep, recovery, and heart data without inventing missing values",()=>{
  const snapshot=composeSnapshot({date:"2026-09-30",weekStart:"2026-09-28",night,day:{resting_hr:50,min_hr:45,avg_hr:70,max_hr:150}});
  assert.equal(snapshot.sleep.score,81);assert.equal(snapshot.sleep.asleepSeconds,27000);
  assert.equal(snapshot.recovery.status,5);assert.equal(snapshot.recovery.stress,"learning","stress needs usual nights first");
  assert.deepEqual(snapshot.heart,{overnight:52,hrv:68,breathing:14,resting:50,min:45,avg:70,max:150});
  assert.equal(snapshot.activity,null);assert.equal(snapshot.nutrition,null);assert.deepEqual(snapshot.sources,["polar"]);
  const empty=composeSnapshot({date:"2026-09-30",weekStart:"2026-09-28"});
  assert.equal(empty.sleep,null);assert.equal(empty.recovery,null);assert.equal(empty.heart,null);assert.deepEqual(empty.sources,[]);
});

test("training status separates done, extra, planned, not logged, rest, and untracked days",()=>{
  const done={id:"workout:w1",date:"2026-09-28",kind:"workout",source:"manual",status:"completed",title:"Monday",durationSeconds:3600,completedSets:12,planDay:"Monday",device:{cardioLoad:42}};
  assert.equal(composeSnapshot({date:"2026-09-28",weekStart:"2026-09-28",entries:[done]}).training.status,"done");
  assert.equal(composeSnapshot({date:"2026-09-28",weekStart:"2026-09-28",entries:[done]}).training.cardioLoad,42);
  assert.equal(composeSnapshot({date:"2026-09-28",weekStart:"2026-09-28",entries:[{...done,planDay:null}]}).training.status,"extra");
  assert.equal(composeSnapshot({date:"2026-09-30",weekStart:"2026-09-28",entries:[{id:"planned:2026-09-30",date:"2026-09-30",kind:"planned",source:"ai",status:"planned",exerciseCount:4,totalSets:12}]}).training.planned.source,"ai");
  assert.equal(composeSnapshot({date:"2026-09-29",weekStart:"2026-09-28",entries:[{id:"planned:2026-09-29",date:"2026-09-29",kind:"planned",source:"manual",status:"not_logged",exerciseCount:4,totalSets:12}]}).training.status,"not_logged");
  assert.equal(composeSnapshot({date:"2026-09-29",weekStart:"2026-09-28"}).training.status,"rest");
  assert.equal(composeSnapshot({date:"2026-09-20",weekStart:"2026-09-28"}).training.status,"untracked","no stored plan for earlier weeks, so no claim of rest");
  assert.equal(composeSnapshot({date:"2026-09-20",weekStart:"2026-09-28",entries:[{...done,date:"2026-09-20",planDay:null}]}).training.status,"done");
});

test("the nutrition diary feeds the day and stored rows keep the brief separate",()=>{
  const snapshot=composeSnapshot({date:"2026-09-30",weekStart:"2026-09-28",log:{calories:2200,protein_g:150,carbs_g:240,fat_g:70,morning_weight_kg:80.4,intake_complete:1}});
  assert.deepEqual(snapshot.nutrition,{calories:2200,proteinG:150,carbsG:240,fatG:70,morningWeightKg:80.4,complete:true});assert.deepEqual(snapshot.sources,["manual"]);
  const row=snapshotRow({snapshot_json:JSON.stringify(snapshot),brief_json:JSON.stringify({headline:"Train as planned"}),brief_generated_at:5,updated_at:6});
  assert.equal(row.brief.headline,"Train as planned");assert.equal(row.briefGeneratedAt,5);assert.equal(row.nutrition.calories,2200);
  assert.equal(snapshotRow({snapshot_json:"{",brief_json:null}),null);assert.equal(snapshotRow({snapshot_json:"{}",brief_json:"{"}).brief,null);
});
