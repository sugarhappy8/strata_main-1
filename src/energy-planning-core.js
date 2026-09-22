// @ts-check
"use strict";

const {DAYS}=require("./plans");
const {scenarioFor}=require("./energy-scenarios-core");
const {activityBudget}=require("./energy-activity-core");

const {CALIBRATION_DAYS,MIN_COMPLETE_DAYS,MIN_WEIGHT_DAYS,MIN_WEIGHT_SPAN_DAYS,MODEL_VERSION,calibrateMaintenance:calibrate,deriveWeightAnchor}=require("./energy-calibration-core");
const ENERGY_SEMANTICS=Object.freeze({LEGACY:"legacy_rmr_activity_multiplier",WHOLE_DAY_EER:"nasem_2023_whole_day_eer",STRUCTURED_ACTIVITY:"mifflin_structured_activity_v4"});
const LEGACY_ACTIVITY_FACTORS=Object.freeze({sedentary:1.2,lightly_active:1.375,moderately_active:1.55,very_active:1.725,extremely_active:1.9});
const ACTIVITY_CATEGORY_MAP=Object.freeze({sedentary:"inactive",lightly_active:"low_active",moderately_active:"active",very_active:"very_active",extremely_active:"very_active"});
const NASEM_EER_COEFFICIENTS=Object.freeze({
  male:Object.freeze({
    inactive:Object.freeze({constant:753.07,age:-10.83,height:6.5,weight:14.1}),
    low_active:Object.freeze({constant:581.47,age:-10.83,height:8.3,weight:14.94}),
    active:Object.freeze({constant:1004.82,age:-10.83,height:6.52,weight:15.91}),
    very_active:Object.freeze({constant:-517.88,age:-10.83,height:15.61,weight:19.11})
  }),
  female:Object.freeze({
    inactive:Object.freeze({constant:584.9,age:-7.01,height:5.72,weight:11.71}),
    low_active:Object.freeze({constant:575.77,age:-7.01,height:6.6,weight:12.14}),
    active:Object.freeze({constant:710.25,age:-7.01,height:6.54,weight:12.34}),
    very_active:Object.freeze({constant:511.83,age:-7.01,height:9.07,weight:12.56})
  })
});

/** @param {number} value @param {number} [step] */
function rounded(value,step=1){return Math.round(value/step)*step;}
/** @param {string} date @param {number} offset */
function addDays(date,offset){return new Date(Date.parse(`${date}T00:00:00.000Z`)+offset*86400000).toISOString().slice(0,10);}
/**
 * 2023 National Academies / Health Canada adult EER equation.
 * Height is centimetres and weight is kilograms, matching the published table.
 * @param {{age:number,heightCm:number,weightKg:number,sexForEquation:string,lifestyleActivity:string}} profile
 */
function nasemEer(profile){
  const activityCategories=/** @type {Record<string,string>} */(/** @type {unknown} */(ACTIVITY_CATEGORY_MAP)),tables=/** @type {Record<string,Record<string,{constant:number,age:number,height:number,weight:number}>>} */(/** @type {unknown} */(NASEM_EER_COEFFICIENTS)),activityCategory=activityCategories[profile.lifestyleActivity],bySex=tables[profile.sexForEquation];
  if(profile.age<19||!activityCategory||!bySex)throw new TypeError("The 2023 adult EER equation requires age 19 or older, a published male/female coefficient, and a supported activity category.");
  const coefficients=bySex[activityCategory];
  if(!coefficients)throw new TypeError("The 2023 adult EER activity equation is unavailable.");
  return coefficients.constant+coefficients.age*profile.age+coefficients.height*profile.heightCm+coefficients.weight*profile.weightKg;
}

/** @param {{age:number,heightCm:number,weightKg:number,sexForEquation:string|null}} profile */
function mifflinRmr(profile){if(!profile.sexForEquation)return null;return 10*profile.weightKg+6.25*profile.heightCm-5*profile.age+(profile.sexForEquation==="male"?5:-161);}
/** @param {{weightKg:number,bodyFatPercent:number|null}} profile */
function cunninghamRmr(profile){return profile.bodyFatPercent==null?null:370+21.6*profile.weightKg*(1-profile.bodyFatPercent/100);}

