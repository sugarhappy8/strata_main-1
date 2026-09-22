// @ts-check
"use strict";

const {createHash}=require("node:crypto");
const {progressionForWorkout,prescribedRange}=require("./progression");
/** @typedef {Record<string,any>} Value */
/** @param {unknown} value @returns {value is Value} */
const record=(value)=>!!value&&typeof value==="object"&&!Array.isArray(value);
/** @param {unknown} value */
function validDate(value){return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}
/** @param {number} stamp @param {string} zone */
function dateInZone(stamp,zone){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(stamp));return ["year","month","day"].map(type=>parts.find(part=>part.type===type)?.value).join("-");}
/** Canonicalize only evidence that existed before this week. @param {Value} evidence @param {string} weekStart @param {string} zone */
function prepareEvidence(evidence,weekStart,zone="UTC"){
  const cutoff=Date.parse(`${weekStart}T00:00:00Z`),seen=new Set();let limited=evidence?.limited===true;
  const workouts=/** @type {Value[]} */([]);
  for(const raw of Array.isArray(evidence?.workouts)?evidence.workouts:[]){
    if(!record(raw)||raw.status!=="completed"||!validDate(raw.date)){limited=true;continue;}
    if(raw.date>=weekStart||Date.parse(raw.date)<cutoff-56*86400000)continue;
    if(typeof raw.id!=="string"||!raw.id||!Number.isSafeInteger(raw.startedAt)||!Number.isSafeInteger(raw.completedAt)||!Number.isFinite(new Date(raw.completedAt).getTime())||raw.startedAt<=0||raw.completedAt<raw.startedAt||!Array.isArray(raw.entries)){limited=true;continue;}
    if(dateInZone(raw.completedAt,zone)>=weekStart)continue;
    if(seen.has(raw.id)){limited=true;continue;}seen.add(raw.id);
    workouts.push({id:raw.id,status:"completed",date:raw.date,startedAt:raw.startedAt,completedAt:raw.completedAt,entries:raw.entries.filter(record).map(entry=>({id:entry.id,exerciseId:entry.exerciseId,measurement:entry.measurement,loadType:entry.loadType,unit:entry.unit,prescribedReps:entry.prescribedReps,effortType:entry.effortType,sets:Array.isArray(entry.sets)?entry.sets.map((/** @type {unknown} */ set)=>record(set)?{reps:set.reps,seconds:set.seconds,weight:set.weight,completed:set.completed,effort:set.effort}:null):[]}))});
  }
  workouts.sort((a,b)=>b.startedAt-a.startedAt||a.id.localeCompare(b.id));
  const checkIns=(Array.isArray(evidence?.checkIns)?evidence.checkIns:[]).filter((/** @type {unknown} */ row)=>record(row)&&seen.has(row.workoutId)&&[row.difficulty,row.energy,row.comfort,row.enjoyment].every(value=>Number.isInteger(value)&&value>=1&&value<=5)&&(!Number.isFinite(row.updatedAt)||dateInZone(row.updatedAt,zone)<weekStart)).map((/** @type {Value} */ row)=>({workoutId:row.workoutId,difficulty:row.difficulty,energy:row.energy,comfort:row.comfort,enjoyment:row.enjoyment})).sort((/** @type {Value} */ a,/** @type {Value} */ b)=>a.workoutId.localeCompare(b.workoutId)||JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const previous=evidence?.previousWeek?.training||evidence?.previousWeek;
  const previousSessions=Array.isArray(previous?.sessions)?previous.sessions.filter(record):[];
  const anchors=previousSessions.map((/** @type {Value} */ session)=>({day:session.day,label:session.label,exercises:(Array.isArray(session.exercises)?session.exercises:[]).filter(record).map((/** @type {Value} */ item)=>({exerciseId:item.exerciseId,role:item.role}))}));
  const fingerprint=createHash("sha256").update(JSON.stringify({workouts,checkIns,anchors,limited})).digest("hex").slice(0,16);
  return {workouts,checkIns,previousSessions:anchors,limited,fingerprint};
}
/** Preserve the catalog's actual unit and unilateral qualifier. @param {Value} exercise @param {string} unit */
function exerciseFormat(exercise,unit){
  const match=String(exercise.reps||"").trim().match(/^(\d+)\s*[–—-]\s*(\d+)\s*(s|sec|seconds|min|m|steps|contacts)?\s*(\/\s*side)?$/i);
  if(!match)return null;
  const suffix=(match[3]||"").toLowerCase(),measurement=["s","sec","seconds","min"].includes(suffix)?"timed":suffix==="m"?"distance":"reps",scale=suffix==="min"?60:1;
  const low=Number(match[1])*scale,high=Number(match[2])*scale;
  if(low<1||high<low||high>(measurement==="timed"?3600:1000))return null;
  // Match the workout logger: a support bench does not imply added resistance.
  const assisted=/\bassisted\b/i.test(exercise.name),bodyweight=["Bodyweight","Bench"].includes(exercise.equipment),loadType=assisted?"assisted":bodyweight?"bodyweight":"external";
  return {measurement,loadType,unit,low,high,perSide:!!match[4],countUnit:["steps","contacts"].includes(suffix)?suffix:null,quantifiableLoad:loadType!=="assisted"||exercise.equipment==="Machine"};
}
/** @param {Value} format @param {number} low @param {number} high */
function rangeLabel(format,low,high){return `${low===high?low:`${low}–${high}`}${format.measurement==="timed"?" s":format.measurement==="distance"?" m":format.countUnit?` ${format.countUnit}`:""}${format.perSide?" / side":""}`;}
/** @param {Value} profile @param {Value} exercise @param {Value} format */
function startingPrescription(profile,exercise,format){
  const compound=exercise.traits?.includes("compound"),goal=profile.trainingGoal||"balanced",baseline=profile.usualExercises.find((/** @type {Value} */ item)=>item.exerciseId===exercise.id)||null;
  let low=format.low,high=format.high;
  if(format.measurement==="reps"&&!format.countUnit){
    const desired=/** @type {[number,number]} */(goal==="strength"&&compound?[4,8]:goal==="hypertrophy"?[8,15]:compound?[6,12]:[10,15]);
    if(Math.max(low,desired[0])<=Math.min(high,desired[1])){low=Math.max(low,desired[0]);high=Math.min(high,desired[1]);}
    if(baseline){high=Math.min(high,baseline.maxReps);low=Math.min(low,high);}
  }
  const sets=Math.min(profile.experience==="beginner"?2:goal==="strength"&&!compound?2:3,baseline?.maxSets||10);
  const restSeconds=compound?(goal==="strength"?180:120):format.measurement==="distance"?90:75;
  const loadLabel=format.loadType==="assisted"?"assistance setting":format.loadType==="bodyweight"?"exercise variation":"load";
  let loadingGuidance=format.measurement==="reps"?`Choose the ${loadLabel} so that about 2–3 controlled repetitions remain in reserve.`:`Use the prescribed ${format.measurement==="timed"?"hold time":"distance"} with controlled technique; shorten it if needed.`;
  if(format.measurement==="distance")loadingGuidance+=" Distance requires manual tracking; automatic recorded-set targets are unavailable.";
  if(baseline)loadingGuidance+=format.measurement==="reps"?" Your entered sets and reps cap this starting prescription; the entered weight is a reference, not a tested maximum or an automatic load target.":" The capability form records repetitions, so its values do not set a time or distance target.";
  if(format.loadType==="assisted")loadingGuidance+=" More assistance makes the movement easier; do not treat it as lifted load.";
  return {sets,reps:rangeLabel(format,low,high),rest:restSeconds>=120?`${restSeconds/60} min`:`${restSeconds} sec`,restSeconds,targetRir:format.measurement==="reps"?"2–3":null,suggestedStartingLoad:null,loadingGuidance,enteredCapability:baseline,range:{low,high}};
}
/** A transparent planning estimate, not a measured workout duration. @param {Value} item */
function estimatedSeconds(item){const multiplier=item.perSide?2:1,work=item.measurement==="timed"?item.range.high*multiplier:item.measurement==="distance"?60*multiplier:Math.max(20,item.range.high*4)*multiplier;return Math.ceil(work*item.sets+Math.max(0,item.sets-1)*item.restSeconds+60);}
/** @param {Value[]} checkIns @param {string[]} ids */
function adverseCheckIn(checkIns,ids){const rows=checkIns.filter(row=>ids.includes(row.workoutId));if(!rows.length)return null;return {difficulty:Math.max(...rows.map(row=>row.difficulty)),energy:Math.min(...rows.map(row=>row.energy)),comfort:Math.min(...rows.map(row=>row.comfort)),enjoyment:Math.min(...rows.map(row=>row.enjoyment))};}
/** Keep actual targets separate from generic starting prescriptions. @param {Value} item @param {ReturnType<typeof prepareEvidence>} evidence @param {string} weekStart @returns {Value} */
function withPerformance(item,evidence,weekStart){
  const source=evidence.workouts.find(workout=>workout.entries.some((/** @type {Value} */ entry)=>entry.exerciseId===item.exerciseId));
  const none={status:item.measurement==="distance"?"manual_distance":"starting",sourceDate:null,explanation:item.measurement==="distance"?"Distance requires manual tracking; automatic recorded-set targets are unavailable.":"No recent comparable completed workout is available. Use the starting prescription and record each set."};
  if(!source)return {...item,performance:none,targetSets:null};
  const entries=source.entries.filter((/** @type {Value} */ entry)=>entry.exerciseId===item.exerciseId),entry=entries[0];
  const held=(/** @type {string} */ explanation,/** @type {string} */ status="reference_only")=>({...item,performance:{status,sourceDate:source.date,explanation},targetSets:null,loadingGuidance:explanation});
  if(Date.parse(weekStart)-Date.parse(source.date)>28*86400000)return held("The latest recorded workout is over 28 days old. Establish a current baseline before using it to progress.","stale");
  if(entries.length!==1||entry.measurement!==item.measurement||entry.loadType!==item.loadType||entry.unit!==item.unit||item.measurement==="distance"||!item.quantifiableLoad)return held("The latest recorded exercise has a different or ambiguous measurement, load type, or unit. Use a fresh baseline for this prescription.");
  const range=prescribedRange(entry),current=prescribedRange({measurement:item.measurement,prescribedReps:item.reps});
  if(!range||!current||range.low!==current.low||range.high!==current.high||entry.sets.length!==item.sets)return held("The latest workout used a different range or set count. Its values do not automatically set the targets for this prescription.");
  const previous=evidence.workouts.filter(workout=>workout.id!==source.id),prior=previous.find(workout=>workout.entries.some((/** @type {Value} */ candidate)=>candidate.exerciseId===item.exerciseId));
  const checkIn=adverseCheckIn(evidence.checkIns,[source.id,prior?.id||""]);
  const result=progressionForWorkout(source,prior?[prior]:[],checkIn),suggestion=result.suggestions.find((/** @type {Value} */ value)=>value.entryId===entry.id);
  if(!suggestion||suggestion.basis==="incomplete"||suggestion.basis==="ambiguous")return held("The latest workout did not contain one fully completed, valid exercise entry. Record a complete baseline before using automatic targets.","incomplete");
  if(evidence.limited&&suggestion.action!=="repeat")return held("The available workout history is incomplete. Repeat a controlled baseline before increasing the target.","limited_history");
  const targetSets=suggestion.targetSets.map((/** @type {Value} */ set)=>({...set})),metric=item.measurement==="timed"?"seconds":"reps";
  // The session time budget uses the prescription ceiling. Recorded work can
  // exceed that ceiling, but cannot silently expand this week's planned work.
  if(targetSets.some((/** @type {Value} */ set)=>Number(set[metric])>current.high))return held("The recorded targets exceed this prescription's time or repetition range. Use the starting prescription; review the range before carrying those targets into this workout.");
  const weights=targetSets.map((/** @type {Value} */ set)=>set.weight),uniform=weights.length&&weights.every((/** @type {any} */ value)=>value===weights[0]);
  const suggestedStartingLoad=item.loadType!=="bodyweight"&&uniform&&typeof weights[0]==="number"?{value:weights[0],unit:item.unit,kg:item.unit==="lb"?Math.round(weights[0]/2.2046226218*100)/100:weights[0],basis:item.loadType==="assisted"?"Recorded assistance setting; lower assistance is harder.":"Based on complete recorded sets in the same format, unit, range, and set count."}:null;
  return {...item,targetSets,suggestedStartingLoad,loadingGuidance:suggestion.explanation,performance:{status:suggestion.action==="repeat"?"repeat":"progression",sourceDate:source.date,workoutId:source.id,basis:suggestion.basis,action:suggestion.action,explanation:suggestion.explanation}};
}
module.exports={exerciseFormat,estimatedSeconds,prepareEvidence,startingPrescription,withPerformance};
