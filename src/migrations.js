"use strict";

const {BILLING_SUBSCRIPTION_TABLE}=require("./billing-schema");

const MIGRATION_LEDGER_SCHEMA=`CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

const MIGRATIONS=Object.freeze([
  {id:"001-account-security-columns",description:"Add verified-account, authorization-version, suspension, and verification-purpose fields."},
  {id:"002-reviewed-index-set",description:"Remove unused legacy indexes and preserve the verification lookup index."},
  {id:"003-one-active-workout",description:"Reconcile duplicate active workouts before enforcing the partial unique index."},
  {id:"004-monthly-subscriptions",description:"Add the lean Paddle subscription cache while preserving legacy lifetime purchases."},
  {id:"005-coaching-calibration",description:"Add optional morning-weight and intake-completeness observations to coaching logs."},
  {id:"006-polar-v4-ans-status",description:"Store Polar V4 ANS status across its documented range."},
  {id:"007-polar-v4-revocations",description:"Drop the queued V3 deregistration credentials that V4 cannot use."},
  {id:"008-build9-retired-tables",description:"Archive legacy trials, drop admin elevations, and retire the trial product signal."}
]);
const LATEST_MIGRATION_ID=MIGRATIONS.at(-1).id;

// Build 9 keeps the trial rows under an archive name so the cut stays reversible for one release.
const RETIRED_TABLE_STATEMENTS=Object.freeze([
  "DROP INDEX IF EXISTS admin_elevations_expiry",
  "DROP TABLE IF EXISTS admin_elevations",
  "DROP TABLE IF EXISTS product_signal_counts_build9"
]);
/** Rebuild the aggregate counts table under the current CHECK list, dropping the retired trial signal. @param {string} table */
const productSignalRebuild=(table)=>[
  table.replace("CREATE TABLE IF NOT EXISTS product_signal_counts","CREATE TABLE product_signal_counts_build9"),
  "INSERT INTO product_signal_counts_build9(event_day,event_name,event_count) SELECT event_day,event_name,event_count FROM product_signal_counts WHERE event_name<>'trial_started'",
  "DROP TABLE product_signal_counts",
  "ALTER TABLE product_signal_counts_build9 RENAME TO product_signal_counts"
];
function localColumnNames(database,table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row)=>String(row.name)));
}

function addLocalColumn(database,table,column,declaration) {
  if (localColumnNames(database,table).has(column)) return;
  try { database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`); }
  catch(error) {
    if (!localColumnNames(database,table).has(column)) throw error;
  }
}

