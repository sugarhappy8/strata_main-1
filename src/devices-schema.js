// @ts-check
"use strict";

// Connected devices and the wellness data they provide. Tokens are stored sealed (see devices-crypto.js), and
// every wellness write is joined to the member's current connection, so a slow sync can never write data for a
// Polar account that was disconnected or replaced in the meantime.

const DEVICE_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS device_connections (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('polar')),
    provider_user_id TEXT NOT NULL CHECK(length(provider_user_id) BETWEEN 1 AND 64),
    member_ref TEXT NOT NULL,
    token_sealed TEXT NOT NULL,
    token_expires_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('active','reconnect')),
    settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
    consent_version TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    synced_through TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    next_sync_at INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,provider),
    UNIQUE(provider,provider_user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS device_connections_due ON device_connections(status,next_sync_at)",
  `CREATE TABLE IF NOT EXISTS device_connect_states (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK(provider IN ('polar')),
    session_hash TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS wellness_nights (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    night_date TEXT NOT NULL,
    recovery_status INTEGER CHECK(recovery_status BETWEEN 1 AND 6),
    ans_charge REAL CHECK(ans_charge BETWEEN -10 AND 10),
    ans_charge_v4 REAL CHECK(ans_charge_v4 BETWEEN -15.7068 AND 15.7068),
    ans_charge_status INTEGER CHECK(ans_charge_status BETWEEN 1 AND 5),
    sleep_charge INTEGER CHECK(sleep_charge BETWEEN 1 AND 5),
    heart_rate_avg REAL CHECK(heart_rate_avg BETWEEN 20 AND 220),
    hrv_avg REAL CHECK(hrv_avg BETWEEN 1 AND 400),
    breathing_rate_avg REAL CHECK(breathing_rate_avg BETWEEN 4 AND 60),
    sleep_score REAL CHECK(sleep_score BETWEEN 0 AND 100),
    sleep_start TEXT,
    sleep_end TEXT,
    asleep_seconds INTEGER CHECK(asleep_seconds BETWEEN 0 AND 86400),
    light_seconds INTEGER CHECK(light_seconds BETWEEN 0 AND 86400),
    deep_seconds INTEGER CHECK(deep_seconds BETWEEN 0 AND 86400),
    rem_seconds INTEGER CHECK(rem_seconds BETWEEN 0 AND 86400),
    interruption_seconds INTEGER CHECK(interruption_seconds BETWEEN 0 AND 86400),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,provider,night_date)
  )`,
  `CREATE TABLE IF NOT EXISTS wellness_days (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    day_date TEXT NOT NULL,
    resting_hr INTEGER CHECK(resting_hr BETWEEN 20 AND 220),
    min_hr INTEGER CHECK(min_hr BETWEEN 20 AND 250),
    avg_hr INTEGER CHECK(avg_hr BETWEEN 20 AND 250),
    max_hr INTEGER CHECK(max_hr BETWEEN 20 AND 250),
    samples INTEGER NOT NULL DEFAULT 0 CHECK(samples >= 0),
    buckets_json TEXT CHECK(buckets_json IS NULL OR json_valid(buckets_json)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,provider,day_date)
  )`,
  `CREATE TABLE IF NOT EXISTS wellness_workouts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 0 AND 172800),
    sport TEXT NOT NULL,
    calories INTEGER CHECK(calories BETWEEN 0 AND 20000),
    hr_avg INTEGER CHECK(hr_avg BETWEEN 20 AND 250),
    hr_max INTEGER CHECK(hr_max BETWEEN 20 AND 250),
    cardio_load REAL CHECK(cardio_load BETWEEN 0 AND 10000),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,provider,external_id)
  )`,
  "CREATE INDEX IF NOT EXISTS wellness_workouts_started ON wellness_workouts(user_id,provider,started_at)",
  // Recreate this trigger on startup so older databases pick up the current cascade.
  "DROP TRIGGER IF EXISTS device_data_on_user_delete",
  `CREATE TRIGGER device_data_on_user_delete
    BEFORE DELETE ON users
    BEGIN
      DELETE FROM device_connections WHERE user_id=OLD.id;
      DELETE FROM device_connect_states WHERE user_id=OLD.id;
      DELETE FROM wellness_nights WHERE user_id=OLD.id;
      DELETE FROM wellness_days WHERE user_id=OLD.id;
      DELETE FROM wellness_workouts WHERE user_id=OLD.id;
    END`,
]);

