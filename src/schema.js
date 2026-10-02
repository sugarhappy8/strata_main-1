"use strict";

const {
  PRODUCT_SIGNAL_TABLE,
  PRODUCT_SIGNAL_SCHEMA,
  PRODUCT_SIGNAL_SQL,
} = require("./product-signals-schema");
const { TRAINING_LOOP_SCHEMA, TRAINING_LOOP_SQL } = require("./training-loop-schema");
const {
  BILLING_SCHEMA,
  BILLING_SQL,
  BILLING_DELETION_BLOCKER,
  activeEntitlement,
  withEntitlementClock,
} = require("./billing-schema");
const { ACCOUNT_SELF_SERVICE_SQL } = require("./account-self-service-schema");
const { COACHING_SCHEMA, COACHING_SQL } = require("./coaching-schema");
const { DEVICE_SCHEMA, DEVICE_SQL } = require("./devices-schema");
const { DATA_LAYER_SCHEMA, DATA_LAYER_SQL } = require("./data-layer-schema");
const { AI_SCHEMA, AI_SQL } = require("./ai-schema");
const {
  APPLE_BILLING_SCHEMA,
  APPLE_BILLING_SQL,
  activeAppleSubscription,
} = require("./apple-billing-schema");
const { SOCIAL_AUTH_SCHEMA, SOCIAL_AUTH_SQL } = require("./social-auth-schema");
const { SERVER_STATE_SCHEMA, SERVER_STATE_SQL } = require("./server-state-schema");

// Central catalog shared by the local SQLite and Turso adapters.
const WORKOUT_ACTIVE_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS workouts_one_active_per_user ON workouts(user_id) WHERE CASE WHEN json_valid(workout_json) THEN json_extract(workout_json,'$.status') END='active'";
const COMPLETED_WORKOUT_FILTER =
  "CASE WHEN json_valid(summary_json) THEN json_extract(summary_json,'$.status') END='completed'";
