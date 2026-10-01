"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const http=require("node:http");
const {spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");

const PROJECT_ROOT=join(__dirname,"..");
const ADMIN_EMAIL="stratafitness.official@gmail.com";
const ADMIN_PASSWORD="admin-owner-password-123";
const MEMBER_PASSWORD="member-password-12345";
const EMAIL_API_KEY="re_admin_http_fixture_key_123456789";
const EMAIL_SECRET="admin-http-email-secret-that-is-long-enough-123";

let provider;
let providerBase;
let app;
let base;
let runtimeDir;
let databasePath;
let requestAddressOctet=20;
const deliveries=[];

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

async function startProvider(){
  provider=http.createServer(async(req,res)=>{
    const raw=await readBody(req);
    let body=null;
    try{body=raw?JSON.parse(raw):null;}catch{}
    deliveries.push({method:req.method,url:req.url,headers:{...req.headers},body});
    res.writeHead(req.method==="POST"&&req.url==="/emails"?200:404,{"Content-Type":"application/json"});
    res.end(JSON.stringify(req.method==="POST"&&req.url==="/emails"?{id:`email_${deliveries.length}`}:{message:"not found"}));
  });
  providerBase=await listen(provider);
}

function appEnvironment(dataDir,adminEmail,{verificationEnabled="true"}={}){
  const env={
    ...process.env,
    PORT:"0",HOST:"127.0.0.1",NODE_ENV:"test",TRUST_PROXY:"true",
    APP_BASE_URL:"http://127.0.0.1",
    TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:dataDir,
    PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",
    PADDLE_WEBHOOK_SECRET:"",PADDLE_PRODUCT_ID:"",PADDLE_PRICE_ID:"",
    EMAIL_VERIFICATION_ENABLED:verificationEnabled,
    ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:verificationEnabled==="false"?"true":"false",
    RESEND_API_KEY:EMAIL_API_KEY,
    EMAIL_FROM:"STRATA <accounts@auth.stratafitness.online>",
    EMAIL_REPLY_TO:ADMIN_EMAIL,SUPPORT_EMAIL:ADMIN_EMAIL,
    EMAIL_VERIFICATION_SECRET:EMAIL_SECRET,RESEND_API_BASE:providerBase
  };
  if(adminEmail===undefined)delete env.ADMIN_EMAIL;
  else env.ADMIN_EMAIL=adminEmail;
  return env;
}

async function launchApp(adminEmail,prefix="admin-http-",options={}){
  mkdirSync(join(PROJECT_ROOT,"test-runtime"),{recursive:true});
  const dataDir=mkdtempSync(join(PROJECT_ROOT,"test-runtime",prefix));
  return launchAppInDirectory(adminEmail,dataDir,options);
}

async function launchAppInDirectory(adminEmail,dataDir,options={}){
  const child=spawn(process.execPath,["server.js"],{
    cwd:PROJECT_ROOT,
    env:appEnvironment(dataDir,adminEmail,options),
    stdio:["ignore","pipe","pipe"]
  });
  const appBase=await new Promise((resolve,reject)=>{
    let output="",errors="",settled=false;
    const timer=setTimeout(()=>finish(new Error(`Server startup timed out. ${errors}`)),6000);
    function finish(error,value){
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      error?reject(error):resolve(value);
    }
    child.stdout.on("data",(chunk)=>{
      output=(output+chunk.toString()).slice(-4096);
      const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if(match)finish(null,`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data",(chunk)=>{errors=(errors+chunk.toString()).slice(-8192);});
    child.once("error",finish);
    child.once("exit",(code,signal)=>finish(new Error(`Server exited before startup (${code??signal??"unknown"}). ${errors}`)));
  }).catch(async(error)=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    rmSync(dataDir,{recursive:true,force:true});
    throw error;
  });
  return {child,base:appBase,dataDir};
}

async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolve)=>{
    let timer;
    child.once("exit",()=>{clearTimeout(timer);resolve();});
    child.kill("SIGTERM");
    timer=setTimeout(()=>child.kill("SIGKILL"),2000);
  });
}

async function closeServer(server){
  if(!server?.listening)return;
  await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
}

async function requestAt(appBase,path,options={}){
  const response=await fetch(`${appBase}${path}`,options);
  const contentType=response.headers.get("content-type")||"";
  const data=contentType.includes("json")?await response.json():await response.text();
  return {response,data,setCookie:response.headers.get("set-cookie")||""};
}

function request(path,options={}){
  return requestAt(base,path,options);
}

function cookieValue(header,name){
  const match=String(header).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`));
  return match?`${name}=${match[1]}`:"";
}

function sha256(value){
  return createHash("sha256").update(String(value)).digest("hex");
}

function jsonRequest(path,body,{cookie="",csrf="",method="POST",origin=true,contentType=true,secFetchSite=""}={}){
  requestAddressOctet=requestAddressOctet%220+20;
  const headers={"X-Forwarded-For":`198.51.100.${requestAddressOctet}`};
  if(contentType)headers["Content-Type"]="application/json";
  if(origin!==false)headers.Origin=origin===true?base:String(origin);
  if(cookie)headers.Cookie=cookie;
  if(csrf)headers["X-CSRF-Token"]=csrf;
  if(secFetchSite)headers["Sec-Fetch-Site"]=secFetchSite;
  return request(path,{method,headers,body:JSON.stringify(body)});
}

function jsonRequestAt(appBase,path,body,{ip="203.0.113.90",origin=true}={}){
  const headers={
    "Content-Type":"application/json",
    "X-Forwarded-For":ip
  };
  if(origin!==false)headers.Origin=origin===true?appBase:String(origin);
  return requestAt(appBase,path,{method:"POST",headers,body:JSON.stringify(body)});
}

function verificationCode(delivery){
  const match=String(delivery?.body?.text||"").match(/code is ([0-9]{6})\./i);
  assert.ok(match,"the fake provider must receive a six-digit verification code");
  return match[1];
}

function actionToken(delivery){
  const match=String(delivery?.body?.text||"").match(/#token=([A-Za-z0-9_-]{43})/);
  assert.ok(match,"the fake provider must receive an account-action URL fragment");
  return match[1];
}

function latestDelivery(subject){
  const delivery=[...deliveries].reverse().find((item)=>item.body?.subject===subject);
  assert.ok(delivery,`expected email with subject: ${subject}`);
  return delivery;
}

async function verifiedSignup({name,email,password}){
  const before=deliveries.length;
  const signup=await jsonRequest("/api/signup",{name,email,password,role:"admin",isAdmin:true});
  assert.equal(signup.response.status,202);
  assert.equal(deliveries.length,before+1);
  const signupCookie=cookieValue(signup.setCookie,"strata_signup");
  assert.ok(signupCookie);
  const verified=await jsonRequest("/api/verify-email",{code:verificationCode(deliveries.at(-1))},{cookie:signupCookie});
  assert.equal(verified.response.status,201);
  const cookie=cookieValue(verified.setCookie,"strata_session");
  assert.ok(cookie);
  const me=await request("/api/me",{headers:{Cookie:cookie}});
  assert.equal(me.response.status,200);
  return {cookie,csrf:me.data.csrfToken,user:me.data.user,password};
}

async function login(email,password){
  const result=await jsonRequest("/api/login",{email,password});
  if(result.response.status!==200)return {...result,cookie:"",csrf:""};
  const cookie=cookieValue(result.setCookie,"strata_session");
  const me=await request("/api/me",{headers:{Cookie:cookie}});
  assert.equal(me.response.status,200);
  return {...result,cookie,csrf:me.data.csrfToken,user:me.data.user};
}

function openDatabase(){
  return new DatabaseSync(databasePath);
}

function databaseCounts(targetId){
  const db=openDatabase();
  try{
    const user=db.prepare("SELECT auth_version,suspended_at FROM users WHERE id=?").get(targetId);
    return {
      user:user?{authVersion:Number(user.auth_version),suspendedAt:user.suspended_at??null}:null,
      sessions:Number(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(targetId).count),
      actions:Number(db.prepare("SELECT COUNT(*) AS count FROM account_action_requests WHERE user_id=?").get(targetId).count),
      audits:Number(db.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").get().count),
      tickets:Number(db.prepare("SELECT COUNT(*) AS count FROM support_tickets").get().count),
      supportEvents:Number(db.prepare("SELECT COUNT(*) AS count FROM support_request_events").get().count),
      deliveries:deliveries.length
    };
  }finally{db.close();}
}

function assertPrivateJson(response){
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(response.headers.get("access-control-allow-origin"),null);
}

function assertAdminResponseRedacted(data,secretValues=[]){
  const serialized=JSON.stringify(data);
  assert.doesNotMatch(serialized,/"(?:password_hash|password_salt|csrf_token|session_token|token_hash|code_digest|browser_token_hash|endpoint_secret_key|api_key)"\s*:/i);
  assert.doesNotMatch(serialized,/\b(?:RESEND_API_KEY|EMAIL_VERIFICATION_SECRET|PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET|TURSO_AUTH_TOKEN)\b/i);
  for(const value of secretValues.filter(Boolean))assert.ok(!serialized.includes(String(value)),`admin response exposed secret value ${String(value).slice(0,8)}…`);
}

async function adminAction(admin,targetId,action,overrides={}){
  return jsonRequest(`/api/admin/users/${encodeURIComponent(targetId)}/actions`,{action},{cookie:admin.cookie,csrf:admin.csrf,...overrides});
}

test.before(async()=>{
  await startProvider();
  const launched=await launchApp("  STRATAFITNESS.OFFICIAL@GMAIL.COM  ","admin-http-");
  app=launched.child;
  base=launched.base;
  runtimeDir=launched.dataDir;
  databasePath=join(runtimeDir,"strata.sqlite");
});

test.after(async()=>{
  await stopChild(app);
  await closeServer(provider);
  if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});
});

let nonAdmin;
let dotVariant;
let admin;
let member;

test("admin configuration is public only as a boolean and invalid values fail closed",async()=>{
  const configured=await request("/api/status");
  assert.equal(configured.response.status,200);
  assert.equal(configured.data.adminConfigured,true);
  assert.doesNotMatch(JSON.stringify(configured.data),/stratafitness\.official|ADMIN_EMAIL|admin-http-email-secret|fixture_key/i);

  for(const [label,value] of [
    ["unset",undefined],
    ["comma-separated",`${ADMIN_EMAIL},attacker@example.test`],
    ["placeholder","admin@example.com"]
  ]){
    const auxiliary=await launchApp(value,`admin-status-${label}-`);
    try{
      const status=await requestAt(auxiliary.base,"/api/status");
      assert.equal(status.response.status,200);
      assert.equal(status.data.adminConfigured,false,label);
      assert.doesNotMatch(JSON.stringify(status.data),/stratafitness\.official|attacker|ADMIN_EMAIL|fixture_key/i);
    }finally{
      await stopChild(auxiliary.child);
      rmSync(auxiliary.dataDir,{recursive:true,force:true});
    }
  }
});

test("an unverified exact email, aliases, forged role fields, and anonymous callers never become admin",async()=>{
  const unverifiedApp=await launchApp(ADMIN_EMAIL,"admin-unverified-",{verificationEnabled:"false"});
  try{
    const signup=await requestAt(unverifiedApp.base,"/api/signup",{
      method:"POST",
      headers:{"Content-Type":"application/json",Origin:unverifiedApp.base},
      body:JSON.stringify({name:"Unverified Owner",email:ADMIN_EMAIL,password:"unverified-owner-password-123",role:"admin",isAdmin:true})
    });
    assert.equal(signup.response.status,201);
    const unverifiedCookie=cookieValue(signup.setCookie,"strata_session");
    assert.ok(unverifiedCookie);
    const unverified=await requestAt(unverifiedApp.base,"/api/admin/session",{headers:{Cookie:unverifiedCookie}});
    assert.equal(unverified.response.status,403,"the configured email must still be verified when general verification is disabled");
    assert.equal(unverified.data.code,"ADMIN_REQUIRED");
    assertPrivateJson(unverified.response);
    const check=new DatabaseSync(join(unverifiedApp.dataDir,"strata.sqlite"));
    assert.equal(check.prepare("SELECT email_verified_at FROM users WHERE email=?").get(ADMIN_EMAIL).email_verified_at,null);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM admin_principal").get().count,0);
    check.close();
  }finally{
    await stopChild(unverifiedApp.child);
    rmSync(unverifiedApp.dataDir,{recursive:true,force:true});
  }

  nonAdmin=await verifiedSignup({
    name:"Forged Role Attempt",
    email:"stratafitness.official+family@gmail.com",
    password:"non-admin-password-123"
  });
  assert.equal(nonAdmin.user.isAdmin,false);
  dotVariant=await verifiedSignup({
    name:"Dot Variant Attempt",
    email:"stratafitnessofficial@gmail.com",
    password:"dot-variant-password-123"
  });
  assert.equal(dotVariant.user.isAdmin,false);

  for(const path of ["/api/admin/session","/api/admin/overview","/api/admin/product-signals","/api/admin/users","/api/admin/audit","/api/admin/support"]){
    const anonymousApi=await request(path);
    assert.equal(anonymousApi.response.status,401,`${path} must reject anonymous callers`);
    assertPrivateJson(anonymousApi.response);
    const nonAdminApi=await request(path,{headers:{Cookie:nonAdmin.cookie}});
    assert.equal(nonAdminApi.response.status,403,`${path} must reject ordinary accounts before private data access`);
    assert.equal(nonAdminApi.data.code,"ADMIN_REQUIRED");
    assertPrivateJson(nonAdminApi.response);
  }
  const dotVariantApi=await request("/api/admin/session",{headers:{Cookie:dotVariant.cookie}});
  assert.equal(dotVariantApi.response.status,403,"a Gmail dot variant must not match the configured admin identity");
  assert.equal(dotVariantApi.data.code,"ADMIN_REQUIRED");

  const anonymousPage=await request("/admin",{redirect:"manual"});
  assert.equal(anonymousPage.response.status,302);
  assert.equal(anonymousPage.response.headers.get("location"),"/account.html?mode=login&next=admin");
  assert.equal(anonymousPage.response.headers.get("cache-control"),"no-store");
  const nonAdminPage=await request("/admin",{redirect:"manual",headers:{Cookie:nonAdmin.cookie}});
  assert.equal(nonAdminPage.response.status,302);
  assert.match(nonAdminPage.response.headers.get("location")||"",/^\/account\.html\?mode=login&next=admin&error=/);
  assert.equal(nonAdminPage.response.headers.get("cache-control"),"no-store");
});

test("the verified exact address binds ownership, forces a fresh login, and opens Admin immediately",async()=>{
  const firstSession=await verifiedSignup({
    name:"STRATA Owner",
    email:"  STRATAFITNESS.OFFICIAL@GMAIL.COM ",
    password:ADMIN_PASSWORD
  });
  assert.equal(firstSession.user.email,ADMIN_EMAIL);
  assert.equal(firstSession.user.isAdmin,false,"signup body role fields and email alone must not pre-authorize a session");

  const bootstrap=await request("/api/admin/session",{headers:{Cookie:firstSession.cookie}});
  assert.equal(bootstrap.response.status,409);
  assert.equal(bootstrap.data.code,"ADMIN_RELOGIN_REQUIRED");
  assert.match(bootstrap.setCookie,/strata_session=;/);
  assert.equal((await request("/api/me",{headers:{Cookie:firstSession.cookie}})).response.status,401,"binding must invalidate pre-admin sessions");

  admin=await login(ADMIN_EMAIL,ADMIN_PASSWORD);
  assert.equal(admin.response.status,200);
  assert.equal(admin.user.email,ADMIN_EMAIL);
  assert.equal(admin.user.isAdmin,true);
  const parallelAdminSession=await login(ADMIN_EMAIL,ADMIN_PASSWORD);
  assert.equal(parallelAdminSession.response.status,200);

  const session=await request("/api/admin/session",{headers:{Cookie:admin.cookie}});
  assert.equal(session.response.status,200);
  assert.deepEqual(session.data,{admin:true,elevated:true,elevatedUntil:null});
  assertPrivateJson(session.response);

  for(const path of ["/api/admin/overview","/api/admin/product-signals","/api/admin/users","/api/admin/audit","/api/admin/support"]){
    const authorized=await request(path,{headers:{Cookie:admin.cookie}});
    assert.equal(authorized.response.status,200,`${path} must open for the authenticated bound owner`);
    assertPrivateJson(authorized.response);
  }
  const deliveriesBefore=deliveries.length;
  for(const path of ["/api/admin/elevate","/api/admin/elevate/verify"]){
    const retired=await jsonRequest(path,{password:ADMIN_PASSWORD,code:"123456"},{cookie:admin.cookie,csrf:admin.csrf});
    assert.equal(retired.response.status,404,`${path} must remain retired`);
    assertPrivateJson(retired.response);
  }
  assert.equal(deliveries.length,deliveriesBefore,"opening Admin must not send a password or email-code challenge");
  assert.equal((await request("/api/me",{headers:{Cookie:admin.cookie}})).response.status,200,"retired endpoints must not rotate or revoke the owner session");

  const parallelSessionStatus=await request("/api/admin/session",{headers:{Cookie:parallelAdminSession.cookie}});
  assert.equal(parallelSessionStatus.response.status,200);
  assert.deepEqual(parallelSessionStatus.data,{admin:true,elevated:true,elevatedUntil:null});
  const parallelOverview=await request("/api/admin/overview",{headers:{Cookie:parallelAdminSession.cookie}});
  assert.equal(parallelOverview.response.status,200,"every current bound-owner session may open Admin without step-up");

  const freshAdmin=await login(ADMIN_EMAIL,ADMIN_PASSWORD);
  assert.equal(freshAdmin.response.status,200);
  const freshAdminSession=await request("/api/admin/session",{headers:{Cookie:freshAdmin.cookie}});
  assert.equal(freshAdminSession.response.status,200);
  assert.deepEqual(freshAdminSession.data,{admin:true,elevated:true,elevatedUntil:null});
  const freshAdminOverview=await request("/api/admin/overview",{headers:{Cookie:freshAdmin.cookie}});
  assert.equal(freshAdminOverview.response.status,200);

  const page=await request("/admin",{redirect:"manual",headers:{Cookie:admin.cookie}});
  assert.equal(page.response.status,200);
  assert.match(page.response.headers.get("content-type")||"",/^text\/html/);
  assert.equal(page.response.headers.get("cache-control"),"private, no-store");
  assert.match(page.response.headers.get("vary")||"",/Cookie/i);
  assert.doesNotMatch(page.data,/re_admin_http_fixture|admin-http-email-secret|PADDLE_API_KEY|TURSO_AUTH_TOKEN/i);
});

test("admin reads require the bound owner session and return bounded, explicitly redacted account data",async()=>{
  member=await verifiedSignup({
    name:"<img src=x onerror=alert(1)>",
    email:"member@example.test",
    password:MEMBER_PASSWORD
  });
  const second=await login(member.user.email,MEMBER_PASSWORD);
  assert.equal(second.response.status,200);
  member.secondCookie=second.cookie;

  const db=openDatabase();
  const purchaseAt=Date.now();
  db.prepare("INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,NULL,NULL,?,?)")
    .run("txn_admin_visible_member",member.user.id,"pri_admin_visible","pro_admin_visible","ctm_admin_visible",purchaseAt,purchaseAt,purchaseAt);
  const stored=db.prepare("SELECT password_hash,password_salt FROM users WHERE id=?").get(member.user.id);
  const targetSessions=db.prepare("SELECT token_hash,csrf_token FROM sessions WHERE user_id=? ORDER BY created_at").all(member.user.id);
  db.close();
  const secrets=[EMAIL_API_KEY,EMAIL_SECRET,ADMIN_PASSWORD,MEMBER_PASSWORD,stored.password_hash,stored.password_salt,...targetSessions.flatMap((row)=>[row.token_hash,row.csrf_token])];

  const overview=await request("/api/admin/overview",{headers:{Cookie:admin.cookie}});
  assert.equal(overview.response.status,200);
  assert.ok(overview.data.overview.accounts.total>=3);
  assert.ok(overview.data.overview.accounts.verified>=3);
  assert.ok(overview.data.overview.discovery.activeUsers>=1);
  assertPrivateJson(overview.response);
  assertAdminResponseRedacted(overview.data,secrets);

  const signal=await request("/api/product-signals",{method:"POST",headers:{Origin:base,"Content-Type":"application/json"},body:JSON.stringify({event:"preview_generated"})});
  assert.equal(signal.response.status,202);
  const productSignals=await request("/api/admin/product-signals?days=30",{headers:{Cookie:admin.cookie}});
  assert.equal(productSignals.response.status,200);
  assert.equal(productSignals.data.totals.preview_generated,1);
  assert.equal(productSignals.data.scope.measure,"aggregate_action_counts");
  assert.equal(productSignals.data.scope.uniquePeople,false);
  assert.equal(productSignals.data.scope.repeatedActionsIncrement,true);
  assertPrivateJson(productSignals.response);
  assertAdminResponseRedacted(productSignals.data,secrets);

  const users=await request("/api/admin/users?q=member%40example.test&limit=500&offset=-5",{headers:{Cookie:admin.cookie}});
  assert.equal(users.response.status,200);
  assert.equal(users.data.limit,50);
  assert.equal(users.data.offset,0);
  assert.equal(users.data.total,1);
  assert.equal(users.data.users[0].id,member.user.id);
  assert.equal(users.data.users[0].name,"<img src=x onerror=alert(1)>");
  assert.deepEqual(users.data.users[0].discovery,{
    active:true,adminGrant:{active:false,startedAt:null,expiresAt:null,revokedAt:null},activePurchaseCount:1,pendingPurchaseCount:0,purchaseCount:1,
    latestPurchaseAt:purchaseAt,transactionId:"txn_admin_visible_member",transactionStatus:"completed",apple:{activeCount:0,expiresAt:null}
  },"account search must expose the selected account's complete entitlement state");
  assertPrivateJson(users.response);
  assertAdminResponseRedacted(users.data,secrets);

  const detail=await request(`/api/admin/users/${encodeURIComponent(member.user.id)}`,{headers:{Cookie:admin.cookie}});
  assert.equal(detail.response.status,200);
  assert.equal(detail.data.user.email,"member@example.test");
  assert.ok(detail.data.user.activeSessions>=2);
  assert.deepEqual(detail.data.user.discovery,{
    active:true,adminGrant:{active:false,startedAt:null,expiresAt:null,revokedAt:null},activePurchaseCount:1,pendingPurchaseCount:0,purchaseCount:1,
    latestPurchaseAt:purchaseAt,transactionId:"txn_admin_visible_member",transactionStatus:"completed",apple:{activeCount:0,expiresAt:null,subscription:null}
  });
  assertPrivateJson(detail.response);
  assertAdminResponseRedacted(detail.data,secrets);

  // Strata+ bought in the iOS app shows beside the Paddle state.
  const appleExpiresAt=Date.now()+30*24*60*60*1000,appleDb=openDatabase();
  try{
    appleDb.prepare("INSERT INTO apple_subscriptions(original_transaction_id,user_id,product_id,environment,latest_transaction_id,purchased_at,original_purchased_at,expires_at,revoked_at,revocation_reason,auto_renew,grace_period_expires_at,last_signed_at,created_at,updated_at) VALUES('5000000000',?,'online.stratafitness.app.plus.monthly','Production','5000000001',?,?,?,NULL,NULL,1,NULL,?,?,?)")
      .run(member.user.id,Date.now(),Date.now(),appleExpiresAt,Date.now(),Date.now(),Date.now());
  }finally{appleDb.close();}
  const appleDetail=await request(`/api/admin/users/${encodeURIComponent(member.user.id)}`,{headers:{Cookie:admin.cookie}});
  assert.deepEqual(appleDetail.data.user.discovery.apple,{activeCount:1,expiresAt:appleExpiresAt,subscription:{active:true,productId:"online.stratafitness.app.plus.monthly",expiresAt:appleExpiresAt,autoRenew:true,inGracePeriod:false,environment:"Production",revoked:false}});
  const appleList=await request("/api/admin/users",{headers:{Cookie:admin.cookie}});
  assert.equal(appleList.data.users.find((entry)=>entry.id===member.user.id).discovery.apple.activeCount,1);
  const appleCleanup=openDatabase();
  try{appleCleanup.prepare("DELETE FROM apple_subscriptions WHERE original_transaction_id='5000000000'").run();}finally{appleCleanup.close();}

  const injection=await request("/api/admin/users?q=%25_%27%20OR%201%3D1--",{headers:{Cookie:admin.cookie}});
  assert.equal(injection.response.status,200);
  assert.equal(injection.data.total,0,"SQL and LIKE metacharacters must remain literal search data");

  const anonymousDetail=await request(`/api/admin/users/${encodeURIComponent(member.user.id)}`);
  const randomAnonymous=await request("/api/admin/users/random-user-id-0000000");
  assert.equal(anonymousDetail.response.status,401);
  assert.equal(randomAnonymous.response.status,401,"authorization must precede target lookup");
  assert.deepEqual(anonymousDetail.data,randomAnonymous.data);
});

test("denied admin mutations enforce authorization, strict Origin, CSRF, and JSON before side effects",async()=>{
  const before=databaseCounts(member.user.id);
  const path=`/api/admin/users/${encodeURIComponent(member.user.id)}/actions`;
  const body={action:"suspend"};

  const anonymous=await jsonRequest(path,body);
  assert.equal(anonymous.response.status,401);
  const nonAdminResult=await jsonRequest(path,body,{cookie:nonAdmin.cookie,csrf:nonAdmin.csrf});
  assert.equal(nonAdminResult.response.status,403);
  assert.equal(nonAdminResult.data.code,"ADMIN_REQUIRED");
  const missingOrigin=await jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,origin:false});
  assert.equal(missingOrigin.response.status,403);
  assert.equal(missingOrigin.data.code,"ADMIN_ORIGIN_REQUIRED");
  const nullOrigin=await jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,origin:"null"});
  assert.equal(nullOrigin.response.status,403);
  const evilOrigin=await jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,origin:"https://stratafitness.online.attacker.example"});
  assert.equal(evilOrigin.response.status,403);
  const crossSite=await jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,secFetchSite:"cross-site"});
  assert.equal(crossSite.response.status,403);
  const missingCsrf=await jsonRequest(path,body,{cookie:admin.cookie});
  assert.equal(missingCsrf.response.status,403);
  assert.equal(missingCsrf.data.code,"INVALID_CSRF");
  const wrongCsrf=await jsonRequest(path,body,{cookie:admin.cookie,csrf:nonAdmin.csrf});
  assert.equal(wrongCsrf.response.status,403);
  assert.equal(wrongCsrf.data.code,"INVALID_CSRF");
  const wrongType=await jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,contentType:false});
  assert.equal(wrongType.response.status,415);
  assert.equal(wrongType.data.code,"JSON_REQUIRED");

  for(const denied of [anonymous,nonAdminResult,missingOrigin,nullOrigin,evilOrigin,crossSite,missingCsrf,wrongCsrf,wrongType]){
    assertPrivateJson(denied.response);
  }
  assert.deepEqual(databaseCounts(member.user.id),before,"denied mutations must not change accounts, sessions, actions, audit, support, or email deliveries");
});

