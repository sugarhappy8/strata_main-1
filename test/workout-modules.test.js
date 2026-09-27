"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const W=require("../public/scripts/workout-core");
const State=require("../public/scripts/workout-state");
const Api=require("../public/scripts/workout-api");
const Calendar=require("../public/scripts/workout-calendar");
const Render=require("../public/scripts/workout-render");
const Context=require("../public/scripts/workout-context");
const Guidance=require("../public/scripts/workout-guidance");
const History=require("../public/scripts/workout-history");
const Events=require("../public/scripts/workout-events");

const ROOT=join(__dirname,"..");
const DAYS=W.DAYS;
const emptyWeek=()=>({version:1,days:Object.fromEntries(DAYS.map((day)=>[day,[]]))});

test("workout state accepts explicit day and start deep links without weakening defaults",()=>{
  assert.equal(State.deepLinkedDay({search:"?day=Thursday",hash:""},W),"Thursday");
  assert.equal(State.deepLinkedDay({search:"?start=Friday",hash:""},W),"Friday");
  assert.equal(State.deepLinkedDay({search:"",hash:"#start=Saturday"},W),"Saturday");
  assert.equal(State.deepLinkedDay({search:"?day=Funday",hash:""},W),W.today());
  const state=State.create(W,{search:"?start=Tuesday",hash:""});
  assert.equal(state.day,"Tuesday");assert.equal(state.workout,null);assert.equal(state.dirty,false);
});

test("workout preferences accept only supported rest durations",()=>{
  assert.deepEqual(State.readPreferences(JSON.stringify({version:1,autoRest:false,restDuration:120})),{autoRest:false,restDuration:120});
  assert.deepEqual(State.readPreferences(JSON.stringify({version:1,autoRest:"yes",restDuration:17})),{});
  assert.deepEqual(JSON.parse(State.writePreferences(true,17)),{version:1,autoRest:true,restDuration:90});
});

test("calendar helper creates a private device calendar file for the next planned day",()=>{
  const plan=emptyWeek();plan.days.Wednesday=[{exerciseId:"press",sets:3},{exerciseId:"row",sets:2}];
  const next=Calendar.nextPlannedSession(plan,DAYS,new Date(2026,8,7,9));
  assert.deepEqual(next,{day:"Wednesday",date:"2026-09-09",movements:2,workingSets:5});
  const event=Calendar.event(next),ics=decodeURIComponent(event.href.split(",").slice(1).join(","));
  assert.equal(event.filename,"strata-2026-09-09-wednesday.ics");
  assert.match(event.href,/^data:text\/calendar;charset=utf-8,/);assert.match(ics,/DTSTART;VALUE=DATE:20260909/);assert.match(ics,/SUMMARY:STRATA · Wednesday workout/);
  assert.equal(Calendar.nextPlannedSession(emptyWeek(),DAYS,new Date(2026,8,7)),null);
});

test("workout renderer keeps the training essentials visible and nests configuration under More",()=>{
  const catalog=[{id:"press",name:"Standing Press",equipment:"Barbell / Smith",reps:"8–12",group:"Shoulders",sub:"Front Delts",score:90,metrics:{stability:8}}];
  const plan=emptyWeek();plan.days.Monday=[{instanceId:"press-one",exerciseId:"press",sets:2,reps:"8–12"}];
  const workout=W.createWorkout(plan,"Monday",catalog,1_780_000_000_000),state={catalog,workout,memoryHistory:[],memoryReady:true,memoryError:""};
  const view=Render.create({state,workout:W,discovery:null}),markup=view.renderEntry(workout.entries[0],0);
  assert.match(markup,/aria-label="Previous performance"/);assert.match(markup,/Complete set/);assert.match(markup,/data-actual="weight"/);assert.match(markup,/data-actual="reps"/);
  assert.match(markup,/<details class="exercise-more"><summary><span>More options<\/span>/);
  assert.ok(markup.indexOf("Complete set")<markup.indexOf("More options"),"set logging must precede configuration");
  for(const advanced of ["data-open-swap","data-format=","data-entry-note","data-calc-warmup"])assert.ok(markup.indexOf(advanced)>markup.indexOf("More options"),`${advanced} should stay inside More options`);
  assert.match(markup,/<details class="set-more">/);assert.match(markup,/Duplicate set/);assert.match(markup,/Remove set/);
});

test("workout API module owns security headers and identity checks",async()=>{
  const calls=[],state={mode:"account",user:{id:"member-1",discovery:{active:true}},csrfToken:"csrf-1"};let identityUpdates=0;
  const fetchImpl=async(path,options)=>{calls.push({path,options});return{ok:true,status:200,json:async()=>path==="/api/me"?{user:{id:"member-1",discovery:{active:true}},csrfToken:"csrf-2"}:{saved:true}};};
  const client=Api.create({state,fetchImpl,onIdentity:()=>identityUpdates++});
  await client.request("/api/workouts",{method:"POST",body:"{}"});
  assert.equal(calls[0].options.headers["X-CSRF-Token"],"csrf-1");assert.equal(calls[0].options.headers["X-Strata-User"],"member-1");
  await client.assertIdentity();assert.equal(state.csrfToken,"csrf-2");assert.equal(identityUpdates,1);
});

