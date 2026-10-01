// @ts-check
"use strict";

// Keeps connected devices in step with Polar. V4 is polling-only and keeps short-lived access credentials, so
// every active connection is refreshed when needed and read at least daily. The schedule lives in the database.

const {open,seal}=require("./devices-crypto");
const {parsePolarCredentials,serializePolarCredentials}=require("./polar-client");
const {daysFromHeartRate,nightsFromPolar,workoutsFromExercises}=require("./polar-mapping");

const DAY_MS=24*60*60*1000;
const FIRST_IMPORT_DAYS=28;
const RECHECK_DAYS=3;
const RECONNECT_CODES=new Set(["POLAR_AUTH","POLAR_V4_RECONNECT","DEVICE_KEY_MISSING","DEVICE_TOKEN_UNREADABLE"]);

/** @param {number} time */
const isoDate=(time)=>new Date(time).toISOString().slice(0,10);

/**
 * @param {{store:import("./domain-types").DeviceStore,polar:any,keys:import("./devices-crypto").DeviceKey[],hasAccess:(userId:string)=>Promise<boolean>,
 *   logger?:{info?:Function,warn?:Function,error?:Function}|null,now?:()=>number,intervalMs?:number,batchSize?:number,events?:import("./domain-types").EventBus|null}} dependencies
 */
function createDeviceSync({store,polar,keys,hasAccess,logger=null,now=Date.now,intervalMs=60000,batchSize=5,events=null}){
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
      let credentials=parsePolarCredentials(open(keys,String(row.token_sealed)));
      const refreshed=await polar.refreshCredentials(credentials);
      credentials=refreshed.credentials;
      if(refreshed.refreshed){
        const saved=await store.updateDeviceToken({...owner,tokenSealed:seal(keys,serializePolarCredentials(credentials)),tokenExpiresAt:credentials.expiresAt,updatedAt:now()});
        if(!saved)return {status:"stale"};
      }
      const token=credentials.accessToken,time=now(),today=isoDate(time);
      const behind=row.synced_through?Math.round((Date.parse(`${today}T00:00:00Z`)-Date.parse(`${row.synced_through}T00:00:00Z`))/DAY_MS)+2:FIRST_IMPORT_DAYS;
      const days=Math.min(FIRST_IMPORT_DAYS,Math.max(RECHECK_DAYS,Number.isFinite(behind)?behind:FIRST_IMPORT_DAYS)),from=isoDate(time-(days-1)*DAY_MS),to=isoDate(time+DAY_MS);
      const nights=nightsFromPolar(await polar.sleep(token,from,to),await polar.nightlyRecharge(token,from,to),time);
      for(const night of nights)if(night.nightDate>=from)await store.upsertWellnessNight(owner,night);
      for(const workout of workoutsFromExercises(await polar.exercises(token,from,to),time))await store.upsertWellnessWorkout(owner,workout);
      for(const day of daysFromHeartRate(await polar.heartRate(token,from,to),time))await store.upsertWellnessDay(owner,day);
      await record({syncedThrough:today,lastSyncAt:time,nextSyncAt:nextDaily(owner.userId),failures:0});
      logger?.info?.("device.synced",{provider:owner.provider,days,nights:nights.length});
      // The Training Log links new sessions and the Daily Snapshot rebuilds these days.
      await events?.emit("polar.sync.finished",{userId:owner.userId,provider:owner.provider,from,to:today});
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

  async function tick(){
    if(ticking)return;
    ticking=true;
    try{
      for(const row of await store.dueDeviceConnections(now(),batchSize))await syncConnection(row);
      if(now()-lastCleanup>=60*60*1000){lastCleanup=now();await store.deleteExpiredDeviceData(now());}
    }finally{ticking=false;}
  }

  return {
    syncConnection,tick,
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