test("unknown admin actions and primary-owner targeting fail before side effects",async()=>{
  const memberBefore=databaseCounts(member.user.id);
  const adminBefore=databaseCounts(admin.user.id);

  const unsupportedEntitlement=await adminAction(admin,member.user.id,"grant-complimentary-discovery");
  assert.equal(unsupportedEntitlement.response.status,400);
  assert.equal(unsupportedEntitlement.data.code,"UNKNOWN_ADMIN_ACTION");
  const selfAction=await adminAction(admin,admin.user.id,"revoke-sessions");
  assert.equal(selfAction.response.status,409);
  assert.equal(selfAction.data.code,"ADMIN_SELF_PROTECTED");

  assert.deepEqual(databaseCounts(member.user.id),memberBefore,"invalid target actions must have no side effects");
  assert.deepEqual(databaseCounts(admin.user.id),adminBefore,"self-targeting must not revoke or alter the primary administrator");
});

test("session revocation, suspension, and restoration affect only the selected account",async()=>{
  const adminBefore=await request("/api/admin/session",{headers:{Cookie:admin.cookie}});
  assert.equal(adminBefore.response.status,200);

  const revoked=await adminAction(admin,member.user.id,"revoke-sessions");
  assert.equal(revoked.response.status,200);
  assert.match(revoked.data.message,/Signed the account out/i);
  assert.equal((await request("/api/me",{headers:{Cookie:member.cookie}})).response.status,401);
  assert.equal((await request("/api/me",{headers:{Cookie:member.secondCookie}})).response.status,401);
  assert.equal((await request("/api/admin/session",{headers:{Cookie:admin.cookie}})).response.status,200,"target revocation must not touch the admin session");
  assert.equal((await request("/api/me",{headers:{Cookie:nonAdmin.cookie}})).response.status,200,"target revocation must not touch unrelated sessions");

  member=await login(member.user.email,MEMBER_PASSWORD);
  assert.equal(member.response.status,200);
  const suspended=await adminAction(admin,member.user.id,"suspend");
  assert.equal(suspended.response.status,200);
  assert.ok(Number(suspended.data.user.suspendedAt)>0);
  assert.equal((await request("/api/me",{headers:{Cookie:member.cookie}})).response.status,401);
  const wrongPasswordWhileSuspended=await login(member.user.email,"definitely-not-the-member-password");
  const blockedLogin=await login(member.user.email,MEMBER_PASSWORD);
  assert.equal(blockedLogin.response.status,403);
  assert.equal(blockedLogin.data.code,"ACCOUNT_SUSPENDED");

  const restored=await adminAction(admin,member.user.id,"restore");
  assert.equal(restored.response.status,200);
  assert.equal(restored.data.user.suspendedAt,null);
  member=await login(member.user.email,MEMBER_PASSWORD);
  assert.equal(member.response.status,200);
  assert.equal(wrongPasswordWhileSuspended.response.status,401,"a wrong password must not reveal that an account is suspended");
  assert.notEqual(wrongPasswordWhileSuspended.data.code,"ACCOUNT_SUSPENDED");
});

