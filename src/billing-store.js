// @ts-check
"use strict";
const {ACCESS_CONTROLS_SQL}=require("./access-controls-schema");
const {BILLING_SQL}=require("./billing-schema");

/** @param {import("./domain-types").JsonObject|null} row @returns {import("./domain-types").DiscoveryAccessSummary} */
function accessSummary(row){
  const purchaseCount=Number(row?.purchase_count||0);
  const activePurchaseCount=Number(row?.active_purchase_count||0);
  return {
    active:activePurchaseCount>0,
    purchaseCount,activePurchaseCount,
    pendingPurchaseCount:Number(row?.pending_purchase_count||0),
    latestActivePurchaseAt:/** @type {number|null} */(row?.latest_active_purchase_at??null),
    latestCompletedAt:/** @type {number|null} */(row?.latest_completed_at??null),
    latestRevokedAt:/** @type {number|null} */(row?.latest_revoked_at??null)
  };
}

/** @param {import("./domain-types").SubscriptionCreate} subscription */
function subscriptionBindArgs(subscription){
  return [
    subscription.customerId,subscription.subscriptionId,subscription.updatedAt,
    subscription.transactionId,subscription.userId,subscription.subscriptionId,
    subscription.customerId,subscription.subscriptionId,subscription.userId,
    subscription.transactionId,subscription.customerId
  ];
}

/** @param {import("./domain-types").SubscriptionCreate} subscription */
function subscriptionCreateArgs(subscription){
  return [
    subscription.subscriptionId,subscription.userId,subscription.transactionId,
    subscription.customerId,subscription.status,subscription.priceId,subscription.productId,
    subscription.scheduledChangeAction,subscription.scheduledChangeAt,subscription.currentPeriodEndsAt,
    subscription.eventOccurredAt,subscription.createdAt,subscription.updatedAt,
    subscription.transactionId,subscription.userId,subscription.subscriptionId
  ];
}

/** @param {import("./domain-types").SubscriptionWrite} subscription */
function subscriptionUpdateArgs(subscription){
  return [
    subscription.customerId,subscription.status,subscription.priceId,subscription.productId,
    subscription.scheduledChangeAction,subscription.scheduledChangeAt,subscription.currentPeriodEndsAt,
    subscription.eventOccurredAt,subscription.updatedAt,subscription.subscriptionId,
    subscription.userId,subscription.eventOccurredAt,subscription.eventOccurredAt,subscription.status
  ];
}
/** @param {readonly string[]} priceIds */
function serializedPriceIds(priceIds){return JSON.stringify([...new Set(priceIds)]);}
/** @param {import("./domain-types").SubscriptionRow} existing @param {import("./domain-types").PurchaseRow} purchase @param {import("./domain-types").SubscriptionWrite} subscription */
function subscriptionPurchaseCatalogArgs(existing,purchase,subscription){
  return [subscription.priceId,subscription.productId,subscription.updatedAt,purchase.transaction_id,purchase.user_id,existing.subscription_id,purchase.price_id,purchase.product_id,subscription.eventOccurredAt,subscription.eventOccurredAt,subscription.status];
}
/** @param {import("./domain-types").SubscriptionWrite} subscription */
function subscriptionUpdateAfterCatalogArgs(subscription){return [...subscriptionUpdateArgs(subscription),subscription.priceId,subscription.productId];}

/**
 * @param {import("./domain-types").LocalBillingStoreDependencies} dependencies
 * @returns {import("./domain-types").BillingAdapterMethods}
 */
