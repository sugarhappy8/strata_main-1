"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DAYS}=require("../src/plans");
const {sanitizeCoachingProfile}=require("../src/coaching-core");
const {candidateExercises}=require("../src/ai-catalog");
const core=require("../src/ai-core");

const emptyDays=()=>Object.fromEntries(DAYS.map((day)=>[day,[]]));
const plan=(days)=>({version:1,restDay:"Sunday",restDays:["Sunday"],days:{...emptyDays(),...days}});
const item=(instanceId,exerciseId,sets=3,reps="8–12")=>({instanceId,exerciseId,sets,reps});
const savedProfile=(overrides={})=>({...sanitizeCoachingProfile({version:4,measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",experience:"intermediate",dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,usualExercises:[],availableEquipment:[],movementLimitations:[],caloriePattern:"steady",flexibleDay:null,macroPreference:null,timeZone:"UTC",mealPreferences:null,...overrides}),revision:3,updatedAt:1});
const candidates=candidateExercises();
const code=(id)=>candidates.find((entry)=>entry.id===id)?.code;
const interpret=(data,options={})=>core.interpretReply(data,{candidates,plan:plan({}),...options});

test("rep targets are normalized, and anything else falls back to the library's typical range",()=>{
  assert.equal(core.repsText("8-12","x"),"8–12");assert.equal(core.repsText("8 to 12","x"),"8–12");
  assert.equal(core.repsText("30-45 s","x"),"30–45 s");assert.equal(core.repsText("10 per side","x"),"10 / side");
  assert.equal(core.repsText("12","x"),"12");
  for(const invalid of ["12-8","0","101","ten","8-12 reps please",null])assert.equal(core.repsText(invalid,"fallback"),"fallback");
  assert.equal(core.estimatedMinutes(0),0);assert.equal(core.estimatedMinutes(16),45);
});

test("a saved plan is summarized by name, training days, and a typical session length",()=>{
  const saved=plan({Monday:[item("aaaaaa1","flat-dumbbell-press",4),item("aaaaaa2","hack-squat",4),item("aaaaaa3","not-a-real-exercise")],Thursday:[item("bbbbbb1","chest-supported-row",4),item("bbbbbb2","hack-squat",4)]});
  const rows=core.planItems(saved);
  assert.deepEqual(rows.map((row)=>`${row.day}:${row.name}`),["Monday:Flat Dumbbell Press","Monday:Hack Squat","Thursday:Chest-supported Row","Thursday:Hack Squat"]);
  assert.deepEqual(core.planSchedule(saved),{workoutDays:["Monday","Thursday"],sessionMinutes:30});
  assert.equal(core.planSchedule(plan({})),null);assert.equal(core.planSchedule(null),null);
  assert.deepEqual(core.planItems(undefined),[]);
});

test("the model sees a factual member summary without identity details",()=>{
  const text=core.memberContext({profile:savedProfile({availableEquipment:["Dumbbells"],movementLimitations:["no-overhead"],macroPreference:"higher_protein",goal:"fat_loss"}),plan:plan({Tuesday:[item("aaaaaa1","flat-dumbbell-press")]}),workouts:[{status:"completed"},{status:"active"}],nutrition:{averageTarget:2200,loggedDays:5,averageIntake:2150,weeklyWeightChangeKg:-0.4},today:"Wednesday"});
  assert.match(text,/Today is Wednesday\./);assert.match(text,/intermediate lifter/);assert.match(text,/fat loss \(moderate pace\)/);assert.match(text,/macros higher protein/);
  assert.match(text,/Equipment: Dumbbells\. Movement limits: no-overhead\./);assert.match(text,/Tuesday: Flat Dumbbell Press 3x8–12/);
  assert.match(text,/Completed workouts in the last 28 days: 1\./);assert.match(text,/average target 2200 kcal\/day; 5 of the last 7 days logged, averaging 2150 kcal; morning weight changing -0.4 kg per week/);
  const blank=core.memberContext({});
  assert.match(blank,/No personal setup yet/);assert.match(blank,/Saved weekly plan: empty\./);assert.match(blank,/No completed workouts/);
  assert.doesNotMatch(blank,/Today is/);
});

test("conversation history is checked, trimmed, and always starts with the member",()=>{
  assert.deepEqual(core.sanitizeHistory(undefined),[]);
  assert.deepEqual(core.sanitizeHistory([{role:"assistant",content:"hello"},{role:"user",content:" first​\nline "},{role:"user",content:"duplicate"},{role:"assistant",content:"answer"},{role:"user",content:"dangling"}]),[{role:"user",content:"first line"},{role:"assistant",content:"answer"}]);
  for(const invalid of ["text",[{role:"system",content:"x"}],[{role:"user",content:""}],[null],[["user"]],Array.from({length:13},()=>({role:"user",content:"x"}))])assert.throws(()=>core.sanitizeHistory(invalid),{code:"AI_INVALID_REQUEST",status:400});
  assert.equal(core.requestText({kind:"suggestions",message:"ignored"}),"");
  assert.equal(core.requestText({kind:"chat",message:"now",history:[{role:"user",content:"one"},{role:"assistant",content:"a"},{role:"user",content:"two"},{role:"assistant",content:"b"},{role:"user",content:"three"}]}),"two \n three \n now");
});

test("prompts stay within a small model's context without losing named exercises",()=>{
  const small=core.promptMessages({kind:"chat",message:"Plan my week",context:"Member facts",candidates:candidates.slice(0,3),note:"A note"});
  assert.equal(small.length,2);assert.equal(small[0].role,"system");assert.match(small[0].content,/Member data:\nMember facts/);assert.match(small[0].content,/CH1 Incline Smith Press/);assert.match(small[0].content,/A note$/);
  assert.equal(small[1].content,"Plan my week");
  assert.match(core.promptMessages({kind:"suggestions",context:"",candidates:[]}).at(-1).content,/up to 3 specific suggestions/);
  const long="x".repeat(1200),history=Array.from({length:12},(_,index)=>({role:index%2?"assistant":"user",content:long}));
  const big=candidateExercises({request:"focus on everything: chest back shoulders arms legs glutes calves core",perGroup:12}),keep=new Set([big.find((entry)=>entry.group==="core"&&entry.code.endsWith("12"))?.id].filter(Boolean));
  const trimmed=core.promptMessages({kind:"chat",message:"Plan",history,context:"c",candidates:big,keep});
  const size=trimmed.reduce((sum,message)=>sum+message.content.length,0);
  assert.ok(trimmed.length<history.length+2,"older turns are dropped first");
  assert.ok(size<=core.LIMITS.promptChars||trimmed.length===2,"the prompt fits, or only the essentials remain");
  for(const id of keep)assert.ok(trimmed[0].content.includes(big.find((entry)=>entry.id===id).name),"kept exercises are never trimmed");
});

test("a proposed week keeps only real, allowed exercises within STRATA's limits",()=>{
  const reply=interpret({reply:"Here you go.",week:{title:"",focus:"power",sessionMinutes:50,days:[
    {day:"mon",name:"Upper",exercises:[{code:code("flat-dumbbell-press").toLowerCase(),sets:9,reps:"8-12"},{code:code("flat-dumbbell-press"),sets:3},{name:"Nordic Hamstring Curl",sets:0,reps:"nonsense"},{code:"ZZ9"},{name:"Imaginary Press"},{name:code("hack-squat"),sets:2}]},
    {day:"Monday",name:"Duplicate day",exercises:[{code:"CH1"},{code:"BK1"}]},
    {day:"Wednesday",name:"Too little",exercises:[{code:"CH1"}]},
    {day:"Friday",name:"Too much",exercises:Array.from({length:8},(_,index)=>({code:candidates[index].code,sets:6}))},
    {day:"Funday",exercises:[{code:"CH1"},{code:"BK1"}]}
  ]}});
  const week=reply.week;
  assert.ok(week,"the valid day still makes a week");
  assert.equal(week.title,"Your Strata AI week");assert.equal(week.focus,"balanced");assert.equal(week.averageMinutes,28);assert.equal(week.sessionMinutes,30,"session length comes from STRATA's estimate, never the model's claim");
  assert.deepEqual(week.trainingDays,["Monday"]);assert.equal(week.restDays.length,6);assert.equal(week.plan.restDay,"Tuesday");
  assert.deepEqual(week.days[0].exercises.map((entry)=>[entry.exerciseId,entry.sets,entry.reps]),[["flat-dumbbell-press",6,"8–12"],["nordic-hamstring-curl",1,"3–8"],["hack-squat",2,"6–12"]],"a code written as a name still resolves");
  assert.equal(week.workingSets,9);assert.equal(week.days[0].minutes,core.estimatedMinutes(9));
  assert.deepEqual(week.notes.sort(),["A day that did not meet STRATA's limits was left out.","Exercises STRATA does not list, or that your movement limits exclude, were left out."]);
  const limited=interpret({reply:"ok",week:{days:[{day:"Tuesday",exercises:[{name:"Nordic Hamstring Curl"},{code:"CH1"},{code:"BK1"}]}]}},{limitations:["no-floor"]});
  assert.deepEqual(limited.week.days[0].exercises.map((entry)=>entry.exerciseId),[candidates[0].id,candidates.find((entry)=>entry.code==="BK1").id],"movement limits apply to exercises named outside the shortlist");
});

test("the compact [code, sets, reps] form is read like the object form",()=>{
  const {week}=interpret({reply:"Compact.",week:{title:"Compact week",days:[{day:"Tuesday",name:"Push",exercises:[[code("flat-dumbbell-press"),4,"6-10"],["Nordic Hamstring Curl",3,"3-8"],["ZZ9",3,"8-12"],"not an exercise",[code("flat-dumbbell-press"),2,"8"]]}]}});
  assert.deepEqual(week.days[0].exercises.map((entry)=>[entry.exerciseId,entry.sets,entry.reps]),[["flat-dumbbell-press",4,"6–10"],["nordic-hamstring-curl",3,"3–8"]]);
  assert.deepEqual(week.notes,["Exercises STRATA does not list, or that your movement limits exclude, were left out."]);
  assert.match(core.promptMessages({kind:"chat",message:"x",context:"",candidates:[]})[0].content,/Each exercise is \[code, sets, reps\]/);
});

test("weeks that cannot pass, bad replies, and search requests are handled explicitly",()=>{
  const allDays=interpret({reply:"Seven days",week:{days:DAYS.map((day)=>({day,exercises:[{code:"CH1"},{code:"BK1"}]}))}});
  assert.equal(allDays.week,null);assert.match(allDays.weekIssue,/did not pass STRATA's checks/);
  assert.match(interpret({reply:"Odd",week:{days:"Monday"}}).weekIssue,/could not read/);
  for(const bad of [null,[],"text",{reply:""},{reply:"   "}])assert.throws(()=>core.interpretReply(bad,{candidates,plan:null}),{code:"AI_BAD_OUTPUT"});
  const trimmed=interpret({reply:"x".repeat(2000)});assert.equal(trimmed.reply.length,core.LIMITS.replyChars);
  assert.deepEqual(core.searchTerms({reply:"Searching",search:[" landmine press ","",42,"a","b","c","d","e","f"]}),["landmine press","42","a","b","c","d"]);
  assert.deepEqual(core.searchTerms({reply:"x",week:{days:[]},search:["ignored"]}),[]);assert.deepEqual(core.searchTerms(null),[]);
  assert.deepEqual(core.searchTerms({search:"not a list"}),[]);
});

test("nutrition proposals are limited to STRATA's own choices",()=>{
  assert.deepEqual(interpret({reply:"ok",nutrition:{goal:"fat_loss",pace:"gentle",pattern:"flexible_day",flexibleDay:"sun",macros:"higher_protein"}}).nutrition,{goal:"fat_loss",goalPace:"gentle",caloriePattern:"flexible_day",flexibleDay:"Sunday",macroPreference:"higher_protein"});
  assert.deepEqual(interpret({reply:"ok",nutrition:{goal:"muscle_gain",pattern:"flexible_day"}}).nutrition,{goal:"muscle_gain",goalPace:"moderate",caloriePattern:"flexible_day",flexibleDay:"Saturday",macroPreference:null});
  assert.deepEqual(interpret({reply:"ok",nutrition:{goal:"maintenance",pattern:"keto",flexibleDay:"Monday",macros:"carnivore"}}).nutrition,{goal:"maintenance",goalPace:"moderate",caloriePattern:"steady",flexibleDay:null,macroPreference:null});
  assert.equal(interpret({reply:"ok",nutrition:{goal:"bulk",calories:5000}}).nutrition,null);
  assert.equal(interpret({reply:"ok",nutrition:"eat more"}).nutrition,null);
});

test("suggested swaps only touch exercises that are in the saved plan",()=>{
  const saved=plan({Monday:[item("aaaaaa1","flat-dumbbell-press"),item("aaaaaa2","hack-squat")],Thursday:[item("bbbbbb1","flat-dumbbell-press")]});
  const {suggestions}=interpret({reply:"Tips",suggestions:[
    {text:"Swap the press on Thursday.",swap:{day:"Thursday",from:"flat dumbbell presses",to:code("incline-machine-chest-press")}},
    "Sleep a little more before heavy days.",
    {text:"Swap to an exercise already on that day.",swap:{day:"Monday",from:"Flat Dumbbell Press",to:"Hack Squat"}},
    {text:"Too many tips."}
  ]},{plan:saved});
  assert.equal(suggestions.length,3);
  assert.deepEqual(suggestions[0].action,{type:"swap",day:"Thursday",instanceId:"bbbbbb1",fromExerciseId:"flat-dumbbell-press",fromName:"Flat Dumbbell Press",toExerciseId:"incline-machine-chest-press",toName:"Incline Machine Chest Press",toReps:"6–12"});
  assert.deepEqual(suggestions[1],{id:"s2",text:"Sleep a little more before heavy days.",action:null});
  assert.equal(suggestions[2].action,null,"a swap that would duplicate an exercise on the same day is not offered");
  const {suggestions:others}=interpret({reply:"Tips",suggestions:[{text:"Not in plan",swap:{from:"Barbell Hip Thrust",to:"CH1"}},{text:"Unknown target",swap:{from:"Hack Squat",to:"Imaginary"}},{text:""},{swap:{from:"Hack Squat",to:"CH1"}}]},{plan:saved});
  assert.deepEqual(others.map((entry)=>entry.action),[null,null]);
  assert.deepEqual(interpret({reply:"No tips",suggestions:"none"}).suggestions,[]);
});

test("nutrition previews use STRATA's calculator and follow the planned training days",()=>{
  const profile=savedProfile({workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60});
  const planned=plan({Tuesday:[item("aaaaaa1","flat-dumbbell-press",4),item("aaaaaa2","hack-squat",4),item("aaaaaa3","chest-supported-row",4),item("aaaaaa4","romanian-deadlift",4)],Saturday:[item("bbbbbb1","hack-squat",4),item("bbbbbb2","flat-dumbbell-press",4),item("bbbbbb3","chest-supported-row",4),item("bbbbbb4","romanian-deadlift",4)]});
  const changes={goal:"fat_loss",goalPace:"gentle",caloriePattern:"zigzag",flexibleDay:null,macroPreference:"higher_protein"};
  const result=core.previewNutrition({profile,changes,plan:planned,evidence:null,timestamp:Date.UTC(2026,8,23,12)});
  assert.deepEqual(result.alignment,{workoutDays:["Tuesday","Saturday"],sessionMinutes:45});
  assert.equal(result.expectedRevision,3);assert.equal(result.profile.goal,"fat_loss");assert.deepEqual(result.profile.workoutDays,["Tuesday","Saturday"]);
  assert.equal(Object.hasOwn(result.profile,"revision"),false);assert.equal(Object.hasOwn(result.profile,"sessionsPerWeek"),false);
  assert.equal(result.preview.selectedGoal,"fat_loss");assert.equal(result.preview.dailyTargets.length,7);
  const training=result.preview.dailyTargets.filter((target)=>target.kind==="higher_training_day");
  assert.deepEqual(training.map((target)=>target.day),["Tuesday","Saturday"],"higher-calorie days land on the planned training days");
  assert.ok(result.preview.maintenance.targetKcal>0);
  const unchanged=core.previewNutrition({profile,changes,plan:plan({}),evidence:null,timestamp:Date.UTC(2026,8,23,12)});
  assert.equal(unchanged.alignment,null,"an empty plan keeps the setup's own schedule");assert.deepEqual(unchanged.profile.workoutDays,["Monday","Wednesday","Friday"]);
});