test("reset and deletion assistance always emails the stored address, hides tokens, and supports cancellation",async()=>{
  const resetBefore=deliveries.length;
  const reset=await adminAction(admin,member.user.id,"send-password-reset");
  assert.equal(reset.response.status,200);
  assert.equal(deliveries.length,resetBefore+1);
  const resetDelivery=latestDelivery("Reset your STRATA password");
  const resetToken=actionToken(resetDelivery);
  assert.deepEqual(resetDelivery.body.to,[member.user.email]);
  assert.match(reset.data.message,/m\*+r@example\.test/i);
  assertAdminResponseRedacted(reset.data,[resetToken,sha256(resetToken),EMAIL_API_KEY,EMAIL_SECRET,MEMBER_PASSWORD]);

  const deletionBefore=deliveries.length;
  const deletion=await adminAction(admin,member.user.id,"send-delete-link");
  assert.equal(deletion.response.status,200);
  assert.equal(deliveries.length,deletionBefore+1);
  const deletionDelivery=latestDelivery("Confirm deletion of your STRATA account");
  const deletionToken=actionToken(deletionDelivery);
  assert.deepEqual(deletionDelivery.body.to,[member.user.email]);
  assert.equal(deletion.data.user.accountDeletion.pending,true);
  assertAdminResponseRedacted(deletion.data,[deletionToken,sha256(deletionToken),EMAIL_API_KEY,EMAIL_SECRET]);

  const canceled=await adminAction(admin,member.user.id,"cancel-deletion");
  assert.equal(canceled.response.status,200);
  assert.equal(canceled.data.user.accountDeletion.pending,false);
  const deletedStatus=await jsonRequest("/api/account/delete/status",{token:deletionToken});
  assert.equal(deletedStatus.response.status,200);
  assert.equal(deletedStatus.data.active,false);
  assert.equal((await request("/api/me",{headers:{Cookie:member.cookie}})).response.status,200,"requesting or canceling deletion must not sign out the customer");
});

