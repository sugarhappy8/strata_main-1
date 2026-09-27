"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const vm=require("node:vm");
const Ui=require("../public/scripts/personal-training-ui-core");

function validDraft(overrides={}){
  return{
    unitSystem:"metric",age:"31",heightCm:"178",weightKg:"82.4",bodyFatPercent:"18.5",sexForEquation:"male",
    dailyMovement:"lightly_moving",additionalActivityMinutesPerWeek:"120",additionalActivityIntensity:"moderate",goal:"deficit",goalPace:"gentle",experience:"intermediate",trainingDaysPerWeek:"3",sessionMinutes:"45",
    availableDays:["Monday","Wednesday","Friday"],equipment:["Dumbbells","Cables"],knownExerciseIds:["flat-dumbbell-press"],
    performanceMaxes:[{exerciseId:"flat-dumbbell-press",maxSets:"4",maxReps:"10",maxWeight:"32.5"}],
    caloriePattern:"training-day",flexibleDay:"",macrosEnabled:true,...overrides
  };
}

test("no-build script exposes the same frozen browser API",()=>{
  const context={Intl};context.globalThis=context;vm.createContext(context);
  vm.runInContext(readFileSync(join(__dirname,"..","public","scripts","personal-training-energy-ui-core.js"),"utf8"),context,{filename:"personal-training-energy-ui-core.js"});
  vm.runInContext(readFileSync(join(__dirname,"..","public","scripts","personal-training-ui-core.js"),"utf8"),context,{filename:"personal-training-ui-core.js"});
  assert.equal(typeof context.StrataPersonalTrainingUi.profileDraftToMetric,"function");
  assert.equal(Object.isFrozen(context.StrataPersonalTrainingUi),true);
});

test("metric and imperial profile drafts serialize to the same canonical units",()=>{
  const metric=Ui.profileDraftToMetric(validDraft());
  assert.equal(metric.ok,true);
  assert.deepEqual(metric.payload.usualExercises,[{exerciseId:"flat-dumbbell-press",maxSets:4,maxReps:10,maxWeightKg:32.5}]);
  assert.equal(metric.payload.goal,"fat_loss");assert.equal(metric.payload.goalPace,"gentle");assert.equal(metric.payload.dailyMovement,"lightly_moving");assert.equal(metric.payload.additionalActivityMinutesPerWeek,120);assert.equal(metric.payload.additionalActivityIntensity,"moderate");assert.equal(Object.hasOwn(metric.payload,"lifestyleActivity"),false);
  assert.deepEqual(metric.payload.workoutDays,["Monday","Wednesday","Friday"]);assert.equal(metric.payload.sessionMinutes,45);
  assert.equal(Object.hasOwn(metric.payload,"revision"),false);
  assert.equal(metric.payload.sexForEquation,"male","the primary equation coefficient remains explicit when body fat supplies a noisy cross-check");
  const imperial=Ui.profileDraftToMetric(validDraft({
    unitSystem:"imperial",heightCm:"",heightFeet:"5",heightInches:"10.1",weightKg:"",weightLb:"181.66",
    performanceMaxes:[{exerciseId:"flat-dumbbell-press",maxSets:"4",maxReps:"10",maxWeight:"71.65"}]
  }));
  assert.equal(imperial.ok,true);
  assert.ok(Math.abs(imperial.payload.heightCm-metric.payload.heightCm)<0.2);
  assert.ok(Math.abs(imperial.payload.weightKg-metric.payload.weightKg)<0.1);
  assert.ok(Math.abs(imperial.payload.usualExercises[0].maxWeightKg-32.5)<0.1);
});