test("training guidance keeps labels and explicit targets predictable",()=>{
  assert.equal(Guidance.actionLabel("hold_steady"),"Hold Steady");
  assert.equal(Guidance.actionLabel("reduce-load"),"Reduce Load");
  assert.equal(Guidance.suggestionTarget({target:{weight:42.5,reps:8},unit:"kg"},String),"42.5 kg · 8 reps");
  assert.equal(Guidance.suggestionTarget({target:{}},String),"Keep the current logged target");
  assert.equal(typeof Guidance.create,"function");assert.equal(typeof History.create,"function");
});

test("workout context exposes exactly one truthful action for each plan state",()=>{
  const node=()=>({hidden:false,disabled:false,open:false,dataset:{},innerHTML:"",textContent:"",focus(){this.focused=true;}});
  const render=(overrides={})=>{
    const nodes=Object.fromEntries(["startWorkout","resumeWorkout","chooseScheduledDay","openPlannerFromEmpty","editWorkoutWeek","differentWorkout","planBrief","planPreviewDetails","planDay","planDayField","todayLabel","startTitle","planStatus","planPreview","startHint","trainHistoryNotice","trainHistoryMessage"].map((id)=>[id,node()]));
    const state={plan:emptyWeek(),day:"Sunday",workout:null,recoveries:[],history:[],historyBusy:false,historyLoaded:true,historyLoadError:"",blocked:false,detailBusy:false,catalog:[],...overrides};
    Context.create({$:id=>nodes[id],state,workout:W,view:{planPreview:()=>"preview"},esc:String,openDetail:async()=>{},recover:async()=>{}}).render();
    return nodes;
  };

  const noPlan=render();
  assert.equal(noPlan.planStatus.textContent,"You have not built a weekly plan yet.");
  assert.equal(noPlan.openPlannerFromEmpty.hidden,false);assert.equal(noPlan.startWorkout.hidden,true);assert.equal(noPlan.resumeWorkout.hidden,true);assert.equal(noPlan.chooseScheduledDay.hidden,true);assert.equal(noPlan.differentWorkout.hidden,true);

  const plan=emptyWeek();plan.days.Monday=[{exerciseId:"press",sets:3,reps:"8–12"}];
  const emptyDay=render({plan});
  assert.equal(emptyDay.startTitle.textContent,"Recovery day.");assert.match(emptyDay.chooseScheduledDay.innerHTML,/^Go to Monday /);
  assert.equal(emptyDay.planStatus.textContent,"Nothing is scheduled for this day.");
  assert.equal(emptyDay.editWorkoutWeek.hidden,false);assert.equal(emptyDay.chooseScheduledDay.hidden,false);assert.equal(emptyDay.chooseScheduledDay.dataset.day,"Monday");assert.equal(emptyDay.startWorkout.hidden,true);assert.equal(emptyDay.differentWorkout.hidden,true);

  const scheduled=render({plan,day:"Monday"});
  assert.equal(scheduled.planStatus.textContent,"Scheduled in your weekly plan.");
  assert.equal(scheduled.startWorkout.hidden,false);assert.match(scheduled.startWorkout.innerHTML,/Start workout/);assert.equal(scheduled.differentWorkout.hidden,false);assert.equal(scheduled.resumeWorkout.hidden,true);

  const active={id:"active-1",title:"Monday workout",date:"2026-09-11",status:"active",entries:[]};
  const resumed=render({plan,day:"Monday",workout:active});
  assert.equal(resumed.resumeWorkout.hidden,false);assert.equal(resumed.startWorkout.hidden,true);assert.equal(resumed.chooseScheduledDay.hidden,true);assert.equal(resumed.openPlannerFromEmpty.hidden,true);assert.equal(resumed.differentWorkout.hidden,true);
});

test("workout entry point is a bounded coordinator over dedicated modules",()=>{
  const main=readFileSync(join(ROOT,"public/scripts/workout.js"),"utf8"),html=readFileSync(join(ROOT,"public/pages/workout.html"),"utf8");
  const ordered=["workout-state.js","workout-api.js","workout-calendar.js","workout-render.js","workout-context.js","workout-guidance.js","workout-history.js","workout-events.js","workout.js"];
  assert.ok(main.trimEnd().split("\n").length<=430,`workout.js coordinator is still too large: ${main.trimEnd().split("\n").length} lines`);
  for(const [file,globalName] of [["workout-state.js","StrataWorkoutState"],["workout-api.js","StrataWorkoutApi"],["workout-calendar.js","StrataWorkoutCalendar"],["workout-render.js","StrataWorkoutRender"],["workout-context.js","StrataWorkoutContext"],["workout-guidance.js","StrataWorkoutGuidance"],["workout-history.js","StrataWorkoutHistory"],["workout-events.js","StrataWorkoutEvents"]]){
    const source=readFileSync(join(ROOT,"public/scripts",file),"utf8");assert.ok(Buffer.byteLength(source)<18_000,`${file} should remain focused`);assert.match(source,new RegExp(globalName));
  }
  for(let index=1;index<ordered.length;index++)assert.ok(html.indexOf(`/${ordered[index-1]}`)<html.indexOf(`/${ordered[index]}`),`${ordered[index-1]} must load before ${ordered[index]}`);
  assert.match(main,/S\.create\(W,location\)/);assert.match(main,/A\.create\(/);assert.match(main,/R\.create\(/);assert.match(main,/T\.create\(/);assert.match(main,/Q\.create\(/);assert.match(main,/H\.create\(/);assert.match(main,/E\.bind\(/);assert.equal(typeof Context.create,"function");assert.equal(typeof Events.bind,"function");
});
