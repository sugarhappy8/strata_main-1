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
