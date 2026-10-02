// @ts-check
"use strict";

const {randomUUID}=require("node:crypto");

/**
 * In-process event bus. Routes announce what happened ("plan.updated",
 * "workout.completed", "polar.sync.finished", "snapshot.ready", ...) and
 * other modules react without the routes knowing about them. Handlers run
 * in order and are awaited, so a route's response reflects every reaction;
 * a failing handler never breaks the request that caused it. With an outbox
 * store, the failed reaction (that one handler and its payload) is saved and
 * retried with backoff until it succeeds, so derived data catches up instead
 * of staying stale.
 */
const EVENT_NAMES=Object.freeze([
  "plan.updated",
  "workout.saved",
  "workout.completed",
  "preferences.saved",
  "coaching.profile_saved",
  "coaching.log_saved",
  "polar.sync.finished",
  "polar.data_deleted",
  "snapshot.ready"
]);
const FIRST_RETRY_MS=30*1000;
const MAX_RETRY_MS=6*60*60*1000;
const MAX_ATTEMPTS=12;
const LEASE_MS=2*60*1000;
const READ_RETRY_SPACING_MS=15*1000;
const RETRY_INTERVAL_MS=30*1000;

/** Delay before the next try after this many failed ones. @param {number} attempts */
const backoff=(attempts)=>Math.min(MAX_RETRY_MS,FIRST_RETRY_MS*2**Math.max(0,attempts-1));
/** Never the message itself, which can carry member data: the error's code or name. @param {unknown} error */
const errorLabel=(error)=>String(/** @type {any} */(error)?.code||/** @type {any} */(error)?.name||"Error").slice(0,80);

/**
 * @param {{logger?:{error?:Function,warn?:Function,info?:Function}|null,outbox?:import("./domain-types").ServerStateStore|null,now?:()=>number,makeId?:()=>string}} [options]
 */
function createEventBus({logger=null,outbox=null,now=Date.now,makeId=randomUUID}={}) {
  /** @type {Map<string,Array<{key:string,handler:(payload:any)=>unknown}>>} */
  const handlers=new Map();
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer=null;
  /** @param {string} name */
  function known(name) {
    if (!EVENT_NAMES.includes(name)) throw new TypeError(`Unknown event ${name}.`);
    return name;
  }
  /**
   * The key names this reaction in the outbox, so a retry after a restart finds the same handler.
   * @param {string} name @param {(payload:any)=>unknown} handler @param {string} [key]
   */
  function on(name,handler,key) {
    if (typeof handler!=="function") throw new TypeError("Event handlers must be functions.");
    const list=handlers.get(known(name))||[],entry={key:String(key||`${name}#${list.length}`),handler};
    if (list.some((item)=>item.key===entry.key)) throw new TypeError(`Event handler ${entry.key} is already registered.`);
    list.push(entry);handlers.set(name,list);
    return ()=>{const current=handlers.get(name)||[];handlers.set(name,current.filter((item)=>item!==entry));};
  }
  /** @param {string} name @param {string} key @param {Record<string,unknown>} payload @param {unknown} error */
  async function queue(name,key,payload,error) {
    if (!outbox) return;
    const time=now(),userId=payload.userId==null?null:String(payload.userId);
    try {
      await outbox.addOutboxEvent({id:makeId(),eventName:name,handlerKey:key,userId,payloadJson:JSON.stringify(payload),attempts:1,attemptedAt:time,nextAttemptAt:time+backoff(1),lastError:errorLabel(error),createdAt:time});
    } catch(failure) { logger?.error?.("event.outbox_failed",{event:name,handler:key,error:failure}); }
  }
  /** @param {string} name @param {Record<string,unknown>} [payload] */
  async function emit(name,payload={}) {
    const list=handlers.get(known(name))||[];
    let delivered=0;
    for (const {key,handler} of list) {
      try { await handler({...payload,event:name}); delivered+=1; }
      catch(error) { logger?.error?.("event.handler_failed",{event:name,handler:key,error}); await queue(name,key,payload,error); }
    }
    return delivered;
  }
  /** Runs claimed outbox rows; returns how many succeeded. @param {import("./domain-types").OutboxEventRow[]} rows */
  async function retry(rows) {
    let succeeded=0;
    for (const row of rows) {
      const time=now();
      if (!await outbox?.claimOutboxEvent(String(row.id),time,time+LEASE_MS)) continue;
      const name=String(row.event_name),key=String(row.handler_key),attempts=Number(row.attempts)+1;
      const entry=(handlers.get(name)||[]).find((item)=>item.key===key);
      if (!entry) { logger?.warn?.("event.handler_missing",{event:name,handler:key});await outbox?.completeOutboxEvent(String(row.id));continue; }
      try {
        let payload={};try { payload=JSON.parse(String(row.payload_json)); } catch { /* An unreadable payload fails below like any other. */ }
        await entry.handler({...payload,event:name});
        await outbox?.completeOutboxEvent(String(row.id));succeeded+=1;
        logger?.info?.("event.retry_succeeded",{event:name,handler:key,attempts});
      } catch(error) {
        const finished=now(),gaveUp=attempts>=MAX_ATTEMPTS;
        await outbox?.failOutboxEvent(String(row.id),{attempts,attemptedAt:finished,nextAttemptAt:finished+backoff(attempts),lastError:errorLabel(error),gaveUpAt:gaveUp?finished:null});
        logger?.[gaveUp?"error":"warn"]?.(gaveUp?"event.retry_gave_up":"event.retry_failed",{event:name,handler:key,attempts,error});
      }
    }
    return succeeded;
  }
  /** Retries every reaction whose backoff has passed. */
  async function retryDue(limit=50) {
    if (!outbox) return 0;
    return retry(await outbox.dueOutboxEvents(now(),limit));
  }
  /** Before a member's derived data is read, retries that member's queued reactions so the read is not stale. @param {string} userId */
  async function retryFor(userId,limit=20) {
    if (!outbox||!userId) return 0;
    const time=now();
    return retry(await outbox.userOutboxEvents(String(userId),time,time-READ_RETRY_SPACING_MS,limit));
  }
  function start(intervalMs=RETRY_INTERVAL_MS) {
    if (timer||!outbox) return;
    timer=setInterval(()=>{void retryDue().catch((error)=>logger?.error?.("event.retry_due_failed",{error}));},intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer);timer=null; }
  /** Given-up reactions are kept a while for inspection, then removed. @param {number} [keepMs] */
  async function cleanup(keepMs=30*24*60*60*1000) { await outbox?.deleteOldOutboxEvents(now()-keepMs); }
  return Object.freeze({on,emit,retryDue,retryFor,start,stop,cleanup,names:EVENT_NAMES});
}

module.exports={EVENT_NAMES,MAX_ATTEMPTS,backoff,createEventBus};
