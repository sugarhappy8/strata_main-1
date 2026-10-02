"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path"),{tmpdir}=require("node:os");
const {DatabaseSync}=require("node:sqlite");
const {createStore}=require("../src/database");
const {SCHEMA,SQL,WORKOUT_ACTIVE_INDEX}=require("../src/schema");
const {sanitizeWorkout,summarizeWorkout}=require("../src/workouts");
const {workoutFixture,fakeTursoFactory}=require("./support/workout-fixtures");

async function fixture(t,kind) {
  const directory=mkdtempSync(join(tmpdir(),"strata-workout-"));let database;
  const names=["NODE_ENV","STRATA_DATA_DIR","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"],old=names.map((key)=>process.env[key]);
  let store;
  try {
    Object.assign(process.env,{NODE_ENV:"test",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:kind==="turso"?"https://workout.invalid":"",TURSO_AUTH_TOKEN:kind==="turso"?"test-token":""});
    store=await createStore(join(__dirname,".."),{tursoClientFactory:fakeTursoFactory((db)=>{database=db;})});
  } finally {names.forEach((key,i)=>{if (old[i]===undefined) delete process.env[key];else process.env[key]=old[i];});}
  t.after(async()=>{await store.close();rmSync(directory,{recursive:true,force:true});});
  for (const id of ["owner","other"]) await store.insertUser({id,name:id,email:`${id}@example.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:1,emailVerifiedAt:1});
  return {store,database,file:join(directory,"strata.sqlite")};
}
function record(userId,id="shared-workout",startedAt=1767600000000,status="active") {
  const workout=workoutFixture(id);workout.startedAt=startedAt;
  if (status==="completed") {
    workout.status="completed";workout.completedAt=startedAt+1000;workout.entries[0].sets[0].completed=true;
  }
  const clean=sanitizeWorkout(workout);
  return {userId,id,workoutJson:JSON.stringify(clean),summaryJson:JSON.stringify(summarizeWorkout(clean)),createHash:"immutable-create-hash",startedAt,updatedAt:1000};
}
function retitled(recordValue,title) {
  const workout=JSON.parse(recordValue.workoutJson);workout.title=title;
  return {...recordValue,workoutJson:JSON.stringify(workout),summaryJson:JSON.stringify(summarizeWorkout(workout))};
}

for (const kind of ["local","turso"]) {
  test(`${kind} workouts use atomic CAS, isolated IDs, bounded summary reads, and deletion`,{concurrency:false},async(t)=>{
    const {store}=await fixture(t,kind),initial=record("owner","shared-workout",1767600000000,"completed");
    const created=await store.insertWorkout(initial);
    assert.equal(created.revision,1);assert.equal(created.updated_at,1000);
    assert.equal(await store.insertWorkout({...initial,workoutJson:"{\"overwritten\":true}"}),null);
    assert.equal((await store.workout("owner",initial.id)).workout_json,initial.workoutJson);
    assert.equal(await store.workout("other",initial.id),null);
    assert.equal(await store.deleteWorkout("other",initial.id,1),false);
    assert.equal(await store.updateWorkout({...initial,userId:"other"},1),null);
    assert.equal((await store.insertWorkout(record("other","shared-workout",1767600000000,"completed"))).revision,1,"each account owns a distinct ID namespace");
    const outcomes=await Promise.all(Array.from({length:20},(_,i)=>store.updateWorkout(retitled(initial,`Winner ${i}`),1)));
    assert.equal(outcomes.filter(Boolean).length,1,"exactly one concurrent writer wins");
    const saved=await store.workout("owner",initial.id);
    assert.equal(saved.revision,2);assert.equal(saved.updated_at,1001);assert.equal(saved.create_hash,initial.createHash);
    assert.equal(await store.updateWorkout(initial,1),null);assert.equal(await store.deleteWorkout("owner",initial.id,1),false);
    await store.insertWorkout(record("owner","newer",initial.startedAt+1,"completed"));
    const summaries=await store.workouts("owner",1,0);
    assert.equal(summaries.length,1);assert.equal(JSON.parse(summaries[0].summary_json).id,"newer");
    assert.equal("workout_json" in summaries[0],false,"history must not transfer complete session JSON");
    assert.equal("create_hash" in summaries[0],false);
    assert.equal(JSON.parse((await store.workouts("owner",1,1))[0].summary_json).id,initial.id);
    assert.equal(await store.workoutCount("owner"),2);
    assert.equal(await store.deleteWorkout("owner",initial.id,2),true);
    assert.equal(await store.workout("owner",initial.id),null);assert.ok(await store.workout("other",initial.id));
  });
  test(`${kind} atomically keeps one indexed active workout per account`,{concurrency:false},async(t)=>{
    const {store,database,file}=await fixture(t,kind);
    const first=record("owner","active-one"),second=record("owner","active-two",1767600000001);
    const outcomes=await Promise.all([store.insertWorkout(first),store.insertWorkout(second)]);
    assert.equal(outcomes.filter(Boolean).length,1,"the storage boundary must reject a competing active session");
    const winner=outcomes.find(Boolean),winnerWorkout=JSON.parse(winner.workout_json);
    assert.deepEqual(JSON.parse((await store.activeWorkout("owner")).workout_json),winnerWorkout);
    assert.equal(await store.insertWorkout(record("other","other-active"))!==null,true,"another account has an independent active slot");

    const completed={...winnerWorkout,status:"completed",completedAt:winnerWorkout.startedAt+1000,restEndsAt:null};
    completed.entries[0].sets[0].completed=true;
    const completedRecord={...(winnerWorkout.id===first.id?first:second),workoutJson:JSON.stringify(completed),summaryJson:JSON.stringify(summarizeWorkout(completed))};
    assert.ok(await store.updateWorkout(completedRecord,1),"completing the winner releases the active slot atomically");
    assert.equal(await store.activeWorkout("owner"),null);
    const loser=winnerWorkout.id===first.id?second:first;
    assert.ok(await store.insertWorkout(loser));

    const archived=record("owner","archived",1767600000002,"completed");
    assert.ok(await store.insertWorkout(archived));
    const reactivated=JSON.parse(archived.workoutJson);
    reactivated.status="active";reactivated.completedAt=null;reactivated.restEndsAt=null;
    assert.equal(await store.updateWorkout({...archived,workoutJson:JSON.stringify(reactivated),summaryJson:JSON.stringify(summarizeWorkout(reactivated))},1),null,"CAS cannot bypass the active-session constraint");

    const check=database||new DatabaseSync(file,{readOnly:true});
    try {
      const plan=check.prepare(`EXPLAIN QUERY PLAN ${SQL.activeWorkout}`).all("owner").map((row)=>row.detail).join(" ");
      assert.match(plan,/workouts_one_active_per_user/);
    } finally {if (!database) check.close();}
  });
  test(`${kind} account deletion removes private workouts${kind==="turso"?" even if foreign keys are unavailable":" through its cascade"}`,{concurrency:false},async(t)=>{
    const {store,database,file}=await fixture(t,kind);
    await store.insertWorkout(record("owner"));await store.insertWorkout(record("other"));
    const now=Date.now();
    await store.upsertAccountAction({requestId:"delete-workout-owner",userId:"owner",purpose:"account_delete",tokenHash:"delete-owner-token",expiresAt:now+60000,deliveryState:"sent",createdAt:now,updatedAt:now});
    if (database) database.exec("PRAGMA foreign_keys=OFF");
    const result=await store.deleteAccount("delete-owner-token",now+1,"owner-hash");
    assert.equal(result.status,"deleted");assert.equal(await store.workoutCount("owner"),0);assert.equal(await store.workoutCount("other"),1);
    const db=database||new DatabaseSync(file);
    try {
      const queryPlan=db.prepare(`EXPLAIN QUERY PLAN ${SQL.workouts}`).all("other",21,0).map((row)=>row.detail).join(" ");
      assert.match(queryPlan,/workouts_user_started/);assert.doesNotMatch(queryPlan,/TEMP\s*B-TREE/);
    } finally {if (!database) db.close();}
  });
}

test("workout migration is additive and a reopened store preserves existing user and plan data",{concurrency:false},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"strata-workout-migration-")),file=join(directory,"strata.sqlite"),db=new DatabaseSync(file,{enableForeignKeyConstraints:true});
  for (const sql of SCHEMA) if (sql!==WORKOUT_ACTIVE_INDEX) db.exec(sql);
  db.prepare("INSERT INTO users (id,name,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)").run("legacy","Legacy","legacy@example.test","hash","salt",42);
  db.prepare("INSERT INTO plans (user_id,plan_json,updated_at) VALUES (?,?,?)").run("legacy","{\"legacy\":true}",123);
  const older=record("legacy","legacy-active-older",1767600000000),newer={...record("legacy","legacy-active-newer",1767600000001),updatedAt:2000};
  const insert=db.prepare("INSERT INTO workouts (user_id,id,workout_json,summary_json,create_hash,started_at,revision,updated_at) VALUES (?,?,?,?,?,?,1,?)");
  for (const value of [older,newer]) insert.run(value.userId,value.id,value.workoutJson,value.summaryJson,value.createHash,value.startedAt,value.updatedAt);
  const before=db.prepare("SELECT * FROM users").get();db.close();
  const previous={NODE_ENV:process.env.NODE_ENV,STRATA_DATA_DIR:process.env.STRATA_DATA_DIR,TURSO_DATABASE_URL:process.env.TURSO_DATABASE_URL};
  let store;
  try {
    Object.assign(process.env,{NODE_ENV:"test",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:""});store=await createStore(join(__dirname,".."));
    assert.deepEqual(await store.plan("legacy"),{plan_json:'{"legacy":true}',updated_at:123});
    assert.equal(JSON.parse((await store.activeWorkout("legacy")).workout_json).id,newer.id,"the newest duplicate remains resumable");
    const archived=await store.workout("legacy",older.id),archivedWorkout=JSON.parse(archived.workout_json);
    assert.equal(archivedWorkout.status,"completed");assert.equal(archivedWorkout.completedAt,older.startedAt);
    assert.deepEqual(archivedWorkout.entries,JSON.parse(older.workoutJson).entries,"migration must retain the recorded exercise data");
    assert.equal(archived.revision,2);assert.equal(await store.workoutCount("legacy"),2,"migration must not delete workout history");
    assert.equal(await store.insertWorkout(record("legacy","blocked-after-migration")),null);
    await store.close();store=await createStore(join(__dirname,".."));
    assert.equal(JSON.parse((await store.activeWorkout("legacy")).workout_json).id,newer.id);
    const migrated=new DatabaseSync(file);
    assert.deepEqual(migrated.prepare("SELECT * FROM users").get(),before);
    assert.ok(migrated.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='workouts_one_active_per_user'").get());
    migrated.close();
  } finally {
    await store?.close();for (const [key,value] of Object.entries(previous)) {if (value===undefined) delete process.env[key];else process.env[key]=value;}
    rmSync(directory,{recursive:true,force:true});
  }
});

test("the mocked Turso migration archives duplicate active rows without deleting their history",{concurrency:false},async()=>{
  const names=["NODE_ENV","STRATA_DATA_DIR","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"],old=names.map((key)=>process.env[key]);
  const older=record("legacy-turso","legacy-turso-older",1767600000000),newer={...record("legacy-turso","legacy-turso-newer",1767600000001),updatedAt:2000};
  let store,database;
  try {
    Object.assign(process.env,{NODE_ENV:"test",TURSO_DATABASE_URL:"https://legacy-workout.invalid",TURSO_AUTH_TOKEN:"test-token"});delete process.env.STRATA_DATA_DIR;
    store=await createStore(join(__dirname,".."),{tursoClientFactory:fakeTursoFactory((db)=>{
      database=db;for (const sql of SCHEMA) if (sql!==WORKOUT_ACTIVE_INDEX) db.exec(sql);
      db.prepare("INSERT INTO users (id,name,email,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)").run("legacy-turso","Legacy Turso","legacy-turso@example.test","hash","salt",42);
      const insert=db.prepare("INSERT INTO workouts (user_id,id,workout_json,summary_json,create_hash,started_at,revision,updated_at) VALUES (?,?,?,?,?,?,1,?)");
      for (const value of [older,newer]) insert.run(value.userId,value.id,value.workoutJson,value.summaryJson,value.createHash,value.startedAt,value.updatedAt);
    })});
    assert.equal(JSON.parse((await store.activeWorkout("legacy-turso")).workout_json).id,newer.id);
    assert.equal(JSON.parse((await store.workout("legacy-turso",older.id)).workout_json).status,"completed");
    assert.equal(await store.workoutCount("legacy-turso"),2);
    assert.ok(database.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='workouts_one_active_per_user'").get());
  } finally {
    await store?.close();names.forEach((key,i)=>{if (old[i]===undefined) delete process.env[key];else process.env[key]=old[i];});
  }
});

test("independent SQLite store connections share the database active-workout guard",{concurrency:false},async()=>{
  const directory=mkdtempSync(join(tmpdir(),"strata-workout-connections-"));
  const names=["NODE_ENV","STRATA_DATA_DIR","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"],old=names.map((key)=>process.env[key]);
  let firstStore,secondStore;
  try {
    Object.assign(process.env,{NODE_ENV:"test",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:""});
    firstStore=await createStore(join(__dirname,".."));secondStore=await createStore(join(__dirname,".."));
    await firstStore.insertUser({id:"two-connections",name:"Two Connections",email:"two-connections@example.test",passwordHash:"hash",passwordSalt:"salt",createdAt:1,emailVerifiedAt:1});
    const outcomes=await Promise.all([
      firstStore.insertWorkout(record("two-connections","connection-one")),
      secondStore.insertWorkout(record("two-connections","connection-two",1767600000001))
    ]);
    assert.equal(outcomes.filter(Boolean).length,1);
    const firstActive=await firstStore.activeWorkout("two-connections"),secondActive=await secondStore.activeWorkout("two-connections");
    assert.deepEqual(firstActive,secondActive,"every server connection must see the same resumable workout");
  } finally {
    await Promise.all([firstStore?.close(),secondStore?.close()]);
    names.forEach((key,i)=>{if (old[i]===undefined) delete process.env[key];else process.env[key]=old[i];});
    rmSync(directory,{recursive:true,force:true});
  }
});

test("workout storage cap is atomic and does not block CAS updates or other owners",{concurrency:false},async(t)=>{
  const {store,database}=await fixture(t,"turso"),initial=record("owner");await store.insertWorkout(initial);
  database.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9999) INSERT INTO workouts (user_id,id,workout_json,summary_json,create_hash,started_at,revision,updated_at) SELECT 'owner','bulk-'||i,'{}','{}','hash',1,1,1 FROM n").run();
  assert.equal(await store.workoutCount("owner"),10000);
  assert.equal(await store.insertWorkout(record("owner","overflow",1767600000001,"completed")),null);
  assert.equal((await store.updateWorkout(initial,1)).revision,2);
  assert.ok(await store.insertWorkout(record("other","other-workout")));
});
