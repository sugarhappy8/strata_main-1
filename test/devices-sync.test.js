"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {randomBytes}=require("node:crypto");
const {keyId,tokenKey}=require("../src/devices-config");
const {open,seal}=require("../src/devices-crypto");
const {POLAR_SCOPES,parsePolarCredentials,serializePolarCredentials}=require("../src/polar-client");
const {FIRST_IMPORT_DAYS,RECHECK_DAYS,createDeviceSync}=require("../src/devices-sync");

const RAW=tokenKey(randomBytes(32).toString("base64")),KEYS=[{id:keyId(RAW),key:RAW}];
const NOW=Date.parse("2026-09-28T09:00:00Z"),HOUR=60*60*1000,DAY=24*HOUR;
const credentials=(overrides={})=>({version:4,accessToken:"member-access",refreshToken:"member-refresh",expiresAt:NOW+HOUR,scopes:[...POLAR_SCOPES],...overrides});

function fakeStore({due=[]}={}){
  const calls=[];
  const store={calls,nights:[],days:[],workouts:[],synced:[],tokens:[],
    async upsertWellnessNight(owner,night){store.nights.push({owner,night});},
    async upsertWellnessDay(owner,day){store.days.push({owner,day});},
    async upsertWellnessWorkout(owner,workout){store.workouts.push({owner,workout});},
    async updateDeviceToken(record){store.tokens.push(record);return true;},
    async recordDeviceSync(record){store.synced.push(record);return true;},
    async dueDeviceConnections(now,limit){calls.push(["due",now,limit]);return due.splice(0);},
    async deleteExpiredDeviceData(now){calls.push(["cleanup",now]);}
  };
  return store;
}
function fakePolar(overrides={}){
  const calls=[];
  return {calls,
    async refreshCredentials(value){calls.push(["refresh",value.accessToken]);return {credentials:value,refreshed:false};},
    async sleep(token,from,to){calls.push(["sleep",token,from,to]);return {nightSleeps:[{sleepDate:"2026-08-01",sleepEvaluation:{phaseDurations:{deep:"60s"}}},{sleepDate:"2026-09-27",sleepEvaluation:{phaseDurations:{deep:"3600s",light:"10000s",rem:"5000s"}}}]};},
    async nightlyRecharge(token,from,to){calls.push(["recharge",token,from,to]);return {nightlyRechargeResults:{nightlyRechargeResults:[{sleepResultDate:"2026-09-27",recoveryIndicator:4,meanNightlyRecoveryRri:1154,meanNightlyRecoveryRmssd:60}]}};},
    async exercises(token,from,to){calls.push(["exercises",token,from,to]);return {trainingSessions:[{identifier:{id:"ex1"},startTime:"2026-09-27T07:00:00Z",durationMillis:1800000,name:"Running"}]};},
    async heartRate(token,from,to){calls.push(["heartRate",token,from,to]);return {continuousSamples:{heartRateSamplesPerDay:[{date:"2026-09-27",samples:[{heartRate:55,offsetMillis:10800000}]}]}};},
    ...overrides};
}
function connection(overrides={}){return {user_id:"member",provider:"polar",provider_user_id:"local-connection",token_sealed:seal(KEYS,serializePolarCredentials(credentials())),synced_through:null,failures:0,...overrides};}
function worker(options={}){return createDeviceSync({store:options.store||fakeStore(),polar:options.polar||fakePolar(),keys:KEYS,hasAccess:options.hasAccess||(async()=>true),now:options.now||(()=>NOW),intervalMs:options.intervalMs||60000,...(options.logger?{logger:options.logger}:{})});}

