"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Diary=require("../public/scripts/personal-training-diary-ui"),Ui=require("../public/scripts/personal-training-ui-core"),{createRenderer,projectionSvg}=require("../public/scripts/discover-coaching-render"),{createController}=require("../public/scripts/discover-coaching"),{assertAccountResponse}=require("../public/scripts/discover-api");
const week={weekStart:"2026-09-14",weekEnd:"2026-09-20",diaryStartDate:"2026-08-05",diaryEndDate:"2026-09-16",logTargets:[{date:"2026-09-07",day:"Monday",calories:null},{date:"2026-09-15",day:"Tuesday",calories:2100,kind:"daily"},{date:"2026-09-16",day:"Wednesday",calories:2200,kind:"daily"}],nutrition:{dailyTargets:[{date:"2026-09-16",day:"Wednesday",calories:2200}]}};
function elements(){const nodes=new Map();return id=>{if(!nodes.has(id))nodes.set(id,{id,value:"",textContent:"",innerHTML:"",checked:false,hidden:false,disabled:false,dataset:{},listeners:{},attributes:{},children:[],addEventListener(type,handler){this.listeners[type]=handler;},setAttribute(name,value){this.attributes[name]=value;},getAttribute(name){return this.attributes[name]||null;},removeAttribute(name){delete this.attributes[name];},focus(){},reset(){},querySelector(){return null;}});return nodes.get(id);};}
function controllerFixture(api){
  const el=elements(),state={user:{id:"member"},csrfToken:"csrf",exercises:[],preferences:{}},rendered=[],synced=[],shown=[],document={querySelectorAll:()=>[],querySelector:()=>null},renderer={renderDashboard(...args){rendered.push(args);shown.push("dashboard");},clearPrivate(){},show(value){shown.push(value);},showProgressSetup(){},renderLog(){}};
  const controller=createController({document,element:el,api,state,ui:Ui,diaryUi:Diary,meals:{sync(value){synced.push(value);},clearPrivate(){},fillPreferences(){}},assertAccountResponse,renderFactory:()=>renderer,saveRetryMessage:error=>error.message,showToast(){}});
  Object.assign(controller.state,{profile:{macroPreference:null,measurementSystem:"metric"},week,logs:[{date:"2026-09-07",calories:1500,proteinG:100,carbsG:180,fatG:50,revision:4}]});
  el("coachingLogDate").value="2026-09-07";el("coachingCaloriesEaten").value="1800";el("coachingMorningWeight").value="80";el("coachingDayComplete").checked=true;
  return{el,state,controller,rendered,synced,shown,save:()=>el("coachingLogForm").listeners.submit({currentTarget:{id:"coachingLogForm"},preventDefault(){}})};
}

test("historical target lookup never substitutes this week's calories for a missing saved target",()=>{
  assert.equal(Diary.context(week,[],"2026-09-07").target,null);assert.equal(Diary.context(week,[],"2026-09-15").target.calories,2100);assert.equal(Diary.context(week,[],"2026-09-17"),null);
  assert.equal(Diary.selectedDate(week,"2026-09-07","2026-09-16"),"2026-09-07");assert.equal(Diary.selectedDate(week,"2026-09-17","2026-09-16"),"2026-09-16");assert.deepEqual(Diary.targetsFor({logTargets:[{date:"2026-99-99"},{date:"2026-02-30"}]}),[]);
});

test("historical diary renders intake without inventing a remaining target",()=>{
  const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary});render.renderLog({macroPreference:null,measurementSystem:"imperial"},week,[{date:"2026-09-07",calories:1800,morningWeightKg:300,complete:true}],"2026-09-07");
  for(const prefix of ["coaching","progressCoaching"]){const summary=el(prefix==="coaching"?"coachingProgressSummary":"progressCoachingSummary").innerHTML;assert.match(summary,/1,800 kcal/);assert.match(summary,/No target was saved/);assert.doesNotMatch(summary,/2,200|400 kcal/);assert.equal(el(`${prefix}LogDate`).value,"2026-09-07");assert.equal(el(`${prefix}MorningWeight`).value,661.4);assert.equal(el(`${prefix}MorningWeight`).max,"661.4");}
});

test("a historical save uses the original revision and omits hidden macros",async()=>{
  let payload;const fixture=controllerFixture(async(_url,options)=>{payload=JSON.parse(options.body);return{csrfToken:"csrf",log:{date:"2026-09-07",...payload.log,proteinG:100,carbsG:180,fatG:50,revision:5}};});await fixture.save();
  assert.equal(payload.expectedRevision,4);assert.equal(payload.expectedUserId,"member");assert.deepEqual(payload.log,{calories:1800,morningWeightKg:80,complete:true});assert.equal(fixture.controller.state.logs[0].proteinG,100);assert.equal(fixture.rendered[0][3],"2026-09-07");
});

