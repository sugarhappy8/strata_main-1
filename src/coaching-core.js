// @ts-check
"use strict";

const {createHash}=require("node:crypto");
const {ENERGY_SEMANTICS,LEGACY_ACTIVITY_FACTORS,MODEL_VERSION:ENERGY_MODEL_VERSION,nutritionFor}=require("./energy-planning-core");
const {CATALOG_FINGERPRINT:MEAL_CATALOG_FINGERPRINT,sanitizeMealPreferences}=require("./meal-planning-core");
const {DAYS,EXERCISES}=require("./plans");
const {buildTraining,CATALOG_FINGERPRINT}=require("./coaching-training-core");

const GENERATION_VERSION="coaching-week-v6";
const EQUIPMENT=[...new Set(EXERCISES.map((exercise)=>String(exercise.equipment)))].sort();
const EXERCISE_BY_ID=new Map(EXERCISES.map((exercise)=>[String(exercise.id),exercise]));
const ACTIVITY_FACTORS=LEGACY_ACTIVITY_FACTORS;
const MOVEMENT_LIMITATIONS=Object.freeze(["no-overhead","no-deep-knee","no-unsupported-hinge","no-floor","no-unilateral"]);
const SESSION_COUNTS=Object.freeze({30:4,45:5,60:6,75:6,90:7});

/** @param {string} message @param {string} [code] @param {number} [status] */
function coachingError(message,code="INVALID_COACHING_PROFILE",status=400){return Object.assign(new Error(message),{code,status});}
/** @param {unknown} value @param {string} label @param {string} [code] @returns {Record<string,any>} */
function object(value,label,code){if(!value||typeof value!=="object"||Array.isArray(value))throw coachingError(`${label} must be an object.`,code);return value;}
/** @param {Record<string,any>} value @param {string[]} allowed @param {string} label @param {string} [code] */
function exactKeys(value,allowed,label,code){const extra=Object.keys(value).filter((key)=>!allowed.includes(key));if(extra.length)throw coachingError(`${label} contains unsupported fields: ${extra.join(", ")}.`,code);}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label @param {string} [code] */
function integer(value,min,max,label,code){if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>max)throw coachingError(`${label} must be a whole number from ${min} to ${max}.`,code);return value;}
/** @param {unknown} value @param {number} min @param {number} max @param {string} label @param {string} [code] */
function decimal(value,min,max,label,code){if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max)throw coachingError(`${label} must be from ${min} to ${max}.`,code);return Math.round(value*10)/10;}
/** @template {string} T @param {unknown} value @param {readonly T[]} allowed @param {string} label @returns {T} */
function choice(value,allowed,label){if(typeof value!=="string"||!allowed.includes(/** @type {T} */(value)))throw coachingError(`${label} is invalid.`);return /** @type {T} */(value);}
/** @template {number} T @param {unknown} value @param {readonly T[]} allowed @param {string} label @returns {T} */
function numericChoice(value,allowed,label){if(typeof value!=="number"||!allowed.includes(/** @type {T} */(value)))throw coachingError(`${label} is invalid.`);return /** @type {T} */(value);}
/** @param {unknown} value */
function timezone(value){
  const name=value==null?"UTC":String(value);
  if(name.length<1||name.length>80||/[^A-Za-z0-9_+\-/]/.test(name))throw coachingError("Time zone is invalid.");
  try{new Intl.DateTimeFormat("en",{timeZone:name}).format(0);}catch{throw coachingError("Time zone is invalid.");}
  return name;
}

