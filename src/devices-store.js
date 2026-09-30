// @ts-check
"use strict";

const {DEVICE_SQL}=require("./devices-schema");

const DAY_MS=24*60*60*1000;
/** @param {number} time */
const isoDate=(time)=>new Date(time).toISOString().slice(0,10);

/** @param {import("./domain-types").WellnessOwner} owner */
const ownerArgs=(owner)=>[owner.userId,owner.provider,owner.providerUserId];
/** @param {import("./domain-types").WellnessNightRecord} night */
const nightArgs=(night)=>[night.nightDate,night.recoveryStatus,night.ansCharge,night.ansChargeStatus,night.sleepCharge,night.heartRateAvg,night.hrvAvg,night.breathingRateAvg,night.sleepScore,night.sleepStart,night.sleepEnd,night.asleepSeconds,night.lightSeconds,night.deepSeconds,night.remSeconds,night.interruptionSeconds,night.updatedAt];
/** @param {import("./domain-types").WellnessDayRecord} day */
const dayArgs=(day)=>[day.dayDate,day.restingHr,day.minHr,day.avgHr,day.maxHr,day.samples,day.bucketsJson,day.updatedAt];
/** @param {import("./domain-types").WellnessWorkoutRecord} workout */
const workoutArgs=(workout)=>[workout.externalId,workout.startedAt,workout.localDate,workout.durationSeconds,workout.sport,workout.calories,workout.hrAvg,workout.hrMax,workout.cardioLoad,workout.updatedAt];
/** @param {import("./domain-types").DeviceConnectionRecord} record */
const connectionArgs=(record)=>[record.provider,record.providerUserId,record.memberRef,record.tokenSealed,record.tokenExpiresAt,record.settingsJson,record.consentVersion,record.connectedAt,record.nextSyncAt,record.updatedAt,record.userId];
/** @param {import("./domain-types").DeviceSyncRecord} record */
const syncArgs=(record)=>[record.status,record.syncedThrough,record.lastSyncAt,record.lastError,record.nextSyncAt,record.failures,record.updatedAt,record.userId,record.provider,record.providerUserId];
/** @param {import("./domain-types").DeviceConnectStateRecord} record */
const stateArgs=(record)=>[record.stateHash,record.provider,record.sessionHash,record.redirectUri,record.createdAt,record.expiresAt,record.userId];
/** @param {import("./domain-types").DeviceRevocationRecord} record */
const revocationArgs=(record)=>[record.id,record.provider,record.providerUserId,record.tokenSealed,record.createdAt,record.nextAttemptAt];
/** Cleanup cutoffs: connect states and stale revocations, 13 months of wellness data, and 28 days of heart-rate detail. @param {number} now */
function cleanupSteps(now){
  return /** @type {Array<[string,unknown[]]>} */([
    ["deleteExpiredDeviceStates",[now-60*60*1000]],["deleteStaleDeviceRevocations",[now-30*DAY_MS]],
    ["deleteOldWellnessNights",[isoDate(now-400*DAY_MS)]],["deleteOldWellnessDays",[isoDate(now-400*DAY_MS)]],
    ["deleteOldWellnessWorkouts",[now-400*DAY_MS]],["trimWellnessDayBuckets",[isoDate(now-28*DAY_MS)]]
  ]);
}
const DATA_DELETIONS=["deleteWellnessNights","deleteWellnessDays","deleteWellnessWorkouts"];

