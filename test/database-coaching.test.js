"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {createStore}=require("../src/database");

const ROOT=join(__dirname,".."),RUNTIME=join(ROOT,"test-runtime");

function fakeTursoClientFactory(){
  const database=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true});
  async function execute(statement){
    const sql=typeof statement==="string"?statement:statement.sql,args=typeof statement==="string"?[]:(statement.args||[]),prepared=database.prepare(sql),returns=/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)||/\bRETURNING\b/i.test(sql);
    if(returns){const rows=prepared.all(...args),columns=prepared.columns().map((column)=>column.name);return {columns,rows:rows.map((row)=>columns.map((column)=>row[column])),rowsAffected:Number(database.prepare("SELECT changes() AS count").get().count)};}
    const result=prepared.run(...args);return {columns:[],rows:[],rowsAffected:Number(result.changes)};
  }
  return {execute,async batch(statements){database.exec("BEGIN IMMEDIATE");try{const results=[];for(const statement of statements)results.push(await execute(statement));database.exec("COMMIT");return results;}catch(error){try{database.exec("ROLLBACK");}catch{}throw error;}},close(){database.close();}};
}

async function stores(){
  mkdirSync(RUNTIME,{recursive:true});const directory=mkdtempSync(join(RUNTIME,"coaching-parity-"));
  const previous={NODE_ENV:process.env.NODE_ENV,STRATA_DATA_DIR:process.env.STRATA_DATA_DIR,TURSO_DATABASE_URL:process.env.TURSO_DATABASE_URL,TURSO_AUTH_TOKEN:process.env.TURSO_AUTH_TOKEN};
  process.env.NODE_ENV="test";process.env.STRATA_DATA_DIR=directory;delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
  const local=await createStore(ROOT);delete process.env.STRATA_DATA_DIR;process.env.TURSO_DATABASE_URL="https://coaching-parity.invalid";process.env.TURSO_AUTH_TOKEN="test-token";
  const turso=await createStore(ROOT,{tursoClientFactory:fakeTursoClientFactory});
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  return {local,turso,async close(){await Promise.all([local.close(),turso.close()]);rmSync(directory,{recursive:true,force:true});}};
}

