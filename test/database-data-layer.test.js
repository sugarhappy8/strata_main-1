"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {createStore}=require("../src/database");
const {fakeTursoFactory}=require("./support/workout-fixtures");

const ROOT=join(__dirname,".."),RUNTIME=join(ROOT,"test-runtime");

async function stores(){
  mkdirSync(RUNTIME,{recursive:true});const directory=mkdtempSync(join(RUNTIME,"data-layer-parity-"));
  const previous={NODE_ENV:process.env.NODE_ENV,STRATA_DATA_DIR:process.env.STRATA_DATA_DIR,TURSO_DATABASE_URL:process.env.TURSO_DATABASE_URL,TURSO_AUTH_TOKEN:process.env.TURSO_AUTH_TOKEN};
  process.env.NODE_ENV="test";process.env.STRATA_DATA_DIR=directory;delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
  const local=await createStore(ROOT);delete process.env.STRATA_DATA_DIR;process.env.TURSO_DATABASE_URL="https://data-layer-parity.invalid";process.env.TURSO_AUTH_TOKEN="test-token";
  const turso=await createStore(ROOT,{tursoClientFactory:fakeTursoFactory()});
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  return {local,turso,async close(){await Promise.all([local.close(),turso.close()]);rmSync(directory,{recursive:true,force:true});}};
}

async function scenario(store,suffix){
  const now=1_900_000_000_000,user={id:`data-${suffix}`,name:"Data Member",email:`data-${suffix}@example.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:now,emailVerifiedAt:now};
  await store.insertUser(user);
  await store.upsertTrainingLink(user.id,{provider:"polar",externalId:"ex-1",workoutId:"w-1",method:"time_overlap",linkedAt:now+1});
  await store.upsertTrainingLink(user.id,{provider:"polar",externalId:"ex-1",workoutId:"w-2",method:"same_day",linkedAt:now+2});
  await store.upsertTrainingLink(user.id,{provider:"polar",externalId:"ex-2",workoutId:"w-3",method:"time_overlap",linkedAt:now+3});
  await store.deleteTrainingLink(user.id,"polar","ex-2");
  const links=(await store.trainingLinks(user.id)).map((row)=>[row.external_id,row.workout_id,row.method]);
  await store.upsertDailySnapshot(user.id,"2030-03-04",JSON.stringify({version:1,date:"2030-03-04"}),now+4);
  await store.upsertDailySnapshot(user.id,"2030-03-05",JSON.stringify({version:1,date:"2030-03-05"}),now+5);
  const briefSaved=await store.saveDailyBrief(user.id,"2030-03-04",JSON.stringify({headline:"Train as planned"}),now+6),briefMissing=await store.saveDailyBrief(user.id,"2030-03-09",JSON.stringify({headline:"x"}),now+6);
  await store.upsertDailySnapshot(user.id,"2030-03-04",JSON.stringify({version:1,date:"2030-03-04",rebuilt:true}),now+7);
  const snapshots=(await store.dailySnapshots(user.id,"2030-03-01","2030-03-31")).map((row)=>({date:row.snapshot_date,data:JSON.parse(row.snapshot_json),brief:row.brief_json?JSON.parse(row.brief_json):null}));
  for(let index=0;index<4;index+=1)await store.insertPlanChange(user.id,{planUpdatedAt:now+10+index,source:index===2?"ai":"manual",detail:index===2?"ai-proposal":"plan-edit",createdAt:now+10+index},3);
  const changes=(await store.planChanges(user.id,10)).map((row)=>[Number(row.plan_updated_at)-now,row.source]);
  const exported=await store.accountExport(user.id);
  await store.deleteDailyBriefs(user.id,now+20);const afterBriefDelete=(await store.dailySnapshots(user.id,"2030-03-04","2030-03-04"))[0].brief_json;
  await store.deleteOldDailySnapshots("2030-03-05");const afterCleanup=(await store.dailySnapshots(user.id,"2030-03-01","2030-03-31")).map((row)=>row.snapshot_date);
  await store.upsertAccountAction({requestId:`delete-${suffix}`,userId:user.id,purpose:"account_delete",tokenHash:`delete-token-${suffix}`,expiresAt:now+1000,deliveryState:"sent",createdAt:now+21,updatedAt:now+21});
  const deletion=await store.deleteAccount(`delete-token-${suffix}`,now+22,"email-hash");
  return {links,snapshots,briefSaved,briefMissing,changes,exported:{snapshots:exported.dailySnapshots.length,planChanges:exported.planChanges.length,links:exported.trainingLinks.length},afterBriefDelete,afterCleanup,
    deleted:deletion.status,after:{links:(await store.trainingLinks(user.id)).length,snapshots:(await store.dailySnapshots(user.id,"2030-01-01","2030-12-31")).length,changes:(await store.planChanges(user.id,10)).length}};
}

test("SQLite and Turso keep Training Log links, Daily Snapshots, and plan history identical",{concurrency:false},async()=>{
  const pair=await stores();
  try{
    const local=await scenario(pair.local,"local"),turso=await scenario(pair.turso,"turso");
    assert.deepEqual(turso,local);
    assert.deepEqual(local.links,[["ex-1","w-2","same_day"]],"a session has one link and relinking replaces it");
    assert.deepEqual(local.snapshots,[{date:"2030-03-04",data:{version:1,date:"2030-03-04",rebuilt:true},brief:{headline:"Train as planned"}},{date:"2030-03-05",data:{version:1,date:"2030-03-05"},brief:null}],"rebuilding a day keeps its stored brief");
    assert.equal(local.briefSaved,true);assert.equal(local.briefMissing,false,"a brief needs its day's snapshot");
    assert.deepEqual(local.changes,[[13,"manual"],[12,"ai"],[11,"manual"]],"plan history keeps the newest entries only");
    assert.deepEqual(local.exported,{snapshots:2,planChanges:3,links:1});
    assert.equal(local.afterBriefDelete,null);assert.deepEqual(local.afterCleanup,["2030-03-05"]);
    assert.equal(local.deleted,"deleted");assert.deepEqual(local.after,{links:0,snapshots:0,changes:0});
  }finally{await pair.close();}
});