/** @param {any} profile @param {any} [training] */
function baselineFor(profile,training=null){
  const factors=/** @type {Record<string,number>} */(LEGACY_ACTIVITY_FACTORS),categories=/** @type {Record<string,string>} */(/** @type {unknown} */(ACTIVITY_CATEGORY_MAP)),activityFactor=factors[profile.lifestyleActivity],activityCategory=categories[profile.lifestyleActivity],mifflin=mifflinRmr(profile),cunningham=cunninghamRmr(profile);
  const energySemantics=profile.version>=4?ENERGY_SEMANTICS.STRUCTURED_ACTIVITY:profile.version===3?ENERGY_SEMANTICS.WHOLE_DAY_EER:ENERGY_SEMANTICS.LEGACY;
  let raw,primaryEquation,equation,explanation,rmrKcal,rmrEquation,bandRate=.125,minimumBand=250;
  let structuredActivity=null,wholeDayEerCrossCheck=null;
  if(energySemantics===ENERGY_SEMANTICS.STRUCTURED_ACTIVITY&&mifflin!=null){
    rmrKcal=rounded(mifflin);rmrEquation="mifflin_st_jeor";structuredActivity=activityBudget({...profile,rmrKcal:mifflin},training);raw=structuredActivity.targetKcal;primaryEquation="mifflin_structured_activity";equation="mifflin_st_jeor";bandRate=.15;
    const totalPal=raw/mifflin,crossActivity=totalPal<1.53?"sedentary":totalPal<1.68?"lightly_active":totalPal<1.85?"moderately_active":"very_active",crossRaw=nasemEer({...profile,lifestyleActivity:crossActivity});wholeDayEerCrossCheck={equation:"nasem_2023_eer",activityCategory:categories[crossActivity],targetKcal:rounded(crossRaw,25),rawKcal:Math.round(crossRaw*10)/10,referenceErrorKcal:profile.sexForEquation==="male"?342:241,role:"population_cross_check"};
    explanation="The starting estimate uses Mifflin–St Jeor resting energy, a reviewed non-workout movement anchor, and the net energy from the generated STRATA sessions plus separately entered activity. Each activity is counted once.";
  }else if(energySemantics===ENERGY_SEMANTICS.WHOLE_DAY_EER&&profile.age>=19&&profile.sexForEquation){
    if(!activityFactor||!activityCategory)throw new TypeError("A supported whole-day activity value is required.");
    raw=nasemEer(profile);primaryEquation="nasem_2023_eer";equation="nasem_2023_eer";
    rmrKcal=mifflin==null?null:rounded(mifflin);rmrEquation=mifflin==null?null:"mifflin_st_jeor";
    explanation=`The starting estimate uses the 2023 adult EER ${activityCategory.replaceAll("_"," ")} equation. It is a population estimate, not a metabolic measurement.`;
  }else if(energySemantics===ENERGY_SEMANTICS.LEGACY&&cunningham!=null){
    if(!activityFactor||!activityCategory)throw new TypeError("A supported legacy activity value is required.");
    raw=cunningham*activityFactor;primaryEquation="legacy_cunningham_activity_fallback";equation="cunningham_1991";bandRate=.175;minimumBand=350;
    rmrKcal=rounded(cunningham);rmrEquation="cunningham_1991";
    explanation="This saved profile predates whole-day EER activity categories, so STRATA preserves its Cunningham lean-mass estimate × original activity multiplier until the profile is reviewed and saved. Body-fat estimates can be noisy.";
  }else if(energySemantics===ENERGY_SEMANTICS.LEGACY&&mifflin!=null){
    if(!activityFactor||!activityCategory)throw new TypeError("A supported legacy activity value is required.");
    raw=mifflin*activityFactor;primaryEquation="legacy_mifflin_activity_fallback";equation="mifflin_st_jeor";bandRate=.15;minimumBand=300;
    rmrKcal=rounded(mifflin);rmrEquation="mifflin_st_jeor";
    explanation="This saved profile predates whole-day EER activity categories, so STRATA preserves its Mifflin–St Jeor estimate × original activity multiplier until the profile is reviewed and saved.";
  }else throw new TypeError("No compatible energy equation is available.");
  const targetKcal=rounded(raw,25),referenceErrorKcal=primaryEquation==="nasem_2023_eer"?(profile.sexForEquation==="male"?342:241):wholeDayEerCrossCheck?.referenceErrorKcal??null,compositionDifferenceKcal=energySemantics!==ENERGY_SEMANTICS.STRUCTURED_ACTIVITY||cunningham==null||rmrKcal==null?null:rounded(Math.abs(cunningham-rmrKcal),25),basePlanningBandKcal=rounded(Math.max(minimumBand,targetKcal*bandRate,referenceErrorKcal||0),25),band=Math.max(basePlanningBandKcal,compositionDifferenceKcal||0);
  return {targetKcal,rawKcal:Math.round(raw*10)/10,equation,primaryEquation,energySemantics,activityCategory:structuredActivity?null:activityCategory,activityFactor:energySemantics===ENERGY_SEMANTICS.LEGACY?activityFactor:null,legacyActivityFactor:activityFactor||null,rmrKcal,rmrEquation,bodyFatCrossCheck:cunningham==null||primaryEquation==="legacy_cunningham_activity_fallback"?null:{equation:"cunningham_1991",rmrKcal:rounded(cunningham),role:"secondary_cross_check"},structuredActivity,wholeDayEerCrossCheck,planningBandKcal:band,basePlanningBandKcal,compositionDifferenceKcal,referenceErrorKcal,explanation};
}

