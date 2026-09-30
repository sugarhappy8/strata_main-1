"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {randomBytes}=require("node:crypto");
const {keyId,tokenKey}=require("../src/devices-config");
const {seal}=require("../src/devices-crypto");
const {FIRST_IMPORT_DAYS,RECHECK_DAYS,createDeviceSync}=require("../src/devices-sync");

const RAW=tokenKey(randomBytes(32).toString("base64")),KEYS=[{id:keyId(RAW),key:RAW}];
const NOW=Date.parse("2026-09-28T09:00:00Z"),HOUR=60*60*1000,DAY=24*HOUR;

function fakeStore({due=[],revocations=[]}={}){
  const calls=[];
  const store={
    calls,nights:[],days:[],workouts:[],synced:[],
    async upsertWellnessNight(owner,night){store.nights.push({owner,night});},
    async upsertWellnessDay(owner,day){store.days.push({owner,day});},
    async upsertWellnessWorkout(owner,workout){store.workouts.push({owner,workout});},
    async recordDeviceSync(record){store.synced.push(record);return true;},
    async dueDeviceConnections(now,limit){calls.push(["due",now,limit]);return due.splice(0);},
    async dueDeviceRevocations(now,limit){calls.push(["revocations",now,limit]);return revocations.splice(0);},
    async deleteDeviceRevocation(id){calls.push(["deleteRevocation",id]);},
    async rescheduleDeviceRevocation(id,attempts,nextAttemptAt){calls.push(["reschedule",id,attempts,nextAttemptAt]);},
    async deleteExpiredDeviceData(now){calls.push(["cleanup",now]);},
    async markDeviceConnectionDue(...args){calls.push(["markDue",...args]);return {user_id:"member"};}
  };
  return store;
}
function fakePolar(overrides={}){
  const calls=[];
  return {calls,
    async sleep(token){calls.push(["sleep",token]);return {nights:[{date:"2026-08-01",deep_sleep:60},{date:"2026-09-27",deep_sleep:3600,light_sleep:10000,rem_sleep:5000}]};},
    async nightlyRecharge(token){calls.push(["recharge",token]);return {recharges:[{date:"2026-09-27",nightly_recharge_status:4,heart_rate_avg:52,heart_rate_variability_avg:60}]};},
    async exercises(token){calls.push(["exercises",token]);return [{id:"ex1",start_time:"2026-09-27T07:00:00Z",duration:"PT30M",sport:"RUNNING"}];},
    async heartRate(token,date){calls.push(["heartRate",date]);return {heart_rate_samples:[{heart_rate:55,sample_time:"03:00"}]};},
    async deregisterUser(token,id){calls.push(["deregister",token,id]);return {removed:true};},
    ...overrides};
}
function connection(overrides={}){return {user_id:"member",provider:"polar",provider_user_id:"12345",token_sealed:seal(KEYS,"member-token"),synced_through:null,failures:0,...overrides};}
function worker(options={}){return createDeviceSync({store:options.store||fakeStore(),polar:options.polar||fakePolar(),keys:KEYS,hasAccess:options.hasAccess||(async()=>true),now:options.now||(()=>NOW),intervalMs:options.intervalMs||60000,...(options.logger?{logger:options.logger}:{})});}