/** @param {unknown} value @param {{allowLegacyProfile?:boolean}} [options] */
function sanitizeCoachingProfile(value,{allowLegacyProfile=false}={}){
  const input=object(value,"Coaching profile");
  exactKeys(input,["version","measurementSystem","preferredLoadUnit","age","heightCm","weightKg","bodyFatPercent","sexForEquation","goal","goalPace","trainingGoal","experience","lifestyleActivity","dailyMovement","additionalActivityMinutesPerWeek","additionalActivityIntensity","workoutDays","sessionMinutes","usualExercises","availableEquipment","movementLimitations","caloriePattern","flexibleDay","macroPreference","timeZone","mealPreferences"],"Coaching profile");
  const version=input.version==null&&allowLegacyProfile?(input.mealPreferences==null?1:2):input.version;
  if(![1,2,3,4].includes(version))throw coachingError("Coaching profile version is unsupported.");
  if(!allowLegacyProfile&&version!==4)throw coachingError("Review and save non-workout movement and separate additional activity before updating this coaching profile.","COACHING_ACTIVITY_REVIEW_REQUIRED",409);
  if(version===1&&input.mealPreferences!=null)throw coachingError("Meal preferences require coaching profile version 2, 3, or 4.");
  if(version===2&&input.mealPreferences==null)throw coachingError("Coaching profile version 2 requires meal preferences.");
  const legacyProfile=version<3,structuredActivity=version===4;
  const measurementSystem=choice(input.measurementSystem,["metric","imperial"],"Measurement system");
  const preferredLoadUnit=choice(input.preferredLoadUnit,["kg","lb"],"Preferred load unit");
  const age=integer(input.age,legacyProfile&&allowLegacyProfile?18:19,80,"Age"),heightCm=decimal(input.heightCm,120,230,"Height"),weightKg=decimal(input.weightKg,35,300,"Weight");
  const bodyFatPercent=input.bodyFatPercent==null?null:decimal(input.bodyFatPercent,3,65,"Body-fat percentage");
  if(input.sexForEquation==null&&!(legacyProfile&&allowLegacyProfile&&bodyFatPercent!=null))throw coachingError("Sex used by the energy equation is required for a new or updated coaching profile.");
  const sexForEquation=input.sexForEquation==null?null:choice(input.sexForEquation,["female","male"],"Sex used by the energy equation");
  const goal=choice(input.goal,["fat_loss","maintenance","muscle_gain"],"Nutrition goal");
  const goalPace=choice(input.goalPace??"moderate",["gentle","moderate"],"Goal pace");
  const trainingGoal=choice(input.trainingGoal??"balanced",["balanced","strength","hypertrophy"],"Training goal");
  const experience=choice(input.experience,["beginner","intermediate","advanced"],"Training experience");
  let lifestyleActivity=null,dailyMovement=null,additionalActivityMinutesPerWeek=null,additionalActivityIntensity=null;
  if(structuredActivity){
    if(input.lifestyleActivity!=null)throw coachingError("Version 4 separates daily movement from workouts and cannot accept the old whole-day activity field.");
    dailyMovement=choice(input.dailyMovement,["mostly_seated","lightly_moving","on_feet","physically_demanding"],"Non-workout daily movement");
    additionalActivityMinutesPerWeek=integer(input.additionalActivityMinutesPerWeek??0,0,1260,"Additional activity minutes");
    additionalActivityIntensity=choice(input.additionalActivityIntensity??"moderate",["light","moderate","vigorous"],"Additional activity intensity");
  }else{
    const activityValues=legacyProfile?Object.keys(ACTIVITY_FACTORS):Object.keys(ACTIVITY_FACTORS).filter((value)=>value!=="extremely_active");lifestyleActivity=choice(input.lifestyleActivity,activityValues,"Lifestyle activity");
  }
  if(!Array.isArray(input.workoutDays)||input.workoutDays.length<1||input.workoutDays.length>6)throw coachingError("Choose between 1 and 6 workout days.");
  const workoutDays=DAYS.filter((day)=>input.workoutDays.includes(day));
  if(workoutDays.length!==input.workoutDays.length||new Set(input.workoutDays).size!==input.workoutDays.length)throw coachingError("Workout days must be valid and unique.");
  const sessionMinutes=numericChoice(input.sessionMinutes,[30,45,60,75,90],"Session length");
  const rawExercises=input.usualExercises??[];
  if(!Array.isArray(rawExercises)||rawExercises.length>40)throw coachingError("Usual exercises must be a list of at most 40 movements.");
  const seen=new Set();
  const usualExercises=rawExercises.map((raw,index)=>{
    const exercise=object(raw,`Usual exercise ${index+1}`);exactKeys(exercise,["exerciseId","maxSets","maxReps","maxWeightKg"],`Usual exercise ${index+1}`);
    const exerciseId=String(exercise.exerciseId||"");
    if(!EXERCISE_BY_ID.has(exerciseId))throw coachingError(`Usual exercise ${index+1} is not in the exercise library.`);
    if(seen.has(exerciseId))throw coachingError("Each usual exercise may only be entered once.");seen.add(exerciseId);
    return {exerciseId,maxSets:integer(exercise.maxSets,1,20,"Maximum sets"),maxReps:integer(exercise.maxReps,1,100,"Maximum reps"),maxWeightKg:exercise.maxWeightKg==null?null:decimal(exercise.maxWeightKg,0,1000,"Maximum load")};
  });
  const rawEquipment=input.availableEquipment??[];
  if(!Array.isArray(rawEquipment)||rawEquipment.length>20||rawEquipment.some((item)=>typeof item!=="string"||!EQUIPMENT.includes(item))||new Set(rawEquipment).size!==rawEquipment.length)throw coachingError("Available equipment contains an invalid or repeated option.");
  const availableEquipment=EQUIPMENT.filter((item)=>rawEquipment.includes(item));
  const rawLimitations=input.movementLimitations??[];
  if(!Array.isArray(rawLimitations)||rawLimitations.length>MOVEMENT_LIMITATIONS.length||rawLimitations.some((item)=>typeof item!=="string"||!MOVEMENT_LIMITATIONS.includes(item))||new Set(rawLimitations).size!==rawLimitations.length)throw coachingError("Movement limitations contain an invalid or repeated option.");
  const movementLimitations=MOVEMENT_LIMITATIONS.filter((item)=>rawLimitations.includes(item));
  const caloriePattern=choice(input.caloriePattern,["steady","zigzag","flexible_day"],"Calorie pattern");
  const flexibleDay=caloriePattern==="flexible_day"?choice(input.flexibleDay,DAYS,"Flexible day"):null;
  const macroPreference=input.macroPreference==null?null:choice(input.macroPreference,["balanced","higher_protein"],"Macro preference");
  const mealPreferences=input.mealPreferences==null?null:sanitizeMealPreferences(input.mealPreferences);
  return {version,measurementSystem,preferredLoadUnit,age,heightCm,weightKg,bodyFatPercent,sexForEquation,goal,goalPace,trainingGoal,experience,...(structuredActivity?{dailyMovement,additionalActivityMinutesPerWeek,additionalActivityIntensity}:{lifestyleActivity}),workoutDays,sessionsPerWeek:workoutDays.length,sessionMinutes,usualExercises,availableEquipment,movementLimitations,caloriePattern,flexibleDay,macroPreference,timeZone:timezone(input.timeZone),mealPreferences};
}