test("primary equation coefficient is required even when optional body fat is supplied",()=>{
  const missing=Ui.profileDraftToMetric(validDraft({sexForEquation:""}));
  assert.equal(missing.ok,false);
  assert.ok(missing.errors.some(({field})=>field==="sexForEquation"));
  const supplied=Ui.profileDraftToMetric(validDraft({bodyFatPercent:"18.5",sexForEquation:"female"}));
  assert.equal(supplied.ok,true);
  assert.equal(supplied.payload.sexForEquation,"female");
  assert.equal(Ui.profileDraftToMetric(validDraft({bodyFatPercent:"",sexForEquation:"male"})).ok,true);
});

test("profile validation gives field-specific adult, measurement, schedule, and flexible-day errors",()=>{
  const result=Ui.profileDraftToMetric(validDraft({
    age:"18",heightCm:"99",weightKg:"900",bodyFatPercent:"80",dailyMovement:"unknown",additionalActivityMinutesPerWeek:"1261",additionalActivityIntensity:"unknown",goal:"cut",experience:"expert",
    trainingDaysPerWeek:"4",availableDays:["Monday","Monday","Funday"],caloriePattern:"flexible-day",flexibleDay:""
  }));
  assert.equal(result.ok,false);
  for(const field of ["age","height","weight","bodyFatPercent","dailyMovement","additionalActivityMinutesPerWeek","additionalActivityIntensity","goal","experience","trainingDays","flexibleDay"]){
    assert.ok(result.errors.some((error)=>error.field===field),field);
  }
});

test("usual exercise rows are normalized without duplicates or incomplete maxima",()=>{
  const result=Ui.profileDraftToMetric(validDraft({
    performanceMaxes:[
      {exerciseId:"incline-curl",maxSets:"3",maxReps:"12",maxWeight:"14"},
      {exerciseId:"incline-curl",maxSets:"3",maxReps:"12",maxWeight:"15"},
      {exerciseId:"dead-bug",maxSets:"",maxReps:"",maxWeight:""}
    ]
  }));
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(({message})=>/once/.test(message)));
  assert.ok(result.errors.some(({message})=>/1–20 sets/.test(message)));
  assert.deepEqual(result.payload.usualExercises,[{exerciseId:"incline-curl",maxSets:3,maxReps:12,maxWeightKg:14}]);
});

test("saved metric profiles round-trip through imperial form values",()=>{
  const source=Ui.profileDraftToMetric(validDraft()).payload,form=Ui.profileMetricToDraft(source,"imperial"),roundTrip=Ui.profileDraftToMetric(form);
  assert.equal(roundTrip.ok,true);
  assert.equal(form.dailyMovement,"lightly_moving");assert.equal(form.additionalActivityMinutesPerWeek,120);assert.equal(form.additionalActivityIntensity,"moderate");
  assert.ok(Math.abs(roundTrip.payload.heightCm-source.heightCm)<0.2);
  assert.ok(Math.abs(roundTrip.payload.weightKg-source.weightKg)<0.1);
  assert.ok(Math.abs(roundTrip.payload.usualExercises[0].maxWeightKg-source.usualExercises[0].maxWeightKg)<0.1);
  assert.equal(Ui.profileDraftToMetric(source).ok,true,"a canonical profile can be validated again without converting its metric storage fields as imperial input");
  form.trainingDays=["Tuesday","Thursday"];form.frequency=2;form.performanceMaxes[0].reps=8;form.macrosEnabled=false;
  const edited=Ui.profileDraftToMetric(form);
  assert.deepEqual(edited.payload.workoutDays,["Tuesday","Thursday"]);assert.equal(edited.payload.usualExercises[0].maxReps,8);assert.equal(edited.payload.macroPreference,null);
  const higher=Ui.profileMetricToDraft({...source,macroPreference:"higher_protein"},"metric");
  assert.equal(higher.macroPreference,"higher_protein");assert.equal(Ui.profileDraftToMetric(higher).payload.macroPreference,"higher_protein");
});

