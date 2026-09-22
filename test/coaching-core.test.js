"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EXERCISES}=require("../src/plans");
const {ENERGY_MODEL_VERSION,MEAL_CATALOG_FINGERPRINT,addDays,currentWeekStart,generateCoachingWeek,sanitizeCoachingProfile,sanitizeDailyLog,weekStartForDate}=require("../src/coaching-core");

function profile(overrides={}){
  const version=overrides.version??4,activity=version===4?{dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate"}:{lifestyleActivity:"moderately_active"};
  return {version,measurementSystem:"metric",preferredLoadUnit:"kg",age:32,heightCm:178,weightKg:82,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",trainingGoal:"balanced",experience:"intermediate",...activity,workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,usualExercises:[{exerciseId:"flat-dumbbell-press",maxSets:4,maxReps:10,maxWeightKg:32}],availableEquipment:[],movementLimitations:[],caloriePattern:"zigzag",flexibleDay:null,macroPreference:"balanced",timeZone:"Asia/Dubai",...overrides};
}
function mealPreferences(overrides={}){return {allergyStatus:"none_known",allergens:[],otherAllergies:"",dietaryPattern:"omnivore",dietaryRequirements:[],favoriteFoods:["chicken","rice"],mealsPerDay:3,dailyBudgetCents:1500,...overrides};}

test("coaching profiles strictly validate adult energy and training boundaries",()=>{
  const clean=sanitizeCoachingProfile(profile());
  assert.equal(clean.sessionsPerWeek,3);assert.equal(clean.timeZone,"Asia/Dubai");assert.equal(clean.goalPace,"moderate");
  assert.throws(()=>sanitizeCoachingProfile(profile({sexForEquation:null})),/Sex used by the energy equation/);
  assert.throws(()=>sanitizeCoachingProfile(profile({bodyFatPercent:20,sexForEquation:null})),/required for a new or updated/);
  assert.equal(sanitizeCoachingProfile(profile({version:1,bodyFatPercent:20,sexForEquation:null}),{allowLegacyProfile:true}).sexForEquation,null);
  assert.throws(()=>sanitizeCoachingProfile(profile({age:18})),/19 to 80/);assert.equal(sanitizeCoachingProfile(profile({version:1,age:18}),{allowLegacyProfile:true}).age,18);
  assert.throws(()=>sanitizeCoachingProfile(profile({version:1,age:17}),{allowLegacyProfile:true}),/18 to 80/);
  assert.throws(()=>sanitizeCoachingProfile({...profile(),userId:"untrusted"}),/unsupported fields: userId/);
  assert.throws(()=>sanitizeCoachingProfile(profile({workoutDays:["Monday","Monday"]})),/valid and unique/);
  assert.throws(()=>sanitizeCoachingProfile(profile({usualExercises:[profile().usualExercises[0],profile().usualExercises[0]]})),/only be entered once/);
  assert.throws(()=>sanitizeCoachingProfile(profile({timeZone:"Mars/Olympus"})),/Time zone is invalid/);
});

test("version 4 stores split activity while versions 1–3 remain read-only compatible",()=>{
  const legacy=sanitizeCoachingProfile(profile({version:1}),{allowLegacyProfile:true});assert.equal(legacy.version,1);assert.equal(legacy.mealPreferences,null);
  const legacyMeals=sanitizeCoachingProfile(profile({version:2,mealPreferences:mealPreferences()}),{allowLegacyProfile:true});assert.equal(legacyMeals.version,2);
  const wholeDay=sanitizeCoachingProfile(profile({version:3}),{allowLegacyProfile:true});assert.equal(wholeDay.lifestyleActivity,"moderately_active");
  const current=sanitizeCoachingProfile(profile({mealPreferences:mealPreferences()}));assert.equal(current.version,4);assert.equal(current.dailyMovement,"mostly_seated");assert.equal(current.lifestyleActivity,undefined);assert.deepEqual(current.mealPreferences,mealPreferences());
  for(const version of [1,2,3])assert.throws(()=>sanitizeCoachingProfile(profile({version,mealPreferences:version===2?mealPreferences():null})),{code:"COACHING_ACTIVITY_REVIEW_REQUIRED",status:409});
  assert.throws(()=>sanitizeCoachingProfile(profile({version:1,mealPreferences:mealPreferences()}),{allowLegacyProfile:true}),/version 2, 3, or 4/);
  assert.throws(()=>sanitizeCoachingProfile(profile({version:2}),{allowLegacyProfile:true}),/requires meal preferences/);
  assert.throws(()=>sanitizeCoachingProfile(profile({lifestyleActivity:"extremely_active"})),/cannot accept the old whole-day activity field/);assert.equal(sanitizeCoachingProfile(profile({version:1,lifestyleActivity:"extremely_active"}),{allowLegacyProfile:true}).lifestyleActivity,"extremely_active");
  for(const invalid of [{dailyMovement:"active"},{additionalActivityMinutesPerWeek:-1},{additionalActivityMinutesPerWeek:1261},{additionalActivityMinutesPerWeek:1.5},{additionalActivityIntensity:"extreme"}])assert.throws(()=>sanitizeCoachingProfile(profile(invalid)),/invalid|whole number/i);
  const week=generateCoachingWeek(current,1,"2026-09-07",1_000);assert.equal(week.schemaVersion,4);assert.equal(week.generationVersion,"coaching-week-v6");assert.equal(week.energyModelVersion,ENERGY_MODEL_VERSION);assert.equal(week.nutrition.maintenance.calibration.modelVersion,ENERGY_MODEL_VERSION);assert.equal(week.mealCatalogFingerprint,MEAL_CATALOG_FINGERPRINT);assert.match(week.methodology.cautions.join(" "),/allergen safety/i);assert.match(week.methodology.references.map(({label})=>label).join(" "),/Adult Compendium.*Older Adult Compendium.*Repeated-weight.*Self-reported/i);
});

test("daily logs require bounded calories and either zero or all three macros",()=>{
  assert.deepEqual(sanitizeDailyLog({calories:2100}),{calories:2100,proteinG:null,carbsG:null,fatG:null,morningWeightKg:null,complete:null});
  assert.deepEqual(sanitizeDailyLog({calories:2100,proteinG:150,carbsG:225,fatG:65,morningWeightKg:81.26,complete:true}),{calories:2100,proteinG:150,carbsG:225,fatG:65,morningWeightKg:81.3,complete:true});
  assert.throws(()=>sanitizeDailyLog({calories:2100,proteinG:150}),/together/);
  assert.throws(()=>sanitizeDailyLog({calories:-1}),/0 to 20000/);
  assert.throws(()=>sanitizeDailyLog({calories:1000,note:"private"}),/unsupported fields: note/);
});

test("daily logs strictly preserve optional morning-weight and completeness boundaries",()=>{
  for(const [complete,expected] of [[true,true],[false,false],[null,null],[undefined,null]])assert.equal(sanitizeDailyLog({calories:0,complete}).complete,expected);
  assert.equal(sanitizeDailyLog({calories:0,morningWeightKg:35}).morningWeightKg,35);assert.equal(sanitizeDailyLog({calories:0,morningWeightKg:300}).morningWeightKg,300);
  assert.throws(()=>sanitizeDailyLog({calories:0,morningWeightKg:34.9}),/35 to 300/);assert.throws(()=>sanitizeDailyLog({calories:0,morningWeightKg:300.1}),/35 to 300/);
  assert.throws(()=>sanitizeDailyLog({calories:0,morningWeightKg:"80"}),/35 to 300/);assert.throws(()=>sanitizeDailyLog({calories:0,complete:1}),/true, false, or left blank/);
});

test("ISO weeks use the profile time zone and reject impossible dates",()=>{
  assert.equal(weekStartForDate("2026-09-11"),"2026-09-07");
  assert.equal(currentWeekStart(Date.parse("2026-09-13T21:30:00Z"),"Asia/Dubai"),"2026-09-14");
  assert.throws(()=>weekStartForDate("2026-02-30"),/invalid/);
});

test("weekly coaching is deterministic, keeps repeatable main exercises, and preserves its calorie budget",()=>{
  const clean=sanitizeCoachingProfile(profile({usualExercises:[]})),first=generateCoachingWeek(clean,1,"2026-09-07",1_000),replay=generateCoachingWeek(clean,1,"2026-09-07",1_000),next=generateCoachingWeek(clean,1,"2026-09-14",2_000);
  assert.deepEqual(replay,first);assert.notEqual(next.planKey,first.planKey);assert.equal(first.nextWeekStart,"2026-09-14");
  const anchors=(week)=>week.training.sessions.map(session=>session.exercises.filter(exercise=>["knee","posterior","push","pull"].includes(exercise.role)).map(exercise=>exercise.exerciseId));
  assert.deepEqual(anchors(next),anchors(first),"main exercises remain comparable across adjacent weeks");
  assert.equal(first.training.sessions.length,3);assert.ok(first.training.sessions.every((session)=>session.exercises.length>=4&&session.estimatedDurationMinutes<=60));
  assert.equal(first.nutrition.weeklyTargetKcal,first.nutrition.dailyTargets.reduce((sum,day)=>sum+day.calories,0));
  assert.equal(first.nutrition.weeklyTargetKcal,first.nutrition.maintenance.targetKcal*7);
  assert.equal(first.nutrition.equation,"mifflin_st_jeor");assert.equal(first.nutrition.primaryEquation,"mifflin_structured_activity");assert.equal(first.nutrition.activityFactor,null);assert.equal(first.nutrition.legacyActivityFactor,null);assert.equal(first.nutrition.activityBreakdown.sessions.length,3);
  for(const day of first.nutrition.dailyTargets){
    const macros=day.macros,total=macros.proteinG*4+macros.carbsG*4+macros.fatG*9;
    assert.ok(macros.carbsG*4/total>=.44,"rounding keeps carbohydrates near or above the 45% AMDR floor");
  }
  assert.match(first.methodology.cautions.join(" "),/not forecasts or confidence intervals/i);
});

test("entered exercise capability caps starting sets and reps without inventing a tested load",()=>{
  const input=profile({usualExercises:[{exerciseId:"flat-dumbbell-press",maxSets:2,maxReps:8,maxWeightKg:32}]}),clean=sanitizeCoachingProfile(input);
  let press;
  for(let offset=0;offset<6&&!press;offset+=1){const week=generateCoachingWeek(clean,1,addDays("2026-09-07",offset*7),1_000+offset);press=week.training.sessions.flatMap((session)=>session.exercises).find((exercise)=>exercise.exerciseId==="flat-dumbbell-press");}
  assert.ok(press);assert.equal(press.sets,2);assert.equal(press.reps,"6–8");assert.equal(press.measurement,"reps");assert.equal(press.loadType,"external");
  assert.equal(press.suggestedStartingLoad,null);assert.equal(press.targetSets,null);assert.equal(press.enteredCapability.maxWeightKg,32);
  assert.match(press.loadingGuidance,/not a tested maximum or an automatic load target/);
});

test("known exercises stay repeatable and full performance evidence changes optional training targets only",()=>{
  const knownIds=["hack-squat","seated-leg-curl","incline-smith-press","neutral-pulldown","cable-lateral-raise","cable-crunch","hip-thrust","cable-reverse-lunge","overhead-triceps","seated-calf"];
  const usualExercises=knownIds.map((exerciseId)=>({exerciseId,maxSets:4,maxReps:10,maxWeightKg:40})),clean=sanitizeCoachingProfile(profile({usualExercises}));
  const first=generateCoachingWeek(clean,1,"2026-09-07",1_000),replay=generateCoachingWeek(clean,1,"2026-09-07",1_000),next=generateCoachingWeek(clean,1,"2026-09-14",2_000);
  const ids=(week)=>week.training.sessions.map((session)=>session.exercises.map((exercise)=>exercise.exerciseId));
  assert.deepEqual(ids(replay),ids(first));assert.deepEqual(ids(next),ids(first));
  const known=first.training.sessions[0].exercises.find(exercise=>knownIds.includes(exercise.exerciseId)&&exercise.measurement==="reps"&&exercise.loadType==="external");assert.ok(known);
  const workouts=["2026-08-28","2026-09-04"].map(date=>({id:`workout-${date}`,date,status:"completed",startedAt:Date.parse(`${date}T12:00:00Z`),completedAt:Date.parse(`${date}T13:00:00Z`),entries:[{id:`entry-${date}`,exerciseId:known.exerciseId,measurement:known.measurement,loadType:known.loadType,unit:known.unit,prescribedReps:known.reps,effortType:"rir",sets:Array.from({length:known.sets},()=>({reps:known.range.high,weight:40,seconds:null,effort:3,completed:true}))}]}));
  const informed=generateCoachingWeek(clean,1,"2026-09-07",1_000,{workouts}),target=informed.training.sessions[0].exercises.find(exercise=>exercise.exerciseId===known.exerciseId);
  assert.equal(target.performance.sourceDate,"2026-09-04");assert.equal(target.performance.action,"increase_load");assert.ok(target.targetSets.every(set=>set.weight===42.5&&set.reps===known.range.low));
  assert.notEqual(informed.planKey,first.planKey);assert.deepEqual(informed.nutrition,first.nutrition,"workout history never adds calorie burn to the whole-day estimate");
});

test("legacy null-sex body-fat input uses the labeled Cunningham fallback and goal pace changes conservative targets",()=>{
  const gentle=generateCoachingWeek(sanitizeCoachingProfile(profile({version:1,bodyFatPercent:20,sexForEquation:null,goal:"fat_loss",goalPace:"gentle"}),{allowLegacyProfile:true}),1,"2026-09-07",1_000);
  const moderate=generateCoachingWeek(sanitizeCoachingProfile(profile({version:1,bodyFatPercent:20,sexForEquation:null,goal:"fat_loss",goalPace:"moderate"}),{allowLegacyProfile:true}),1,"2026-09-07",1_000);
  assert.equal(gentle.nutrition.equation,"cunningham_1991");assert.equal(gentle.methodology.formulaSources.filter((item)=>/Cunningham/.test(item)).length,1,"a legacy Cunningham primary is named once");assert.ok(gentle.nutrition.deficit.targetKcal>moderate.nutrition.deficit.targetKcal);
  assert.equal(gentle.nutrition.weightScenarios.length,3);assert.ok(gentle.nutrition.weightScenarios.every((item)=>item.rangeKg[0]<=item.weightKg&&item.weightKg<=item.rangeKg[1]));
});

test("saved equipment, experience, and movement limitations are hard constraints",()=>{
  const clean=sanitizeCoachingProfile(profile({experience:"beginner",sessionMinutes:30,movementLimitations:["no-floor","no-overhead"]})),week=generateCoachingWeek(clean,1,"2026-09-07",1_000),byId=new Map(EXERCISES.map((exercise)=>[exercise.id,exercise]));
  for(const session of week.training.sessions)for(const item of session.exercises){
    const exercise=byId.get(item.exerciseId);assert.ok(exercise);assert.equal(exercise.level,"Beginner");assert.ok(!exercise.traits.includes("floor"));assert.ok(!exercise.traits.includes("overhead"));
  }
  assert.ok(week.training.sessions.every((session)=>session.exercises.length===4));
  const restricted=generateCoachingWeek(sanitizeCoachingProfile(profile({availableEquipment:["Resistance band"],movementLimitations:["no-floor","no-overhead","no-deep-knee","no-unilateral"]})),1,"2026-09-07",1_000);
  assert.equal(restricted.training.summary.reviewNeeded,true);assert.equal(restricted.nutrition.dailyTargets.length,7);
  for(const session of restricted.training.sessions)for(const item of session.exercises){const exercise=byId.get(item.exerciseId);assert.equal(exercise.equipment,"Resistance band");assert.ok(!exercise.traits.some(trait=>["floor","overhead","deep-knee","unilateral"].includes(trait)));}
});

test("version 4 energy follows the feasible generated plan rather than the requested schedule alone",()=>{
  const short=generateCoachingWeek(sanitizeCoachingProfile(profile({sessionMinutes:30})),1,"2026-09-07",1_000),long=generateCoachingWeek(sanitizeCoachingProfile(profile({sessionMinutes:90})),1,"2026-09-07",1_000),limited=generateCoachingWeek(sanitizeCoachingProfile(profile({availableEquipment:["Resistance band"],movementLimitations:["no-overhead","no-deep-knee","no-unsupported-hinge","no-floor","no-unilateral"]})),1,"2026-09-07",1_000);
  assert.ok(long.training.summary.estimatedDurationMinutes>short.training.summary.estimatedDurationMinutes);assert.ok(long.nutrition.activityBreakdown.plannedTrainingWeekKcal>short.nutrition.activityBreakdown.plannedTrainingWeekKcal);
  assert.ok(limited.training.sessions.some((session)=>session.status!=="ready"));assert.ok(limited.nutrition.activityBreakdown.plannedTrainingWeekKcal<long.nutrition.activityBreakdown.plannedTrainingWeekKcal);assert.equal(limited.nutrition.activityBreakdown.sessions.length,limited.training.sessions.filter((session)=>session.status!=="unavailable"&&session.exercises.length).length);
});

test("unsafe automated deficits fail closed and low-energy variations disclose a steady fallback",()=>{
  const lowBmi=sanitizeCoachingProfile(profile({heightCm:190,weightKg:50,goal:"fat_loss"}));
  assert.throws(()=>generateCoachingWeek(lowBmi,1,"2026-09-07",1_000),{code:"DEFICIT_REQUIRES_REVIEW"});
  const roundedUpUnderweight=sanitizeCoachingProfile(profile({heightCm:180,weightKg:59.8,goal:"fat_loss"}));
  assert.throws(()=>generateCoachingWeek(roundedUpUnderweight,1,"2026-09-07",1_000),{code:"DEFICIT_REQUIRES_REVIEW"});
  const roundedUpMaintenance=generateCoachingWeek(sanitizeCoachingProfile(profile({heightCm:180,weightKg:59.8,goal:"maintenance"})),1,"2026-09-07",1_000);
  assert.equal(roundedUpMaintenance.nutrition.bmi,18.5);assert.equal(roundedUpMaintenance.nutrition.deficit.targetKcal,null);
  const projectedUnderweight=sanitizeCoachingProfile(profile({heightCm:180,weightKg:60.1,goal:"fat_loss"}));
  assert.throws(()=>generateCoachingWeek(projectedUnderweight,1,"2026-09-07",1_000),{code:"DEFICIT_REQUIRES_REVIEW"});
  const projectedMaintenance=generateCoachingWeek(sanitizeCoachingProfile(profile({heightCm:180,weightKg:60.1,goal:"maintenance"})),1,"2026-09-07",1_000);
  assert.ok(60.1/1.8**2>18.5);assert.equal(projectedMaintenance.nutrition.deficit.targetKcal,null);
  const safeDeficit=generateCoachingWeek(sanitizeCoachingProfile(profile({goal:"fat_loss"})),1,"2026-09-07",1_000),minimumSafeWeight=18.5*(safeDeficit.inputs.heightCm/100)**2;
  assert.ok(safeDeficit.nutrition.weightScenarios.every((scenario)=>scenario.rangeKg[0]>=minimumSafeWeight));
  const lowEnergy=generateCoachingWeek(sanitizeCoachingProfile(profile({age:60,heightCm:140,weightKg:45,sexForEquation:"female",caloriePattern:"zigzag",macroPreference:null})),1,"2026-09-07",1_000);
  assert.equal(lowEnergy.nutrition.requestedPattern,"zigzag");assert.equal(lowEnergy.nutrition.effectivePattern,"steady");assert.match(lowEnergy.nutrition.patternFallback,/1,200/);
  assert.throws(()=>generateCoachingWeek(sanitizeCoachingProfile(profile({age:80,heightCm:120,weightKg:35,sexForEquation:"female",caloriePattern:"steady",macroPreference:null})),1,"2026-09-07",1_000),{code:"CALORIE_TARGET_REQUIRES_REVIEW"});
});