const SUBSCRIPTION_RENEWAL_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;
const {
  ADMIN_CONTROLS_TABLE,
  ACCESS_CONTROLS_SQL,
  CONTROL_COLUMNS,
  activeGrant,
} = require("./access-controls-schema");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    email_verified_at INTEGER,
    auth_version INTEGER NOT NULL DEFAULT 1,
    suspended_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    auth_version INTEGER NOT NULL DEFAULT 1
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id)",
  "CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at)",
  `CREATE TABLE IF NOT EXISTS signup_verifications (
    challenge_id TEXT PRIMARY KEY,
    browser_token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'signup' CHECK(purpose IN ('signup','login')),
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    code_digest TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used >= 0),
    send_count INTEGER NOT NULL DEFAULT 0 CHECK(send_count >= 0),
    last_sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hard_expires_at INTEGER NOT NULL,
    delivery_state TEXT NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(expires_at <= hard_expires_at)
  )`,
  "CREATE INDEX IF NOT EXISTS signup_verifications_user_id_idx ON signup_verifications(user_id)",
  "CREATE INDEX IF NOT EXISTS signup_verifications_email ON signup_verifications(email,consumed_at,created_at)",
  "CREATE INDEX IF NOT EXISTS signup_verifications_expiry ON signup_verifications(hard_expires_at,consumed_at)",
  `CREATE TABLE IF NOT EXISTS email_verification_sends (
    send_id TEXT PRIMARY KEY,
    email_hash TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    sent_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS email_verification_sends_email_time ON email_verification_sends(email_hash,sent_at)",
  "CREATE INDEX IF NOT EXISTS email_verification_sends_time ON email_verification_sends(sent_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS email_verification_sends_challenge_generation ON email_verification_sends(challenge_id,generation)",
  `CREATE TABLE IF NOT EXISTS account_action_requests (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    delivery_state TEXT NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id,purpose)
  )`,
  "CREATE INDEX IF NOT EXISTS account_action_requests_expiry ON account_action_requests(expires_at,consumed_at)",
  `CREATE TABLE IF NOT EXISTS account_action_deliveries (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS account_action_deliveries_user_purpose ON account_action_deliveries(user_id,purpose)",
  "CREATE INDEX IF NOT EXISTS account_action_deliveries_expiry ON account_action_deliveries(expires_at)",
  `CREATE TABLE IF NOT EXISTS account_action_sends (
    send_id TEXT PRIMARY KEY,
    email_hash TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
    sent_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS account_action_sends_email_time ON account_action_sends(email_hash,purpose,sent_at)",
  "CREATE INDEX IF NOT EXISTS account_action_sends_time ON account_action_sends(sent_at)",
  `CREATE TABLE IF NOT EXISTS workouts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    workout_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    create_hash TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,id)
  )`,
  "CREATE INDEX IF NOT EXISTS workouts_user_started ON workouts(user_id,started_at DESC,id DESC)",
  WORKOUT_ACTIVE_INDEX,
  ...TRAINING_LOOP_SCHEMA,
  ...COACHING_SCHEMA,
  ...DEVICE_SCHEMA,
  ...DATA_LAYER_SCHEMA,
  ...AI_SCHEMA,
  ...SOCIAL_AUTH_SCHEMA,
  ...SERVER_STATE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS plans (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS monthly_plans (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    preferences_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ratings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_id TEXT NOT NULL,
    comfort INTEGER NOT NULL CHECK(comfort BETWEEN 1 AND 5),
    pump INTEGER NOT NULL CHECK(pump BETWEEN 1 AND 5),
    enjoyment INTEGER NOT NULL CHECK(enjoyment BETWEEN 1 AND 5),
    stability INTEGER NOT NULL CHECK(stability BETWEEN 1 AND 5),
    setup INTEGER NOT NULL CHECK(setup BETWEEN 1 AND 5),
    overall INTEGER NOT NULL CHECK(overall BETWEEN 1 AND 5),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,exercise_id)
  )`,
  "CREATE INDEX IF NOT EXISTS ratings_exercise_id ON ratings(exercise_id)",
  ...BILLING_SCHEMA,
  ...APPLE_BILLING_SCHEMA,
  ADMIN_CONTROLS_TABLE,
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    category TEXT NOT NULL CHECK(category IN ('account','password','payment','privacy','exercise','other')),
    subject TEXT NOT NULL,
    reference_id TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','open','waiting','resolved')),
    admin_note TEXT,
    last_response_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS support_tickets_status_updated ON support_tickets(status,updated_at DESC)",
  `CREATE TABLE IF NOT EXISTS support_request_events (
    id TEXT PRIMARY KEY,
    ip_hash TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS support_request_events_ip_time ON support_request_events(ip_hash,created_at)",
  "CREATE INDEX IF NOT EXISTS support_request_events_email_time ON support_request_events(email_hash,created_at)",
  "CREATE INDEX IF NOT EXISTS support_request_events_time ON support_request_events(created_at)",
  PRODUCT_SIGNAL_TABLE,
  ...PRODUCT_SIGNAL_SCHEMA,
  `CREATE TABLE IF NOT EXISTS admin_principal (
    slot TEXT PRIMARY KEY CHECK(slot='primary'),
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    configured_email TEXT NOT NULL COLLATE NOCASE,
    bound_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS admin_audit_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit_events(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS admin_audit_actor ON admin_audit_events(actor_user_id,created_at DESC)",
  `CREATE TRIGGER IF NOT EXISTS admin_principal_secure_claim
    AFTER INSERT ON admin_principal
    BEGIN
      UPDATE users SET auth_version=auth_version+1 WHERE id=NEW.user_id;
      DELETE FROM sessions WHERE user_id=NEW.user_id;
      DELETE FROM account_action_requests WHERE user_id=NEW.user_id;
      DELETE FROM account_action_deliveries WHERE user_id=NEW.user_id;
      INSERT INTO admin_audit_events(id,actor_user_id,target_user_id,action,reason,result,created_at)
      VALUES(lower(hex(randomblob(16))),NEW.user_id,NEW.user_id,'admin-bound','Primary administrator activated','success',NEW.bound_at);
    END`,
];

const SQL = {
  ...ACCESS_CONTROLS_SQL,
  ...ACCOUNT_SELF_SERVICE_SQL,
  ...BILLING_SQL,
  ping: "SELECT 1 AS ok",
  userByEmail: "SELECT * FROM users WHERE email = ?",
  userById:
    "SELECT id,name,email,created_at,email_verified_at,auth_version,suspended_at FROM users WHERE id = ?",
  accountCredentialsById:
    "SELECT id,email,password_hash,password_salt,auth_version,suspended_at FROM users WHERE id = ?",
  insertUser:
    "INSERT INTO users(id,name,email,password_hash,password_salt,created_at,email_verified_at) VALUES(?,?,?,?,?,?,?)",
  insertSession: `INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at,auth_version)
    SELECT ?,id,?,?,?,auth_version
    FROM users
    WHERE id=? AND auth_version=? AND suspended_at IS NULL
    RETURNING token_hash`,
  session: `SELECT s.token_hash,s.csrf_token,s.expires_at,s.created_at AS session_created_at,u.id,u.name,
      u.email,u.created_at,u.email_verified_at,u.auth_version,u.suspended_at
    FROM sessions s
    JOIN users u ON u.id=s.user_id AND u.auth_version=s.auth_version AND u.suspended_at IS NULL
    WHERE s.token_hash=? AND s.expires_at>?`,
  // Sliding renewal only ever extends a live session, and never past the expiry the caller computed from its cap.
  renewSession:
    "UPDATE sessions SET expires_at=? WHERE token_hash=? AND expires_at>? AND expires_at<? RETURNING token_hash",
  deleteSession: "DELETE FROM sessions WHERE token_hash=?",
  deleteExpired: "DELETE FROM sessions WHERE expires_at<=?",
  verificationByTokenHash: `SELECT challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,
      code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,
      delivery_state,consumed_at,created_at,updated_at
    FROM signup_verifications
    WHERE browser_token_hash=?`,
  verificationByChallenge: `SELECT challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,
      code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,
      delivery_state,consumed_at,created_at,updated_at
    FROM signup_verifications
    WHERE challenge_id=?`,
  insertVerification: `INSERT INTO signup_verifications(challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,delivery_state,consumed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)`,
  rotateVerification: `UPDATE signup_verifications
    SET code_digest=?,generation=generation+1,attempts_used=0,send_count=send_count+1,last_sent_at=?,
      expires_at=?,delivery_state=?,updated_at=?
    WHERE challenge_id=? AND generation=? AND consumed_at IS NULL
    RETURNING challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,
      code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,
      delivery_state,consumed_at,created_at,updated_at`,
  markVerificationDelivery: `UPDATE signup_verifications
    SET delivery_state=?,updated_at=?
    WHERE challenge_id=? AND generation=? AND consumed_at IS NULL
    RETURNING challenge_id`,
  claimVerificationAttempt: `UPDATE signup_verifications
    SET attempts_used=attempts_used+1,updated_at=?
    WHERE challenge_id=? AND generation=? AND consumed_at IS NULL AND expires_at>?
      AND hard_expires_at>? AND attempts_used<?
    RETURNING challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,
      code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,
      delivery_state,consumed_at,created_at,updated_at`,
  consumeVerification: `UPDATE signup_verifications
    SET code_digest='',password_hash='',password_salt='',delivery_state='consumed',consumed_at=?,
      updated_at=?
    WHERE challenge_id=? AND generation=? AND consumed_at IS NULL
    RETURNING challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,
      code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,
      delivery_state,consumed_at,created_at,updated_at`,
  completeSignupInsert: `INSERT INTO users(id,name,email,password_hash,password_salt,created_at,email_verified_at)
    SELECT user_id,name,email,password_hash,password_salt,?,?
    FROM signup_verifications
    WHERE challenge_id=? AND generation=? AND purpose='signup' AND consumed_at IS NULL
      AND expires_at>? AND hard_expires_at>?
    RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at`,
  completeSignupConsume: `UPDATE signup_verifications
    SET code_digest='',password_hash='',password_salt='',delivery_state='consumed',consumed_at=?,
      updated_at=?
    WHERE changes()=1 AND challenge_id=? AND generation=? AND purpose='signup'
      AND consumed_at IS NULL AND expires_at>? AND hard_expires_at>?
    RETURNING challenge_id`,
  completeSignupSession: `INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at,auth_version)
    SELECT ?,v.user_id,?,?,?,u.auth_version
    FROM signup_verifications v
    JOIN users u ON u.id=v.user_id
    WHERE changes()=1 AND v.challenge_id=? AND v.generation=? AND v.purpose='signup'
      AND v.consumed_at=?
    RETURNING token_hash`,
  completeLoginVerifyUser: `UPDATE users
    SET email_verified_at=?
    WHERE email_verified_at IS NULL AND suspended_at IS NULL
      AND id=(SELECT user_id FROM signup_verifications WHERE challenge_id=? AND generation=? AND purpose='login' AND consumed_at IS NULL AND expires_at>? AND hard_expires_at>?)
    RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at`,
  completeLoginConsume: `UPDATE signup_verifications
    SET code_digest='',password_hash='',password_salt='',delivery_state='consumed',consumed_at=?,
      updated_at=?
    WHERE changes()=1 AND challenge_id=? AND generation=? AND purpose='login'
      AND consumed_at IS NULL AND expires_at>? AND hard_expires_at>?
    RETURNING challenge_id`,
  completeLoginSession: `INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at,auth_version)
    SELECT ?,v.user_id,?,?,?,u.auth_version
    FROM signup_verifications v
    JOIN users u ON u.id=v.user_id AND u.suspended_at IS NULL
    WHERE changes()=1 AND v.challenge_id=? AND v.generation=? AND v.purpose='login'
      AND v.consumed_at=?
    RETURNING token_hash`,
  completeLoginDeleteOldSessions: `DELETE FROM sessions
    WHERE changes()=1
      AND user_id=(SELECT user_id FROM signup_verifications WHERE challenge_id=? AND generation=? AND purpose='login' AND consumed_at=?)
      AND token_hash<>?
    RETURNING token_hash`,
  countVerificationSends:
    "SELECT COUNT(*) AS send_count FROM email_verification_sends WHERE email_hash=? AND sent_at>=?",
  recordVerificationSend:
    "INSERT INTO email_verification_sends(send_id,email_hash,challenge_id,generation,sent_at) VALUES(?,?,?,?,?)",
  claimVerificationSend: `INSERT OR IGNORE INTO email_verification_sends(send_id,email_hash,challenge_id,generation,sent_at)
    SELECT ?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM email_verification_sends WHERE email_hash=? AND sent_at>=?)<?
    RETURNING send_id`,
  verificationSendByChallengeGeneration:
    "SELECT send_id,email_hash,challenge_id,generation,sent_at FROM email_verification_sends WHERE challenge_id=? AND generation=?",
  deleteOldVerifications:
    "DELETE FROM signup_verifications WHERE hard_expires_at<=? OR (consumed_at IS NOT NULL AND consumed_at<=?)",
  deleteOldVerificationSends: "DELETE FROM email_verification_sends WHERE sent_at<?",
  accountActionByTokenHash: `SELECT a.request_id,a.user_id,a.purpose,a.token_hash,a.expires_at,a.delivery_state,a.consumed_at,
      a.created_at,a.updated_at,u.email,u.name
    FROM account_action_requests a
    JOIN users u ON u.id=a.user_id
    WHERE a.token_hash=?`,
  accountActionForUser: `SELECT request_id,user_id,purpose,token_hash,expires_at,delivery_state,consumed_at,created_at,
      updated_at
    FROM account_action_requests
    WHERE user_id=? AND purpose=?`,
  upsertAccountAction: `INSERT INTO account_action_requests(request_id,user_id,purpose,token_hash,expires_at,delivery_state,consumed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,NULL,?,?)
    ON CONFLICT(user_id,purpose) DO UPDATE
    SET request_id=excluded.request_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,
      delivery_state=excluded.delivery_state,consumed_at=NULL,created_at=excluded.created_at,
      updated_at=excluded.updated_at
    RETURNING request_id,user_id,purpose,token_hash,expires_at,delivery_state,consumed_at,created_at,
      updated_at`,
  markAccountActionDelivery: `UPDATE account_action_requests
    SET delivery_state=?,updated_at=?
    WHERE request_id=? AND token_hash=? AND consumed_at IS NULL
    RETURNING request_id`,
  stageAccountAction: `INSERT INTO account_action_deliveries(request_id,user_id,purpose,token_hash,expires_at,created_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,purpose) DO UPDATE
    SET request_id=excluded.request_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,
      created_at=excluded.created_at
    RETURNING request_id,user_id,purpose,token_hash,expires_at,created_at`,
  activateAccountAction: `INSERT INTO account_action_requests(request_id,user_id,purpose,token_hash,expires_at,delivery_state,consumed_at,created_at,updated_at)
    SELECT request_id,user_id,purpose,token_hash,expires_at,'sent',NULL,created_at,?
    FROM account_action_deliveries
    WHERE request_id=? AND token_hash=? AND expires_at>?
    ON CONFLICT(user_id,purpose) DO UPDATE
    SET request_id=excluded.request_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,
      delivery_state='sent',consumed_at=NULL,created_at=excluded.created_at,
      updated_at=excluded.updated_at
    WHERE account_action_requests.created_at<=excluded.created_at
    RETURNING request_id,user_id,purpose,token_hash,expires_at,delivery_state,consumed_at,created_at,
      updated_at`,
  discardStagedAccountAction:
    "DELETE FROM account_action_deliveries WHERE request_id=? AND token_hash=? RETURNING request_id",
  claimAccountActionSend: `INSERT OR IGNORE INTO account_action_sends(send_id,email_hash,purpose,sent_at)
    SELECT ?,?,?,?
    WHERE (SELECT COUNT(*) FROM account_action_sends WHERE email_hash=? AND purpose=? AND sent_at>=?)<?
    RETURNING send_id`,
  countAccountActionSends:
    "SELECT COUNT(*) AS send_count FROM account_action_sends WHERE email_hash=? AND purpose=? AND sent_at>=?",
  deleteOldAccountActions:
    "DELETE FROM account_action_requests WHERE expires_at<=? OR (consumed_at IS NOT NULL AND consumed_at<=?)",
  deleteOldStagedAccountActions: "DELETE FROM account_action_deliveries WHERE expires_at<=?",
  deleteOldAccountActionSends: "DELETE FROM account_action_sends WHERE sent_at<?",
  activeAccountDeletion: `SELECT request_id,expires_at
    FROM account_action_requests
    WHERE user_id=? AND purpose='account_delete' AND delivery_state='sent' AND consumed_at IS NULL
      AND expires_at>?`,
  activeCheckoutCreationForUser: `SELECT user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at
    FROM paddle_checkout_claims
    WHERE user_id=? AND expires_at>?`,
  cancelAccountDeletion: `DELETE FROM account_action_requests
    WHERE user_id=? AND purpose='account_delete' AND delivery_state='sent' AND consumed_at IS NULL
    RETURNING request_id`,
  discardAccountAction:
    "DELETE FROM account_action_requests WHERE token_hash=? AND consumed_at IS NULL",
  cancelStagedAccountDeletions:
    "DELETE FROM account_action_deliveries WHERE user_id=? AND purpose='account_delete' RETURNING request_id",
  cancelStagedAccountDeletionsIfAudit: `DELETE FROM account_action_deliveries
    WHERE user_id=? AND purpose='account_delete'
      AND EXISTS(SELECT 1 FROM admin_audit_events WHERE id=?)
    RETURNING request_id`,
  completePasswordResetUser: `UPDATE users
    SET password_hash=?,password_salt=?,email_verified_at=COALESCE(email_verified_at,?),
      auth_version=auth_version+1
    WHERE id=(SELECT user_id FROM account_action_requests WHERE token_hash=? AND purpose='password_reset' AND delivery_state='sent' AND consumed_at IS NULL AND expires_at>?)
    RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at`,
  completePasswordResetConsume: `UPDATE account_action_requests
    SET consumed_at=?,delivery_state='consumed',updated_at=?
    WHERE changes()=1 AND token_hash=? AND purpose='password_reset' AND delivery_state='sent'
      AND consumed_at IS NULL AND expires_at>?
    RETURNING user_id`,
  completePasswordResetDeleteSessions: `DELETE FROM sessions
    WHERE user_id=(SELECT user_id FROM account_action_requests WHERE token_hash=? AND purpose='password_reset' AND consumed_at=?)
    RETURNING token_hash`,
  completePasswordResetDeleteStagedActions: `DELETE FROM account_action_deliveries
    WHERE user_id=(SELECT user_id FROM account_action_requests WHERE token_hash=? AND purpose='password_reset' AND consumed_at=?)
    RETURNING request_id`,
  completePasswordResetDeleteActions: `DELETE FROM account_action_requests
    WHERE user_id=(SELECT user_id FROM account_action_requests WHERE token_hash=? AND purpose='password_reset' AND consumed_at=?)
    RETURNING request_id`,
  deleteUserWithAction: `DELETE FROM users
  WHERE id=(SELECT user_id FROM account_action_requests WHERE token_hash=? AND purpose='account_delete' AND delivery_state='sent' AND consumed_at IS NULL AND expires_at>?)
    AND NOT EXISTS (SELECT 1 FROM admin_principal ap WHERE ap.user_id=users.id)
    AND NOT EXISTS (SELECT 1 FROM paddle_purchases p WHERE p.user_id=users.id AND ${BILLING_DELETION_BLOCKER})
    AND NOT EXISTS (SELECT 1 FROM paddle_checkout_claims c WHERE c.user_id=users.id AND c.expires_at>?)
  RETURNING id,email`,
  deleteVerificationSendsForDeletedUser: `DELETE FROM email_verification_sends
    WHERE challenge_id IN (SELECT challenge_id FROM signup_verifications WHERE user_id=? OR email=?)
      AND NOT EXISTS (SELECT 1 FROM users WHERE id=?)`,
  deleteVerificationsForDeletedUser:
    "DELETE FROM signup_verifications WHERE (user_id=? OR email=?) AND NOT EXISTS (SELECT 1 FROM users WHERE id=?)",
  deleteActionSendsForDeletedUser:
    "DELETE FROM account_action_sends WHERE email_hash=? AND NOT EXISTS (SELECT 1 FROM users WHERE id=?)",
  deleteCheckoutClaimsForDeletedUser:
    "DELETE FROM paddle_checkout_claims WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM users WHERE id=?) RETURNING claim_id",
  workout:
    "SELECT workout_json,create_hash,revision,updated_at FROM workouts WHERE user_id=? AND id=?",
  activeWorkout: `SELECT workout_json,create_hash,revision,updated_at
    FROM workouts
    WHERE user_id=?
      AND CASE WHEN json_valid(workout_json) THEN json_extract(workout_json,'$.status') END='active'
    LIMIT 1`,
  workouts:
    "SELECT summary_json,revision,updated_at FROM workouts WHERE user_id=? ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?",
  workoutCount: "SELECT COUNT(*) AS count FROM workouts WHERE user_id=?",
  insertWorkout: `INSERT OR IGNORE INTO workouts (id,workout_json,summary_json,create_hash,started_at,updated_at,user_id)
    SELECT ?,?,?,?,?,?,id
    FROM users
    WHERE id=? AND suspended_at IS NULL
      AND (SELECT COUNT(*) FROM workouts WHERE user_id=users.id)<10000
    RETURNING workout_json,create_hash,revision,updated_at`,
  updateWorkout: `UPDATE OR IGNORE workouts
    SET workout_json=?,summary_json=?,revision=revision+1,updated_at=MAX(updated_at+1,?)
    WHERE user_id=? AND id=? AND revision=?
      AND EXISTS(SELECT 1 FROM users WHERE users.id=workouts.user_id AND suspended_at IS NULL)
    RETURNING workout_json,create_hash,revision,updated_at`,
  deleteWorkoutsForDeletedUser:
    "DELETE FROM workouts WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM users WHERE id=?)",
  plan: "SELECT plan_json,updated_at FROM plans WHERE user_id=?",
  upsertPlan: `INSERT INTO plans(user_id,plan_json,updated_at)
    SELECT u.id,?,?
    FROM users u
    WHERE u.id=? AND u.suspended_at IS NULL
      AND (?=0 OR EXISTS(SELECT 1 FROM plans current_plan WHERE current_plan.user_id=u.id AND current_plan.updated_at=?))
    ON CONFLICT(user_id) DO UPDATE
    SET plan_json=excluded.plan_json,updated_at=MAX(plans.updated_at+1,excluded.updated_at)
    WHERE ?<>0 AND plans.updated_at=?
    RETURNING plan_json,updated_at`,
  upsertPlanForSetup: `INSERT INTO plans(user_id,plan_json,updated_at)
    SELECT u.id,?,MAX(?,?+1)
    FROM users u
    WHERE u.id=? AND u.suspended_at IS NULL
      AND COALESCE((SELECT updated_at FROM preferences WHERE user_id=u.id),0)=?
      AND (?=0 OR EXISTS(SELECT 1 FROM plans current_plan WHERE current_plan.user_id=u.id AND current_plan.updated_at=?))
    ON CONFLICT(user_id) DO UPDATE
    SET plan_json=excluded.plan_json,updated_at=MAX(plans.updated_at+1,excluded.updated_at)
    WHERE ?<>0 AND plans.updated_at=?
    RETURNING plan_json,updated_at`,
  upsertPreferencesAfterPlan: `INSERT INTO preferences(user_id,preferences_json,updated_at)
    SELECT ?,?,p.updated_at
    FROM plans p
    WHERE p.user_id=? AND changes()=1
    ON CONFLICT(user_id) DO UPDATE
    SET preferences_json=excluded.preferences_json,updated_at=excluded.updated_at
    RETURNING preferences_json,updated_at`,
  monthlyPlan: "SELECT plan_json,updated_at FROM monthly_plans WHERE user_id=?",
  upsertMonthlyPlan: `INSERT INTO monthly_plans(user_id,plan_json,updated_at)
    VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE
    SET plan_json=excluded.plan_json,updated_at=excluded.updated_at`,
  compareAndSwapMonthlyPlan: `INSERT INTO monthly_plans(user_id,plan_json,updated_at)
    SELECT ?,?,?
    WHERE COALESCE((SELECT updated_at FROM monthly_plans WHERE user_id=?),0)=?
    ON CONFLICT(user_id) DO UPDATE
    SET plan_json=excluded.plan_json,updated_at=excluded.updated_at
    WHERE monthly_plans.updated_at=?
    RETURNING plan_json,updated_at`,
  preferences: "SELECT preferences_json,updated_at FROM preferences WHERE user_id=?",
  upsertPreferences: `INSERT INTO preferences(user_id,preferences_json,updated_at)
    VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE
    SET preferences_json=excluded.preferences_json,
      updated_at=MAX(preferences.updated_at+1,excluded.updated_at)`,
  ratingsForUser:
    "SELECT exercise_id,comfort,pump,enjoyment,stability,setup,overall,updated_at FROM ratings WHERE user_id=?",
  ratingAggregates: `SELECT exercise_id,COUNT(*) AS rating_count,AVG(comfort) AS comfort,AVG(pump) AS pump,
      AVG(enjoyment) AS enjoyment,AVG(stability) AS stability,AVG(setup) AS setup,
      AVG(overall) AS overall
    FROM ratings
    GROUP BY exercise_id`,
  ratingAggregate: `SELECT exercise_id,COUNT(*) AS rating_count,AVG(comfort) AS comfort,AVG(pump) AS pump,
      AVG(enjoyment) AS enjoyment,AVG(stability) AS stability,AVG(setup) AS setup,
      AVG(overall) AS overall
    FROM ratings
    WHERE exercise_id=?
    GROUP BY exercise_id`,
  upsertRating: `INSERT INTO ratings(user_id,exercise_id,comfort,pump,enjoyment,stability,setup,overall,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,exercise_id) DO UPDATE
    SET comfort=excluded.comfort,pump=excluded.pump,enjoyment=excluded.enjoyment,
      stability=excluded.stability,setup=excluded.setup,overall=excluded.overall,
      updated_at=excluded.updated_at`,
  adminOverview: withEntitlementClock(
    `SELECT (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL) AS verified_users,
      (SELECT COUNT(*) FROM users WHERE suspended_at IS NOT NULL) AS suspended_users,
      (SELECT COUNT(*)
        FROM sessions s
        JOIN users u ON u.id=s.user_id AND u.auth_version=s.auth_version
        WHERE s.expires_at>? AND u.suspended_at IS NULL) AS active_sessions,
      (SELECT COUNT(*)
        FROM users u
        WHERE u.suspended_at IS NULL
          AND (EXISTS(SELECT 1 FROM paddle_purchases pp WHERE pp.user_id=u.id AND ${activeEntitlement("pp")})
              OR EXISTS(SELECT 1 FROM apple_subscriptions aps WHERE aps.user_id=u.id AND ${activeAppleSubscription("aps")})
              OR EXISTS(SELECT 1 FROM admin_account_controls ac WHERE ac.user_id=u.id AND ${activeGrant("ac")}))) AS discovery_users,
      (SELECT COUNT(*)
        FROM paddle_purchases
        WHERE paddle_status<>'canceled' AND completed_at IS NULL AND access_revoked_at IS NULL) AS pending_payments,
      (SELECT COUNT(*)
        FROM account_action_requests
        WHERE purpose='account_delete' AND delivery_state='sent' AND consumed_at IS NULL
          AND expires_at>?) AS pending_deletions,
      (SELECT COUNT(*) FROM support_tickets WHERE status<>'resolved') AS open_support,
      (SELECT COUNT(*) FROM (SELECT user_id FROM workouts WHERE ${COMPLETED_WORKOUT_FILTER} GROUP BY user_id)) AS first_workout_users,
      (SELECT COUNT(*)
        FROM (SELECT user_id FROM workouts WHERE ${COMPLETED_WORKOUT_FILTER} GROUP BY user_id HAVING COUNT(*)>=2)) AS second_workout_users,
      (SELECT COUNT(*)
        FROM (SELECT user_id
            FROM workouts
            WHERE ${COMPLETED_WORKOUT_FILTER}
            GROUP BY user_id
            HAVING MAX(started_at)-MIN(started_at)>=604800000)) AS day_eight_return_users,
      (SELECT COUNT(DISTINCT user_id) FROM paddle_purchases WHERE completed_at IS NOT NULL) AS paid_users,
      (SELECT COUNT(*)
        FROM paddle_subscriptions
        WHERE current_period_ends_at>created_at+${SUBSCRIPTION_RENEWAL_WINDOW_MS}) AS renewed_subscriptions`,
  ),
  adminUserById: withEntitlementClock(
    `SELECT ${CONTROL_COLUMNS},u.id,u.name,u.email,u.created_at,u.email_verified_at,u.auth_version,
      u.suspended_at,p.plan_json,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.auth_version=u.auth_version AND s.expires_at>?) AS active_session_count,
      (SELECT COUNT(*) FROM ratings r WHERE r.user_id=u.id) AS rating_count,
      (SELECT COUNT(*) FROM paddle_purchases pp WHERE pp.user_id=u.id) AS purchase_count,
      (SELECT COUNT(*) FROM paddle_purchases pp WHERE pp.user_id=u.id AND ${activeEntitlement("pp")}) AS active_purchase_count,
      (SELECT COUNT(*)
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id AND pp.paddle_status<>'canceled' AND pp.completed_at IS NULL
          AND pp.access_revoked_at IS NULL) AS pending_purchase_count,
      (SELECT MAX(pp.updated_at) FROM paddle_purchases pp WHERE pp.user_id=u.id) AS latest_purchase_at,
      (SELECT pp.transaction_id
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id
        ORDER BY pp.updated_at DESC,pp.transaction_id DESC
        LIMIT 1) AS transaction_id,
      (SELECT pp.paddle_status
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id
        ORDER BY pp.updated_at DESC,pp.transaction_id DESC
        LIMIT 1) AS transaction_status,
      (SELECT COUNT(*) FROM apple_subscriptions aps WHERE aps.user_id=u.id AND ${activeAppleSubscription("aps")}) AS active_apple_count,
      (SELECT aps.expires_at FROM apple_subscriptions aps WHERE aps.user_id=u.id ORDER BY aps.expires_at DESC LIMIT 1) AS apple_expires_at,
      (SELECT request_id
        FROM account_action_requests a
        WHERE a.user_id=u.id AND a.purpose='account_delete' AND a.delivery_state='sent'
          AND a.consumed_at IS NULL AND a.expires_at>?
        LIMIT 1) AS deletion_request_id,
      (SELECT expires_at
        FROM account_action_requests a
        WHERE a.user_id=u.id AND a.purpose='account_delete' AND a.delivery_state='sent'
          AND a.consumed_at IS NULL AND a.expires_at>?
        LIMIT 1) AS deletion_expires_at
    FROM users u
    LEFT JOIN admin_account_controls ac ON ac.user_id=u.id
    LEFT JOIN plans p ON p.user_id=u.id
    WHERE u.id=?`,
  ),
  adminUsers: withEntitlementClock(
    `SELECT ${CONTROL_COLUMNS},u.id,u.name,u.email,u.created_at,u.email_verified_at,u.suspended_at,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.auth_version=u.auth_version AND s.expires_at>?) AS active_session_count,
      (SELECT COUNT(*) FROM paddle_purchases pp WHERE pp.user_id=u.id) AS purchase_count,
      (SELECT COUNT(*) FROM paddle_purchases pp WHERE pp.user_id=u.id AND ${activeEntitlement("pp")}) AS active_purchase_count,
      (SELECT COUNT(*)
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id AND pp.paddle_status<>'canceled' AND pp.completed_at IS NULL
          AND pp.access_revoked_at IS NULL) AS pending_purchase_count,
      (SELECT MAX(pp.updated_at) FROM paddle_purchases pp WHERE pp.user_id=u.id) AS latest_purchase_at,
      (SELECT pp.transaction_id
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id
        ORDER BY pp.updated_at DESC,pp.transaction_id DESC
        LIMIT 1) AS transaction_id,
      (SELECT pp.paddle_status
        FROM paddle_purchases pp
        WHERE pp.user_id=u.id
        ORDER BY pp.updated_at DESC,pp.transaction_id DESC
        LIMIT 1) AS transaction_status,
      (SELECT COUNT(*) FROM apple_subscriptions aps WHERE aps.user_id=u.id AND ${activeAppleSubscription("aps")}) AS active_apple_count,
      (SELECT aps.expires_at FROM apple_subscriptions aps WHERE aps.user_id=u.id ORDER BY aps.expires_at DESC LIMIT 1) AS apple_expires_at,
      (SELECT expires_at
        FROM account_action_requests a
        WHERE a.user_id=u.id AND a.purpose='account_delete' AND a.delivery_state='sent'
          AND a.consumed_at IS NULL AND a.expires_at>?
        LIMIT 1) AS deletion_expires_at
    FROM users u
    LEFT JOIN admin_account_controls ac ON ac.user_id=u.id
    WHERE (?='' OR lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\'
          OR lower(u.id) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM paddle_purchases pp WHERE pp.user_id=u.id AND lower(pp.transaction_id) LIKE ? ESCAPE '\\'))
    ORDER BY u.created_at DESC,u.id DESC
    LIMIT ? OFFSET ?`,
  ),
  adminUserCount: `SELECT COUNT(*) AS total
    FROM users u
    WHERE (?='' OR lower(u.name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\'
          OR lower(u.id) LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM paddle_purchases pp WHERE pp.user_id=u.id AND lower(pp.transaction_id) LIKE ? ESCAPE '\\'))`,
  adminPrincipal: `SELECT ap.slot,ap.user_id,ap.configured_email,ap.bound_at,u.name,u.email,u.email_verified_at,
      u.suspended_at,u.auth_version
    FROM admin_principal ap
    JOIN users u ON u.id=ap.user_id
    WHERE ap.slot='primary'`,
  insertAdminPrincipal: `INSERT INTO admin_principal(slot,user_id,configured_email,bound_at)
    SELECT 'primary',id,?,?
    FROM users
    WHERE id=? AND email=? COLLATE NOCASE AND email_verified_at IS NOT NULL AND suspended_at IS NULL
    ON CONFLICT(slot) DO NOTHING
    RETURNING slot,user_id,configured_email,bound_at`,
  revokeUserSessionsUser:
    "UPDATE users SET auth_version=auth_version+1 WHERE id=? RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at",
  revokeUserSessionsDelete: "DELETE FROM sessions WHERE user_id=? RETURNING token_hash",
  suspendUser: `UPDATE users
    SET suspended_at=?,auth_version=auth_version+1
    WHERE id=? AND suspended_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM admin_principal ap WHERE ap.user_id=users.id)
    RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at`,
  restoreUser: `UPDATE users
    SET suspended_at=NULL
    WHERE id=? AND suspended_at IS NOT NULL
    RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at`,
  deleteUserByAdmin: `DELETE FROM users
  WHERE id=? AND email COLLATE BINARY=? AND suspended_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM admin_principal ap WHERE ap.user_id=users.id)
    AND NOT EXISTS (SELECT 1 FROM paddle_purchases p WHERE p.user_id=users.id AND ${BILLING_DELETION_BLOCKER})
    AND NOT EXISTS (SELECT 1 FROM paddle_checkout_claims c WHERE c.user_id=users.id AND c.expires_at>?)
    AND EXISTS (SELECT 1
      FROM admin_principal ap
      JOIN users actor ON actor.id=ap.user_id
      JOIN sessions s ON s.user_id=actor.id AND s.auth_version=actor.auth_version
      WHERE ap.slot='primary' AND ap.user_id=? AND ap.configured_email=actor.email COLLATE NOCASE
        AND actor.email_verified_at IS NOT NULL AND actor.suspended_at IS NULL AND s.token_hash=?
        AND s.expires_at>?)
  RETURNING id,email`,
  insertAdminAudit:
    "INSERT INTO admin_audit_events(id,actor_user_id,target_user_id,action,reason,result,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id",
  insertAdminAuditIfChanged: `INSERT INTO admin_audit_events(id,actor_user_id,target_user_id,action,reason,result,created_at)
    SELECT ?,?,?,?,?,?,?
    WHERE changes()>0
    RETURNING id`,
  adminAudit: `SELECT a.id,a.target_user_id,a.action,a.reason,a.result,a.created_at,actor.id AS actor_id,
      actor.name AS actor_name,actor.email AS actor_email,target.id AS target_id,
      target.name AS target_name,target.email AS target_email
    FROM admin_audit_events a
    JOIN users actor ON actor.id=a.actor_user_id
    LEFT JOIN users target ON target.id=a.target_user_id
    ORDER BY a.created_at DESC,a.id DESC
    LIMIT ?`,
  insertSupportTicket: `INSERT INTO support_tickets(id,reference,user_id,name,email,category,subject,reference_id,message,status,admin_note,last_response_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'new',NULL,NULL,?,?)
    RETURNING id,reference,user_id,name,email,category,subject,reference_id,message,status,
      admin_note,last_response_at,created_at,updated_at`,
  supportTicketById: `SELECT id,reference,user_id,name,email,category,subject,reference_id,message,status,admin_note,
      last_response_at,created_at,updated_at
    FROM support_tickets
    WHERE id=?`,
  adminSupportTickets: `SELECT id,reference,user_id,name,email,category,subject,reference_id,message,status,admin_note,
      last_response_at,created_at,updated_at
    FROM support_tickets
    WHERE (?='' OR status=?)
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'open' THEN 1 WHEN 'waiting' THEN 2 ELSE 3 END,
      updated_at DESC,id DESC
    LIMIT ? OFFSET ?`,
  adminSupportCount: "SELECT COUNT(*) AS total FROM support_tickets WHERE (?='' OR status=?)",
  updateSupportTicket: `UPDATE support_tickets
    SET status=?,admin_note=?,last_response_at=CASE WHEN ?=1 THEN ? ELSE last_response_at END,
      updated_at=?
    WHERE id=? AND updated_at=?
    RETURNING id,reference,user_id,name,email,category,subject,reference_id,message,status,
      admin_note,last_response_at,created_at,updated_at`,
  markSupportResponseSent: `UPDATE support_tickets
    SET last_response_at=?,updated_at=MAX(updated_at,?)
    WHERE id=?
    RETURNING id,reference,user_id,name,email,category,subject,reference_id,message,status,
      admin_note,last_response_at,created_at,updated_at`,
  claimSupportRequestEvent: `INSERT INTO support_request_events(id,ip_hash,email_hash,created_at)
    SELECT ?,?,?,?
    WHERE (SELECT COUNT(*) FROM support_request_events WHERE ip_hash=? AND created_at>=?)<?
      AND (SELECT COUNT(*) FROM support_request_events WHERE email_hash=? AND created_at>=?)<?
      AND (SELECT COUNT(*) FROM support_request_events WHERE created_at>=?)<?
    RETURNING id`,
  deleteOldSupportRequestEvents: "DELETE FROM support_request_events WHERE created_at<?",
  ...PRODUCT_SIGNAL_SQL,
  ...TRAINING_LOOP_SQL,
  ...COACHING_SQL,
  ...DEVICE_SQL,
  ...DATA_LAYER_SQL,
  ...AI_SQL,
  ...APPLE_BILLING_SQL,
  ...SOCIAL_AUTH_SQL,
  ...SERVER_STATE_SQL,
};

// Installed after the base schema so an existing database can reconcile the
// short window in which older server replicas allowed duplicate active rows.
// The predicate derives from the canonical JSON, so it cannot drift from the
// workout returned to clients.
const RECONCILE_DUPLICATE_ACTIVE_WORKOUTS = `UPDATE workouts AS stale
  SET workout_json=json_set(stale.workout_json,'$.status','completed','$.completedAt',MAX(stale.started_at,stale.updated_at),'$.restEndsAt',NULL),
      summary_json=CASE WHEN json_valid(stale.summary_json) THEN json_set(stale.summary_json,'$.status','completed','$.completedAt',MAX(stale.started_at,stale.updated_at)) ELSE stale.summary_json END,
      revision=stale.revision+1,
      updated_at=MAX(stale.updated_at+1,stale.started_at)
  WHERE CASE WHEN json_valid(stale.workout_json) THEN json_extract(stale.workout_json,'$.status') END='active'
    AND EXISTS (
      SELECT 1 FROM workouts AS newer
      WHERE newer.user_id=stale.user_id
        AND CASE WHEN json_valid(newer.workout_json) THEN json_extract(newer.workout_json,'$.status') END='active'
        AND (newer.updated_at>stale.updated_at
          OR (newer.updated_at=stale.updated_at AND newer.started_at>stale.started_at)
          OR (newer.updated_at=stale.updated_at AND newer.started_at=stale.started_at AND newer.id>stale.id))
    )`;

module.exports = {
  SCHEMA,
  SQL,
  WORKOUT_ACTIVE_INDEX,
  RECONCILE_DUPLICATE_ACTIVE_WORKOUTS,
  PRODUCT_SIGNAL_TABLE,
};
