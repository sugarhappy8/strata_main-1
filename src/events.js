// @ts-check
"use strict";

/**
 * In-process event bus. Routes announce what happened ("plan.updated",
 * "workout.completed", "polar.sync.finished", "snapshot.ready", ...) and
 * other modules react without the routes knowing about them. Handlers run
 * in order and are awaited, so a route's response reflects every reaction;
 * a failing handler is logged and never breaks the request that caused it.
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

/**
 * @param {{logger?:{error?:Function,info?:Function}|null}} [options]
 */
function createEventBus({logger=null}={}) {
  /** @type {Map<string,Array<(payload:any)=>unknown>>} */
  const handlers=new Map();
  /** @param {string} name */
  function known(name) {
    if (!EVENT_NAMES.includes(name)) throw new TypeError(`Unknown event ${name}.`);
    return name;
  }
  /** @param {string} name @param {(payload:any)=>unknown} handler */
  function on(name,handler) {
    if (typeof handler!=="function") throw new TypeError("Event handlers must be functions.");
    const list=handlers.get(known(name))||[];
    list.push(handler);handlers.set(name,list);
    return ()=>{const current=handlers.get(name)||[];handlers.set(name,current.filter((item)=>item!==handler));};
  }
  /** @param {string} name @param {Record<string,unknown>} [payload] */
  async function emit(name,payload={}) {
    const list=handlers.get(known(name))||[];
    let delivered=0;
    for (const handler of list) {
      try { await handler({...payload,event:name}); delivered+=1; }
      catch(error) { logger?.error?.("event.handler_failed",{event:name,error}); }
    }
    return delivered;
  }
  return Object.freeze({on,emit,names:EVENT_NAMES});
}

module.exports={EVENT_NAMES,createEventBus};
