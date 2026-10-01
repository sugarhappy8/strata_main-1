"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const http=require("node:http");
const {spawn}=require("node:child_process");
const {createHmac}=require("node:crypto");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");

const PROJECT_ROOT=join(__dirname,"..");
const PRODUCT_ID="pro_01m1ky8j916ybyacs836dxbz8x";
const PRICE_ID="pri_01monthlyfixture00000000000000";
const LEGACY_PRICE_ID="pri_01m1kyc2zd313d7a3ssmg02424";
const CLIENT_TOKEN="live_browser_token_for_account_recovery_test";
const API_KEY="pdl_live_apikey_01accountrecoveryfixture0000_secret_123";
const WEBHOOK_SECRET="pdl_ntfset_live_account_recovery_test_secret";
const EMAIL_API_KEY="re_account_recovery_fixture_key_123456";
const EMAIL_SECRET="account-recovery-test-secret-that-is-long-enough-123";

let resend;
let paddle;
let app;
let resendBase;
let paddleBase;
let base;
let runtimeDir;
let appErrors="";
let transactionSequence=0;
let requestAddressOctet=10;
let malformedCancellationResponses=0;
let failedItemReplacementResponses=0;
let malformedItemReplacementResponses=0;
let invalidItemReplacementPrices=[];
let readyItemReplacementResponses=0;
let transactionListHook=null;
let transactionListResults=[];
const deliveries=[];
const paddleRequests=[];
const paddleTransactions=new Map();

function listen(server){
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      server.off("error",reject);
      const address=server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function readBody(req){
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function startResend(){
  resend=http.createServer(async(req,res)=>{
    const raw=await readBody(req);
    let body=null;
    try{body=raw?JSON.parse(raw):null;}catch{}
    deliveries.push({method:req.method,url:req.url,headers:{...req.headers},body});
    if(req.method!=="POST"||req.url!=="/emails"){
      res.writeHead(404,{"Content-Type":"application/json"});
      res.end(JSON.stringify({message:"not found"}));
      return;
    }
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({id:`email_${deliveries.length}`}));
  });
  resendBase=await listen(resend);
}

async function startPaddle(){
  paddle=http.createServer(async(req,res)=>{
    const raw=await readBody(req);
    let body=null;
    try{body=raw?JSON.parse(raw):null;}catch{}
    paddleRequests.push({method:req.method,url:req.url,headers:{...req.headers},body});
    if(req.method==="GET"&&req.url.startsWith("/transactions?")){
      if(transactionListHook){const hook=transactionListHook;transactionListHook=null;await hook();}
      const data=transactionListResults;transactionListResults=[];
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({data,meta:{pagination:{has_more:false}}}));
      return;
    }
    if(req.method==="GET"&&/^\/transactions\/txn_[a-z0-9]+$/.test(req.url)){
      const id=req.url.split("/").at(-1),transaction=paddleTransactions.get(id);
      res.writeHead(transaction?200:404,{"Content-Type":"application/json"});
      res.end(JSON.stringify(transaction?{data:transaction}:{error:{detail:"not found"}}));
      return;
    }
    if(req.method==="PATCH"&&/^\/transactions\/txn_[a-z0-9]+$/.test(req.url)){
      const id=req.url.split("/").at(-1),transaction=paddleTransactions.get(id);
      if(transaction?.status==="draft"&&body?.collection_mode==="manual"&&body?.billing_details?.enable_checkout===false&&body?.custom_data===null){
        transaction.collection_mode="manual";transaction.billing_details=body.billing_details;transaction.custom_data=null;transaction.checkout=null;transaction.updated_at=new Date().toISOString();
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({data:transaction}));return;
      }
      if(transaction?.status==="draft"&&Array.isArray(body?.items)&&body.items.length===1&&body.items[0]?.price_id===PRICE_ID&&body.items[0]?.quantity===1){
        if(failedItemReplacementResponses>0){failedItemReplacementResponses-=1;res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{detail:"temporary failure"}}));return;}
        const invalidPrice=invalidItemReplacementPrices.shift();
        transaction.items=[{quantity:1,price:{id:PRICE_ID,product_id:PRODUCT_ID,billing_cycle:{interval:"month",frequency:1},...(invalidPrice==="missing"?{}:{unit_price:{amount:invalidPrice==="wrong"?"99":"299",currency_code:"USD"}})}}];
        if(readyItemReplacementResponses>0){readyItemReplacementResponses-=1;transaction.status="ready";}
        transaction.updated_at=new Date().toISOString();
        if(malformedItemReplacementResponses>0){malformedItemReplacementResponses-=1;res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({data:{...transaction,status:"paid"}}));return;}
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({data:transaction}));
        return;
      }
      if(!transaction||!new Set(["ready","billed"]).has(transaction.status)||body?.status!=="canceled"){
        res.writeHead(409,{"Content-Type":"application/json"});
        res.end(JSON.stringify({error:{detail:"transaction cannot be canceled"}}));
        return;
      }
      if(malformedCancellationResponses>0){
        malformedCancellationResponses-=1;
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({data:{...transaction,status:"ready"}}));
        return;
      }
      transaction.status="canceled";
      transaction.updated_at=new Date().toISOString();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({data:transaction}));
      return;
    }
    if(req.method!=="POST"||req.url!=="/transactions"){
      res.writeHead(404,{"Content-Type":"application/json"});
      res.end(JSON.stringify({error:{detail:"not found"}}));
      return;
    }
    transactionSequence+=1;
    const id=`txn_${String(transactionSequence).padStart(26,"0")}`;
    const transaction=paddleTransactionFixture({
      id,userId:body?.custom_data?.strata_user_id,checkoutId:body?.custom_data?.strata_checkout_id,
      status:"ready",priceId:body?.items?.[0]?.price_id,quantity:body?.items?.[0]?.quantity
    });
    paddleTransactions.set(id,transaction);
    res.writeHead(201,{"Content-Type":"application/json"});
    res.end(JSON.stringify({data:transaction}));
  });
  paddleBase=await listen(paddle);
}

async function startApp(){
  mkdirSync(join(PROJECT_ROOT,"test-runtime"),{recursive:true});
  runtimeDir=mkdtempSync(join(PROJECT_ROOT,"test-runtime","account-recovery-"));
  app=spawn(process.execPath,["server.js"],{
    cwd:PROJECT_ROOT,
    env:{
      ...process.env,
      PORT:"0",HOST:"127.0.0.1",NODE_ENV:"test",TRUST_PROXY:"true",
      APP_BASE_URL:"http://127.0.0.1",
      TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,
      EMAIL_VERIFICATION_ENABLED:"true",RESEND_API_KEY:EMAIL_API_KEY,
      EMAIL_FROM:"STRATA <accounts@auth.stratafitness.online>",
      EMAIL_REPLY_TO:"stratafitness.official@gmail.com",
      EMAIL_VERIFICATION_SECRET:EMAIL_SECRET,RESEND_API_BASE:resendBase,
      PADDLE_PRODUCT_ID:PRODUCT_ID,PADDLE_PRICE_ID:PRICE_ID,
      PADDLE_CLIENT_TOKEN:CLIENT_TOKEN,PADDLE_API_KEY:API_KEY,
      PADDLE_WEBHOOK_SECRET:WEBHOOK_SECRET,PADDLE_CHECKOUT_ENABLED:"true",
      PADDLE_ENFORCE_IP_ALLOWLIST:"false",PADDLE_API_BASE:paddleBase
    },
    stdio:["ignore","pipe","pipe"]
  });
  base=await new Promise((resolve,reject)=>{
    let output="",settled=false;
    const timer=setTimeout(()=>finish(new Error(`Server startup timed out. ${appErrors}`)),5000);
    function finish(error,value){
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      error?reject(error):resolve(value);
    }
    app.stdout.on("data",(chunk)=>{
      output=(output+chunk.toString()).slice(-4096);
      const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if(match)finish(null,`http://127.0.0.1:${match[1]}`);
    });
    app.stderr.on("data",(chunk)=>{appErrors=(appErrors+chunk.toString()).slice(-8192);});
    app.once("error",finish);
    app.once("exit",(code,signal)=>finish(new Error(`Server exited before startup (${code??signal??"unknown"}). ${appErrors}`)));
  });
}

