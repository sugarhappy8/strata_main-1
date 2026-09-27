"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const EnergyUi=require("../public/scripts/personal-training-energy-ui-core");

test("profile v4 energy activity inputs stay separate and bounded",()=>{
  const result=EnergyUi.profileDraftToEnergy({dailyMovement:"on_feet",additionalActivityMinutesPerWeek:"360",additionalActivityIntensity:"vigorous"});
  assert.deepEqual(result,{ok:true,payload:{dailyMovement:"on_feet",additionalActivityMinutesPerWeek:360,additionalActivityIntensity:"vigorous"},errors:[]});
  assert.equal(Object.isFrozen(EnergyUi),true);
});

test("zero extra activity is optional while positive minutes require intensity",()=>{
  assert.deepEqual(EnergyUi.profileDraftToEnergy({dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:"",additionalActivityIntensity:""}).payload,{dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate"});
  const missing=EnergyUi.profileDraftToEnergy({dailyMovement:"lightly_moving",additionalActivityMinutesPerWeek:"30",additionalActivityIntensity:""});
  assert.equal(missing.ok,false);assert.ok(missing.errors.some(({field})=>field==="additionalActivityIntensity"));
  for(const minutes of [-1,1.5,1261])assert.ok(EnergyUi.profileDraftToEnergy({dailyMovement:"on_feet",additionalActivityMinutesPerWeek:minutes,additionalActivityIntensity:"light"}).errors.some(({field})=>field==="additionalActivityMinutesPerWeek"));
});

test("earlier profiles force a fresh movement review without copying legacy activity",()=>{
  const legacy=EnergyUi.profileEnergyToDraft({version:3,lifestyleActivity:"very_active",additionalActivityMinutesPerWeek:900,additionalActivityIntensity:"vigorous"});
  assert.deepEqual(legacy,{dailyMovement:"",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate"});
  const current=EnergyUi.profileEnergyToDraft({version:4,dailyMovement:"physically_demanding",additionalActivityMinutesPerWeek:180,additionalActivityIntensity:"light"});
  assert.deepEqual(current,{dailyMovement:"physically_demanding",additionalActivityMinutesPerWeek:180,additionalActivityIntensity:"light"});
});

test("maintenance shows the accepted target instead of a range midpoint or the uncalibrated baseline",()=>{
  const display=EnergyUi.maintenanceDisplay({targetKcal:2475,baselineKcal:2700,planningRangeKcal:[2100,3000],estimateRangeKcal:[2300,3100],rangeLabel:"Sensitivity band, not a confidence interval."});
  assert.equal(display.targetKcal,2475);
  assert.equal(display.label,"2,475 kcal/day");
  assert.equal(display.detail,"Planning range: 2,100–3,000 kcal/day. Sensitivity band, not a confidence interval.");
});

test("saved scalar, baseline-only, and earlier range snapshots retain their maintenance values",()=>{
  for(const value of [2325,{targetKcal:2325},{baselineKcal:2325}])assert.equal(EnergyUi.maintenanceDisplay(value).label,"2,325 kcal/day");
  const previous=EnergyUi.maintenanceDisplay({targetKcal:2325,estimateRangeKcal:[2000,2800]});
  assert.match(previous.detail,/2,000–2,800 kcal\/day.*Not a measured value or a confidence interval/);
  assert.match(EnergyUi.maintenanceDisplay(2325).detail,/Planning estimate; actual needs can differ/);
});

test("missing or corrupt targets require review without inventing zero calories",()=>{
  for(const value of [null,undefined,"",false,0,-50,NaN,Infinity,"invalid"]){
    assert.equal(EnergyUi.calorieTargetLabel(value),"Review required");
    assert.equal(EnergyUi.maintenanceDisplay({targetKcal:value}).label,"Review required");
  }
  assert.equal(EnergyUi.maintenanceDisplay({estimateRangeKcal:[2000,2800]}).label,"Review required","uncertainty bounds alone do not supply a target");
  assert.doesNotMatch(EnergyUi.maintenanceDisplay({targetKcal:2325,estimateRangeKcal:[2800,2000]}).detail,/2,800–2,000/);
});

test("scheduled targets show one value for steady days and a labelled range only when days vary",()=>{
  assert.deepEqual(EnergyUi.dailyTargetDisplay(Array(7).fill({calories:2300})),{label:"2,300 kcal/day",varies:false});
  assert.deepEqual(EnergyUi.dailyTargetDisplay([{calories:2100},{calories:2450}]),{label:"2,100–2,450 kcal/day",varies:true});
  assert.equal(EnergyUi.calorieTargetLabel(16_100,"kcal/week"),"16,100 kcal/week");
  for(const targets of [[],null,[{calories:2300},{calories:null}],[{calories:Infinity}]])assert.deepEqual(EnergyUi.dailyTargetDisplay(targets),{label:"Review required",varies:false});
});

test("the target reads as maintenance minus the deficit with one value per kind of day",()=>{
  const week=(calories,kinds,extra={})=>({maintenance:{targetKcal:2750},selectedGoal:"fat_loss",dailyTargets:calories.map((value,index)=>({day:["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"][index],calories:value,kind:kinds[index]})),...extra});
  // An older saved week can still hold uneven rest days; the range is shown rather than hidden.
  const zigzag=EnergyUi.targetSummary(week([2590,2440,2590,2440,2590,2440,2585],["higher_training_day","lower_rest_day","higher_training_day","lower_rest_day","higher_training_day","lower_rest_day","lower_rest_day"]));
  assert.equal(zigzag.label,"2,525 kcal/day average");assert.equal(zigzag.math,"2,750 maintenance − 225 deficit = 2,525 kcal/day");assert.equal(zigzag.days,"Training days 2,590 · Rest days 2,440–2,585");
  const steady=EnergyUi.targetSummary(week(Array(7).fill(2525),Array(7).fill("standard")));assert.equal(steady.label,"2,525 kcal/day");assert.equal(steady.days,"");assert.equal(steady.varies,false);
  const surplus=EnergyUi.targetSummary({...week(Array(7).fill(2950),Array(7).fill("standard")),selectedGoal:"muscle_gain"});assert.equal(surplus.math,"2,750 maintenance + 200 surplus = 2,950 kcal/day");
  const maintenance=EnergyUi.targetSummary({...week(Array(7).fill(2750),Array(7).fill("standard")),selectedGoal:"maintenance"});assert.equal(maintenance.math,"Matches maintenance of 2,750 kcal");
  const flexible=EnergyUi.targetSummary(week([2460,2460,2460,2460,2460,2915,2460],["standard","standard","standard","standard","standard","flexible_day","standard"]));assert.equal(flexible.days,"Other days 2,460 · Saturday 2,915");
  assert.equal(EnergyUi.targetSummary({dailyTargets:[{calories:null}]}).label,"Review required");assert.equal(EnergyUi.targetSummary(null).label,"Review required");
});

test("maintenance steps add up exactly on screen and end at the saved maintenance",()=>{
  const nutrition={rmrKcal:1787.5,maintenance:{targetKcal:2750,baselineKcal:2775},activityBreakdown:{movementPal:1.5,nonWorkoutKcal:2681.25,plannedTrainingWeekKcal:618.4,additionalActivityWeekKcal:469,targetKcal:2836.6}};
  const steps=EnergyUi.maintenanceSteps(nutrition),value=(label)=>Number(steps.find(row=>row.label.startsWith(label)).value.replace(/[^0-9−-]/g,"").replace("−","-"));
  assert.deepEqual(steps.map(row=>row.label),["Resting energy","× 1.50 for daily movement","+ planned workouts (618 kcal/week ÷ 7)","+ other activity (469 kcal/week ÷ 7)","= estimated daily expenditure","Rounded to the nearest 25 kcal","Calibration from your logged intake and weight","Maintenance"]);
  assert.equal(value("× 1.50")+value("+ planned")+value("+ other"),value("= estimated"),"the visible rows add up");
  assert.equal(value("Rounded"),2775);assert.equal(value("Calibration"),-25);assert.equal(steps.at(-1).value,"2,750 kcal/day");assert.equal(steps.at(-1).total,true);
  assert.equal(EnergyUi.maintenanceSteps({...nutrition,maintenance:{targetKcal:2775,baselineKcal:2775},activityBreakdown:{...nutrition.activityBreakdown,additionalActivityWeekKcal:0}}).some(row=>/other activity|Calibration/.test(row.label)),false,"zero rows are omitted");
  for(const broken of [{...nutrition,rmrKcal:0},{...nutrition,activityBreakdown:null},{...nutrition,maintenance:{targetKcal:2750}}])assert.equal(EnergyUi.maintenanceSteps(broken),null);
});

test("macro calories use 4 kcal per gram of protein and carbohydrate and 9 per gram of fat",()=>{
  assert.equal(EnergyUi.macroCalories({proteinG:90,carbsG:120,fatG:40}),1200);assert.equal(EnergyUi.macroCalories({proteinG:"150",carbsG:"287",fatG:"65"}),2333);
  for(const partial of [{proteinG:90,carbsG:120},{proteinG:90,carbsG:"",fatG:40},{proteinG:-1,carbsG:1,fatG:1},null])assert.equal(EnergyUi.macroCalories(partial),null);
});