function createLocalBillingMethods({db,statements,plainRow}){
  /** @param {unknown} row @returns {import("./domain-types").PurchaseRow|null} */
  const purchaseRow=(row)=>/** @type {import("./domain-types").PurchaseRow|null} */(plainRow(row));
  /** @param {unknown[]} rows @returns {import("./domain-types").PurchaseRow[]} */
  const purchaseRows=(rows)=>rows.map(purchaseRow).filter((row)=>row!==null);
  /** @param {unknown} row @returns {import("./domain-types").CheckoutClaimRow|null} */
  const checkoutRow=(row)=>/** @type {import("./domain-types").CheckoutClaimRow|null} */(plainRow(row));
  /** @param {unknown} row @returns {import("./domain-types").SubscriptionRow|null} */
  const subscriptionRow=(row)=>/** @type {import("./domain-types").SubscriptionRow|null} */(plainRow(row));
  /** @param {unknown} row @returns {import("./domain-types").DiscoveryTrialRow|null} */
  const trialRow=(row)=>/** @type {import("./domain-types").DiscoveryTrialRow|null} */(plainRow(row));
  /** @type {import("./domain-types").BillingAdapterMethods} */
  const methods={
    async pendingPurchasesForUser(userId){return Number(plainRow(statements.pendingPurchasesForUser.get(userId))?.pending_count||0);},
    async unsettledPurchasesForUser(userId){return purchaseRows(statements.unsettledPurchasesForUser.all(userId));},
    async insertPendingPurchase(purchase){
      return purchaseRow(statements.insertPendingPurchase.get(purchase.transactionId,purchase.priceId,purchase.productId,purchase.paddleStatus||"ready",purchase.createdAt,purchase.updatedAt,purchase.userId,purchase.updatedAt));
    },
    async recordClaimedPurchase(purchase,claimId){return purchaseRow(statements.recordClaimedPurchase.get(purchase.priceId,purchase.productId,purchase.paddleStatus||"ready",purchase.createdAt,purchase.updatedAt,purchase.userId,claimId,purchase.transactionId,purchase.priceId));},
    async replacePendingPurchaseCatalog(purchase,replacement){return purchaseRow(statements.replacePendingPurchaseCatalog.get(replacement.priceId,replacement.productId,replacement.paddleStatus,replacement.updatedAt,purchase.transaction_id,purchase.user_id,purchase.price_id,purchase.product_id,purchase.updated_at,purchase.paddle_status,replacement.paddleStatus,replacement.updatedAt));},
    async completePurchaseCatalogMigration(purchase,replacement){return purchaseRow(statements.completePurchaseCatalogMigration.get(replacement.priceId,replacement.productId,replacement.customerId||null,replacement.subscriptionId||null,replacement.completedAt,replacement.updatedAt,purchase.transaction_id,purchase.user_id,purchase.price_id,purchase.product_id,purchase.paddle_status,purchase.updated_at,replacement.subscriptionId||null,replacement.customerId||null));},
    async checkoutCreationForUser(userId){return checkoutRow(statements.checkoutCreationForUser.get(userId));},
    async claimCheckoutCreation({userId,priceId,claimId,expiresAt,now}){return checkoutRow(statements.claimCheckoutCreation.get(priceId,claimId,expiresAt,now,now,userId,now,now));},
    async recordCheckoutCreationTransaction(userId,claimId,transactionId,updatedAt){return checkoutRow(statements.recordCheckoutCreationTransaction.get(transactionId,updatedAt,userId,claimId,transactionId));},
    async extendCheckoutCreation(userId,claimId,expiresAt,updatedAt){return checkoutRow(statements.extendCheckoutCreation.get(expiresAt,updatedAt,userId,claimId));},
    async releaseCheckoutCreation(userId,claimId,expectedTransactionId=null){return Boolean(plainRow(statements.releaseCheckoutCreation.get(userId,claimId,expectedTransactionId)));},
    async purchaseByTransaction(transactionId){return purchaseRow(statements.purchaseByTransaction.get(transactionId));},
    async pendingPurchaseForUser(userId,priceId){return purchaseRow(statements.pendingPurchaseForUser.get(userId,priceId));},
    async completePurchase(transactionId,completion){
      statements.completePurchase.run(completion.customerId||null,completion.subscriptionId||null,completion.completedAt,completion.updatedAt,transactionId,completion.subscriptionId||null,completion.customerId||null);
      const stored=purchaseRow(statements.purchaseByTransaction.get(transactionId));
      return stored&&(!completion.customerId||stored.customer_id===completion.customerId)&&(!completion.subscriptionId||stored.subscription_id===completion.subscriptionId)?stored:null;
    },
    async updatePurchaseStatus(transactionId,status,occurredAt){
      statements.updatePurchaseStatus.run(status,occurredAt,transactionId,occurredAt);
      return purchaseRow(statements.purchaseByTransaction.get(transactionId));
    },
    async createPaddleSubscription(subscription){
      let transactionOpen=false;
      try{
        db.exec("BEGIN IMMEDIATE");transactionOpen=true;
        const bound=plainRow(statements.bindPurchaseSubscription.get(...subscriptionBindArgs(subscription)));
        if(!bound){db.exec("ROLLBACK");transactionOpen=false;return null;}
        const saved=subscriptionRow(statements.createPaddleSubscription.get(...subscriptionCreateArgs(subscription)))||subscriptionRow(statements.subscriptionById.get(subscription.subscriptionId));
        if(!saved||saved.user_id!==subscription.userId||saved.transaction_id!==subscription.transactionId)throw new Error("Paddle subscription identity conflict.");
        db.exec("COMMIT");transactionOpen=false;return saved;
      }catch(error){
        if(transactionOpen)try{db.exec("ROLLBACK");}catch{/* Preserve the subscription write error. */}
        throw error;
      }
    },
    async updatePaddleSubscription(subscription){return subscriptionRow(statements.updatePaddleSubscription.get(...subscriptionUpdateArgs(subscription)));},
    async updatePaddleSubscriptionCatalog(existing,purchase,subscription){
      let transactionOpen=false;
      try{
        db.exec("BEGIN IMMEDIATE");transactionOpen=true;
        const migrated=purchaseRow(statements.replaceSubscriptionPurchaseCatalog.get(...subscriptionPurchaseCatalogArgs(existing,purchase,subscription)));
        const saved=migrated&&subscriptionRow(statements.updatePaddleSubscriptionAfterCatalog.get(...subscriptionUpdateAfterCatalogArgs(subscription)));
        if(!saved){db.exec("ROLLBACK");transactionOpen=false;return null;}
        db.exec("COMMIT");transactionOpen=false;return saved;
      }catch(error){if(transactionOpen)try{db.exec("ROLLBACK");}catch{/* Preserve the catalog write error. */}throw error;}
    },
    async subscriptionById(subscriptionId){return subscriptionRow(statements.subscriptionById.get(subscriptionId));},
    async subscriptionForUser(userId){return subscriptionRow(statements.subscriptionForUser.get(userId));},
    async upsertAdjustment(adjustment){return Boolean(plainRow(statements.upsertAdjustment.get(adjustment.adjustmentId,adjustment.transactionId,adjustment.action,adjustment.type||null,adjustment.status,adjustment.occurredAt,adjustment.updatedAt)));},
    async adjustmentById(adjustmentId){return plainRow(statements.adjustmentById.get(adjustmentId));},
    async revokePurchase(transactionId,reason,revokedAt,updatedAt){
      statements.revokePurchase.run(revokedAt,reason,updatedAt,transactionId);
      return purchaseRow(statements.purchaseByTransaction.get(transactionId));
    },
    async hasPaidDiscoveryAccess(userId,priceId=null,now=Date.now()){return Boolean(statements.hasDiscoveryAccess.get(now,userId,priceId,priceId));},
    async hasCurrentPaidDiscoveryAccess(userId,priceId,productId,now=Date.now()){return Boolean(statements.hasCurrentDiscoveryAccess.get(now,userId,priceId,productId));},
    async hasEntitledPaidDiscoveryAccess(userId,priceIds,productId,now=Date.now()){return Boolean(statements.hasEntitledDiscoveryAccess.get(now,userId,serializedPriceIds(priceIds),productId));},
    async hasDiscoveryAccess(userId,priceId=null,now=Date.now()){return Boolean(statements.hasDiscoveryAccess.get(now,userId,priceId,priceId)||statements.activeDiscoveryTrial.get(userId,now)||statements.activeAdminGrant.get(userId,now,now));},
    async discoveryTrial(userId){return trialRow(statements.discoveryTrial.get(userId));},
    async discoveryAccessSummary(userId,priceId=null,now=Date.now()){return accessSummary(plainRow(statements.discoveryAccessSummary.get(now,userId,priceId,priceId)));},
    async currentDiscoveryAccessSummary(userId,priceId,productId,now=Date.now()){return accessSummary(plainRow(statements.currentDiscoveryAccessSummary.get(now,priceId,productId,priceId,productId,userId)));},
    async entitledDiscoveryAccessSummary(userId,priceIds,productId,now=Date.now()){const prices=serializedPriceIds(priceIds);return accessSummary(plainRow(statements.entitledDiscoveryAccessSummary.get(now,prices,productId,prices,productId,userId)));},
    async webhookEvent(eventId){return plainRow(statements.webhookEvent.get(eventId));},
    async recordWebhookEvent(event){return Boolean(plainRow(statements.recordWebhookEvent.get(event.eventId,event.notificationId||null,event.eventType,event.occurredAt,event.processedAt)));}
  };
  return methods;
}

