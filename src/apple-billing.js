// @ts-check
"use strict";

// Strata+ bought through Apple In-App Purchase inside the STRATA iOS app. The app sends the StoreKit 2 signed
// transactions it receives (purchase, restore, launch-time entitlements) and the App Store sends Server Notifications V2.
// Both are App Store JWS verified by src/apple-jws.js; the server never trusts an unsigned claim from the device.
const {APPLE_ROOT_CA_G3_FINGERPRINT,AppleJwsError,verifyAppleJws}=require("./apple-jws");
const {MAX_WEBHOOK_BYTES,bodyBuffer}=require("./http");

const DEFAULT_BUNDLE_ID="online.stratafitness.app";
const DEFAULT_PRODUCT_IDS=Object.freeze(["online.stratafitness.app.plus.monthly"]);
const MANAGE_SUBSCRIPTIONS_URL="https://apps.apple.com/account/subscriptions";
const DELETION_NOTICE="Deleting your STRATA account does not cancel a Strata+ subscription bought through Apple. Apple keeps billing your Apple Account until you cancel it in Settings > Apple ID > Subscriptions.";
const MAX_TRANSACTIONS=20;
const TRANSACTION_REQUESTS_PER_WINDOW=30;
const NOTIFICATIONS_PER_WINDOW=600;
const NOTIFICATION_RETENTION_MS=30*24*60*60*1000;
const ENVIRONMENTS=new Set(["Production","Sandbox"]);
const STORE_IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const APPLE_IDENTIFIER=/^[A-Za-z0-9._-]{1,64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT=/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
// Notification types that change a subscription's state. TEST is acknowledged; everything else is acknowledged and ignored.
const STATE_NOTIFICATIONS=new Set([
  "SUBSCRIBED","DID_RENEW","DID_CHANGE_RENEWAL_STATUS","DID_CHANGE_RENEWAL_PREF","DID_FAIL_TO_RENEW","GRACE_PERIOD_EXPIRED",
  "EXPIRED","REFUND","REVOKE","REFUND_REVERSED","RENEWAL_EXTENDED","OFFER_REDEEMED"
]);
const GRACE_ENDING_NOTIFICATIONS=new Set(["EXPIRED","GRACE_PERIOD_EXPIRED","DID_RENEW"]);

/** @param {string} message @param {number} status @param {string} code */
function appleError(message,status,code){return Object.assign(new Error(message),{status,code});}
/** @param {unknown} value @returns {number|null} */
function time(value){const number=typeof value==="number"?value:typeof value==="string"&&value.trim()?Number(value):Number.NaN;return Number.isSafeInteger(number)&&number>0?number:null;}
/** @param {unknown} value @param {RegExp} pattern */
function identifier(value,pattern=APPLE_IDENTIFIER){const text=typeof value==="number"&&Number.isSafeInteger(value)?String(value):typeof value==="string"?value:"";return pattern.test(text)?text:"";}

/**
 * Apple settings from the environment. APPLE_ROOT_FINGERPRINT replaces the pinned Apple Root CA - G3 only under
 * NODE_ENV=test, so tests can sign with a throwaway chain and production can never be pointed at another root.
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {import("./domain-types").AppleBillingSettings}
 */
function appleBillingSettings(environment=process.env){
  const bundleId=String(environment.APPLE_BUNDLE_ID||"").trim()||DEFAULT_BUNDLE_ID;
  const listed=[...new Set(String(environment.APPLE_IAP_PRODUCT_IDS||"").split(",").map((item)=>item.trim()).filter(Boolean))];
  const productIds=listed.length?listed:[...DEFAULT_PRODUCT_IDS];
  if(!STORE_IDENTIFIER.test(bundleId)||productIds.some((id)=>!STORE_IDENTIFIER.test(id)))throw new TypeError("APPLE_BUNDLE_ID and APPLE_IAP_PRODUCT_IDS must be App Store identifiers.");
  const override=String(environment.APPLE_ROOT_FINGERPRINT||"").trim().toUpperCase();
  const testRoot=environment.NODE_ENV==="test"&&FINGERPRINT.test(override);
  return Object.freeze({bundleId,productIds:Object.freeze(productIds),rootFingerprint:testRoot?override:APPLE_ROOT_CA_G3_FINGERPRINT,rootOverrideIgnored:Boolean(override)&&!testRoot});
}

/**
 * Checks a decoded StoreKit 2 transaction against this app's bundle and Strata+ products.
 * @param {Record<string,any>} payload
 * @param {import("./domain-types").AppleBillingSettings} settings
 * @returns {{ok:true,transaction:import("./domain-types").AppleTransaction}|{ok:false,reason:string}}
 */
function validateAppleTransaction(payload,settings){
  if(payload.bundleId!==settings.bundleId)return {ok:false,reason:"bundle"};
  if(typeof payload.productId!=="string"||!settings.productIds.includes(payload.productId))return {ok:false,reason:"product"};
  if(!ENVIRONMENTS.has(payload.environment))return {ok:false,reason:"environment"};
  if(payload.type!==undefined&&payload.type!=="Auto-Renewable Subscription")return {ok:false,reason:"type"};
  const transactionId=identifier(payload.transactionId),originalTransactionId=identifier(payload.originalTransactionId);
  if(!transactionId||!originalTransactionId)return {ok:false,reason:"identifier"};
  const purchaseDate=time(payload.purchaseDate),expiresDate=time(payload.expiresDate),signedDate=time(payload.signedDate);
  if(!purchaseDate||!expiresDate||!signedDate)return {ok:false,reason:"dates"};
  const token=typeof payload.appAccountToken==="string"?payload.appAccountToken.trim().toLowerCase():"";
  if(token&&!UUID.test(token))return {ok:false,reason:"account-token"};
  const reasonCode=Number.isSafeInteger(payload.revocationReason)?Number(payload.revocationReason):null;
  return {ok:true,transaction:{
    transactionId,originalTransactionId,productId:payload.productId,environment:payload.environment,
    purchaseDate,originalPurchaseDate:time(payload.originalPurchaseDate),expiresDate,signedDate,
    revocationDate:time(payload.revocationDate),revocationReason:reasonCode,appAccountToken:token||null
  }};
}

/**
 * Renewal info belongs to the same subscription and environment as its transaction, or it is ignored.
 * @param {Record<string,any>} payload @param {import("./domain-types").AppleTransaction} transaction
 * @returns {import("./domain-types").AppleRenewal|null}
 */
function validateAppleRenewal(payload,transaction){
  if(identifier(payload.originalTransactionId)!==transaction.originalTransactionId)return null;
  if(payload.environment!==undefined&&payload.environment!==transaction.environment)return null;
  const status=Number(payload.autoRenewStatus);
  return {autoRenew:status===1?true:status===0?false:null,gracePeriodExpiresAt:time(payload.gracePeriodExpiresDate)};
}

/** @param {import("./domain-types").AppleSubscriptionRow} row @param {number} now */
function appleRowActive(row,now){
  return row.revoked_at==null&&(Number(row.expires_at||0)>now||Number(row.grace_period_expires_at||0)>now);
}

/** @param {number|null} reason @param {string|null} type */
function revocationReason(reason,type){
  if(reason===1)return "app_issue";
  if(reason===0)return "other";
  return type==="REVOKE"?"family_sharing":type==="REFUND"?"refund":null;
}

/**
 * The stored state after applying one signed transaction (and its renewal info, when a notification carries it).
 * Returns null when the data is older than what is already stored. A transaction for an earlier billing period
 * (for example a refund of last month) updates the signing clock and renewal state but not the current period.
 * @param {import("./domain-types").AppleSubscriptionRow|null} existing
 * @param {{userId:string,transaction:import("./domain-types").AppleTransaction,renewal?:import("./domain-types").AppleRenewal|null,type?:string|null,subtype?:string|null,signedAt:number,now:number}} input
 * @returns {import("./domain-types").AppleSubscriptionWrite|null}
 */
function nextAppleState(existing,{userId,transaction,renewal=null,type=null,subtype=null,signedAt,now}){
  if(existing&&signedAt<Number(existing.last_signed_at))return null;
  const storedExpiry=existing?Number(existing.expires_at||0):0;
  const current=!existing||transaction.transactionId===existing.latest_transaction_id||transaction.expiresDate>=storedExpiry;
  const renewed=Boolean(existing)&&current&&transaction.expiresDate>storedExpiry;
  let revokedAt=current?transaction.revocationDate:existing?.revoked_at??null;
  let reason=current?transaction.revocationDate?revocationReason(transaction.revocationReason,type):null:existing?.revocation_reason??null;
  if(current&&revokedAt===null&&(type==="REFUND"||type==="REVOKE")){revokedAt=signedAt;reason=revocationReason(transaction.revocationReason,type);}
  let grace=renewal?renewal.gracePeriodExpiresAt:renewed?null:existing?.grace_period_expires_at??null;
  if(type&&GRACE_ENDING_NOTIFICATIONS.has(type))grace=null;
  if(type==="DID_FAIL_TO_RENEW"&&subtype!=="GRACE_PERIOD")grace=null;
  const autoRenew=renewal&&renewal.autoRenew!==null?renewal.autoRenew:existing?.auto_renew==null?null:Number(existing.auto_renew)===1;
  return {
    originalTransactionId:transaction.originalTransactionId,userId,
    productId:current?transaction.productId:String(existing?.product_id),
    environment:transaction.environment,
    latestTransactionId:current?transaction.transactionId:String(existing?.latest_transaction_id),
    purchasedAt:current?transaction.purchaseDate:existing?.purchased_at??null,
    originalPurchasedAt:transaction.originalPurchaseDate??existing?.original_purchased_at??null,
    expiresAt:current?transaction.expiresDate:existing?.expires_at??null,
    revokedAt,revocationReason:reason,autoRenew,gracePeriodExpiresAt:grace,
    lastSignedAt:Math.max(signedAt,Number(existing?.last_signed_at||0)),
    createdAt:existing?Number(existing.created_at):now,updatedAt:now
  };
}

/**
 * The member-facing Apple summary for /api/me "discovery.apple": the subscription giving access, else the latest one.
 * @param {import("./domain-types").AppleSubscriptionRow[]} rows @param {number} now
 * @returns {import("./domain-types").AppleSubscriptionSummary|null}
 */
function appleSubscriptionSummary(rows,now){
  const ranked=[...rows].sort((a,b)=>Number(appleRowActive(b,now))-Number(appleRowActive(a,now))||Number(b.expires_at||0)-Number(a.expires_at||0)||Number(b.updated_at)-Number(a.updated_at));
  const row=ranked[0];
  if(!row)return null;
  const expiresAt=row.expires_at==null?null:Number(row.expires_at),revoked=row.revoked_at!=null;
  return {
    active:appleRowActive(row,now),productId:String(row.product_id),expiresAt,
    autoRenew:row.auto_renew==null?null:Number(row.auto_renew)===1,
    inGracePeriod:!revoked&&(expiresAt??0)<=now&&Number(row.grace_period_expires_at||0)>now,
    environment:row.environment==="Sandbox"?"Sandbox":"Production",revoked
  };
}

/**
 * @param {import("./domain-types").AppleBillingServiceDependencies} dependencies
 * @returns {import("./domain-types").AppleBillingService}
 */
function createAppleBillingService({store,settings,getAuth,getUserPayload,trustedOrigin,rateAllowed,http,logger,now=Date.now,verify=verifyAppleJws}){
  if(!store||!settings||typeof getAuth!=="function"||typeof getUserPayload!=="function"||typeof trustedOrigin!=="function"||typeof rateAllowed!=="function"||!http||!logger){
    throw new TypeError("Apple billing requires storage, settings, account policy, request guards, HTTP helpers, and a logger.");
  }
  const {json}=http;
  if(settings.rootOverrideIgnored)logger.warn("apple.root_override_ignored",{});

  function authService(){
    const service=getAuth();
    if(!service)throw new Error("Apple billing account policy is unavailable.");
    return service;
  }

  /** @param {unknown} token @returns {Record<string,any>} */
  function verifySigned(token){
    try{return verify(String(token),{rootFingerprint:settings.rootFingerprint,now:now()});}
    catch(error){
      if(!(error instanceof AppleJwsError))throw error;
      throw appleError(error.message,400,error.code==="APPLE_ROOT_UNTRUSTED"?"APPLE_ROOT_UNTRUSTED":"APPLE_SIGNATURE_INVALID");
    }
  }

  /** @param {import("./domain-types").HttpRequest} req @returns {Promise<Record<string,any>>} */
  async function readJson(req){
    const raw=await bodyBuffer(req,MAX_WEBHOOK_BYTES);
    try{
      const value=JSON.parse(raw.toString("utf8"));
      if(value&&typeof value==="object"&&!Array.isArray(value))return value;
    }catch{/* Reported below as an invalid body. */}
    throw appleError("Invalid JSON.",400,"INVALID_JSON");
  }

  // A subscription stays with the account that bought it. It moves only when that link is spent (expired or revoked)
  // and the incoming transaction is a newer purchase made for the other account.
  /** @param {import("./domain-types").AppleSubscriptionRow|null} existing @param {string} userId @param {import("./domain-types").AppleTransaction} transaction */
  function ownership(existing,userId,transaction){
    if(!existing||existing.user_id===userId)return {allowed:true,replaceOwnerId:null};
    const spent=!appleRowActive(existing,now())&&(existing.revoked_at!=null||transaction.purchaseDate>=Number(existing.expires_at||0));
    return spent?{allowed:true,replaceOwnerId:existing.user_id}:{allowed:false,replaceOwnerId:null};
  }

  /**
   * @param {{existing:import("./domain-types").AppleSubscriptionRow|null,userId:string,replaceOwnerId:string|null,transaction:import("./domain-types").AppleTransaction,renewal?:import("./domain-types").AppleRenewal|null,type?:string|null,subtype?:string|null,signedAt:number}} input
   * @returns {Promise<"applied"|"stale"|"conflict"|"unlinked">}
   */
  async function apply({existing,userId,replaceOwnerId,transaction,renewal=null,type=null,subtype=null,signedAt}){
    const record=nextAppleState(replaceOwnerId?null:existing,{userId,transaction,renewal,type,subtype,signedAt,now:now()});
    if(!record)return "stale";
    if(replaceOwnerId&&existing&&signedAt<Number(existing.last_signed_at))return "stale";
    if(await store.upsertAppleSubscription(record,replaceOwnerId))return "applied";
    const latest=await store.appleSubscription(transaction.originalTransactionId);
    if(!latest)return "unlinked";
    return latest.user_id===userId?"stale":"conflict";
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function acceptTransactions(req,res){
    const auth=authService();
    const session=await auth.requireSession(req,res);if(!session)return;
    if(!trustedOrigin(req)){json(res,403,{error:"Purchase security check failed. Refresh and try again.",code:"APPLE_ORIGIN_REQUIRED"});return;}
    if(!auth.validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return;}
    if(!rateAllowed(req,`identity:apple-transactions:${session.id}`,TRANSACTION_REQUESTS_PER_WINDOW)){
      json(res,429,{error:"Too many purchase updates. Try again in a few minutes.",code:"APPLE_RATE_LIMIT"});return;
    }
    const tokens=(await readJson(req)).signedTransactions;
    if(!Array.isArray(tokens)||tokens.length<1||tokens.length>MAX_TRANSACTIONS||!tokens.every((token)=>typeof token==="string")){
      throw appleError(`Send between 1 and ${MAX_TRANSACTIONS} signed App Store transactions.`,400,"APPLE_TRANSACTION_INVALID");
    }
    const accountToken=String(session.id).toLowerCase(),transactions=[];
    for(const token of tokens){
      const result=validateAppleTransaction(verifySigned(token),settings);
      if(!result.ok)throw appleError("This App Store purchase is not a Strata+ subscription for this app.",400,"APPLE_TRANSACTION_INVALID");
      if(!result.transaction.appAccountToken)throw appleError("This App Store purchase is not linked to a STRATA account.",400,"APPLE_TRANSACTION_INVALID");
      if(result.transaction.appAccountToken!==accountToken)throw appleError("This App Store purchase belongs to a different STRATA account.",403,"APPLE_ACCOUNT_MISMATCH");
      transactions.push(result.transaction);
    }
    transactions.sort((a,b)=>a.signedDate-b.signedDate);
    for(const transaction of transactions){
      if(!ownership(await store.appleSubscription(transaction.originalTransactionId),session.id,transaction).allowed){
        throw appleError("This Apple subscription is already linked to another STRATA account.",409,"APPLE_PURCHASE_OTHER_ACCOUNT");
      }
    }
    /** @type {string[]} */
    const accepted=[];
    for(const transaction of transactions){
      const existing=await store.appleSubscription(transaction.originalTransactionId),owner=ownership(existing,session.id,transaction);
      const outcome=owner.allowed?await apply({existing,userId:session.id,replaceOwnerId:owner.replaceOwnerId,transaction,signedAt:transaction.signedDate}):"conflict";
      if(outcome==="conflict")throw appleError("This Apple subscription is already linked to another STRATA account.",409,"APPLE_PURCHASE_OTHER_ACCOUNT");
      if(outcome==="unlinked")throw appleError("The signed-in account changed. Sign in again and restore purchases.",409,"ACCOUNT_CHANGED");
      if(!accepted.includes(transaction.transactionId))accepted.push(transaction.transactionId);
    }
    logger.info("apple.transactions_accepted",{count:accepted.length});
    const user=await getUserPayload(session);
    json(res,200,{discovery:user.discovery,accepted},{"Cache-Control":"private, no-store"});
  }

  /** @param {Record<string,any>} payload @returns {Promise<string>} */
  async function processNotification(payload){
    const notificationUuid=typeof payload.notificationUUID==="string"?payload.notificationUUID.toLowerCase():"";
    const type=typeof payload.notificationType==="string"?payload.notificationType.slice(0,64):"";
    const subtype=typeof payload.subtype==="string"?payload.subtype.slice(0,64):null;
    const signedAt=time(payload.signedDate);
    if(!UUID.test(notificationUuid)||!type||!signedAt)return "ignored:malformed";
    if(await store.appleNotification(notificationUuid))return "replayed";
    const outcome=await notificationOutcome(payload,type,subtype,signedAt);
    await store.recordAppleNotification({notificationUuid,notificationType:type,subtype,outcome,signedAt,processedAt:now()});
    return outcome;
  }

  /** @param {Record<string,any>} payload @param {string} type @param {string|null} subtype @param {number} signedAt @returns {Promise<string>} */
  async function notificationOutcome(payload,type,subtype,signedAt){
    if(type==="TEST")return "test";
    if(!STATE_NOTIFICATIONS.has(type))return "ignored:type";
    const data=payload.data&&typeof payload.data==="object"?payload.data:null;
    if(!data||typeof data.signedTransactionInfo!=="string")return "ignored:no-transaction";
    if(data.bundleId!==settings.bundleId)return "ignored:bundle";
    const result=validateAppleTransaction(verifySigned(data.signedTransactionInfo),settings);
    if(!result.ok)return `ignored:${result.reason}`;
    const transaction=result.transaction;
    const renewal=typeof data.signedRenewalInfo==="string"?validateAppleRenewal(verifySigned(data.signedRenewalInfo),transaction):null;
    const existing=await store.appleSubscription(transaction.originalTransactionId);
    let userId=existing?.user_id||"",replaceOwnerId=null;
    const tokenOwner=transaction.appAccountToken&&transaction.appAccountToken!==existing?.user_id.toLowerCase()?await store.userById(transaction.appAccountToken):null;
    if(tokenOwner){
      const owner=ownership(existing,String(tokenOwner.id),transaction);
      if(!existing||owner.allowed){userId=String(tokenOwner.id);replaceOwnerId=owner.replaceOwnerId;}
    }
    if(!userId)return "ignored:unlinked";
    const outcome=await apply({existing,userId,replaceOwnerId,transaction,renewal,type,subtype,signedAt});
    return outcome==="unlinked"?"ignored:unlinked":outcome;
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function handleNotification(req,res){
    if(req.method!=="POST"){json(res,405,{error:"Method not allowed."},{Allow:"POST"});return;}
    if(!rateAllowed(req,"apple-notifications",NOTIFICATIONS_PER_WINDOW)){json(res,429,{error:"Too many notifications. Retry later."});return;}
    const signedPayload=(await readJson(req)).signedPayload;
    if(typeof signedPayload!=="string")throw appleError("The notification has no signedPayload.",400,"APPLE_SIGNATURE_INVALID");
    const outcome=await processNotification(verifySigned(signedPayload));
    logger.info("apple.notification",{outcome});
    json(res,200,{});
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function handleApi(req,res,url){
    if(url.pathname!=="/api/billing/apple/transactions")return false;
    if(req.method!=="POST"){json(res,405,{error:"Method not allowed."},{Allow:"POST"});return true;}
    await acceptTransactions(req,res);
    return true;
  }

  /** @param {string} userId */
  async function subscriptionForUser(userId){
    return appleSubscriptionSummary(await store.appleSubscriptionsForUser(userId),now());
  }

  // Apple bills until the member cancels with Apple, so deletion says so while a subscription is live or set to renew.
  /** @param {string} userId @returns {Promise<import("./domain-types").AppleDeletionNotice|null>} */
  async function deletionNotice(userId){
    const timestamp=now(),rows=await store.appleSubscriptionsForUser(userId);
    const billing=rows.some((row)=>row.revoked_at==null&&(Number(row.auto_renew)===1||appleRowActive(row,timestamp)));
    return billing?{message:DELETION_NOTICE,manageUrl:MANAGE_SUBSCRIPTIONS_URL}:null;
  }

  async function cleanup(){await store.deleteOldAppleNotifications(now()-NOTIFICATION_RETENTION_MS);}

  return Object.freeze({handleApi,handleNotification,processNotification,subscriptionForUser,deletionNotice,cleanup});
}

module.exports={
  DEFAULT_BUNDLE_ID,DEFAULT_PRODUCT_IDS,DELETION_NOTICE,MANAGE_SUBSCRIPTIONS_URL,
  appleBillingSettings,appleRowActive,appleSubscriptionSummary,createAppleBillingService,
  nextAppleState,validateAppleRenewal,validateAppleTransaction
};
