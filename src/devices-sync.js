// @ts-check
"use strict";

// Keeps connected devices in step with Polar. Polar keeps only about 28 days of sleep, recovery, and heart-rate
// history, so every active connection is read at least daily and STRATA keeps its own copy; a webhook only makes
// a connection due sooner. The schedule lives in the database (next_sync_at), so a restart simply resumes it.

const {open}=require("./devices-crypto");
const {dayFromHeartRate,nightsFromPolar,workoutsFromExercises}=require("./polar-mapping");

const DAY_MS=24*60*60*1000;
const FIRST_IMPORT_DAYS=28;
const RECHECK_DAYS=3;
const RECONNECT_CODES=new Set(["POLAR_AUTH","DEVICE_KEY_MISSING","DEVICE_TOKEN_UNREADABLE"]);

/** @param {number} time */
const isoDate=(time)=>new Date(time).toISOString().slice(0,10);

/**
 * @param {{store:import("./domain-types").DeviceStore,polar:any,keys:import("./devices-crypto").DeviceKey[],hasAccess:(userId:string)=>Promise<boolean>,
 *   logger?:{info?:Function,warn?:Function,error?:Function}|null,now?:()=>number,intervalMs?:number,batchSize?:number}} dependencies
 */
function createDeviceSync({store,polar,keys,hasAccess,logger=null,now=Date.now,intervalMs=60000,batchSize=5}){
  /** @type {Set<string>} */
  const running=new Set();
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer=null;
  let ticking=false,lastCleanup=0;

  /** The next daily check, spread across a few hours per member so connections do not all sync at once. @param {string} userId */
  function nextDaily(userId){
    const spread=[...userId].reduce((hash,char)=>(hash*31+char.charCodeAt(0))>>>0,7)%(4*60*60*1000);
    return now()+20*60*60*1000+spread;
  }
  /** @param {number} failures */
  const backoff=(failures)=>now()+Math.min(6*60*60*1000,5*60*1000*2**Math.min(failures,7));

  /** Reads everything Polar still holds for the window and stores it. @param {any} row */
  async function syncConnection(row){
    const owner={userId:String(row.user_id),provider:String(row.provider),providerUserId:String(row.provider_user_id)},key=`${owner.userId}:${owner.provider}`;
    if(running.has(key))return {status:"busy"};
    running.add(key);
    const failures=Number(row.failures)||0;
    /** @param {{status?:string,syncedThrough?:string|null,lastSyncAt?:number|null,lastError?:string|null,nextSyncAt:number,failures:number}} outcome */
    const record=(outcome)=>store.recordDeviceSync({...owner,status:outcome.status||"active",syncedThrough:outcome.syncedThrough??null,lastSyncAt:outcome.lastSyncAt??null,
      lastError:outcome.lastError??null,nextSyncAt:outcome.nextSyncAt,failures:outcome.failures,updatedAt:now()});
    try{
      // Syncing pauses while Strata+ is inactive and resumes on renewal; stored data stays until disconnect.
      if(!await hasAccess(owner.userId)){await record({lastError:"PLUS_INACTIVE",nextSyncAt:now()+DAY_MS,failures});return {status:"paused"};}
      const token=open(keys,String(row.token_sealed)),time=now(),today=isoDate(time);
      const behind=row.synced_through?Math.round((Date.parse(`${today}T00:00:00Z`)-Date.parse(`${row.synced_through}T00:00:00Z`))/DAY_MS)+2:FIRST_IMPORT_DAYS;
      const days=Math.min(FIRST_IMPORT_DAYS,Math.max(RECHECK_DAYS,Number.isFinite(behind)?behind:FIRST_IMPORT_DAYS)),from=isoDate(time-(days-1)*DAY_MS);
      const nights=nightsFromPolar(await polar.sleep(token),await polar.nightlyRecharge(token),time);
      for(const night of nights)if(night.nightDate>=from)await store.upsertWellnessNight(owner,night);
      for(const workout of workoutsFromExercises(await polar.exercises(token),time))await store.upsertWellnessWorkout(owner,workout);
      // One extra day covers members whose local date is already ahead of UTC.
      for(let offset=days-1;offset>=-1;offset-=1){
        const date=isoDate(time-offset*DAY_MS),day=dayFromHeartRate(date,await polar.heartRate(token,date),time);
        if(day)await store.upsertWellnessDay(owner,day);
      }
      await record({syncedThrough:today,lastSyncAt:time,nextSyncAt:nextDaily(owner.userId),failures:0});
      logger?.info?.("device.synced",{provider:owner.provider,days,nights:nights.length});
      return {status:"synced"};
    }catch(error){
      const failure=/** @type {any} */(error),code=String(failure?.code||"DEVICE_SYNC_FAILED");
      if(RECONNECT_CODES.has(code))await record({status:"reconnect",lastError:code,nextSyncAt:now()+365*DAY_MS,failures:failures+1});
      else if(code==="POLAR_RATE_LIMIT")await record({lastError:code,nextSyncAt:Math.max(now()+60*1000,Number(failure.retryAt)||0),failures});
      else await record({lastError:code,nextSyncAt:backoff(failures+1),failures:failures+1});
      logger?.warn?.("device.sync_failed",{provider:owner.provider,code});
      return {status:"failed",code};
    }finally{running.delete(key);}
  }

  /** Tells Polar the app no longer has access for connections that were disconnected or deleted. */
  async function processRevocations(){
    for(const row of await store.dueDeviceRevocations(now(),batchSize)){
      const id=String(row.id);
      let token;
      try{token=open(keys,String(row.token_sealed));}catch{await store.deleteDeviceRevocation(id);continue;}
      try{await polar.deregisterUser(token,String(row.provider_user_id));await store.deleteDeviceRevocation(id);logger?.info?.("device.revoked",{provider:String(row.provider)});}
      catch(error){
        const attempts=(Number(row.attempts)||0)+1,retryAt=Number(/** @type {any} */(error)?.retryAt)||0;
        if(attempts>=10){await store.deleteDeviceRevocation(id);logger?.warn?.("device.revocation_abandoned",{provider:String(row.provider)});}
        else await store.rescheduleDeviceRevocation(id,attempts,Math.max(backoff(attempts),retryAt));
      }
    }
  }

  async function tick(){
    if(ticking)return;
    ticking=true;
    try{
      await processRevocations();
      for(const row of await store.dueDeviceConnections(now(),batchSize))await syncConnection(row);
      if(now()-lastCleanup>=60*60*1000){lastCleanup=now();await store.deleteExpiredDeviceData(now());}
    }finally{ticking=false;}
  }

  return {
    syncConnection,tick,processRevocations,
    /** A Polar webhook makes that member's connection due within a minute. @param {string} providerUserId */
    markWebhook:(providerUserId)=>store.markDeviceConnectionDue("polar",providerUserId,now()+60*1000,now()),
    start(){
      if(timer)return;
      const run=()=>void tick().catch((error)=>logger?.error?.("device.sync_loop_failed",{error}));
      timer=setInterval(run,intervalMs);timer.unref?.();
      setTimeout(run,Math.min(intervalMs,1000)).unref?.();
    },
    stop(){if(timer)clearInterval(timer);timer=null;}
  };
}

module.exports={FIRST_IMPORT_DAYS,RECHECK_DAYS,createDeviceSync};
