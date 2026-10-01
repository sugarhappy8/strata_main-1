"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync,mkdtempSync,rmSync } = require("node:fs");
const { join } = require("node:path");
const { createStore } = require("../src/database");
const { STRATA_PLUS_TRIAL_MS } = require("../src/payments");
const { insertLegacyTrial } = require("./support/strata-plus-access");

const PROJECT_ROOT=join(__dirname,"..");

const PRICE_ID="pri_01monthlyfixture00000000000000";
const LEGACY_PRICE_ID="pri_01m1kyc2zd313d7a3ssmg02424";
const OTHER_PRICE_ID="pri_01m1kyc2zd313d7a3ssmg09999";
const PRODUCT_ID="pro_01m1ky8j916ybyacs836dxbz8x";

async function fixture() {
  const runtimeRoot=join(PROJECT_ROOT,"test-runtime");
  mkdirSync(runtimeRoot,{recursive:true});
  const root=mkdtempSync(join(runtimeRoot,"payment-db-"));
  const previous={
    nodeEnv:process.env.NODE_ENV,
    tursoUrl:process.env.TURSO_DATABASE_URL,
    dataDir:process.env.STRATA_DATA_DIR
  };
  process.env.NODE_ENV="test";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.STRATA_DATA_DIR;
  const store=await createStore(root);
  await store.insertUser({
    id:"user-1",
    name:"Payment Tester",
    email:"payments@example.test",
    passwordHash:"not-a-real-password-hash",
    passwordSalt:"not-a-real-salt",
    createdAt:100
  });
  return {
    store,root,
    async close() {
      await store.close();
      rmSync(root,{recursive:true,force:true});
      if(previous.nodeEnv===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous.nodeEnv;
      if(previous.tursoUrl===undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL=previous.tursoUrl;
      if(previous.dataDir===undefined) delete process.env.STRATA_DATA_DIR; else process.env.STRATA_DATA_DIR=previous.dataDir;
    }
  };
}

function pending(transactionId,createdAt,status="ready",priceId=PRICE_ID) {
  return {
    transactionId,
    userId:"user-1",
    priceId,
    productId:PRODUCT_ID,
    paddleStatus:status,
    createdAt,
    updatedAt:createdAt
  };
}

test("checkout creation claims serialize per user, track provider work, and recover after expiry",async() => {
  const {store,close}=await fixture();
  try {
    const first=await store.claimCheckoutCreation({
      userId:"user-1",priceId:PRICE_ID,claimId:"claim-first",expiresAt:2_000,now:1_000
    });
    assert.deepEqual(first,{
      user_id:"user-1",price_id:PRICE_ID,claim_id:"claim-first",transaction_id:null,
      expires_at:2_000,created_at:1_000,updated_at:1_000
    });
    assert.equal(await store.claimCheckoutCreation({
      userId:"user-1",priceId:OTHER_PRICE_ID,claimId:"claim-second",expiresAt:2_500,now:1_500
    }),null,"an unexpired claim must admit only one checkout creator per user, even across prices");
    assert.equal(await store.releaseCheckoutCreation("user-1","wrong-claim"),false);

    const recorded=await store.recordCheckoutCreationTransaction("user-1","claim-first","txn_claim_first",1_600);
    assert.deepEqual(recorded,{
      ...first,transaction_id:"txn_claim_first",updated_at:1_600
    });
    assert.equal(await store.recordCheckoutCreationTransaction("user-1","wrong-claim","txn_wrong",1_700),null);
    assert.equal(
      await store.recordCheckoutCreationTransaction("user-1","claim-first","txn_replacement",1_700),
      null,
      "a claim must not be rebound to a different provider transaction"
    );

    const extended=await store.extendCheckoutCreation("user-1","claim-first",4_000,1_800);
    assert.deepEqual(extended,{
      ...recorded,expires_at:4_000,updated_at:1_800
    });
    assert.equal(await store.extendCheckoutCreation("user-1","wrong-claim",5_000,1_900),null);
    assert.equal(await store.claimCheckoutCreation({
      userId:"user-1",priceId:OTHER_PRICE_ID,claimId:"claim-too-soon",expiresAt:4_500,now:2_000
    }),null,"extending the lease must keep other checkout creators out");

    assert.equal(await store.claimCheckoutCreation({
      userId:"user-1",priceId:OTHER_PRICE_ID,claimId:"claim-attached-takeover",expiresAt:5_000,now:4_000
    }),null,"an expired claim with an attached provider transaction must not be taken over");
    assert.deepEqual(await store.checkoutCreationForUser("user-1"),extended);
    assert.equal(await store.releaseCheckoutCreation("user-1","claim-first"),false,"a null expectation cannot erase an attached transaction");
    assert.equal(await store.releaseCheckoutCreation("user-1","claim-first","txn_wrong"),false,"a mismatched transaction cannot release the claim");
    assert.equal(await store.releaseCheckoutCreation("user-1","claim-first","txn_claim_first"),true);

    const unbound=await store.claimCheckoutCreation({
      userId:"user-1",priceId:PRICE_ID,claimId:"claim-unbound",expiresAt:6_000,now:5_000
    });
    assert.equal(unbound.transaction_id,null);
    const recovered=await store.claimCheckoutCreation({
      userId:"user-1",priceId:OTHER_PRICE_ID,claimId:"claim-recovered",expiresAt:7_000,now:6_000
    });
    assert.deepEqual(recovered,{
      user_id:"user-1",price_id:OTHER_PRICE_ID,claim_id:"claim-recovered",transaction_id:null,
      expires_at:7_000,created_at:6_000,updated_at:6_000
    },"an expired claim without a provider transaction must not strand checkout");
    assert.equal(await store.releaseCheckoutCreation("user-1","claim-unbound"),false,"an older owner cannot release a replacement claim");
    assert.equal(await store.releaseCheckoutCreation("user-1","claim-recovered"),true);
    assert.equal(await store.checkoutCreationForUser("user-1"),null);
  } finally {
    await close();
  }
});

test("trials started before the trial was retired grant temporary access without becoming purchases",async()=>{
  const {store,root,close}=await fixture();
  try{
    assert.equal(await store.discoveryTrial("user-1"),null);
    assert.equal(await store.hasDiscoveryAccess("user-1",null,999),false);
    assert.equal(typeof store.startDiscoveryTrial,"undefined","the store has no way to start a new trial");
    insertLegacyTrial(join(root,"data"),"user-1",{startedAt:1_000,expiresAt:1_000+STRATA_PLUS_TRIAL_MS});
    const trial=await store.discoveryTrial("user-1");
    assert.deepEqual(trial,{user_id:"user-1",started_at:1_000,expires_at:1_000+STRATA_PLUS_TRIAL_MS});
    assert.equal(await store.hasPaidDiscoveryAccess("user-1"),false);
    assert.equal(await store.hasDiscoveryAccess("user-1",null,999+STRATA_PLUS_TRIAL_MS),true);
    assert.equal(await store.hasDiscoveryAccess("user-1",null,1_000+STRATA_PLUS_TRIAL_MS),false,"access expires on the exact server timestamp");
  }finally{await close();}
});

test("purchase ledger grants access from any completed, unrevoked purchase",async() => {
  const {store,close}=await fixture();
  try {
    assert.deepEqual(await store.discoveryAccessSummary("user-1"),{
      active:false,
      purchaseCount:0,
      activePurchaseCount:0,
      pendingPurchaseCount:0,
      latestActivePurchaseAt:null,
      latestCompletedAt:null,
      latestRevokedAt:null
    });

    const first=await store.insertPendingPurchase(pending("txn_first",1_000));
    assert.equal(first.paddle_status,"ready");
    assert.equal((await store.pendingPurchaseForUser("user-1",PRICE_ID)).transaction_id,"txn_first");
    assert.equal(await store.hasDiscoveryAccess("user-1"),false);

    const completed=await store.completePurchase("txn_first",{customerId:"ctm_first",completedAt:2_000,updatedAt:2_000});
    assert.equal(completed.paddle_status,"completed");
    assert.equal(completed.customer_id,"ctm_first");
    assert.equal(completed.completed_at,2_000);
    assert.equal(await store.pendingPurchaseForUser("user-1",PRICE_ID),null);
    assert.equal(await store.hasDiscoveryAccess("user-1"),true);
    assert.equal(await store.hasDiscoveryAccess("user-1",PRICE_ID),true);
    assert.equal(await store.hasDiscoveryAccess("user-1","pri_another_product"),false);
    assert.equal((await store.discoveryAccessSummary("user-1","pri_another_product")).purchaseCount,0);

    await store.revokePurchase("txn_first","approved_full_refund",3_000,3_000);
    assert.equal(await store.hasDiscoveryAccess("user-1"),false);

    await store.insertPendingPurchase(pending("txn_second",4_000));
    await store.completePurchase("txn_second",{customerId:"ctm_second",completedAt:5_000,updatedAt:5_000});
    assert.equal(await store.hasDiscoveryAccess("user-1"),true,"a refunded older purchase must not revoke a later active purchase");
    assert.deepEqual(await store.discoveryAccessSummary("user-1"),{
      active:true,
      purchaseCount:2,
      activePurchaseCount:1,
      pendingPurchaseCount:0,
      latestActivePurchaseAt:5_000,
      latestCompletedAt:5_000,
      latestRevokedAt:3_000
    });
  } finally {
    await close();
  }
});

test("a legacy draft can move to the recurring catalog only through an exact pending-row CAS",async()=>{
  const {store,close}=await fixture();
  try{
    const draft=await store.insertPendingPurchase(pending("txn_catalog_migration",1_000,"draft",LEGACY_PRICE_ID));
    const migrated=await store.replacePendingPurchaseCatalog(draft,{priceId:PRICE_ID,productId:PRODUCT_ID,paddleStatus:"draft",updatedAt:1_100});
    assert.equal(migrated.price_id,PRICE_ID);
    assert.equal(migrated.updated_at,1_100);
    assert.equal(await store.replacePendingPurchaseCatalog(draft,{priceId:PRICE_ID,productId:PRODUCT_ID,paddleStatus:"draft",updatedAt:1_200}),null,"the stale source snapshot cannot replay");
    const ready=await store.updatePurchaseStatus("txn_catalog_migration","ready",1_200);
    assert.equal((await store.replacePendingPurchaseCatalog(ready,{priceId:PRICE_ID,productId:PRODUCT_ID,paddleStatus:"ready",updatedAt:1_300})).paddle_status,"ready","a provider-ready/local-stale row can finish the same exact CAS after a response is lost");
    assert.equal((await store.purchaseByTransaction("txn_catalog_migration")).price_id,PRICE_ID);
    await store.updatePurchaseStatus("txn_catalog_migration","canceled",1_400);
    for(const [index,status] of ["paid","past_due","canceled"].entries()){
      const blocked=await store.insertPendingPurchase(pending(`txn_catalog_blocked_${index}`,2_000+index,status,LEGACY_PRICE_ID));
      assert.equal(await store.replacePendingPurchaseCatalog(blocked,{priceId:PRICE_ID,productId:PRODUCT_ID,paddleStatus:"ready",updatedAt:2_100+index}),null,`${status} source rows cannot be catalog-rewritten`);
      assert.equal((await store.purchaseByTransaction(blocked.transaction_id)).price_id,LEGACY_PRICE_ID);
      if(status!=="canceled")await store.updatePurchaseStatus(blocked.transaction_id,"canceled",2_200+index);
    }
  }finally{await close();}
});

test("monthly subscription cache is linked, ordered, fail-closed, and keeps legacy buyers",async()=>{
  const {store,close}=await fixture();
  const transactionId="txn_monthly",subscriptionId="sub_monthly",customerId="ctm_monthly";
  try{
    // A pre-7.5 completed purchase has no subscription ID and remains a
    // grandfathered lifetime entitlement.
    await store.insertPendingPurchase(pending("txn_legacy",500,"ready",LEGACY_PRICE_ID));
    await store.completePurchase("txn_legacy",{customerId:"ctm_legacy",completedAt:600,updatedAt:600});
    assert.equal(await store.hasPaidDiscoveryAccess("user-1",null,Number.MAX_SAFE_INTEGER),true);
    assert.equal(await store.hasCurrentPaidDiscoveryAccess("user-1","","",Number.MAX_SAFE_INTEGER),true,"legacy lifetime access survives missing or replaced recurring catalog configuration");
    await store.revokePurchase("txn_legacy","test_subscription_isolation",700,700);

    await store.insertPendingPurchase(pending(transactionId,1_000));
    await store.completePurchase(transactionId,{customerId,subscriptionId,completedAt:1_100,updatedAt:1_100});
    assert.equal(await store.hasPaidDiscoveryAccess("user-1"),false,"a completed recurring transaction must wait for its verified subscription link");
    assert.equal(await store.pendingPurchasesForUser("user-1"),1,"an unlinked completed subscription prevents a duplicate checkout or unsafe deletion");

    const active=await store.createPaddleSubscription({
      subscriptionId,userId:"user-1",transactionId,customerId,status:"active",
      priceId:PRICE_ID,productId:PRODUCT_ID,scheduledChangeAction:"cancel",scheduledChangeAt:5_000,
      currentPeriodEndsAt:5_000,eventOccurredAt:2_000,createdAt:2_000,updatedAt:2_100
    });
    assert.equal(active.status,"active");
    assert.equal(active.scheduled_change_action,"cancel");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1",null,4_999),true,"scheduled cancellation keeps access through the active period");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1",null,5_000),false,"scheduled cancellation ends access at the exact trusted boundary");
    assert.equal(await store.hasCurrentPaidDiscoveryAccess("user-1",PRICE_ID,PRODUCT_ID,4_999),true);
    assert.equal(await store.hasCurrentPaidDiscoveryAccess("user-1",OTHER_PRICE_ID,PRODUCT_ID,4_999),false,"recurring access requires the configured price");
    assert.equal(await store.hasCurrentPaidDiscoveryAccess("user-1",PRICE_ID,"pro_another_product",4_999),false,"recurring access requires the configured product");
    assert.equal((await store.currentDiscoveryAccessSummary("user-1",OTHER_PRICE_ID,PRODUCT_ID,4_999)).active,false);
    assert.equal(await store.pendingPurchasesForUser("user-1"),1,"an active subscription blocks deletion and duplicate subscription creation");

    const pastDue=await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"past_due",priceId:PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:6_000,eventOccurredAt:3_000,updatedAt:3_100
    });
    assert.equal(pastDue.status,"past_due");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1",null,5_999),true,"past-due members retain access while Paddle retries payment");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1",null,6_000),false,"cached recurring access fails closed when its verified period ends");

    const stale=await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"canceled",priceId:PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:null,eventOccurredAt:2_500,updatedAt:4_000
    });
    assert.equal(stale,null,"an older delivery cannot overwrite the newest provider state");
    assert.equal((await store.subscriptionById(subscriptionId)).status,"past_due");

    await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"active",priceId:OTHER_PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:7_000,eventOccurredAt:4_000,updatedAt:4_100
    });
    assert.equal(await store.hasPaidDiscoveryAccess("user-1"),false,"a catalog change fails closed without losing the provider state");
    assert.equal(await store.pendingPurchasesForUser("user-1"),1,"a still-active mismatched subscription remains deletion-blocking");

    const paused=await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"paused",priceId:PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:null,eventOccurredAt:4_500,updatedAt:4_600
    });
    assert.equal(paused.status,"paused");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1"),false,"paused subscriptions do not grant access");
    assert.equal(await store.pendingPurchasesForUser("user-1"),1,"paused subscriptions remain provider-managed and cannot be duplicated or orphaned by deletion");

    const canceled=await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"canceled",priceId:PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:null,eventOccurredAt:5_000,updatedAt:5_100
    });
    assert.equal(canceled.status,"canceled");
    assert.equal(await store.hasPaidDiscoveryAccess("user-1"),false);
    const equalTimestampReactivation=await store.updatePaddleSubscription({
      subscriptionId,userId:"user-1",customerId,status:"active",priceId:PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:9_000,eventOccurredAt:5_000,updatedAt:5_200
    });
    assert.equal(equalTimestampReactivation,null,"an equal-timestamp active update cannot supersede a terminal state");
    assert.equal((await store.subscriptionById(subscriptionId)).status,"canceled");
    assert.equal(await store.pendingPurchasesForUser("user-1"),0,"a terminal subscription no longer blocks account deletion");
  }finally{await close();}
});

