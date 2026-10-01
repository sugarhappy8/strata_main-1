"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {composeTrainingLog,matchSessions,mondayOf,sessionOf,summaryOf,weekdayOf}=require("../src/training-log");

const at=(iso)=>Date.parse(iso);
function workout(id,date,start,end,overrides={}){return {id,date,status:"completed",title:`${weekdayOf(date)} session`,startedAt:at(`${date}T${start}:00Z`),completedAt:at(`${date}T${end}:00Z`),elapsedSeconds:(at(`${date}T${end}:00Z`)-at(`${date}T${start}:00Z`))/1000,exerciseCount:4,completedSets:12,totalSets:12,planDay:weekdayOf(date),...overrides};}
function session(externalId,date,start,minutes,sport="Strength training",extra={}){return sessionOf({external_id:externalId,started_at:at(`${date}T${start}:00Z`),local_date:date,duration_seconds:minutes*60,sport,calories:300,hr_avg:120,hr_max:160,cardio_load:42,...extra});}
const plan=(days)=>({version:1,restDay:null,restDays:[],days:Object.fromEntries(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(day=>[day,days[day]||[]]))});

test("a Polar session links to the logged workout it overlaps most, and each side links once",()=>{
  const workouts=[workout("w1","2026-09-28","10:00","11:00"),workout("w2","2026-09-28","18:00","19:00")];
  const sessions=[session("p2","2026-09-28","18:10",40),session("p1","2026-09-28","09:50",60),session("p3","2026-09-28","10:30",20)];
  assert.deepEqual(matchSessions(workouts,sessions).sort((a,b)=>a.externalId.localeCompare(b.externalId)),[
    {provider:"polar",externalId:"p1",workoutId:"w1",method:"time_overlap"},
    {provider:"polar",externalId:"p2",workoutId:"w2",method:"time_overlap"}
  ],"the second overlapping session never double-links the same workout");
});

test("same-day linking needs one gym session and one workout that day, and ignores runs",()=>{
  const workouts=[workout("w1","2026-09-28","10:00","11:00")];
  assert.deepEqual(matchSessions(workouts,[session("gym","2026-09-28","17:00",45)]).map(link=>[link.externalId,link.method]),[["gym","same_day"]]);
  assert.deepEqual(matchSessions(workouts,[session("run","2026-09-28","07:00",30,"Running")]),[],"a morning run is not the evening gym workout");
  assert.deepEqual(matchSessions(workouts,[session("a","2026-09-28","17:00",30),session("b","2026-09-28","19:00",30)]),[],"two candidate sessions are ambiguous");
  assert.deepEqual(matchSessions([{...workouts[0],status:"active"}],[session("gym","2026-09-28","10:10",30)]),[],"an unfinished workout is never linked");
});

test("the Training Log shows a linked session once, tags sources, and lets Polar complete a planned day",()=>{
  const today="2026-10-01",monday=mondayOf(today);assert.equal(monday,"2026-09-28");
  const workouts=[workout("w1","2026-09-28","10:00","11:00")],sessions=[session("p1","2026-09-28","10:05",50),session("p2","2026-09-30","07:00",45),session("run","2026-09-29","07:00",30,"Running")];
  const week=plan({Monday:[{exerciseId:"barbell-back-squat",sets:4,reps:"5–8"}],Wednesday:[{exerciseId:"flat-dumbbell-press",sets:3,reps:"8–12"}],Thursday:[{exerciseId:"barbell-bent-over-row",sets:3,reps:"8–12"}],Friday:[{exerciseId:"pec-deck-fly",sets:2,reps:"10–15"}]});
  const entries=composeTrainingLog({workouts,sessions,links:matchSessions(workouts,sessions),plan:week,planSource:"ai",from:"2026-09-21",to:"2026-10-04",today});
  assert.deepEqual(entries.map(entry=>[entry.date,entry.kind,entry.source,entry.status]),[
    ["2026-09-28","workout","manual","completed"],
    ["2026-09-29","device_session","polar","completed"],
    ["2026-09-30","device_session","polar","completed"],
    ["2026-10-01","planned","ai","planned"],
    ["2026-10-02","planned","ai","planned"]
  ]);
  assert.equal(entries[0].device.externalId,"p1","the matching Polar data rides on the logged workout");assert.equal(entries[0].device.linkMethod,"time_overlap");
  assert.equal(entries[1].planDay,null,"a run on a rest day is extra training, not a planned day");
  assert.equal(entries[2].planDay,"Wednesday","a gym session on a planned day completes it");
  assert.ok(!entries.some(entry=>entry.date<monday&&entry.kind==="planned"),"the current plan is never projected onto earlier weeks");
});

test("a planned day earlier this week with nothing logged reads as not logged",()=>{
  const entries=composeTrainingLog({workouts:[],sessions:[],links:[],plan:plan({Monday:[{exerciseId:"barbell-back-squat",sets:4,reps:"5–8"}]}),from:"2026-09-28",to:"2026-09-28",today:"2026-10-01"});
  assert.deepEqual(entries.map(entry=>[entry.kind,entry.status,entry.source,entry.totalSets]),[["planned","not_logged","manual",4]]);
});

test("stored summaries and sessions that cannot be read safely are skipped",()=>{
  assert.equal(summaryOf({summary_json:"{"}),null);assert.equal(summaryOf({summary_json:JSON.stringify({id:"w",date:"2026-02-30",status:"completed"})}),null);
  assert.equal(summaryOf({summary_json:JSON.stringify({id:"w",date:"2026-09-28",status:"draft"})}),null);
  assert.equal(sessionOf({external_id:"",started_at:1,local_date:"2026-09-28"}),null);assert.equal(sessionOf({external_id:"x",started_at:null,local_date:"2026-09-28"}),null);
});
