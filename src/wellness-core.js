// @ts-check
"use strict";

// Recovery, stress signals, sleep, and heart rate, always compared with the member's own usual nights. Polar's
// Nightly Recharge numbers are shown as Polar reports them; STRATA only adds its overnight stress signals and the
// optional lighter-session offer, and never describes any of this as a diagnosis.

const RECOVERY_LABELS=Object.freeze(["Very poor","Poor","Compromised","OK","Good","Very good"]);
const CHARGE_LABELS=Object.freeze(["Much below usual","Below usual","Usual","Above usual","Much above usual"]);
const LEARNING_NIGHTS=7;
const USUAL_NIGHTS=28;
const DAY_MS=24*60*60*1000;

/** @typedef {Record<string,any>} Row */

/** @param {unknown} value @returns {number|null} */
function num(value){if(value===null||value===undefined||value==="")return null;const number=Number(value);return Number.isFinite(number)?number:null;}
/** @param {number} value */
const round1=(value)=>Math.round(value*10)/10;
/** @param {string} date @param {number} days */
function addDays(date,days){return new Date(Date.parse(`${date}T00:00:00Z`)+days*DAY_MS).toISOString().slice(0,10);}
/** @param {string} from @param {string} to */
function daysBetween(from,to){return Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/DAY_MS);}

/**
 * The member's usual range: the median and the middle half of their recent nights. Nothing is compared until
 * at least seven nights exist. @param {Array<number|null>} values
 */
function usualRange(values){
  const sorted=values.filter((value)=>value!==null&&Number.isFinite(value)).map(Number).sort((a,b)=>a-b);
  if(sorted.length<LEARNING_NIGHTS)return null;
  /** @param {number} position */
  const quantile=(position)=>{const index=(sorted.length-1)*position,low=Math.floor(index),high=Math.ceil(index),a=sorted[low]??0,b=sorted[high]??a;return a+(b-a)*(index-low);};
  return {median:round1(quantile(0.5)),low:round1(quantile(0.25)),high:round1(quantile(0.75)),nights:sorted.length};
}

/** @param {unknown} status */
function recoveryLabel(status){const value=num(status);return value!==null&&value>=1&&value<=6?RECOVERY_LABELS[value-1]??null:null;}
/** @param {unknown} status */
function chargeLabel(status){const value=num(status);return value!==null&&value>=1&&value<=5?CHARGE_LABELS[value-1]??null:null;}

/**
 * Overnight stress signals for one night against the nights before it. "Higher than usual" needs Polar's ANS
 * charge below usual, or two of: HRV below its usual range, overnight heart rate above it, breathing rate above it.
 * @param {Row} night @param {Row[]} previous nights before this one, oldest first
 */
function stressSignals(night,previous){
  const history=previous.slice(-USUAL_NIGHTS);
  const counted=history.filter((row)=>num(row.hrv_avg)!==null||num(row.heart_rate_avg)!==null).length;
  if(counted<LEARNING_NIGHTS)return {level:"learning",nights:counted,needed:LEARNING_NIGHTS,signals:[],usual:null};
  const usual={hrv:usualRange(history.map((row)=>num(row.hrv_avg))),heartRate:usualRange(history.map((row)=>num(row.heart_rate_avg))),breathing:usualRange(history.map((row)=>num(row.breathing_rate_avg)))};
  /** @type {string[]} */
  const signals=[];
  const hrv=num(night.hrv_avg),heartRate=num(night.heart_rate_avg),breathing=num(night.breathing_rate_avg);
  if(hrv!==null&&usual.hrv&&hrv<usual.hrv.low)signals.push("hrv-low");
  if(heartRate!==null&&usual.heartRate&&heartRate>usual.heartRate.high)signals.push("heart-rate-high");
  if(breathing!==null&&usual.breathing&&breathing>usual.breathing.high)signals.push("breathing-high");
  const ansStatus=num(night.ans_charge_status),ans=num(night.ans_charge);
  const ansLow=ansStatus!==null?ansStatus<=2:ans!==null&&ans<=-3,ansHigh=ansStatus!==null?ansStatus>=4:ans!==null&&ans>=3;
  const level=ansLow||signals.length>=2?"higher":!signals.length&&ansHigh?"lower":"usual";
  return {level,nights:counted,needed:LEARNING_NIGHTS,signals:ansLow?["ans-low",...signals]:signals,usual};
}

/** @param {Row} night */
function recoveryOf(night){
  return {status:num(night.recovery_status),label:recoveryLabel(night.recovery_status),ansCharge:num(night.ans_charge),ansChargeLabel:chargeLabel(night.ans_charge_status),
    sleepCharge:num(night.sleep_charge),sleepChargeLabel:chargeLabel(night.sleep_charge)};
}

