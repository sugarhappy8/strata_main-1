// @ts-check
"use strict";

const COACHING_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS coaching_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS coaching_weeks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start TEXT NOT NULL,
    plan_key TEXT NOT NULL,
    profile_revision INTEGER NOT NULL CHECK(profile_revision >= 1),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    generated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,week_start)
  )`,
  `CREATE TABLE IF NOT EXISTS coaching_daily_logs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    log_date TEXT NOT NULL,
    calories INTEGER NOT NULL CHECK(calories BETWEEN 0 AND 20000),
    protein_g INTEGER CHECK(protein_g BETWEEN 0 AND 2000),
    carbs_g INTEGER CHECK(carbs_g BETWEEN 0 AND 3000),
    fat_g INTEGER CHECK(fat_g BETWEEN 0 AND 1000),
    morning_weight_kg REAL CHECK(morning_weight_kg BETWEEN 35 AND 300),
    intake_complete INTEGER CHECK(intake_complete IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL,
    CHECK((protein_g IS NULL AND carbs_g IS NULL AND fat_g IS NULL) OR
          (protein_g IS NOT NULL AND carbs_g IS NOT NULL AND fat_g IS NOT NULL)),
    PRIMARY KEY(user_id,log_date)
  )`,
]);

const COACHING_SQL = Object.freeze({
  coachingProfile: "SELECT profile_json,revision,updated_at FROM coaching_profiles WHERE user_id=?",
  upsertCoachingProfile:
    "INSERT INTO coaching_profiles(user_id,profile_json,revision,updated_at) SELECT u.id,?,1,? FROM users u WHERE u.id=? AND u.suspended_at IS NULL AND (?=0 OR EXISTS(SELECT 1 FROM coaching_profiles p WHERE p.user_id=u.id AND p.revision=?)) ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json,revision=coaching_profiles.revision+1,updated_at=MAX(coaching_profiles.updated_at+1,excluded.updated_at) WHERE coaching_profiles.revision=? RETURNING profile_json,revision,updated_at",
  coachingWeek:
    "SELECT week_start,plan_key,profile_revision,snapshot_json,generated_at FROM coaching_weeks WHERE user_id=? AND week_start=?",
  upsertCoachingWeek:
    "INSERT INTO coaching_weeks(user_id,week_start,plan_key,profile_revision,snapshot_json,generated_at) SELECT u.id,?,?,?,?,? FROM users u JOIN coaching_profiles p ON p.user_id=u.id AND p.revision=? WHERE u.id=? AND u.suspended_at IS NULL ON CONFLICT(user_id,week_start) DO UPDATE SET plan_key=excluded.plan_key,profile_revision=excluded.profile_revision,snapshot_json=excluded.snapshot_json,generated_at=excluded.generated_at WHERE coaching_weeks.profile_revision<>excluded.profile_revision OR json_extract(coaching_weeks.snapshot_json,'$.training.planFingerprint') IS NOT json_extract(excluded.snapshot_json,'$.training.planFingerprint') RETURNING week_start,plan_key,profile_revision,snapshot_json,generated_at",
  coachingDailyLog:
    "SELECT log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=? AND log_date=?",
  coachingDailyLogs:
    "SELECT log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at FROM coaching_daily_logs WHERE user_id=? AND log_date>=? AND log_date<=? ORDER BY log_date",
  upsertCoachingDailyLog:
    "INSERT INTO coaching_daily_logs(user_id,log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at) SELECT u.id,?,?,?,?,?,?,?,1,? FROM users u WHERE u.id=? AND u.suspended_at IS NULL AND (?=0 OR EXISTS(SELECT 1 FROM coaching_daily_logs l WHERE l.user_id=u.id AND l.log_date=? AND l.revision=?)) ON CONFLICT(user_id,log_date) DO UPDATE SET calories=excluded.calories,protein_g=excluded.protein_g,carbs_g=excluded.carbs_g,fat_g=excluded.fat_g,morning_weight_kg=excluded.morning_weight_kg,intake_complete=excluded.intake_complete,revision=coaching_daily_logs.revision+1,updated_at=MAX(coaching_daily_logs.updated_at+1,excluded.updated_at) WHERE coaching_daily_logs.revision=? RETURNING log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at",
  deleteCoachingLogsForDeletedUser:
    "DELETE FROM coaching_daily_logs WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteCoachingWeeksForDeletedUser:
    "DELETE FROM coaching_weeks WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteCoachingProfileForDeletedUser:
    "DELETE FROM coaching_profiles WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
});

module.exports = { COACHING_SCHEMA, COACHING_SQL };
