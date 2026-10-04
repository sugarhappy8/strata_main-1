// @ts-check
"use strict";

// Strata+ bought through Google Play Billing. One row per purchase token, holding Google Play's own answer the last time
// STRATA asked (purchases.subscriptionsv2): its state, expiry, renewal, whether it is a license tester's test purchase,
// and whether STRATA has acknowledged it. checked_at is when that question was asked, so an answer read earlier never
// replaces one read later.
const GOOGLE_PLAY_SUBSCRIPTION_COLUMNS =
  "purchase_token,user_id,product_id,base_plan_id,state,test_purchase,linked_purchase_token,latest_order_id,started_at,expires_at,auto_renew,acknowledged,checked_at,created_at,updated_at";

const GOOGLE_PLAY_BILLING_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS google_play_subscriptions (
    purchase_token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('PENDING','ACTIVE','PAUSED','IN_GRACE_PERIOD','ON_HOLD','CANCELED','EXPIRED','PENDING_PURCHASE_CANCELED')),
    test_purchase INTEGER NOT NULL CHECK(test_purchase IN (0,1)),
    linked_purchase_token TEXT,
    latest_order_id TEXT,
    started_at INTEGER,
    expires_at INTEGER,
    auto_renew INTEGER CHECK(auto_renew IS NULL OR auto_renew IN (0,1)),
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
    checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS google_play_subscriptions_user_id ON google_play_subscriptions(user_id)",
  "CREATE INDEX IF NOT EXISTS google_play_subscriptions_checked_at ON google_play_subscriptions(checked_at)",
]);

// Kept equal to RENEWAL_MARGIN_MS in src/google-play-billing.js (a test holds them together).
const RENEWAL_MARGIN_MS = 2 * 60 * 60 * 1000;

/**
 * Strata+ access from Google Play: active, in its grace period, or canceled, and paid through a future expiry (or, while
 * active and renewing, a renewal STRATA has not heard of yet).
 * @param {string} alias
 * @param {string} [now]
 */
function activeGooglePlaySubscription(
  alias = "google_play_subscriptions",
  now = "(SELECT now FROM entitlement_clock)",
) {
  return `${alias}.state IN ('ACTIVE','IN_GRACE_PERIOD','CANCELED') AND (${alias}.expires_at>${now} OR (${alias}.state='ACTIVE' AND ${alias}.auto_renew=1 AND ${alias}.expires_at+${RENEWAL_MARGIN_MS}>${now}))`;
}

const GOOGLE_PLAY_BILLING_SQL = Object.freeze({
  googlePlaySubscription: `SELECT ${GOOGLE_PLAY_SUBSCRIPTION_COLUMNS} FROM google_play_subscriptions WHERE purchase_token=?`,
  googlePlaySubscriptionsForUser: `SELECT ${GOOGLE_PLAY_SUBSCRIPTION_COLUMNS} FROM google_play_subscriptions WHERE user_id=? ORDER BY updated_at DESC,purchase_token`,
  // Inserts only for an existing account. An update keeps the owner unless the caller names the inactive previous owner it
  // may replace, never replaces an answer read later (checked_at), and never forgets an acknowledgement.
  upsertGooglePlaySubscription: `INSERT INTO google_play_subscriptions(${GOOGLE_PLAY_SUBSCRIPTION_COLUMNS})
  SELECT ?,u.id,?,?,?,?,?,?,?,?,?,?,?,?,?
  FROM users u
  WHERE u.id=?
  ON CONFLICT(purchase_token) DO UPDATE
  SET user_id=excluded.user_id,product_id=excluded.product_id,base_plan_id=excluded.base_plan_id,
    state=excluded.state,test_purchase=excluded.test_purchase,linked_purchase_token=excluded.linked_purchase_token,
    latest_order_id=excluded.latest_order_id,started_at=excluded.started_at,expires_at=excluded.expires_at,
    auto_renew=excluded.auto_renew,acknowledged=MAX(google_play_subscriptions.acknowledged,excluded.acknowledged),
    checked_at=excluded.checked_at,updated_at=excluded.updated_at
  WHERE (google_play_subscriptions.user_id=excluded.user_id OR google_play_subscriptions.user_id=?)
    AND excluded.checked_at>=google_play_subscriptions.checked_at
  RETURNING ${GOOGLE_PLAY_SUBSCRIPTION_COLUMNS}`,
  // A test purchase unlocks Strata+ only where test purchases are allowed (outside production) or for a listed account
  // whose email is verified.
  hasActiveGooglePlaySubscription: `SELECT 1 AS active
  FROM google_play_subscriptions g
  JOIN users u ON u.id=g.user_id
  WHERE g.user_id=? AND ${activeGooglePlaySubscription("g", "?")}
    AND (g.test_purchase=0 OR ?=1
      OR (u.email_verified_at IS NOT NULL AND lower(u.email) IN (SELECT value FROM json_each(?))))
  LIMIT 1`,
  // Open subscriptions to ask Google about again: near or past their expiry (or with none yet), not acknowledged, or not
  // checked since the given time. Oldest answers first.
  googlePlaySubscriptionsDue: `SELECT ${GOOGLE_PLAY_SUBSCRIPTION_COLUMNS} FROM google_play_subscriptions
  WHERE state NOT IN ('EXPIRED','PENDING_PURCHASE_CANCELED')
    AND (expires_at IS NULL OR expires_at<=? OR checked_at<=?
      OR (acknowledged=0 AND state IN ('ACTIVE','IN_GRACE_PERIOD','CANCELED')))
  ORDER BY checked_at,purchase_token
  LIMIT ?`,
  markGooglePlayAcknowledged:
    "UPDATE google_play_subscriptions SET acknowledged=1,updated_at=MAX(updated_at,?) WHERE purchase_token=?",
  deleteGooglePlaySubscriptionsForDeletedUser:
    "DELETE FROM google_play_subscriptions WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM users WHERE id=?)",
});

module.exports = {
  GOOGLE_PLAY_BILLING_SCHEMA,
  GOOGLE_PLAY_BILLING_SQL,
  RENEWAL_MARGIN_MS,
  activeGooglePlaySubscription,
};
