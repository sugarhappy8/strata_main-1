/* global module, require */
(function(root,factory){
  const energyUi=typeof module==="object"&&module.exports?require("./personal-training-energy-ui-core"):root.StrataPersonalTrainingEnergyUi;
  const api=factory(energyUi);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPersonalTrainingUi=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(energyUi){
  "use strict";

  const DAYS=Object.freeze(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]);
  const UNIT_SYSTEMS=Object.freeze(["metric","imperial"]);
  const TRAINING_GOALS=Object.freeze(["balanced","strength","hypertrophy"]);
  const GOALS=Object.freeze(["fat_loss","maintenance","muscle_gain"]);
  const EXPERIENCE_LEVELS=Object.freeze(["beginner","intermediate","advanced"]);
  const CALORIE_PATTERNS=Object.freeze(["steady","zigzag","flexible_day"]);
  const SESSION_MINUTES=Object.freeze([30,45,60,75,90]);
  const GOAL_ALIASES=Object.freeze({deficit:"fat_loss",fat_loss:"fat_loss",maintenance:"maintenance",bulk:"muscle_gain",surplus:"muscle_gain",muscle_gain:"muscle_gain"});
  const PATTERN_ALIASES=Object.freeze({steady:"steady","training-day":"zigzag",training_day:"zigzag",zigzag:"zigzag","flexible-day":"flexible_day",flexible_day:"flexible_day"});
  const KG_PER_LB=0.45359237;
  const CM_PER_INCH=2.54;

  function isRecord(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
  function round(value,digits=0){const scale=10**digits;return Math.round((Number(value)+Number.EPSILON)*scale)/scale;}
  function finiteNumber(value){
    if(value==null||value==="")return null;
    const parsed=typeof value==="string"?Number(value.trim().replace(",",".")):Number(value);
    return Number.isFinite(parsed)?parsed:null;
  }
  function boundedNumber(value,min,max,{whole=false}={}){
    const parsed=finiteNumber(value);
    if(parsed==null||parsed<min||parsed>max||(whole&&!Number.isInteger(parsed)))return null;
    return parsed;
  }
  function uniqueStrings(values){return [...new Set((Array.isArray(values)?values:[]).map((value)=>String(value||"").trim()).filter(Boolean))];}
  function allowedValue(value,allowed){const normalized=String(value||"").trim().toLowerCase();return allowed.includes(normalized)?normalized:"";}
  function aliasedValue(value,aliases){return aliases[String(value||"").trim().toLowerCase()]||"";}
  function validExerciseId(value){return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)&&value.length<=80;}

  // At two decimals the advertised imperial endpoints (661.4 lb, 47.24 in) land a hair outside the metric range; snap them onto it.
  function snap(value,min,max){return value==null?null:value<min&&min-value<.02?min:value>max&&value-max<.02?max:value;}
  function poundsToKilograms(value){const number=finiteNumber(value);return number==null?null:round(number*KG_PER_LB,2);}
  function kilogramsToPounds(value){const number=finiteNumber(value);return number==null?null:round(number/KG_PER_LB,1);}
  function inchesToCentimeters(value){const number=finiteNumber(value);return number==null?null:round(number*CM_PER_INCH,2);}
  function centimetersToInches(value){const number=finiteNumber(value);return number==null?null:round(number/CM_PER_INCH,2);}

  function heightToCentimeters(draft){
    if(draft?.height!==undefined){
      const height=finiteNumber(draft.height);
      return height==null?null:draft.heightUnit==="in"?inchesToCentimeters(height):height;
    }
    const canonical=finiteNumber(draft?.heightCm);
    if(canonical!=null)return canonical;
    if(draft?.unitSystem!=="imperial")return finiteNumber(draft?.heightCm);
    const feet=finiteNumber(draft?.heightFeet),inches=finiteNumber(draft?.heightInches);
    if(feet==null||!Number.isInteger(feet)||inches==null||inches<0||inches>=12)return null;
    return inchesToCentimeters(feet*12+inches);
  }
  function heightFromCentimeters(heightCm,unitSystem="metric"){
    const centimeters=finiteNumber(heightCm);
    if(centimeters==null)return{heightCm:"",heightFeet:"",heightInches:""};
    if(unitSystem!=="imperial")return{heightCm:round(centimeters,1),heightFeet:"",heightInches:""};
    const totalInches=centimetersToInches(centimeters),baseFeet=Math.floor(totalInches/12),roundedInches=round(totalInches-baseFeet*12,1),carry=roundedInches>=12?1:0;
    return{heightCm:"",heightFeet:baseFeet+carry,heightInches:carry?0:roundedInches};
  }
  function weightToKilograms(draft){return draft?.unitSystem==="imperial"?poundsToKilograms(draft?.weightLb):finiteNumber(draft?.weightKg);}
  function weightFromKilograms(weightKg,unitSystem="metric"){
    const kilograms=finiteNumber(weightKg);
    if(kilograms==null)return{weightKg:"",weightLb:""};
    return unitSystem==="imperial"?{weightKg:"",weightLb:kilogramsToPounds(kilograms)}:{weightKg:round(kilograms,2),weightLb:""};
  }

  function normalizedPerformanceMaxes(values,preferredLoadUnit,errors){
    const output=[],seen=new Set();
    for(const [index,entry] of (Array.isArray(values)?values:[]).entries()){
      if(!isRecord(entry))continue;
      const exerciseId=String(entry.exerciseId||"").trim();
      if(!validExerciseId(exerciseId)){errors.push({field:`performanceMaxes.${index}.exerciseId`,message:"Choose an exercise from STRATA's library."});continue;}
      if(seen.has(exerciseId)){errors.push({field:`performanceMaxes.${index}.exerciseId`,message:"Record each known exercise once."});continue;}
      const rawSets=entry.maxSets??entry.sets,rawReps=entry.maxReps??entry.reps,rawWeight=entry.maxWeightKg??entry.maxWeight??entry.weight??entry.load;
      const maxSets=boundedNumber(rawSets,1,20,{whole:true}),maxReps=boundedNumber(rawReps,1,100,{whole:true}),hasWeight=rawWeight!==""&&rawWeight!=null;
      const enteredWeight=finiteNumber(rawWeight),loadUnit=entry.maxWeightKg!=null||entry.unit==="kg"||entry.weightUnit==="kg"?"kg":entry.unit==="lb"||entry.weightUnit==="lb"?"lb":preferredLoadUnit,maxWeightKg=enteredWeight==null?null:round(loadUnit==="lb"?enteredWeight*KG_PER_LB:enteredWeight,2);
      if(maxSets==null)errors.push({field:`performanceMaxes.${index}.maxSets`,message:"Enter 1–20 sets for this exercise."});
      if(maxReps==null)errors.push({field:`performanceMaxes.${index}.maxReps`,message:"Enter 1–100 reps for this exercise."});
      if(hasWeight&&(enteredWeight==null||maxWeightKg<0||maxWeightKg>1000))errors.push({field:`performanceMaxes.${index}.maxWeight`,message:"Enter a load from 0–1,000 kg, or leave it blank for bodyweight work."});
      if(maxSets==null||maxReps==null)continue;
      seen.add(exerciseId);
      output.push({exerciseId,maxSets,maxReps,maxWeightKg:maxWeightKg==null?null:round(maxWeightKg,2)});
    }
    return output;
  }

  function profileDraftToMetric(draft){
    const source=isRecord(draft)?draft:{},errors=[];
    const inferredSystem=source.heightUnit==="in"||source.weightUnit==="lb"?"imperial":"metric",measurementSystem=allowedValue(source.measurementSystem??source.unitSystem,UNIT_SYSTEMS)||inferredSystem;
    const preferredLoadUnit=source.preferredLoadUnit==="lb"||source.preferredLoadUnit==="kg"?source.preferredLoadUnit:measurementSystem==="imperial"?"lb":"kg";
    const age=boundedNumber(source.age,19,80,{whole:true});
    const heightCm=heightToCentimeters({...source,unitSystem:measurementSystem}),hasFormWeight=source.weight!==undefined,hasCanonicalWeight=finiteNumber(source.weightKg)!=null,enteredWeight=finiteNumber(hasFormWeight?source.weight:hasCanonicalWeight?source.weightKg:source.weightLb),weightKg=enteredWeight==null?null:hasFormWeight?source.weightUnit==="lb"?dailyWeightToKilograms(enteredWeight,"imperial"):enteredWeight:hasCanonicalWeight?enteredWeight:measurementSystem==="imperial"?dailyWeightToKilograms(enteredWeight,"imperial"):enteredWeight;
    const trainingGoal=source.trainingGoal==null?"balanced":allowedValue(source.trainingGoal,TRAINING_GOALS);if(!trainingGoal)errors.push({field:"trainingGoal",message:"Choose balanced training, strength, or muscle growth."});
    const bodyFatRaw=finiteNumber(source.bodyFatPercent),bodyFatPercent=bodyFatRaw==null?null:boundedNumber(bodyFatRaw,3,65);
    const sexForEquation=String(source.sexForEquation||source.sex||"").trim().toLowerCase();
    const goal=aliasedValue(source.goal,GOAL_ALIASES),experience=allowedValue(source.experience,EXPERIENCE_LEVELS),caloriePattern=aliasedValue(source.caloriePattern,PATTERN_ALIASES)||"steady",energy=energyUi.profileDraftToEnergy(source);
    const workoutDays=uniqueStrings(source.trainingDays??source.workoutDays??source.availableDays).filter((day)=>DAYS.includes(day));
    const frequency=boundedNumber(source.frequency??source.trainingDaysPerWeek??workoutDays.length,1,6,{whole:true}),sessionMinutes=boundedNumber(source.sessionMinutes,30,90,{whole:true});
    if(age==null)errors.push({field:"age",message:"New STRATA energy estimates are for adults ages 19–80."});
    if(heightCm==null||snap(round(heightCm,2),120,230)<120||snap(round(heightCm,2),120,230)>230)errors.push({field:"height",message:"Enter a height from 120–230 cm (3 ft 11 in–7 ft 7 in)."});
    if(weightKg==null||weightKg<35||weightKg>300)errors.push({field:"weight",message:"Enter a weight from 35–300 kg (77.2–661.4 lb)."});
    if(bodyFatRaw!=null&&bodyFatPercent==null)errors.push({field:"bodyFatPercent",message:"Enter 3–65%, or leave body fat blank."});
    if(!['female','male'].includes(sexForEquation))errors.push({field:"sexForEquation",message:"Choose the coefficient required by the primary energy equation."});
    errors.push(...energy.errors);
    if(!goal)errors.push({field:"goal",message:"Choose deficit, maintenance, or building."});
    if(!experience)errors.push({field:"experience",message:"Choose your current training experience."});
    if(frequency==null)errors.push({field:"frequency",message:"Choose one to six training days."});
    if(!workoutDays.length||workoutDays.length>6)errors.push({field:"trainingDays",message:"Choose one to six available days and leave at least one recovery day."});
    if(frequency!=null&&workoutDays.length&&frequency!==workoutDays.length)errors.push({field:"trainingDays",message:"The selected days must match the weekly training frequency."});
    if(source.sessionMinutes!==undefined&&!SESSION_MINUTES.includes(sessionMinutes))errors.push({field:"sessionMinutes",message:"Choose a listed workout duration."});
    const usualExercises=normalizedPerformanceMaxes(source.performanceMaxes??source.usualExercises,preferredLoadUnit,errors);
    const goalPace=source.goalPace==="gentle"||source.goalPace==="moderate"?source.goalPace:"moderate";
    const macroPreference=source.macrosEnabled===false?null:source.macroPreference==="higher_protein"||source.macroPreference==="balanced"?source.macroPreference:source.macrosEnabled===true?"balanced":null;
    const payload={
      version:4,measurementSystem,preferredLoadUnit,age,heightCm:heightCm==null?null:snap(round(heightCm,2),120,230),weightKg:weightKg==null?null:round(weightKg,2),bodyFatPercent,
      sexForEquation:['female','male'].includes(sexForEquation)?sexForEquation:null,
      goal,goalPace,trainingGoal,experience,...energy.payload,workoutDays,sessionMinutes:sessionMinutes??45,usualExercises,
      availableEquipment:uniqueStrings(source.equipment??source.availableEquipment),movementLimitations:uniqueStrings(source.limitations??source.movementLimitations),caloriePattern,flexibleDay:DAYS.includes(source.flexibleDay)?source.flexibleDay:null,
      macroPreference,timeZone:String(source.timeZone||"UTC")
    };
    if(caloriePattern==="flexible_day"&&!payload.flexibleDay)errors.push({field:"flexibleDay",message:"Choose the day that should have the flexible calorie budget."});
    return{ok:errors.length===0,payload,errors,unitSystem:measurementSystem};
  }

  function profileMetricToDraft(profile,unitSystem="metric"){
    const source=isRecord(profile)?profile:{},system=allowedValue(unitSystem,UNIT_SYSTEMS)||"metric",imperial=system==="imperial",height=imperial?centimetersToInches(source.heightCm):finiteNumber(source.heightCm),weight=imperial?kilogramsToPounds(source.weightKg):finiteNumber(source.weightKg);
    const goal={fat_loss:"deficit",maintenance:"maintenance",muscle_gain:"surplus"}[source.goal]||source.goal||"maintenance",caloriePattern={steady:"steady",zigzag:"training_day",flexible_day:"flexible_day"}[source.caloriePattern]||"steady",energy=energyUi.profileEnergyToDraft(source);
    return{
      ...source,unitSystem:system,height:height==null?"":round(height,imperial?2:1),heightUnit:imperial?"in":"cm",weight:weight==null?"":round(weight,1),weightUnit:imperial?"lb":"kg",
      bodyFatPercent:source.bodyFatPercent??"",sexForEquation:source.sexForEquation??source.sex??"",goal,...energy,
      frequency:Array.isArray(source.workoutDays)?source.workoutDays.length:"",trainingDays:Array.isArray(source.workoutDays)?[...source.workoutDays]:[],sessionMinutes:source.sessionMinutes??45,
      caloriePattern,macrosEnabled:source.macroPreference!=null,macroPreference:source.macroPreference??"balanced",
      performanceMaxes:(Array.isArray(source.usualExercises)?source.usualExercises:[]).map((entry)=>({
        exerciseId:String(entry?.exerciseId||""),sets:entry?.maxSets??"",reps:entry?.maxReps??"",
        load:entry?.maxWeightKg==null?"":imperial?kilogramsToPounds(entry.maxWeightKg):round(entry.maxWeightKg,1),unit:imperial?"lb":"kg"
      }))
    };
  }

  function calorieProgress(targetCalories,consumedCalories=0){
    const target=boundedNumber(targetCalories,1,20_000,{whole:true}),consumed=boundedNumber(consumedCalories,0,100_000,{whole:true});
    if(target==null)throw new TypeError("A positive daily calorie target is required.");
    if(consumed==null)throw new TypeError("Calories eaten must be zero or a positive whole number.");
    const difference=target-consumed,remaining=Math.max(0,difference),overBy=Math.max(0,-difference),status=overBy>0?"over":difference===0?"met":"remaining";
    return{targetCalories:target,consumedCalories:consumed,remainingCalories:remaining,overByCalories:overBy,status,progressPercent:Math.min(100,round(consumed/target*100)),summary:status==="over"?`${overBy.toLocaleString()} kcal above the selected day's planning target`:status==="met"?"The selected day's planning target is met":`${remaining.toLocaleString()} kcal remaining for the selected day`};
  }

  function macroProgress(targets,consumed={}){
    if(!isRecord(targets))return null;
    const nutrient=(key,apiKey)=>{
      const target=boundedNumber(targets[key]??targets[apiKey],0,2_000,{whole:true}),eaten=boundedNumber(consumed?.[key]??consumed?.[apiKey]??0,0,5_000,{whole:true});
      if(target==null||eaten==null)return null;
      return{targetGrams:target,consumedGrams:eaten,remainingGrams:Math.max(0,target-eaten),overByGrams:Math.max(0,eaten-target),progressPercent:target===0?0:Math.min(100,round(eaten/target*100))};
    };
    const output={protein:nutrient("proteinGrams","proteinG"),fat:nutrient("fatGrams","fatG"),carbs:nutrient("carbGrams","carbsG")};
    return Object.values(output).some(Boolean)?output:null;
  }

  function weeklyCalorieProgress(days){
    const rows=(Array.isArray(days)?days:[]).map((entry,index)=>{
      const day=DAYS.includes(entry?.day)?entry.day:DAYS[index]||"Day";
      return{day,date:String(entry?.date||""),...calorieProgress(entry?.targetCalories??entry?.calories,entry?.consumedCalories??entry?.consumed??0)};
    });
    const targetCalories=rows.reduce((sum,row)=>sum+row.targetCalories,0),consumedCalories=rows.reduce((sum,row)=>sum+row.consumedCalories,0),difference=targetCalories-consumedCalories;
    return{days:rows,targetCalories,consumedCalories,remainingCalories:Math.max(0,difference),overByCalories:Math.max(0,-difference),complete:rows.length===7};
  }

  // Two decimals (0.01 kg ≈ 0.02 lb) so every 0.1 lb entry reads back exactly as typed.
  function dailyWeightToKilograms(value,unitSystem="metric"){const entered=finiteNumber(value);if(entered==null)return null;if(unitSystem==="imperial")return entered<77.2||entered>661.4?null:snap(round(entered*KG_PER_LB,2),35,300);return round(entered,2);}
  function dailyWeightFromKilograms(valueKg,unitSystem="metric"){const kilograms=finiteNumber(valueKg);return kilograms==null?null:unitSystem==="imperial"?kilogramsToPounds(kilograms):round(kilograms,1);}

  function calibrationDisplay(value){
    const source=isRecord(value)?value:{},allowed=["starting","calibrating","trend_informed","legacy_profile"],status=allowed.includes(source.status)?source.status:"starting";
    const count=(input,fallback=0)=>{const parsed=boundedNumber(input,0,10_000,{whole:true});return parsed==null?fallback:parsed;};
    const evidence=isRecord(source.evidence)?source.evidence:source,requiredCompleteDays=count(evidence.requiredCompleteCalorieDays??source.requiredCompleteDays,14),requiredWeightDays=count(evidence.requiredMorningWeightDays??source.requiredWeightDays,8),requiredWeightSpanDays=count(evidence.requiredWeightObservationSpanDays??source.requiredWeightSpanDays,14),windowDays=count(source.windowDays,source.windowStart&&source.windowEnd?Math.round((Date.parse(source.windowEnd)-Date.parse(source.windowStart))/86400000)+1:42),completeDays=count(evidence.completeCalorieDays??source.completeDays),weightDays=count(evidence.morningWeightDays??source.weightDays),weightSpanDays=count(evidence.weightObservationSpanDays??source.weightSpanDays);
    const copy={starting:{title:"Starting estimate",label:"Formula estimate"},calibrating:{title:"Calibrating from your logs",label:"Calibration in progress"},trend_informed:{title:"Trend-informed estimate",label:"Trend informed"},legacy_profile:{title:"Starting estimate",label:"Legacy profile"}}[status];
    const defaults={starting:"This is a formula-based planning estimate. Complete intake totals and comparable morning weights can make a future weekly estimate more personal.",calibrating:"STRATA is collecting complete intake totals and comparable morning weights. It will keep the current planning estimate until the evidence window is ready.",trend_informed:"This week uses your completed intake records and smoothed morning-weight trend as a cross-check on the formula estimate.",legacy_profile:"This saved profile predates calorie calibration. Review the profile once, then complete daily totals and comparable morning weights to begin."},explanation=String(source.explanation||defaults[status]);
    const limitations=Array.isArray(source.limitations)?source.limitations.map((item)=>String(item||"").trim()).filter(Boolean):source.limitations?String(source.limitations):"Day-to-day scale changes reflect water, glycogen, digestion, and measurement conditions as well as tissue change.";
    const priorState=["held","expired","rate_limiter"].includes(source.priorState)?source.priorState:"none",interval=isRecord(source.interval)?source.interval:null,quality=isRecord(source.quality)?source.quality:null,sensitivity=isRecord(source.sensitivity)&&Array.isArray(source.sensitivity.rangeKcal)&&source.sensitivity.rangeKcal.length===2&&source.sensitivity.rangeKcal.every((x)=>finiteNumber(x)!=null&&Number(x)>=0)?source.sensitivity:null;
    const weeklyChangeKcal=finiteNumber(source.weeklyChangeKcal),adjusted=priorState==="held"&&weeklyChangeKcal!=null&&weeklyChangeKcal!==0;
    return{status,modelVersion:String(source.modelVersion||""),weeklyChangeKcal,title:priorState==="held"?(adjusted?"Previous estimate adjusted":"Previous estimate held"):copy.title,label:priorState==="held"?(adjusted?"Previous estimate adjusted":"Previous estimate held"):priorState==="expired"?"Previous evidence expired":copy.label,priorState,interval,quality,sensitivity,alignedIntakeDays:count(evidence.alignedIntakeDays),lastAcceptedEvidenceEnd:String(source.lastAcceptedEvidenceEnd||""),completeDays,requiredCompleteDays,weightDays,requiredWeightDays,weightSpanDays,requiredWeightSpanDays,windowDays,observedMaintenanceKcal:finiteNumber(source.observedMaintenanceKcal),averageCompleteCaloriesKcal:finiteNumber(source.averageCompleteCaloriesKcal??source.averageCalories),appliedAdjustmentKcal:finiteNumber(source.appliedAdjustmentKcal)??0,cutoffDate:String(source.windowEnd||source.cutoffDate||""),explanation,limitations};
  }

  function formatCalories(value){const number=finiteNumber(value);return number==null?"—":`${Math.round(number).toLocaleString()} kcal`;}
  function displayWeight(valueKg,unitSystem="metric"){
    const kilograms=finiteNumber(valueKg);if(kilograms==null)return"—";
    if(unitSystem==="imperial"){
      const pounds=kilogramsToPounds(kilograms),rounded=round(pounds,1);
      return`${rounded.toLocaleString()} lb`;
    }
    const rounded=round(kilograms,1);
    return`${rounded.toLocaleString()} kg`;
  }
  function projectionDisplay(projection,unitSystem="metric"){
    if(!isRecord(projection))return null;
    const start=finiteNumber(projection.startWeightKg),expected=finiteNumber(projection.projectedWeightKg??projection.expectedWeightKg??projection.weightKg),low=finiteNumber(projection.lowWeightKg??projection.rangeKg?.[0]),high=finiteNumber(projection.highWeightKg??projection.rangeKg?.[1]);
    if([start,expected,low,high].some((value)=>value==null))return null;
    const lower=Math.min(low,high),upper=Math.max(low,high),weeks=boundedNumber(projection.weeks??projection.horizonWeeks,1,52,{whole:true});
    if(weeks==null)return null;
    return{
      start:displayWeight(start,unitSystem,{projection:true}),expected:displayWeight(expected,unitSystem,{projection:true}),
      range:`${displayWeight(lower,unitSystem,{projection:true})}–${displayWeight(upper,unitSystem,{projection:true})}`,
      weeks,modelLabel:String(projection.modelLabel||"Dynamic planning scenario"),
      caveat:String(projection.caveat||"This is a population-based planning scenario, not a promise. Scale weight also changes with hydration, glycogen, digestion, adherence, and individual metabolism.")
    };
  }

  return Object.freeze({
    DAYS,UNIT_SYSTEMS,GOALS,TRAINING_GOALS,EXPERIENCE_LEVELS,CALORIE_PATTERNS,SESSION_MINUTES,
    poundsToKilograms,kilogramsToPounds,inchesToCentimeters,centimetersToInches,heightToCentimeters,heightFromCentimeters,weightToKilograms,weightFromKilograms,
    profileDraftToMetric,profileMetricToDraft,calorieProgress,macroProgress,weeklyCalorieProgress,dailyWeightToKilograms,dailyWeightFromKilograms,calibrationDisplay,formatCalories,displayWeight,projectionDisplay
  });
});
