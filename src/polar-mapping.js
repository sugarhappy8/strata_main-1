// @ts-check
"use strict";

// Turns Polar AccessLink payloads into STRATA wellness rows. Every value is range-checked, anything missing or
// out of range becomes null, and unknown fields are ignored, so an unexpected payload can never corrupt a row.

const DATE=/^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} value @param {number} min @param {number} max @param {number} [digits] @returns {number|null} */
function numberIn(value,min,max,digits=1){
  if(value===null||value===undefined||value==="")return null;
  const number=Number(value);
  if(!Number.isFinite(number)||number<min||number>max)return null;
  const scale=10**digits;return Math.round(number*scale)/scale;
}
/** @param {unknown} value @param {number} min @param {number} max */
const integerIn=(value,min,max)=>numberIn(value,min,max,0);
/** @param {unknown} value */
const seconds=(value)=>integerIn(value,0,86400);
/** @param {unknown} value @returns {string|null} */
function dateKey(value){
  const text=String(value??"");
  if(!DATE.test(text))return null;
  const date=new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===text?text:null;
}
/** @param {unknown} value @returns {string|null} */
function timestamp(value){const text=String(value??"");return text.length<=40&&Number.isFinite(Date.parse(text))?text:null;}
/** @param {unknown} payload @param {string} key @returns {any[]} */
function list(payload,key){
  if(Array.isArray(payload))return payload;
  const value=payload&&typeof payload==="object"?/** @type {Record<string,unknown>} */(payload)[key]:null;
  return Array.isArray(value)?value:[];
}

/** An empty night, so sleep and Nightly Recharge for one date merge into a single row. @param {string} nightDate @param {number} updatedAt */
function blankNight(nightDate,updatedAt){
  return {nightDate,recoveryStatus:null,ansCharge:null,ansChargeStatus:null,sleepCharge:null,heartRateAvg:null,hrvAvg:null,breathingRateAvg:null,
    sleepScore:null,sleepStart:null,sleepEnd:null,asleepSeconds:null,lightSeconds:null,deepSeconds:null,remSeconds:null,interruptionSeconds:null,updatedAt};
}

/**
 * Merges Polar sleep nights and Nightly Recharge results by date.
 * @param {unknown} sleepPayload @param {unknown} rechargePayload @param {number} updatedAt
 * @returns {import("./domain-types").WellnessNightRecord[]}
 */
function nightsFromPolar(sleepPayload,rechargePayload,updatedAt){
  /** @type {Map<string,import("./domain-types").WellnessNightRecord>} */
  const nights=new Map();
  /** @param {string} date */
  const night=(date)=>{let record=nights.get(date);if(!record){record=blankNight(date,updatedAt);nights.set(date,record);}return record;};
  for(const sleep of list(sleepPayload,"nights")){
    const date=dateKey(sleep?.date);if(!date)continue;
    const record=night(date),light=seconds(sleep.light_sleep),deep=seconds(sleep.deep_sleep),rem=seconds(sleep.rem_sleep),other=seconds(sleep.unrecognized_sleep_stage);
    record.sleepScore=numberIn(sleep.sleep_score,0,100);record.sleepCharge=integerIn(sleep.sleep_charge,1,5);
    record.sleepStart=timestamp(sleep.sleep_start_time);record.sleepEnd=timestamp(sleep.sleep_end_time);
    record.lightSeconds=light;record.deepSeconds=deep;record.remSeconds=rem;record.interruptionSeconds=seconds(sleep.total_interruption_duration);
    record.asleepSeconds=light===null&&deep===null&&rem===null?null:Math.min(86400,(light||0)+(deep||0)+(rem||0)+(other||0));
  }
  for(const recharge of list(rechargePayload,"recharges")){
    const date=dateKey(recharge?.date);if(!date)continue;
    const record=night(date);
    record.recoveryStatus=integerIn(recharge.nightly_recharge_status,1,6);record.ansCharge=numberIn(recharge.ans_charge,-10,10);
    record.ansChargeStatus=integerIn(recharge.ans_charge_status,1,5);record.heartRateAvg=numberIn(recharge.heart_rate_avg,20,220);
    record.hrvAvg=numberIn(recharge.heart_rate_variability_avg,1,400);record.breathingRateAvg=numberIn(recharge.breathing_rate_avg,4,60);
  }
  return [...nights.values()].sort((a,b)=>a.nightDate.localeCompare(b.nightDate));
}

