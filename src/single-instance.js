// @ts-check
"use strict";

// STRATA runs as one server (render.yaml numInstances: 1). Rate limits, the AI queue, the event outbox, and the Polar
// loop are shared through the database, but the AI per-minute cap, in-flight marks, and timers live in each process.
// Every server renews a heartbeat lock; one that keeps finding another holder is a second server on the same database,
// and it says so in the log. A deploy overlaps the old and new server for a moment, so one miss is not enough.
const {randomUUID}=require("node:crypto");

const LOCK_NAME="server-instance";
const HEARTBEAT_MS=60_000;
const LOCK_MS=150_000;
const MISSES_BEFORE_WARNING=3;
const MISSES_BETWEEN_WARNINGS=60;

/**
 * @param {{store:Pick<import("./domain-types").ServerStateStore,"acquireLock"|"releaseLock">,logger:{warn?:Function,error?:Function}|null,
 *   id?:string,now?:()=>number,intervalMs?:number}} dependencies
 */
function createSingleInstanceGuard({store,logger,id=randomUUID(),now=Date.now,intervalMs=HEARTBEAT_MS}){
  let misses=0;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer=null;
  /** True while this server holds the heartbeat. */
  async function check(){
    const time=now();
    if(await store.acquireLock(LOCK_NAME,id,time+LOCK_MS,time)){misses=0;return true;}
    misses+=1;
    if(misses%MISSES_BETWEEN_WARNINGS===MISSES_BEFORE_WARNING)logger?.warn?.("service.multiple_instances",{detail:"Another STRATA server is using this database. STRATA supports one server; set numInstances: 1."});
    return false;
  }
  const safeCheck=()=>check().catch((error)=>{logger?.error?.("service.instance_check_failed",{error});return false;});
  return {
    check,
    async start(){if(timer)return;await safeCheck();timer=setInterval(()=>{void safeCheck();},intervalMs);timer.unref?.();},
    async stop(){if(timer)clearInterval(timer);timer=null;await store.releaseLock(LOCK_NAME,id).catch(()=>{});}
  };
}

module.exports={HEARTBEAT_MS,LOCK_MS,MISSES_BEFORE_WARNING,createSingleInstanceGuard};