test("a delayed save preserves a changed date and newer draft values",async()=>{
  let resolveResponse;const pending=new Promise(resolve=>{resolveResponse=resolve;}),fixture=controllerFixture(()=>pending),saving=fixture.save();fixture.el("coachingLogDate").value="2026-09-16";fixture.el("coachingCaloriesEaten").value="975";
  resolveResponse({csrfToken:"csrf",log:{date:"2026-09-07",calories:1800,morningWeightKg:80,complete:true,revision:5}});await saving;
  assert.equal(fixture.rendered.length,0);assert.equal(fixture.el("coachingLogDate").value,"2026-09-16");assert.equal(fixture.el("coachingCaloriesEaten").value,"975");assert.equal(fixture.synced.at(-1).date,"2026-09-16");assert.match(fixture.el("coachingLogStatus").textContent,/newer entries.*not saved/i);
});

test("a delayed coaching write cannot repopulate a reset account view",async()=>{
  let resolveResponse;const pending=new Promise(resolve=>{resolveResponse=resolve;}),fixture=controllerFixture(()=>pending),saving=fixture.save();fixture.controller.reset();resolveResponse({csrfToken:"csrf",log:{date:"2026-09-07",calories:1800,revision:5}});await saving;
  assert.deepEqual(fixture.controller.state.logs,[]);assert.equal(fixture.rendered.length,0);assert.equal(fixture.synced.length,0);
});

test("weight scenarios begin at their dated engine weight basis",()=>{
  const markup=projectionSvg({weightKg:100},[{weeks:4,startWeightKg:80,weightKg:79,rangeKg:[77,83]}],kg=>`${kg} kg`);
  assert.match(markup,/Start/);assert.match(markup,/77 kg–83 kg/);assert.doesNotMatch(markup,/100 kg/);
});


test("a delayed conflict cannot restore an earlier account's diary after reset",async()=>{
  let rejectResponse;const pending=new Promise((_resolve,reject)=>{rejectResponse=reject;}),fixture=controllerFixture(()=>pending),saving=fixture.save();fixture.controller.reset();rejectResponse(Object.assign(new Error("Changed"),{code:"COACHING_LOG_CHANGED",payload:{log:{date:"2026-09-07",calories:1900,revision:6}}}));await saving;
  assert.deepEqual(fixture.controller.state.logs,[]);assert.equal(fixture.el("coachingSaveLog").disabled,false);assert.equal(fixture.rendered.length,0);
});

test("switching the maximum body weight back to metric retains a valid endpoint",()=>{
  const fixture=controllerFixture(async()=>({}));fixture.el("coachingWeight").value="661.4";fixture.el("coachingWeight").dataset.unit="lb";fixture.el("coachingWeightUnit").value="kg";fixture.el("coachingWeightUnit").listeners.change();assert.equal(fixture.el("coachingWeight").value,300);assert.equal(fixture.el("coachingWeight").max,"300");
});

test("an existing version 3 profile opens explicit movement review and can discard to its saved week",async()=>{
  const profile={version:3,measurementSystem:"metric",preferredLoadUnit:"kg",age:31,heightCm:178,weightKg:82,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"gentle",trainingGoal:"balanced",experience:"intermediate",lifestyleActivity:"very_active",sessionsPerWeek:3,workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:45,usualExercises:[],caloriePattern:"steady",flexibleDay:null,macroPreference:null};
  const fixture=controllerFixture(async url=>url==="/api/coaching/profile"?{csrfToken:"csrf",profile}:{csrfToken:"csrf",week,logs:[]});
  await fixture.controller.load();
  assert.equal(fixture.shown.at(-1),"setup");assert.equal(fixture.el("coachingDailyMovement").value,"");assert.equal(fixture.el("coachingAdditionalActivityMinutes").value,"0");assert.equal(fixture.el("coachingAdditionalActivityIntensity").value,"moderate");
  assert.equal(fixture.el("coachingActivityReviewNotice").hidden,false);assert.match(fixture.el("coachingActivityReviewNotice").textContent,/saved profile, week, and diary are unchanged.*Normal day outside planned exercise.*Separate planned activity each week/is);assert.match(fixture.el("coachingSaveStatus").textContent,/Two new activity answers are required/);
  fixture.el("coachingDiscardProfile").listeners.click();assert.equal(fixture.shown.at(-1),"dashboard");
});

