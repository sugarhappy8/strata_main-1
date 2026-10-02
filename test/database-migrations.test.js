"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {MIGRATIONS,migrateLocalSchema,migrateTursoSchema}=require("../src/migrations");
const {SCHEMA,WORKOUT_ACTIVE_INDEX,RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,PRODUCT_SIGNAL_TABLE}=require("../src/schema");

function legacyDatabase() {
  const database=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true});
  for (const statement of SCHEMA) if (statement!==WORKOUT_ACTIVE_INDEX) database.exec(statement);
  database.exec("DROP TABLE coaching_daily_logs");
  database.exec(`CREATE TABLE coaching_daily_logs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK(calories BETWEEN 0 AND 20000),
    protein_g INTEGER CHECK(protein_g BETWEEN 0 AND 2000),
    carbs_g INTEGER CHECK(carbs_g BETWEEN 0 AND 3000),
    fat_g INTEGER CHECK(fat_g BETWEEN 0 AND 1000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL,
    CHECK((protein_g IS NULL AND carbs_g IS NULL AND fat_g IS NULL) OR
          (protein_g IS NOT NULL AND carbs_g IS NOT NULL AND fat_g IS NOT NULL)),
    PRIMARY KEY(user_id,log_date)
  )`);
  database.prepare("INSERT INTO users(id,name,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)").run("legacy-coach","Legacy Coach","legacy-coach@example.test","hash","salt",1000);
  database.prepare("INSERT INTO coaching_daily_logs(user_id,log_date,calories,protein_g,carbs_g,fat_g,revision,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("legacy-coach","2030-03-04",2100,null,null,null,1,1001);
  database.exec("CREATE TABLE device_revocations (id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_user_id TEXT NOT NULL,token_sealed TEXT NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0)");
  database.prepare("INSERT INTO device_revocations(id,provider,provider_user_id,token_sealed,created_at,next_attempt_at) VALUES(?,?,?,?,?,?)").run("legacy-polar","polar","123","sealed-v3-token",1000,2000);
  database.exec("CREATE TABLE discovery_trials (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,CHECK(expires_at > started_at))");
  database.prepare("INSERT INTO discovery_trials(user_id,started_at,expires_at) VALUES(?,?,?)").run("legacy-coach",1000,2000);
  database.exec("CREATE INDEX IF NOT EXISTS discovery_trials_expires_at ON discovery_trials(expires_at)");
  database.exec("CREATE TABLE admin_elevations (session_token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)");
  database.exec("CREATE TABLE community_weekly_plans (id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',plan_json TEXT NOT NULL,is_published INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  database.exec("CREATE INDEX IF NOT EXISTS community_weekly_plans_public_updated ON community_weekly_plans(is_published,updated_at DESC)");
  database.prepare("INSERT INTO community_weekly_plans(id,user_id,title,description,plan_json,is_published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run("shared-1","legacy-coach","Legacy week","",JSON.stringify({days:{}}),1,1000,1001);
  database.exec("CREATE INDEX IF NOT EXISTS admin_elevations_expiry ON admin_elevations(expires_at)");
  database.exec("DROP TABLE product_signal_counts");
  database.exec(`CREATE TABLE product_signal_counts (
    event_day TEXT NOT NULL,
    event_name TEXT NOT NULL CHECK(event_name IN ('plan_saved','trial_started','upgrade_viewed')),
    event_count INTEGER NOT NULL,
    PRIMARY KEY(event_day,event_name)
  )`);
  database.prepare("INSERT INTO product_signal_counts(event_day,event_name,event_count) VALUES(?,?,?),(?,?,?)").run("2030-03-04","trial_started",3,"2030-03-04","plan_saved",2);
  database.exec("CREATE INDEX IF NOT EXISTS support_tickets_email ON support_tickets(email)");
  return database;
}

function assertRetiredTables(database) {
  const tables=new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>name));
  assert.equal(tables.has("device_revocations"),false,"V3 revocation credentials are dropped");
  assert.equal(tables.has("admin_elevations"),false,"the unused elevation table is dropped");
  assert.equal(tables.has("discovery_trials"),false,"legacy trials no longer grant access");
  assert.equal(tables.has("community_weekly_plans"),false,"shared community plans are retired");
  assert.deepEqual(database.prepare("SELECT id,title FROM archive_community_weekly_plans").all().map((row)=>({...row})),[{id:"shared-1",title:"Legacy week"}],"shared plans are archived, not deleted");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='community_weekly_plans_public_updated'").get().count,0);
  assert.deepEqual(database.prepare("SELECT user_id,started_at,expires_at FROM archive_discovery_trials").all().map((row)=>({...row})),[{user_id:"legacy-coach",started_at:1000,expires_at:2000}],"legacy trial rows are archived, not deleted");
  assert.deepEqual(database.prepare("SELECT event_name,event_count FROM product_signal_counts ORDER BY event_name").all().map((row)=>({...row})),[{event_name:"plan_saved",event_count:2}],"the retired trial signal is dropped from the counts");
  assert.throws(()=>database.prepare("INSERT INTO product_signal_counts(event_day,event_name,event_count) VALUES(?,?,?)").run("2030-03-05","trial_started",1),/CHECK constraint failed/);
  database.prepare("INSERT INTO product_signal_counts(event_day,event_name,event_count) VALUES(?,?,?)").run("2030-03-05","workout_started",1);
  assert.deepEqual(database.prepare("PRAGMA table_info(product_signal_counts)").all().map((row)=>row.name),["event_day","event_name","event_count","member_count","anonymous_count"]);
}