/** @param {import("./domain-types").LocalDeviceStoreDependencies} dependencies @returns {import("./domain-types").DeviceStore} */
function createLocalDeviceMethods({db,statements,plainRow}){
  /** @param {string} name */
  const statement=(name)=>{const prepared=statements[name];if(!prepared)throw new Error(`Missing device statement: ${name}`);return prepared;};
  /** @param {string} name @param {unknown[]} args */
  const one=(name,args)=>plainRow(statement(name).get(...args));
  /** @param {string} name @param {unknown[]} args */
  const many=(name,args)=>statement(name).all(...args).map((row)=>plainRow(row));
  return {
    async deviceConnection(userId,provider){return one("deviceConnection",[userId,provider]);},
    async deviceConnectionByProviderUser(provider,providerUserId){return one("deviceConnectionByProviderUser",[provider,providerUserId]);},
    async insertDeviceConnectState(record){return Boolean(one("insertDeviceConnectState",stateArgs(record)));},
    async readDeviceConnectState(stateHash){return one("readDeviceConnectState",[stateHash]);},
    async consumeDeviceConnectState(stateHash,userId,sessionHash,now){return one("consumeDeviceConnectState",[now,stateHash,userId,sessionHash,now]);},
    async discardDeviceConnectState(stateHash,now){statement("discardDeviceConnectState").run(now,stateHash);},
    async upsertDeviceConnection(record){return one("upsertDeviceConnection",connectionArgs(record));},
    async recordDeviceSync(record){return Boolean(one("recordDeviceSync",syncArgs(record)));},
    async markDeviceConnectionDue(provider,providerUserId,dueAt,now){return one("markDeviceConnectionDue",[dueAt,now,provider,providerUserId]);},
    async dueDeviceConnections(now,limit){return many("dueDeviceConnections",[now,limit]);},
    async updateDeviceSettings(userId,provider,settingsJson,expectedRevision,updatedAt){return one("updateDeviceSettings",[settingsJson,updatedAt,userId,provider,expectedRevision]);},
    async deleteDeviceData(userId,provider){
      let open=false;
      try{
        db.exec("BEGIN IMMEDIATE");open=true;
        const deleted=one("deleteDeviceConnection",[userId,provider]);
        for(const name of DATA_DELETIONS)statement(name).run(userId,provider);
        db.exec("COMMIT");open=false;
        return deleted;
      }catch(error){if(open)try{db.exec("ROLLBACK");}catch{/* Keep the original error. */}throw error;}
    },
    async insertDeviceRevocation(record){statement("insertDeviceRevocation").run(...revocationArgs(record));},
    async dueDeviceRevocations(now,limit){return many("dueDeviceRevocations",[now,limit]);},
    async rescheduleDeviceRevocation(id,attempts,nextAttemptAt){statement("rescheduleDeviceRevocation").run(attempts,nextAttemptAt,id);},
    async deleteDeviceRevocation(id){statement("deleteDeviceRevocation").run(id);},
    async cancelDeviceRevocations(provider,providerUserId){statement("cancelDeviceRevocations").run(provider,providerUserId);},
    async upsertWellnessNight(owner,night){statement("upsertWellnessNight").run(...nightArgs(night),...ownerArgs(owner));},
    async upsertWellnessDay(owner,day){statement("upsertWellnessDay").run(...dayArgs(day),...ownerArgs(owner));},
    async upsertWellnessWorkout(owner,workout){statement("upsertWellnessWorkout").run(...workoutArgs(workout),...ownerArgs(owner));},
    async wellnessNights(userId,provider,fromDate,toDate){return many("wellnessNights",[userId,provider,fromDate,toDate]);},
    async wellnessDays(userId,provider,fromDate,toDate){return many("wellnessDays",[userId,provider,fromDate,toDate]);},
    async wellnessWorkouts(userId,provider,fromTime,toTime){return many("wellnessWorkouts",[userId,provider,fromTime,toTime]);},
    async deleteExpiredDeviceData(now){for(const [name,args] of cleanupSteps(now))statement(name).run(...args);}
  };
}

