// @ts-check
"use strict";

// Server state that must survive a restart. The event outbox holds a reaction (one handler for one event) that failed,
// so it is retried with backoff instead of lost. A member's queued reactions go when the member is deleted.

const SERVER_STATE_SCHEMA=Object.freeze([
  `CREATE TABLE IF NOT EXISTS event_outbox (
    id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    handler_key TEXT NOT NULL,
    user_id TEXT,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK(attempts >= 1),
    attempted_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    gave_up_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS event_outbox_due ON event_outbox(next_attempt_at) WHERE gave_up_at IS NULL",
  "CREATE INDEX IF NOT EXISTS event_outbox_user ON event_outbox(user_id) WHERE gave_up_at IS NULL",
  "DROP TRIGGER IF EXISTS event_outbox_on_user_delete",
  `CREATE TRIGGER event_outbox_on_user_delete
    BEFORE DELETE ON users
    BEGIN
      DELETE FROM event_outbox WHERE user_id=OLD.id;
    END`
]);

const OUTBOX="id,event_name,handler_key,user_id,payload_json,attempts";

const SERVER_STATE_SQL=Object.freeze({
  addOutboxEvent:"INSERT INTO event_outbox(id,event_name,handler_key,user_id,payload_json,attempts,attempted_at,next_attempt_at,last_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  dueOutboxEvents:`SELECT ${OUTBOX} FROM event_outbox WHERE gave_up_at IS NULL AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at LIMIT ?`,
  // On a read, a member's queued reactions are retried early, but no more than once per spacing interval.
  userOutboxEvents:`SELECT ${OUTBOX} FROM event_outbox WHERE user_id=? AND gave_up_at IS NULL AND lease_until<=? AND attempted_at<=? ORDER BY created_at LIMIT ?`,
  // A lease makes one retry own the row, so the timer and a read never run the same reaction at once.
  claimOutboxEvent:"UPDATE event_outbox SET lease_until=? WHERE id=? AND gave_up_at IS NULL AND lease_until<=? RETURNING id",
  completeOutboxEvent:"DELETE FROM event_outbox WHERE id=?",
  failOutboxEvent:"UPDATE event_outbox SET attempts=?,attempted_at=?,next_attempt_at=?,lease_until=0,last_error=?,gave_up_at=? WHERE id=?",
  deleteOldOutboxEvents:"DELETE FROM event_outbox WHERE gave_up_at IS NOT NULL AND gave_up_at<?"
});

module.exports={SERVER_STATE_SCHEMA,SERVER_STATE_SQL};