async function closeServer(server){
  if(!server?.listening)return;
  await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
}

async function stopApp(){
  const child=app;
  app=undefined;
  if(child&&child.exitCode===null&&child.signalCode===null){
    await new Promise((resolve)=>{
      let timer;
      child.once("exit",()=>{clearTimeout(timer);resolve();});
      child.kill("SIGTERM");
      timer=setTimeout(()=>child.kill("SIGKILL"),2000);
    });
  }
}

async function request(path,options={}){
  const response=await fetch(`${base}${path}`,options);
  const contentType=response.headers.get("content-type")||"";
  const data=contentType.includes("json")?await response.json():await response.text();
  return {response,data,setCookie:response.headers.get("set-cookie")||""};
}

function cookieValue(header,name){
  const match=String(header).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match?`${name}=${match[1]}`:"";
}

function jsonRequest(path,body,{cookie="",csrf="",method="POST",origin=true}={}){
  requestAddressOctet=requestAddressOctet%240+1;
  const headers={"Content-Type":"application/json","X-Forwarded-For":`198.51.100.${requestAddressOctet}`};
  if(origin)headers.Origin=base;
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers["X-CSRF-Token"]=csrf;
  return request(path,{method,headers,body:JSON.stringify(body)});
}

function verificationCode(delivery){
  const match=String(delivery?.body?.text||"").match(/code is ([0-9]{6})\./i);
  assert.ok(match,"verification delivery must contain a six-digit code");
  return match[1];
}

function actionToken(delivery){
  const match=String(delivery?.body?.text||"").match(/#token=([A-Za-z0-9_-]{43})/);
  assert.ok(match,"account-action delivery must contain a URL-fragment token");
  return match[1];
}

function latestDelivery(subject){
  const delivery=[...deliveries].reverse().find((item)=>item.body?.subject===subject);
  assert.ok(delivery,`expected email with subject: ${subject}`);
  return delivery;
}

async function verifiedSignup({name,email,password}){
  const before=deliveries.length;
  const signup=await jsonRequest("/api/signup",{name,email,password});
  assert.equal(signup.response.status,202);
  assert.equal(deliveries.length,before+1);
  const signupCookie=cookieValue(signup.setCookie,"strata_signup");
  assert.ok(signupCookie);
  const code=verificationCode(deliveries.at(-1));
  const verified=await jsonRequest("/api/verify-email",{code},{cookie:signupCookie});
  assert.equal(verified.response.status,201);
  const cookie=cookieValue(verified.setCookie,"strata_session");
  assert.ok(cookie);
  const me=await request("/api/me",{headers:{Cookie:cookie}});
  assert.equal(me.response.status,200);
  return {cookie,csrfToken:me.data.csrfToken,user:me.data.user,password};
}

async function login(email,password){
  return jsonRequest("/api/login",{email,password});
}

async function accountForCookie(cookie){
  const me=await request("/api/me",{headers:{Cookie:cookie}});
  assert.equal(me.response.status,200);
  return {cookie,csrfToken:me.data.csrfToken,user:me.data.user};
}

async function checkout(account){
  return jsonRequest("/api/billing/checkout",{},
    {cookie:account.cookie,csrf:account.csrfToken});
}

const DAY_MS=24*60*60*1000;
const PERIOD_START_AT=new Date(Date.now()-DAY_MS).toISOString();
const PERIOD_END_AT=new Date(Date.now()+31*DAY_MS).toISOString();
let eventSequence=0;
function subscriptionId(transactionId){return `sub_${String(transactionId).slice(4)}`;}
function eventId(label){
  eventSequence+=1;
  const safe=String(label).toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,8);
  return `evt_${safe}${String(eventSequence).padStart(24-safe.length,"0")}`;
}

function completedEvent(transactionId,userId,label="complete"){
  const occurredAt=new Date(Date.now()+eventSequence).toISOString();
  const id=eventId(label);
  return {
    event_id:id,
    event_type:"transaction.completed",
    occurred_at:occurredAt,
    notification_id:`ntf_${id.slice(4)}`,
    data:{
      id:transactionId,status:"completed",
      customer_id:"ctm_00000000000000000000000001",
      subscription_id:subscriptionId(transactionId),collection_mode:"automatic",origin:"api",updated_at:occurredAt,
      custom_data:{strata_user_id:userId,strata_checkout_id:paddleTransactions.get(transactionId)?.custom_data?.strata_checkout_id,strata_version:1},
      items:[{quantity:1,price:{id:PRICE_ID,product_id:PRODUCT_ID,billing_cycle:{interval:"month",frequency:1}}}],
      details:{totals:{subtotal:"299",discount:"0",tax:"0",total:"299"}}
    }
  };
}

function subscriptionEvent(transactionId,userId,{label="subscription",status="active",eventType="subscription.created"}={}){
  const id=eventId(label),occurredAt=new Date(Date.now()+eventSequence*1_000).toISOString();
  return {
    event_id:id,event_type:eventType,occurred_at:occurredAt,notification_id:`ntf_${id.slice(4)}`,
    data:{
      id:subscriptionId(transactionId),status,customer_id:"ctm_00000000000000000000000001",
      ...(eventType==="subscription.created"?{transaction_id:transactionId}:{}),
      collection_mode:"automatic",custom_data:{strata_user_id:userId,strata_version:1},
      billing_cycle:{interval:"month",frequency:1},
      items:[{quantity:1,recurring:true,price:{id:PRICE_ID,product_id:PRODUCT_ID,billing_cycle:{interval:"month",frequency:1}}}],
      scheduled_change:null,
      current_billing_period:["active","trialing","past_due"].includes(status)?{starts_at:PERIOD_START_AT,ends_at:PERIOD_END_AT}:null,
      updated_at:occurredAt
    }
  };
}

function adjustmentEvent(transactionId,label="partial"){
  const id=eventId(label);
  return {
    event_id:id,event_type:"adjustment.created",
    occurred_at:new Date(Date.now()+eventSequence).toISOString(),
    notification_id:`ntf_${id.slice(4)}`,
    data:{
      id:`adj_${String(eventSequence).padStart(24,"0")}`,
      transaction_id:transactionId,action:"refund",type:"partial",status:"approved"
    }
  };
}

function transactionStatusEvent(transactionId,status,label=status,eventType=`transaction.${status}`){
  const id=eventId(label);
  return {
    event_id:id,event_type:eventType,
    occurred_at:new Date(Date.now()+eventSequence).toISOString(),
    notification_id:`ntf_${id.slice(4)}`,
    data:{id:transactionId,status}
  };
}

async function signedWebhook(event){
  const raw=JSON.stringify(event);
  const timestamp=Math.floor(Date.now()/1000);
  const signature=createHmac("sha256",WEBHOOK_SECRET).update(`${timestamp}:${raw}`).digest("hex");
  return request("/api/paddle/webhook",{
    method:"POST",
    headers:{"Content-Type":"application/json","Paddle-Signature":`ts=${timestamp};h1=${signature}`},
    body:raw
  });
}