test("subscription catalog migration updates the linked purchase atomically",async()=>{
  const {store,close}=await fixture();
  const transactionId="txn_catalog_subscription",subscriptionId="sub_catalog_subscription",customerId="ctm_catalog_subscription";
  try{
    await store.insertPendingPurchase(pending(transactionId,1_000,"ready",OTHER_PRICE_ID));
    await store.completePurchase(transactionId,{customerId,subscriptionId,completedAt:1_100,updatedAt:1_100});
    const legacy=await store.createPaddleSubscription({
      subscriptionId,userId:"user-1",transactionId,customerId,status:"active",priceId:OTHER_PRICE_ID,productId:PRODUCT_ID,
      scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:9_000,eventOccurredAt:2_000,createdAt:2_000,updatedAt:2_000
    });
    const update={subscriptionId,userId:"user-1",customerId,status:"active",priceId:PRICE_ID,productId:PRODUCT_ID,scheduledChangeAction:null,scheduledChangeAt:null,currentPeriodEndsAt:10_000,eventOccurredAt:3_000,updatedAt:3_000};
    const purchase=await store.purchaseByTransaction(transactionId);
    const migrated=await store.updatePaddleSubscriptionCatalog(legacy,purchase,update);
    assert.equal(migrated.price_id,PRICE_ID);
    assert.equal((await store.purchaseByTransaction(transactionId)).price_id,PRICE_ID);
    assert.equal(await store.hasEntitledPaidDiscoveryAccess("user-1",[PRICE_ID,OTHER_PRICE_ID],PRODUCT_ID,9_999),true);
    assert.equal((await store.entitledDiscoveryAccessSummary("user-1",[PRICE_ID,OTHER_PRICE_ID],PRODUCT_ID,9_999)).activePurchaseCount,1);

    const stale={...legacy,price_id:"pri_01stalelegacy000000000000000"};
    assert.equal(await store.updatePaddleSubscriptionCatalog(stale,{...purchase,price_id:"pri_01stalelegacy000000000000000"},{...update,eventOccurredAt:4_000,updatedAt:4_000}),null);
    assert.equal((await store.purchaseByTransaction(transactionId)).price_id,PRICE_ID,"a stale source cannot partially rewrite either side of the link");
    assert.equal((await store.subscriptionById(subscriptionId)).event_occurred_at,3_000);
  }finally{await close();}
});

