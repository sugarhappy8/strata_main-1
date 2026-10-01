// @ts-check
"use strict";

// Tables owned by the shared data layer. Polar sessions stay in wellness_workouts; a link records
// which STRATA workout a Polar session belongs to, so the Training Log shows one entry, not two.
const DATA_LAYER_SCHEMA=Object.freeze([
  `CREATE TABLE IF NOT EXISTS training_links (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    workout_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK(method IN ('time_overlap','same_day')),
    linked_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,provider,external_id)
  )`,
  "CREATE INDEX IF NOT EXISTS training_links_workout ON training_links(user_id,workout_id)",
  `CREATE TABLE IF NOT EXISTS daily_snapshots (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    snapshot_date TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    brief_json TEXT CHECK(brief_json IS NULL OR json_valid(brief_json)),
    brief_generated_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,snapshot_date)
  )`,
  "CREATE INDEX IF NOT EXISTS daily_snapshots_date ON daily_snapshots(snapshot_date)",
  // Where each saved week came from: the member's own edit, an accepted Strata AI proposal, or setup.
  `CREATE TABLE IF NOT EXISTS plan_changes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_updated_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual','ai','system')),
    detail TEXT NOT NULL CHECK(length(detail) BETWEEN 1 AND 40),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,plan_updated_at)
  )`
]);

const OWNED="FROM users WHERE id=? AND suspended_at IS NULL";
const DATA_LAYER_SQL=Object.freeze({
  trainingLinks:"SELECT provider,external_id,workout_id,method,linked_at FROM training_links WHERE user_id=? ORDER BY linked_at",
  upsertTrainingLink:`INSERT INTO training_links(user_id,provider,external_id,workout_id,method,linked_at) SELECT id,?,?,?,?,? ${OWNED} ON CONFLICT(user_id,provider,external_id) DO UPDATE SET workout_id=excluded.workout_id,method=excluded.method,linked_at=excluded.linked_at`,
  deleteTrainingLink:"DELETE FROM training_links WHERE user_id=? AND provider=? AND external_id=?",
  dailySnapshots:"SELECT snapshot_date,snapshot_json,brief_json,brief_generated_at,updated_at FROM daily_snapshots WHERE user_id=? AND snapshot_date>=? AND snapshot_date<=? ORDER BY snapshot_date",
  upsertDailySnapshot:`INSERT INTO daily_snapshots(user_id,snapshot_date,snapshot_json,brief_json,brief_generated_at,updated_at) SELECT id,?,?,NULL,NULL,? ${OWNED} ON CONFLICT(user_id,snapshot_date) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`,
  saveDailyBrief:"UPDATE daily_snapshots SET brief_json=?,brief_generated_at=?,updated_at=? WHERE user_id=? AND snapshot_date=?",
  deleteDailyBriefs:"UPDATE daily_snapshots SET brief_json=NULL,brief_generated_at=NULL,updated_at=? WHERE user_id=? AND brief_json IS NOT NULL",
  deleteOldDailySnapshots:"DELETE FROM daily_snapshots WHERE snapshot_date<?",
  deleteUserDailySnapshots:"DELETE FROM daily_snapshots WHERE user_id=?",
  insertPlanChange:`INSERT INTO plan_changes(user_id,plan_updated_at,source,detail,created_at) SELECT id,?,?,?,? ${OWNED} ON CONFLICT(user_id,plan_updated_at) DO UPDATE SET source=excluded.source,detail=excluded.detail,created_at=excluded.created_at`,
  planChanges:"SELECT plan_updated_at,source,detail,created_at FROM plan_changes WHERE user_id=? ORDER BY plan_updated_at DESC LIMIT ?",
  prunePlanChanges:"DELETE FROM plan_changes WHERE user_id=? AND plan_updated_at NOT IN (SELECT plan_updated_at FROM plan_changes WHERE user_id=? ORDER BY plan_updated_at DESC LIMIT ?)",
  deletePlanChangesForDeletedUser:"DELETE FROM plan_changes WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteTrainingLinksForDeletedUser:"DELETE FROM training_links WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteDailySnapshotsForDeletedUser:"DELETE FROM daily_snapshots WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteTrainingLinksForProvider:"DELETE FROM training_links WHERE user_id=? AND provider=?"
});

module.exports={DATA_LAYER_SCHEMA,DATA_LAYER_SQL};
