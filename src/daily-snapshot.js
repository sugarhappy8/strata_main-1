// @ts-check
"use strict";

// The Daily Snapshot: one stored row per member per day with the facts every screen and Strata AI read about
// that day: sleep, recovery, heart rate, training done versus planned, and the nutrition log. Rows are rebuilt
// when something that feeds them changes (a Polar sync, a finished workout, a diary entry, a plan edit) and
// announce `snapshot.ready`. The AI's Daily Brief is stored on the same row so no screen re-calls the model.

const {chargeLabel,recoveryLabel,stressSignals}=require("./wellness-core");
const {addDays,isDate,mondayOf}=require("./training-log");

const PROVIDER="polar";
const MAX_RANGE_DAYS=31;
const RETENTION_DAYS=400;

/** @param {unknown} value */
const num=(value)=>{if(value===null||value===undefined||value==="")return null;const number=Number(value);return Number.isFinite(number)?number:null;};
/** @param {Record<string,unknown>} value */
const anyValue=(value)=>Object.values(value).some((item)=>item!==null);

/**
 * Pure: the facts for one day. Missing sources stay null; nothing is estimated.
 * Days before the current week have no stored plan, so a day with nothing logged there is "untracked", not rest.
 * @param {{date:string,weekStart:string,night?:any,nightsBefore?:any[],day?:any,log?:any,entries?:any[]}} input
 */
function composeSnapshot({date,weekStart,night=null,nightsBefore=[],day=null,log=null,entries=[]}){
  const sleep=night?{score:num(night.sleep_score),asleepSeconds:num(night.asleep_seconds),deepSeconds:num(night.deep_seconds),remSeconds:num(night.rem_seconds),lightSeconds:num(night.light_seconds),interruptionSeconds:num(night.interruption_seconds),start:night.sleep_start??null,end:night.sleep_end??null}:null;
  const recovery=night?{status:num(night.recovery_status),label:recoveryLabel(night.recovery_status),ansCharge:num(night.ans_charge),ansChargeLabel:chargeLabel(night.ans_charge_status),sleepCharge:num(night.sleep_charge),sleepChargeLabel:chargeLabel(night.sleep_charge),stress:stressSignals(night,nightsBefore).level}:null;
  const heartValues={overnight:num(night?.heart_rate_avg),hrv:num(night?.hrv_avg),breathing:num(night?.breathing_rate_avg),resting:num(day?.resting_hr),min:num(day?.min_hr),avg:num(day?.avg_hr),max:num(day?.max_hr)};
  const today=entries.filter((entry)=>entry.date===date),plannedEntry=today.find((entry)=>entry.kind==="planned")||null;
  const done=today.filter((entry)=>entry.kind==="workout"&&entry.status==="completed"||entry.kind==="device_session").map((entry)=>({id:entry.id,source:entry.source,title:entry.title,durationSeconds:entry.durationSeconds,completedSets:entry.completedSets,cardioLoad:num(entry.device?.cardioLoad),fulfilsPlan:Boolean(entry.planDay)}));
  const plannedDay=Boolean(plannedEntry)||done.some((item)=>item.fulfilsPlan);
  const tracked=date>=weekStart,status=done.length?(plannedDay||!tracked?"done":"extra"):plannedEntry?plannedEntry.status:tracked?"rest":"untracked";
  const load=done.reduce((sum,item)=>sum+(item.cardioLoad||0),0);
  const nutrition=log?{calories:num(log.calories),proteinG:num(log.protein_g),carbsG:num(log.carbs_g),fatG:num(log.fat_g),morningWeightKg:num(log.morning_weight_kg),complete:log.intake_complete==null?null:Number(log.intake_complete)===1}:null;
  const sources=[...new Set([...(night||day?["polar"]:[]),...done.map((item)=>item.source),...(plannedEntry?[plannedEntry.source]:[]),...(nutrition?["manual"]:[])])].sort();
  return {version:1,date,sleep,recovery,heart:anyValue(heartValues)?heartValues:null,activity:null,
    training:{status,planned:plannedEntry?{exercises:plannedEntry.exerciseCount,sets:plannedEntry.totalSets,source:plannedEntry.source}:null,done,cardioLoad:load?Math.round(load*10)/10:null},
    nutrition,sources};
}