test("the first import reads Polar's full 28-day window and schedules the next daily check",async()=>{
  const store=fakeStore(),polar=fakePolar(),events=[];
  const sync=worker({store,polar,logger:{info:(name,detail)=>events.push([name,detail])}});
  assert.deepEqual(await sync.syncConnection(connection()),{status:"synced"});
  assert.equal(FIRST_IMPORT_DAYS,28);
  assert.deepEqual(store.nights.map((entry)=>entry.night.nightDate),["2026-09-27"],"nights older than the window are skipped");
  assert.equal(store.nights[0].night.recoveryStatus,4);assert.deepEqual(store.nights[0].owner,{userId:"member",provider:"polar",providerUserId:"12345"});
  assert.equal(store.workouts.length,1);assert.equal(store.workouts[0].workout.sport,"Running");
  const dates=polar.calls.filter((call)=>call[0]==="heartRate").map((call)=>call[1]);
  assert.equal(dates.length,29);assert.equal(dates[0],"2026-09-01");assert.equal(dates.at(-1),"2026-09-29","one day ahead covers members east of UTC");
  assert.ok(polar.calls.every((call)=>call[1]==="member-token"||call[0]==="heartRate"),"the sealed token is opened for Polar");
  const [record]=store.synced;
  assert.equal(record.status,"active");assert.equal(record.syncedThrough,"2026-09-28");assert.equal(record.lastSyncAt,NOW);assert.equal(record.lastError,null);assert.equal(record.failures,0);
  assert.ok(record.nextSyncAt>=NOW+20*HOUR&&record.nextSyncAt<NOW+24*HOUR);
  assert.deepEqual(events,[["device.synced",{provider:"polar",days:28,nights:2}]]);
});

test("later syncs recheck recent days and catch up after a gap",async()=>{
  for(const [syncedThrough,expected] of [["2026-09-27",RECHECK_DAYS],["2026-09-28",RECHECK_DAYS],["2026-09-18",12],["2026-01-01",28],["garbage",28]]){
    const polar=fakePolar();
    await worker({polar}).syncConnection(connection({synced_through:syncedThrough}));
    assert.equal(polar.calls.filter((call)=>call[0]==="heartRate").length,expected+1,syncedThrough);
  }
});

test("syncing pauses while Strata+ is inactive and keeps the stored data",async()=>{
  const store=fakeStore(),polar=fakePolar();
  assert.deepEqual(await worker({store,polar,hasAccess:async()=>false}).syncConnection(connection({failures:2})),{status:"paused"});
  assert.equal(polar.calls.length,0);
  assert.deepEqual(store.synced.map((record)=>[record.status,record.lastError,record.nextSyncAt,record.failures]),[["active","PLUS_INACTIVE",NOW+DAY,2]]);
});

test("sync failures ask for a reconnect, wait for Polar's rate limit, or back off",async()=>{
  const cases=[
    [{sleep:async()=>{throw Object.assign(new Error("no"),{code:"POLAR_AUTH"});}},{},["reconnect","POLAR_AUTH",NOW+365*DAY,1]],
    [{},{token_sealed:"v1.bad"},["reconnect","DEVICE_TOKEN_UNREADABLE",NOW+365*DAY,1]],
    [{sleep:async()=>{throw Object.assign(new Error("slow"),{code:"POLAR_RATE_LIMIT",retryAt:NOW+10*60*1000});}},{failures:1},["active","POLAR_RATE_LIMIT",NOW+10*60*1000,1]],
    [{sleep:async()=>{throw Object.assign(new Error("slow"),{code:"POLAR_RATE_LIMIT"});}},{},["active","POLAR_RATE_LIMIT",NOW+60*1000,0]],
    [{heartRate:async()=>{throw Object.assign(new Error("down"),{code:"POLAR_UNAVAILABLE"});}},{failures:2},["active","POLAR_UNAVAILABLE",NOW+40*60*1000,3]],
    [{exercises:async()=>{throw new Error("unexpected");}},{failures:9},["active","DEVICE_SYNC_FAILED",NOW+6*HOUR,10]]
  ];
  for(const [overrides,row,expected] of cases){
    const store=fakeStore(),warnings=[];
    const result=await createDeviceSync({store,polar:fakePolar(overrides),keys:KEYS,hasAccess:async()=>true,now:()=>NOW,logger:{warn:(name,detail)=>warnings.push([name,detail])}}).syncConnection(connection(row));
    assert.deepEqual(result,{status:"failed",code:expected[1]});
    assert.deepEqual(store.synced.map((record)=>[record.status,record.lastError,record.nextSyncAt,record.failures]),[expected]);
    assert.deepEqual(warnings,[["device.sync_failed",{provider:"polar",code:expected[1]}]]);
  }
});