test("discover form aliases map to the strict coaching API contract",()=>{
  const result=Ui.profileDraftToMetric({
    height:"70",heightUnit:"in",weight:"180",weightUnit:"lb",age:"28",bodyFatPercent:"",sexForEquation:"male",
    goal:"surplus",goalPace:"moderate",dailyMovement:"on_feet",additionalActivityMinutesPerWeek:"0",additionalActivityIntensity:"moderate",experience:"advanced",frequency:"2",sessionMinutes:"60",
    trainingDays:["Tuesday","Saturday"],equipment:["Dumbbells"],limitations:["no-overhead"],
    performanceMaxes:[{exerciseId:"incline-curl",sets:"3",reps:"10",load:"30",unit:"lb"}],
    caloriePattern:"flexible_day",flexibleDay:"Saturday",macrosEnabled:true,timeZone:"Asia/Dubai"
  });
  assert.equal(result.ok,true);
  assert.deepEqual(result.payload,{
    version:4,measurementSystem:"imperial",preferredLoadUnit:"lb",age:28,heightCm:177.8,weightKg:81.65,bodyFatPercent:null,sexForEquation:"male",
    goal:"muscle_gain",goalPace:"moderate",trainingGoal:"balanced",experience:"advanced",dailyMovement:"on_feet",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",workoutDays:["Tuesday","Saturday"],sessionMinutes:60,
    usualExercises:[{exerciseId:"incline-curl",maxSets:3,maxReps:10,maxWeightKg:13.61}],availableEquipment:["Dumbbells"],movementLimitations:["no-overhead"],
    caloriePattern:"flexible_day",flexibleDay:"Saturday",macroPreference:"balanced",timeZone:"Asia/Dubai"
  });
});

test("daily progress keeps remaining and over-target amounts distinct",()=>{
  assert.deepEqual(Ui.calorieProgress(2200,1750),{
    targetCalories:2200,consumedCalories:1750,remainingCalories:450,overByCalories:0,status:"remaining",progressPercent:80,summary:"450 kcal remaining for the selected day"
  });
  const over=Ui.calorieProgress(2200,2350);
  assert.equal(over.remainingCalories,0);assert.equal(over.overByCalories,150);assert.equal(over.status,"over");assert.equal(over.progressPercent,100);
  assert.throws(()=>Ui.calorieProgress(0,10),/positive daily/);
  assert.throws(()=>Ui.calorieProgress(1000,-1),/zero or a positive/);
});

test("optional macro progress and seven-day totals remain transparent",()=>{
  assert.equal(Ui.macroProgress(null,{proteinGrams:20}),null);
  const macros=Ui.macroProgress({proteinGrams:150,fatGrams:70,carbGrams:250},{proteinGrams:90,fatGrams:72,carbGrams:100});
  assert.deepEqual(macros.protein,{targetGrams:150,consumedGrams:90,remainingGrams:60,overByGrams:0,progressPercent:60});
  assert.equal(macros.fat.overByGrams,2);
  assert.equal(Ui.macroProgress({proteinG:150,fatG:70,carbsG:250},{proteinG:90,fatG:72,carbsG:100}).carbs.remainingGrams,150);
  const week=Ui.weeklyCalorieProgress(Ui.DAYS.map((day,index)=>({day,targetCalories:index===5?2600:2100,consumedCalories:2000})));
  assert.equal(week.complete,true);assert.equal(week.targetCalories,15_200);assert.equal(week.consumedCalories,14_000);assert.equal(week.remainingCalories,1_200);
});

test("daily morning weights round-trip between display and canonical kilograms",()=>{
  assert.equal(Ui.dailyWeightToKilograms("82.4","metric"),82.4);
  assert.ok(Math.abs(Ui.dailyWeightToKilograms("181.7","imperial")-82.42)<.02);
  assert.equal(Ui.dailyWeightFromKilograms(82.4,"metric"),82.4);
  assert.ok(Math.abs(Ui.dailyWeightFromKilograms(82.4,"imperial")-181.7)<.1);
  assert.equal(Ui.dailyWeightToKilograms("","imperial"),null);
  assert.equal(Ui.dailyWeightFromKilograms(null,"metric"),null);
});