/** @param {any} row */
function snapshotRow(row){
  try{const snapshot=JSON.parse(String(row.snapshot_json));let brief=null;try{brief=row.brief_json?JSON.parse(String(row.brief_json)):null;}catch{brief=null;}
    return {...snapshot,brief,briefGeneratedAt:num(row.brief_generated_at),updatedAt:num(row.updated_at)};}catch{return null;}
}

/**
 * @param {{store:any,trainingLog:{read:(userId:string,range:{from:string,to:string,today:string})=>Promise<any[]>},events?:import("./domain-types").EventBus|null,logger?:{warn?:Function}|null,now?:()=>number}} dependencies
 */
function createDailySnapshots({store,trainingLog,events=null,logger=null,now=Date.now}){
  /** Builds and stores every day in a range, then announces each one. @param {string} userId @param {string} from @param {string} to @param {string} today */
  async function build(userId,from,to,today){
    const last=to>today?today:to;if(!isDate(from)||!isDate(last)||from>last)return [];
    const [nights,days,logs,entries]=await Promise.all([store.wellnessNights(userId,PROVIDER,addDays(from,-28),last),store.wellnessDays(userId,PROVIDER,from,last),store.coachingDailyLogs(userId,from,last),trainingLog.read(userId,{from,to:last,today}).catch(()=>[])]),weekStart=mondayOf(today);
    const built=[];
    for(let date=from;date<=last;date=addDays(date,1)){
      const index=nights.findIndex((/** @type {any} */ row)=>String(row.night_date)===date);
      const snapshot=composeSnapshot({date,weekStart,night:index>=0?nights[index]:null,nightsBefore:index>=0?nights.slice(0,index):[],day:days.find((/** @type {any} */ row)=>String(row.day_date)===date)||null,log:logs.find((/** @type {any} */ row)=>String(row.log_date)===date)||null,entries});
      await store.upsertDailySnapshot(userId,date,JSON.stringify(snapshot),now());built.push(snapshot);
      await events?.emit("snapshot.ready",{userId,date});
    }
    return built;
  }
  /**
   * Stored rows for a range. A rebuild that failed and is waiting in the outbox is retried first, and today and any
   * missing past day are rebuilt, so a read is never staler than its sources.
   * @param {string} userId @param {{from:string,to:string,today:string}} range
   */
  async function read(userId,{from,to,today}){
    if(!isDate(from)||!isDate(to)||from>to||(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000>=MAX_RANGE_DAYS)throw Object.assign(new Error("Choose a range of up to 31 days."),{status:400,code:"INVALID_SNAPSHOT_RANGE"});
    await events?.retryFor?.(userId).catch((/** @type {unknown} */ error)=>logger?.warn?.("snapshot.retry_failed",{error}));
    const stored=await store.dailySnapshots(userId,from,to),have=new Set(stored.map((/** @type {any} */ row)=>String(row.snapshot_date))),stale=[];
    for(let date=from;date<=to&&date<=today;date=addDays(date,1))if(date===today||!have.has(date))stale.push(date);
    if(stale.length)await build(userId,stale[0],stale.at(-1)||stale[0],today);
    return (await store.dailySnapshots(userId,from,to)).map(snapshotRow).filter(Boolean);
  }
  return {
    build,read,
    // A failed rebuild throws to the bus, which keeps it in the outbox and retries it.
    /** @param {import("./domain-types").EventBus} bus @param {(userId:string)=>string|Promise<string>} todayFor */
    subscribe(bus,todayFor){
      bus.on("polar.sync.finished",async(payload)=>{const userId=String(payload.userId),today=await todayFor(userId);await build(userId,String(payload.from),String(payload.to),today);},"snapshots.polar_sync");
      bus.on("workout.completed",async(payload)=>{const userId=String(payload.userId),date=String(payload.workout?.date||"");if(isDate(date))await build(userId,date,date,await todayFor(userId));},"snapshots.workout_completed");
      bus.on("coaching.log_saved",async(payload)=>{const userId=String(payload.userId),date=String(payload.date||"");if(isDate(date))await build(userId,date,date,await todayFor(userId));},"snapshots.coaching_log");
      bus.on("plan.updated",async(payload)=>{const userId=String(payload.userId),today=await todayFor(userId);await build(userId,mondayOf(today),today,today);},"snapshots.plan_updated");
    },
    /** @param {string} beforeDate */
    async cleanup(beforeDate){await store.deleteOldDailySnapshots(beforeDate);}
  };
}

module.exports={MAX_RANGE_DAYS,RETENTION_DAYS,composeSnapshot,createDailySnapshots,snapshotRow};
