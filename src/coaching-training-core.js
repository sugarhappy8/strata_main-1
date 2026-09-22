// @ts-check
"use strict";

const {createHash}=require("node:crypto");
const {DAYS,EXERCISES}=require("./plans");
const {exerciseFormat,estimatedSeconds,prepareEvidence,startingPrescription,withPerformance}=require("./coaching-prescription-core");
/** @typedef {Record<string,any>} Value */
const MODEL_VERSION="coaching-training-v2";
const CATALOG_FINGERPRINT=createHash("sha256").update(JSON.stringify(EXERCISES.map(exercise=>({id:exercise.id,name:exercise.name,group:exercise.group,sub:exercise.sub,equipment:exercise.equipment,level:exercise.level,pattern:exercise.pattern,traits:Array.isArray(exercise.traits)?[...exercise.traits].sort():[],score:exercise.score,sets:exercise.sets,reps:exercise.reps,rest:exercise.rest})).sort((a,b)=>String(a.id).localeCompare(String(b.id))))).digest("hex").slice(0,16);
const LEVELS=/** @type {Record<string,number>} */({Beginner:0,Intermediate:1,Advanced:2,beginner:0,intermediate:1,advanced:2});
const LIMITS=/** @type {Record<string,string>} */({"no-overhead":"overhead","no-deep-knee":"deep-knee","no-unsupported-hinge":"unsupported-hinge","no-floor":"floor","no-unilateral":"unilateral"});
const LABELS=/** @type {Record<string,string>} */({knee:"Knee-dominant legs",posterior:"Posterior legs and hips",push:"Upper-body push",pull:"Upper-body pull",shoulders:"Shoulders",biceps:"Biceps",triceps:"Triceps",core:"Core",calves:"Calves"});
const GROUPS=["chest","back","legs","glutes","shoulders","arms","calves","core"];
const PRIMARY_ROLES=new Set(["knee","posterior","push","pull"]);
const UPPER=["push","pull","shoulders","pull","triceps","biceps","core"],LOWER=["knee","posterior","calves","core","posterior","knee","calves"];
const FULL=["knee","push","pull","posterior","core","shoulders","calves"];
const PUSH=["push","shoulders","triceps","push","shoulders","triceps","core"],PULL=["pull","posterior","biceps","pull","biceps","core","shoulders"];
/** @param {string} message */
function constraintError(message){return Object.assign(new Error(message),{code:"COACHING_PLAN_CONSTRAINTS",status:422});}
/** @param {number} count @returns {{label:string,roles:string[]}[]} */
function templates(count){
  const full=(/** @type {string} */ letter)=>({label:`Full body ${letter}`,roles:FULL}),upper=(/** @type {string} */ letter)=>({label:`Upper ${letter}`,roles:UPPER}),lower=(/** @type {string} */ letter)=>({label:`Lower ${letter}`,roles:LOWER});
  if(count<=3)return Array.from({length:count},(_,index)=>full(String.fromCharCode(65+index)));
  if(count===4)return [upper("A"),lower("A"),upper("B"),lower("B")];
  if(count===5)return [{label:"Push",roles:PUSH},{label:"Pull",roles:PULL},lower("A"),upper("A"),lower("B")];
  return [{label:"Push A",roles:PUSH},{label:"Pull A",roles:PULL},lower("A"),{label:"Push B",roles:PUSH},{label:"Pull B",roles:PULL},lower("B")];
}
/** @param {Value} exercise @param {string} role */
function fitsRole(exercise,role){
  const group=String(exercise.group),sub=String(exercise.sub),compound=exercise.traits?.includes("compound");
  if(role==="knee")return group==="legs"&&sub==="Quadriceps";
  if(role==="posterior")return group==="legs"&&sub==="Hamstrings"||group==="glutes"&&sub==="Glute max";
  if(role==="push")return group==="chest"&&compound;
  if(role==="pull")return group==="back"&&sub!=="Spinal erectors"&&compound;
  if(role==="biceps")return group==="arms"&&/Biceps|Brachialis/.test(sub);
  if(role==="triceps")return group==="arms"&&/Triceps/.test(sub);
  return group===role;
}
/** @param {Value} profile @param {Value} exercise */
function eligible(profile,exercise){return (LEVELS[exercise.level]??99)<=(LEVELS[profile.experience]??0)&&(profile.availableEquipment.length===0||profile.availableEquipment.includes(exercise.equipment))&&!profile.movementLimitations.some((/** @type {string} */ limit)=>exercise.traits?.includes(LIMITS[limit]))&&!!exerciseFormat(exercise,profile.preferredLoadUnit);}
/** @param {string} seed */
function tieBreak(seed){return Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0,6),16)%7;}
/** @param {Value} profile @param {string} role @param {Set<string>} used @param {Value} context */
function selectExercise(profile,role,used,context){
  const candidates=EXERCISES.filter(exercise=>fitsRole(exercise,role)&&eligible(profile,exercise)&&!used.has(String(exercise.id)));
  const known=new Set(profile.usualExercises.map((/** @type {Value} */ item)=>item.exerciseId));
  const recent=new Set(context.evidence.workouts.flatMap((/** @type {Value} */ workout)=>workout.entries.map((/** @type {Value} */ entry)=>entry.exerciseId)));
  const prior=context.evidence.previousSessions.find((/** @type {Value} */ session)=>session.day===context.day)||context.evidence.previousSessions.find((/** @type {Value} */ session)=>session.label===context.label);
  const anchors=new Set((prior?.exercises||[]).filter((/** @type {Value} */ item)=>!item.role||item.role===role).map((/** @type {Value} */ item)=>item.exerciseId));
  const phase=PRIMARY_ROLES.has(role)?"anchor":String(Math.floor(Date.parse(context.weekStart)/2419200000));
  const score=(/** @type {Value} */ exercise)=>Number(exercise.score)+(PRIMARY_ROLES.has(role)&&anchors.has(exercise.id)?300:0)+(known.has(exercise.id)?150:0)+(recent.has(exercise.id)?100:0)+(exercise.traits?.includes("compound")?35:0)+(role==="posterior"&&context.index%2===0&&exercise.sub==="Hamstrings"?40:0)+tieBreak(`${profile.trainingGoal||"balanced"}\0${context.label}\0${role}\0${phase}\0${exercise.id}`);
  candidates.sort((a,b)=>score(b)-score(a)||String(a.id).localeCompare(String(b.id)));
  return candidates[0]||null;
}
/** @param {Value[]} items */
function totalSeconds(items){return items.length?300+items.reduce((total,item)=>total+estimatedSeconds(item),0):0;}
/** Preserve movement priorities before accessories; never claim an unbudgeted duration. @param {Value[]} items @param {number} minutes */
function fitDuration(items,minutes){
  const initialSets=items.reduce((sum,item)=>sum+item.sets,0);let removed=0;
  while(totalSeconds(items)>minutes*60&&items.length>4){items.pop();removed+=1;}
  for(const floor of [2,1]){
    while(totalSeconds(items)>minutes*60){
      const choices=items.filter(item=>item.sets>floor).sort((a,b)=>estimatedSeconds(b)/b.sets-estimatedSeconds(a)/a.sets);
      if(!choices[0])break;choices[0].sets-=1;
    }
  }
  while(totalSeconds(items)>minutes*60&&items.length){items.pop();removed+=1;}
  return {adjusted:removed>0||items.reduce((sum,item)=>sum+item.sets,0)<initialSets,removed};
}
/** @param {Value[]} sessions @param {Value} profile @param {ReturnType<typeof prepareEvidence>} evidence */
function trainingSummary(sessions,profile,evidence){
  const groupRows=GROUPS.map(group=>{const days=sessions.filter(session=>session.exercises.some((/** @type {Value} */ item)=>item.group===group));return {group,workingSets:days.reduce((sum,day)=>sum+day.exercises.filter((/** @type {Value} */ item)=>item.group===group).reduce((/** @type {number} */ total,/** @type {Value} */ item)=>total+item.sets,0),0),days:days.map(day=>day.day),frequency:days.length};});
  const muscleRows=/** @type {Map<string,{muscle:string,workingSets:number,days:string[]}>} */(new Map());
  for(const session of sessions)for(const item of session.exercises){const row=muscleRows.get(item.primaryMuscle)||{muscle:item.primaryMuscle,workingSets:0,days:/** @type {string[]} */([])};row.workingSets+=item.sets;if(!row.days.includes(session.day))row.days.push(session.day);muscleRows.set(item.primaryMuscle,row);}
  const consecutiveDays=profile.workoutDays.flatMap((/** @type {string} */ day)=>{const next=DAYS[(DAYS.indexOf(day)+1)%7];return profile.workoutDays.includes(next)?[`${day}–${next}`]:[];});
  const historyBasedExercises=sessions.flatMap(session=>session.exercises).filter(item=>item.targetSets).length,reviewNeeded=sessions.some(session=>session.status!=="ready"),missingCoverage=sessions.filter(session=>session.status!=="ready").map(session=>`${session.day}: ${session.missingRoles.join(", ")||"No compatible exercises"}`);
  return {trainingGoal:profile.trainingGoal||"balanced",scheduledDays:sessions.length,trainingDays:sessions.filter(session=>session.exercises.length).length,reviewNeeded,missingCoverage,workingSets:sessions.reduce((sum,session)=>sum+session.workingSets,0),estimatedDurationMinutes:sessions.reduce((sum,session)=>sum+session.estimatedDurationMinutes,0),groups:groupRows,muscles:[...muscleRows.values()].sort((a,b)=>a.muscle.localeCompare(b.muscle)),coverageGaps:groupRows.filter(row=>row.frequency<2).map(row=>row.group),consecutiveDays,historyBasedExercises,historyLimited:evidence.limited,coverageBasis:"Direct sets assigned to the catalog's primary group and muscle. Compound overlap is not double-counted; a missing direct group can still receive indirect work.",durationBasis:"Planning heuristic: five minutes to warm up when exercises are available, controlled set time, prescribed inter-set rest, and one minute per exercise for setup. Actual duration varies.",consistencyBasis:"Compatible main exercises are retained across weeks for practice and comparison. Accessories may vary after four-week calendar windows; variation is not required for progress.",schedulingNote:consecutiveDays.length?"Your chosen schedule includes consecutive training days. Review spacing when repeated muscles have not recovered; this planner does not measure recovery.":null};
}
/**
 * Plan suggestions only: never mutates the saved Plan, workouts, or calorie targets.
 * @param {Value} profile Canonical coaching profile, optionally including trainingGoal.
 * @param {string} weekStart Monday in the profile's time zone.
 * @param {unknown} [evidence] Owner-scoped full workouts, check-ins, and previous coaching week.
 */