test("a version 3 deficit keeps its percentage policy instead of displaying null fields as zero",()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary}),profile={version:3,measurementSystem:"metric",preferredLoadUnit:"kg",weightKg:82,experience:"intermediate",sessionMinutes:45,sessionsPerWeek:1,lifestyleActivity:"sedentary",usualExercises:[],trainingGoal:"balanced",goalPace:"gentle"};
    const model={...week,modelUpdateAvailable:true,nextWeekStart:"2026-09-21",training:{sessions:[]},nutrition:{...week.nutrition,rmrKcal:1650,selectedGoal:"fat_loss",goalPace:"gentle",weeklyTargetKcal:14_000,maintenance:{targetKcal:2250},deficit:{targetKcal:2000,policy:"10% below estimated maintenance",breakdown:{requestedWeightChangePercentPerWeek:null,actualWeightChangePercentPerWeek:null,actualDeficitKcal:250}},bulk:{targetKcal:2400,policy:"Conservative surplus"},weightScenarios:[]}};
    render.renderDashboard(profile,model,[],"2026-09-16");assert.match(el("coachingTargetDetail").textContent,/10% below estimated maintenance/);assert.doesNotMatch(el("coachingTargetDetail").textContent,/0% body weight/);assert.match(el("coachingModelUpdate").textContent,/keep their existing calculation.*opt in/is);assert.doesNotMatch(el("coachingModelUpdate").textContent,/next weekly snapshot uses the new method/i);
    for(const maintenance of [2250,{baselineKcal:2250},{targetKcal:2250,baselineKcal:2500,estimateRangeKcal:[1900,2800]}]){
      render.renderDashboard(profile,{...model,nutrition:{...model.nutrition,maintenance}},[],"2026-09-16");
      assert.equal(el("coachingTdee").textContent,"2,250 kcal/day");
      assert.match(el("coachingGoalComparison").innerHTML,/<span>Maintenance<\/span><strong>2,250 kcal\/day<\/strong>/);
    }
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test("version 4 dashboard explains each separate activity input and the bounded deficit",()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary}),profile={version:4,measurementSystem:"metric",preferredLoadUnit:"kg",weightKg:82,experience:"intermediate",sessionMinutes:45,sessionsPerWeek:1,dailyMovement:"on_feet",additionalActivityMinutesPerWeek:180,additionalActivityIntensity:"vigorous",usualExercises:[{exerciseId:"squat"}],trainingGoal:"balanced",goalPace:"moderate",caloriePattern:"steady",flexibleDay:null,macroPreference:null};
    const model={...week,training:{sessions:[{day:"Tuesday",label:"Full body",workingSets:6,estimatedDurationMinutes:40,exercises:[{name:"Squat",sets:3,reps:"6–8",rest:"120 sec"}]}]},nutrition:{rmrKcal:1700,primaryEquation:"mifflin_structured_activity",selectedGoal:"fat_loss",goalPace:"moderate",weeklyTargetKcal:13_300,dailyTargets:week.nutrition.dailyTargets,maintenance:{targetKcal:2300,estimateRangeKcal:[2000,2600]},activityBreakdown:{nonWorkoutKcal:2200,plannedTrainingWeekKcal:160,additionalActivityWeekKcal:300,sessions:[{day:"Tuesday",minutes:40,kcal:160}]},wholeDayEerCrossCheck:{targetKcal:2500,activityCategory:"low_active"},deficit:{targetKcal:1900,breakdown:{requestedWeightChangePercentPerWeek:.5,actualDeficitKcal:400,energyAvailabilityFloorKcal:1800,energyAvailabilityGuardApplied:true,compositionDifferenceKcal:425,compositionRangeExpanded:true,scenarioGuardApplied:false}},bulk:{targetKcal:2450,policy:"Conservative surplus"},weightScenarios:[]}};
    render.renderDashboard(profile,model,[],"2026-09-16");
    assert.match(el("coachingWeekExplanation").textContent,/on your feet.*1 generated STRATA session \(40 min\).*180 min of vigorous other activity.*1 known exercise/);
    assert.match(el("coachingTdeeDetail").textContent,/ordinary daily movement: about 2,200 kcal\/day.*generated sessions: about 160 kcal\/week.*other activity: about 300 kcal\/week.*Population EER cross-check: about 2,500 kcal\/day \(low active\); context only, not an override/);
    assert.match(el("coachingTargetDetail").textContent,/0\.5% body weight\/week requested.*400 kcal\/day actual deficit.*composition floor about 1,800 kcal\/day applied/);
    assert.match(el("coachingTargetDetail").textContent,/resting cross-check differs by about 425 kcal and widens the planning range.*lower sensitivity scenario stays within planner limits/);
    assert.match(el("coachingGoalComparison").innerHTML,/0\.5% body weight\/week requested/);
    assert.equal(el("coachingTdee").textContent,"2,300 kcal/day");
    assert.match(el("coachingTdeeDetail").textContent,/Planning range: 2,000–2,600 kcal\/day.*Not a measured value or a confidence interval/);
    assert.equal(el("coachingTarget").textContent,"2,200 kcal/day");
    assert.equal(el("coachingWeeklyCalories").textContent,"13,300 kcal/week");
    const comparison=el("coachingGoalComparison").innerHTML;
    for(const [label,calories] of [["Deficit","1,900"],["Maintenance","2,300"],["Surplus","2,450"]])assert.ok(comparison.includes(`<span>${label}</span><strong>${calories} kcal/day</strong>`));
    assert.doesNotMatch(comparison,/<strong>about|<strong>.*–/);
    assert.doesNotMatch(el("coachingCalorieWeek").innerHTML,/<strong>about/);
    render.renderDashboard(profile,{...model,nutrition:{...model.nutrition,dailyTargets:[{day:"Tuesday",date:"2026-09-15",calories:2050},{day:"Wednesday",date:"2026-09-16",calories:2300}]}},[],"2026-09-16");
    assert.equal(el("coachingTarget").textContent,"2,050–2,300 kcal/day");
    assert.match(el("coachingTargetDetail").textContent,/Scheduled daily targets; the weekly total is preserved/);
    assert.equal(el("coachingTdee").textContent,"2,300 kcal/day","a varying daily schedule must not replace maintenance with a range");
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test("maintenance explains the movement multiplier separately from net exercise",()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary}),profile={version:4,measurementSystem:"metric",weightKg:75,experience:"intermediate",dailyMovement:"lightly_moving",additionalActivityMinutesPerWeek:0,sessionsPerWeek:3,usualExercises:[]};
    const model={...week,nutrition:{...week.nutrition,rmrKcal:1770,selectedGoal:"maintenance",maintenance:{targetKcal:2725},activityBreakdown:{movementPal:1.5,nonWorkoutKcal:2655,plannedTrainingWeekKcal:490,additionalActivityWeekKcal:0,sessions:[]}}};
    render.renderDashboard(profile,model,[],"2026-09-16");
    assert.equal(el("coachingTdee").textContent,"2,725 kcal/day");
    assert.match(el("coachingTdeeDetail").textContent,/Resting plus ordinary daily movement: about 2,655 kcal\/day \(resting 1,770 × 1\.50 movement factor; an activity assumption, not a measurement\)/);
    assert.match(el("coachingTdeeDetail").textContent,/generated sessions: about 490 kcal\/week · other activity: about 0 kcal\/week\. Exercise totals exclude resting energy/);
    for(const [rmrKcal,movementPal] of [[1770,undefined],[1770,null],[1770,0],[1770,Infinity],[null,1.5],[0,1.5],[NaN,1.5]]){
      render.renderDashboard(profile,{...model,nutrition:{...model.nutrition,rmrKcal,activityBreakdown:{...model.nutrition.activityBreakdown,movementPal}}},[],"2026-09-16");
      assert.doesNotMatch(el("coachingTdeeDetail").textContent,/×|movement factor/);
    }
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});