test("anonymous support rejects credentials and payment-card numbers before persistence",async()=>{
  const before=databaseCounts(member.user.id);
  const baseRequest={
    name:"Privacy Conscious Customer",
    email:"privacy-check@example.test",
    category:"privacy",
    subject:"Please help me remove private information",
    referenceId:"privacy-check-42",
    message:"Please explain how STRATA handles the information in my account.",
    website:""
  };
  const secret=await jsonRequest("/api/support",{
    ...baseRequest,
    message:"I accidentally included password=supersecret123 in this request."
  });
  assert.equal(secret.response.status,400);
  assert.equal(secret.data.code,"SENSITIVE_SUPPORT_CONTENT");
  assertPrivateJson(secret.response);

  const card=await jsonRequest("/api/support",{
    ...baseRequest,
    email:"card-check@example.test",
    message:"I accidentally included card number 4242 4242 4242 4242 here."
  });
  assert.equal(card.response.status,400);
  assert.equal(card.data.code,"SENSITIVE_SUPPORT_CONTENT");
  assertPrivateJson(card.response);
  assert.deepEqual(databaseCounts(member.user.id),before,"rejected sensitive support content must not create tickets, rate reservations, audits, or email deliveries");
});

test("the contact form still works without JavaScript through a plain form post",async()=>{
  const form=(fields,ip)=>request("/api/support",{method:"POST",redirect:"manual",headers:{"Content-Type":"application/x-www-form-urlencoded",Origin:base,"X-Forwarded-For":ip},body:new URLSearchParams(fields).toString()});
  const sent=await form({name:"No Script",email:"no-script@example.test",category:"other",subject:"Form post without scripts",referenceId:"",message:"This came from the plain HTML form with JavaScript disabled.",website:""},"198.51.100.241");
  assert.equal(sent.response.status,303);
  const location=sent.response.headers.get("location");
  assert.match(location,/^\/contact\?sent=STR-\d{4}-[0-9A-F]{6}#supportStatus$/,"a successful post lands back on the contact page with its reference");
  const reference=new URL(location,base).searchParams.get("sent");
  const stored=openDatabase().prepare("SELECT reference,email,message FROM support_tickets WHERE reference=?").get(reference);
  assert.equal(stored.email,"no-script@example.test");
  const invalid=await form({name:"N",email:"not-an-email",category:"other",subject:"x",message:"short",website:""},"198.51.100.242");
  assert.equal(invalid.response.status,303);
  assert.equal(invalid.response.headers.get("location"),"/contact?error=INVALID_SUPPORT_REQUEST#supportStatus");
  const plainText=await request("/api/support",{method:"POST",headers:{"Content-Type":"text/plain",Origin:base,"X-Forwarded-For":"198.51.100.243"},body:"hello"});
  assert.equal(plainText.response.status,415,"other content types are still refused");
});

test("anonymous support rate reservations survive an application restart",async()=>{
  mkdirSync(join(PROJECT_ROOT,"test-runtime"),{recursive:true});
  const durableDir=mkdtempSync(join(PROJECT_ROOT,"test-runtime","admin-support-rate-"));
  const payload={
    name:"Anonymous Customer",
    email:"durable-limit@example.test",
    category:"account",
    subject:"Question about my STRATA account",
    referenceId:"durable-rate-test",
    message:"I need some help understanding an account setting in STRATA.",
    website:""
  };
  const ip="203.0.113.170";
  let first;
  let second;
  try {
    first=await launchAppInDirectory(undefined,durableDir);
    for(let attempt=0;attempt<4;attempt+=1){
      const accepted=await jsonRequestAt(first.base,"/api/support",payload,{ip});
      assert.equal(accepted.response.status,201,`support request ${attempt+1} should fit within the per-email limit`);
    }
    await stopChild(first.child);
    first=null;

    second=await launchAppInDirectory(undefined,durableDir);
    const limited=await jsonRequestAt(second.base,"/api/support",payload,{ip});
    assert.equal(limited.response.status,429);
    assert.equal(limited.data.code,"SUPPORT_RATE_LIMIT");
    assertPrivateJson(limited.response);

    const db=new DatabaseSync(join(durableDir,"strata.sqlite"));
    try {
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM support_request_events").get().count),4,"a denied request must not consume another durable reservation");
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM support_tickets").get().count),4);
    } finally {
      db.close();
    }
  } finally {
    await stopChild(first?.child);
    await stopChild(second?.child);
    rmSync(durableDir,{recursive:true,force:true});
  }
});

test("support management is admin-only, mutation-protected, auditable, and redacted",async()=>{
  const created=await jsonRequest("/api/support",{
    name:"Attacker Supplied Name",
    email:"attacker@example.test",
    category:"account",
    subject:"Please help with my account",
    referenceId:"customer-reference-42",
    message:"I need help understanding an account setting.",
    website:""
  },{cookie:member.cookie});
  assert.equal(created.response.status,201);
  assert.match(created.data.reference,/^STR-/);

  const anonymous=await request("/api/admin/support");
  assert.equal(anonymous.response.status,401);
  const nonAdminResult=await request("/api/admin/support",{headers:{Cookie:nonAdmin.cookie}});
  assert.equal(nonAdminResult.response.status,403);

  const list=await request("/api/admin/support?status=new&limit=100",{headers:{Cookie:admin.cookie}});
  assert.equal(list.response.status,200);
  assert.equal(list.data.limit,50);
  const ticket=list.data.tickets.find((item)=>item.reference===created.data.reference);
  assert.ok(ticket);
  assert.equal(ticket.userId,member.user.id);
  assert.equal(ticket.email,member.user.email,"a signed-in support request must use the stored address");
  assert.equal(ticket.name,member.user.name,"a signed-in support request must use the stored name");
  assertAdminResponseRedacted(list.data,[EMAIL_API_KEY,EMAIL_SECRET,ADMIN_PASSWORD,MEMBER_PASSWORD,admin.csrf,member.csrf]);

  const db=openDatabase();
  const original=db.prepare("SELECT status,admin_note,last_response_at FROM support_tickets WHERE id=?").get(ticket.id);
  const auditBefore=Number(db.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").get().count);
  db.close();
  const deliveryBefore=deliveries.length;
  const update={
    status:"waiting",
    note:"Asked the customer for one more detail.",
    response:"We received your request and need one more detail.",
    expectedUpdatedAt:ticket.updatedAt
  };
  const noOrigin=await jsonRequest(`/api/admin/support/${ticket.id}`,update,{cookie:admin.cookie,csrf:admin.csrf,origin:false});
  assert.equal(noOrigin.response.status,403);
  assert.equal(noOrigin.data.code,"ADMIN_ORIGIN_REQUIRED");
  const badCsrf=await jsonRequest(`/api/admin/support/${ticket.id}`,update,{cookie:admin.cookie,csrf:"wrong-support-csrf"});
  assert.equal(badCsrf.response.status,403);
  assert.equal(badCsrf.data.code,"INVALID_CSRF");
  const sensitive=await jsonRequest(`/api/admin/support/${ticket.id}`,{
    status:"open",note:`Bearer ${EMAIL_API_KEY}`,response:"",expectedUpdatedAt:ticket.updatedAt
  },{cookie:admin.cookie,csrf:admin.csrf});
  assert.equal(sensitive.response.status,400);
  assert.equal(sensitive.data.code,"SENSITIVE_SUPPORT_CONTENT");
  assertPrivateJson(sensitive.response);
  const check=openDatabase();
  assert.deepEqual(check.prepare("SELECT status,admin_note,last_response_at FROM support_tickets WHERE id=?").get(ticket.id),original);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM admin_audit_events").get().count,auditBefore);
  check.close();
  assert.equal(deliveries.length,deliveryBefore,"denied support updates must not send a response email");

  const updated=await jsonRequest(`/api/admin/support/${ticket.id}`,update,{cookie:admin.cookie,csrf:admin.csrf});
  assert.equal(updated.response.status,200);
  assert.equal(updated.data.ticket.status,"waiting");
  assert.equal(updated.data.ticket.note,update.note);
  assert.equal(deliveries.length,deliveryBefore+1);
  assert.deepEqual(deliveries.at(-1).body.to,[member.user.email]);
  assertAdminResponseRedacted(updated.data,[EMAIL_API_KEY,EMAIL_SECRET,ADMIN_PASSWORD,MEMBER_PASSWORD,admin.csrf,member.csrf]);

  const deliveredCount=deliveries.length;
  const stale=await jsonRequest(`/api/admin/support/${ticket.id}`,{
    status:"resolved",
    note:"This browser tab still has the old version.",
    response:"This stale response must not be delivered.",
    expectedUpdatedAt:ticket.updatedAt
  },{cookie:admin.cookie,csrf:admin.csrf});
  assert.equal(stale.response.status,409);
  assert.equal(stale.data.code,"SUPPORT_STATE_CHANGED");
  assert.equal(deliveries.length,deliveredCount,"a stale support update must not send a second email");
  assertPrivateJson(stale.response);

  const audit=await request("/api/admin/audit?limit=500",{headers:{Cookie:admin.cookie}});
  assert.equal(audit.response.status,200);
  assert.equal(audit.data.limit,100);
  for(const action of ["revoke-sessions","suspend","restore","send-password-reset","send-delete-link","cancel-deletion","support-updated"]){
    assert.ok(audit.data.events.some((event)=>event.action===action),`audit should include ${action}`);
  }
  assertPrivateJson(audit.response);
  assertAdminResponseRedacted(audit.data,[EMAIL_API_KEY,EMAIL_SECRET,ADMIN_PASSWORD,MEMBER_PASSWORD,admin.csrf,member.csrf]);
});

test("Admin derives bounded audit reasons and ignores obsolete client confirmation fields",async()=>{
  const secretReason=`Investigating with Bearer ${EMAIL_API_KEY}`;
  const result=await jsonRequest(`/api/admin/users/${member.user.id}/actions`,{
    action:"send-password-reset",reason:secretReason,confirmation:"WRONG"
  },{cookie:admin.cookie,csrf:admin.csrf});
  assert.equal(result.response.status,200);
  const audit=await request("/api/admin/audit",{headers:{Cookie:admin.cookie}});
  const event=audit.data.events.find((entry)=>entry.action==="send-password-reset"&&entry.target?.id===member.user.id);
  assert.ok(event);assert.equal(event.reason,"Owner initiated a password-reset email from Admin.");assert.ok(event.reason.length<=200);
  assert.ok(!JSON.stringify(audit.data).includes(EMAIL_API_KEY));
});

test("Admin automatically pauses deletion targets and preserves accounts with live billing",async()=>{
  const target=await verifiedSignup({name:"Delete Me",email:"delete-me@example.test",password:"delete-me-password-123"});
  const support=await jsonRequest("/api/support",{name:"Ignored",email:"ignored@example.test",category:"privacy",subject:"Delete this test account",referenceId:"direct-delete-test",message:"Please remove the account after the guarded administrator review.",website:""},{cookie:target.cookie});
  assert.equal(support.response.status,201);
  const db=openDatabase();
  const createdAt=Date.now();
  db.prepare("INSERT INTO plans(user_id,plan_json,updated_at) VALUES(?,?,?)").run(target.user.id,JSON.stringify({version:1,restDay:null,restDays:[],days:{}}),createdAt);
  db.prepare("INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,subscription_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,'completed',?,NULL,NULL,?,?)")
    .run("txn_direct_admin_delete",target.user.id,"pri_monthly_delete_test","pro_monthly_delete_test","ctm_retained_by_paddle","sub_direct_admin_delete",createdAt,createdAt,createdAt);
  db.prepare("INSERT INTO paddle_subscriptions(subscription_id,user_id,transaction_id,customer_id,status,price_id,product_id,scheduled_change_action,scheduled_change_at,current_period_ends_at,event_occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("sub_direct_admin_delete",target.user.id,"txn_direct_admin_delete","ctm_retained_by_paddle","active","pri_monthly_delete_test","pro_monthly_delete_test",null,null,createdAt+86_400_000,createdAt,createdAt,createdAt);
  db.close();

  const active=await adminAction(admin,target.user.id,"delete-account");
  assert.equal(active.response.status,409);
  assert.equal(active.data.code,"SUBSCRIPTION_ACTIVE");
  assert.equal((await request("/api/me",{headers:{Cookie:target.cookie}})).response.status,401);
  assert.ok(databaseCounts(target.user.id).user);

  const self=await adminAction(admin,admin.user.id,"delete-account");
  assert.equal(self.response.status,409);
  assert.equal(self.data.code,"ADMIN_SELF_PROTECTED");

  const detail=await request(`/api/admin/users/${target.user.id}`,{headers:{Cookie:admin.cookie}});
  assert.ok(detail.data.user.suspendedAt);
  assert.ok(databaseCounts(target.user.id).user);

  const subscribed=await adminAction(admin,target.user.id,"delete-account");
  assert.equal(subscribed.response.status,409);
  assert.equal(subscribed.data.code,"SUBSCRIPTION_ACTIVE");
  const canceledDb=openDatabase();
  canceledDb.prepare("UPDATE paddle_subscriptions SET status='canceled',current_period_ends_at=? WHERE subscription_id=?").run(Date.now(),"sub_direct_admin_delete");
  canceledDb.close();

  const beforeAudit=databaseCounts(target.user.id).audits;
  const deleted=await adminAction(admin,target.user.id,"delete-account");
  assert.equal(deleted.response.status,200);
  assert.match(deleted.data.message,/permanently deleted from STRATA/i);
  assert.doesNotMatch(JSON.stringify(deleted.data),/delete-me@example\.test|ctm_retained_by_paddle/i);
  assert.equal((await request("/api/me",{headers:{Cookie:target.cookie}})).response.status,401);
  assert.equal((await request("/api/admin/session",{headers:{Cookie:admin.cookie}})).response.status,200);
  assert.equal((await request("/api/me",{headers:{Cookie:nonAdmin.cookie}})).response.status,200);

  const check=openDatabase();
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM users WHERE id=?").get(target.user.id).count,0);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(target.user.id).count,0);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM plans WHERE user_id=?").get(target.user.id).count,0);
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM paddle_purchases WHERE user_id=?").get(target.user.id).count,0);
  assert.equal(check.prepare("SELECT user_id FROM support_tickets WHERE reference=?").get(support.data.reference).user_id,null,"support history is retained but detached");
  assert.equal(check.prepare("SELECT COUNT(*) AS count FROM admin_audit_events WHERE target_user_id=? AND action='delete-account'").get(target.user.id).count,1);
  check.close();
  assert.equal(databaseCounts(target.user.id).audits,beforeAudit+1,"deletion and its success audit must commit together");

  const replay=await adminAction(admin,target.user.id,"delete-account");
  assert.equal(replay.response.status,404);
  assert.equal(replay.data.code,"ADMIN_TARGET_NOT_FOUND");
  assertPrivateJson(replay.response);
});

test("admin grants timed or indefinite free Strata+, revokes it, and controls new payment sessions",async()=>{
  const target=await verifiedSignup({name:"Complimentary Member",email:"complimentary@example.test",password:MEMBER_PASSWORD});
  const path=`/api/admin/users/${target.user.id}/actions`;
  const send=(body,options={})=>jsonRequest(path,body,{cookie:admin.cookie,csrf:admin.csrf,...options});
  const grant={action:"grant-plus",expectedControlsRevision:0,grant:{unit:"minutes",amount:90}};
  assert.equal((await send(grant,{cookie:target.cookie,csrf:target.csrf})).response.status,403);
  assert.equal((await send(grant,{csrf:"wrong"})).response.status,403);
  assert.equal((await send({...grant,grant:{unit:"days",amount:-1}})).response.status,400);
  const timed=await send(grant);
  assert.equal(timed.response.status,200,JSON.stringify(timed.data));
  assert.equal(timed.data.user.controlsRevision,1);
  assert.ok(timed.data.user.discovery.adminGrant.expiresAt>Date.now()+89*60000);
  let me=await request("/api/me",{headers:{Cookie:target.cookie}});
  assert.equal(me.data.user.discovery.accessType,"grant");
  assert.equal((await request("/api/discovery",{headers:{Cookie:target.cookie}})).response.status,200);
  assert.equal((await jsonRequest("/api/discovery/trial",{},{cookie:target.cookie,csrf:target.csrf})).response.status,410,"the retired trial cannot start alongside a grant");
  const db=openDatabase();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paddle_purchases WHERE user_id=?").get(target.user.id).n,0);
  db.prepare("UPDATE admin_account_controls SET grant_starts_at=?,grant_expires_at=? WHERE user_id=?").run(Date.now()-2000,Date.now()-1000,target.user.id);db.close();
  assert.equal((await request("/api/discovery",{headers:{Cookie:target.cookie}})).response.status,402);
  assert.equal((await send(grant)).response.status,409,"stale controls must not overwrite a grant");
  const indefinite=await send({...grant,expectedControlsRevision:1,grant:{unit:"indefinite"}});
  assert.equal(indefinite.response.status,200);
  assert.equal(indefinite.data.user.discovery.adminGrant.expiresAt,null);
  const revoked=await send({action:"revoke-plus",expectedControlsRevision:2});
  assert.equal(revoked.response.status,200);
  assert.equal(revoked.data.user.discovery.active,false);
  const held=await send({action:"close-checkouts",expectedControlsRevision:3});
  assert.equal(held.response.status,200,JSON.stringify(held.data));
  assert.equal(held.data.user.checkoutBlocked,true);
  assert.match(held.data.message,/No unfinished/);
  const blocked=await jsonRequest("/api/billing/checkout",{},{cookie:target.cookie,csrf:target.csrf});
  assert.equal(blocked.data.code,"CHECKOUT_BLOCKED");
  const enabled=await send({action:"enable-checkouts",expectedControlsRevision:4});
  assert.equal(enabled.response.status,200);
  assert.equal(enabled.data.user.checkoutBlocked,false);
});

test("one reviewed admin deletion pauses and removes an active account without typed fields",async()=>{
  const target=await verifiedSignup({name:"Easy Removal",email:"easy-removal@example.test",password:MEMBER_PASSWORD});
  const deleted=await adminAction(admin,target.user.id,"delete-account");
  assert.equal(deleted.response.status,200,JSON.stringify(deleted.data));
  assert.equal((await request("/api/me",{headers:{Cookie:target.cookie}})).response.status,401);
  assert.equal((await request(`/api/admin/users/${target.user.id}`,{headers:{Cookie:admin.cookie}})).response.status,404);
});