const CONNECTION =
  "user_id,provider,provider_user_id,member_ref,token_sealed,token_expires_at,status,settings_json,consent_version,connected_at,synced_through,last_sync_at,last_error,next_sync_at,failures,revision,updated_at";
const NIGHT_COLUMNS =
  "night_date,recovery_status,ans_charge,ans_charge_v4,ans_charge_status,sleep_charge,heart_rate_avg,hrv_avg,breathing_rate_avg,sleep_score,sleep_start,sleep_end,asleep_seconds,light_seconds,deep_seconds,rem_seconds,interruption_seconds,updated_at";
const NIGHT =
  "night_date,recovery_status,COALESCE(ans_charge_v4,ans_charge) AS ans_charge,ans_charge_status,sleep_charge,heart_rate_avg,hrv_avg,breathing_rate_avg,sleep_score,sleep_start,sleep_end,asleep_seconds,light_seconds,deep_seconds,rem_seconds,interruption_seconds,updated_at";
const DAY = "day_date,resting_hr,min_hr,avg_hr,max_hr,samples,buckets_json,updated_at";
const WORKOUT =
  "external_id,started_at,local_date,duration_seconds,sport,calories,hr_avg,hr_max,cardio_load,updated_at";
const OWNED =
  "FROM device_connections c WHERE c.user_id=? AND c.provider=? AND c.provider_user_id=?";
/** @param {string} columns */
const keep = (columns) =>
  columns
    .split(",")
    .map((column) => `${column}=COALESCE(excluded.${column},${column})`)
    .join(",");