test("calibration display distinguishes readiness without inventing certainty",()=>{
  const starting=Ui.calibrationDisplay(null);
  assert.deepEqual({status:starting.status,completeDays:starting.completeDays,requiredCompleteDays:starting.requiredCompleteDays,weightDays:starting.weightDays,requiredWeightDays:starting.requiredWeightDays,weightSpanDays:starting.weightSpanDays,requiredWeightSpanDays:starting.requiredWeightSpanDays,windowDays:starting.windowDays},{status:"starting",completeDays:0,requiredCompleteDays:14,weightDays:0,requiredWeightDays:8,weightSpanDays:0,requiredWeightSpanDays:14,windowDays:42});
  assert.match(starting.explanation,/formula-based planning estimate/i);
  const informed=Ui.calibrationDisplay({status:"trend_informed",evidence:{completeCalorieDays:19,requiredCompleteCalorieDays:18,morningWeightDays:14,requiredMorningWeightDays:12,weightObservationSpanDays:16,requiredWeightObservationSpanDays:14},windowStart:"2026-09-07",windowEnd:"2026-09-27",observedMaintenanceKcal:2437,averageCompleteCaloriesKcal:2260,appliedAdjustmentKcal:-100,explanation:"Recent records support a restrained cross-check.",limitations:["Not a metabolic measurement."]});
  assert.equal(informed.title,"TREND-INFORMED ESTIMATE.");assert.equal(informed.completeDays,19);assert.equal(informed.weightDays,14);assert.equal(informed.weightSpanDays,16);assert.equal(informed.requiredWeightSpanDays,14);assert.equal(informed.observedMaintenanceKcal,2437);assert.equal(informed.averageCompleteCaloriesKcal,2260);assert.equal(informed.cutoffDate,"2026-09-27");assert.equal(informed.appliedAdjustmentKcal,-100);assert.deepEqual(informed.limitations,["Not a metabolic measurement."]);
  assert.equal(Ui.calibrationDisplay({status:"calibrating",completeDays:5,weightDays:4}).completeDays,5,"older flat fixtures remain readable");
  assert.equal(Ui.calibrationDisplay({status:"legacy_profile"}).label,"Legacy profile");
});

test("projection display retains tenths and always carries uncertainty language",()=>{
  const metric=Ui.projectionDisplay({startWeightKg:82.37,projectedWeightKg:79.73,lowWeightKg:78.91,highWeightKg:81.04,weeks:12},"metric");
  assert.deepEqual({start:metric.start,expected:metric.expected,range:metric.range,weeks:metric.weeks},{start:"82.4 kg",expected:"79.7 kg",range:"78.9 kg–81 kg",weeks:12});
  assert.match(metric.caveat,/not a promise/i);
  const imperial=Ui.projectionDisplay({startWeightKg:82.37,expectedWeightKg:79.73,lowWeightKg:78.91,highWeightKg:81.04,horizonWeeks:12,caveat:"Estimate only."},"imperial");
  assert.equal(imperial.start,"181.6 lb");assert.equal(imperial.expected,"175.8 lb");assert.equal(imperial.caveat,"Estimate only.");
  assert.equal(Ui.projectionDisplay({startWeightKg:82.37,weightKg:79.73,rangeKg:[78.91,81.04],weeks:12},"metric").expected,"79.7 kg");
  assert.equal(Ui.projectionDisplay({startWeightKg:80},"metric"),null);
});


test("training focus is independent of calorie goal and preserves a balanced default",()=>{
  assert.equal(Ui.profileDraftToMetric(validDraft()).payload.trainingGoal,"balanced");
  for(const trainingGoal of ["balanced","strength","hypertrophy"]){const result=Ui.profileDraftToMetric(validDraft({trainingGoal,goal:"maintenance"}));assert.equal(result.ok,true);assert.equal(result.payload.trainingGoal,trainingGoal);assert.equal(result.payload.goal,"maintenance");}
  assert.equal(Ui.profileDraftToMetric(validDraft({trainingGoal:"random"})).ok,false);
});