test("the first import reads one V4 range and schedules the next daily check",async()=>{
  const store=fakeStore(),polar=fakePolar(),events=[];
  assert.deepEqual(await worker({store,polar,logger:{info:(name,detail)=>events.push([name,detail])}}).syncConnection(connection()),{status:"synced"});
  assert.equal(FIRST_IMPORT_DAYS,28);assert.deepEqual(store.nights.map((entry)=>entry.night.nightDate),["2026-09-27"]);
  assert.equal(store.nights[0].night.recoveryStatus,4);assert.deepEqual(store.nights[0].owner,{userId:"member",provider:"polar",providerUserId:"local-connection"});
  assert.equal(store.workouts.length,1);assert.equal(store.workouts[0].workout.sport,"Running");assert.equal(store.days.length,1);
  assert.deepEqual(polar.calls.map((call)=>call[0]),["refresh","sleep","recharge","exercises","heartRate"]);
  for(const call of polar.calls.slice(1)){assert.equal(call[1],"member-access");assert.equal(call[2],"2026-09-01");assert.equal(call[3],"2026-09-29");}
  const [record]=store.synced;assert.equal(record.status,"active");assert.equal(record.syncedThrough,"2026-09-28");assert.equal(record.lastSyncAt,NOW);assert.equal(record.lastError,null);assert.equal(record.failures,0);
  assert.ok(record.nextSyncAt>=NOW+20*HOUR&&record.nextSyncAt<NOW+24*HOUR);assert.deepEqual(events,[["device.synced",{provider:"polar",days:28,nights:2}]]);
});

test("later syncs recheck recent dates and catch up after a gap",async()=>{
  for(const [syncedThrough,expected] of [["2026-09-27",RECHECK_DAYS],["2026-09-28",RECHECK_DAYS],["2026-09-18",12],["2026-01-01",28],["garbage",28]]){
    const polar=fakePolar();await worker({polar}).syncConnection(connection({synced_through:syncedThrough}));
    const from=polar.calls.find((call)=>call[0]==="sleep")[2],days=Math.round((Date.parse("2026-09-28T00:00:00Z")-Date.parse(`${from}T00:00:00Z`))/DAY)+1;
    assert.equal(days,expected,syncedThrough);assert.equal(polar.calls.filter((call)=>call[0]==="heartRate").length,1);
  }
});

test("a rotated refresh token is sealed durably before V4 data reads",async()=>{
  const store=fakeStore(),next=credentials({accessToken:"access-new",refreshToken:"refresh-new",expiresAt:NOW+12*HOUR});
  const polar=fakePolar({async refreshCredentials(value){polar.calls.push(["refresh",value.accessToken]);return {credentials:next,refreshed:true};}});
  assert.deepEqual(await worker({store,polar}).syncConnection(connection()),{status:"synced"});assert.equal(store.tokens.length,1);
  assert.deepEqual(parsePolarCredentials(open(KEYS,store.tokens[0].tokenSealed)),next);assert.equal(store.tokens[0].tokenExpiresAt,next.expiresAt);
  assert.deepEqual({userId:store.tokens[0].userId,provider:store.tokens[0].provider,providerUserId:store.tokens[0].providerUserId},{userId:"member",provider:"polar",providerUserId:"local-connection"});
  assert.equal(polar.calls.find((call)=>call[0]==="sleep")[1],"access-new");
  const staleStore=fakeStore();staleStore.updateDeviceToken=async()=>false;
  assert.deepEqual(await worker({store:staleStore,polar}).syncConnection(connection()),{status:"stale"});assert.equal(staleStore.synced.length,0);
});

test("syncing pauses while Strata+ is inactive and keeps the stored data",async()=>{
  const store=fakeStore(),polar=fakePolar();assert.deepEqual(await worker({store,polar,hasAccess:async()=>false}).syncConnection(connection({failures:2})),{status:"paused"});
  assert.equal(polar.calls.length,0);assert.deepEqual(store.synced.map((record)=>[record.status,record.lastError,record.nextSyncAt,record.failures]),[["active","PLUS_INACTIVE",NOW+DAY,2]]);
});