test("dashboard shows aligned evidence and exercise-specific units without inventing timed repetitions",()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary}),profile={version:3,measurementSystem:"metric",preferredLoadUnit:"lb",weightKg:82,experience:"intermediate",sessionMinutes:45,sessionsPerWeek:1,lifestyleActivity:"moderately_active",usualExercises:[],trainingGoal:"strength"};
    const model={...week,modelUpdateAvailable:true,nextWeekStart:"2026-09-21",training:{sessions:[{day:"Wednesday",label:"Full body",workingSets:3,estimatedDurationMinutes:12,exercises:[{name:"Plank",sets:3,reps:"20–30 s",rest:"75 sec",measurement:"timed",loadType:"bodyweight",unit:"kg",enteredCapability:{maxSets:3,maxReps:12,maxWeightKg:null},performance:{sourceDate:"2026-09-12",status:"repeat"},targetSets:[{seconds:25,reps:null,weight:null}]}]}]},nutrition:{...week.nutrition,weightBasis:{weightKg:80,date:"2026-09-13",source:"recent_morning_weights"},maintenance:{targetKcal:2300,calibration:{status:"trend_informed",windowStart:"2026-08-03",windowEnd:"2026-09-13",evidence:{completeCalorieDays:20,alignedIntakeDays:18,morningWeightDays:9,weightObservationSpanDays:18},interval:{start:"2026-08-24",lastIntakeDate:"2026-09-10",end:"2026-09-11"},quality:{label:"usable"},sensitivity:{rangeKcal:[2000,2600],basis:"Not a confidence interval."}}},weightScenarios:[{weeks:4,startWeightKg:80,weightKg:79,rangeKg:[77,83],includesGainAndLoss:true,caveat:"Scenario envelope, not a prediction interval."}]}};
    render.renderDashboard(profile,model,[],"2026-09-16");assert.match(el("coachingWeekGrid").innerHTML,/3 working sets · about 12 minutes/);assert.match(el("coachingWeekGrid").innerHTML,/Optional set targets: 25 s/);assert.match(el("coachingWeekGrid").innerHTML,/Entered repetition reference; not a time or distance target: 3 sets × 12 reps/);assert.doesNotMatch(el("coachingWeekGrid").innerHTML,/null reps|25 reps|25 s · 0 kg/);assert.match(el("coachingCalibrationIntake").textContent,/20 logged · 18 aligned/);assert.match(el("coachingCalibrationAlignment").textContent,/final date is excluded/);assert.match(el("coachingCalibrationSensitivity").textContent,/2,000–2,600.*Not a confidence interval/);assert.match(el("coachingWeightBasis").textContent,/80 kg · recent morning weights/);assert.equal(el("coachingModelUpdate").hidden,false);assert.match(el("coachingProjectionNote").textContent,/both weight gain and weight loss/);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});


