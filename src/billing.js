// @ts-check
"use strict";
const {createCheckoutReconciliation}=require("./checkout-reconciliation");
const {adminGrantState}=require("./access-controls");

const {randomUUID}=require("node:crypto");
const {MAX_WEBHOOK_BYTES,bodyBuffer:readBodyBuffer}=require("./http");
const {
  DEFAULT_PRODUCT_ID,DEFAULT_PRICE_ID,
  publicPaymentConfig,
  webhookSecretFor,
  verifyPaddleSignature,
  createPaddleTransaction,
  fetchPaddleTransaction,
  cancelPaddleTransaction,
  retirePaddleDraftTransaction,
  validateRetiredPaddleCheckoutTransaction,
  findPaddleCheckoutTransaction,
  fetchPaddleIpv4Cidrs,
  isPaddleWebhookAddress,
  validateCheckoutTransactionForRetirement,
  validateCompletedTransaction,
  validateSubscription,
  subscriptionCatalogTransition,
  createCustomerPortalSession,
  fullRevocationFromAdjustment
}=require("./payments");
const {validateRetiredCompletedTransaction,createLegacyCheckoutPolicy}=require("./legacy-checkout");
const {MANAGE_SUBSCRIPTIONS_URL}=require("./apple-billing");
const {cleanText}=require("./plans");

const ABANDONED_CHECKOUT_MS=30*60*1000;
const CHECKOUT_CREATION_CLAIM_MS=60*1000;
const PADDLE_IP_CACHE_MS=6*60*60*1000;
const PADDLE_TRANSACTION_STATUSES=new Set(["draft","ready","billed","paid","completed","canceled","past_due"]);
const PADDLE_STATUS_EVENTS=new Set([
  "transaction.created","transaction.ready","transaction.billed","transaction.paid",
  "transaction.past_due","transaction.payment_failed","transaction.canceled",
  "transaction.revised","transaction.updated"
]);
const PADDLE_CANCELABLE_STALE_STATUSES=new Set(["ready","billed"]);
/** @type {import("./domain-types").AppleSandboxPolicy} */
const PRODUCTION_ONLY_APPLE=Object.freeze({allowSandbox:false,sandboxAccounts:new Set()});
/** @param {unknown} value @param {number} [fallback] */
const eventTime=(value,fallback=Date.now())=>{const parsed=Date.parse(String(value||""));return Number.isFinite(parsed)?parsed:fallback;};

/**
 * Paddle checkout, entitlement, webhook, and account-deletion
 * reconciliation boundary. The composition root supplies account/session
 * policy and storage capabilities; provider details only point downward.
 * @param {import("./domain-types").BillingServiceDependencies} dependencies
 * @returns {import("./domain-types").BillingService}
 */