test("V3 grants and V4 failures reconnect, rate-limit, or back off",async()=>{
  const cases=[
    [{refreshCredentials:async()=>{throw Object.assign(new Error("no"),{code:"POLAR_AUTH"});}},{},["reconnect","POLAR_AUTH",NOW+365*DAY,1]],
    [{},{token_sealed:seal(KEYS,"legacy-v3-token")},["reconnect","POLAR_V4_RECONNECT",NOW+365*DAY,1]],
    [{},{token_sealed:"v1.bad"},["reconnect","DEVICE_TOKEN_UNREADABLE",NOW+365*DAY,1]],
    [{sleep:async()=>{throw Object.assign(new Error("slow"),{code:"POLAR_RATE_LIMIT",retryAt:NOW+10*60*1000});}},{failures:1},["active","POLAR_RATE_LIMIT",NOW+10*60*1000,1]],
    [{heartRate:async()=>{throw Object.assign(new Error("down"),{code:"POLAR_UNAVAILABLE"});}},{failures:2},["active","POLAR_UNAVAILABLE",NOW+40*60*1000,3]],
    [{exercises:async()=>{throw new Error("unexpected");}},{failures:9},["active","DEVICE_SYNC_FAILED",NOW+6*HOUR,10]]
  ];
  for(const [overrides,row,expected] of cases){
    const store=fakeStore(),warnings=[],result=await createDeviceSync({store,polar:fakePolar(overrides),keys:KEYS,hasAccess:async()=>true,now:()=>NOW,logger:{warn:(name,detail)=>warnings.push([name,detail])}}).syncConnection(connection(row));
    assert.deepEqual(result,{status:"failed",code:expected[1]});assert.deepEqual(store.synced.map((record)=>[record.status,record.lastError,record.nextSyncAt,record.failures]),[expected]);assert.deepEqual(warnings,[["device.sync_failed",{provider:"polar",code:expected[1]}]]);
  }
});

test("one connection never syncs twice at the same time",async()=>{
  let release;const gate=new Promise((resolve)=>{release=resolve;});const sync=worker({polar:fakePolar({sleep:async()=>{await gate;return {nightSleeps:[]};}})});
  const first=sync.syncConnection(connection());assert.deepEqual(await sync.syncConnection(connection()),{status:"busy"});release();assert.deepEqual(await first,{status:"synced"});assert.deepEqual(await sync.syncConnection(connection()),{status:"synced"});
});

test("a tick syncs due connections and cleans up hourly",async()=>{
  let time=NOW;const store=fakeStore({due:[connection()]}),sync=worker({store,now:()=>time});await Promise.all([sync.tick(),sync.tick()]);
  assert.deepEqual(store.calls.map((call)=>call[0]),["due","cleanup"]);assert.equal(store.synced.length,1);await sync.tick();assert.equal(store.calls.filter((call)=>call[0]==="cleanup").length,1);
  time+=HOUR;await sync.tick();assert.equal(store.calls.filter((call)=>call[0]==="cleanup").length,2);
});

test("the sync loop starts once, runs soon after start, and stops cleanly",async()=>{
  const store=fakeStore(),errors=[],sync=createDeviceSync({store,polar:fakePolar(),keys:KEYS,hasAccess:async()=>true,intervalMs:20,logger:{error:(name)=>errors.push(name)}});
  sync.start();sync.start();await new Promise((resolve)=>setTimeout(resolve,120));sync.stop();sync.stop();const runs=store.calls.filter((call)=>call[0]==="due").length;assert.ok(runs>=2);
  await new Promise((resolve)=>setTimeout(resolve,60));assert.equal(store.calls.filter((call)=>call[0]==="due").length,runs);
  const failing=createDeviceSync({store:{...fakeStore(),dueDeviceConnections:async()=>{throw new Error("database offline");}},polar:fakePolar(),keys:KEYS,hasAccess:async()=>true,intervalMs:20,logger:{error:(name)=>errors.push(name)}});
  failing.start();await new Promise((resolve)=>setTimeout(resolve,60));failing.stop();assert.ok(errors.includes("device.sync_loop_failed"));
});
