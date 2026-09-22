"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {ACTIVITY_CATEGORY_MAP,baselineFor,calibrateMaintenance,macroTarget,nasemEer,nutritionFor}=require("../src/energy-planning-core");

function profile(overrides={}){return {version:3,age:40,heightCm:175,weightKg:75,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",lifestyleActivity:"moderately_active",workoutDays:["Monday","Wednesday","Friday"],caloriePattern:"steady",flexibleDay:null,macroPreference:"balanced",...overrides};}
function structuredProfile(overrides={}){const output=profile({version:4,dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",...overrides});delete output.lifestyleActivity;return output;}
function training(days=["Monday"],minutes=60,status="ready"){return {sessions:days.map(day=>({day,status,estimatedDurationMinutes:minutes,exercises:status==="unavailable"?[]:[{exerciseId:"test"}]}))};}
function date(offset){return new Date(Date.parse("2026-08-17T00:00:00.000Z")+offset*86400000).toISOString().slice(0,10);}
function completeEvidence({calories=3000,weightStart=75,weeklyChange=0,outlier=false}={}){
  const weights=new Map(Array.from({length:13},(_,index)=>{const day=Math.round(index*20/12),weightKg=weightStart+weeklyChange*day/7;return [day,outlier&&index===6?weightKg+12:weightKg];}));
  return {dailyLogs:Array.from({length:21},(_,index)=>({date:date(index),calories,complete:true,morningWeightKg:weights.get(index)??null}))};
}

test("the official 2023 adult EER example rounds to 2,275 kcal",()=>{
  const input=profile({age:22,heightCm:165,weightKg:63,sexForEquation:"female",lifestyleActivity:"lightly_active"});
  assert.equal(Math.round(nasemEer(input)),2275);
  const baseline=baselineFor(input);assert.equal(baseline.targetKcal,2275);assert.equal(baseline.primaryEquation,"nasem_2023_eer");assert.equal(baseline.activityCategory,"low_active");
});

test("all adult sex and activity equations use the published coefficients",()=>{
  const expected={male:{sedentary:2514.87,lightly_active:2721.27,moderately_active:2905.87,very_active:3213.92,extremely_active:3213.92},female:{sedentary:2183.75,lightly_active:2360.87,moderately_active:2499.85,very_active:2760.68,extremely_active:2760.68}};
  for(const [sex,activities] of Object.entries(expected))for(const [activity,value] of Object.entries(activities))assert.equal(Math.round(nasemEer(profile({sexForEquation:sex,lifestyleActivity:activity}))*100)/100,value,`${sex} ${activity}`);
  assert.deepEqual(ACTIVITY_CATEGORY_MAP,{sedentary:"inactive",lightly_active:"low_active",moderately_active:"active",very_active:"very_active",extremely_active:"very_active"});
});

test("version 1–2 profiles preserve the exact legacy equation choice and do not calibrate before review",()=>{
  const mifflin=baselineFor(profile({version:1,age:18}));
  assert.equal(mifflin.primaryEquation,"legacy_mifflin_activity_fallback");assert.equal(mifflin.targetKcal,2725);assert.equal(mifflin.activityFactor,1.55);assert.match(mifflin.explanation,/original activity multiplier/);
  const cunningham=baselineFor(profile({version:2,bodyFatPercent:20}));
  assert.equal(cunningham.primaryEquation,"legacy_cunningham_activity_fallback");assert.equal(cunningham.targetKcal,2575);assert.equal(cunningham.bodyFatCrossCheck,null,"a legacy primary must not also render as its own cross-check");
  const noSex=baselineFor(profile({version:1,bodyFatPercent:20,sexForEquation:null}));assert.equal(noSex.primaryEquation,"legacy_cunningham_activity_fallback");
  const held=calibrateMaintenance(profile({version:1}),"2026-09-07",completeEvidence({calories:3600}));assert.equal(held.status,"legacy_profile");assert.equal(held.appliedAdjustmentKcal,0);assert.equal(held.targetKcal,held.baselineKcal);
});

test("body-fat data is a secondary cross-check and cannot silently replace the adult EER target",()=>{
  const without=baselineFor(profile()),withBodyFat=baselineFor(profile({bodyFatPercent:12}));
  assert.equal(withBodyFat.primaryEquation,"nasem_2023_eer");assert.equal(withBodyFat.targetKcal,without.targetKcal);assert.equal(withBodyFat.planningBandKcal,without.planningBandKcal,"version 3 must retain its exact pre-v4 planning band");assert.equal(withBodyFat.bodyFatCrossCheck.role,"secondary_cross_check");assert.equal(without.bodyFatCrossCheck,null);
  const legacyCorner={age:19,heightCm:160,weightKg:57,sexForEquation:"male",lifestyleActivity:"sedentary",goal:"fat_loss",goalPace:"moderate"},withoutCorner=nutritionFor(profile(legacyCorner),"2026-09-07"),withCorner=nutritionFor(profile({...legacyCorner,bodyFatPercent:40}),"2026-09-07");assert.equal(withCorner.deficit.targetKcal,withoutCorner.deficit.targetKcal);
});

test("version 4 separates non-workout movement from generated sessions and the DRI cross-check",()=>{
  const noTraining=baselineFor(structuredProfile(),training([])),withTraining=baselineFor(structuredProfile(),training(["Monday","Wednesday","Friday"]));
  assert.equal(noTraining.energySemantics,"mifflin_structured_activity_v4");assert.equal(noTraining.primaryEquation,"mifflin_structured_activity");assert.equal(noTraining.structuredActivity.plannedTrainingWeekKcal,0);
  assert.ok(withTraining.targetKcal>noTraining.targetKcal);assert.equal(withTraining.structuredActivity.sessions.length,3);assert.equal(withTraining.wholeDayEerCrossCheck.role,"population_cross_check");assert.ok(withTraining.targetKcal<baselineFor(profile({lifestyleActivity:"sedentary"})).targetKcal,"a reviewed seated component start avoids treating the DRI inactive example as truly sedentary");
});

test("version 4 activity inputs are monotonic and unavailable sessions never add training fuel",()=>{
  const base=structuredProfile(),seated=baselineFor(base,training([])),moving=baselineFor(structuredProfile({dailyMovement:"lightly_moving"}),training([])),extra=baselineFor(structuredProfile({additionalActivityMinutesPerWeek:180}),training([])),unavailable=baselineFor(base,training(["Monday"],90,"unavailable"));
  assert.ok(moving.targetKcal>seated.targetKcal);assert.ok(extra.targetKcal>seated.targetKcal);assert.equal(unavailable.targetKcal,seated.targetKcal);assert.equal(unavailable.structuredActivity.sessions.length,0);
});

test("version 4 deficit pace is weight-relative and optional composition can only restrict it",()=>{
  const moderate=nutritionFor(structuredProfile({goal:"fat_loss",goalPace:"moderate"}),"2026-09-07",null,training(["Monday","Wednesday","Friday"])),gentle=nutritionFor(structuredProfile({goal:"fat_loss",goalPace:"gentle"}),"2026-09-07",null,training(["Monday","Wednesday","Friday"])),withComposition=nutritionFor(structuredProfile({goal:"fat_loss",goalPace:"moderate",bodyFatPercent:15}),"2026-09-07",null,training(["Monday","Wednesday","Friday"]));
  assert.equal(moderate.deficit.breakdown.requestedWeightChangePercentPerWeek,.5);assert.equal(gentle.deficit.breakdown.requestedWeightChangePercentPerWeek,.25);assert.ok(moderate.deficit.targetKcal<gentle.deficit.targetKcal);assert.equal(moderate.deficit.breakdown.weightRateDeficitKcal,400);assert.ok(moderate.deficit.breakdown.actualWeightChangePercentPerWeek<=.5);
  assert.equal(withComposition.maintenance.targetKcal,moderate.maintenance.targetKcal);assert.ok(withComposition.deficit.targetKcal>=moderate.deficit.targetKcal);assert.equal(withComposition.deficit.breakdown.bodyFatRole.includes("never raises maintenance"),true);
});

test("a body-fat cross-check that widens the planning range names the resulting scenario guard",()=>{
  const common={age:19,heightCm:160,weightKg:56.3,dailyMovement:"mostly_seated",goalPace:"moderate"},without=nutritionFor(structuredProfile({...common,goal:"fat_loss"}),"2026-09-07",null,training(["Monday"],30)),withComposition=nutritionFor(structuredProfile({...common,goal:"maintenance",bodyFatPercent:40}),"2026-09-07",null,training(["Monday"],30)),details=withComposition.deficit.breakdown;
  assert.equal(without.deficit.targetKcal,1700);assert.equal(withComposition.maintenance.targetKcal,without.maintenance.targetKcal,"composition must not raise the midpoint");assert.equal(details.energyAvailabilityGuardApplied,false);assert.equal(details.compositionRangeExpanded,true);assert.equal(details.scenarioGuardApplied,true);assert.equal(withComposition.deficit.targetKcal,null);assert.ok(details.compositionDifferenceKcal>0);
  assert.throws(()=>nutritionFor(structuredProfile({...common,goal:"fat_loss",bodyFatPercent:40}),"2026-09-07",null,training(["Monday"],30)),error=>error?.code==="DEFICIT_REQUIRES_REVIEW"&&/widen the planning range.*lower sensitivity scenario/.test(error.message));
});

test("a small recent-weight change cannot remove a restrictive body-fat safety screen",()=>{
  const input=structuredProfile({goal:"fat_loss",goalPace:"moderate",bodyFatPercent:5}),without=nutritionFor(input,"2026-09-07",null,training(["Monday","Wednesday","Friday"])),recent={dailyLogs:[18,19,20].map(offset=>({date:date(offset),calories:2000,complete:false,morningWeightKg:74.9}))},withRecent=nutritionFor(input,"2026-09-07",recent,training(["Monday","Wednesday","Friday"]));
  assert.equal(withRecent.weightBasis.bodyFatCompatible,true);assert.ok(withRecent.deficit.breakdown.energyAvailabilityFloorKcal!=null);assert.ok(withRecent.deficit.targetKcal>=without.deficit.targetKcal-25,"scale noise must not unlock a materially larger deficit");
  const changed={dailyLogs:[18,19,20].map(offset=>({date:date(offset),calories:2000,complete:false,morningWeightKg:72}))};assert.throws(()=>nutritionFor(input,"2026-09-07",changed,training(["Monday","Wednesday","Friday"])),error=>error?.code==="DEFICIT_REQUIRES_REVIEW"&&/body-fat estimate/.test(error.message));
});

test("version 4 never rounds a deficit past the requested body-weight rate or declared caps",()=>{
  for(const weightKg of [35,75,150,300])for(const goalPace of ["gentle","moderate"]){
    const heightCm=Math.max(120,Math.min(230,Math.sqrt(weightKg/25)*100)),output=nutritionFor(structuredProfile({age:35,heightCm,weightKg,goal:"fat_loss",goalPace}),"2026-09-07",null,training(["Monday","Wednesday","Friday"])),details=output.deficit.breakdown,actual=details.actualDeficitKcal,requestedRate=goalPace==="gentle"?.0025:.005;
    assert.ok(actual<=weightKg*requestedRate*7700/7);assert.ok(actual<=output.maintenance.targetKcal*.2);assert.ok(actual<=500);assert.ok(details.actualWeightChangePercentPerWeek<=details.requestedWeightChangePercentPerWeek);
  }
});

test("version 4 zigzag uses actual generated session energy and preserves the weekly budget",()=>{
  const output=nutritionFor(structuredProfile({caloriePattern:"zigzag"}),"2026-09-07",null,training(["Monday","Friday"],60)),higher=output.dailyTargets.filter(day=>day.kind==="higher_training_day"),lower=output.dailyTargets.filter(day=>day.kind==="lower_rest_day");
  assert.deepEqual(higher.map(day=>day.day),["Monday","Friday"]);assert.ok(Math.min(...higher.map(day=>day.calories))>Math.max(...lower.map(day=>day.calories)));assert.equal(output.weeklyTargetKcal,output.maintenance.targetKcal*7);
});

test("version 4 does not claim a zigzag when no usable generated session can receive it",()=>{
  const output=nutritionFor(structuredProfile({caloriePattern:"zigzag"}),"2026-09-07",null,training(["Monday","Friday"],60,"unavailable"));
  assert.equal(output.requestedPattern,"zigzag");assert.equal(output.effectivePattern,"steady");assert.match(output.patternFallback,/No usable generated session/);assert.ok(output.dailyTargets.every(day=>day.kind==="standard"));assert.ok(Math.max(...output.dailyTargets.map(day=>day.calories))-Math.min(...output.dailyTargets.map(day=>day.calories))<=1);
});

test("daily redistribution cannot undo the composition floor applied to a deficit",()=>{
  for(const caloriePattern of ["flexible_day","zigzag"]){
    const output=nutritionFor(structuredProfile({weightKg:85,bodyFatPercent:20,goal:"fat_loss",caloriePattern,flexibleDay:"Sunday"}),"2026-09-07",null,training(["Monday","Friday"],60));
    const floor=output.deficit.breakdown.energyAvailabilityFloorKcal;
    assert.equal(output.deficit.targetKcal,floor);
    assert.equal(output.effectivePattern,"steady");assert.match(output.patternFallback,/composition review floor/);
    assert.ok(output.dailyTargets.every(day=>day.calories>=floor));
    assert.equal(output.weeklyTargetKcal,output.deficit.targetKcal*7);
  }
});

test("calibration searches the preceding 42 days and ignores outside and future rows",()=>{
  const evidence=completeEvidence();
  evidence.dailyLogs.push({date:"2026-07-26",calories:1,complete:true,morningWeightKg:200},{date:"2026-09-07",calories:1,complete:true,morningWeightKg:200});
  const result=calibrateMaintenance(profile(),"2026-09-07",evidence);
  assert.equal(result.windowStart,"2026-07-27");assert.equal(result.windowEnd,"2026-09-06");assert.equal(result.evidence.completeCalorieDays,21);assert.equal(result.evidence.rawMorningWeightDays,13);assert.equal(result.status,"trend_informed");
});

test("sparse and incomplete evidence reports progress without changing the equation baseline",()=>{
  const starting=calibrateMaintenance(profile(),"2026-09-07",null);assert.equal(starting.status,"starting");assert.equal(starting.appliedAdjustmentKcal,0);
  const evidence=completeEvidence();evidence.dailyLogs=evidence.dailyLogs.slice(0,13);let kept=0;for(const row of evidence.dailyLogs)if(row.morningWeightKg!=null){kept+=1;if(kept>11)row.morningWeightKg=null;}
  const calibrating=calibrateMaintenance(profile(),"2026-09-07",evidence);assert.equal(calibrating.status,"calibrating");assert.equal(calibrating.targetKcal,calibrating.baselineKcal);assert.match(calibrating.explanation,/complete|14/);
});

test("Theil-Sen calibration is deterministic, rejects an isolated weight outlier, and caps correction",()=>{
  const input=completeEvidence({calories:3600,outlier:true}),snapshot=structuredClone(input),first=calibrateMaintenance(profile(),"2026-09-07",input),reordered=calibrateMaintenance(profile(),"2026-09-07",{dailyLogs:[...input.dailyLogs].reverse()});
  assert.deepEqual(input,snapshot,"calibration must not mutate caller evidence");assert.deepEqual(reordered,first);assert.equal(first.status,"trend_informed");assert.equal(first.evidence.outlierWeightDays,1);assert.equal(first.appliedAdjustmentKcal,150);assert.equal(first.targetKcal,first.baselineKcal+150);assert.match(first.explanation,/150 kcal\/day per new week/);
});

test("calibration fingerprints all usable raw evidence, including a rejected weight outlier",()=>{
  const clean=completeEvidence({calories:3000}),withOutlier=structuredClone(clean);withOutlier.dailyLogs[1].morningWeightKg=100;
  const first=calibrateMaintenance(profile(),"2026-09-07",clean),second=calibrateMaintenance(profile(),"2026-09-07",withOutlier);
  assert.equal(first.status,"trend_informed");assert.equal(second.status,"trend_informed");assert.equal(second.evidence.outlierWeightDays,1);assert.notEqual(second.evidenceFingerprint,first.evidenceFingerprint);
});

test("trend calibration requires exact evidence counts spread across at least 14 days",()=>{
  const evidence={dailyLogs:Array.from({length:21},(_,index)=>({date:date(index),calories:3000,complete:index<18,morningWeightKg:index<=10||index===14?75:null}))};
  const accepted=calibrateMaintenance(profile(),"2026-09-07",evidence);assert.equal(accepted.status,"trend_informed");assert.deepEqual({calories:accepted.evidence.completeCalorieDays,weights:accepted.evidence.morningWeightDays,span:accepted.evidence.weightObservationSpanDays},{calories:18,weights:12,span:14});assert.match(accepted.thresholdBasis,/engineering heuristics/);
  evidence.dailyLogs[14].morningWeightKg=null;evidence.dailyLogs[11].morningWeightKg=75;
  const clustered=calibrateMaintenance(profile(),"2026-09-07",evidence);assert.equal(clustered.status,"calibrating");assert.equal(clustered.evidence.morningWeightDays,12);assert.equal(clustered.evidence.weightObservationSpanDays,11);assert.match(clustered.explanation,/14 days/);
});

test("implausible trend and observed-maintenance signals are rejected instead of applied",()=>{
  const fast=calibrateMaintenance(profile(),"2026-09-07",completeEvidence({calories:2600,weeklyChange:-1.2}));assert.equal(fast.status,"calibrating");assert.equal(fast.appliedAdjustmentKcal,0);assert.match(fast.explanation,/1.5%/);
  const far=calibrateMaintenance(profile(),"2026-09-07",completeEvidence({calories:1200}));assert.equal(far.status,"calibrating");assert.equal(far.appliedAdjustmentKcal,0);assert.match(far.explanation,/plausibility bounds/);
});

test("plausible gain and loss trends adjust maintenance in the correct bounded direction",()=>{
  const baseline=baselineFor(profile()).targetKcal,gain=calibrateMaintenance(profile(),"2026-09-07",completeEvidence({calories:baseline,weeklyChange:.35})),loss=calibrateMaintenance(profile(),"2026-09-07",completeEvidence({calories:baseline,weeklyChange:-.35}));
  assert.equal(gain.status,"trend_informed");assert.ok(gain.trendKgPerWeek>0);assert.ok(gain.appliedAdjustmentKcal<0);assert.ok(gain.observedMaintenanceKcal<baseline);
  assert.equal(loss.status,"trend_informed");assert.ok(loss.trendKgPerWeek<0);assert.ok(loss.appliedAdjustmentKcal>0);assert.ok(loss.observedMaintenanceKcal>baseline);
});

test("daily patterns and weight scenarios preserve their intended ordering",()=>{
  const zigzag=nutritionFor(profile({caloriePattern:"zigzag"}),"2026-09-07"),byKind=(nutrition,kind)=>nutrition.dailyTargets.filter((day)=>day.kind===kind).map((day)=>day.calories);
  assert.ok(Math.min(...byKind(zigzag,"higher_training_day"))>Math.max(...byKind(zigzag,"lower_rest_day")));
  const flexible=nutritionFor(profile({caloriePattern:"flexible_day",flexibleDay:"Saturday"}),"2026-09-07"),flexibleTarget=flexible.dailyTargets.find((day)=>day.kind==="flexible_day").calories,standard=byKind(flexible,"standard");assert.ok(flexibleTarget>Math.max(...standard));
  const deficit=nutritionFor(profile({goal:"fat_loss"}),"2026-09-07"),maintenance=nutritionFor(profile(),"2026-09-07"),surplus=nutritionFor(profile({goal:"muscle_gain"}),"2026-09-07");assert.ok(deficit.deficit.targetKcal<maintenance.maintenance.targetKcal);assert.ok(surplus.bulk.targetKcal>maintenance.maintenance.targetKcal);
  const centers=(nutrition)=>nutrition.weightScenarios.map((item)=>item.weightKg);assert.ok(centers(deficit).every((weight,index,values)=>index===0||weight<=values[index-1]));assert.deepEqual(centers(maintenance),[75,75,75]);assert.ok(centers(surplus).every((weight,index,values)=>index===0||weight>=values[index-1]));
});

test("nutrition output keeps legacy consumer fields while exposing the model, range, and evidence",()=>{
  const evidence=completeEvidence({calories:3000}),snapshot=structuredClone(evidence),nutrition=nutritionFor(profile(),"2026-09-07",evidence);
  assert.deepEqual(evidence,snapshot);assert.equal(nutrition.equation,"nasem_2023_eer");assert.equal(nutrition.rmrEquation,"mifflin_st_jeor");assert.equal(nutrition.activityFactor,null);assert.equal(nutrition.legacyActivityFactor,1.55);assert.equal(nutrition.maintenance.calibration.status,"trend_informed");assert.match(nutrition.activityFactorBasis,/No resting-energy multiplier/);assert.match(nutrition.maintenance.rangeLabel,/not a confidence interval/);assert.equal(nutrition.weeklyTargetKcal,nutrition.dailyTargets.reduce((sum,day)=>sum+day.calories,0));
});

test("weekly patterns allocate exact budgets and integer macros reconcile at every supported planning weight",()=>{
  for(const weightKg of [35,60,90,180,350])for(const calories of [1200,1201,1225,1999,2600,4600])for(const preference of ["balanced","higher_protein"]){
    const macros=macroTarget(calories,weightKg,preference,"fat_loss");
    assert.ok([macros.proteinG,macros.carbsG,macros.fatG].every(n=>Number.isInteger(n)&&n>=0));
    assert.equal(4*macros.proteinG+4*macros.carbsG+9*macros.fatG,calories);
    assert.ok(macros.proteinG*4<=calories*.3);
    if(macros.proteinG<macros.requestedProteinG)assert.ok(macros.adjustmentReason);
  }
  for(const caloriePattern of ["steady","zigzag","flexible_day"]){
    const output=nutritionFor(profile({caloriePattern,flexibleDay:caloriePattern==="flexible_day"?"Sunday":null}),"2026-09-07");
    assert.equal(output.weeklyTargetKcal,7*output.maintenance.targetKcal);
    for(const target of output.dailyTargets)assert.equal(target.macros.energyKcal,target.calories);
    const peers=output.dailyTargets.filter(day=>day.kind==="standard"||day.kind==="lower_rest_day").map(day=>day.calories);
    assert.ok(Math.max(...peers)-Math.min(...peers)<=1,"equally weighted days differ by at most a calorie");
  }
});

test("recent credible weight anchors baseline, macros and scenarios without reusing stale body fat",()=>{
  const evidence={dailyLogs:[0,1,2].map(i=>({date:date(18+i),morningWeightKg:72,complete:false,calories:2000}))};
  const result=nutritionFor(profile({bodyFatPercent:20}),"2026-09-07",evidence);
  assert.equal(result.weightBasis.weightKg,72);assert.equal(result.bodyFatCrossCheck,null);
  assert.equal(result.maintenance.baselineKcal,baselineFor(profile({weightKg:72})).targetKcal);
  assert.equal(result.dailyTargets[0].macros.requestedProteinG,Math.round(72*1.6));
  assert.ok(result.weightScenarios.every(s=>s.startWeightKg===72));
  assert.equal(result.maintenance.referencePredictionErrorKcal,342);
  assert.equal(nutritionFor(profile({sexForEquation:"female"}),"2026-09-07").maintenance.referencePredictionErrorKcal,241);
});

test("a contradictory recent weight or unrounded unsafe lower scenario blocks an automated deficit",()=>{
  const evidence={dailyLogs:[0,1,2].map(i=>({date:date(18+i),morningWeightKg:55,complete:false,calories:2000}))};
  const maintenance=nutritionFor(profile(),"2026-09-07",evidence);
  assert.equal(maintenance.weightBasis.requiresReview,true);assert.equal(maintenance.weightBasis.weightKg,75);
  assert.throws(()=>nutritionFor(profile({goal:"fat_loss"}),"2026-09-07",evidence),{code:"DEFICIT_REQUIRES_REVIEW"});
  assert.throws(()=>nutritionFor(profile({sexForEquation:"female",age:32,heightCm:170,weightKg:59.6,lifestyleActivity:"sedentary",goalPace:"gentle",goal:"fat_loss"}),"2026-09-07"),{code:"DEFICIT_REQUIRES_REVIEW"});
});