test("a 9.3 database gains separate signed-in and anonymous counts, and the daily-key trigger fills them",()=>{
  const database=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true});
  try {
    for (const statement of SCHEMA) if (statement!==WORKOUT_ACTIVE_INDEX) database.exec(statement);
    database.exec("DROP TABLE product_signal_counts");
    database.exec(PRODUCT_SIGNAL_TABLE.replace(/\n\s*member_count[^\n]*\n\s*anonymous_count[^\n]*/,""));
    assert.deepEqual(database.prepare("PRAGMA table_info(product_signal_counts)").all().map((row)=>row.name),["event_day","event_name","event_count"],"the 9.3 shape");
    database.prepare("INSERT INTO product_signal_counts(event_day,event_name,event_count) VALUES(?,?,?)").run("2030-03-04","plan_saved",7);
    database.exec("CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)");
    for (const {id} of MIGRATIONS.slice(0,-1)) database.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(id,1);
    const result=migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>1234});
    assert.deepEqual(result.applied,["010-product-signal-audiences"]);
    assert.deepEqual({...database.prepare("SELECT event_count,member_count,anonymous_count FROM product_signal_counts").get()},{event_count:7,member_count:0,anonymous_count:0},"older counts stay, unattributed");
    const record=database.prepare("INSERT INTO product_signal_actors(event_day,event_name,actor_key,audience) VALUES(?,?,?,?) ON CONFLICT DO NOTHING RETURNING event_name");
    assert.equal(record.all("2030-03-04","plan_saved","a".repeat(64),"member").length,1);
    assert.equal(record.all("2030-03-04","plan_saved","a".repeat(64),"member").length,0,"the same key on the same day is not counted again");
    assert.equal(record.all("2030-03-04","plan_saved","b".repeat(64),"anonymous").length,1);
    assert.deepEqual({...database.prepare("SELECT event_count,member_count,anonymous_count FROM product_signal_counts").get()},{event_count:9,member_count:1,anonymous_count:1});
  } finally { database.close(); }
});