/**
 * Offers a lighter session for today only after a poor or very poor Nightly Recharge, or after two consecutive
 * nights with more stress signals than usual. A compromised night only earns a note.
 * @param {{night:Row,stress:{level:string}}|null} latest @param {{night:Row,stress:{level:string}}|null} previous
 */
function lighterSessionAdvice(latest,previous){
  if(!latest)return {offer:false,reason:null,note:null};
  const status=num(latest.night.recovery_status);
  if(status===1||status===2)return {offer:true,reason:"recovery",note:null};
  if(latest.stress.level==="higher"&&previous?.stress.level==="higher")return {offer:true,reason:"stress",note:null};
  return {offer:false,reason:null,note:status===3?"compromised":null};
}

/**
 * Everything the Today card, Train, and the Recovery page show about the latest night.
 * @param {{nights:Row[],days:Row[],today:string}} input nights and days oldest first
 */
function todaySummary({nights,days,today}){
  const valid=nights.filter((row)=>String(row.night_date)<=today);
  const latest=valid.at(-1);
  if(!latest)return {state:"no-data",lighterSession:{offer:false,reason:null,note:null}};
  const date=String(latest.night_date),ageDays=daysBetween(date,today),history=valid.slice(0,-1);
  const stress=stressSignals(latest,history),before=valid.at(-2);
  const previous=before&&daysBetween(String(before.night_date),date)===1?{night:before,stress:stressSignals(before,valid.slice(0,-2))}:null;
  const recent=history.slice(-USUAL_NIGHTS),day=days.find((row)=>row.day_date===today)||null;
  return {
    state:ageDays<=1?"current":"stale",date,ageDays,recovery:recoveryOf(latest),stress,
    sleep:{score:num(latest.sleep_score),asleepSeconds:num(latest.asleep_seconds),deepSeconds:num(latest.deep_seconds),lightSeconds:num(latest.light_seconds),remSeconds:num(latest.rem_seconds),
      interruptionSeconds:num(latest.interruption_seconds),start:latest.sleep_start??null,end:latest.sleep_end??null,usual:usualRange(recent.map((row)=>num(row.asleep_seconds)))},
    heart:{overnight:num(latest.heart_rate_avg),hrv:num(latest.hrv_avg),breathing:num(latest.breathing_rate_avg),usual:stress.usual,
      today:day?{resting:num(day.resting_hr),min:num(day.min_hr),avg:num(day.avg_hr),max:num(day.max_hr)}:null},
    lighterSession:ageDays<=1?lighterSessionAdvice({night:latest,stress},previous):{offer:false,reason:null,note:null}
  };
}

/**
 * Nightly series, usual ranges, and weekly averages for the Recovery page charts.
 * @param {{nights:Row[],today:string,weeks:number}} input nights oldest first, including the 28 before the range
 */
function trendSummary({nights,today,weeks}){
  const from=addDays(today,-(weeks*7-1)),inRange=nights.filter((row)=>String(row.night_date)>=from&&String(row.night_date)<=today);
  const series=inRange.map((row)=>({date:String(row.night_date),recoveryStatus:num(row.recovery_status),ansCharge:num(row.ans_charge),hrv:num(row.hrv_avg),heartRate:num(row.heart_rate_avg),
    breathing:num(row.breathing_rate_avg),sleepScore:num(row.sleep_score),asleepSeconds:num(row.asleep_seconds)}));
  const recent=nights.filter((row)=>String(row.night_date)<=today).slice(-USUAL_NIGHTS);
  const usual={hrv:usualRange(recent.map((row)=>num(row.hrv_avg))),heartRate:usualRange(recent.map((row)=>num(row.heart_rate_avg))),
    breathing:usualRange(recent.map((row)=>num(row.breathing_rate_avg))),sleepScore:usualRange(recent.map((row)=>num(row.sleep_score))),asleepSeconds:usualRange(recent.map((row)=>num(row.asleep_seconds)))};
  const weekly=Array.from({length:weeks},(_,index)=>{
    const start=addDays(from,index*7),end=addDays(start,6),rows=series.filter((point)=>point.date>=start&&point.date<=end);
    /** @param {"recoveryStatus"|"hrv"|"heartRate"|"sleepScore"|"asleepSeconds"} key */
    const average=(key)=>{const values=rows.map((point)=>point[key]).filter((value)=>value!==null).map(Number);return values.length?round1(values.reduce((sum,value)=>sum+value,0)/values.length):null;};
    return {start,end,nights:rows.length,recoveryStatus:average("recoveryStatus"),hrv:average("hrv"),heartRate:average("heartRate"),sleepScore:average("sleepScore"),asleepSeconds:average("asleepSeconds")};
  });
  return {from,to:today,weeks,series,usual,weekly};
}

module.exports={CHARGE_LABELS,LEARNING_NIGHTS,RECOVERY_LABELS,addDays,chargeLabel,daysBetween,lighterSessionAdvice,recoveryLabel,stressSignals,todaySummary,trendSummary,usualRange};