function database(options={}){
  return new DatabaseSync(join(runtimeDir,"strata.sqlite"),{timeout:5000,...options});
}

function paddleTransactionFixture({id,userId,checkoutId,status="ready",priceId=PRICE_ID,productId=PRODUCT_ID,quantity=1,billingCycle={interval:"month",frequency:1}}={}){
  const now=new Date().toISOString();
  return {
    id,status,customer_id:null,subscription_id:null,
    collection_mode:"automatic",origin:"api",created_at:now,updated_at:now,
    custom_data:{strata_user_id:userId,strata_checkout_id:checkoutId,strata_version:1},
    items:[{quantity:Number(quantity),price:{id:priceId,product_id:productId,billing_cycle:billingCycle,unit_price:{amount:"299",currency_code:"USD"}}}]
  };
}

function planFixture(){
  const days={Monday:[],Tuesday:[],Wednesday:[],Thursday:[],Friday:[],Saturday:[],Sunday:[]};
  days.Monday.push({instanceId:"recovery-plan-001",exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"});
  return {version:1,restDay:"Sunday",days};
}

const ratingFixture={comfort:5,pump:4,enjoyment:5,stability:4,setup:3,overall:5};
const preferencesFixture={
  goal:"strength",level:"Intermediate",days:4,
  equipment:["Dumbbells","Bodyweight"],preferences:["stable"],limitations:[]
};

test.before(async()=>{
  await startResend();
  await startPaddle();
  try{await startApp();}
  catch(error){
    await closeServer(resend);
    await closeServer(paddle);
    throw error;
  }
});

test.after(async()=>{
  await stopApp();
  await closeServer(resend);
  await closeServer(paddle);
  if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});
});

test("password recovery is private, preserves account data, and revokes every session",async()=>{
  const originalPassword="original-recovery-password-123";
  const resetPassword="forgotten-flow-password-456";
  const signedInPassword="signed-in-flow-password-789";
  const email="recover-me@example.test";
  const account=await verifiedSignup({name:"Recovery Lifter",email,password:originalPassword});

  const secondLogin=await login(email,originalPassword);
  assert.equal(secondLogin.response.status,200);
  const secondCookie=cookieValue(secondLogin.setCookie,"strata_session");
  assert.ok(secondCookie);

  const prepared=await checkout(account);
  assert.equal(prepared.response.status,201);
  const transactionId=prepared.data.transactionId;
  const completed=await signedWebhook(completedEvent(transactionId,account.user.id,"recover"));
  assert.equal(completed.response.status,200);
  assert.equal(completed.data.outcome,"subscription-payment-recorded");
  const linked=await signedWebhook(subscriptionEvent(transactionId,account.user.id,{label:"recover-sub"}));
  assert.equal(linked.data.outcome,"subscription-created");
  const adjustment=await signedWebhook(adjustmentEvent(transactionId,"recoveradj"));
  assert.equal(adjustment.response.status,200);
  assert.equal(adjustment.data.outcome,"adjustment-recorded");

  const plan=await jsonRequest("/api/plan",{plan:planFixture(),expectedPlanUpdatedAt:0},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  assert.equal(plan.response.status,200);
  const rating=await jsonRequest("/api/ratings/flat-dumbbell-press",{rating:ratingFixture},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  assert.equal(rating.response.status,200);
  const preferences=await jsonRequest("/api/preferences",{preferences:preferencesFixture},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  assert.equal(preferences.response.status,200);

  const beforeEmails=deliveries.length;
  const unknown=await jsonRequest("/api/password-reset/request",{email:"nobody-here@example.test"});
  const known=await jsonRequest("/api/password-reset/request",{email});
  assert.equal(unknown.response.status,202);
  assert.equal(known.response.status,202);
  assert.deepEqual(unknown.data,known.data,"forgot-password must not reveal whether an email is registered");
  assert.equal(deliveries.length,beforeEmails+1,"only a registered mailbox should receive a recovery email");
  const recoveryDelivery=latestDelivery("Reset your STRATA password");
  assert.deepEqual(recoveryDelivery.body.to,[email]);
  assert.equal(recoveryDelivery.headers.authorization,`Bearer ${EMAIL_API_KEY}`);
  const token=actionToken(recoveryDelivery);

  const tokenStatus=await jsonRequest("/api/password-reset/status",{token});
  assert.equal(tokenStatus.response.status,200);
  assert.equal(tokenStatus.data.active,true);
  assert.equal(tokenStatus.data.maskedEmail,"r******e@example.test");

  const reset=await jsonRequest("/api/password-reset/complete",{
    token,password:resetPassword,confirmation:resetPassword
  });
  assert.equal(reset.response.status,200);
  assert.equal(reset.data.ok,true);
  assert.match(reset.setCookie,/strata_session=;.*Max-Age=0/i);

  for(const cookie of [account.cookie,secondCookie]){
    const revoked=await request("/api/me",{headers:{Cookie:cookie}});
    assert.equal(revoked.response.status,401,"password reset must revoke every existing session");
  }
  const oldLogin=await login(email,originalPassword);
  assert.equal(oldLogin.response.status,401);
  const newLogin=await login(email,resetPassword);
  assert.equal(newLogin.response.status,200);
  const resetCookie=cookieValue(newLogin.setCookie,"strata_session");
  const resetAccount=await accountForCookie(resetCookie);
  assert.equal(resetAccount.user.id,account.user.id,"password reset must retain the account identity");
  assert.equal(resetAccount.user.discovery.active,true,"password reset must retain Discovery access");

  const restoredPlan=await request("/api/plan",{headers:{Cookie:resetCookie}});
  const restoredDiscovery=await request("/api/discovery",{headers:{Cookie:resetCookie}});
  assert.equal(restoredPlan.response.status,200);
  assert.deepEqual(restoredPlan.data.plan,plan.data.plan);
  assert.equal(restoredDiscovery.response.status,200);
  assert.equal(restoredDiscovery.data.ratings.user.length,1);
  assert.equal(restoredDiscovery.data.ratings.user[0].exercise_id,"flat-dumbbell-press");

  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM plans WHERE user_id=?").get(account.user.id).count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM preferences WHERE user_id=?").get(account.user.id).count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ratings WHERE user_id=?").get(account.user.id).count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE user_id=? AND transaction_id=?").get(account.user.id,transactionId).count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_adjustments WHERE transaction_id=?").get(transactionId).count,1);
    assert.ok(db.prepare("SELECT auth_version FROM users WHERE id=?").get(account.user.id).auth_version>=2);
    db.close();
  }

  const noCsrf=await jsonRequest("/api/account/password-reset/request",{}, {cookie:resetCookie});
  assert.equal(noCsrf.response.status,403);
  assert.equal(noCsrf.data.code,"INVALID_CSRF");
  const wrongCsrf=await jsonRequest("/api/account/password-reset/request",{}, {cookie:resetCookie,csrf:"wrong-token"});
  assert.equal(wrongCsrf.response.status,403);
  assert.equal(wrongCsrf.data.code,"INVALID_CSRF");
  const beforeSignedInEmail=deliveries.length;
  const signedInRequest=await jsonRequest("/api/account/password-reset/request",{},
    {cookie:resetCookie,csrf:resetAccount.csrfToken});
  assert.equal(signedInRequest.response.status,202);
  assert.equal(deliveries.length,beforeSignedInEmail+1);
  const signedInDelivery=deliveries.at(-1);
  assert.equal(signedInDelivery.body.subject,"Reset your STRATA password");
  assert.deepEqual(signedInDelivery.body.to,[email],"signed-in reset must always go to the registered email");

  const signedInToken=actionToken(signedInDelivery);
  const signedInReset=await jsonRequest("/api/password-reset/complete",{
    token:signedInToken,password:signedInPassword,confirmation:signedInPassword
  });
  assert.equal(signedInReset.response.status,200);
  assert.equal((await request("/api/me",{headers:{Cookie:resetCookie}})).response.status,401);
  assert.equal((await login(email,resetPassword)).response.status,401);
  const finalLogin=await login(email,signedInPassword);
  assert.equal(finalLogin.response.status,200);
  assert.equal(finalLogin.data.user.id,account.user.id);
  assert.equal(finalLogin.data.user.discovery.active,true);

  const replayedReset=await jsonRequest("/api/password-reset/complete",{
    token:signedInToken,password:"another-password-123",confirmation:"another-password-123"
  });
  assert.equal(replayedReset.response.status,400,"a recovery link must work only once");
  assert.equal(replayedReset.data.code,"INVALID_RESET_LINK");
});