function runLocalMigration(database,id,operation,appliedAt) {
  let transactionOpen=false;
  try {
    database.exec("BEGIN IMMEDIATE");transactionOpen=true;
    if (database.prepare("SELECT 1 FROM schema_migrations WHERE migration_id=?").get(id)) {
      database.exec("COMMIT");transactionOpen=false;return false;
    }
    operation();
    database.prepare("INSERT INTO schema_migrations(migration_id,applied_at) VALUES(?,?)").run(id,appliedAt);
    database.exec("COMMIT");transactionOpen=false;return true;
  } catch(error) {
    if (transactionOpen) try { database.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
    throw error;
  }
}

function migrateLocalSchema(database,{activeWorkoutIndex,reconcileActiveWorkouts,productSignalTable,now=Date.now}={}) {
  if (!activeWorkoutIndex||!reconcileActiveWorkouts||!productSignalTable) throw new TypeError("Local migrations require the reviewed workout reconciliation and index statements.");
  database.exec(MIGRATION_LEDGER_SCHEMA);
  const applied=[];
  if (runLocalMigration(database,MIGRATIONS[0].id,()=>{
    addLocalColumn(database,"users","email_verified_at","INTEGER");
    addLocalColumn(database,"users","auth_version","INTEGER NOT NULL DEFAULT 1");
    addLocalColumn(database,"users","suspended_at","INTEGER");
    addLocalColumn(database,"sessions","auth_version","INTEGER NOT NULL DEFAULT 1");
    addLocalColumn(database,"signup_verifications","purpose","TEXT NOT NULL DEFAULT 'signup'");
  },now())) applied.push(MIGRATIONS[0].id);
  if (runLocalMigration(database,MIGRATIONS[1].id,()=>{
    database.exec("DROP INDEX IF EXISTS signup_verifications_user_id");
    database.exec("CREATE INDEX IF NOT EXISTS signup_verifications_user_id_idx ON signup_verifications(user_id)");
    database.exec("DROP INDEX IF EXISTS paddle_purchases_customer_id");
    database.exec("DROP INDEX IF EXISTS discovery_trials_expires_at");
    database.exec("DROP INDEX IF EXISTS support_tickets_email");
  },now())) applied.push(MIGRATIONS[1].id);
  if (runLocalMigration(database,MIGRATIONS[2].id,()=>{
    database.exec(reconcileActiveWorkouts);database.exec(activeWorkoutIndex);
  },now())) applied.push(MIGRATIONS[2].id);
  if (runLocalMigration(database,MIGRATIONS[3].id,()=>{
    addLocalColumn(database,"paddle_purchases","subscription_id","TEXT");
    database.exec(BILLING_SUBSCRIPTION_TABLE);
    database.exec("CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id ON paddle_subscriptions(user_id)");
  },now())) applied.push(MIGRATIONS[3].id);
  if (runLocalMigration(database,MIGRATIONS[4].id,()=>{
    addLocalColumn(database,"coaching_daily_logs","morning_weight_kg","REAL CHECK(morning_weight_kg BETWEEN 35 AND 300)");
    addLocalColumn(database,"coaching_daily_logs","intake_complete","INTEGER CHECK(intake_complete IN (0,1))");
  },now())) applied.push(MIGRATIONS[4].id);
  if (runLocalMigration(database,MIGRATIONS[5].id,()=>{
    addLocalColumn(database,"wellness_nights","ans_charge_v4","REAL CHECK(ans_charge_v4 BETWEEN -15.7068 AND 15.7068)");
  },now())) applied.push(MIGRATIONS[5].id);
  if (runLocalMigration(database,MIGRATIONS[6].id,()=>database.exec("DROP TABLE IF EXISTS device_revocations"),now())) applied.push(MIGRATIONS[6].id);
  if (runLocalMigration(database,MIGRATIONS[7].id,()=>{
    for (const sql of RETIRED_TABLE_STATEMENTS) database.exec(sql);
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_trials'").get()) database.exec("ALTER TABLE discovery_trials RENAME TO archive_discovery_trials");
    for (const sql of productSignalRebuild(productSignalTable)) database.exec(sql);
  },now())) applied.push(MIGRATIONS[7].id);
  return {latest:LATEST_MIGRATION_ID,applied};
}

async function tursoColumnNames(client,table) {
  const result=await client.execute(`PRAGMA table_info(${table})`);
  return new Set((result.rows||[]).map((row)=>String(row.name??row[1])));
}

async function addTursoColumn(client,table,column,declaration) {
  if ((await tursoColumnNames(client,table)).has(column)) return;
  try { await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`); }
  catch(error) {
    if (!(await tursoColumnNames(client,table)).has(column)) throw error;
  }
}

async function tursoMigrationIds(client) {
  const result=await client.execute("SELECT migration_id FROM schema_migrations ORDER BY migration_id");
  return new Set((result.rows||[]).map((row)=>String(row.migration_id??row[0])));
}

async function recordTursoMigration(client,id,appliedAt) {
  await client.execute({sql:"INSERT OR IGNORE INTO schema_migrations(migration_id,applied_at) VALUES(?,?)",args:[id,appliedAt]});
}

async function migrateTursoSchema(client,{activeWorkoutIndex,reconcileActiveWorkouts,productSignalTable,now=Date.now}={}) {
  if (!activeWorkoutIndex||!reconcileActiveWorkouts||!productSignalTable) throw new TypeError("Turso migrations require the reviewed workout reconciliation and index statements.");
  await client.execute(MIGRATION_LEDGER_SCHEMA);
  const completed=await tursoMigrationIds(client),applied=[];
  if (!completed.has(MIGRATIONS[0].id)) {
    await addTursoColumn(client,"users","email_verified_at","INTEGER");
    await addTursoColumn(client,"users","auth_version","INTEGER NOT NULL DEFAULT 1");
    await addTursoColumn(client,"users","suspended_at","INTEGER");
    await addTursoColumn(client,"sessions","auth_version","INTEGER NOT NULL DEFAULT 1");
    await addTursoColumn(client,"signup_verifications","purpose","TEXT NOT NULL DEFAULT 'signup'");
    await recordTursoMigration(client,MIGRATIONS[0].id,now());applied.push(MIGRATIONS[0].id);
  }
  if (!completed.has(MIGRATIONS[1].id)) {
    await client.execute("DROP INDEX IF EXISTS signup_verifications_user_id");
    await client.execute("CREATE INDEX IF NOT EXISTS signup_verifications_user_id_idx ON signup_verifications(user_id)");
    await client.execute("DROP INDEX IF EXISTS paddle_purchases_customer_id");
    await client.execute("DROP INDEX IF EXISTS discovery_trials_expires_at");
    await client.execute("DROP INDEX IF EXISTS support_tickets_email");
    await recordTursoMigration(client,MIGRATIONS[1].id,now());applied.push(MIGRATIONS[1].id);
  }
  if (!completed.has(MIGRATIONS[2].id)) {
    await client.batch([reconcileActiveWorkouts,activeWorkoutIndex,{sql:"INSERT OR IGNORE INTO schema_migrations(migration_id,applied_at) VALUES(?,?)",args:[MIGRATIONS[2].id,now()]}],"write");
    applied.push(MIGRATIONS[2].id);
  }
  if (!completed.has(MIGRATIONS[3].id)) {
    await addTursoColumn(client,"paddle_purchases","subscription_id","TEXT");
    await client.batch([
      BILLING_SUBSCRIPTION_TABLE,
      "CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id ON paddle_subscriptions(user_id)",
      {sql:"INSERT OR IGNORE INTO schema_migrations(migration_id,applied_at) VALUES(?,?)",args:[MIGRATIONS[3].id,now()]}
    ],"write");
    applied.push(MIGRATIONS[3].id);
  }
  if (!completed.has(MIGRATIONS[4].id)) {
    await addTursoColumn(client,"coaching_daily_logs","morning_weight_kg","REAL CHECK(morning_weight_kg BETWEEN 35 AND 300)");
    await addTursoColumn(client,"coaching_daily_logs","intake_complete","INTEGER CHECK(intake_complete IN (0,1))");
    await recordTursoMigration(client,MIGRATIONS[4].id,now());applied.push(MIGRATIONS[4].id);
  }
  if (!completed.has(MIGRATIONS[5].id)) {
    await addTursoColumn(client,"wellness_nights","ans_charge_v4","REAL CHECK(ans_charge_v4 BETWEEN -15.7068 AND 15.7068)");
    await recordTursoMigration(client,MIGRATIONS[5].id,now());applied.push(MIGRATIONS[5].id);
  }
  if (!completed.has(MIGRATIONS[6].id)) {
    await client.execute("DROP TABLE IF EXISTS device_revocations");
    await recordTursoMigration(client,MIGRATIONS[6].id,now());applied.push(MIGRATIONS[6].id);
  }
  if (!completed.has(MIGRATIONS[7].id)) {
    for (const sql of RETIRED_TABLE_STATEMENTS) await client.execute(sql);
    const trials=await client.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_trials'");
    await client.batch([
      ...((trials.rows||[]).length?["ALTER TABLE discovery_trials RENAME TO archive_discovery_trials"]:[]),
      ...productSignalRebuild(productSignalTable),
      {sql:"INSERT OR IGNORE INTO schema_migrations(migration_id,applied_at) VALUES(?,?)",args:[MIGRATIONS[7].id,now()]}
    ],"write");
    applied.push(MIGRATIONS[7].id);
  }
  return {latest:LATEST_MIGRATION_ID,applied};
}

module.exports={LATEST_MIGRATION_ID,MIGRATIONS,MIGRATION_LEDGER_SCHEMA,migrateLocalSchema,migrateTursoSchema};
