// @ts-check
"use strict";

const {SERVER_STATE_SQL}=require("./server-state-schema");

/** @param {import("./domain-types").OutboxEventRecord} record */
const outboxArgs=(record)=>[record.id,record.eventName,record.handlerKey,record.userId,record.payloadJson,record.attempts,record.attemptedAt,record.nextAttemptAt,record.lastError,record.createdAt];
/** @param {string} key @param {number} max @param {number} windowMs @param {number} now */
const rateArgs=(key,max,windowMs,now)=>{const expired=now-windowMs;return [key,now,expired,expired,expired,max];};
/** @param {string} id @param {import("./domain-types").OutboxFailure} failure */
const failureArgs=(id,failure)=>[failure.attempts,failure.attemptedAt,failure.nextAttemptAt,failure.lastError,failure.gaveUpAt,id];

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").ServerStateStore} */
function createLocalServerStateMethods({statements,plainRow}){
  /** @param {string} name */
  const statement=(name)=>{const prepared=statements[name];if(!prepared)throw new Error(`Missing server-state statement: ${name}`);return prepared;};
  return {
    async addOutboxEvent(record){statement("addOutboxEvent").run(...outboxArgs(record));},
    async dueOutboxEvents(now,limit){return statement("dueOutboxEvents").all(now,now,limit).map((row)=>plainRow(row));},
    async userOutboxEvents(userId,now,attemptedBefore,limit){return statement("userOutboxEvents").all(userId,now,attemptedBefore,limit).map((row)=>plainRow(row));},
    async claimOutboxEvent(id,now,leaseUntil){return Boolean(plainRow(statement("claimOutboxEvent").get(leaseUntil,id,now)));},
    async completeOutboxEvent(id){statement("completeOutboxEvent").run(id);},
    async failOutboxEvent(id,failure){statement("failOutboxEvent").run(...failureArgs(id,failure));},
    async deleteOldOutboxEvents(before){statement("deleteOldOutboxEvents").run(before);},
    async takeRateSlot(key,max,windowMs,now){return Boolean(plainRow(statement("takeRateSlot").get(...rateArgs(key,max,windowMs,now))));},
    async deleteOldRateBuckets(before){statement("deleteOldRateBuckets").run(before);},
    async acquireLock(name,holder,expiresAt,now){return Boolean(plainRow(statement("acquireLock").get(name,holder,expiresAt,now)));},
    async releaseLock(name,holder){statement("releaseLock").run(name,holder);}
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").ServerStateStore} */
function createTursoServerStateMethods({first,all,run}){
  return {
    async addOutboxEvent(record){await run(SERVER_STATE_SQL.addOutboxEvent,outboxArgs(record));},
    dueOutboxEvents:(now,limit)=>all(SERVER_STATE_SQL.dueOutboxEvents,[now,now,limit]),
    userOutboxEvents:(userId,now,attemptedBefore,limit)=>all(SERVER_STATE_SQL.userOutboxEvents,[userId,now,attemptedBefore,limit]),
    async claimOutboxEvent(id,now,leaseUntil){return Boolean(await first(SERVER_STATE_SQL.claimOutboxEvent,[leaseUntil,id,now]));},
    async completeOutboxEvent(id){await run(SERVER_STATE_SQL.completeOutboxEvent,[id]);},
    async failOutboxEvent(id,failure){await run(SERVER_STATE_SQL.failOutboxEvent,failureArgs(id,failure));},
    async deleteOldOutboxEvents(before){await run(SERVER_STATE_SQL.deleteOldOutboxEvents,[before]);},
    async takeRateSlot(key,max,windowMs,now){return Boolean(await first(SERVER_STATE_SQL.takeRateSlot,rateArgs(key,max,windowMs,now)));},
    async deleteOldRateBuckets(before){await run(SERVER_STATE_SQL.deleteOldRateBuckets,[before]);},
    async acquireLock(name,holder,expiresAt,now){return Boolean(await first(SERVER_STATE_SQL.acquireLock,[name,holder,expiresAt,now]));},
    async releaseLock(name,holder){await run(SERVER_STATE_SQL.releaseLock,[name,holder]);}
  };
}

module.exports={createLocalServerStateMethods,createTursoServerStateMethods};