/** @param {any} profile @param {string} weekStart @param {unknown} evidence @param {ReturnType<typeof baselineFor>|null} [baseline] @param {any} [training] */
function calibrateMaintenance(profile,weekStart,evidence,baseline=null,training=null){return calibrate(profile,weekStart,evidence,baseline||baselineFor(profile,training));}

/** Preserve an exact weekly calorie budget while distributing daily weights. @param {number} target @param {number[]} weights */
function distribute(target,weights){
  const total=rounded(target)*7,sum=weights.reduce((value,weight)=>value+weight,0),raw=weights.map(weight=>total*weight/sum),days=raw.map(Math.floor),order=raw.map((value,index)=>({index,remainder:value-Math.floor(value)})).sort((a,b)=>b.remainder-a.remainder||a.index-b.index);
  for(let remaining=total-days.reduce((a,b)=>a+b,0),index=0;remaining>0;remaining-=1,index+=1){const slot=order[index]?.index??0;days[slot]=(days[slot]??0)+1;}return days;
}
/** Integer grams reconcile exactly with the 4/4/9 planning convention. @param {number} calories @param {number} weightKg @param {string|null} preference @param {string} goal */
function macroTarget(calories,weightKg,preference,goal){
  if(!preference)return null;
  const requestedRate=preference==="higher_protein"?2:goal==="fat_loss"?1.8:1.6,requestedProteinG=rounded(weightKg*requestedRate),protein=Math.min(requestedProteinG,Math.floor(calories*.3/4)),desiredFat=calories*.25/9;
  const fatCandidates=Array.from({length:7},(_,i)=>Math.max(0,Math.floor(desiredFat)-3+i)).filter(fat=>(calories-9*fat)%4===0&&calories-4*protein-9*fat>=0),fat=fatCandidates.sort((a,b)=>Math.abs(a-desiredFat)-Math.abs(b-desiredFat)||a-b)[0]??0,carbs=(calories-protein*4-fat*9)/4;
  return {proteinG:protein,carbsG:carbs,fatG:fat,requestedProteinG,actualProteinGPerKg:Math.round(protein/weightKg*100)/100,energyKcal:4*protein+4*carbs+9*fat,proteinBasis:`${requestedRate} g/kg requested; ${protein<requestedProteinG?"reduced to respect the 30% energy cap":"met at the planning weight"}`,fatBasis:"approximately 25% of energy",carbohydrateBasis:"remaining energy",adjustmentReason:protein<requestedProteinG?"The protein request exceeds 30% of this calorie budget. The displayed grams are the actual target; review individual protein needs with a qualified professional.":null};
}
/** @param {number} weightKg @param {number} dailyCalorieDelta @param {number} weeks */
function weightScenario(weightKg,dailyCalorieDelta,weeks){const days=weeks*7,changeLb=dailyCalorieDelta/10*(1-Math.exp(-Math.log(2)*days/365)),changeKg=changeLb*.45359237,center=Math.max(0,weightKg+changeKg),uncertainty=Math.max(.5,Math.abs(changeKg)*.4);return {center,uncertainty};}
/** @param {number} weightKg @param {number} dailyCalorieDelta */
function weightScenarios(weightKg,dailyCalorieDelta){return [4,8,12].map((weeks)=>{const {center,uncertainty}=weightScenario(weightKg,dailyCalorieDelta,weeks);return {weeks,weightKg:Math.round(center*10)/10,rangeKg:[Math.round(Math.max(0,center-uncertainty)*10)/10,Math.round((center+uncertainty)*10)/10]};});}