test("SQLite records each idempotent migration once",()=>{
  const database=legacyDatabase();
  try {
    const first=migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>1234});
    assert.deepEqual(first.applied,MIGRATIONS.map(({id})=>id));
    assert.equal(first.latest,MIGRATIONS.at(-1).id);
    assert.deepEqual(database.prepare("SELECT migration_id,applied_at FROM schema_migrations ORDER BY migration_id").all().map((row)=>({...row})),MIGRATIONS.map(({id})=>({migration_id:id,applied_at:1234})));
    const second=migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>9999});
    assert.deepEqual(second.applied,[]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,MIGRATIONS.length);
    assertRetiredTables(database);
    const indexes=new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(({name})=>name));
    assert.equal(indexes.has("discovery_trials_expires_at"),false);
    assert.equal(indexes.has("admin_elevations_expiry"),false);
    assert.equal(indexes.has("support_tickets_email"),false);
    assert.equal(indexes.has("workouts_one_active_per_user"),true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND tbl_name='coaching_daily_logs' AND sql IS NOT NULL").get().count,0,"the composite primary key already covers coaching log date lookups");
    assert.deepEqual({...database.prepare("SELECT calories,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{calories:2100,morning_weight_kg:null,intake_complete:null,revision:1,updated_at:1001});
    assert.throws(()=>database.prepare("UPDATE coaching_daily_logs SET morning_weight_kg=34.9 WHERE user_id=?").run("legacy-coach"),/CHECK constraint failed/);
    assert.throws(()=>database.prepare("UPDATE coaching_daily_logs SET morning_weight_kg=300.1 WHERE user_id=?").run("legacy-coach"),/CHECK constraint failed/);
    assert.throws(()=>database.prepare("UPDATE coaching_daily_logs SET intake_complete=2 WHERE user_id=?").run("legacy-coach"),/CHECK constraint failed/);
    database.prepare("UPDATE coaching_daily_logs SET morning_weight_kg=?,intake_complete=? WHERE user_id=?").run(300,1,"legacy-coach");
    assert.deepEqual({...database.prepare("SELECT morning_weight_kg,intake_complete FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{morning_weight_kg:300,intake_complete:1});
  } finally { database.close(); }
});

test("the documented 9.0.0 rollback restores archived rows under their 8.9.0 table names",()=>{
  const database=legacyDatabase();
  try {
    migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>1234});
    // The rollback plan in CHANGELOG_9.0.0.md: rename the archives back before redeploying 8.9.0.
    database.exec("ALTER TABLE archive_discovery_trials RENAME TO discovery_trials");
    database.exec("ALTER TABLE archive_community_weekly_plans RENAME TO community_weekly_plans");
    assert.deepEqual(database.prepare("SELECT user_id,started_at,expires_at FROM discovery_trials").all().map((row)=>({...row})),[{user_id:"legacy-coach",started_at:1000,expires_at:2000}]);
    assert.deepEqual(database.prepare("SELECT id,user_id,title,is_published FROM community_weekly_plans").all().map((row)=>({...row})),[{id:"shared-1",user_id:"legacy-coach",title:"Legacy week",is_published:1}]);
    // The renamed tables keep their constraints, so 8.9.0 writes behave as before.
    assert.throws(()=>database.prepare("INSERT INTO discovery_trials(user_id,started_at,expires_at) VALUES(?,?,?)").run("legacy-coach",3000,4000),/UNIQUE constraint failed/);
    assert.throws(()=>database.prepare("INSERT INTO discovery_trials(user_id,started_at,expires_at) VALUES(?,?,?)").run("missing-user",3000,4000),/FOREIGN KEY constraint failed/);
  } finally { database.close(); }
});

test("Turso migration runner records the same ordered ledger",async()=>{
  const database=legacyDatabase();
  async function execute(statement) {
    const sql=typeof statement==="string"?statement:statement.sql,args=typeof statement==="string"?[]:statement.args||[];
    const prepared=database.prepare(sql),returnsRows=/^\s*(?:SELECT|PRAGMA)\b/i.test(sql)||/\bRETURNING\b/i.test(sql);
    if (!returnsRows) { const result=prepared.run(...args);return {rows:[],columns:[],rowsAffected:Number(result.changes)}; }
    const rows=prepared.all(...args),columns=prepared.columns().map(({name})=>name);
    return {rows:rows.map((row)=>columns.map((name)=>row[name])),columns};
  }
  const client={execute,async batch(statements){database.exec("BEGIN IMMEDIATE");try{const results=[];for(const statement of statements)results.push(await execute(statement));database.exec("COMMIT");return results;}catch(error){database.exec("ROLLBACK");throw error;}}};
  try {
    const first=await migrateTursoSchema(client,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>5678});
    assert.deepEqual(first.applied,MIGRATIONS.map(({id})=>id));
    const stored=database.prepare("SELECT migration_id,applied_at FROM schema_migrations ORDER BY migration_id").all().map((row)=>({...row}));
    assert.deepEqual(stored,MIGRATIONS.map(({id})=>({migration_id:id,applied_at:5678})));
    assertRetiredTables(database);
    assert.deepEqual({...database.prepare("SELECT calories,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{calories:2100,morning_weight_kg:null,intake_complete:null,revision:1,updated_at:1001});
    database.prepare("UPDATE coaching_daily_logs SET morning_weight_kg=?,intake_complete=? WHERE user_id=?").run(35,0,"legacy-coach");
    assert.deepEqual({...database.prepare("SELECT morning_weight_kg,intake_complete FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{morning_weight_kg:35,intake_complete:0});
    const second=await migrateTursoSchema(client,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,productSignalTable:PRODUCT_SIGNAL_TABLE,now:()=>9999});
    assert.deepEqual(second.applied,[]);
  } finally { database.close(); }
});
