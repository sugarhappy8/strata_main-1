"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {randomUUID}=require("node:crypto");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {Readable}=require("node:stream");
const {DatabaseSync}=require("node:sqlite");
const {createStore}=require("../src/database");
const {APPLE_ROOT_CA_G3_FINGERPRINT}=require("../src/apple-jws");
const {
  DELETION_NOTICE,MANAGE_SUBSCRIPTIONS_URL,appleBillingSettings,appleSubscriptionSummary,createAppleBillingService,
  nextAppleState,validateAppleRenewal,validateAppleTransaction
}=require("../src/apple-billing");
const {createAppleTestChain}=require("./support/apple-test-chain");

const ROOT=join(__dirname,"..");
const RUNTIME=join(ROOT,"test-runtime");
const BUNDLE="online.stratafitness.app";
const PRODUCT="online.stratafitness.app.plus.monthly";
const DAY=24*60*60*1000;
const chain=createAppleTestChain();
const settings=appleBillingSettings({NODE_ENV:"test",APPLE_ROOT_FINGERPRINT:chain.rootFingerprint});
// The throwaway chain's certificates start at the second they were made, so every signed date sits a minute ahead
// (inside the verifier's five-minute clock allowance) to stay inside their validity.
const BASE=Date.now()+60_000;

function transaction(overrides={}){
  const now=BASE;
  return {
    transactionId:"2000000001",originalTransactionId:"2000000000",bundleId:BUNDLE,productId:PRODUCT,
    purchaseDate:now-DAY,originalPurchaseDate:now-DAY,expiresDate:now+29*DAY,type:"Auto-Renewable Subscription",
    inAppOwnershipType:"PURCHASED",signedDate:now-1000,environment:"Sandbox",...overrides
  };
}
function renewal(overrides={}){
  return {originalTransactionId:"2000000000",autoRenewProductId:PRODUCT,productId:PRODUCT,autoRenewStatus:1,signedDate:BASE-1000,environment:"Sandbox",...overrides};
}
function notification(type,{subtype,tx,renew,uuid=randomUUID(),signedDate=BASE-500,bundleId=BUNDLE}={}){
  const data={bundleId,environment:"Sandbox"};
  if(tx)data.signedTransactionInfo=chain.signJws(tx);
  if(renew)data.signedRenewalInfo=chain.signJws(renew);
  return {notificationType:type,...(subtype?{subtype}:{}),notificationUUID:uuid,version:"2.0",signedDate,data};
}

function fakeTursoClient(){
  const database=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true});
  async function execute(statement){
    const sql=typeof statement==="string"?statement:statement.sql,args=typeof statement==="string"?[]:(statement.args||[]);
    const prepared=database.prepare(sql);
    if(/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql)||/\bRETURNING\b/i.test(sql)){
      const objects=prepared.all(...args),columns=prepared.columns().map((column)=>column.name);
      return {columns,rows:objects.map((row)=>columns.map((column)=>row[column])),rowsAffected:0};
    }
    const result=prepared.run(...args);return {columns:[],rows:[],rowsAffected:Number(result.changes)};
  }
  return {execute,async batch(statements){
    database.exec("BEGIN IMMEDIATE");
    try{const results=[];for(const statement of statements)results.push(await execute(statement));database.exec("COMMIT");return results;}
    catch(error){database.exec("ROLLBACK");throw error;}
  },close(){database.close();}};
}

async function withStore(kind,run){
  mkdirSync(RUNTIME,{recursive:true});
  const directory=mkdtempSync(join(RUNTIME,"apple-billing-"));
  const previous=Object.fromEntries(["NODE_ENV","STRATA_DATA_DIR","TURSO_DATABASE_URL","TURSO_AUTH_TOKEN"].map((key)=>[key,process.env[key]]));
  let store;
  try{
    process.env.NODE_ENV="test";
    if(kind==="turso"){
      delete process.env.STRATA_DATA_DIR;process.env.TURSO_DATABASE_URL="https://apple-billing.invalid";process.env.TURSO_AUTH_TOKEN="apple-test-token";
      store=await createStore(ROOT,{tursoClientFactory:fakeTursoClient});
    }else{
      process.env.STRATA_DATA_DIR=directory;delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
      store=await createStore(ROOT);
    }
    await run(store);
  }finally{
    await store?.close();
    for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;
    rmSync(directory,{recursive:true,force:true});
  }
}