/**
 * @param {import("./domain-types").TursoBillingStoreDependencies} dependencies
 * @returns {import("./domain-types").BillingAdapterMethods}
 */
function createTursoBillingMethods({client,first,run,all,plainRow}){
  /** @template {import("./domain-types").JsonObject} Row @param {string} sql @param {unknown[]} args @returns {Promise<Row|null>} */
  async function returned(sql,args){const result=await run(sql,args);return plainRow(result.rows?.[0],result.columns);}
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").PurchaseRow|null>} */
  const returnedPurchase=(sql,args)=>/** @type {Promise<import("./domain-types").PurchaseRow|null>} */(returned(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").CheckoutClaimRow|null>} */
  const returnedCheckout=(sql,args)=>/** @type {Promise<import("./domain-types").CheckoutClaimRow|null>} */(returned(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").SubscriptionRow|null>} */
  const returnedSubscription=(sql,args)=>/** @type {Promise<import("./domain-types").SubscriptionRow|null>} */(returned(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").DiscoveryTrialRow|null>} */
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").PurchaseRow|null>} */
  const firstPurchase=(sql,args)=>/** @type {Promise<import("./domain-types").PurchaseRow|null>} */(first(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").CheckoutClaimRow|null>} */
  const firstCheckout=(sql,args)=>/** @type {Promise<import("./domain-types").CheckoutClaimRow|null>} */(first(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").SubscriptionRow|null>} */
  const firstSubscription=(sql,args)=>/** @type {Promise<import("./domain-types").SubscriptionRow|null>} */(first(sql,args));
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").DiscoveryTrialRow|null>} */
  const firstTrial=(sql,args)=>/** @type {Promise<import("./domain-types").DiscoveryTrialRow|null>} */(first(sql,args));
  /** @param {import("./domain-types").JsonObject|null} row @returns {import("./domain-types").PurchaseRow|null} */
  const purchaseRow=(row)=>/** @type {import("./domain-types").PurchaseRow|null} */(row);
  /** @param {string} sql @param {unknown[]} args @returns {Promise<import("./domain-types").PurchaseRow[]>} */
  const allPurchases=async(sql,args)=>(await all(sql,args)).map(purchaseRow).filter((row)=>row!==null);
  /** @type {import("./domain-types").BillingAdapterMethods} */
  const methods={
    async pendingPurchasesForUser(userId){return Number((await first(BILLING_SQL.pendingPurchasesForUser,[userId]))?.pending_count||0);},
    unsettledPurchasesForUser:(userId)=>allPurchases(BILLING_SQL.unsettledPurchasesForUser,[userId]),
    insertPendingPurchase:(purchase)=>returnedPurchase(BILLING_SQL.insertPendingPurchase,[purchase.transactionId,purchase.priceId,purchase.productId,purchase.paddleStatus||"ready",purchase.createdAt,purchase.updatedAt,purchase.userId,purchase.updatedAt]),
    recordClaimedPurchase:(purchase,claimId)=>returnedPurchase(BILLING_SQL.recordClaimedPurchase,[purchase.priceId,purchase.productId,purchase.paddleStatus||"ready",purchase.createdAt,purchase.updatedAt,purchase.userId,claimId,purchase.transactionId,purchase.priceId]),
    replacePendingPurchaseCatalog:(purchase,replacement)=>returnedPurchase(BILLING_SQL.replacePendingPurchaseCatalog,[replacement.priceId,replacement.productId,replacement.paddleStatus,replacement.updatedAt,purchase.transaction_id,purchase.user_id,purchase.price_id,purchase.product_id,purchase.updated_at,purchase.paddle_status,replacement.paddleStatus,replacement.updatedAt]),
    completePurchaseCatalogMigration:(purchase,replacement)=>returnedPurchase(BILLING_SQL.completePurchaseCatalogMigration,[replacement.priceId,replacement.productId,replacement.customerId||null,replacement.subscriptionId||null,replacement.completedAt,replacement.updatedAt,purchase.transaction_id,purchase.user_id,purchase.price_id,purchase.product_id,purchase.paddle_status,purchase.updated_at,replacement.subscriptionId||null,replacement.customerId||null]),
    checkoutCreationForUser:(userId)=>firstCheckout(BILLING_SQL.checkoutCreationForUser,[userId]),
    claimCheckoutCreation:({userId,priceId,claimId,expiresAt,now})=>returnedCheckout(BILLING_SQL.claimCheckoutCreation,[priceId,claimId,expiresAt,now,now,userId,now,now]),
    recordCheckoutCreationTransaction:(userId,claimId,transactionId,updatedAt)=>returnedCheckout(BILLING_SQL.recordCheckoutCreationTransaction,[transactionId,updatedAt,userId,claimId,transactionId]),
    extendCheckoutCreation:(userId,claimId,expiresAt,updatedAt)=>returnedCheckout(BILLING_SQL.extendCheckoutCreation,[expiresAt,updatedAt,userId,claimId]),
    async releaseCheckoutCreation(userId,claimId,expectedTransactionId=null){return Boolean(await returned(BILLING_SQL.releaseCheckoutCreation,[userId,claimId,expectedTransactionId]));},
    purchaseByTransaction:(transactionId)=>firstPurchase(BILLING_SQL.purchaseByTransaction,[transactionId]),
    pendingPurchaseForUser:(userId,priceId)=>firstPurchase(BILLING_SQL.pendingPurchaseForUser,[userId,priceId]),
    async completePurchase(transactionId,completion){
      await run(BILLING_SQL.completePurchase,[completion.customerId||null,completion.subscriptionId||null,completion.completedAt,completion.updatedAt,transactionId,completion.subscriptionId||null,completion.customerId||null]);
      const stored=await firstPurchase(BILLING_SQL.purchaseByTransaction,[transactionId]);
      return stored&&(!completion.customerId||stored.customer_id===completion.customerId)&&(!completion.subscriptionId||stored.subscription_id===completion.subscriptionId)?stored:null;
    },
    async updatePurchaseStatus(transactionId,status,occurredAt){await run(BILLING_SQL.updatePurchaseStatus,[status,occurredAt,transactionId,occurredAt]);return firstPurchase(BILLING_SQL.purchaseByTransaction,[transactionId]);},
    async createPaddleSubscription(subscription){
      const results=await client.batch([
        {sql:BILLING_SQL.bindPurchaseSubscription,args:subscriptionBindArgs(subscription)},
        {sql:BILLING_SQL.createPaddleSubscription,args:subscriptionCreateArgs(subscription)}
      ],"write");
      const bound=plainRow(results[0]?.rows?.[0],results[0]?.columns);
      if(!bound)return null;
      const saved=/** @type {import("./domain-types").SubscriptionRow|null} */(plainRow(results[1]?.rows?.[0],results[1]?.columns))||await firstSubscription(BILLING_SQL.subscriptionById,[subscription.subscriptionId]);
      if(!saved||saved.user_id!==subscription.userId||saved.transaction_id!==subscription.transactionId)throw new Error("Paddle subscription identity conflict.");
      return saved;
    },
    updatePaddleSubscription:(subscription)=>returnedSubscription(BILLING_SQL.updatePaddleSubscription,subscriptionUpdateArgs(subscription)),
    async updatePaddleSubscriptionCatalog(existing,purchase,subscription){
      const results=await client.batch([
        {sql:BILLING_SQL.replaceSubscriptionPurchaseCatalog,args:subscriptionPurchaseCatalogArgs(existing,purchase,subscription)},
        {sql:BILLING_SQL.updatePaddleSubscriptionAfterCatalog,args:subscriptionUpdateAfterCatalogArgs(subscription)}
      ],"write");
      const migrated=plainRow(results[0]?.rows?.[0],results[0]?.columns);
      const saved=/** @type {import("./domain-types").SubscriptionRow|null} */(plainRow(results[1]?.rows?.[0],results[1]?.columns));
      return migrated&&saved?saved:null;
    },
    subscriptionById:(subscriptionId)=>firstSubscription(BILLING_SQL.subscriptionById,[subscriptionId]),
    subscriptionForUser:(userId)=>firstSubscription(BILLING_SQL.subscriptionForUser,[userId]),
    async upsertAdjustment(adjustment){return Boolean(await returned(BILLING_SQL.upsertAdjustment,[adjustment.adjustmentId,adjustment.transactionId,adjustment.action,adjustment.type||null,adjustment.status,adjustment.occurredAt,adjustment.updatedAt]));},
    adjustmentById:(adjustmentId)=>first(BILLING_SQL.adjustmentById,[adjustmentId]),
    async revokePurchase(transactionId,reason,revokedAt,updatedAt){await run(BILLING_SQL.revokePurchase,[revokedAt,reason,updatedAt,transactionId]);return firstPurchase(BILLING_SQL.purchaseByTransaction,[transactionId]);},
    async hasPaidDiscoveryAccess(userId,priceId=null,now=Date.now()){return Boolean(await first(BILLING_SQL.hasDiscoveryAccess,[now,userId,priceId,priceId]));},
    async hasCurrentPaidDiscoveryAccess(userId,priceId,productId,now=Date.now()){return Boolean(await first(BILLING_SQL.hasCurrentDiscoveryAccess,[now,userId,priceId,productId]));},
    async hasEntitledPaidDiscoveryAccess(userId,priceIds,productId,now=Date.now()){return Boolean(await first(BILLING_SQL.hasEntitledDiscoveryAccess,[now,userId,serializedPriceIds(priceIds),productId]));},
    async hasDiscoveryAccess(userId,priceId=null,now=Date.now()){
      const [paid,trial,grant]=await Promise.all([first(BILLING_SQL.hasDiscoveryAccess,[now,userId,priceId,priceId]),first(BILLING_SQL.activeDiscoveryTrial,[userId,now]),first(ACCESS_CONTROLS_SQL.activeAdminGrant,[userId,now,now])]);
      return Boolean(paid||trial||grant);
    },
    discoveryTrial:(userId)=>firstTrial(BILLING_SQL.discoveryTrial,[userId]),
    async discoveryAccessSummary(userId,priceId=null,now=Date.now()){return accessSummary(await first(BILLING_SQL.discoveryAccessSummary,[now,userId,priceId,priceId]));},
    async currentDiscoveryAccessSummary(userId,priceId,productId,now=Date.now()){return accessSummary(await first(BILLING_SQL.currentDiscoveryAccessSummary,[now,priceId,productId,priceId,productId,userId]));},
    async entitledDiscoveryAccessSummary(userId,priceIds,productId,now=Date.now()){const prices=serializedPriceIds(priceIds);return accessSummary(await first(BILLING_SQL.entitledDiscoveryAccessSummary,[now,prices,productId,prices,productId,userId]));},
    webhookEvent:(eventId)=>first(BILLING_SQL.webhookEvent,[eventId]),
    async recordWebhookEvent(event){return Boolean(await returned(BILLING_SQL.recordWebhookEvent,[event.eventId,event.notificationId||null,event.eventType,event.occurredAt,event.processedAt]));}
  };
  return methods;
}

module.exports={createLocalBillingMethods,createTursoBillingMethods};