function createBillingService({
  store,paymentConfig,enforcePaddleIps,requestAddress,rateAllowed,
  isUniqueViolation,getAuth,getUserPayload,http,logger,
  appleSandbox=PRODUCTION_ONLY_APPLE,now=Date.now,makeId=randomUUID
}) {
  if(!store||!paymentConfig||typeof requestAddress!=="function"||typeof rateAllowed!=="function"||
    typeof isUniqueViolation!=="function"||typeof getAuth!=="function"||typeof getUserPayload!=="function"||
    !http||!logger) {
    throw new TypeError("Billing service requires storage, payment configuration, account policy, request guards, HTTP helpers, and a logger.");
  }
  const {json,bodyJson}=http;
  /** @type {{cidrs:string[];expiresAt:number;pending:Promise<string[]>|null}} */
  let paddleIpCache={cidrs:[],expiresAt:0,pending:null};

  function authService() {
    const service=getAuth();
    if(!service) throw new Error("Billing account policy is unavailable.");
    return service;
  }

  /** @param {unknown} priceId */
  function legacyRecurringPrice(priceId) {
    return paymentConfig.legacyRecurringPriceIds.includes(String(priceId||""));
  }

  function entitledRecurringPrices() {
    return [paymentConfig.priceId,...paymentConfig.legacyRecurringPriceIds];
  }

  /** @param {string} userId @param {number} [timestamp] */
  function hasCurrentPaidAccess(userId,timestamp=now()) {
    return store.hasEntitledPaidDiscoveryAccess(userId,entitledRecurringPrices(),paymentConfig.productId,timestamp);
  }

  // Strata+ is one entitlement however it was paid for: Paddle, Apple In-App Purchase, or an owner's grant.
  /** @param {string} userId @param {number} [timestamp] @param {import("./domain-types").AdminControlsRow|null} [knownControls] */
  async function hasCurrentAccess(userId,timestamp=now(),knownControls) {
    const [paid,apple,controls]=await Promise.all([hasCurrentPaidAccess(userId,timestamp),store.hasActiveAppleSubscription(userId,timestamp,appleSandbox),knownControls===undefined?store.adminControls(userId):knownControls]);
    return Boolean(paid||apple||adminGrantState(controls,timestamp).active);
  }

  /** @param {string} userId @param {number} [timestamp] */
  function accessSummaryForUser(userId,timestamp=now()) {
    return store.entitledDiscoveryAccessSummary(userId,entitledRecurringPrices(),paymentConfig.productId,timestamp);
  }

  /** @param {import("./domain-types").SubscriptionRow|null} row @param {number} [timestamp] */
  function subscriptionSummary(row,timestamp=now()) {
    if(!row)return null;
    const status=row.status,periodEndsAt=Number(row.current_period_ends_at),scheduledEndsAt=Number(row.scheduled_change_at);
    const scheduledTerminal=row.scheduled_change_action==="cancel"||row.scheduled_change_action==="pause";
    const active=["active","trialing","past_due"].includes(status)&&Number.isSafeInteger(periodEndsAt)&&periodEndsAt>timestamp&&(!scheduledTerminal||(Number.isSafeInteger(scheduledEndsAt)&&scheduledEndsAt>timestamp));
    return {
      id:row.subscription_id,status,active,
      pastDue:status==="past_due",
      scheduledChange:row.scheduled_change_action?{
        action:row.scheduled_change_action,effectiveAt:row.scheduled_change_at
      }:null,
      currentPeriodEndsAt:row.current_period_ends_at
    };
  }

  /** @param {string} userId */
  async function subscriptionForUser(userId) {
    return subscriptionSummary(await store.subscriptionForUser(userId));
  }

  async function currentPaddleIps() {
    const timestamp=now();
    if(paddleIpCache.cidrs.length&&paddleIpCache.expiresAt>timestamp)return paddleIpCache.cidrs;
    if(paddleIpCache.pending)return paddleIpCache.pending;
    paddleIpCache.pending=fetchPaddleIpv4Cidrs(paymentConfig)
      .then((cidrs)=>{
        paddleIpCache={cidrs,expiresAt:now()+PADDLE_IP_CACHE_MS,pending:null};
        return cidrs;
      })
      .finally(()=>{paddleIpCache.pending=null;});
    return paddleIpCache.pending;
  }

  /** @param {import("./domain-types").HttpRequest} req */
  async function webhookSourceAllowed(req) {
    if(!enforcePaddleIps)return true;
    let cidrs;
    try{cidrs=await currentPaddleIps();}
    catch{throw Object.assign(new Error("Webhook source verification is temporarily unavailable."),{status:503});}
    return isPaddleWebhookAddress(requestAddress(req),cidrs);
  }

  /** @param {string} message @param {string} [code] */
  function reconciliationError(message,code="PURCHASE_RECONCILIATION_UNAVAILABLE") {
    return authService().accountActionError(message,503,code);
  }

  const legacy=createLegacyCheckoutPolicy({store,paymentConfig,now,reconciliationError});
  const {purchaseCatalog,checkoutCatalog,validatePurchaseCheckoutForCancellation,migrateReusableDraft,completeCatalogMigration}=legacy;
  const {reconcileUnsettledPurchases}=createCheckoutReconciliation({store,paymentConfig,now,authService,legacy});

  /** @param {import("./domain-types").CheckoutClaimRow} claim @param {string|null} [expectedTransactionId] */
  async function releaseCheckoutClaim(claim,expectedTransactionId=null) {
    if(await store.releaseCheckoutCreation(claim.user_id,claim.claim_id,expectedTransactionId))return true;
    // A concurrent recovery may already have removed this claim. Preserve any
    // replacement or newly bound claim for the next reconciliation attempt.
    return !(await store.checkoutCreationForUser(claim.user_id));
  }

  /** @param {import("./domain-types").CheckoutClaimRow} claim @param {{retirement?:boolean}} [options] */
  async function transactionForCheckoutClaim(claim,{retirement=false}={}) {
    const legacy=claim.price_id===DEFAULT_PRICE_ID,current=claim.price_id===paymentConfig.priceId,legacyRecurring=legacyRecurringPrice(claim.price_id);
    if(!retirement&&!legacy&&!current&&!legacyRecurring)throw reconciliationError("STRATA could not safely validate an interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    const validationOptions={userId:claim.user_id,checkoutId:claim.claim_id,priceId:claim.price_id,productId:legacy?DEFAULT_PRODUCT_ID:paymentConfig.productId,retiredOneTimeCancellation:legacy};
    /** @type {import("./domain-types").PaddleFetchedTransactionResult|null} */
    let remote;
    try{
      remote=claim.transaction_id?await fetchPaddleTransaction(paymentConfig,claim.transaction_id):await findPaddleCheckoutTransaction(paymentConfig,{...validationOptions,createdAt:Number(claim.created_at),retirement});
      if(!remote&&legacy&&!retirement)remote=await findPaddleCheckoutTransaction(paymentConfig,{userId:claim.user_id,checkoutId:claim.claim_id,createdAt:Number(claim.created_at)});
    }catch{
      throw reconciliationError("STRATA could not safely confirm an interrupted Strata+ checkout. Please try again later.");
    }
    if(!remote)return null;
    const remoteCatalog=checkoutCatalog(remote,claim.user_id,claim.claim_id);
    const remotePriceId=cleanText(remote.data.items?.[0]?.price?.id,100);
    const retirementValidation=validateCheckoutTransactionForRetirement(remote.data,paymentConfig,{userId:claim.user_id,checkoutId:claim.claim_id,priceId:claim.price_id});
    const alreadyRetired=claim.transaction_id===remote.transactionId&&validateRetiredPaddleCheckoutTransaction(remote.data).ok;
    const currentCatalogValid=Boolean(remoteCatalog)&&(!current||remoteCatalog==="current")&&(!legacyRecurring||remoteCatalog==="current"||remoteCatalog==="legacy-recurring"&&remotePriceId===claim.price_id);
    if(retirement?!currentCatalogValid&&!retirementValidation.ok&&!alreadyRetired:!currentCatalogValid){
      throw reconciliationError("STRATA could not safely validate an interrupted Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    }
    if(legacy&&remoteCatalog==="current"){
      const partial=await store.purchaseByTransaction(remote.transactionId);
      if(partial?.user_id!==claim.user_id||purchaseCatalog(partial)!=="retired")throw reconciliationError("STRATA could not safely match the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    }
    if(!claim.transaction_id){
      const recorded=await store.recordCheckoutCreationTransaction(claim.user_id,claim.claim_id,remote.transactionId,now());
      if(!recorded){
        const attached=await store.purchaseByTransaction(remote.transactionId);
        if(attached?.user_id!==claim.user_id){
          throw reconciliationError("The interrupted checkout changed while it was being recovered. Please try again.");
        }
      }
    }
    return remote;
  }

  /** @param {import("./domain-types").CheckoutClaimRow} claim @returns {Promise<import("./domain-types").CheckoutRecovery>} */
  async function recoverCheckoutCreation(claim) {
    const remote=await transactionForCheckoutClaim(claim);
    if(!remote){
      if(Number(claim.expires_at)>now())return {state:"waiting"};
      return await releaseCheckoutClaim(claim,null)?{state:"replace"}:{state:"waiting"};
    }
    let purchase=await store.purchaseByTransaction(remote.transactionId);
    if(purchase&&purchase.user_id!==claim.user_id){
      throw reconciliationError("STRATA could not safely attach an interrupted Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    }
    const remoteCatalog=checkoutCatalog(remote,claim.user_id,claim.claim_id);
    if(purchase&&!purchaseCatalog(purchase))throw reconciliationError("STRATA could not safely validate the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    if(remote.status==="canceled"){
      if(purchase&&!validatePurchaseCheckoutForCancellation(remote,purchase).ok)throw reconciliationError("STRATA could not safely match the canceled checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      if(purchase)await store.updatePurchaseStatus(remote.transactionId,"canceled",Math.max(now(),Number(purchase.updated_at)+1));
      return await releaseCheckoutClaim(claim,remote.transactionId)?{state:"replace"}:{state:"waiting"};
    }
    if(!purchase){
      const createdAt=eventTime(remote.data.created_at,Number(claim.created_at)||now());
      const updatedAt=Math.max(createdAt,eventTime(remote.data.updated_at,now()));
      try{
        purchase=await store.insertPendingPurchase({
          transactionId:remote.transactionId,userId:claim.user_id,priceId:remoteCatalog==="retired"?DEFAULT_PRICE_ID:remoteCatalog==="legacy-recurring"?claim.price_id:paymentConfig.priceId,
          productId:remoteCatalog==="retired"?DEFAULT_PRODUCT_ID:paymentConfig.productId,
          paddleStatus:remote.status,createdAt,updatedAt
        });
      }catch(error){
        if(!isUniqueViolation(error))throw error;
        purchase=await store.purchaseByTransaction(remote.transactionId);
      }
    }
    if(!purchase)return await store.activeAccountDeletion(claim.user_id,now())?{state:"deletion"}:{state:"blocked"};
    const sourceCatalog=purchaseCatalog(purchase);
    if(!sourceCatalog)throw reconciliationError("STRATA could not safely validate the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    if(remote.status==="draft"&&["retired","legacy-recurring"].includes(sourceCatalog))purchase=await migrateReusableDraft(remote,purchase);
    else if(remote.status==="ready"&&(sourceCatalog==="legacy-recurring"||(sourceCatalog==="retired"&&remoteCatalog==="current")))purchase=await migrateReusableDraft(remote,purchase);
    else if(sourceCatalog!==remoteCatalog&&remote.status!=="completed")throw reconciliationError("STRATA could not safely match the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    let entitled=false;
    if(remote.status==="completed"){
      if(["retired","legacy-recurring"].includes(sourceCatalog)&&remoteCatalog==="current")purchase=await completeCatalogMigration(remote,purchase,eventTime(remote.data.updated_at,now()));
      const legacy=remoteCatalog==="retired";
      const validation=legacy
        ?validateRetiredCompletedTransaction(remote.data,paymentConfig,{userId:claim.user_id,checkoutId:claim.claim_id})
        :validateCompletedTransaction(remote.data,paymentConfig,{priceId:purchase.price_id,productId:paymentConfig.productId});
      if(!validation.ok)throw reconciliationError("STRATA could not safely validate a completed Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      const completedAt=eventTime(remote.data.updated_at,now());
      const subscriptionId=legacy?null:cleanText(remote.data.subscription_id,100);
      const completed=await store.completePurchase(remote.transactionId,{customerId:cleanText(remote.data.customer_id,100)||null,subscriptionId,completedAt,updatedAt:completedAt});
      if(!completed||completed.subscription_id!==subscriptionId)throw reconciliationError("STRATA could not safely attach the completed Strata+ subscription. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      entitled=await hasCurrentPaidAccess(claim.user_id);
    }else if(sourceCatalog==="retired"&&remoteCatalog==="retired"&&PADDLE_CANCELABLE_STALE_STATUSES.has(remote.status)){
      try{await cancelPaddleTransaction(paymentConfig,remote.transactionId);}catch{throw reconciliationError("STRATA could not safely close the retired checkout. Please try again later.");}
      await store.updatePurchaseStatus(remote.transactionId,"canceled",Math.max(now(),Number(purchase.updated_at)+1));
      return await releaseCheckoutClaim(claim,remote.transactionId)?{state:"replace"}:{state:"waiting"};
    }else if(purchase.paddle_status!==remote.status){
      await store.updatePurchaseStatus(remote.transactionId,remote.status,Math.max(now(),Number(purchase.updated_at)+1));
    }
    const released=await releaseCheckoutClaim(claim,remote.transactionId);
    if(remote.status==="completed"){
      if(entitled)return {state:"entitled"};
      // Paddle may deliver transaction.completed before subscription.created.
      // Keep the completed purchase as a durable barrier so a retry cannot
      // open a second subscription while ownership is still being linked.
      return released?{state:"pending"}:{state:"waiting"};
    }
    if(!released)return {state:"waiting"};
    if(remote.status==="draft"||remote.status==="ready")return {state:"transaction",transactionId:remote.transactionId};
    return {state:"pending"};
  }

  /** @param {string} userId @param {string} [expectedClaimId] */
  async function reconcileCheckoutCreationBeforeDeletion(userId,expectedClaimId) {
    const claim=await store.checkoutCreationForUser(userId);
    if(!claim)return 0;
    if(expectedClaimId&&claim.claim_id!==expectedClaimId)return 1;
    const remote=await transactionForCheckoutClaim(claim,{retirement:true});
    if(!remote){
      if(Number(claim.expires_at)<=now())return await releaseCheckoutClaim(claim,null)?0:1;
      return 1;
    }
    let purchase=await store.purchaseByTransaction(remote.transactionId);
    if(purchase&&purchase.user_id!==userId){
      throw reconciliationError("STRATA could not safely attach an interrupted Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
    }
    const sourceCatalog=purchase?purchaseCatalog(purchase):"",checkoutId=cleanText(remote.data.custom_data?.strata_checkout_id,100),remoteCatalog=checkoutCatalog(remote,userId,checkoutId);
    const purchaseRetirement=purchase?validateCheckoutTransactionForRetirement(remote.data,paymentConfig,{userId,checkoutId,priceId:purchase.price_id,productId:purchase.product_id}):null;
    if(validateRetiredPaddleCheckoutTransaction(remote.data).ok){
      if(purchase){const retiredAt=Math.max(now(),Number(purchase.updated_at)+1,eventTime(remote.data.updated_at,now()));await store.revokePurchase(remote.transactionId,"checkout_disabled",retiredAt,retiredAt);}
      return await releaseCheckoutClaim(claim,remote.transactionId)?0:1;
    }
    if(remote.status==="canceled"){
      if(purchase&&!purchaseRetirement?.ok)throw reconciliationError("STRATA could not safely match the canceled checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      if(purchase)await store.updatePurchaseStatus(remote.transactionId,"canceled",Math.max(now(),Number(purchase.updated_at)+1));
      return await releaseCheckoutClaim(claim,remote.transactionId)?0:1;
    }
    if(remote.status==="draft"){
      const claimValidation=validateCheckoutTransactionForRetirement(remote.data,paymentConfig,{userId,checkoutId:claim.claim_id,priceId:claim.price_id});
      if(purchase?!purchaseRetirement?.ok:!claimValidation.ok)throw reconciliationError("STRATA could not safely match the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      let retired;
      try{retired=await retirePaddleDraftTransaction(paymentConfig,remote.transactionId);}
      catch{throw reconciliationError("STRATA could not safely disable an interrupted Strata+ checkout. Please try again later.");}
      if(purchase){
        const retiredAt=Math.max(now(),Number(purchase.updated_at)+1,eventTime(retired.data.updated_at,now()));
        await store.revokePurchase(remote.transactionId,"checkout_disabled",retiredAt,retiredAt);
      }
      return await releaseCheckoutClaim(claim,remote.transactionId)?0:1;
    }
    if(PADDLE_CANCELABLE_STALE_STATUSES.has(remote.status)){
      if(purchase&&!purchaseRetirement?.ok)throw reconciliationError("STRATA could not safely match the interrupted checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      try{await cancelPaddleTransaction(paymentConfig,remote.transactionId);}
      catch{throw reconciliationError("STRATA could not safely close an interrupted Strata+ checkout. Please try again later.");}
      if(purchase)await store.updatePurchaseStatus(remote.transactionId,"canceled",Math.max(now(),Number(purchase.updated_at)+1));
      return await releaseCheckoutClaim(claim,remote.transactionId)?0:1;
    }
    if(remote.status==="completed"){
      if(purchase&&!sourceCatalog)throw reconciliationError("STRATA could not safely validate the completed checkout catalog. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      if(purchase&&["retired","legacy-recurring"].includes(sourceCatalog)&&remoteCatalog==="current")purchase=await completeCatalogMigration(remote,purchase,eventTime(remote.data.updated_at,now()));
      const legacy=remoteCatalog==="retired";
      const validation=legacy
        ?sourceCatalog&&sourceCatalog!=="retired"?{ok:false}:validateRetiredCompletedTransaction(remote.data,paymentConfig,{userId,checkoutId})
        :validateCompletedTransaction(remote.data,paymentConfig,remoteCatalog==="legacy-recurring"?{priceId:purchase?.price_id||claim.price_id,productId:paymentConfig.productId}:undefined);
      if(!validation.ok)throw reconciliationError("STRATA could not safely validate a completed Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      if(!purchase){
        const stamp=now();
        purchase=await store.recordClaimedPurchase({transactionId:remote.transactionId,userId,priceId:legacy?DEFAULT_PRICE_ID:remoteCatalog==="legacy-recurring"?claim.price_id:paymentConfig.priceId,productId:legacy?DEFAULT_PRODUCT_ID:paymentConfig.productId,paddleStatus:remote.status,createdAt:eventTime(remote.data.created_at,Number(claim.created_at)),updatedAt:stamp},claim.claim_id)||await store.purchaseByTransaction(remote.transactionId);
        if(!purchase||purchase.user_id!==userId)throw reconciliationError("STRATA could not safely attach the completed checkout to its account.","PURCHASE_RECONCILIATION_INVALID");
      }
      const completedAt=eventTime(remote.data.updated_at,now());
      const subscriptionId=legacy?null:cleanText(remote.data.subscription_id,100);
      const completed=await store.completePurchase(remote.transactionId,{customerId:cleanText(remote.data.customer_id,100)||null,subscriptionId,completedAt,updatedAt:completedAt});
      if(!completed||completed.subscription_id!==subscriptionId)throw reconciliationError("STRATA could not safely attach the completed Strata+ subscription. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      return await releaseCheckoutClaim(claim,remote.transactionId)?0:1;
    }
    const timestamp=now();
    await store.extendCheckoutCreation(userId,claim.claim_id,timestamp+CHECKOUT_CREATION_CLAIM_MS,timestamp);
    return 1;
  }

  /** @param {import("./domain-types").BillingWebhookEvent} event */
  async function processPaddleEvent(event) {
    const eventId=cleanText(event?.event_id,100);
    const eventType=cleanText(event?.event_type,100);
    const data=event?.data;
    if(!/^evt_[a-z0-9]{20,}$/.test(eventId)||!eventType||!data||typeof data!=="object"){
      throw Object.assign(new Error("Invalid Paddle event."),{status:400});
    }
    if(await store.webhookEvent(eventId))return "replayed";
    const occurredAt=eventTime(event.occurred_at,Number.NaN);
    if(!Number.isSafeInteger(occurredAt)||occurredAt<0){
      throw Object.assign(new Error("Invalid Paddle event timestamp."),{status:400});
    }
    const timestamp=now();
    let outcome="ignored";
    if(eventType==="transaction.completed"){
      const transactionId=cleanText(data.id,100);
      const purchase=await store.purchaseByTransaction(transactionId);
      const claimedUser=cleanText(data.custom_data?.strata_user_id,100);
      const checkoutId=cleanText(data.custom_data?.strata_checkout_id,100);
      const sourceCatalog=purchase?purchaseCatalog(purchase):"";
      const legacyValidation=sourceCatalog==="retired"?validateRetiredCompletedTransaction(data,paymentConfig,{userId:purchase?.user_id,checkoutId}):{ok:false,reason:"catalog"};
      const recurringValidation=sourceCatalog==="current"
        ?validateCompletedTransaction(data,paymentConfig)
        :sourceCatalog==="legacy-recurring"
          ?validateCompletedTransaction(data,paymentConfig,{priceId:purchase?.price_id,productId:paymentConfig.productId})
          :legacyValidation;
      const validation=recurringValidation;
      if(purchase&&["retired","legacy-recurring"].includes(sourceCatalog)&&validateCompletedTransaction(data,paymentConfig).ok&&claimedUser===purchase.user_id){
        const remote={transactionId,status:"completed",data};
        const completed=await completeCatalogMigration(remote,purchase,occurredAt);
        outcome=completed.subscription_id===cleanText(data.subscription_id,100)?"subscription-payment-recorded":"rejected:subscription-link";
      }else if(purchase&&validation.ok&&claimedUser===purchase.user_id){
        const subscriptionId=cleanText(data.subscription_id,100);
        const completed=await store.completePurchase(transactionId,{
          customerId:cleanText(data.customer_id,100)||null,subscriptionId:sourceCatalog==="retired"?null:subscriptionId,
          completedAt:eventTime(data.updated_at||event.occurred_at,timestamp),updatedAt:occurredAt
        });
        outcome=completed?.subscription_id===(sourceCatalog==="retired"?null:subscriptionId)?sourceCatalog==="retired"?"lifetime-payment-recorded":"subscription-payment-recorded":"rejected:subscription-link";
      }else outcome=purchase?`rejected:${validation.ok?"account":validation.reason}`:"ignored:unknown-transaction";
    }else if(eventType==="subscription.created"){
      const transactionId=cleanText(data.transaction_id,100);
      const purchase=await store.purchaseByTransaction(transactionId);
      const validation=validateSubscription(data,paymentConfig,{
        userId:purchase?.user_id,transactionId,requireTransaction:true
      });
      const catalogMatches=purchase&&validation.ok&&purchase.price_id===validation.priceId&&purchase.product_id===validation.productId;
      if(catalogMatches&&validation.ok){
        const saved=await store.createPaddleSubscription({
          subscriptionId:validation.subscriptionId,userId:purchase.user_id,transactionId,
          customerId:validation.customerId,status:validation.status,priceId:validation.priceId,
          productId:validation.productId,scheduledChangeAction:validation.scheduledChangeAction,
          scheduledChangeAt:validation.scheduledChangeAt,currentPeriodEndsAt:validation.currentPeriodEndsAt,
          eventOccurredAt:occurredAt,createdAt:occurredAt,updatedAt:timestamp
        });
        outcome=saved?(validation.entitled?"subscription-created":"subscription-catalog-changed"):"rejected:subscription-link";
      }else outcome=purchase?`rejected:${validation.ok?"catalog":validation.reason}`:"ignored:unknown-transaction";
    }else if(eventType==="subscription.updated"){
      const subscriptionId=cleanText(data.id,100);
      const existing=await store.subscriptionById(subscriptionId);
      const validation=validateSubscription(data,paymentConfig,{userId:existing?.user_id});
      if(existing&&validation.ok&&validation.customerId===existing.customer_id){
        const update={
          subscriptionId,userId:existing.user_id,customerId:validation.customerId,status:validation.status,
          priceId:validation.priceId,productId:validation.productId,
          scheduledChangeAction:validation.scheduledChangeAction,scheduledChangeAt:validation.scheduledChangeAt,
          currentPeriodEndsAt:validation.currentPeriodEndsAt,eventOccurredAt:occurredAt,updatedAt:timestamp
        };
        const linkedPurchase=await store.purchaseByTransaction(existing.transaction_id),ownedPurchase=linkedPurchase?.user_id===existing.user_id&&linkedPurchase.subscription_id===existing.subscription_id?linkedPurchase:null;
        const transition=subscriptionCatalogTransition(existing,ownedPurchase,validation,paymentConfig);
        if(transition==="reject")outcome="rejected:catalog";
        else{
        const migratingPurchase=transition==="migrate"?ownedPurchase:null;
        const saved=migratingPurchase
          ?await store.updatePaddleSubscriptionCatalog(existing,migratingPurchase,update)
          :await store.updatePaddleSubscription(update);
        if(migratingPurchase&&!saved){
          const [latest,latestPurchase]=await Promise.all([store.subscriptionById(subscriptionId),store.purchaseByTransaction(existing.transaction_id)]);
          if(latest&&latestPurchase?.subscription_id===latest.subscription_id&&latestPurchase.price_id===latest.price_id&&latestPurchase.product_id===latest.product_id&&Number(latest.event_occurred_at)>=occurredAt)outcome="subscription-stale";
          else throw Object.assign(new Error("Subscription catalog migration conflicted. Please retry."),{status:503,code:"SUBSCRIPTION_CATALOG_MIGRATION_PENDING"});
        }else outcome=saved?(validation.entitled?"subscription-updated":"subscription-catalog-changed"):"subscription-stale";
        }
      }else if(!existing){
        // Updates can arrive before subscription.created. A retry after the
        // creation link is stored is safer than acknowledging and losing the
        // newer state forever.
        throw Object.assign(new Error("Subscription ownership is still being linked. Please retry."),{status:503,code:"SUBSCRIPTION_LINK_PENDING"});
      }else outcome=`rejected:${validation.ok?"customer":validation.reason}`;
    }else if(PADDLE_STATUS_EVENTS.has(eventType)){
      const transactionId=cleanText(data.id,100);
      const transactionStatus=cleanText(data.status,40);
      if(transactionStatus!=="completed"&&PADDLE_TRANSACTION_STATUSES.has(transactionStatus)&&await store.purchaseByTransaction(transactionId)){
        await store.updatePurchaseStatus(transactionId,transactionStatus,occurredAt);
        outcome="updated";
      }
    }else if(eventType==="adjustment.created"||eventType==="adjustment.updated"){
      const adjustmentId=cleanText(data.id,100);
      const transactionId=cleanText(data.transaction_id,100);
      const purchase=transactionId?await store.purchaseByTransaction(transactionId):null;
      if(adjustmentId&&transactionId&&purchase){
        const existing=await store.adjustmentById(adjustmentId);
        if(existing&&existing.transaction_id!==transactionId)outcome="rejected:adjustment-transaction";
        else{
          const adjustmentApplied=await store.upsertAdjustment({
            adjustmentId,transactionId,action:cleanText(data.action,40),type:cleanText(data.type,40),
            status:cleanText(data.status,40),occurredAt,updatedAt:timestamp
          });
          const revocation=fullRevocationFromAdjustment(data);
          if(revocation&&adjustmentApplied){
            await store.revokePurchase(transactionId,revocation.reason,occurredAt,timestamp);
            outcome="revoked";
          }else outcome="adjustment-recorded";
        }
      }
    }
    await store.recordWebhookEvent({
      eventId,notificationId:cleanText(event.notification_id,100)||null,eventType,
      occurredAt,processedAt:now()
    });
    return outcome;
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function handleWebhook(req,res) {
    if(req.method!=="POST"){
      json(res,405,{error:"Method not allowed."},{Allow:"POST"});
      return;
    }
    if(!await webhookSourceAllowed(req)){
      json(res,403,{error:"Webhook source rejected."});
      return;
    }
    const secret=webhookSecretFor(paymentConfig);
    if(!secret){json(res,503,{error:"Webhook is not configured."});return;}
    const rawBody=await readBodyBuffer(req,MAX_WEBHOOK_BYTES);
    if(!verifyPaddleSignature(rawBody,req.headers["paddle-signature"],secret)){
      json(res,400,{error:"Invalid webhook signature."});
      return;
    }
    /** @type {import("./domain-types").BillingWebhookEvent} */
    let event;
    try{event=JSON.parse(rawBody.toString("utf8"));}
    catch{json(res,400,{error:"Invalid JSON."});return;}
    const outcome=await processPaddleEvent(event);
    json(res,200,{ok:true,outcome});
  }

  /** @param {import("./domain-types").HttpResponse} res */
  function retiredTrial(res) {
    // Installed apps from earlier builds may still offer the old trial button.
    json(res,410,{error:"The free Strata+ trial is no longer offered. Subscribe to use Strata+.",code:"TRIAL_RETIRED"});
  }

  // Never take a second payment: a member whose Strata+ comes from the App Store is told so.
  /** @param {import("./domain-types").HttpResponse} res @param {string} userId */
  async function alreadyEntitled(res,userId) {
    if(await store.hasActiveAppleSubscription(userId,now(),appleSandbox))json(res,409,{error:"You already have Strata+ through the App Store.",code:"ALREADY_ENTITLED_APP_STORE"});
    else json(res,409,{error:"Strata+ is already unlocked for this account.",code:"ALREADY_ENTITLED"});
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function beginCheckout(req,res) {
    const auth=authService();
    const session=await auth.requireSession(req,res);if(!session)return;
    if(!auth.validCsrf(req,session)){
      json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return;
    }
    await bodyJson(req);
    if((await store.adminControls(session.id))?.checkout_blocked_at){json(res,403,{error:"New payment sessions are disabled for this account. Contact support.",code:"CHECKOUT_BLOCKED"});return;}
    if(!paymentConfig.enabled){json(res,503,{error:"Checkout is not available yet.",code:"CHECKOUT_UNAVAILABLE"});return;}
    if(await store.activeAccountDeletion(session.id,now())){
      json(res,409,{error:"Cancel the pending account-deletion request before starting checkout.",code:"ACCOUNT_DELETION_PENDING"});return;
    }
    if(!await rateAllowed(req,`checkout:${session.id}`,8)){
      json(res,429,{error:"Too many checkout attempts. Try again later."});return;
    }
    if(await hasCurrentAccess(session.id)){
      await alreadyEntitled(res,session.id);return;
    }
    /** @param {number} status @param {import("./domain-types").JsonObject} data */
    const sendCheckout=async(status,data)=>{if(await checkoutAllowed())json(res,status,data);};
    const checkoutAllowed=async()=>{
      if(!await auth.requireSession(req,res))return false;
      const controls=await store.adminControls(session.id);
      if(controls?.checkout_blocked_at!=null){json(res,403,{error:"New payment sessions are disabled for this account. Contact support.",code:"CHECKOUT_BLOCKED"});return false;}
      if(await hasCurrentAccess(session.id,now(),controls)){await alreadyEntitled(res,session.id);return false;}
      if(await store.activeAccountDeletion(session.id,now())){json(res,409,{error:"Cancel account deletion before starting checkout.",code:"ACCOUNT_DELETION_PENDING"});return false;}
      return true;
    };
    const interrupted=await store.checkoutCreationForUser(session.id);
    if(interrupted){
      const recovery=await recoverCheckoutCreation(interrupted);
      if(recovery.state==="transaction"){
        await sendCheckout(200,{transactionId:recovery.transactionId,reused:true,recovered:true});return;
      }
      if(recovery.state==="entitled"){
        await alreadyEntitled(res,session.id);return;
      }
      if(recovery.state==="deletion"){
        json(res,409,{error:"Cancel the pending account-deletion request before starting checkout.",code:"ACCOUNT_DELETION_PENDING"});return;
      }
      if(recovery.state==="pending"||recovery.state==="blocked"){
        json(res,409,{error:"A previous Strata+ payment is still being confirmed. Please wait before starting another checkout.",code:"CHECKOUT_PENDING_CONFIRMATION"});return;
      }
      if(recovery.state==="waiting"){
        json(res,409,{error:"Another checkout is already being prepared. Please try again in a moment.",code:"CHECKOUT_PREPARING"});return;
      }
    }
    const claimedAt=now(),claimId=makeId();
    const claim=await store.claimCheckoutCreation({
      userId:session.id,priceId:paymentConfig.priceId,claimId,
      expiresAt:claimedAt+CHECKOUT_CREATION_CLAIM_MS,now:claimedAt
    });
    if(!claim){
      const pending=await store.pendingPurchaseForUser(session.id,paymentConfig.priceId);
      if(pending){await sendCheckout(200,{transactionId:pending.transaction_id,reused:true});return;}
      json(res,409,{error:"Another checkout is already being prepared. Please try again in a moment.",code:"CHECKOUT_PREPARING"});return;
    }
    let preserveClaim=false;
    /** @type {string|null} */
    let releaseTransactionId=null;
    try{
      if(await store.activeAccountDeletion(session.id,now())){
        json(res,409,{error:"Cancel the pending account-deletion request before starting checkout.",code:"ACCOUNT_DELETION_PENDING"});return;
      }
      if(await hasCurrentAccess(session.id)){
        await alreadyEntitled(res,session.id);return;
      }
      let pending=await store.pendingPurchaseForUser(session.id,paymentConfig.priceId);
      if(pending&&Number(pending.updated_at)>now()-ABANDONED_CHECKOUT_MS){
        await sendCheckout(200,{transactionId:pending.transaction_id,reused:true});return;
      }
      if(await store.pendingPurchasesForUser(session.id)>0){
        await reconcileUnsettledPurchases(session.id,{reuseDraft:true});
        if(await hasCurrentAccess(session.id)){
          await alreadyEntitled(res,session.id);return;
        }
        pending=await store.pendingPurchaseForUser(session.id,paymentConfig.priceId);
        if(pending){await sendCheckout(200,{transactionId:pending.transaction_id,reused:true});return;}
        if(await store.pendingPurchasesForUser(session.id)>0){
          json(res,409,{error:"A previous Strata+ payment is still being confirmed. Please wait before starting another checkout.",code:"CHECKOUT_PENDING_CONFIRMATION"});return;
        }
      }
      // Once Paddle accepts create, retain this durable claim until a retry can
      // discover and bind the provider transaction by stable checkout ID.
      if(!await checkoutAllowed())return;
      preserveClaim=true;
      const created=await createPaddleTransaction(paymentConfig,{userId:session.id,checkoutId:claimId});
      releaseTransactionId=created.transactionId;
      const timestamp=now();
      const recorded=await store.recordCheckoutCreationTransaction(session.id,claimId,created.transactionId,timestamp);
      if(!recorded){
        if(!await checkoutAllowed())return;
        const recoveredPurchase=await store.purchaseByTransaction(created.transactionId);
        if(recoveredPurchase?.user_id===session.id){
          preserveClaim=false;
          await sendCheckout(201,{transactionId:created.transactionId,recovered:true});return;
        }
        throw reconciliationError("STRATA could not safely record the prepared Strata+ checkout. Please try again later.");
      }
      let storedPurchase;
      try{
        storedPurchase=await store.insertPendingPurchase({
          transactionId:created.transactionId,userId:session.id,priceId:paymentConfig.priceId,
          productId:paymentConfig.productId,paddleStatus:created.status,createdAt:timestamp,updatedAt:timestamp
        });
      }catch(error){
        if(isUniqueViolation(error))storedPurchase=await store.purchaseByTransaction(created.transactionId);
        if(storedPurchase?.user_id!==session.id)throw error;
        if(!storedPurchase)throw error;
      }
      if(!storedPurchase)storedPurchase=await store.recordClaimedPurchase({transactionId:created.transactionId,userId:session.id,priceId:paymentConfig.priceId,productId:paymentConfig.productId,paddleStatus:created.status,createdAt:timestamp,updatedAt:timestamp},claimId);
      if(!storedPurchase){
        if(await store.activeAccountDeletion(session.id,now())){
          json(res,409,{error:"Checkout could not be attached because account deletion is pending. Cancel deletion and try again.",code:"ACCOUNT_DELETION_PENDING"});return;
        }
        json(res,409,{error:"A previous Strata+ payment is still being confirmed. Please wait before starting another checkout.",code:"CHECKOUT_PENDING_CONFIRMATION"});return;
      }
      if(storedPurchase.user_id!==session.id){
        throw reconciliationError("STRATA could not safely attach the prepared Strata+ checkout. Please contact support.","PURCHASE_RECONCILIATION_INVALID");
      }
      preserveClaim=false;
      await sendCheckout(201,{transactionId:created.transactionId});
    }finally{
      try{
        if(preserveClaim){
          const timestamp=now();
          await store.extendCheckoutCreation(session.id,claimId,timestamp+CHECKOUT_CREATION_CLAIM_MS,timestamp);
        }else{
          const released=await releaseCheckoutClaim(claim,releaseTransactionId);
          if(!released)logger.error("billing.checkout_claim_release_race",{userId:session.id,transactionId:releaseTransactionId});
        }
      }catch(error){
        logger.error(preserveClaim?"billing.checkout_claim_extend_failed":"billing.checkout_claim_release_failed",{error});
      }
    }
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function openPortal(req,res) {
    const auth=authService();
    const session=await auth.requireSession(req,res);if(!session)return;
    if(!auth.validCsrf(req,session)){
      json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return;
    }
    await bodyJson(req);
    const subscription=await store.subscriptionForUser(session.id);
    if(!subscription){
      // Strata+ bought in the iOS app is managed by Apple; Paddle's portal has nothing to show for it.
      if((await store.appleSubscriptionsForUser(session.id)).length){
        json(res,409,{error:"Your Strata+ subscription is managed by the App Store. Manage it in Settings on your iPhone.",code:"APP_STORE_MANAGED",manageUrl:MANAGE_SUBSCRIPTIONS_URL});return;
      }
      json(res,404,{error:"No Strata+ monthly subscription was found for this account.",code:"SUBSCRIPTION_NOT_FOUND"});return;
    }
    if(!await rateAllowed(req,`billing-portal:${session.id}`,10,15*60*1000)){
      json(res,429,{error:"Too many subscription-management requests. Try again later."});return;
    }
    const links=await createCustomerPortalSession(paymentConfig,{
      customerId:subscription.customer_id,subscriptionId:subscription.subscription_id
    });
    json(res,200,{...links,subscription:subscriptionSummary(subscription)},{"Cache-Control":"private, no-store"});
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function handleApi(req,res,url) {
    if(url.pathname==="/api/billing/config"&&req.method==="GET"){
      json(res,200,publicPaymentConfig(paymentConfig));return true;
    }
    if(url.pathname==="/api/discovery/trial"&&req.method==="POST"){
      retiredTrial(res);return true;
    }
    if(url.pathname==="/api/billing/checkout"&&req.method==="POST"){
      await beginCheckout(req,res);return true;
    }
    if(url.pathname==="/api/billing/subscription"&&req.method==="GET"){
      const session=await authService().requireSession(req,res);if(session){
        json(res,200,{subscription:await subscriptionForUser(session.id)},{"Cache-Control":"private, no-store"});
      }
      return true;
    }
    if(url.pathname==="/api/billing/portal"&&req.method==="POST"){
      await openPortal(req,res);return true;
    }
    return false;
  }

  async function warmProviderTrust() {
    if(enforcePaddleIps)await currentPaddleIps();
  }

  return {
    handleApi,handleWebhook,hasCurrentAccess,accessSummaryForUser,reconcileCheckoutCreationBeforeDeletion,
    reconcileUnsettledPurchases,subscriptionForUser,warmProviderTrust
  };
}

module.exports={createBillingService};