test("partial and unavailable sessions disclose missing movements while calorie tracking stays available",()=>{
  const previous=globalThis.document;globalThis.document={querySelectorAll:()=>[]};
  try{
    const el=elements(),render=createRenderer({element:el,ui:Ui,diaryUi:Diary}),profile={version:3,measurementSystem:"metric",weightKg:82,experience:"beginner",sessionMinutes:30,sessionsPerWeek:2,workoutDays:["Wednesday","Thursday"],lifestyleActivity:"lightly_active",usualExercises:[]};
    const partial={day:"Wednesday",status:"partial",label:"Partial workout · manual review",plannedLabel:"Full body A",workingSets:2,estimatedDurationMinutes:9,missingRoles:["Upper-body pull"],readinessWarning:"The selected equipment cannot cover every required movement.",exercises:[{name:"Incline Push-up",sets:2,reps:"6–12",rest:"120 sec",measurement:"reps",loadType:"bodyweight"}]};
    const unavailable={day:"Thursday",status:"unavailable",label:"Workout unavailable",plannedLabel:"Full body B",workingSets:0,estimatedDurationMinutes:0,missingRoles:["Knee-dominant legs","Upper-body pull"],readinessWarning:"No compatible exercises fit the saved movement constraints.",exercises:[]};
    const model={...week,nextWeekStart:"2026-09-21",training:{sessions:[partial,unavailable],summary:{reviewNeeded:true,missingCoverage:["Wednesday: Upper-body pull","Thursday: Knee-dominant legs, Upper-body pull"],groups:[],coverageBasis:"Direct work only."}}};
    render.renderDashboard(profile,model,[],"2026-09-16");const markup=el("coachingWeekGrid").innerHTML,partialCard=markup.match(/<article class="coaching-day-card is-training is-partial">(.*?)<\/article>/)[1],unavailableCard=markup.match(/<article class="coaching-day-card is-training is-unavailable">(.*?)<\/article>/)[1];
    assert.match(partialCard,/<h5>Partial session<\/h5>/);assert.match(partialCard,/Missing movements: Upper-body pull/);assert.match(partialCard,/Incline Push-up/);assert.match(partialCard,/2 working sets/);assert.doesNotMatch(partialCard,/Full body A/);
    assert.match(unavailableCard,/<h5>Training unavailable<\/h5>/);assert.match(unavailableCard,/saved movement constraints/);assert.match(unavailableCard,/Knee-dominant legs, Upper-body pull/);assert.doesNotMatch(unavailableCard,/Recovery day|Full body B|0 minutes|<ol>/);
    assert.match(markup,/Recovery day/);assert.match(el("coachingWeekLabel").textContent,/2 scheduled days/);assert.match(el("coachingPlanMethod").textContent,/partial or unavailable sessions/);assert.match(el("coachingTrainingCoverage").textContent,/Thursday: Knee-dominant legs, Upper-body pull/);assert.match(el("coachingCalorieWeek").innerHTML,/2,200 kcal/);assert.match(el("coachingProgressSummary").innerHTML,/2,200 kcal/);assert.equal(el("coachingDashboard").hidden,false);
  }finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}
});
