"use strict";

const {createHash}=require("node:crypto");
const {EXERCISE_IDS,DAYS}=require("./plans");

function workoutError(message,status=400,code="INVALID_WORKOUT") {
  return Object.assign(new Error(message),{status,code});
}
function object(value,label) {
  if (!value||typeof value!=="object"||Array.isArray(value)) throw workoutError(`${label} must be an object.`);
  return value;
}
function text(value,max,label,required=true) {
  if (typeof value!=="string"||value.length>max||/[\u0000-\u001f\u007f]/.test(value)||required&&!value.trim()) throw workoutError(`${label} is invalid.`);
  return value.trim();
}
function identifier(value,label) {
  if (typeof value!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw workoutError(`${label} is invalid.`);
  return value;
}
function optionalIdentifier(value,label) { return value==null||value===""?"":identifier(value,label); }
function note(value) {
  if (value==null) return "";
  if (typeof value!=="string"||value.length>500||/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(value)) throw workoutError("Exercise note is invalid.");
  return value.trim();
}
function integer(value,min,max,label) {
  if (!Number.isSafeInteger(value)||value<min||value>max) throw workoutError(`${label} must be a whole number from ${min} to ${max}.`);
  return value;
}
function choice(value,allowed,label) {
  if (!allowed.includes(value)) throw workoutError(`${label} is invalid.`);
  return value;
}
function nullableInteger(value,min,max,label) { return value===null?null:integer(value,min,max,label); }
function weightValue(value) {
  if (value===null) return null;
  if (typeof value!=="number"||!Number.isFinite(value)||value<0||value>1000||Math.abs(value*100-Math.round(value*100))>0.0000001) throw workoutError("Weight must be from 0 to 1000, with at most two decimal places.");
  return value;
}
function effortValue(value,type) {
  if (value==null) return null;
  const min=type==="rpe"?1:0;
  if (type==="none"||typeof value!=="number"||!Number.isFinite(value)||value<min||value>10||Math.abs(value*2-Math.round(value*2))>0.0000001) throw workoutError(type==="rpe"?"RPE must be from 1 to 10 in whole or half steps.":"RIR must be from 0 to 10 in whole or half steps.");
  return value;
}
function workoutSet(value,entry) {
  const input=object(value,"Set");
  if (typeof input.completed!=="boolean") throw workoutError("Set completion must be true or false.");
  const set={reps:nullableInteger(input.reps,0,1000,"Repetitions"),weight:weightValue(input.weight),seconds:nullableInteger(input.seconds,0,3600,"Set seconds"),completed:input.completed,effort:effortValue(input.effort,entry.effortType)};
  if (entry.measurement==="reps"&&set.seconds!==null||entry.measurement==="timed"&&set.reps!==null) throw workoutError("Use repetitions or time for each set, not both.");
  if (set.completed) {
    if (!(entry.measurement==="reps"?set.reps>0:set.seconds>0)) throw workoutError("Completed sets need positive repetitions or time.");
    if (entry.loadType!=="bodyweight"&&set.weight===null) throw workoutError("Enter the load or assistance for each completed set.");
  }
  return set;
}
function workoutEntry(value) {
  const input=object(value,"Exercise");
  const entry={
    id:identifier(input.id,"Entry ID"),exerciseId:identifier(input.exerciseId,"Exercise ID"),planInstanceId:optionalIdentifier(input.planInstanceId,"Plan exercise ID"),
    measurement:choice(input.measurement,["reps","timed"],"Measurement"),loadType:choice(input.loadType,["external","bodyweight","assisted"],"Load type"),
    unit:choice(input.unit,["kg","lb"],"Weight unit"),prescribedReps:text(input.prescribedReps,40,"Prescribed repetitions",false),note:note(input.note),
    effortType:choice(input.effortType??"none",["none","rir","rpe"],"Effort scale"),supersetGroup:optionalIdentifier(input.supersetGroup,"Superset group"),replacedFromExerciseId:optionalIdentifier(input.replacedFromExerciseId,"Replaced exercise")
  };
  if (!EXERCISE_IDS.has(entry.exerciseId)) throw workoutError("This exercise is not in the exercise catalog.");
  if (entry.replacedFromExerciseId&&!EXERCISE_IDS.has(entry.replacedFromExerciseId)) throw workoutError("The replaced exercise is not in the exercise catalog.");
  if (!Array.isArray(input.sets)||input.sets.length<1||input.sets.length>10) throw workoutError("Each exercise needs 1 to 10 sets.");
  return {...entry,sets:input.sets.map((set)=>workoutSet(set,entry))};
}

function sanitizeWorkout(value,now=Date.now()) {
  const input=object(value,"Workout");
  const workout={id:identifier(input.id,"Workout ID"),title:text(input.title,120,"Workout title"),planDay:choice(input.planDay,["",...DAYS],"Plan day"),date:input.date};
  if (typeof input.date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw workoutError("Workout date must use YYYY-MM-DD.");
  const date=new Date(`${input.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==input.date||date.getUTCFullYear()<1900||date.getUTCFullYear()>2200) throw workoutError("Workout date is invalid.");
  workout.status=choice(input.status,["active","completed"],"Workout status");
  workout.startedAt=integer(input.startedAt,0,now+300000,"Start time");
  workout.completedAt=nullableInteger(input.completedAt,workout.startedAt,now+300000,"Completion time");
  workout.elapsedSeconds=integer(input.elapsedSeconds,0,604800,"Elapsed seconds");
  workout.restEndsAt=nullableInteger(input.restEndsAt,workout.startedAt,now+3600000,"Rest deadline");
  if (workout.status==="active"&&workout.completedAt!==null||workout.status==="completed"&&(workout.completedAt===null||workout.restEndsAt!==null)) throw workoutError("Workout completion and timer state do not match its status.");
  if (!Array.isArray(input.entries)||input.entries.length<1||input.entries.length>30) throw workoutError("A workout needs 1 to 30 exercises.");
  workout.entries=input.entries.map(workoutEntry);
  if (new Set(workout.entries.map((entry)=>entry.id)).size!==workout.entries.length) throw workoutError("Exercise entry IDs must be unique within a workout.");
  if (workout.status==="completed"&&!workout.entries.some((entry)=>entry.sets.some((set)=>set.completed))) throw workoutError("Complete at least one set before finishing a workout.");
  // "recovery" marks a session the member chose to lighten after a poor night; the field is absent otherwise.
  if (input.adjustment!==undefined&&input.adjustment!==null&&input.adjustment!=="") workout.adjustment=choice(input.adjustment,["recovery"],"Workout adjustment");
  return workout;
}

function summarizeWorkout(workout) {
  const {id,title,planDay,date,status,startedAt,completedAt,elapsedSeconds}=workout;
  const result={id,title,planDay,date,status,startedAt,completedAt,elapsedSeconds,...(workout.adjustment?{adjustment:workout.adjustment}:{}),totalSets:0,completedSets:0,exerciseCount:workout.entries.length,exerciseSummaries:[]};
  const groups=new Map();
  for (const entry of workout.entries) {
    const {exerciseId,measurement,loadType,unit}=entry,key=JSON.stringify([exerciseId,measurement,loadType,unit]);
    if (!groups.has(key)) groups.set(key,{exerciseId,measurement,loadType,unit,completedSets:0,totalReps:0,maxReps:null,maxWeight:null,minAssistance:null,volume:0,totalSeconds:0,maxSeconds:null,setValues:[]});
    const summary=groups.get(key);
    result.totalSets+=entry.sets.length;
    for (const set of entry.sets) {
      if (!set.completed) continue;
      result.completedSets++;summary.completedSets++;
      if (measurement==="reps") {
        summary.totalReps+=set.reps;summary.maxReps=Math.max(summary.maxReps||0,set.reps);
        if (loadType==="external") summary.volume+=set.weight*set.reps;
      } else {
        summary.totalSeconds+=set.seconds;summary.maxSeconds=Math.max(summary.maxSeconds||0,set.seconds);
      }
      // Assistance is resistance removed; body mass is not a known external load.
      if (loadType==="external") summary.maxWeight=Math.max(summary.maxWeight||0,set.weight);
      if (loadType==="assisted") summary.minAssistance=summary.minAssistance===null?set.weight:Math.min(summary.minAssistance,set.weight);
      if (summary.setValues.length<10) summary.setValues.push({reps:set.reps,weight:set.weight,seconds:set.seconds,effort:set.effort,effortType:set.effort===null?"none":entry.effortType});
    }
  }
  result.exerciseSummaries=[...groups.values()].map((summary)=>({...summary,volume:Math.round(summary.volume*100)/100}));
  return result;
}
function workoutPayload(row,summary=false,includeMemory=false) {
  if (!row) return null;
  const payload={...JSON.parse(summary?row.summary_json:row.workout_json),revision:Number(row.revision),updatedAt:Number(row.updated_at)};
  if (summary&&!includeMemory) for (const entry of payload.exerciseSummaries||[]) delete entry.setValues;
  return payload;
}
function pagination(value,fallback,min,max) {
  if (value===null) return fallback;
  if (!/^\d+$/.test(value)) throw workoutError("History pagination is invalid.");
  return integer(Number(value),min,max,"History pagination");
}

function createWorkoutService({store,auth,requireAccess,rateAllowed,http,events=null}) {
  if (!store||!auth||typeof requireAccess!=="function"||typeof rateAllowed!=="function"||!http) throw new TypeError("Workout service requires store, auth, request guards, and HTTP helpers.");
  const {json,bodyJson}=http;
  function activeWorkoutConflict(res,workout) {
    json(res,409,{error:"You already have a workout in progress. Resume it before starting another.",code:"ACTIVE_WORKOUT_EXISTS",workout});
  }
  async function existingOrConflict(res,userId,id) {
    const current=workoutPayload(await store.workout(userId,id));
    json(res,current?409:404,current?{error:"This workout changed elsewhere. Review the saved workout before retrying.",code:"WORKOUT_CONFLICT",workout:current}:{error:"Workout not found.",code:"WORKOUT_NOT_FOUND"});
  }
  async function mutate(req,res,userId,id) {
    const input=object(await bodyJson(req),"Request");
    const expectedRevision=req.method==="POST"?null:integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER-1,"Expected revision");
    if (req.method==="DELETE") {
      if (await store.deleteWorkout(userId,id,expectedRevision)) json(res,200,{ok:true});
      else await existingOrConflict(res,userId,id);
      return;
    }
    const now=Date.now(),workout=sanitizeWorkout(input.workout,now);
    if (id&&id!==workout.id) throw workoutError("The workout ID does not match the URL.");
    const workoutJson=JSON.stringify(workout),digest=createHash("sha256").update(workoutJson).digest("hex");
    const record={id:workout.id,userId,workoutJson,summaryJson:JSON.stringify(summarizeWorkout(workout)),createHash:digest,startedAt:workout.startedAt,updatedAt:now};
    if (req.method==="POST") {
      const current=await store.workout(userId,workout.id);
      if (current?.create_hash===digest) { json(res,200,{workout:workoutPayload(current)});return; }
      if (current) { await existingOrConflict(res,userId,workout.id);return; }
      const saved=await store.insertWorkout(record);
      if (saved) { await events?.emit("workout.saved",{userId,workout,created:true});if (workout.status==="completed") await events?.emit("workout.completed",{userId,workout});json(res,201,{workout:workoutPayload(saved)});return; }
      const concurrent=await store.workout(userId,workout.id);
      if (concurrent?.create_hash===digest) { json(res,200,{workout:workoutPayload(concurrent)});return; }
      if (concurrent) { await existingOrConflict(res,userId,workout.id);return; }
      if (workout.status==="active") {
        const active=workoutPayload(await store.activeWorkout(userId));
        if (active) { activeWorkoutConflict(res,active);return; }
      }
      if (await store.workoutCount(userId)>=10000) throw workoutError("Workout history is full. Delete an old workout before adding another.",409,"WORKOUT_LIMIT");
      throw workoutError("Your account changed. Sign in again to save this workout.",409,"WORKOUT_ACCOUNT_CHANGED");
    }
    const current=workoutPayload(await store.workout(userId,id));
    if (!current) { await existingOrConflict(res,userId,id);return; }
    if (current.startedAt!==workout.startedAt) throw workoutError("A workout's start time cannot change.");
    const saved=await store.updateWorkout(record,expectedRevision);
    if (saved) { await events?.emit("workout.saved",{userId,workout,created:false});if (workout.status==="completed"&&current.status!=="completed") await events?.emit("workout.completed",{userId,workout});json(res,200,{workout:workoutPayload(saved)});return; }
    const concurrent=await store.workout(userId,id);
    if (concurrent&&Number(concurrent.revision)===expectedRevision&&workout.status==="active") {
      const active=workoutPayload(await store.activeWorkout(userId));
      if (active&&active.id!==id) { activeWorkoutConflict(res,active);return; }
    }
    await existingOrConflict(res,userId,id);
  }
  async function handleApi(req,res,url) {
    if (url.pathname!=="/api/workouts"&&!url.pathname.startsWith("/api/workouts/")) return false;
    const session=await requireAccess(req,res);if (!session) return true;
    try {
      const match=url.pathname.match(/^\/api\/workouts(?:\/([A-Za-z0-9_-]{1,100}))?$/);
      if (!match) throw workoutError("Workout not found.",404,"WORKOUT_NOT_FOUND");
      const id=match[1],allowed=id?["GET","PUT","DELETE"]:["GET","POST"];
      if (!allowed.includes(req.method)) { json(res,405,{error:"Method not allowed."},{Allow:allowed.join(", ")});return true; }
      if (!rateAllowed(req,`identity:workout:${req.method==="GET"?"read":"write"}:${session.id}`,req.method==="GET"?300:180,60000)) throw workoutError("Too many workout requests. Wait a moment and retry.",429,"WORKOUT_RATE_LIMIT");
      if (req.method==="GET") {
        if (id) {
          const workout=workoutPayload(await store.workout(session.id,id));
          if (!workout) throw workoutError("Workout not found.",404,"WORKOUT_NOT_FOUND");
          json(res,200,{workout,csrfToken:session.csrf_token});
        } else {
          const limit=pagination(url.searchParams.get("limit"),20,1,100),offset=pagination(url.searchParams.get("offset"),0,0,10000),memory=url.searchParams.get("memory");
          if (memory!==null&&memory!=="1") throw workoutError("Workout memory selection is invalid.");
          const rows=await store.workouts(session.id,limit+1,offset);
          json(res,200,{workouts:rows.slice(0,limit).map((row)=>workoutPayload(row,true,memory==="1")),hasMore:rows.length>limit,csrfToken:session.csrf_token});
        }
        return true;
      }
      if (!auth.validCsrf(req,session)) throw workoutError("Security check failed. Refresh and try again.",403,"INVALID_CSRF");
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"]||""))) throw workoutError("Workout requests must use JSON.",415,"JSON_REQUIRED");
      await mutate(req,res,session.id,id);
    } catch(error) {
      if (!error.status) throw error;
      json(res,error.status,{error:error.message,code:error.code||"INVALID_WORKOUT"});
    }
    return true;
  }
  return {handleApi};
}

module.exports={createWorkoutService,sanitizeWorkout,summarizeWorkout,workoutPayload};