/** @param {import("./domain-types").TursoDeviceStoreDependencies} dependencies @returns {import("./domain-types").DeviceStore} */
function createTursoDeviceMethods({client,first,all,run,plainRow}){
  return {
    deviceConnection:(userId,provider)=>first(DEVICE_SQL.deviceConnection,[userId,provider]),
    deviceConnectionByProviderUser:(provider,providerUserId)=>first(DEVICE_SQL.deviceConnectionByProviderUser,[provider,providerUserId]),
    async insertDeviceConnectState(record){return Boolean(await first(DEVICE_SQL.insertDeviceConnectState,stateArgs(record)));},
    readDeviceConnectState:(stateHash)=>first(DEVICE_SQL.readDeviceConnectState,[stateHash]),
    consumeDeviceConnectState:(stateHash,userId,sessionHash,now)=>first(DEVICE_SQL.consumeDeviceConnectState,[now,stateHash,userId,sessionHash,now]),
    async discardDeviceConnectState(stateHash,now){await run(DEVICE_SQL.discardDeviceConnectState,[now,stateHash]);},
    upsertDeviceConnection:(record)=>first(DEVICE_SQL.upsertDeviceConnection,connectionArgs(record)),
    async recordDeviceSync(record){return Boolean(await first(DEVICE_SQL.recordDeviceSync,syncArgs(record)));},
    markDeviceConnectionDue:(provider,providerUserId,dueAt,now)=>first(DEVICE_SQL.markDeviceConnectionDue,[dueAt,now,provider,providerUserId]),
    dueDeviceConnections:(now,limit)=>all(DEVICE_SQL.dueDeviceConnections,[now,limit]),
    updateDeviceSettings:(userId,provider,settingsJson,expectedRevision,updatedAt)=>first(DEVICE_SQL.updateDeviceSettings,[settingsJson,updatedAt,userId,provider,expectedRevision]),
    async deleteDeviceData(userId,provider){
      const sql=/** @type {Record<string,string>} */(DEVICE_SQL);
      const results=await client.batch([{sql:DEVICE_SQL.deleteDeviceConnection,args:[userId,provider]},...DATA_DELETIONS.map((name)=>({sql:String(sql[name]),args:[userId,provider]}))],"write");
      return plainRow(results[0]?.rows?.[0],results[0]?.columns);
    },
    async insertDeviceRevocation(record){await run(DEVICE_SQL.insertDeviceRevocation,revocationArgs(record));},
    dueDeviceRevocations:(now,limit)=>all(DEVICE_SQL.dueDeviceRevocations,[now,limit]),
    async rescheduleDeviceRevocation(id,attempts,nextAttemptAt){await run(DEVICE_SQL.rescheduleDeviceRevocation,[attempts,nextAttemptAt,id]);},
    async deleteDeviceRevocation(id){await run(DEVICE_SQL.deleteDeviceRevocation,[id]);},
    async cancelDeviceRevocations(provider,providerUserId){await run(DEVICE_SQL.cancelDeviceRevocations,[provider,providerUserId]);},
    async upsertWellnessNight(owner,night){await run(DEVICE_SQL.upsertWellnessNight,[...nightArgs(night),...ownerArgs(owner)]);},
    async upsertWellnessDay(owner,day){await run(DEVICE_SQL.upsertWellnessDay,[...dayArgs(day),...ownerArgs(owner)]);},
    async upsertWellnessWorkout(owner,workout){await run(DEVICE_SQL.upsertWellnessWorkout,[...workoutArgs(workout),...ownerArgs(owner)]);},
    wellnessNights:(userId,provider,fromDate,toDate)=>all(DEVICE_SQL.wellnessNights,[userId,provider,fromDate,toDate]),
    wellnessDays:(userId,provider,fromDate,toDate)=>all(DEVICE_SQL.wellnessDays,[userId,provider,fromDate,toDate]),
    wellnessWorkouts:(userId,provider,fromTime,toTime)=>all(DEVICE_SQL.wellnessWorkouts,[userId,provider,fromTime,toTime]),
    async deleteExpiredDeviceData(now){
      const sql=/** @type {Record<string,string>} */(DEVICE_SQL);
      await client.batch(cleanupSteps(now).map(([name,args])=>({sql:String(sql[name]),args})),"write");
    }
  };
}

module.exports={createLocalDeviceMethods,createTursoDeviceMethods};