test("monthly checkout safely upgrades an abandoned 7.4 draft to the current recurring catalog",async()=>{
  const account=await verifiedSignup({
    name:"Legacy Checkout Upgrade",email:"legacy-checkout-upgrade@example.test",password:"legacy-checkout-upgrade-password-123"
  });
  const transactionId=`txn_${"l".repeat(26)}`;
  const checkoutId="legacy_checkout_upgrade";
  const oldTimestamp=Date.now()-31*60*1000;
  paddleTransactions.set(transactionId,paddleTransactionFixture({
    id:transactionId,userId:account.user.id,checkoutId,status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null
  }));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases
      (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at)
      VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(transactionId,account.user.id,LEGACY_PRICE_ID,PRODUCT_ID,oldTimestamp,oldTimestamp);
    db.close();
  }

  const paddleBefore=paddleRequests.length;
  readyItemReplacementResponses=1;
  const replacement=await checkout(account);
  assert.equal(replacement.response.status,200);
  assert.equal(replacement.data.transactionId,transactionId);
  assert.equal(replacement.data.reused,true);
  assert.deepEqual(paddleRequests.slice(paddleBefore).map((entry)=>entry.method),["GET","PATCH"]);
  assert.equal(paddleTransactions.get(transactionId).status,"ready","the migrated response may safely advance to Paddle's ready state");
  assert.equal(paddleTransactions.get(transactionId).items[0].price.id,PRICE_ID);
  const db=database({readOnly:true});
  assert.deepEqual({...db.prepare("SELECT price_id,product_id,paddle_status FROM paddle_purchases WHERE transaction_id=?").get(transactionId)},{price_id:PRICE_ID,product_id:PRODUCT_ID,paddle_status:"ready"});
  db.close();
});

