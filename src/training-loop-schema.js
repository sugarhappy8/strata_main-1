"use strict";

const TRAINING_LOOP_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workout_check_ins (
    user_id TEXT NOT NULL,
    workout_id TEXT NOT NULL,
    difficulty INTEGER NOT NULL CHECK(difficulty BETWEEN 1 AND 5),
    energy INTEGER NOT NULL CHECK(energy BETWEEN 1 AND 5),
    comfort INTEGER NOT NULL CHECK(comfort BETWEEN 1 AND 5),
    enjoyment INTEGER NOT NULL CHECK(enjoyment BETWEEN 1 AND 5),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,workout_id),
    FOREIGN KEY(user_id,workout_id) REFERENCES workouts(user_id,id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS training_blocks (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    block_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS training_adaptations (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,
    workout_id TEXT NOT NULL,
    adaptation_json TEXT NOT NULL,
    plan_updated_at INTEGER NOT NULL CHECK(plan_updated_at > 0),
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','dismissed')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY(user_id,id),
    FOREIGN KEY(user_id,workout_id) REFERENCES workouts(user_id,id) ON DELETE CASCADE
  )`,
  "UPDATE training_adaptations SET adaptation_json=json_remove(adaptation_json,'$.proposedPlan') WHERE json_valid(adaptation_json) AND json_type(adaptation_json,'$.proposedPlan') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS training_adaptations_pending ON training_adaptations(user_id,created_at DESC,id DESC) WHERE status='pending'",
];

const TRAINING_LOOP_SQL = {
  deleteWorkout: "DELETE FROM workouts WHERE user_id=? AND id=? AND revision=? RETURNING id",
  workoutCheckIn:
    "SELECT workout_id,difficulty,energy,comfort,enjoyment,created_at,updated_at FROM workout_check_ins WHERE user_id=? AND workout_id=?",
  upsertWorkoutCheckIn:
    "INSERT INTO workout_check_ins(user_id,workout_id,difficulty,energy,comfort,enjoyment,created_at,updated_at) SELECT ?,w.id,?,?,?,?,?,? FROM workouts w JOIN users u ON u.id=w.user_id AND u.suspended_at IS NULL WHERE w.user_id=? AND w.id=? AND CASE WHEN json_valid(w.workout_json) THEN json_extract(w.workout_json,'$.status') END='completed' ON CONFLICT(user_id,workout_id) DO UPDATE SET difficulty=excluded.difficulty,energy=excluded.energy,comfort=excluded.comfort,enjoyment=excluded.enjoyment,updated_at=MAX(workout_check_ins.updated_at+1,excluded.updated_at) RETURNING workout_id,difficulty,energy,comfort,enjoyment,created_at,updated_at",
  trainingBlock: "SELECT block_json,revision,updated_at FROM training_blocks WHERE user_id=?",
  upsertTrainingBlock:
    "INSERT INTO training_blocks(user_id,block_json,revision,updated_at) SELECT u.id,?,1,? FROM users u WHERE u.id=? AND u.suspended_at IS NULL AND (?=0 OR EXISTS(SELECT 1 FROM training_blocks current WHERE current.user_id=u.id)) ON CONFLICT(user_id) DO UPDATE SET block_json=excluded.block_json,revision=training_blocks.revision+1,updated_at=MAX(training_blocks.updated_at+1,excluded.updated_at) WHERE ?>0 AND training_blocks.revision=? RETURNING block_json,revision,updated_at",
  trainingAdaptation:
    "SELECT id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at FROM training_adaptations WHERE user_id=? AND id=?",
  latestTrainingAdaptation:
    "SELECT id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at FROM training_adaptations WHERE user_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1",
  upsertTrainingAdaptation:
    "INSERT INTO training_adaptations(user_id,id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at) SELECT ?,?,w.id,?,?,'pending',?,NULL FROM workouts w JOIN plans p ON p.user_id=w.user_id AND p.updated_at=? WHERE w.user_id=? AND w.id=? AND CASE WHEN json_valid(w.workout_json) THEN json_extract(w.workout_json,'$.status') END='completed' AND EXISTS(SELECT 1 FROM workout_check_ins c WHERE c.user_id=w.user_id AND c.workout_id=w.id AND c.updated_at=?) AND ((SELECT COUNT(*) FROM training_adaptations a WHERE a.user_id=w.user_id AND a.status='pending')<20 OR EXISTS(SELECT 1 FROM training_adaptations a WHERE a.user_id=w.user_id AND a.id=?)) ON CONFLICT(user_id,id) DO UPDATE SET adaptation_json=excluded.adaptation_json,plan_updated_at=excluded.plan_updated_at,created_at=excluded.created_at WHERE training_adaptations.status='pending' RETURNING id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at",
  dismissTrainingAdaptation:
    "UPDATE training_adaptations SET status='dismissed',resolved_at=? WHERE user_id=? AND id=? AND status='pending' AND (? IS NULL OR EXISTS(SELECT 1 FROM workout_check_ins c WHERE c.user_id=training_adaptations.user_id AND c.workout_id=training_adaptations.workout_id AND c.updated_at=?)) RETURNING id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at",
  applyTrainingAdaptationPlan:
    "UPDATE plans SET plan_json=?,updated_at=MAX(updated_at+1,?) WHERE user_id=? AND updated_at=? AND EXISTS(SELECT 1 FROM training_adaptations a JOIN workouts w ON w.user_id=a.user_id AND w.id=a.workout_id JOIN workout_check_ins c ON c.user_id=w.user_id AND c.workout_id=w.id WHERE a.user_id=? AND a.id=? AND a.status='pending' AND a.plan_updated_at=? AND CASE WHEN json_valid(w.workout_json) THEN json_extract(w.workout_json,'$.status') END='completed' AND c.updated_at=?) RETURNING plan_json,updated_at",
  acceptTrainingAdaptation:
    "UPDATE training_adaptations SET status='accepted',resolved_at=? WHERE user_id=? AND id=? AND status='pending' AND plan_updated_at=? AND changes()=1 RETURNING id,workout_id,adaptation_json,plan_updated_at,status,created_at,resolved_at",
  deleteTrainingAdaptationsForWorkout:
    "DELETE FROM training_adaptations WHERE user_id=? AND workout_id=? AND NOT EXISTS(SELECT 1 FROM workouts w WHERE w.user_id=? AND w.id=?)",
  deleteWorkoutCheckInForWorkout:
    "DELETE FROM workout_check_ins WHERE user_id=? AND workout_id=? AND NOT EXISTS(SELECT 1 FROM workouts w WHERE w.user_id=? AND w.id=?)",
  deleteTrainingAdaptationsForDeletedUser:
    "DELETE FROM training_adaptations WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteWorkoutCheckInsForDeletedUser:
    "DELETE FROM workout_check_ins WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteTrainingBlockForDeletedUser:
    "DELETE FROM training_blocks WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
};

module.exports = { TRAINING_LOOP_SCHEMA, TRAINING_LOOP_SQL };