/** @param {unknown} value */
function validDate(value){
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw coachingError("Log date must use YYYY-MM-DD.","INVALID_COACHING_DATE");
  const date=new Date(`${value}T00:00:00.000Z`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value||date.getUTCFullYear()<2000||date.getUTCFullYear()>2200)throw coachingError("Log date is invalid.","INVALID_COACHING_DATE");
  return value;
}
/** @param {unknown} value */
function sanitizeDailyLog(value){
  const code="INVALID_COACHING_LOG",input=object(value,"Calorie log",code);exactKeys(input,["calories","proteinG","carbsG","fatG","morningWeightKg","complete"],"Calorie log",code);
  const values=[input.proteinG,input.carbsG,input.fatG],provided=values.filter((item)=>item!=null).length;
  if(provided!==0&&provided!==3)throw coachingError("Enter protein, carbohydrates, and fat together, or leave all macros blank.","INVALID_COACHING_LOG");
  if(input.complete!=null&&typeof input.complete!=="boolean")throw coachingError("Intake completeness must be true, false, or left blank.","INVALID_COACHING_LOG");
  return {calories:integer(input.calories,0,20000,"Calories",code),proteinG:provided?integer(input.proteinG,0,2000,"Protein",code):null,carbsG:provided?integer(input.carbsG,0,3000,"Carbohydrates",code):null,fatG:provided?integer(input.fatG,0,1000,"Fat",code):null,morningWeightKg:input.morningWeightKg==null?null:decimal(input.morningWeightKg,35,300,"Morning weight",code),complete:input.complete==null?null:input.complete};
}

/** @param {number} timestamp @param {string} timeZone */
function localDate(timestamp,timeZone){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(timestamp));
  /** @param {string} type */
  const part=(type)=>parts.find((entry)=>entry.type===type)?.value||"";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
