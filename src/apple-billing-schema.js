// @ts-check
"use strict";

// Strata+ bought through Apple In-App Purchase. One row per App Store subscription (originalTransactionId), holding the
// latest state the App Store signed. last_signed_at is the signedDate of the data last applied, so a delayed or replayed
// notification can never move a subscription backwards. Processed notification UUIDs make deliveries idempotent.
const APPLE_SUBSCRIPTION_COLUMNS="original_transaction_id,user_id,product_id,environment,latest_transaction_id,purchased_at,original_purchased_at,expires_at,revoked_at,revocation_reason,auto_renew,grace_period_expires_at,last_signed_at,created_at,updated_at";

const APPLE_BILLING_SCHEMA=Object.freeze([
  `CREATE TABLE IF NOT EXISTS apple_subscriptions (
    original_transaction_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('Production','Sandbox')),
    latest_transaction_id TEXT NOT NULL,
    purchased_at INTEGER,
    original_purchased_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    revocation_reason TEXT,
    auto_renew INTEGER CHECK(auto_renew IS NULL OR auto_renew IN (0,1)),
    grace_period_expires_at INTEGER,
    last_signed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS apple_subscriptions_user_id ON apple_subscriptions(user_id)",
  `CREATE TABLE IF NOT EXISTS apple_notifications (
    notification_uuid TEXT PRIMARY KEY,
    notification_type TEXT NOT NULL,
    subtype TEXT,
    outcome TEXT NOT NULL,
    signed_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS apple_notifications_processed_at ON apple_notifications(processed_at)"
]);

/** Strata+ access from Apple: not revoked, and paid through a future expiry or a billing grace period. @param {string} alias @param {string} [now] */
function activeAppleSubscription(alias="apple_subscriptions",now="(SELECT now FROM entitlement_clock)"){
  return `${alias}.revoked_at IS NULL AND (${alias}.expires_at>${now} OR ${alias}.grace_period_expires_at>${now})`;
}

const APPLE_BILLING_SQL=Object.freeze({
  appleSubscription:`SELECT ${APPLE_SUBSCRIPTION_COLUMNS} FROM apple_subscriptions WHERE original_transaction_id=?`,
  appleSubscriptionsForUser:`SELECT ${APPLE_SUBSCRIPTION_COLUMNS} FROM apple_subscriptions WHERE user_id=? ORDER BY updated_at DESC,original_transaction_id`,
  // Inserts only for an existing account. An update never moves state backwards (last_signed_at) and keeps the owner,
  // unless the caller names the inactive previous owner it is allowed to replace.
  upsertAppleSubscription:`INSERT INTO apple_subscriptions(${APPLE_SUBSCRIPTION_COLUMNS}) SELECT ?,u.id,?,?,?,?,?,?,?,?,?,?,?,?,? FROM users u WHERE u.id=? ON CONFLICT(original_transaction_id) DO UPDATE SET user_id=excluded.user_id,product_id=excluded.product_id,environment=excluded.environment,latest_transaction_id=excluded.latest_transaction_id,purchased_at=excluded.purchased_at,original_purchased_at=excluded.original_purchased_at,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,revocation_reason=excluded.revocation_reason,auto_renew=excluded.auto_renew,grace_period_expires_at=excluded.grace_period_expires_at,last_signed_at=excluded.last_signed_at,updated_at=excluded.updated_at WHERE excluded.last_signed_at>=apple_subscriptions.last_signed_at AND (apple_subscriptions.user_id=excluded.user_id OR apple_subscriptions.user_id=?) RETURNING ${APPLE_SUBSCRIPTION_COLUMNS}`,
  hasActiveAppleSubscription:`SELECT 1 AS active FROM apple_subscriptions WHERE user_id=? AND ${activeAppleSubscription("apple_subscriptions","?")} LIMIT 1`,
  appleNotification:"SELECT notification_uuid,notification_type,subtype,outcome,signed_at,processed_at FROM apple_notifications WHERE notification_uuid=?",
  recordAppleNotification:"INSERT INTO apple_notifications(notification_uuid,notification_type,subtype,outcome,signed_at,processed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(notification_uuid) DO NOTHING RETURNING notification_uuid",
  deleteOldAppleNotifications:"DELETE FROM apple_notifications WHERE processed_at<?",
  deleteAppleSubscriptionsForDeletedUser:"DELETE FROM apple_subscriptions WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)"
});

module.exports={APPLE_BILLING_SCHEMA,APPLE_BILLING_SQL,APPLE_SUBSCRIPTION_COLUMNS,activeAppleSubscription};