test("advertised imperial weight bounds round-trip to valid canonical endpoints",()=>{
  for(const [pounds,kilograms] of [[77.2,35.02],[661.4,300]]){assert.equal(Ui.dailyWeightToKilograms(pounds,"imperial"),kilograms);assert.equal(Ui.kilogramsToPounds(kilograms),pounds,"the endpoint reads back as entered");const result=Ui.profileDraftToMetric({...validDraft(),weight:pounds,weightUnit:"lb"});assert.equal(result.ok,true);assert.equal(result.payload.weightKg,kilograms);}
  assert.equal(Ui.dailyWeightToKilograms(661.5,"imperial"),null);assert.equal(Ui.dailyWeightToKilograms(77.1,"imperial"),null);
  // Every 0.1 lb entry reads back exactly as typed (180 lb previously came back as 179.9 lb).
  for(let tenths=772;tenths<=6614;tenths+=1){const pounds=tenths/10;assert.equal(Ui.dailyWeightFromKilograms(Ui.dailyWeightToKilograms(pounds,"imperial"),"imperial"),pounds);}
});

test("calibration presents aligned evidence, held prior state, and heuristic sensitivity",()=>{
  const source={status:"calibrating",priorState:"held",windowStart:"2026-08-03",windowEnd:"2026-09-13",evidence:{completeCalorieDays:20,alignedIntakeDays:14,requiredCompleteCalorieDays:14,morningWeightDays:8,requiredMorningWeightDays:8,weightObservationSpanDays:14},interval:{start:"2026-08-24",end:"2026-09-07",lastIntakeDate:"2026-09-06"},quality:{label:"inconsistent"},lastAcceptedEvidenceEnd:"2026-08-31",sensitivity:{rangeKcal:[1900,2600],statistical:false,basis:"Not a confidence interval."}};
  const view=Ui.calibrationDisplay(source);assert.equal(view.windowDays,42);assert.equal(view.alignedIntakeDays,14);assert.equal(view.title,"PREVIOUS ESTIMATE HELD.");assert.equal(view.label,"Previous estimate held");assert.deepEqual(view.interval,source.interval);assert.deepEqual(view.sensitivity,source.sensitivity);assert.equal(view.quality.label,"inconsistent");assert.equal(Ui.calibrationDisplay({...source,priorState:"expired"}).label,"Previous evidence expired");assert.equal(Ui.calibrationDisplay({...source,sensitivity:{rangeKcal:[]}}).sensitivity,null);
});


test("imperial height endpoints retain enough precision to remain valid on review",()=>{
  for(const [heightCm,inches] of [[120,47.24],[230,90.55]]){const draft=Ui.profileMetricToDraft({heightCm},"imperial");assert.equal(draft.height,inches);const roundTrip=Ui.profileDraftToMetric({...validDraft(),height:draft.height,heightUnit:"in"});assert.equal(roundTrip.ok,true);assert.equal(roundTrip.payload.heightCm,heightCm);}
});


test("held target reconciliation separates weekly change from the equation difference",()=>{
  const result=Ui.calibrationDisplay({modelVersion:"energy-planning-v3",status:"calibrating",priorState:"held",weeklyChangeKcal:-25,appliedAdjustmentKcal:650});
  assert.equal(result.title,"PREVIOUS ESTIMATE ADJUSTED.");assert.equal(result.label,"Previous estimate adjusted");assert.equal(result.weeklyChangeKcal,-25);assert.equal(result.appliedAdjustmentKcal,650);assert.equal(result.modelVersion,"energy-planning-v3");
  assert.equal(Ui.calibrationDisplay({...result,weeklyChangeKcal:0}).title,"PREVIOUS ESTIMATE HELD.");
  assert.equal(Ui.displayWeight(57.1,"metric",{projection:true}),"57.1 kg","presentation must preserve the backend's displayed lower safety boundary");
});