async function scenario(store,suffix){
  const now=1_900_000_000_000,user={id:`coach-${suffix}`,name:"Coaching Member",email:`coach-${suffix}@example.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:now,emailVerifiedAt:now};
  await store.insertUser(user);
  const profile1=await store.upsertCoachingProfile(user.id,JSON.stringify({version:1,goal:"maintenance"}),now+1,0);
  const staleProfile=await store.upsertCoachingProfile(user.id,JSON.stringify({version:1,goal:"fat_loss"}),now+2,0);
  const profile2=await store.upsertCoachingProfile(user.id,JSON.stringify({version:3,goal:"muscle_gain"}),now+3,1);
  const wrongWeek=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"wrong",profileRevision:1,snapshotJson:JSON.stringify({wrong:true}),generatedAt:now+4});
  const week=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"week-key",profileRevision:2,snapshotJson:JSON.stringify({weekStart:"2030-03-04",planKey:"week-key",profileRevision:2}),generatedAt:now+5});
  const duplicateWeek=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"week-key",profileRevision:2,snapshotJson:JSON.stringify({weekStart:"2030-03-04",planKey:"week-key",profileRevision:2,generatedAt:now+999}),generatedAt:now+999}),persistedWeek=await store.coachingWeek(user.id,"2030-03-04");
  const differentEvidence=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"different-evidence",profileRevision:2,snapshotJson:JSON.stringify({weekStart:"2030-03-04",planKey:"different-evidence",profileRevision:2}),generatedAt:now+1000});
  assert.equal(differentEvidence,null,"the first snapshot wins even when concurrent evidence changes its key");
  assert.equal((await store.coachingWeek(user.id,"2030-03-04")).plan_key,"week-key");
  const planChanged=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"plan-changed",profileRevision:2,snapshotJson:JSON.stringify({weekStart:"2030-03-04",planKey:"plan-changed",profileRevision:2,training:{planFingerprint:"0123456789abcdef"}}),generatedAt:now+1001});
  assert.equal(planChanged?.plan_key,"plan-changed","a changed weekly plan replaces the stored week for the same profile revision");
  const samePlanAgain=await store.upsertCoachingWeek({userId:user.id,weekStart:"2030-03-04",planKey:"plan-changed-evidence",profileRevision:2,snapshotJson:JSON.stringify({weekStart:"2030-03-04",planKey:"plan-changed-evidence",profileRevision:2,training:{planFingerprint:"0123456789abcdef"}}),generatedAt:now+1002});
  assert.equal(samePlanAgain,null,"the same plan with different evidence keeps the first stored week");
  const log1=await store.upsertCoachingDailyLog({userId:user.id,logDate:"2030-03-04",calories:2100,proteinG:null,carbsG:null,fatG:null,morningWeightKg:null,complete:null,updatedAt:now+6},0);
  const staleLog=await store.upsertCoachingDailyLog({userId:user.id,logDate:"2030-03-04",calories:9999,proteinG:null,carbsG:null,fatG:null,morningWeightKg:80,complete:false,updatedAt:now+7},0);
  const log2=await store.upsertCoachingDailyLog({userId:user.id,logDate:"2030-03-04",calories:2200,proteinG:160,carbsG:250,fatG:65,morningWeightKg:82.4,complete:true,updatedAt:now+8},1);
  const exportRows=await store.accountExport(user.id);
  await store.upsertAccountAction({requestId:`delete-${suffix}`,userId:user.id,purpose:"account_delete",tokenHash:`delete-token-${suffix}`,expiresAt:now+1000,deliveryState:"sent",createdAt:now+9,updatedAt:now+9});
  const deletion=await store.deleteAccount(`delete-token-${suffix}`,now+10,"email-hash");
  return {
    profile1:{revision:Number(profile1.revision),data:JSON.parse(profile1.profile_json)},staleProfile,
    profile2:{revision:Number(profile2.revision),data:JSON.parse(profile2.profile_json)},wrongWeek,
    week:{weekStart:week.week_start,planKey:week.plan_key,profileRevision:Number(week.profile_revision),duplicateWeek,persistedGeneratedAt:Number(persistedWeek.generated_at)},planChangedKey:planChanged?.plan_key,
    log1:{calories:Number(log1.calories),morningWeightKg:log1.morning_weight_kg,complete:log1.intake_complete,revision:Number(log1.revision)},staleLog,
    log2:{calories:Number(log2.calories),proteinG:Number(log2.protein_g),morningWeightKg:Number(log2.morning_weight_kg),complete:Boolean(log2.intake_complete),revision:Number(log2.revision)},
    listed:(await store.coachingDailyLogs(user.id,"2030-03-01","2030-03-10")).length,
    exported:{profile:JSON.parse(exportRows.coachingProfile.profile_json),weeks:exportRows.coachingWeeks.length,logs:exportRows.coachingLogs.length,morningWeightKg:Number(exportRows.coachingLogs[0].morning_weight_kg),complete:Boolean(exportRows.coachingLogs[0].intake_complete)},
    deleted:deletion.status,after:{profile:await store.coachingProfile(user.id),week:await store.coachingWeek(user.id,"2030-03-04"),log:await store.coachingDailyLog(user.id,"2030-03-04")}
  };
}

test("SQLite and Turso keep coaching revisions, exports, and deletion behavior identical",{concurrency:false},async()=>{
  const pair=await stores();
  try{
    const local=await scenario(pair.local,"local"),turso=await scenario(pair.turso,"turso");
    assert.deepEqual({...turso,profile1:{...turso.profile1},profile2:{...turso.profile2}},{...local,profile1:{...local.profile1},profile2:{...local.profile2}});
    assert.equal(local.profile1.revision,1);assert.equal(local.staleProfile,null);assert.equal(local.profile2.revision,2);assert.equal(local.wrongWeek,null);
    assert.deepEqual(local.week,{weekStart:"2030-03-04",planKey:"week-key",profileRevision:2,duplicateWeek:null,persistedGeneratedAt:1_900_000_000_005});assert.equal(local.staleLog,null);
    assert.deepEqual(local.log1,{calories:2100,morningWeightKg:null,complete:null,revision:1});
    assert.deepEqual(local.log2,{calories:2200,proteinG:160,morningWeightKg:82.4,complete:true,revision:2});
    assert.deepEqual(local.exported,{profile:{version:3,goal:"muscle_gain"},weeks:1,logs:1,morningWeightKg:82.4,complete:true});assert.equal(local.deleted,"deleted");assert.deepEqual(local.after,{profile:null,week:null,log:null});
  }finally{await pair.close();}
});