const DEVICE_SQL = Object.freeze({
  deviceConnection: `SELECT ${CONNECTION} FROM device_connections WHERE user_id=? AND provider=?`,
  deviceConnectionByProviderUser: `SELECT ${CONNECTION} FROM device_connections WHERE provider=? AND provider_user_id=?`,
  insertDeviceConnectState:
    "INSERT INTO device_connect_states(state_hash,user_id,provider,session_hash,redirect_uri,created_at,expires_at,used_at) SELECT ?,u.id,?,?,?,?,?,NULL FROM users u WHERE u.id=? AND u.suspended_at IS NULL RETURNING state_hash",
  readDeviceConnectState:
    "SELECT provider,expires_at,used_at FROM device_connect_states WHERE state_hash=?",
  consumeDeviceConnectState:
    "UPDATE device_connect_states SET used_at=? WHERE state_hash=? AND user_id=? AND session_hash=? AND used_at IS NULL AND expires_at>? RETURNING provider,redirect_uri",
  discardDeviceConnectState:
    "UPDATE device_connect_states SET used_at=? WHERE state_hash=? AND used_at IS NULL",
  upsertDeviceConnection: `INSERT INTO device_connections(${CONNECTION}) SELECT u.id,?,?,?,?,?,'active',?,?,?,NULL,NULL,NULL,?,0,1,? FROM users u WHERE u.id=? AND u.suspended_at IS NULL ON CONFLICT(user_id,provider) DO UPDATE SET provider_user_id=excluded.provider_user_id,member_ref=excluded.member_ref,token_sealed=excluded.token_sealed,token_expires_at=excluded.token_expires_at,status='active',consent_version=excluded.consent_version,connected_at=excluded.connected_at,synced_through=CASE WHEN device_connections.provider_user_id=excluded.provider_user_id THEN device_connections.synced_through ELSE NULL END,last_error=NULL,next_sync_at=excluded.next_sync_at,failures=0,revision=device_connections.revision+1,updated_at=excluded.updated_at RETURNING ${CONNECTION}`,
  updateDeviceToken:
    "UPDATE device_connections SET token_sealed=?,token_expires_at=?,updated_at=? WHERE user_id=? AND provider=? AND provider_user_id=? AND status='active' RETURNING user_id",
  recordDeviceSync:
    "UPDATE device_connections SET status=?,synced_through=COALESCE(?,synced_through),last_sync_at=COALESCE(?,last_sync_at),last_error=?,next_sync_at=?,failures=?,updated_at=? WHERE user_id=? AND provider=? AND provider_user_id=? RETURNING user_id",
  markDeviceConnectionDue:
    "UPDATE device_connections SET next_sync_at=MIN(next_sync_at,?),updated_at=? WHERE provider=? AND provider_user_id=? AND status='active' RETURNING user_id",
  dueDeviceConnections: `SELECT ${CONNECTION} FROM device_connections WHERE status='active' AND next_sync_at<=? ORDER BY next_sync_at,user_id LIMIT ?`,
  updateDeviceSettings: `UPDATE device_connections SET settings_json=?,revision=revision+1,updated_at=? WHERE user_id=? AND provider=? AND revision=? RETURNING ${CONNECTION}`,
  deleteDeviceConnection:
    "DELETE FROM device_connections WHERE user_id=? AND provider=? RETURNING provider_user_id,token_sealed",
  deleteWellnessNights: "DELETE FROM wellness_nights WHERE user_id=? AND provider=?",
  deleteWellnessDays: "DELETE FROM wellness_days WHERE user_id=? AND provider=?",
  deleteWellnessWorkouts: "DELETE FROM wellness_workouts WHERE user_id=? AND provider=?",
  upsertWellnessNight: `INSERT INTO wellness_nights(user_id,provider,${NIGHT_COLUMNS}) SELECT c.user_id,c.provider,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? ${OWNED} ON CONFLICT(user_id,provider,night_date) DO UPDATE SET ${keep(NIGHT_COLUMNS.replace("night_date,", "").replace(",updated_at", ""))},updated_at=excluded.updated_at`,
  upsertWellnessDay: `INSERT INTO wellness_days(user_id,provider,${DAY}) SELECT c.user_id,c.provider,?,?,?,?,?,?,?,? ${OWNED} ON CONFLICT(user_id,provider,day_date) DO UPDATE SET resting_hr=excluded.resting_hr,min_hr=excluded.min_hr,avg_hr=excluded.avg_hr,max_hr=excluded.max_hr,samples=excluded.samples,buckets_json=excluded.buckets_json,updated_at=excluded.updated_at`,
  upsertWellnessWorkout: `INSERT INTO wellness_workouts(user_id,provider,${WORKOUT}) SELECT c.user_id,c.provider,?,?,?,?,?,?,?,?,?,? ${OWNED} ON CONFLICT(user_id,provider,external_id) DO UPDATE SET started_at=excluded.started_at,local_date=excluded.local_date,duration_seconds=excluded.duration_seconds,sport=excluded.sport,calories=excluded.calories,hr_avg=excluded.hr_avg,hr_max=excluded.hr_max,cardio_load=excluded.cardio_load,updated_at=excluded.updated_at`,
  wellnessNights: `SELECT ${NIGHT} FROM wellness_nights WHERE user_id=? AND provider=? AND night_date>=? AND night_date<=? ORDER BY night_date`,
  wellnessDays: `SELECT ${DAY} FROM wellness_days WHERE user_id=? AND provider=? AND day_date>=? AND day_date<=? ORDER BY day_date`,
  wellnessWorkouts: `SELECT ${WORKOUT} FROM wellness_workouts WHERE user_id=? AND provider=? AND started_at>=? AND started_at<=? ORDER BY started_at`,
  deleteExpiredDeviceStates: "DELETE FROM device_connect_states WHERE expires_at<?",
  deleteOldWellnessNights: "DELETE FROM wellness_nights WHERE night_date<?",
  deleteOldWellnessDays: "DELETE FROM wellness_days WHERE day_date<?",
  deleteOldWellnessWorkouts: "DELETE FROM wellness_workouts WHERE started_at<?",
  trimWellnessDayBuckets:
    "UPDATE wellness_days SET buckets_json=NULL WHERE buckets_json IS NOT NULL AND day_date<?",
});

module.exports = { DEVICE_SCHEMA, DEVICE_SQL };
