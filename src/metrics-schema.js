// @ts-check
"use strict";

// Investor metrics read existing account-scoped records. The one new fact is when an account first saved a full
// week, written by migration 013; the migration's own ledger time is when STRATA began recording it.
const ACTIVATION_MIGRATION_ID = "013-account-milestones";
const ACCOUNT_MILESTONES_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS account_milestones (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    first_full_week_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS account_milestones_on_user_delete
    BEFORE DELETE ON users
    BEGIN
      DELETE FROM account_milestones WHERE user_id=OLD.id;
    END`,
]);

const DAY = "86400000";
const METRICS_SQL = Object.freeze({
  // Keeps the earliest time, so a retried or out-of-order reaction can never move the milestone later.
  recordFullWeek: `INSERT INTO account_milestones(user_id,first_full_week_at)
    SELECT id,? FROM users WHERE id=?
    ON CONFLICT(user_id) DO UPDATE SET first_full_week_at=MIN(first_full_week_at,excluded.first_full_week_at)`,
  accountMilestone: "SELECT first_full_week_at FROM account_milestones WHERE user_id=?",
  // An account created with Google has its identity linked at the moment it was created.
  metricsAccounts: `SELECT u.id,u.created_at,m.first_full_week_at,
      CASE WHEN EXISTS(SELECT 1 FROM account_identities i WHERE i.user_id=u.id AND i.linked_at<=u.created_at)
        THEN 'google' ELSE 'email' END AS method,
      CASE WHEN lower(u.email) IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END AS internal
    FROM users u
    LEFT JOIN account_milestones m ON m.user_id=u.id`,
  // One row per account and UTC day with anything saved or logged. plus=1 marks a Strata+ feature.
  metricsActiveDays: `SELECT user_id,day,MAX(plus) AS plus FROM (
      SELECT user_id,CAST(started_at/${DAY} AS INTEGER) AS day,1 AS plus FROM workouts WHERE started_at>=?
      UNION ALL
      SELECT user_id,CAST(created_at/${DAY} AS INTEGER),0 FROM plan_changes WHERE created_at>=?
      UNION ALL
      SELECT user_id,CAST(updated_at/${DAY} AS INTEGER),1 FROM coaching_daily_logs WHERE updated_at>=?
      UNION ALL
      SELECT user_id,CAST(created_at/${DAY} AS INTEGER),1 FROM workout_check_ins WHERE created_at>=?
      UNION ALL
      SELECT scope,CAST(julianday(usage_date)-2440587.5 AS INTEGER),1 FROM ai_usage_days
      WHERE kind='chat' AND requests>0 AND scope<>'global' AND usage_date>=?
    )
    GROUP BY user_id,day`,
  metricsPaddleSubscriptions: `SELECT user_id,status,price_id,created_at,
      COALESCE(event_occurred_at,updated_at) AS changed_at
    FROM paddle_subscriptions`,
  // App Store Sandbox purchases are tests, never revenue.
  metricsAppleSubscriptions: `SELECT user_id,COALESCE(original_purchased_at,purchased_at,created_at) AS started_at,
      MAX(COALESCE(expires_at,0),COALESCE(grace_period_expires_at,0)) AS ends_at,revoked_at
    FROM apple_subscriptions
    WHERE environment='Production'`,
  metricsLifetimePurchases: `SELECT DISTINCT user_id FROM paddle_purchases
    WHERE subscription_id IS NULL AND paddle_status='completed' AND completed_at IS NOT NULL
      AND access_revoked_at IS NULL AND user_id IS NOT NULL`,
  metricsAiUsage: `SELECT scope AS user_id,substr(usage_date,1,7) AS month,SUM(requests) AS requests,
      SUM(tokens) AS tokens
    FROM ai_usage_days
    WHERE scope<>'global' AND usage_date>=?
    GROUP BY scope,month`,
  metricsActivationSince: "SELECT applied_at FROM schema_migrations WHERE migration_id=?",
});

module.exports = { ACCOUNT_MILESTONES_SCHEMA, ACTIVATION_MIGRATION_ID, METRICS_SQL };
