"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DatabaseSync}=require("node:sqlite");
const {MIGRATIONS,migrateLocalSchema,migrateTursoSchema}=require("../src/migrations");
const {SCHEMA,WORKOUT_ACTIVE_INDEX,RECONCILE_DUPLICATE_ACTIVE_WORKOUTS}=require("../src/schema");

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
  database.prepare("INSERT INTO device_revocations(id,provider,provider_user_id,token_sealed,created_at,next_attempt_at) VALUES(?,?,?,?,?,?)").run("legacy-polar","polar","123","sealed-v3-token",1000,2000);
  database.exec("CREATE INDEX IF NOT EXISTS discovery_trials_expires_at ON discovery_trials(expires_at)");
  database.exec("CREATE INDEX IF NOT EXISTS support_tickets_email ON support_tickets(email)");
  return database;
}

test("SQLite records each idempotent migration once",()=>{
  const database=legacyDatabase();
  try {
    const first=migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,now:()=>1234});
    assert.deepEqual(first.applied,MIGRATIONS.map(({id})=>id));
    assert.equal(first.latest,MIGRATIONS.at(-1).id);
    assert.deepEqual(database.prepare("SELECT migration_id,applied_at FROM schema_migrations ORDER BY migration_id").all().map((row)=>({...row})),MIGRATIONS.map(({id})=>({migration_id:id,applied_at:1234})));
    const second=migrateLocalSchema(database,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,now:()=>9999});
    assert.deepEqual(second.applied,[]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count,MIGRATIONS.length);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_revocations").get().count,0);
    const indexes=new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(({name})=>name));
    assert.equal(indexes.has("discovery_trials_expires_at"),false);
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
    const first=await migrateTursoSchema(client,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,now:()=>5678});
    assert.deepEqual(first.applied,MIGRATIONS.map(({id})=>id));
    const stored=database.prepare("SELECT migration_id,applied_at FROM schema_migrations ORDER BY migration_id").all().map((row)=>({...row}));
    assert.deepEqual(stored,MIGRATIONS.map(({id})=>({migration_id:id,applied_at:5678})));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_revocations").get().count,0);
    assert.deepEqual({...database.prepare("SELECT calories,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{calories:2100,morning_weight_kg:null,intake_complete:null,revision:1,updated_at:1001});
    database.prepare("UPDATE coaching_daily_logs SET morning_weight_kg=?,intake_complete=? WHERE user_id=?").run(35,0,"legacy-coach");
    assert.deepEqual({...database.prepare("SELECT morning_weight_kg,intake_complete FROM coaching_daily_logs WHERE user_id=?").get("legacy-coach")},{morning_weight_kg:35,intake_complete:0});
    const second=await migrateTursoSchema(client,{activeWorkoutIndex:WORKOUT_ACTIVE_INDEX,reconcileActiveWorkouts:RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,now:()=>9999});
    assert.deepEqual(second.applied,[]);
  } finally { database.close(); }
});
