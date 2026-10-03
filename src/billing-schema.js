"use strict";

const PURCHASE_COLUMNS =
  "transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at";
const SUBSCRIPTION_COLUMNS =
  "subscription_id,user_id,transaction_id,customer_id,status,price_id,product_id,scheduled_change_action,scheduled_change_at,current_period_ends_at,event_occurred_at,created_at,updated_at";

const BILLING_SUBSCRIPTION_TABLE = `CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES paddle_purchases(transaction_id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','trialing','past_due','paused','canceled')),
  price_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  scheduled_change_action TEXT CHECK(scheduled_change_action IS NULL OR scheduled_change_action IN ('cancel','pause','resume')),
  scheduled_change_at INTEGER,
  current_period_ends_at INTEGER,
  event_occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const BILLING_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS paddle_purchases (
    transaction_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    price_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    customer_id TEXT,
    subscription_id TEXT,
    paddle_status TEXT NOT NULL,
    completed_at INTEGER,
    access_revoked_at INTEGER,
    revocation_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS paddle_purchases_user_id ON paddle_purchases(user_id)",
  BILLING_SUBSCRIPTION_TABLE,
  "CREATE INDEX IF NOT EXISTS paddle_subscriptions_user_id ON paddle_subscriptions(user_id)",
  `CREATE TABLE IF NOT EXISTS paddle_checkout_claims (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    price_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    transaction_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS paddle_checkout_claims_claim_id ON paddle_checkout_claims(claim_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS paddle_checkout_claims_transaction_id ON paddle_checkout_claims(transaction_id)",
  `CREATE TABLE IF NOT EXISTS paddle_adjustments (
    adjustment_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES paddle_purchases(transaction_id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    type TEXT,
    status TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS paddle_adjustments_transaction_id ON paddle_adjustments(transaction_id)",
  `CREATE TABLE IF NOT EXISTS paddle_webhook_events (
    event_id TEXT PRIMARY KEY,
    notification_id TEXT,
    event_type TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL
  )`,
];

function activeEntitlement(purchase = "paddle_purchases") {
  return `${purchase}.paddle_status='completed' AND ${purchase}.completed_at IS NOT NULL AND ${purchase}.access_revoked_at IS NULL AND (${purchase}.subscription_id IS NULL OR EXISTS (SELECT 1 FROM paddle_subscriptions s WHERE s.subscription_id=${purchase}.subscription_id AND s.transaction_id=${purchase}.transaction_id AND s.user_id=${purchase}.user_id AND s.price_id=${purchase}.price_id AND s.product_id=${purchase}.product_id AND s.status IN ('active','trialing','past_due') AND s.current_period_ends_at>(SELECT now FROM entitlement_clock) AND (s.scheduled_change_action IS NULL OR s.scheduled_change_action='resume' OR s.scheduled_change_at>(SELECT now FROM entitlement_clock))))`;
}
/** @param {string} sql */
function withEntitlementClock(sql) {
  return `WITH entitlement_clock(now) AS (VALUES(?)) ${sql}`;
}
/** @param {string} status */
function subscriptionStateRank(status) {
  return `CASE ${status} WHEN 'canceled' THEN 4 WHEN 'paused' THEN 3 WHEN 'past_due' THEN 2 WHEN 'trialing' THEN 1 ELSE 0 END`;
}
const ACTIVE_ENTITLEMENT = activeEntitlement();
// Bound to the two plans' price IDs (monthly, then yearly or the monthly ID again) and the product ID.
const ENTITLED_RECURRING_CATALOG =
  "subscription_id IS NULL OR (price_id IN (?,?) AND product_id=?)";
const BILLING_DELETION_BLOCKER = `((p.completed_at IS NULL AND p.paddle_status<>'canceled' AND p.access_revoked_at IS NULL) OR (p.subscription_id IS NOT NULL AND (NOT EXISTS (SELECT 1 FROM paddle_subscriptions s WHERE s.subscription_id=p.subscription_id) OR EXISTS (SELECT 1 FROM paddle_subscriptions s WHERE s.subscription_id=p.subscription_id AND s.user_id=p.user_id AND s.status IN ('active','trialing','past_due','paused')))))`;

const BILLING_SQL = {
  pendingPurchasesForUser: `SELECT COUNT(*) AS pending_count FROM paddle_purchases p WHERE p.user_id=? AND ${BILLING_DELETION_BLOCKER}`,
  unsettledPurchasesForUser: `SELECT ${PURCHASE_COLUMNS}
  FROM paddle_purchases
  WHERE user_id=? AND paddle_status<>'canceled' AND completed_at IS NULL
    AND access_revoked_at IS NULL
  ORDER BY created_at`,
  insertPendingPurchase: `INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at)
  SELECT ?,u.id,?,?,NULL,NULL,?,NULL,NULL,NULL,?,?
  FROM users u
  WHERE u.id=? AND u.suspended_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM admin_account_controls ac WHERE ac.user_id=u.id AND ac.checkout_blocked_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1
      FROM account_action_requests a
      WHERE a.user_id=u.id AND a.purpose='account_delete' AND a.delivery_state='sent'
        AND a.consumed_at IS NULL AND a.expires_at>?)
    AND NOT EXISTS (SELECT 1 FROM paddle_purchases p WHERE p.user_id=u.id AND ${BILLING_DELETION_BLOCKER})
  RETURNING ${PURCHASE_COLUMNS}`,
  recordClaimedPurchase: `INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at)
  SELECT c.transaction_id,c.user_id,?,?,NULL,NULL,?,NULL,NULL,NULL,?,?
  FROM paddle_checkout_claims c
  JOIN users u ON u.id=c.user_id
  WHERE c.user_id=? AND c.claim_id=? AND c.transaction_id=? AND c.price_id=?
  ON CONFLICT(transaction_id) DO NOTHING
  RETURNING ${PURCHASE_COLUMNS}`,
  checkoutCreationForUser:
    "SELECT user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at FROM paddle_checkout_claims WHERE user_id=?",
  claimCheckoutCreation: `INSERT INTO paddle_checkout_claims(user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at)
    SELECT u.id,?,?,NULL,?,?,?
    FROM users u
    WHERE u.id=? AND u.suspended_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM admin_account_controls ac WHERE ac.user_id=u.id AND ac.checkout_blocked_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1
        FROM account_action_requests a
        WHERE a.user_id=u.id AND a.purpose='account_delete' AND a.delivery_state='sent'
          AND a.consumed_at IS NULL AND a.expires_at>?)
    ON CONFLICT(user_id) DO UPDATE
    SET price_id=excluded.price_id,claim_id=excluded.claim_id,transaction_id=NULL,
      expires_at=excluded.expires_at,created_at=excluded.created_at,updated_at=excluded.updated_at
    WHERE paddle_checkout_claims.expires_at<=? AND paddle_checkout_claims.transaction_id IS NULL
    RETURNING user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at`,
  recordCheckoutCreationTransaction: `UPDATE paddle_checkout_claims
    SET transaction_id=?,updated_at=MAX(updated_at,?)
    WHERE user_id=? AND claim_id=? AND (transaction_id IS NULL OR transaction_id=?)
    RETURNING user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at`,
  extendCheckoutCreation: `UPDATE paddle_checkout_claims
    SET expires_at=MAX(expires_at,?),updated_at=MAX(updated_at,?)
    WHERE user_id=? AND claim_id=?
    RETURNING user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at`,
  releaseCheckoutCreation:
    "DELETE FROM paddle_checkout_claims WHERE user_id=? AND claim_id=? AND transaction_id IS ? RETURNING claim_id",
  purchaseByTransaction: `SELECT ${PURCHASE_COLUMNS} FROM paddle_purchases WHERE transaction_id=?`,
  pendingPurchaseForUser: `SELECT ${PURCHASE_COLUMNS}
  FROM paddle_purchases
  WHERE user_id=? AND price_id=? AND paddle_status IN ('draft','ready') AND completed_at IS NULL
    AND access_revoked_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1`,
  completePurchase: `UPDATE paddle_purchases
    SET customer_id=COALESCE(customer_id,?),subscription_id=COALESCE(subscription_id,?),
      paddle_status='completed',completed_at=COALESCE(completed_at,?),updated_at=MAX(updated_at,?)
    WHERE transaction_id=? AND (subscription_id IS NULL OR subscription_id=?)
      AND (customer_id IS NULL OR customer_id=?)`,
  updatePurchaseStatus:
    "UPDATE paddle_purchases SET paddle_status=?,updated_at=? WHERE transaction_id=? AND paddle_status<>'completed' AND updated_at<=?",
  bindPurchaseSubscription: `UPDATE paddle_purchases
  SET customer_id=COALESCE(customer_id,?),subscription_id=COALESCE(subscription_id,?),
    updated_at=MAX(updated_at,?)
  WHERE transaction_id=? AND user_id=? AND (subscription_id IS NULL OR subscription_id=?)
    AND (customer_id IS NULL OR customer_id=?)
    AND NOT EXISTS (SELECT 1
      FROM paddle_subscriptions s
      WHERE s.subscription_id=? AND (s.user_id<>? OR s.transaction_id<>? OR s.customer_id<>?))
  RETURNING ${PURCHASE_COLUMNS}`,
  createPaddleSubscription: `INSERT INTO paddle_subscriptions(${SUBSCRIPTION_COLUMNS})
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
  FROM paddle_purchases p
  WHERE p.transaction_id=? AND p.user_id=? AND p.subscription_id=?
  ON CONFLICT(subscription_id) DO UPDATE
  SET customer_id=excluded.customer_id,status=excluded.status,price_id=excluded.price_id,
    product_id=excluded.product_id,scheduled_change_action=excluded.scheduled_change_action,
    scheduled_change_at=excluded.scheduled_change_at,
    current_period_ends_at=excluded.current_period_ends_at,
    event_occurred_at=excluded.event_occurred_at,updated_at=excluded.updated_at
  WHERE paddle_subscriptions.user_id=excluded.user_id
    AND paddle_subscriptions.transaction_id=excluded.transaction_id
    AND (excluded.event_occurred_at>paddle_subscriptions.event_occurred_at
        OR (excluded.event_occurred_at=paddle_subscriptions.event_occurred_at
            AND ${subscriptionStateRank("excluded.status")}>${subscriptionStateRank("paddle_subscriptions.status")}))
  RETURNING ${SUBSCRIPTION_COLUMNS}`,
  updatePaddleSubscription: `UPDATE paddle_subscriptions
  SET customer_id=?,status=?,price_id=?,product_id=?,scheduled_change_action=?,scheduled_change_at=?,
    current_period_ends_at=?,event_occurred_at=?,updated_at=?
  WHERE subscription_id=? AND user_id=?
    AND (event_occurred_at<? OR (event_occurred_at=? AND ${subscriptionStateRank("?")}>${subscriptionStateRank("status")}))
  RETURNING ${SUBSCRIPTION_COLUMNS}`,
  subscriptionById: `SELECT ${SUBSCRIPTION_COLUMNS} FROM paddle_subscriptions WHERE subscription_id=?`,
  subscriptionForUser: `SELECT ${SUBSCRIPTION_COLUMNS}
  FROM paddle_subscriptions
  WHERE user_id=?
  ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'trialing' THEN 1 WHEN 'past_due' THEN 2 ELSE 3 END,
    updated_at DESC
  LIMIT 1`,
  upsertAdjustment: `INSERT INTO paddle_adjustments(adjustment_id,transaction_id,action,type,status,occurred_at,updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(adjustment_id) DO UPDATE
    SET action=excluded.action,type=excluded.type,status=excluded.status,
      occurred_at=excluded.occurred_at,updated_at=excluded.updated_at
    WHERE paddle_adjustments.transaction_id=excluded.transaction_id
      AND excluded.occurred_at>=paddle_adjustments.occurred_at
    RETURNING adjustment_id`,
  revokePurchase: `UPDATE paddle_purchases
    SET access_revoked_at=?,revocation_reason=?,updated_at=MAX(updated_at,?)
    WHERE transaction_id=? AND access_revoked_at IS NULL`,
  hasDiscoveryAccess: withEntitlementClock(
    `SELECT 1 AS active FROM paddle_purchases WHERE user_id=? AND (? IS NULL OR price_id=?) AND ${ACTIVE_ENTITLEMENT} LIMIT 1`,
  ),
  hasCurrentDiscoveryAccess: withEntitlementClock(
    `SELECT 1 AS active
    FROM paddle_purchases
    WHERE user_id=? AND (${ENTITLED_RECURRING_CATALOG})
      AND ${ACTIVE_ENTITLEMENT}
    LIMIT 1`,
  ),
  hasEntitledDiscoveryAccess: withEntitlementClock(
    `SELECT 1 AS active FROM paddle_purchases WHERE user_id=? AND (${ENTITLED_RECURRING_CATALOG}) AND ${ACTIVE_ENTITLEMENT} LIMIT 1`,
  ),
  discoveryAccessSummary: withEntitlementClock(
    `SELECT COUNT(*) AS purchase_count,
      COALESCE(SUM(CASE WHEN ${ACTIVE_ENTITLEMENT} THEN 1 ELSE 0 END),0) AS active_purchase_count,
      COALESCE(SUM(CASE WHEN paddle_status<>'canceled' AND completed_at IS NULL AND access_revoked_at IS NULL THEN 1 ELSE 0 END),0) AS pending_purchase_count,
      MAX(CASE WHEN ${ACTIVE_ENTITLEMENT} THEN completed_at ELSE NULL END) AS latest_active_purchase_at,
      MAX(completed_at) AS latest_completed_at,MAX(access_revoked_at) AS latest_revoked_at
    FROM paddle_purchases
    WHERE user_id=? AND (? IS NULL OR price_id=?)`,
  ),
  currentDiscoveryAccessSummary: withEntitlementClock(
    `SELECT COUNT(*) AS purchase_count,
      COALESCE(SUM(CASE WHEN ${ACTIVE_ENTITLEMENT} AND (${ENTITLED_RECURRING_CATALOG}) THEN 1 ELSE 0 END),0) AS active_purchase_count,
      COALESCE(SUM(CASE WHEN paddle_status<>'canceled' AND completed_at IS NULL AND access_revoked_at IS NULL THEN 1 ELSE 0 END),0) AS pending_purchase_count,
      MAX(CASE WHEN ${ACTIVE_ENTITLEMENT} AND (${ENTITLED_RECURRING_CATALOG}) THEN completed_at ELSE NULL END) AS latest_active_purchase_at,
      MAX(completed_at) AS latest_completed_at,MAX(access_revoked_at) AS latest_revoked_at
    FROM paddle_purchases
    WHERE user_id=?`,
  ),
  entitledDiscoveryAccessSummary: withEntitlementClock(
    `SELECT COUNT(*) AS purchase_count,
      COALESCE(SUM(CASE WHEN ${ACTIVE_ENTITLEMENT} AND (${ENTITLED_RECURRING_CATALOG}) THEN 1 ELSE 0 END),0) AS active_purchase_count,
      COALESCE(SUM(CASE WHEN paddle_status<>'canceled' AND completed_at IS NULL AND access_revoked_at IS NULL THEN 1 ELSE 0 END),0) AS pending_purchase_count,
      MAX(CASE WHEN ${ACTIVE_ENTITLEMENT} AND (${ENTITLED_RECURRING_CATALOG}) THEN completed_at ELSE NULL END) AS latest_active_purchase_at,
      MAX(completed_at) AS latest_completed_at,MAX(access_revoked_at) AS latest_revoked_at
    FROM paddle_purchases
    WHERE user_id=?`,
  ),
  adjustmentById:
    "SELECT adjustment_id,transaction_id,action,type,status,occurred_at,updated_at FROM paddle_adjustments WHERE adjustment_id=?",
  webhookEvent:
    "SELECT event_id,notification_id,event_type,occurred_at,processed_at FROM paddle_webhook_events WHERE event_id=?",
  recordWebhookEvent: `INSERT INTO paddle_webhook_events(event_id,notification_id,event_type,occurred_at,processed_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(event_id) DO NOTHING
    RETURNING event_id`,
};

module.exports = {
  ACTIVE_ENTITLEMENT,
  BILLING_SCHEMA,
  BILLING_SQL,
  BILLING_SUBSCRIPTION_TABLE,
  BILLING_DELETION_BLOCKER,
  activeEntitlement,
  withEntitlementClock,
};