test("purchase status updates are ordered and completed is terminal",async() => {
  const {store,close}=await fixture();
  try {
    await store.insertPendingPurchase(pending("txn_ordered",1_000,"draft"));
    assert.equal((await store.updatePurchaseStatus("txn_ordered","ready",2_000)).paddle_status,"ready");
    const stale=await store.updatePurchaseStatus("txn_ordered","payment_failed",1_500);
    assert.equal(stale.paddle_status,"ready");
    assert.equal(stale.updated_at,2_000);

    await store.completePurchase("txn_ordered",{customerId:"ctm_ordered",completedAt:3_000,updatedAt:3_000});
    const lateCancel=await store.updatePurchaseStatus("txn_ordered","canceled",4_000);
    assert.equal(lateCancel.paddle_status,"completed");
    assert.equal(lateCancel.updated_at,3_000);
    assert.equal(await store.hasDiscoveryAccess("user-1"),true);
  } finally {
    await close();
  }
});

test("adjustment upserts keep the newest event and revocation is monotonic",async() => {
  const {store,close}=await fixture();
  try {
    await store.insertPendingPurchase(pending("txn_refund",1_000));
    await store.completePurchase("txn_refund",{customerId:"ctm_refund",completedAt:2_000,updatedAt:2_000});

    const pendingApplied=await store.upsertAdjustment({
      adjustmentId:"adj_refund",
      transactionId:"txn_refund",
      action:"refund",
      type:"full",
      status:"pending_approval",
      occurredAt:4_000,
      updatedAt:4_000
    });
    assert.equal(pendingApplied,true);
    assert.equal((await store.adjustmentById("adj_refund")).status,"pending_approval");

    const staleApplied=await store.upsertAdjustment({
      adjustmentId:"adj_refund",
      transactionId:"txn_refund",
      action:"refund",
      type:"full",
      status:"approved",
      occurredAt:3_000,
      updatedAt:5_000
    });
    assert.equal(staleApplied,false,"an older delivery must not overwrite newer adjustment state");
    const stale=await store.adjustmentById("adj_refund");
    assert.equal(stale.status,"pending_approval");
    assert.equal(stale.occurred_at,4_000);

    const approvedApplied=await store.upsertAdjustment({
      adjustmentId:"adj_refund",
      transactionId:"txn_refund",
      action:"refund",
      type:"full",
      status:"approved",
      occurredAt:6_000,
      updatedAt:6_000
    });
    assert.equal(approvedApplied,true);
    assert.equal((await store.adjustmentById("adj_refund")).status,"approved");

    await store.insertPendingPurchase(pending("txn_other_refund",6_100));
    const reassigned=await store.upsertAdjustment({
      adjustmentId:"adj_refund",transactionId:"txn_other_refund",action:"chargeback",type:"full",
      status:"approved",occurredAt:7_000,updatedAt:7_000
    });
    assert.equal(reassigned,false,"a provider adjustment ID cannot be rebound to another transaction");
    assert.equal((await store.adjustmentById("adj_refund")).transaction_id,"txn_refund");
    assert.equal((await store.purchaseByTransaction("txn_other_refund")).access_revoked_at,null);

    const revoked=await store.revokePurchase("txn_refund","approved_full_refund",6_000,6_000);
    assert.equal(revoked.access_revoked_at,6_000);
    assert.equal(revoked.revocation_reason,"approved_full_refund");
    await store.revokePurchase("txn_refund","duplicate_or_later_reason",7_000,7_000);
    await store.completePurchase("txn_refund",{customerId:"ctm_replayed",completedAt:8_000,updatedAt:8_000});

    const preserved=await store.purchaseByTransaction("txn_refund");
    assert.equal(preserved.access_revoked_at,6_000,"replayed completion must not restore revoked access");
    assert.equal(preserved.revocation_reason,"approved_full_refund");
    assert.equal(preserved.completed_at,2_000,"replayed completion must preserve the first completion time");
    assert.equal(preserved.customer_id,"ctm_refund","replayed completion must preserve the first provider customer identity");
    assert.equal(await store.hasDiscoveryAccess("user-1"),false);
  } finally {
    await close();
  }
});

test("webhook event IDs are recorded once",async() => {
  const {store,close}=await fixture();
  try {
    const event={eventId:"evt_once",notificationId:"ntf_once",eventType:"transaction.completed",occurredAt:2_000,processedAt:2_100};
    assert.equal(await store.recordWebhookEvent(event),true);
    assert.equal(await store.recordWebhookEvent({...event,eventType:"adjustment.updated",processedAt:9_999}),false);
    assert.deepEqual(await store.webhookEvent("evt_once"),{
      event_id:"evt_once",
      notification_id:"ntf_once",
      event_type:"transaction.completed",
      occurred_at:2_000,
      processed_at:2_100
    });
    assert.equal(await store.webhookEvent("evt_missing"),null);
  } finally {
    await close();
  }
});

test("adjustments require a known local purchase",async() => {
  const {store,close}=await fixture();
  try {
    await assert.rejects(
      store.upsertAdjustment({adjustmentId:"adj_unknown",transactionId:"txn_unknown",action:"refund",type:"full",status:"approved",occurredAt:1_000,updatedAt:1_000}),
      /foreign key/i
    );
  } finally {
    await close();
  }
});
