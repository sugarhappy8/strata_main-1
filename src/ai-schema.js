// @ts-check
"use strict";

// Strata AI storage: each member's consent and Daily Brief choice, and per-day request and token counts.
// The "global" scope is the whole organization's use of the provider, which the quota manager budgets.
const AI_SCHEMA=Object.freeze([
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
  )`
]);

const AI_SQL=Object.freeze({
  aiSettings:"SELECT consent_at,consent_version,daily_brief,updated_at FROM ai_settings WHERE user_id=?",
  upsertAiSettings:"INSERT INTO ai_settings(user_id,consent_at,consent_version,daily_brief,updated_at) SELECT id,?,?,?,? FROM users WHERE id=? AND suspended_at IS NULL ON CONFLICT(user_id) DO UPDATE SET consent_at=excluded.consent_at,consent_version=excluded.consent_version,daily_brief=excluded.daily_brief,updated_at=excluded.updated_at RETURNING consent_at,consent_version,daily_brief,updated_at",
  briefCandidates:"SELECT s.user_id,p.profile_json FROM ai_settings s JOIN users u ON u.id=s.user_id AND u.suspended_at IS NULL LEFT JOIN coaching_profiles p ON p.user_id=s.user_id WHERE s.consent_at IS NOT NULL AND s.daily_brief=1 ORDER BY s.user_id LIMIT ? OFFSET ?",
  aiUsage:"SELECT kind,requests,tokens FROM ai_usage_days WHERE usage_date=? AND scope=?",
  addAiUsage:"INSERT INTO ai_usage_days(usage_date,scope,kind,requests,tokens) VALUES(?,?,?,?,?) ON CONFLICT(usage_date,scope,kind) DO UPDATE SET requests=ai_usage_days.requests+excluded.requests,tokens=ai_usage_days.tokens+excluded.tokens",
  refundAiUsage:"UPDATE ai_usage_days SET requests=MAX(0,requests-1) WHERE usage_date=? AND scope=? AND kind=?",
  aiUsageTotals:"SELECT kind,SUM(requests) AS requests,SUM(tokens) AS tokens FROM ai_usage_days WHERE usage_date=? AND scope='global' GROUP BY kind ORDER BY kind",
  aiUsageTop:"SELECT a.scope AS user_id,u.email,SUM(a.requests) AS requests,SUM(a.tokens) AS tokens FROM ai_usage_days a LEFT JOIN users u ON u.id=a.scope WHERE a.usage_date=? AND a.scope<>'global' GROUP BY a.scope,u.email ORDER BY tokens DESC,requests DESC,a.scope LIMIT ?",
  deleteOldAiUsage:"DELETE FROM ai_usage_days WHERE usage_date<?",
  deleteAiSettingsForDeletedUser:"DELETE FROM ai_settings WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
  deleteAiUsageForDeletedUser:"DELETE FROM ai_usage_days WHERE scope=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)"
});

module.exports={AI_SCHEMA,AI_SQL};