test("legacy checkout migration rejects unknown catalogs and recovers lost provider responses",async()=>{
  const arbitrary=await verifiedSignup({name:"Unknown Catalog",email:"unknown-catalog@example.test",password:"unknown-catalog-password-123"});
  const arbitraryTransactionId=`txn_${"u".repeat(26)}`,arbitraryPrice="pri_01arbitrarymonthly0000000000",old=Date.now()-31*60*1000;
  paddleTransactions.set(arbitraryTransactionId,paddleTransactionFixture({id:arbitraryTransactionId,userId:arbitrary.user.id,checkoutId:"unknown_catalog",status:"draft",priceId:arbitraryPrice}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(arbitraryTransactionId,arbitrary.user.id,arbitraryPrice,PRODUCT_ID,old,old);
    db.close();
  }
  const arbitraryBefore=paddleRequests.length,arbitraryResult=await checkout(arbitrary);
  assert.equal(arbitraryResult.response.status,503);
  assert.equal(arbitraryResult.data.code,"PURCHASE_RECONCILIATION_INVALID");
  assert.equal(paddleRequests.length,arbitraryBefore,"an unrecognized monthly pair is rejected before any provider request or mutation");

  const failed=await verifiedSignup({name:"Failed Migration",email:"failed-migration@example.test",password:"failed-migration-password-123"});
  const failedTransactionId=`txn_${"f".repeat(26)}`;
  paddleTransactions.set(failedTransactionId,paddleTransactionFixture({id:failedTransactionId,userId:failed.user.id,checkoutId:"failed_migration",status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(failedTransactionId,failed.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.close();
  }
  failedItemReplacementResponses=1;
  assert.equal((await checkout(failed)).response.status,503);
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,paddle_status FROM paddle_purchases WHERE transaction_id=?").get(failedTransactionId);db.close();
    assert.deepEqual({...row},{price_id:LEGACY_PRICE_ID,paddle_status:"draft"},"a failed provider PATCH cannot mutate the local ledger");
  }

  const retry=await verifiedSignup({name:"Retry Migration",email:"retry-migration@example.test",password:"retry-migration-password-123"});
  const retryTransactionId=`txn_${"m".repeat(26)}`;
  paddleTransactions.set(retryTransactionId,paddleTransactionFixture({id:retryTransactionId,userId:retry.user.id,checkoutId:"retry_migration",status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(retryTransactionId,retry.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.close();
  }
  malformedItemReplacementResponses=1;
  const malformed=await checkout(retry);
  assert.equal(malformed.response.status,503,"a malformed success response is not trusted");
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,paddle_status FROM paddle_purchases WHERE transaction_id=?").get(retryTransactionId);db.close();
    assert.deepEqual({...row},{price_id:LEGACY_PRICE_ID,paddle_status:"draft"},"provider success with an invalid response leaves the local row retryable");
  }
  const retryBefore=paddleRequests.length,recovered=await checkout(retry);
  assert.equal(recovered.response.status,200);
  assert.equal(recovered.data.transactionId,retryTransactionId);
  assert.deepEqual(paddleRequests.slice(retryBefore).map((entry)=>entry.method),["GET"],"a retry detects the provider-current/local-legacy split without another PATCH");
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,product_id,paddle_status FROM paddle_purchases WHERE transaction_id=?").get(retryTransactionId);db.close();
    assert.deepEqual({...row},{price_id:PRICE_ID,product_id:PRODUCT_ID,paddle_status:"draft"});
  }
});

test("legacy checkout migration never exposes a wrong or missing current price",async()=>{
  for(const invalidPrice of ["wrong","missing"]){
    const account=await verifiedSignup({name:`Invalid Price ${invalidPrice}`,email:`invalid-price-${invalidPrice}@example.test`,password:"invalid-price-migration-password-123"});
    const transactionId=`txn_${(invalidPrice==="wrong"?"w":"n").repeat(26)}`,old=Date.now()-31*60*1000;
    paddleTransactions.set(transactionId,paddleTransactionFixture({id:transactionId,userId:account.user.id,checkoutId:`invalid_price_${invalidPrice}`,status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
    {
      const db=database();
      db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
        .run(transactionId,account.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);db.close();
    }
    invalidItemReplacementPrices.push(invalidPrice);
    const result=await checkout(account);
    assert.equal(result.response.status,503,`${invalidPrice} provider price must fail closed`);
    assert.equal(result.data.code,"PURCHASE_RECONCILIATION_INVALID");
    const db=database({readOnly:true}),purchase=db.prepare("SELECT price_id,paddle_status FROM paddle_purchases WHERE transaction_id=?").get(transactionId);db.close();
    assert.deepEqual({...purchase},{price_id:LEGACY_PRICE_ID,paddle_status:"draft"},"the local catalog stays retryable after an invalid provider response");
  }
});

test("completed current and delayed exact-legacy payments recover without losing entitlement",async()=>{
  const migrated=await verifiedSignup({name:"Completed Migration",email:"completed-migration@example.test",password:"completed-migration-password-123"});
  const migratedTransactionId=`txn_${"c".repeat(26)}`,old=Date.now()-31*60*1000;
  paddleTransactions.set(migratedTransactionId,paddleTransactionFixture({id:migratedTransactionId,userId:migrated.user.id,checkoutId:"completed_migration",status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(migratedTransactionId,migrated.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.close();
  }
  const migratedEvent=completedEvent(migratedTransactionId,migrated.user.id,"catalogdone");
  const migratedResult=await signedWebhook(migratedEvent);
  assert.equal(migratedResult.response.status,200);
  assert.equal(migratedResult.data.outcome,"subscription-payment-recorded");
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,product_id,paddle_status,completed_at,subscription_id FROM paddle_purchases WHERE transaction_id=?").get(migratedTransactionId);
    assert.equal(row.price_id,PRICE_ID);assert.equal(row.product_id,PRODUCT_ID);assert.equal(row.paddle_status,"completed");assert.ok(row.completed_at);assert.equal(row.subscription_id,subscriptionId(migratedTransactionId));
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id=?").get(migratedEvent.event_id).count,1);db.close();
  }

  const conflicted=await verifiedSignup({name:"Completion Conflict",email:"completion-conflict@example.test",password:"completion-conflict-password-123"});
  const conflictTransactionId=`txn_${"x".repeat(26)}`;
  paddleTransactions.set(conflictTransactionId,paddleTransactionFixture({id:conflictTransactionId,userId:conflicted.user.id,checkoutId:"completion_conflict",status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,?,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(conflictTransactionId,conflicted.user.id,LEGACY_PRICE_ID,PRODUCT_ID,"ctm_00000000000000000000000099",old,old);
    db.close();
  }
  const conflictEvent=completedEvent(conflictTransactionId,conflicted.user.id,"catalograce"),conflictResult=await signedWebhook(conflictEvent);
  assert.equal(conflictResult.response.status,503,"an atomic migration conflict asks Paddle to retry");
  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT price_id FROM paddle_purchases WHERE transaction_id=?").get(conflictTransactionId).price_id,LEGACY_PRICE_ID);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id=?").get(conflictEvent.event_id).count,0,"an uncommitted migration is never marked processed");db.close();
  }

  const lifetime=await verifiedSignup({name:"Delayed Lifetime",email:"delayed-lifetime@example.test",password:"delayed-lifetime-password-123"});
  const lifetimeTransactionId=`txn_${"t".repeat(26)}`;
  paddleTransactions.set(lifetimeTransactionId,paddleTransactionFixture({id:lifetimeTransactionId,userId:lifetime.user.id,checkoutId:"delayed_lifetime",status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(lifetimeTransactionId,lifetime.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.close();
  }
  const lifetimeEvent=completedEvent(lifetimeTransactionId,lifetime.user.id,"legacydone");
  lifetimeEvent.data.subscription_id=null;lifetimeEvent.data.items[0].price.id=LEGACY_PRICE_ID;lifetimeEvent.data.items[0].price.billing_cycle=null;
  const lifetimeResult=await signedWebhook(lifetimeEvent);
  assert.equal(lifetimeResult.response.status,200);assert.equal(lifetimeResult.data.outcome,"lifetime-payment-recorded");
  assert.equal((await request("/api/me",{headers:{Cookie:lifetime.cookie}})).data.user.discovery.active,true,"a strictly validated paid 7.4 completion remains grandfathered");

  const unknown=await verifiedSignup({name:"Unknown One Time",email:"unknown-one-time@example.test",password:"unknown-one-time-password-123"});
  const unknownTransactionId=`txn_${"o".repeat(26)}`,unknownPrice="pri_01unknownonetime000000000000";
  paddleTransactions.set(unknownTransactionId,paddleTransactionFixture({id:unknownTransactionId,userId:unknown.user.id,checkoutId:"unknown_one_time",status:"draft",priceId:unknownPrice,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`)
      .run(unknownTransactionId,unknown.user.id,unknownPrice,PRODUCT_ID,old,old);db.close();
  }
  const unknownEvent=completedEvent(unknownTransactionId,unknown.user.id,"unknowndone");unknownEvent.data.subscription_id=null;unknownEvent.data.items[0].price.id=unknownPrice;unknownEvent.data.items[0].price.billing_cycle=null;
  const unknownResult=await signedWebhook(unknownEvent);assert.equal(unknownResult.data.outcome,"rejected:catalog");
});

test("a surviving 7.4 checkout claim and purchase migrate together",async()=>{
  const account=await verifiedSignup({name:"Legacy Claim",email:"legacy-claim@example.test",password:"legacy-claim-password-123"});
  const transactionId=`txn_${"q".repeat(26)}`,claimId="legacy_claim_recovery",old=Date.now()-31*60*1000;
  paddleTransactions.set(transactionId,paddleTransactionFixture({id:transactionId,userId:account.user.id,checkoutId:claimId,status:"draft",priceId:LEGACY_PRICE_ID,billingCycle:null}));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`).run(transactionId,account.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.prepare(`INSERT INTO paddle_checkout_claims (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(account.user.id,LEGACY_PRICE_ID,claimId,transactionId,Date.now()+60_000,old,old);db.close();
  }
  const before=paddleRequests.length,result=await checkout(account);
  assert.equal(result.response.status,200);assert.equal(result.data.transactionId,transactionId);assert.equal(result.data.recovered,true);
  assert.deepEqual(paddleRequests.slice(before).map((entry)=>entry.method),["GET","PATCH"]);
  {
    const db=database({readOnly:true});assert.equal(db.prepare("SELECT price_id FROM paddle_purchases WHERE transaction_id=?").get(transactionId).price_id,PRICE_ID);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?").get(account.user.id).count,0);db.close();
  }

  const paid=await verifiedSignup({name:"Legacy Claim Paid",email:"legacy-claim-paid@example.test",password:"legacy-claim-paid-password-123"});
  const paidTransactionId=`txn_${"z".repeat(26)}`,paidClaimId="legacy_claim_paid";
  const paidRemote=paddleTransactionFixture({id:paidTransactionId,userId:paid.user.id,checkoutId:paidClaimId,status:"completed",priceId:LEGACY_PRICE_ID,billingCycle:null});
  paidRemote.customer_id="ctm_00000000000000000000000001";paidRemote.subscription_id=null;paddleTransactions.set(paidTransactionId,paidRemote);
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_purchases (transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'draft',NULL,NULL,NULL,?,?)`).run(paidTransactionId,paid.user.id,LEGACY_PRICE_ID,PRODUCT_ID,old,old);
    db.prepare(`INSERT INTO paddle_checkout_claims (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(paid.user.id,LEGACY_PRICE_ID,paidClaimId,paidTransactionId,Date.now()+60_000,old,old);db.close();
  }
  const paidBefore=paddleRequests.length,paidResult=await checkout(paid);
  assert.equal(paidResult.response.status,409);assert.equal(paidResult.data.code,"ALREADY_ENTITLED");
  assert.deepEqual(paddleRequests.slice(paidBefore).map((entry)=>entry.method),["GET"],"provider-fetch recovery validates the exact retired completion without mutation");
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,paddle_status,completed_at,subscription_id FROM paddle_purchases WHERE transaction_id=?").get(paidTransactionId);
    assert.equal(row.price_id,LEGACY_PRICE_ID);assert.equal(row.paddle_status,"completed");assert.ok(row.completed_at);assert.equal(row.subscription_id,null);db.close();
  }
  assert.equal((await request("/api/me",{headers:{Cookie:paid.cookie}})).data.user.discovery.active,true,"reconciled legacy payment grants lifetime access before deletion can proceed");

  const discovered=await verifiedSignup({name:"Discovered Legacy Payment",email:"discovered-legacy-payment@example.test",password:"discovered-legacy-payment-password-123"});
  const discoveredTransactionId=`txn_${"y".repeat(26)}`,discoveredClaimId="discovered_legacy_payment",discoveredAt=Date.now();
  const discoveredRemote=paddleTransactionFixture({id:discoveredTransactionId,userId:discovered.user.id,checkoutId:discoveredClaimId,status:"completed",priceId:LEGACY_PRICE_ID,billingCycle:null});
  discoveredRemote.customer_id="ctm_00000000000000000000000001";discoveredRemote.subscription_id=null;transactionListResults=[discoveredRemote];
  {
    const db=database();db.prepare(`INSERT INTO paddle_checkout_claims (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,NULL,?,?,?)`).run(discovered.user.id,LEGACY_PRICE_ID,discoveredClaimId,discoveredAt+60_000,discoveredAt,discoveredAt);db.close();
  }
  const providerPostsBefore=paddleRequests.filter((entry)=>entry.method==="POST"&&entry.url==="/transactions").length,discoveredResult=await checkout(discovered);
  assert.equal(discoveredResult.response.status,409);assert.equal(discoveredResult.data.code,"ALREADY_ENTITLED");
  assert.equal(paddleRequests.filter((entry)=>entry.method==="POST"&&entry.url==="/transactions").length,providerPostsBefore,"an unbound paid legacy claim is rediscovered instead of opening a second checkout");
  {
    const db=database({readOnly:true}),row=db.prepare("SELECT price_id,paddle_status,completed_at,subscription_id FROM paddle_purchases WHERE transaction_id=?").get(discoveredTransactionId);
    assert.equal(row.price_id,LEGACY_PRICE_ID);assert.equal(row.paddle_status,"completed");assert.ok(row.completed_at);assert.equal(row.subscription_id,null);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?").get(discovered.user.id).count,0);db.close();
  }

  const unbound=await verifiedSignup({name:"Unbound Legacy Claim",email:"unbound-legacy-claim@example.test",password:"unbound-legacy-claim-password-123"});
  const unboundTransactionId=`txn_${"v".repeat(26)}`,unboundClaimId="unbound_legacy_claim",unboundRemote=paddleTransactionFixture({id:unboundTransactionId,userId:unbound.user.id,checkoutId:unboundClaimId,status:"draft"});
  paddleTransactions.set(unboundTransactionId,unboundRemote);
  {
    const db=database();db.prepare(`INSERT INTO paddle_checkout_claims (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`).run(unbound.user.id,LEGACY_PRICE_ID,unboundClaimId,unboundTransactionId,Date.now()+60_000,old,old);db.close();
  }
  const unboundResult=await checkout(unbound);assert.equal(unboundResult.response.status,503);assert.equal(unboundResult.data.code,"PURCHASE_RECONCILIATION_INVALID");
  {
    const db=database({readOnly:true});assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE transaction_id=?").get(unboundTransactionId).count,0,"a legacy claim cannot create a current-catalog purchase without a bound retired row");db.close();
  }
});

test("account deletion requires email confirmation, supports cancel, blocks pending checkout, and cannot be undone by a late webhook",async()=>{
  const failed=await verifiedSignup({
    name:"Failed Checkout",email:"failed-checkout@example.test",password:"failed-checkout-password-123"
  });
  const failedCheckout=await checkout(failed);
  assert.equal(failedCheckout.response.status,201);
  const failureEvent=await signedWebhook(transactionStatusEvent(
    failedCheckout.data.transactionId,"ready","failed","transaction.payment_failed"
  ));
  assert.equal(failureEvent.response.status,200);
  assert.equal(failureEvent.data.outcome,"updated");
  const failedPaddleBefore=paddleRequests.length;
  const retryCheckout=await checkout(failed);
  assert.equal(retryCheckout.response.status,200,"a failed payment that remains ready should reuse its checkout");
  assert.equal(retryCheckout.data.reused,true);
  assert.equal(retryCheckout.data.transactionId,failedCheckout.data.transactionId);
  assert.equal(paddleRequests.length,failedPaddleBefore,"retrying a ready checkout should not create or cancel a Paddle transaction");
  assert.equal(paddleTransactions.get(failedCheckout.data.transactionId).status,"ready");

  const claimed=await verifiedSignup({
    name:"Claimed Checkout",email:"claimed-checkout@example.test",password:"claimed-checkout-password-123"
  });
  const claimedDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:claimed.cookie,csrf:claimed.csrfToken});
  assert.equal(claimedDeleteRequest.response.status,202);
  const claimedDeleteToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const claimNow=Date.now();
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_checkout_claims
      (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(claimed.user.id,PRICE_ID,"claim_active_deletion",null,claimNow+60_000,claimNow,claimNow);
    db.close();
  }
  const claimBlocked=await jsonRequest("/api/account/delete/complete",{token:claimedDeleteToken,confirmation:"DELETE"});
  assert.equal(claimBlocked.response.status,409,"an active checkout-creation claim must block account deletion");
  assert.equal(claimBlocked.data.code,"CHECKOUT_PREPARING");
  assert.equal((await request("/api/me",{headers:{Cookie:claimed.cookie}})).response.status,200,"the blocked account must remain signed in");
  {
    const db=database();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(claimed.user.id).count,1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?").get(claimed.user.id).count,1);
    db.prepare("UPDATE paddle_checkout_claims SET expires_at=?,updated_at=? WHERE user_id=?")
      .run(Date.now()-1,Date.now(),claimed.user.id);
    db.close();
  }
  const claimedDeleted=await jsonRequest("/api/account/delete/complete",{token:claimedDeleteToken,confirmation:"DELETE"});
  assert.equal(claimedDeleted.response.status,200,"the same deletion link should work after the checkout claim expires");
  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(claimed.user.id).count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?").get(claimed.user.id).count,0);
    db.close();
  }

  const draftClaimed=await verifiedSignup({
    name:"Draft Checkout Claim",email:"draft-claim@example.test",password:"draft-claim-password-123"
  });
  const draftDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:draftClaimed.cookie,csrf:draftClaimed.csrfToken});
  assert.equal(draftDeleteRequest.response.status,202);
  const draftDeleteToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const draftClaimId="claim_draft_cancellation";
  const draftTransactionId=`txn_${"d".repeat(26)}`;
  const draftNow=Date.now();
  paddleTransactions.set(draftTransactionId,paddleTransactionFixture({
    id:draftTransactionId,userId:draftClaimed.user.id,checkoutId:draftClaimId,status:"draft"
  }));
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_checkout_claims
      (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(draftClaimed.user.id,PRICE_ID,draftClaimId,draftTransactionId,draftNow+60_000,draftNow,draftNow);
    db.close();
  }
  const draftPaddleBefore=paddleRequests.length;
  const retiredDraftDeletion=await jsonRequest("/api/account/delete/complete",{token:draftDeleteToken,confirmation:"DELETE"});
  assert.equal(retiredDraftDeletion.response.status,200,"deletion should safely disable an incomplete draft instead of waiting forever");
  assert.deepEqual(paddleRequests.slice(draftPaddleBefore).map((entry)=>entry.method),["GET","PATCH"]);
  const retiredDraft=paddleTransactions.get(draftTransactionId);
  assert.equal(retiredDraft.status,"draft","retirement must preserve Paddle's truthful transaction status");
  assert.equal(retiredDraft.collection_mode,"manual");assert.equal(retiredDraft.billing_details.enable_checkout,false);assert.equal(retiredDraft.custom_data,null);assert.equal(retiredDraft.checkout,null);
  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(draftClaimed.user.id).count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_checkout_claims WHERE user_id=?").get(draftClaimed.user.id).count,0);
    db.close();
  }
  const releaseRace=await verifiedSignup({
    name:"Checkout Release Race",email:"claim-release-race@example.test",password:"claim-release-race-password-123"
  });
  const releaseRaceRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:releaseRace.cookie,csrf:releaseRace.csrfToken});
  assert.equal(releaseRaceRequest.response.status,202);
  const releaseRaceToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const releaseRaceClaimId="claim_release_race";
  const releaseRaceTransactionId=`txn_${"r".repeat(26)}`;
  const releaseRaceNow=Date.now();
  {
    const db=database();
    db.prepare(`INSERT INTO paddle_checkout_claims
      (user_id,price_id,claim_id,transaction_id,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(releaseRace.user.id,PRICE_ID,releaseRaceClaimId,null,releaseRaceNow-1,releaseRaceNow-1000,releaseRaceNow-1000);
    db.close();
  }
  transactionListHook=async()=>{
    const db=database();
    db.prepare("UPDATE paddle_checkout_claims SET transaction_id=?,updated_at=? WHERE user_id=? AND claim_id=?")
      .run(releaseRaceTransactionId,Date.now(),releaseRace.user.id,releaseRaceClaimId);
    db.close();
  };
  const racedDeletion=await jsonRequest("/api/account/delete/complete",{token:releaseRaceToken,confirmation:"DELETE"});
  assert.equal(racedDeletion.response.status,409,"an expired unbound claim must not be released after a transaction is attached concurrently");
  assert.equal(racedDeletion.data.code,"CHECKOUT_PREPARING");
  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(releaseRace.user.id).count,1);
    assert.equal(db.prepare("SELECT transaction_id FROM paddle_checkout_claims WHERE user_id=?").get(releaseRace.user.id).transaction_id,releaseRaceTransactionId);
    db.close();
  }
  paddleTransactions.set(releaseRaceTransactionId,paddleTransactionFixture({
    id:releaseRaceTransactionId,userId:releaseRace.user.id,checkoutId:releaseRaceClaimId,status:"ready"
  }));
  const releaseRaceDeleted=await jsonRequest("/api/account/delete/complete",{token:releaseRaceToken,confirmation:"DELETE"});
  assert.equal(releaseRaceDeleted.response.status,200,"a later retry can reconcile the transaction that won the release race");
  assert.equal(paddleTransactions.get(releaseRaceTransactionId).status,"canceled");

  const abandoned=await verifiedSignup({
    name:"Abandoned Checkout",email:"abandoned-checkout@example.test",password:"abandoned-checkout-password-123"
  });
  const abandonedCheckout=await checkout(abandoned);
  assert.equal(abandonedCheckout.response.status,201);
  {
    const db=database();
    db.prepare("UPDATE paddle_purchases SET updated_at=? WHERE transaction_id=?").run(Date.now()-31*60*1000,abandonedCheckout.data.transactionId);
    db.close();
  }
  delete paddleTransactions.get(abandonedCheckout.data.transactionId).custom_data.strata_checkout_id;
  const paddleBefore=paddleRequests.length;
  const abandonedDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:abandoned.cookie,csrf:abandoned.csrfToken});
  assert.equal(abandonedDeleteRequest.response.status,202);
  assert.equal(paddleRequests.length,paddleBefore,"requesting a deletion email must not mutate a Paddle checkout");
  const abandonedDeleteToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const abandonedDeleted=await jsonRequest("/api/account/delete/complete",{token:abandonedDeleteToken,confirmation:"DELETE"});
  assert.equal(abandonedDeleted.response.status,200,"a confirmed deletion should close an abandoned legacy checkout instead of blocking forever");
  assert.deepEqual(paddleRequests.slice(paddleBefore).map((entry)=>entry.method),["GET","PATCH"]);
  assert.equal(paddleTransactions.get(abandonedCheckout.data.transactionId).status,"canceled");

  const mismatched=await verifiedSignup({
    name:"Mismatched Checkout",email:"mismatched-checkout@example.test",password:"mismatched-checkout-password-123"
  });
  const mismatchedCheckout=await checkout(mismatched);
  assert.equal(mismatchedCheckout.response.status,201);
  {
    const db=database();
    db.prepare("UPDATE paddle_purchases SET updated_at=? WHERE transaction_id=?")
      .run(Date.now()-31*60*1000,mismatchedCheckout.data.transactionId);
    db.close();
  }
  const mismatchedRemote=paddleTransactions.get(mismatchedCheckout.data.transactionId);
  mismatchedRemote.custom_data.strata_user_id="different-account";
  const mismatchedDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:mismatched.cookie,csrf:mismatched.csrfToken});
  assert.equal(mismatchedDeleteRequest.response.status,202);
  const mismatchedDeleteToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const mismatchedPaddleBefore=paddleRequests.length;
  const mismatchedDeletion=await jsonRequest("/api/account/delete/complete",{token:mismatchedDeleteToken,confirmation:"DELETE"});
  assert.equal(mismatchedDeletion.response.status,503,"STRATA must not cancel a remote transaction whose ownership metadata does not match");
  assert.equal(mismatchedDeletion.data.code,"PURCHASE_RECONCILIATION_INVALID");
  assert.deepEqual(paddleRequests.slice(mismatchedPaddleBefore).map((entry)=>entry.method),["GET"],"invalid ownership must be rejected before PATCH");
  assert.equal(mismatchedRemote.status,"ready");
  mismatchedRemote.custom_data.strata_user_id=mismatched.user.id;
  mismatchedRemote.items[0].price.product_id="pro_wrong_catalog_item";
  const wrongCatalogBefore=paddleRequests.length;
  const wrongCatalogDeletion=await jsonRequest("/api/account/delete/complete",{token:mismatchedDeleteToken,confirmation:"DELETE"});
  assert.equal(wrongCatalogDeletion.response.status,503,"STRATA must not cancel a remote transaction for a different product");
  assert.equal(wrongCatalogDeletion.data.code,"PURCHASE_RECONCILIATION_INVALID");
  assert.deepEqual(paddleRequests.slice(wrongCatalogBefore).map((entry)=>entry.method),["GET"],"invalid catalog data must be rejected before PATCH");
  mismatchedRemote.items[0].price.product_id=PRODUCT_ID;
  const matchedDeletion=await jsonRequest("/api/account/delete/complete",{token:mismatchedDeleteToken,confirmation:"DELETE"});
  assert.equal(matchedDeletion.response.status,200);
  assert.equal(mismatchedRemote.status,"canceled");

  const repaired=await verifiedSignup({
    name:"Recovered Checkout",email:"recovered-checkout@example.test",password:"recovered-checkout-password-123"
  });
  const repairedCheckout=await checkout(repaired);
  assert.equal(repairedCheckout.response.status,201);
  const repairedEvent=completedEvent(repairedCheckout.data.transactionId,repaired.user.id,"missed-webhook");
  paddleTransactions.set(repairedCheckout.data.transactionId,{...repairedEvent.data,status:"completed"});
  {
    const db=database();
    db.prepare("UPDATE paddle_purchases SET paddle_status='completed',completed_at=NULL,updated_at=? WHERE transaction_id=?")
      .run(Date.now()-31*60*1000,repairedCheckout.data.transactionId);
    db.close();
  }
  const repairedDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:repaired.cookie,csrf:repaired.csrfToken});
  assert.equal(repairedDeleteRequest.response.status,202);
  const repairedToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const repairedPending=await jsonRequest("/api/account/delete/complete",{token:repairedToken,confirmation:"DELETE"});
  assert.equal(repairedPending.response.status,409,"a remotely completed recurring checkout stays blocked until its subscription state is linked");
  assert.equal(repairedPending.data.code,"PURCHASE_PENDING");
  const repairedTerminal=await signedWebhook(subscriptionEvent(repairedCheckout.data.transactionId,repaired.user.id,{label:"repaired-canceled",status:"canceled"}));
  assert.equal(repairedTerminal.data.outcome,"subscription-created");
  const repairedDelete=await jsonRequest("/api/account/delete/complete",{token:repairedToken,confirmation:"DELETE"});
  assert.equal(repairedDelete.response.status,200,"a verified terminal subscription state should allow deletion");

  const email="delete-me@example.test";
  const account=await verifiedSignup({
    name:"Deletion Lifter",email,password:"deletion-password-123"
  });

  const firstRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:account.cookie,csrf:account.csrfToken});
  assert.equal(firstRequest.response.status,202);
  const firstDelivery=latestDelivery("Confirm deletion of your STRATA account");
  assert.deepEqual(firstDelivery.body.to,[email]);
  const firstToken=actionToken(firstDelivery);
  const firstStatus=await jsonRequest("/api/account/delete/status",{token:firstToken});
  assert.equal(firstStatus.response.status,200);
  assert.equal(firstStatus.data.active,true);
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).data.user.accountDeletion.pending,true);

  const canceled=await jsonRequest("/api/account/delete/cancel",{},
    {cookie:account.cookie,csrf:account.csrfToken});
  assert.equal(canceled.response.status,200);
  assert.equal(canceled.data.ok,true);
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).data.user.accountDeletion.pending,false);
  const canceledStatus=await jsonRequest("/api/account/delete/status",{token:firstToken});
  assert.equal(canceledStatus.data.active,false);
  const canceledCompletion=await jsonRequest("/api/account/delete/complete",{token:firstToken,confirmation:"DELETE"});
  assert.equal(canceledCompletion.response.status,400);
  assert.equal(canceledCompletion.data.code,"INVALID_DELETE_LINK");
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).response.status,200);

  const pending=await checkout(account);
  assert.equal(pending.response.status,201);
  const transactionId=pending.data.transactionId;
  const pendingDeleteRequest=await jsonRequest("/api/account/delete/request",{},
    {cookie:account.cookie,csrf:account.csrfToken});
  assert.equal(pendingDeleteRequest.response.status,202,"requesting an email is safe while checkout is pending");
  const pendingDeleteToken=actionToken(latestDelivery("Confirm deletion of your STRATA account"));
  const blocked=await jsonRequest("/api/account/delete/complete",{token:pendingDeleteToken,confirmation:"DELETE"});
  assert.equal(blocked.response.status,409,"a fresh pending checkout must block final deletion");
  assert.equal(blocked.data.code,"PURCHASE_PENDING");

  const completedPurchase=await signedWebhook(completedEvent(transactionId,account.user.id,"delete"));
  assert.equal(completedPurchase.response.status,200);
  assert.equal(completedPurchase.data.outcome,"subscription-payment-recorded");
  const granted=await signedWebhook(subscriptionEvent(transactionId,account.user.id,{label:"delete-sub"}));
  assert.equal(granted.data.outcome,"subscription-created");
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).data.user.discovery.active,true);

  const savedPlan=await jsonRequest("/api/plan",{plan:planFixture(),expectedPlanUpdatedAt:0},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  const savedPreferences=await jsonRequest("/api/preferences",{preferences:preferencesFixture},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  const savedRating=await jsonRequest("/api/ratings/flat-dumbbell-press",{rating:ratingFixture},{cookie:account.cookie,csrf:account.csrfToken,method:"PUT"});
  assert.equal(savedPlan.response.status,200);
  assert.equal(savedPreferences.response.status,200);
  assert.equal(savedRating.response.status,200);

  const deleteToken=pendingDeleteToken;
  let verificationChallengeIds;
  {
    const db=database({readOnly:true});
    verificationChallengeIds=db.prepare("SELECT challenge_id FROM signup_verifications WHERE user_id=?").all(account.user.id).map((row)=>row.challenge_id);
    assert.ok(verificationChallengeIds.length>0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_action_sends WHERE purpose='account_delete'").get().count,2);
    db.close();
  }

  const wrongConfirmation=await jsonRequest("/api/account/delete/complete",{
    token:deleteToken,confirmation:"delete"
  });
  assert.equal(wrongConfirmation.response.status,400);
  assert.equal(wrongConfirmation.data.code,"DELETE_CONFIRMATION_REQUIRED");
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).response.status,200);

  const activeSubscriptionDeletion=await jsonRequest("/api/account/delete/complete",{
    token:deleteToken,confirmation:"DELETE"
  });
  assert.equal(activeSubscriptionDeletion.response.status,409,"an account cannot disappear while Paddle may still renew its subscription");
  assert.equal(activeSubscriptionDeletion.data.code,"SUBSCRIPTION_ACTIVE");
  const canceledSubscription=await signedWebhook(subscriptionEvent(transactionId,account.user.id,{
    label:"delete-canceled",status:"canceled",eventType:"subscription.updated"
  }));
  assert.equal(canceledSubscription.data.outcome,"subscription-updated");

  const deleted=await jsonRequest("/api/account/delete/complete",{
    token:deleteToken,confirmation:"DELETE"
  });
  assert.equal(deleted.response.status,200);
  assert.equal(deleted.data.ok,true);
  assert.match(deleted.setCookie,/strata_session=;.*Max-Age=0/i);
  assert.equal((await request("/api/me",{headers:{Cookie:account.cookie}})).response.status,401);
  assert.equal((await login(email,"deletion-password-123")).response.status,401);

  {
    const db=database({readOnly:true});
    for(const table of ["users","sessions","plans","preferences","ratings","paddle_purchases","paddle_checkout_claims","account_action_requests","signup_verifications"]){
      const column=table==="users"?"id":table==="signup_verifications"?"user_id":"user_id";
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`).get(account.user.id).count,0,`${table} should not retain deleted account data`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_adjustments WHERE transaction_id=?").get(transactionId).count,0);
    for(const challengeId of verificationChallengeIds){
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM email_verification_sends WHERE challenge_id=?").get(challengeId).count,0);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_action_sends WHERE purpose='account_delete'").get().count,0);
    db.close();
  }

  const lateEvent=completedEvent(transactionId,account.user.id,"late");
  const late=await signedWebhook(lateEvent);
  assert.equal(late.response.status,200);
  assert.equal(late.data.outcome,"ignored:unknown-transaction");
  {
    const db=database({readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(account.user.id).count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE transaction_id=?").get(transactionId).count,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM paddle_webhook_events WHERE event_id=?").get(lateEvent.event_id).count,1);
    db.close();
  }
});
