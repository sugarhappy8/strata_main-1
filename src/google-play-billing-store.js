// @ts-check
"use strict";

const { GOOGLE_PLAY_BILLING_SQL } = require("./google-play-billing-schema");

/** @param {boolean|null} value */
const flag = (value) => (value === null ? null : value ? 1 : 0);

/** @param {import("./domain-types").GooglePlaySubscriptionWrite} record @param {string|null} replaceOwnerId */
function upsertArgs(record, replaceOwnerId) {
  return [
    record.purchaseToken,
    record.productId,
    record.basePlanId,
    record.state,
    record.testPurchase ? 1 : 0,
    record.linkedPurchaseToken,
    record.latestOrderId,
    record.startedAt,
    record.expiresAt,
    flag(record.autoRenew),
    record.acknowledged ? 1 : 0,
    record.checkedAt,
    record.createdAt,
    record.updatedAt,
    record.userId,
    replaceOwnerId,
  ];
}
/** @param {string} userId @param {number} now @param {import("./domain-types").GooglePlayTestPolicy|undefined} policy */
function accessArgs(userId, now, policy) {
  return [
    userId,
    now,
    now,
    policy?.allowTestPurchases ? 1 : 0,
    JSON.stringify(policy ? [...policy.testAccounts] : []),
  ];
}

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").GooglePlayBillingStore} */
function createLocalGooglePlayBillingMethods({ statements, plainRow }) {
  /** @param {string} name */
  const statement = (name) => {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing Google Play billing statement: ${name}`);
    return prepared;
  };
  return {
    async googlePlaySubscription(purchaseToken) {
      return plainRow(statement("googlePlaySubscription").get(purchaseToken));
    },
    async googlePlaySubscriptionsForUser(userId) {
      return statement("googlePlaySubscriptionsForUser")
        .all(userId)
        .map((row) => plainRow(row));
    },
    async upsertGooglePlaySubscription(record, replaceOwnerId = null) {
      return plainRow(
        statement("upsertGooglePlaySubscription").get(...upsertArgs(record, replaceOwnerId)),
      );
    },
    async hasActiveGooglePlaySubscription(userId, now, policy) {
      return Boolean(
        statement("hasActiveGooglePlaySubscription").get(...accessArgs(userId, now, policy)),
      );
    },
    async googlePlaySubscriptionsDue(expiringBefore, checkedBefore, limit) {
      return statement("googlePlaySubscriptionsDue")
        .all(expiringBefore, checkedBefore, limit)
        .map((row) => plainRow(row));
    },
    async markGooglePlayAcknowledged(purchaseToken, at) {
      statement("markGooglePlayAcknowledged").run(at, purchaseToken);
    },
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").GooglePlayBillingStore} */
function createTursoGooglePlayBillingMethods({ first, all, run }) {
  return {
    googlePlaySubscription: (purchaseToken) =>
      first(GOOGLE_PLAY_BILLING_SQL.googlePlaySubscription, [purchaseToken]),
    googlePlaySubscriptionsForUser: (userId) =>
      all(GOOGLE_PLAY_BILLING_SQL.googlePlaySubscriptionsForUser, [userId]),
    upsertGooglePlaySubscription: (record, replaceOwnerId = null) =>
      first(
        GOOGLE_PLAY_BILLING_SQL.upsertGooglePlaySubscription,
        upsertArgs(record, replaceOwnerId),
      ),
    async hasActiveGooglePlaySubscription(userId, now, policy) {
      return Boolean(
        await first(
          GOOGLE_PLAY_BILLING_SQL.hasActiveGooglePlaySubscription,
          accessArgs(userId, now, policy),
        ),
      );
    },
    googlePlaySubscriptionsDue: (expiringBefore, checkedBefore, limit) =>
      all(GOOGLE_PLAY_BILLING_SQL.googlePlaySubscriptionsDue, [
        expiringBefore,
        checkedBefore,
        limit,
      ]),
    async markGooglePlayAcknowledged(purchaseToken, at) {
      await run(GOOGLE_PLAY_BILLING_SQL.markGooglePlayAcknowledged, [at, purchaseToken]);
    },
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalGooglePlayData(statements, userId) {
  const statement = statements.deleteGooglePlaySubscriptionsForDeletedUser;
  if (!statement) throw new Error("Missing Google Play billing deletion statement.");
  statement.run(userId, userId);
}

/** @param {string} userId */
function googlePlayDeletionBatch(userId) {
  return [
    {
      sql: GOOGLE_PLAY_BILLING_SQL.deleteGooglePlaySubscriptionsForDeletedUser,
      args: [userId, userId],
    },
  ];
}

module.exports = {
  createLocalGooglePlayBillingMethods,
  createTursoGooglePlayBillingMethods,
  deleteLocalGooglePlayData,
  googlePlayDeletionBatch,
};