/** @param {any} profile @param {string} weekStart @param {unknown} [evidence] @param {any} [training] */
function nutritionFor(profile,weekStart,evidence=null,training=null){
  const weightBasis=deriveWeightAnchor(profile,weekStart,evidence),compositionNeedsReview=profile.version>=4&&profile.bodyFatPercent!=null&&!weightBasis.bodyFatCompatible,planningProfile={...profile,weightKg:weightBasis.weightKg,bodyFatPercent:weightBasis.bodyFatCompatible?profile.bodyFatPercent:null},baseline=baselineFor(planningProfile,training),calibration=calibrateMaintenance(profile,weekStart,evidence,baseline),maintenance=calibration.targetKcal,band=baseline.planningBandKcal,maintenanceLow=rounded(Math.max(0,maintenance-band),25),maintenanceHigh=rounded(maintenance+band,25),heightM=profile.heightCm/100,rawBmi=planningProfile.weightKg/heightM**2,bmi=Math.round(rawBmi*10)/10,legacyDeficitRate=profile.goalPace==="gentle"?.1:.15,surplusRate=profile.goalPace==="gentle"?.05:.075;
  const requestedWeightRate=profile.goalPace==="gentle"?.0025:.005,rawWeightRateDelta=planningProfile.weightKg*requestedWeightRate*7700/7,weightRateDelta=Math.floor(rawWeightRateDelta/25)*25,maintenanceFractionCap=Math.floor(maintenance*.2/25)*25,deficitDelta=profile.version>=4?Math.min(500,maintenanceFractionCap,weightRateDelta):Math.min(500,rounded(maintenance*legacyDeficitRate,25)),surplusDelta=Math.min(250,Math.max(100,rounded(maintenance*surplusRate,25))),averageExerciseKcal=(baseline.structuredActivity?.activityWeekKcal||0)/7,fatFreeMassKg=planningProfile.bodyFatPercent==null?null:planningProfile.weightKg*(1-planningProfile.bodyFatPercent/100),energyAvailabilityFloor=fatFreeMassKg==null?null:Math.ceil((30*fatFreeMassKg+averageExerciseKcal)/25)*25,reviewFloor=Math.max(1200,profile.version>=4&&energyAvailabilityFloor!=null?energyAvailabilityFloor:0),candidateDeficit=Math.max(reviewFloor,maintenance-deficitDelta),minimumSafeWeight=18.5*heightM**2,candidateDelta=candidateDeficit-maintenance,planningRangeKcal=[maintenanceLow,maintenanceHigh],deficitScenarios=profile.version>=3?scenarioFor(planningProfile.weightKg,candidateDeficit,{targetKcal:maintenance,planningRangeKcal}):null;
  const scenarioGuardApplied=deficitScenarios?!deficitScenarios.every(scenario=>Math.min(...scenario.rawRangeKg,...scenario.rangeKg)>=minimumSafeWeight):![4,8,12].every((weeks)=>{const {center,uncertainty}=weightScenario(planningProfile.weightKg,candidateDelta,weeks),lower=Math.max(0,center-uncertainty),displayedLower=Math.round(lower*10)/10;return lower>=minimumSafeWeight&&displayedLower>=minimumSafeWeight;}),compositionRangeExpanded=profile.version>=4&&baseline.compositionDifferenceKcal!=null&&baseline.compositionDifferenceKcal>baseline.basePlanningBandKcal;
  const deficitAllowed=!weightBasis.requiresReview&&!weightBasis.recentUnderweight&&!compositionNeedsReview&&rawBmi>=18.5&&maintenance>reviewFloor&&candidateDelta<0&&!scenarioGuardApplied,deficit=deficitAllowed?candidateDeficit:null,bulk=maintenance+surplusDelta,selected=profile.goal==="fat_loss"?deficit:profile.goal==="muscle_gain"?bulk:maintenance;
  if(selected==null)throw Object.assign(new Error(compositionNeedsReview?"Recent weight differs by more than 2% from the weight paired with your saved body-fat estimate. Update or remove that estimate before generating a deficit; maintenance remains available.":compositionRangeExpanded&&scenarioGuardApplied?"Your optional body-fat cross-check differs enough from the primary resting estimate to widen the planning range, and the lower sensitivity scenario falls outside this planner’s limits. Review the estimate or choose maintenance and seek qualified advice.":"A calorie deficit requires review because recent weight, the lower sensitivity scenario, or the calorie floor falls outside this planner’s limits. Review your profile, choose maintenance, and seek qualified advice."),{code:"DEFICIT_REQUIRES_REVIEW",status:422});
  if(selected<1200)throw Object.assign(new Error("An automated calorie target cannot be generated below the conservative 1,200 kcal review floor. Speak with a qualified clinician."),{code:"CALORIE_TARGET_REQUIRES_REVIEW",status:422});
  const trainingEnergyByDay=new Map((baseline.structuredActivity?.sessions||[]).map(session=>[session.day,session.kcal])),averagePlannedTraining=(baseline.structuredActivity?.plannedTrainingWeekKcal||0)/7;
  let weights=Array(7).fill(1),effectivePattern=profile.caloriePattern,patternFallback=null;if(profile.caloriePattern==="zigzag"){if(profile.version>=4&&averagePlannedTraining<=0){effectivePattern="steady";patternFallback="No usable generated session has an activity contribution this week, so calorie targets stay steady rather than claiming a training-day shift.";}else weights=profile.version>=4?DAYS.map((day)=>Math.max(.1,(selected-averagePlannedTraining+(trainingEnergyByDay.get(day)||0))/selected)):DAYS.map((day)=>profile.workoutDays.includes(day)?1.075:.925);}if(profile.caloriePattern==="flexible_day")weights=DAYS.map((day)=>day===profile.flexibleDay?1.15:.975);let calories=distribute(selected,weights);
  const dailyFloor=profile.version>=4&&profile.goal==="fat_loss"?reviewFloor:1200;
  if(Math.min(...calories)<dailyFloor){calories=distribute(selected,Array(7).fill(1));effectivePattern="steady";patternFallback=dailyFloor>1200?`The requested variation would create a day below the ${dailyFloor.toLocaleString("en-US")} kcal composition review floor already applied to your deficit, so this week uses steady targets.`:"The requested variation would create a day below the conservative 1,200 kcal floor, so this week uses steady targets.";}
  const dailyTargets=DAYS.map((day,index)=>{const dailyCalories=calories[index]??selected,hasTraining=(trainingEnergyByDay.get(day)||0)>0;return {day,date:addDays(weekStart,index),calories:dailyCalories,macros:macroTarget(dailyCalories,planningProfile.weightKg,profile.macroPreference,profile.goal),kind:effectivePattern==="zigzag"?(hasTraining||profile.version<4&&profile.workoutDays.includes(day)?"higher_training_day":"lower_rest_day"):effectivePattern==="flexible_day"&&day===profile.flexibleDay?"flexible_day":"standard"};});
  const activityFactorBasis=baseline.energySemantics===ENERGY_SEMANTICS.STRUCTURED_ACTIVITY?"Non-workout movement sets a conservative PAL anchor. Net generated-session energy and separately entered activity are added once; unavailable sessions add zero.":baseline.primaryEquation==="nasem_2023_eer"?"The reviewed profile activity value selects a 2023 whole-day EER category. No resting-energy multiplier is applied; legacyActivityFactor is supplied only to explain old snapshots.":"This unreviewed legacy profile preserves its original resting-energy × activityFactor interpretation and uses a broader planning band.";
  const actualDeficit=deficit==null?null:maintenance-deficit,actualWeightRate=actualDeficit==null?null:actualDeficit*7/(7700*planningProfile.weightKg),bodyFatRole=profile.bodyFatPercent==null?"not_entered":profile.version<4?"Used only for the preserved resting-energy cross-check; version 3 does not apply the composition screen.":compositionNeedsReview?"Recent weight differs too much to reuse the saved body-fat estimate; the composition check is withheld and an automated deficit requires profile review.":"Used as a noisy resting-energy cross-check, for a conservative fat-free-mass energy-availability screen, and to widen the planning band when it materially disagrees with Mifflin; it never raises maintenance.",deficitBreakdown={requestedWeightChangePercentPerWeek:profile.version>=4?requestedWeightRate*100:null,requestedWeightChangeKgPerWeek:profile.version>=4?Math.round(planningProfile.weightKg*requestedWeightRate*1000)/1000:null,weightRateDeficitKcal:profile.version>=4?weightRateDelta:null,maximumMaintenanceFraction:profile.version>=4?0.2:null,maintenanceFractionCapKcal:profile.version>=4?maintenanceFractionCap:null,maximumDeficitKcal:500,energyAvailabilityFloorKcal:profile.version>=4?energyAvailabilityFloor:null,energyAvailabilityGuardApplied:profile.version>=4&&energyAvailabilityFloor!=null&&energyAvailabilityFloor>maintenance-deficitDelta,scenarioGuardApplied:profile.version>=4?scenarioGuardApplied:null,compositionDifferenceKcal:profile.version>=4?baseline.compositionDifferenceKcal:null,compositionRangeExpanded:profile.version>=4?compositionRangeExpanded:null,actualDeficitKcal:actualDeficit,actualWeightChangePercentPerWeek:profile.version>=4&&actualWeightRate!=null?Math.round(actualWeightRate*10000)/100:null,bodyFatRole};
  return {bmi,weightBasis,equation:baseline.equation,primaryEquation:baseline.primaryEquation,energySemantics:baseline.energySemantics,rmrKcal:baseline.rmrKcal,rmrEquation:baseline.rmrEquation,bodyFatCrossCheck:baseline.bodyFatCrossCheck,wholeDayEerCrossCheck:baseline.wholeDayEerCrossCheck,activityBreakdown:baseline.structuredActivity,activityFactor:baseline.activityFactor,legacyActivityFactor:baseline.legacyActivityFactor,activityCategory:baseline.activityCategory,activityFactorBasis,maintenance:{targetKcal:maintenance,baselineKcal:baseline.targetKcal,rawBaselineKcal:baseline.rawKcal,referencePredictionErrorKcal:baseline.referenceErrorKcal,referencePredictionErrorBasis:"NASEM Table 5-8 reference standard error at mean adult covariates; not a personalized confidence interval.",estimateRangeKcal:[maintenanceLow,maintenanceHigh],planningRangeKcal:[maintenanceLow,maintenanceHigh],rangeLabel:"Conservative STRATA planning band; not a confidence interval or measured expenditure.",equationExplanation:baseline.explanation,calibration},deficit:{targetKcal:deficit,policy:profile.version>=4?`${profile.goalPace==="gentle"?"0.25":"0.50"}% body-weight change per week requested; capped at 20% of maintenance and 500 kcal/day, with BMI, 1,200-kcal, scenario, and optional composition review guards`:`${Math.round(legacyDeficitRate*100)}% below estimated maintenance, capped at 500 kcal/day and never below 1,200 kcal/day`,breakdown:deficitBreakdown},bulk:{targetKcal:bulk,policy:`About ${surplusRate*100}% above estimated maintenance, bounded to 100–250 kcal/day`},selectedGoal:profile.goal,goalPace:profile.goalPace,requestedPattern:profile.caloriePattern,effectivePattern,patternFallback,weeklyTargetKcal:calories.reduce((a,b)=>a+b,0),dailyTargets,weightScenarios:profile.version>=3?scenarioFor(planningProfile.weightKg,selected,{targetKcal:maintenance,planningRangeKcal}):weightScenarios(planningProfile.weightKg,selected-maintenance)};
}

module.exports={ACTIVITY_CATEGORY_MAP,CALIBRATION_DAYS,ENERGY_SEMANTICS,LEGACY_ACTIVITY_FACTORS,MIN_COMPLETE_DAYS,MIN_WEIGHT_DAYS,MIN_WEIGHT_SPAN_DAYS,MODEL_VERSION,NASEM_EER_COEFFICIENTS,baselineFor,calibrateMaintenance,distribute,macroTarget,nasemEer,nutritionFor};