/** @param {string} date */
function weekStartForDate(date){const valid=validDate(date),stamp=Date.parse(`${valid}T00:00:00.000Z`),day=new Date(stamp).getUTCDay(),monday=stamp-((day+6)%7)*86400000;return new Date(monday).toISOString().slice(0,10);}
/** @param {number} timestamp @param {string} timeZone */
function currentWeekStart(timestamp,timeZone){return weekStartForDate(localDate(timestamp,timeZone));}
/** @param {string} date @param {number} offset */
function addDays(date,offset){return new Date(Date.parse(`${date}T00:00:00.000Z`)+offset*86400000).toISOString().slice(0,10);}
/** @param {ReturnType<typeof sanitizeCoachingProfile>} profile @param {number} profileRevision @param {string} weekStart @param {number} generatedAt @param {unknown} [calibrationEvidence] */
function generateCoachingWeek(profile,profileRevision,weekStart,generatedAt,calibrationEvidence=null){
  validDate(weekStart);integer(profileRevision,1,Number.MAX_SAFE_INTEGER,"Profile revision");integer(generatedAt,1,Number.MAX_SAFE_INTEGER,"Generation timestamp");
  const training=buildTraining(profile,weekStart,/** @type {Record<string,any>} */(calibrationEvidence||{})),nutrition=nutritionFor(profile,weekStart,calibrationEvidence,training),canonical=JSON.stringify(profile),calibrationFingerprint=nutrition.maintenance.calibration.evidenceFingerprint,planKey=createHash("sha256").update(`${GENERATION_VERSION}\0${ENERGY_MODEL_VERSION}\0${CATALOG_FINGERPRINT}\0${MEAL_CATALOG_FINGERPRINT}\0${calibrationFingerprint}\0${training.evidenceFingerprint}\0${weekStart}\0${profileRevision}\0${canonical}`).digest("hex"),energySource=nutrition.energySemantics===ENERGY_SEMANTICS.STRUCTURED_ACTIVITY?"Mifflin–St Jeor resting energy plus separately modeled non-workout movement and generated-session activity":nutrition.energySemantics===ENERGY_SEMANTICS.WHOLE_DAY_EER?"2023 National Academies / Health Canada adult EER equations for ages 19–80":nutrition.primaryEquation==="legacy_cunningham_activity_fallback"?"Preserved legacy Cunningham resting-energy estimate × original activity multiplier":"Preserved legacy Mifflin–St Jeor resting-energy estimate × original activity multiplier";
  const formulaSources=[energySource];if(nutrition.energySemantics===ENERGY_SEMANTICS.STRUCTURED_ACTIVITY)formulaSources.push("2024 Adult and Older Adult Compendium resistance-training MET references","2023 DRI activity descriptions and EER population cross-check");else if(nutrition.energySemantics===ENERGY_SEMANTICS.WHOLE_DAY_EER)formulaSources.push("Mifflin–St Jeor resting-energy cross-check when the published sex coefficient is supplied");if(nutrition.bodyFatCrossCheck?.role==="secondary_cross_check")formulaSources.push(nutrition.energySemantics===ENERGY_SEMANTICS.STRUCTURED_ACTIVITY?"Cunningham resting-energy cross-check and optional fat-free-mass safety screen when body-fat percentage is supplied":"Cunningham resting-energy cross-check when body-fat percentage is supplied");if(profile.version>=3)formulaSources.push("Aligned morning-to-morning intake and weight calibration using complete intervals in a 42-day history","Dynamic energy-balance sensitivity scenarios with explicit maintenance, tissue-density and expenditure-response assumptions");else formulaSources.push("Preserved legacy weight-change illustration; calorie calibration is disabled until profile review");
  return {schemaVersion:4,generationVersion:GENERATION_VERSION,energyModelVersion:ENERGY_MODEL_VERSION,catalogFingerprint:CATALOG_FINGERPRINT,mealCatalogFingerprint:MEAL_CATALOG_FINGERPRINT,weekStart,weekEnd:addDays(weekStart,6),nextWeekStart:addDays(weekStart,7),planKey,profileRevision,generatedAt,inputs:profile,training,nutrition,methodology:{formulaSources,references:[{label:"2023 Dietary Reference Intakes for Energy",url:"https://www.ncbi.nlm.nih.gov/books/NBK591020/?report=printable"},{label:"Mifflin–St Jeor resting-energy study",url:"https://pubmed.ncbi.nlm.nih.gov/2305711/"},{label:"Cunningham 1991 lean-mass resting-energy synthesis",url:"https://pubmed.ncbi.nlm.nih.gov/1957828/"},{label:"2024 Adult Compendium of Physical Activities",url:"https://pubmed.ncbi.nlm.nih.gov/38242596/"},{label:"2024 Older Adult Compendium of Physical Activities",url:"https://pubmed.ncbi.nlm.nih.gov/38242593/"},{label:"2023 IOC REDs consensus",url:"https://doi.org/10.1136/bjsports-2023-106994"},{label:"Repeated-weight energy-intake model validation",url:"https://pubmed.ncbi.nlm.nih.gov/26040640/"},{label:"Self-reported energy-intake validity review",url:"https://pubmed.ncbi.nlm.nih.gov/31920966/"},{label:"Hall dynamic weight-change approximation",url:"https://pmc.ncbi.nlm.nih.gov/articles/PMC3880593/"},{label:"US Physical Activity Guidelines",url:"https://odphp.health.gov/our-work/nutrition-physical-activity/physical-activity-guidelines/current-guidelines"},{label:"ACSM 2026 resistance-training position stand",url:"https://pmc.ncbi.nlm.nih.gov/articles/PMC12965823/"},{label:"ISSN protein position stand",url:"https://pubmed.ncbi.nlm.nih.gov/28642676/"},{label:"USDA FoodData Central",url:"https://fdc.nal.usda.gov/"},{label:"FDA food-allergy guidance",url:"https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies"}],assumptions:["Energy equations and trend calibration are estimates; the displayed range is a conservative planning band, not a confidence interval or measurement.","Profile versions 1–2 preserve their original resting-energy × activity-multiplier meaning and version 3 preserves its whole-day EER meaning until the member explicitly reviews and saves profile version 4.","Version 4 counts ordinary non-workout movement, generated STRATA session energy, and separately entered activity once. Equipment, limitations, experience, and known lifts shape the feasible session; kilograms lifted are not treated as measured calorie expenditure.","The version-4 daily-movement PAL anchors, body-weight pace tiers, composition screen, and deficit caps are transparent STRATA engineering guardrails, not clinically validated individual prescriptions.","Calibration pairs each morning weight with cumulative complete intake up to that morning; missing days break an interval. Up to 42 prior days are considered.","STRATA's aligned energy-balance inversion, evidence-quality weights, sensitivity bounds, and weekly rate limits are engineering heuristics; published studies do not validate this exact implementation.","Entered exercise capabilities are context, not verified one-repetition maximums.","The seven daily calorie targets preserve the selected weekly energy budget.","Food nutrition and USD cost figures are rounded planning estimates, not live product or store data."],cautions:["New estimates are for adults ages 19–80. Age-18 stored profiles use a labeled legacy fallback; not for pregnancy, eating-disorder care, or medical/injury-specific prescription.","Self-reported activity, intake, body fat, and scale trends can be wrong or distorted; weekly corrections are deliberately shrunk and capped.","The optional 30 kcal/kg fat-free-mass screen is a debated safety signal, not a universal diagnostic threshold; seek individual advice for sport or physique dieting.","Weight figures are sensitivity envelopes, not forecasts or confidence intervals. They propagate assumed maintenance, tissue-density and adaptation ranges; water shifts and actual adherence remain unmodeled.","Food suggestions cannot guarantee allergen safety; verify every label and cross-contact risk.","Stop or modify movements that cause pain and seek qualified care when appropriate."]}};
}

module.exports={ACTIVITY_FACTORS,CATALOG_FINGERPRINT,ENERGY_MODEL_VERSION,EQUIPMENT,GENERATION_VERSION,MEAL_CATALOG_FINGERPRINT,MOVEMENT_LIMITATIONS,SESSION_COUNTS,addDays,currentWeekStart,localDate,generateCoachingWeek,sanitizeCoachingProfile,sanitizeDailyLog,validDate,weekStartForDate};