function buildTraining(profile,weekStart,evidence={}){
  const normalized=prepareEvidence(/** @type {Value} */(evidence&&typeof evidence==="object"?evidence:{}),weekStart,profile.timeZone||"UTC"),split=templates(profile.sessionsPerWeek),goal=profile.trainingGoal||"balanced";
  const requestedCount=profile.sessionMinutes<=30?4:profile.sessionMinutes<=45?5:profile.sessionMinutes<=60?6:7,count=Math.min(requestedCount,profile.experience==="beginner"?5:7);
  const sessions=split.map((template,index)=>{
    const day=profile.workoutDays[index];if(!day)throw constraintError("Workout-day setup is incomplete.");
    const used=new Set(),items=/** @type {Value[]} */([]),requiredRoles=[...new Set(template.roles.slice(0,4).filter(role=>PRIMARY_ROLES.has(role)))];
    /** @param {string} role */
    function addRole(role){
      const exercise=selectExercise(profile,role,used,{evidence:normalized,day,label:template.label,index,weekStart});
      if(!exercise)return false;
      const format=exerciseFormat(exercise,profile.preferredLoadUnit);if(!format)return false;used.add(String(exercise.id));
      items.push({exerciseId:String(exercise.id),name:String(exercise.name),group:String(exercise.group),primaryMuscle:String(exercise.sub),role,roleLabel:LABELS[role],...format,...startingPrescription(profile,exercise,format)});
      return true;
    }
    for(const role of template.roles.slice(0,count))addRole(role);
    const duration=fitDuration(items,profile.sessionMinutes),exercises=items.map(item=>withPerformance(item,normalized,weekStart)),workingSets=exercises.reduce((sum,item)=>sum+item.sets,0),estimatedDurationSeconds=totalSeconds(items),estimatedDurationMinutes=Math.ceil(estimatedDurationSeconds/60);
    const missingRoles=requiredRoles.filter(role=>!items.some(item=>item.role===role)).map(role=>LABELS[role]),status=!exercises.length?"unavailable":missingRoles.length?"partial":"ready",readinessWarning=status==="ready"?null:`${status==="unavailable"?"No compatible exercises are available for this workout.":"This partial workout needs manual review."} Missing coverage: ${missingRoles.join(", ")}. Keep your actual experience level and movement limits; review compatible equipment or your workout setup.`;
    return {day,date:new Date(Date.parse(`${weekStart}T00:00:00Z`)+DAYS.indexOf(day)*86400000).toISOString().slice(0,10),label:status==="ready"?template.label:status==="partial"?"Partial workout · manual review":"Workout unavailable",plannedLabel:template.label,status,missingRoles,readinessWarning,rationale:readinessWarning||`${workingSets} working sets with ${goal==="strength"?"longer rests for strength-focused compound work":goal==="hypertrophy"?"moderate repetition ranges for muscle-focused training":"repeatable strength and muscle-building practice"}. About ${estimatedDurationMinutes} minutes including planned rests and setup.`,exercises,workingSets,estimatedDurationMinutes,estimatedDurationSeconds,availableMinutes:profile.sessionMinutes,durationAdjusted:duration.adjusted};
  });
  const summary=trainingSummary(sessions,profile,normalized);
  return {sessions,summary,modelVersion:MODEL_VERSION,evidenceFingerprint:normalized.fingerprint,progression:"Record every set. Load or assistance changes use two recent, complete, comparable workouts at the top of the range, subject to recorded effort and check-ins. These are optional next-workout targets, not automatic Plan changes.",frequencyCaveat:profile.sessionsPerWeek<2?"General adult guidance recommends strengthening all major muscle groups on at least two days per week; this reflects your selected one-day starting schedule.":"Review direct-muscle coverage below. Your selected days, time, and equipment determine which groups receive direct work twice per week."};
}
module.exports={buildTraining,CATALOG_FINGERPRINT,MODEL_VERSION};
