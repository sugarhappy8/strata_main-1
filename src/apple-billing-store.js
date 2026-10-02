// @ts-check
"use strict";

const {APPLE_BILLING_SQL}=require("./apple-billing-schema");

/** @param {import("./domain-types").AppleSubscriptionWrite} record @param {string|null} replaceOwnerId */
function upsertArgs(record,replaceOwnerId){
  return [
    record.originalTransactionId,record.productId,record.environment,record.latestTransactionId,
    record.purchasedAt,record.originalPurchasedAt,record.expiresAt,record.revokedAt,record.revocationReason,
    record.autoRenew===null?null:record.autoRenew?1:0,record.gracePeriodExpiresAt,record.lastSignedAt,
    record.latestSignedAt,record.createdAt,record.updatedAt,record.userId,replaceOwnerId
  ];
}
/** @param {string} userId @param {number} now @param {import("./domain-types").AppleSandboxPolicy|undefined} sandbox */
function accessArgs(userId,now,sandbox){
  return [userId,now,now,sandbox?.allowSandbox?1:0,JSON.stringify(sandbox?[...sandbox.sandboxAccounts]:[])];
}
/** @param {import("./domain-types").AppleNotificationWrite} notification */
function notificationArgs(notification){
  return [notification.notificationUuid,notification.notificationType,notification.subtype,notification.outcome,notification.signedAt,notification.processedAt];
}

/** @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies @returns {import("./domain-types").AppleBillingStore} */
function createLocalAppleBillingMethods({statements,plainRow}){
  /** @param {string} name */
  const statement=(name)=>{const prepared=statements[name];if(!prepared)throw new Error(`Missing Apple billing statement: ${name}`);return prepared;};
  return {
    async appleSubscription(originalTransactionId){return plainRow(statement("appleSubscription").get(originalTransactionId));},
    async appleSubscriptionsForUser(userId){return statement("appleSubscriptionsForUser").all(userId).map((row)=>plainRow(row));},
    async upsertAppleSubscription(record,replaceOwnerId=null){return plainRow(statement("upsertAppleSubscription").get(...upsertArgs(record,replaceOwnerId)));},
    async hasActiveAppleSubscription(userId,now,sandbox){return Boolean(statement("hasActiveAppleSubscription").get(...accessArgs(userId,now,sandbox)));},
    async appleNotification(notificationUuid){return plainRow(statement("appleNotification").get(notificationUuid));},
    async recordAppleNotification(notification){return Boolean(plainRow(statement("recordAppleNotification").get(...notificationArgs(notification))));},
    async deleteOldAppleNotifications(before){statement("deleteOldAppleNotifications").run(before);}
  };
}

/** @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies @returns {import("./domain-types").AppleBillingStore} */
function createTursoAppleBillingMethods({first,all,run}){
  return {
    appleSubscription:(originalTransactionId)=>first(APPLE_BILLING_SQL.appleSubscription,[originalTransactionId]),
    appleSubscriptionsForUser:(userId)=>all(APPLE_BILLING_SQL.appleSubscriptionsForUser,[userId]),
    upsertAppleSubscription:(record,replaceOwnerId=null)=>first(APPLE_BILLING_SQL.upsertAppleSubscription,upsertArgs(record,replaceOwnerId)),
    async hasActiveAppleSubscription(userId,now,sandbox){return Boolean(await first(APPLE_BILLING_SQL.hasActiveAppleSubscription,accessArgs(userId,now,sandbox)));},
    appleNotification:(notificationUuid)=>first(APPLE_BILLING_SQL.appleNotification,[notificationUuid]),
    async recordAppleNotification(notification){return Boolean(await first(APPLE_BILLING_SQL.recordAppleNotification,notificationArgs(notification)));},
    async deleteOldAppleNotifications(before){await run(APPLE_BILLING_SQL.deleteOldAppleNotifications,[before]);}
  };
}

/** @param {Record<string,import("./domain-types").PreparedStatementLike>} statements @param {string} userId */
function deleteLocalAppleData(statements,userId){
  const statement=statements.deleteAppleSubscriptionsForDeletedUser;
  if(!statement)throw new Error("Missing Apple billing deletion statement.");
  statement.run(userId,userId);
}

/** @param {string} userId */
function appleDeletionBatch(userId){return [{sql:APPLE_BILLING_SQL.deleteAppleSubscriptionsForDeletedUser,args:[userId,userId]}];}

module.exports={appleDeletionBatch,createLocalAppleBillingMethods,createTursoAppleBillingMethods,deleteLocalAppleData};