test("one connection never syncs twice at the same time",async()=>{
  let release;const gate=new Promise((resolve)=>{release=resolve;});
  const sync=worker({polar:fakePolar({sleep:async()=>{await gate;return {nights:[]};}})});
  const first=sync.syncConnection(connection());
  assert.deepEqual(await sync.syncConnection(connection()),{status:"busy"});
  release();assert.deepEqual(await first,{status:"synced"});
  assert.deepEqual(await sync.syncConnection(connection()),{status:"synced"},"the lock is released afterwards");
});

test("disconnects and deleted accounts are revoked at Polar with retries",async()=>{
  const revocations=[
    {id:"ok",provider:"polar",provider_user_id:"1",token_sealed:seal(KEYS,"token-1"),attempts:0},
    {id:"unreadable",provider:"polar",provider_user_id:"2",token_sealed:"v1.x.y.z.w",attempts:0},
    {id:"retry",provider:"polar",provider_user_id:"3",token_sealed:seal(KEYS,"token-3"),attempts:2},
    {id:"give-up",provider:"polar",provider_user_id:"4",token_sealed:seal(KEYS,"token-4"),attempts:9}
  ];
  const store=fakeStore({revocations}),events=[];
  const polar=fakePolar({async deregisterUser(token,id){polar.calls.push(["deregister",token,id]);if(id!=="1")throw Object.assign(new Error("slow"),{code:"POLAR_RATE_LIMIT",retryAt:NOW+2*HOUR});return {removed:true};}});
  await createDeviceSync({store,polar,keys:KEYS,hasAccess:async()=>true,now:()=>NOW,logger:{info:(name)=>events.push(name),warn:(name)=>events.push(name)}}).processRevocations();
  assert.deepEqual(polar.calls.map((call)=>call.slice(1)),[["token-1","1"],["token-3","3"],["token-4","4"]]);
  assert.deepEqual(store.calls.filter((call)=>call[0]!=="revocations"),[["deleteRevocation","ok"],["deleteRevocation","unreadable"],["reschedule","retry",3,NOW+2*HOUR],["deleteRevocation","give-up"]]);
  assert.deepEqual(events,["device.revoked","device.revocation_abandoned"]);
});

test("a tick revokes, syncs due connections, and cleans up at most hourly",async()=>{
  let time=NOW;
  const store=fakeStore({due:[connection()]}),sync=worker({store,now:()=>time});
  await Promise.all([sync.tick(),sync.tick()]);
  assert.deepEqual(store.calls.map((call)=>call[0]),["revocations","due","cleanup"],"an overlapping tick does nothing");
  assert.equal(store.synced.length,1);
  await sync.tick();assert.equal(store.calls.filter((call)=>call[0]==="cleanup").length,1);
  time+=HOUR;await sync.tick();assert.equal(store.calls.filter((call)=>call[0]==="cleanup").length,2);
  await sync.markWebhook("12345");
  assert.deepEqual(store.calls.at(-1),["markDue","polar","12345",time+60*1000,time]);
});

test("the sync loop starts once, runs soon after start, and stops cleanly",async()=>{
  const store=fakeStore(),errors=[];
  const sync=createDeviceSync({store,polar:fakePolar(),keys:KEYS,hasAccess:async()=>true,intervalMs:20,logger:{error:(name)=>errors.push(name)}});
  sync.start();sync.start();
  await new Promise((resolve)=>setTimeout(resolve,120));
  sync.stop();sync.stop();
  const runs=store.calls.filter((call)=>call[0]==="due").length;
  assert.ok(runs>=2,`expected repeated ticks, saw ${runs}`);
  await new Promise((resolve)=>setTimeout(resolve,60));
  assert.equal(store.calls.filter((call)=>call[0]==="due").length,runs,"no ticks after stop");
  const failing=createDeviceSync({store:{...fakeStore(),dueDeviceRevocations:async()=>{throw new Error("database offline");}},polar:fakePolar(),keys:KEYS,hasAccess:async()=>true,intervalMs:20,logger:{error:(name)=>errors.push(name)}});
  failing.start();await new Promise((resolve)=>setTimeout(resolve,60));failing.stop();
  assert.ok(errors.includes("device.sync_loop_failed"));
});
