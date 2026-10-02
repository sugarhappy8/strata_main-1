// @ts-check
"use strict";

// Strata AI storage: each member's consent and Daily Brief choice, per-day request and token counts, and the request
// queue. The "global" scope is the whole organization's use of the provider, which the quota manager budgets. A queued
// request keeps the member's message only until it finishes; its answer is kept for ten minutes for the page to read.
const AI_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ai_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    consent_at INTEGER,
    consent_version INTEGER NOT NULL DEFAULT 1 CHECK(consent_version >= 1),
    daily_brief INTEGER NOT NULL DEFAULT 1 CHECK(daily_brief IN (0,1)),
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_usage_days (
    usage_date TEXT NOT NULL,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('chat','brief')),
    requests INTEGER NOT NULL DEFAULT 0 CHECK(requests >= 0),
    tokens INTEGER NOT NULL DEFAULT 0 CHECK(tokens >= 0),
    PRIMARY KEY(usage_date,scope,kind)
  )`,
  `CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('chat','suggestions')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
    request_json TEXT,
    usage_date TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_json TEXT,
    created_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER
  )`,
  // One unfinished request per member, enforced by the database rather than by one server's memory.
  "CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_one_active ON ai_jobs(user_id) WHERE status IN ('queued','running')",
  "CREATE INDEX IF NOT EXISTS ai_jobs_queue ON ai_jobs(status,created_at)",
  "DROP TRIGGER IF EXISTS ai_jobs_on_user_delete",
  `CREATE TRIGGER ai_jobs_on_user_delete
    BEFORE DELETE ON users
    BEGIN
      DELETE FROM ai_jobs WHERE user_id=OLD.id;
    END`,
]);

const AI_JOB =
  "id,user_id,kind,status,request_json,usage_date,tokens,result_json,error_json,created_at,finished_at";

const AI_SQL = Object.freeze({
  aiSettings:
    "SELECT consent_at,consent_version,daily_brief,updated_at FROM ai_settings WHERE user_id=?",
  upsertAiSettings:
    "INSERT INTO ai_settings(user_id,consent_at,consent_version,daily_brief,updated_at) SELECT id,?,?,?,? FROM users WHERE id=? AND suspended_at IS NULL ON CONFLICT(user_id) DO UPDATE SET consent_at=excluded.consent_at,consent_version=excluded.consent_version,daily_brief=excluded.daily_brief,updated_at=excluded.updated_at RETURNING consent_at,consent_version,daily_brief,updated_at",
  briefCandidates:
    "SELECT s.user_id,p.profile_json FROM ai_settings s JOIN users u ON u.id=s.user_id AND u.suspended_at IS NULL LEFT JOIN coaching_profiles p ON p.user_id=s.user_id WHERE s.consent_at IS NOT NULL AND s.daily_brief=1 ORDER BY s.user_id LIMIT ? OFFSET ?",
  aiUsage: "SELECT kind,requests,tokens FROM ai_usage_days WHERE usage_date=? AND scope=?",
  addAiUsage:
    "INSERT INTO ai_usage_days(usage_date,scope,kind,requests,tokens) VALUES(?,?,?,?,?) ON CONFLICT(usage_date,scope,kind) DO UPDATE SET requests=ai_usage_days.requests+excluded.requests,tokens=ai_usage_days.tokens+excluded.tokens",
  refundAiUsage:
    "UPDATE ai_usage_days SET requests=MAX(0,requests-1) WHERE usage_date=? AND scope=? AND kind=?",
  // Claims are one conditional statement each, so concurrent requests can never pass a limit: no row back means spent.
  claimMemberAiRequest:
    "INSERT INTO ai_usage_days(usage_date,scope,kind,requests,tokens) SELECT ?,?,?,1,0 WHERE ?>0 ON CONFLICT(usage_date,scope,kind) DO UPDATE SET requests=ai_usage_days.requests+1 WHERE ai_usage_days.requests<? RETURNING requests",
  claimGlobalAiRequest:
    "INSERT INTO ai_usage_days(usage_date,scope,kind,requests,tokens) SELECT ?,'global',?,1,0 WHERE (SELECT COALESCE(SUM(requests),0) FROM ai_usage_days WHERE usage_date=? AND scope='global')<? AND (SELECT COALESCE(SUM(requests),0) FROM ai_usage_days WHERE usage_date=? AND scope='global' AND kind=?)<? ON CONFLICT(usage_date,scope,kind) DO UPDATE SET requests=ai_usage_days.requests+1 RETURNING requests",
  aiUsageTotals:
    "SELECT kind,SUM(requests) AS requests,SUM(tokens) AS tokens FROM ai_usage_days WHERE usage_date=? AND scope='global' GROUP BY kind ORDER BY kind",
  aiUsageTop:
    "SELECT a.scope AS user_id,u.email,SUM(a.requests) AS requests,SUM(a.tokens) AS tokens FROM ai_usage_days a LEFT JOIN users u ON u.id=a.scope WHERE a.usage_date=? AND a.scope<>'global' GROUP BY a.scope,u.email ORDER BY tokens DESC,requests DESC,a.scope LIMIT ?",
  deleteOldAiUsage: "DELETE FROM ai_usage_days WHERE usage_date<?",
  insertAiJob: `INSERT INTO ai_jobs(id,user_id,kind,status,request_json,usage_date,created_at) VALUES(?,?,?,'queued',?,?,?) RETURNING ${AI_JOB}`,
  aiJob: `SELECT ${AI_JOB} FROM ai_jobs WHERE id=? AND user_id=?`,
  activeAiJob: `SELECT ${AI_JOB} FROM ai_jobs WHERE user_id=? AND status IN ('queued','running') LIMIT 1`,
  queuedAiJobs: "SELECT COUNT(*) AS count FROM ai_jobs WHERE status='queued'",
  // Position among queued requests, oldest first (1 is next).
  aiJobPosition:
    "SELECT COUNT(*) AS position FROM ai_jobs q, ai_jobs j WHERE j.id=? AND q.status='queued' AND (q.created_at<j.created_at OR (q.created_at=j.created_at AND q.id<=j.id))",
  // Claims the oldest queued request for this server; a lease lets a later start requeue it if this server stops.
  claimAiJob: `UPDATE ai_jobs SET status='running',lease_until=? WHERE id=(SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1) AND status='queued' RETURNING ${AI_JOB}`,
  finishAiJob:
    "UPDATE ai_jobs SET status=?,tokens=?,result_json=?,error_json=?,finished_at=?,request_json=NULL,lease_until=0 WHERE id=? AND status='running'",
  requeueStaleAiJobs:
    "UPDATE ai_jobs SET status='queued',lease_until=0 WHERE status='running' AND lease_until<?",
  deleteFinishedAiJobs: "DELETE FROM ai_jobs WHERE finished_at IS NOT NULL AND finished_at<?",
  deleteAiSettingsForDeletedUser:
    "DELETE FROM ai_settings WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteAiUsageForDeletedUser:
    "DELETE FROM ai_usage_days WHERE scope=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
});

module.exports = { AI_SCHEMA, AI_SQL };