async function addUser(store,id=randomUUID()){
  await store.insertUser({id,name:"Apple Member",email:`${id}@apple.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:Date.now(),emailVerifiedAt:Date.now()});
  return id;
}

function service(store,overrides={}){
  const responses=[],logs=[];
  const http={json(res,status,data,headers={}){responses.push({status,data,headers});res.status=status;res.body=data;}};
  const logger={debug(){},info(event,fields){logs.push({event,fields});},warn(event,fields){logs.push({event,fields});},error(event,fields){logs.push({event,fields});}};
  const auth={session:null,csrf:true,async requireSession(_req,res){if(!this.session){http.json(res,401,{error:"Sign in required."});return null;}return this.session;},validCsrf(){return this.csrf;}};
  const guards={origin:true,rate:true};
  const apple=createAppleBillingService({
    store,settings,getAuth:()=>auth,getUserPayload:async(session)=>({id:session.id,discovery:{apple:await apple.subscriptionForUser(session.id)}}),
    trustedOrigin:()=>guards.origin,rateAllowed:()=>guards.rate,http,logger,...overrides
  });
  return {apple,auth,guards,responses,logs};
}

function request(body,{method="POST"}={}){
  const req=Readable.from([Buffer.from(typeof body==="string"?body:JSON.stringify(body))]);
  return Object.assign(req,{method,headers:{"content-type":"application/json"}});
}
const TRANSACTIONS=new URL("https://stratafitness.online/api/billing/apple/transactions");

test("settings default to the STRATA app and only honor a test root under NODE_ENV=test",()=>{
  const defaults=appleBillingSettings({});
  assert.equal(defaults.bundleId,BUNDLE);assert.deepEqual(defaults.productIds,[PRODUCT]);
  assert.equal(defaults.rootFingerprint,APPLE_ROOT_CA_G3_FINGERPRINT);assert.equal(defaults.rootOverrideIgnored,false);
  const production=appleBillingSettings({NODE_ENV:"production",APPLE_ROOT_FINGERPRINT:chain.rootFingerprint});
  assert.equal(production.rootFingerprint,APPLE_ROOT_CA_G3_FINGERPRINT);assert.equal(production.rootOverrideIgnored,true);
  assert.equal(settings.rootFingerprint,chain.rootFingerprint);
  const listed=appleBillingSettings({APPLE_BUNDLE_ID:" com.example.app ",APPLE_IAP_PRODUCT_IDS:"a.monthly, b.yearly,a.monthly,"});
  assert.equal(listed.bundleId,"com.example.app");assert.deepEqual(listed.productIds,["a.monthly","b.yearly"]);
  assert.throws(()=>appleBillingSettings({APPLE_IAP_PRODUCT_IDS:"bad id"}),/App Store identifiers/);
  assert.throws(()=>appleBillingSettings({APPLE_BUNDLE_ID:"-bad"}),/App Store identifiers/);
});

test("transactions must be a Strata+ subscription of this app with a linked account",()=>{
  const userId=randomUUID();
  const valid=validateAppleTransaction(transaction({appAccountToken:userId.toUpperCase(),revocationReason:1,revocationDate:Date.now()}),settings);
  assert.equal(valid.ok,true);
  assert.equal(valid.ok&&valid.transaction.appAccountToken,userId);
  assert.equal(valid.ok&&valid.transaction.revocationReason,1);
  for(const [overrides,reason] of [
    [{bundleId:"com.other.app"},"bundle"],[{productId:"online.stratafitness.app.coins"},"product"],[{environment:"Xcode"},"environment"],
    [{type:"Consumable"},"type"],[{transactionId:"bad id!"},"identifier"],[{originalTransactionId:""},"identifier"],
    [{expiresDate:undefined},"dates"],[{signedDate:"soon"},"dates"],[{appAccountToken:"not-a-uuid"},"account-token"]
  ])assert.deepEqual(validateAppleTransaction(transaction(overrides),settings),{ok:false,reason},JSON.stringify(overrides));
  const numeric=validateAppleTransaction(transaction({transactionId:2000000009,purchaseDate:String(Date.now())}),settings);
  assert.equal(numeric.ok&&numeric.transaction.transactionId,"2000000009");
  const tx=valid.ok?valid.transaction:null;assert.ok(tx);
  assert.deepEqual(validateAppleRenewal(renewal({gracePeriodExpiresDate:123456}),tx),{autoRenew:true,gracePeriodExpiresAt:123456});
  assert.deepEqual(validateAppleRenewal(renewal({autoRenewStatus:0}),tx),{autoRenew:false,gracePeriodExpiresAt:null});
  assert.deepEqual(validateAppleRenewal(renewal({autoRenewStatus:"x"}),tx),{autoRenew:null,gracePeriodExpiresAt:null});
  assert.equal(validateAppleRenewal(renewal({originalTransactionId:"9"}),tx),null);
  assert.equal(validateAppleRenewal(renewal({environment:"Production"}),tx),null);
});

test("state transitions never move backwards and keep the current period on older refunds",()=>{
  const now=Date.now(),userId="member";
  const parse=(overrides)=>{const result=validateAppleTransaction(transaction(overrides),settings);assert.ok(result.ok);return result.transaction;};
  const first=nextAppleState(null,{userId,transaction:parse({}),signedAt:now-1000,now});
  assert.ok(first);assert.equal(first.autoRenew,null);assert.equal(first.revokedAt,null);
  const row={original_transaction_id:first.originalTransactionId,user_id:userId,product_id:first.productId,environment:first.environment,latest_transaction_id:first.latestTransactionId,purchased_at:first.purchasedAt,original_purchased_at:first.originalPurchasedAt,expires_at:first.expiresAt,revoked_at:null,revocation_reason:null,auto_renew:1,grace_period_expires_at:now+DAY,last_signed_at:first.lastSignedAt,created_at:now-5000,updated_at:now-5000};
  assert.equal(nextAppleState(row,{userId,transaction:parse({}),signedAt:now-2000,now}),null);
  const olderPeriod=parse({transactionId:"1999",expiresDate:now-10*DAY,revocationDate:now-100,revocationReason:0});
  const refundOld=nextAppleState(row,{userId,transaction:olderPeriod,type:"REFUND",signedAt:now,now});
  assert.ok(refundOld);assert.equal(refundOld.revokedAt,null);assert.equal(refundOld.latestTransactionId,"2000000001");assert.equal(refundOld.expiresAt,row.expires_at);
  assert.equal(refundOld.autoRenew,true);assert.equal(refundOld.gracePeriodExpiresAt,now+DAY);assert.equal(refundOld.createdAt,now-5000);
  const revoked=nextAppleState(row,{userId,transaction:parse({}),type:"REVOKE",signedAt:now,now});
  assert.equal(revoked?.revokedAt,now);assert.equal(revoked?.revocationReason,"family_sharing");
  const refunded=nextAppleState(row,{userId,transaction:parse({revocationDate:now-50}),type:"REFUND",signedAt:now,now});
  assert.equal(refunded?.revokedAt,now-50);assert.equal(refunded?.revocationReason,"refund");
  const renewed=nextAppleState(row,{userId,transaction:parse({transactionId:"2000000002",expiresDate:now+60*DAY}),signedAt:now,now});
  assert.equal(renewed?.gracePeriodExpiresAt,null);assert.equal(renewed?.latestTransactionId,"2000000002");
  const failed=nextAppleState(row,{userId,transaction:parse({}),renewal:{autoRenew:true,gracePeriodExpiresAt:now+DAY},type:"DID_FAIL_TO_RENEW",signedAt:now,now});
  assert.equal(failed?.gracePeriodExpiresAt,null);
});

test("the discovery summary prefers the subscription that gives access",()=>{
  const now=Date.now();
  assert.equal(appleSubscriptionSummary([],now),null);
  const base={user_id:"u",product_id:PRODUCT,environment:"Sandbox",latest_transaction_id:"1",purchased_at:now-DAY,original_purchased_at:now-DAY,revoked_at:null,revocation_reason:null,auto_renew:0,grace_period_expires_at:null,last_signed_at:now,created_at:now,updated_at:now};
  const expired={...base,original_transaction_id:"a",expires_at:now-DAY,updated_at:now+5};
  const grace={...base,original_transaction_id:"b",expires_at:now-1000,grace_period_expires_at:now+DAY,auto_renew:1,environment:"Production"};
  assert.deepEqual(appleSubscriptionSummary([expired,grace],now),{active:true,productId:PRODUCT,expiresAt:now-1000,autoRenew:true,inGracePeriod:true,environment:"Production",revoked:false});
  assert.deepEqual(appleSubscriptionSummary([{...expired,revoked_at:now,auto_renew:null}],now),{active:false,productId:PRODUCT,expiresAt:now-DAY,autoRenew:null,inGracePeriod:false,environment:"Sandbox",revoked:true});
});

for(const kind of ["local","turso"]){
  test(`${kind}: App Store notifications link, renew, enter grace, expire, refund, and dedupe`,async()=>withStore(kind,async(store)=>{
    const {apple}=service(store);
    const userId=await addUser(store),now=BASE;
    const tx=(overrides={})=>transaction({appAccountToken:userId,...overrides});
    assert.equal(await apple.processNotification(notification("TEST")),"test");
    assert.equal(await apple.processNotification(notification("PRICE_INCREASE",{tx:tx()})),"ignored:type");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED")),"ignored:no-transaction");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{tx:tx(),bundleId:"com.other"})),"ignored:bundle");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{tx:tx({productId:"other.product"})})),"ignored:product");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{tx:transaction({appAccountToken:randomUUID()})})),"ignored:unlinked");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{tx:transaction()})),"ignored:unlinked");
    assert.equal(await apple.processNotification({notificationType:"SUBSCRIBED",notificationUUID:"nope",signedDate:now}),"ignored:malformed");
    assert.equal(await store.hasActiveAppleSubscription(userId,now),false);

    const subscribedId=randomUUID();
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{subtype:"INITIAL_BUY",tx:tx(),renew:renewal(),uuid:subscribedId,signedDate:now-4000})),"applied");
    assert.equal(await apple.processNotification(notification("SUBSCRIBED",{tx:tx(),renew:renewal(),uuid:subscribedId.toUpperCase(),signedDate:now-4000})),"replayed");
    assert.equal(await store.hasActiveAppleSubscription(userId,now),true);
    assert.deepEqual(await apple.subscriptionForUser(userId),{active:true,productId:PRODUCT,expiresAt:tx().expiresDate,autoRenew:true,inGracePeriod:false,environment:"Sandbox",revoked:false});

    const renewedExpiry=now+59*DAY;
    assert.equal(await apple.processNotification(notification("DID_RENEW",{tx:tx({transactionId:"2000000002",expiresDate:renewedExpiry}),renew:renewal(),signedDate:now-3000})),"applied");
    assert.equal(await apple.processNotification(notification("DID_CHANGE_RENEWAL_STATUS",{subtype:"AUTO_RENEW_DISABLED",tx:tx(),renew:renewal({autoRenewStatus:0}),signedDate:now-3500})),"stale");
    let summary=await apple.subscriptionForUser(userId);
    assert.equal(summary?.expiresAt,renewedExpiry);assert.equal(summary?.autoRenew,true);

    assert.equal(await apple.processNotification(notification("DID_FAIL_TO_RENEW",{subtype:"GRACE_PERIOD",tx:tx({transactionId:"2000000002",expiresDate:now-120_000}),renew:renewal({gracePeriodExpiresDate:now+6*DAY}),signedDate:now-2000})),"applied");
    summary=await apple.subscriptionForUser(userId);
    assert.equal(summary?.active,true);assert.equal(summary?.inGracePeriod,true);
    assert.equal(await store.hasActiveAppleSubscription(userId,now),true);

    assert.equal(await apple.processNotification(notification("GRACE_PERIOD_EXPIRED",{tx:tx({transactionId:"2000000002",expiresDate:now-120_000}),renew:renewal({gracePeriodExpiresDate:now+6*DAY}),signedDate:now-1800})),"applied");
    assert.equal(await store.hasActiveAppleSubscription(userId,now),false);
    assert.equal((await apple.subscriptionForUser(userId))?.inGracePeriod,false);

    assert.equal(await apple.processNotification(notification("DID_RENEW",{tx:tx({transactionId:"2000000003",expiresDate:now+30*DAY}),renew:renewal(),signedDate:now-1500})),"applied");
    assert.equal(await store.hasActiveAppleSubscription(userId,now),true);
    assert.equal(await apple.processNotification(notification("REFUND",{tx:tx({transactionId:"2000000003",expiresDate:now+30*DAY,revocationDate:now-1200,revocationReason:1}),signedDate:now-1200})),"applied");
    summary=await apple.subscriptionForUser(userId);
    assert.equal(summary?.active,false);assert.equal(summary?.revoked,true);
    assert.equal(await apple.processNotification(notification("REFUND_REVERSED",{tx:tx({transactionId:"2000000003",expiresDate:now+30*DAY}),signedDate:now-1000})),"applied");
    assert.equal((await apple.subscriptionForUser(userId))?.active,true);
    assert.equal(await apple.processNotification(notification("EXPIRED",{subtype:"VOLUNTARY",tx:tx({transactionId:"2000000003",expiresDate:now-120_000}),renew:renewal({autoRenewStatus:0}),signedDate:now-600})),"applied");
    summary=await apple.subscriptionForUser(userId);
    assert.equal(summary?.active,false);assert.equal(summary?.autoRenew,false);
    assert.equal(await apple.deletionNotice(userId),null);

    const forged={...notification("DID_RENEW",{signedDate:now}),data:{bundleId:BUNDLE,signedTransactionInfo:"a.b.c"}};
    await assert.rejects(apple.processNotification(forged),(error)=>error.status===400&&error.code==="APPLE_SIGNATURE_INVALID");
    const before=await store.appleNotification(subscribedId);
    assert.ok(before);
    await store.deleteOldAppleNotifications(Date.now()+1);
    assert.equal(await store.appleNotification(subscribedId),null);
  }));
}

test("signed transactions from the app grant access only to the account that bought them",async()=>withStore("local",async(store)=>{
  const {apple,auth,guards,responses}=service(store);
  const userId=await addUser(store),otherId=await addUser(store),now=BASE;
  const sign=(overrides={})=>chain.signJws(transaction({appAccountToken:userId,...overrides}));
  const post=async(body)=>{const res={};await apple.handleApi(request(body),res,TRANSACTIONS);return responses.at(-1);};

  assert.equal(await apple.handleApi(request({}),{},new URL("https://stratafitness.online/api/billing/config")),false);
  assert.equal(await apple.handleApi(request({},{method:"GET"}),{},TRANSACTIONS),true);
  assert.equal(responses.at(-1).status,405);
  assert.equal((await post({signedTransactions:[sign()]})).status,401);
  auth.session={id:userId};
  guards.origin=false;assert.equal((await post({signedTransactions:[sign()]})).data.code,"APPLE_ORIGIN_REQUIRED");guards.origin=true;
  auth.csrf=false;assert.equal((await post({signedTransactions:[sign()]})).data.code,"INVALID_CSRF");auth.csrf=true;
  guards.rate=false;assert.equal((await post({signedTransactions:[sign()]})).status,429);guards.rate=true;

  for(const [body,code,status] of [
    [{signedTransactions:[]},"APPLE_TRANSACTION_INVALID",400],[{signedTransactions:"x"},"APPLE_TRANSACTION_INVALID",400],
    [{signedTransactions:Array.from({length:21},()=>sign())},"APPLE_TRANSACTION_INVALID",400],
    [{signedTransactions:[sign({productId:"online.stratafitness.app.other"})]},"APPLE_TRANSACTION_INVALID",400],
    [{signedTransactions:[sign({bundleId:"com.other.app"})]},"APPLE_TRANSACTION_INVALID",400],
    [{signedTransactions:[chain.signJws(transaction())]},"APPLE_TRANSACTION_INVALID",400],
    [{signedTransactions:[sign({appAccountToken:otherId})]},"APPLE_ACCOUNT_MISMATCH",403],
    [{signedTransactions:[`${sign().slice(0,-4)}AAAA`]},"APPLE_SIGNATURE_INVALID",400]
  ])await assert.rejects(apple.handleApi(request(body),{},TRANSACTIONS),(error)=>error.status===status&&error.code===code,JSON.stringify(body).slice(0,80));
  await assert.rejects(apple.handleApi(request("{not json"),{},TRANSACTIONS),(error)=>error.status===400&&error.code==="INVALID_JSON");
  const foreign=createAppleTestChain();
  await assert.rejects(apple.handleApi(request({signedTransactions:[foreign.signJws(transaction({appAccountToken:userId}))]}),{},TRANSACTIONS),(error)=>error.code==="APPLE_ROOT_UNTRUSTED");
  assert.equal(await store.hasActiveAppleSubscription(userId,now),false);

  const accepted=await post({signedTransactions:[sign(),sign({transactionId:"2000000001",signedDate:now-5000})]});
  assert.equal(accepted.status,200);assert.deepEqual(accepted.data.accepted,["2000000001"]);
  assert.equal(accepted.data.discovery.apple.active,true);assert.equal(accepted.headers["Cache-Control"],"private, no-store");
  assert.equal((await post({signedTransactions:[sign({signedDate:now-9000})]})).status,200);
  assert.ok(await apple.deletionNotice(userId));
  assert.deepEqual(await apple.deletionNotice(userId),{message:DELETION_NOTICE,manageUrl:MANAGE_SUBSCRIPTIONS_URL});

  auth.session={id:otherId};
  await assert.rejects(apple.handleApi(request({signedTransactions:[chain.signJws(transaction({appAccountToken:otherId,transactionId:"2000000050"}))]}),{},TRANSACTIONS),(error)=>error.status===409&&error.code==="APPLE_PURCHASE_OTHER_ACCOUNT");

  // Once the first account's subscription is spent, a newer purchase by the same Apple ID for another account moves it.
  const spent=await store.appleSubscription("2000000000");
  await store.upsertAppleSubscription({originalTransactionId:"2000000000",userId,productId:PRODUCT,environment:"Sandbox",latestTransactionId:"2000000001",purchasedAt:spent?.purchased_at??null,originalPurchasedAt:null,expiresAt:now-DAY,revokedAt:null,revocationReason:null,autoRenew:false,gracePeriodExpiresAt:null,lastSignedAt:now,createdAt:now,updatedAt:now});
  const moved=await post({signedTransactions:[chain.signJws(transaction({appAccountToken:otherId,transactionId:"2000000060",purchaseDate:now,signedDate:now+1}))]});
  assert.equal(moved.status,200);assert.equal((await store.appleSubscription("2000000000"))?.user_id,otherId);
  assert.equal(await store.hasActiveAppleSubscription(otherId,now),true);
  assert.equal(await store.hasActiveAppleSubscription(userId,now),false);
}));

test("App Store Server Notifications are verified, rate-limited, and acknowledged with an empty body",async()=>withStore("local",async(store)=>{
  const {apple,guards,responses,logs}=service(store);
  const userId=await addUser(store);
  const res={};
  await apple.handleNotification(request({},{method:"GET"}),res);assert.equal(responses.at(-1).status,405);
  guards.rate=false;await apple.handleNotification(request({}),res);assert.equal(responses.at(-1).status,429);guards.rate=true;
  await assert.rejects(apple.handleNotification(request({}),res),(error)=>error.status===400&&error.code==="APPLE_SIGNATURE_INVALID");
  await assert.rejects(apple.handleNotification(request({signedPayload:"x.y.z"}),res),(error)=>error.status===400);
  await apple.handleNotification(request({signedPayload:chain.signJws(notification("SUBSCRIBED",{tx:transaction({appAccountToken:userId}),renew:renewal()}))}),res);
  assert.deepEqual(responses.at(-1),{status:200,data:{},headers:{}});
  assert.deepEqual(logs.at(-1),{event:"apple.notification",fields:{outcome:"applied"}});
  assert.equal(await store.hasActiveAppleSubscription(userId,Date.now()),true);
  await apple.cleanup();
  assert.throws(()=>createAppleBillingService({store}),/requires storage/);
  const warnings=service(store,{settings:appleBillingSettings({NODE_ENV:"production",APPLE_ROOT_FINGERPRINT:chain.rootFingerprint})}).logs;
  assert.deepEqual(warnings,[{event:"apple.root_override_ignored",fields:{}}]);
}));