/** @param {unknown} value @returns {number|null} */
function minuteOfDay(value){
  const match=String(value??"").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!match)return null;
  const hours=Number(match[1]),minutes=Number(match[2]);
  return hours<24&&minutes<60?hours*60+minutes:null;
}

/**
 * Summarizes one day of Polar's 24/7 heart rate: the range, the average, 48 half-hour averages for a chart, and
 * the lowest half-hour average (with at least three samples) as a resting estimate.
 * @param {string} dayDate @param {unknown} payload @param {number} updatedAt
 * @returns {import("./domain-types").WellnessDayRecord|null}
 */
function dayFromHeartRate(dayDate,payload,updatedAt){
  if(!dateKey(dayDate))return null;
  const buckets=Array.from({length:48},()=>({sum:0,count:0}));
  let min=Infinity,max=-Infinity,sum=0,count=0;
  for(const sample of list(payload,"heart_rate_samples")){
    const rate=integerIn(sample?.heart_rate,20,250),minute=minuteOfDay(sample?.sample_time);
    if(rate===null||minute===null)continue;
    const bucket=buckets[Math.floor(minute/30)];if(!bucket)continue;
    bucket.sum+=rate;bucket.count+=1;sum+=rate;count+=1;min=Math.min(min,rate);max=Math.max(max,rate);
  }
  if(!count)return null;
  const averages=buckets.map((bucket)=>bucket.count?Math.round(bucket.sum/bucket.count):null);
  const settled=buckets.filter((bucket)=>bucket.count>=3).map((bucket)=>Math.round(bucket.sum/bucket.count));
  return {dayDate,restingHr:settled.length?Math.max(20,Math.min(220,Math.min(...settled))):null,minHr:min,avgHr:Math.round(sum/count),maxHr:max,samples:count,bucketsJson:JSON.stringify(averages),updatedAt};
}

/** ISO 8601 durations such as PT1H2M3.5S, in whole seconds. @param {unknown} value @returns {number|null} */
function isoDurationSeconds(value){
  const match=String(value??"").match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if(!match||!match[1]&&!match[2]&&!match[3])return null;
  const total=Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0);
  return Number.isFinite(total)&&total<=172800?Math.round(total):null;
}
/** Polar sport codes such as OTHER_INDOOR become "Other indoor". @param {unknown} value */
function sportLabel(value){
  const text=String(value??"").trim().replace(/_/g," ").toLowerCase().slice(0,40);
  return text?text.charAt(0).toUpperCase()+text.slice(1):"Workout";
}

/**
 * One Polar exercise as a device workout. Start times without a zone are local and come with an offset in
 * minutes, so the UTC start is the local time minus that offset.
 * @param {any} exercise @param {number} updatedAt @returns {import("./domain-types").WellnessWorkoutRecord|null}
 */
function workoutFromExercise(exercise,updatedAt){
  const externalId=String(exercise?.id??"");
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(externalId))return null;
  const start=String(exercise.start_time??""),match=start.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/);
  const localDate=match?dateKey(match[1]):null;if(!match||!localDate)return null;
  const offset=Number(exercise.start_time_utc_offset);
  const startedAt=match[2]?Date.parse(start):Date.parse(`${start}Z`)-(Number.isFinite(offset)&&Math.abs(offset)<=14*60?offset*60000:0);
  const durationSeconds=isoDurationSeconds(exercise.duration);
  if(!Number.isFinite(startedAt)||durationSeconds===null)return null;
  return {externalId,startedAt,localDate,durationSeconds,sport:sportLabel(exercise.detailed_sport_info||exercise.sport),
    calories:integerIn(exercise.calories,0,20000),hrAvg:integerIn(exercise.heart_rate?.average,20,250),hrMax:integerIn(exercise.heart_rate?.maximum,20,250),
    cardioLoad:numberIn(exercise.training_load,0,10000),updatedAt};
}

/** @param {unknown} payload @param {number} updatedAt */
function workoutsFromExercises(payload,updatedAt){
  return list(payload,"exercises").map((exercise)=>workoutFromExercise(exercise,updatedAt)).filter((workout)=>workout!==null);
}

module.exports={dateKey,dayFromHeartRate,isoDurationSeconds,nightsFromPolar,numberIn,sportLabel,workoutFromExercise,workoutsFromExercises};
