"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_ROOT=join(__dirname,"..");
const RELEASE=require(join(PROJECT_ROOT,"package.json"));
const BUILD=RELEASE.strataBuild||RELEASE.version;
const BUILD_LABEL=new RegExp(`Build ${BUILD.replace(/\./g,"\\.")}`);
const {STRATA_PLUS_TRIAL_MS}=require("../src/payments");

let server;
let runtimeDir;
let BASE;

async function startServer() {
  mkdirSync(join(PROJECT_ROOT,"test-runtime"),{recursive:true});
  runtimeDir=mkdtempSync(join(PROJECT_ROOT,"test-runtime","run-"));
  server=spawn(process.execPath,["server.js"],{cwd:PROJECT_ROOT,env:{...process.env,PORT:"0",HOST:"127.0.0.1",NODE_ENV:"test",ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",TRUST_PROXY:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRODUCT_ID:"",PADDLE_PRICE_ID:""},stdio:["ignore","pipe","pipe"]});
  try {
    BASE=await new Promise((resolve,reject) => {
      let output="",settled=false,timer;
      const fail=(error)=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);};
      timer=setTimeout(()=>fail(new Error("Server startup timed out")),5000);
      server.stdout.on("data",(chunk)=>{
        output=(output+chunk.toString()).slice(-4096);
        const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
        if(match&&!settled){settled=true;clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}
      });
      server.stderr.on("data",(chunk)=>process.stderr.write(chunk));
      server.once("error",fail);
      server.once("exit",(code,signal)=>fail(new Error(`Server exited before startup (${code??signal??"unknown"})`)));
    });
  } catch(error) {
    await stopServer();
    throw error;
  }
}

async function stopServer() {
  const child=server;
  server=undefined;
  if(child&&child.exitCode===null&&child.signalCode===null){
    await new Promise((resolve)=>{
      let timer;
      child.once("exit",()=>{clearTimeout(timer);resolve();});
      child.kill("SIGTERM");
      timer=setTimeout(()=>child.kill("SIGKILL"),2000);
    });
  }
  if(runtimeDir) rmSync(runtimeDir,{recursive:true,force:true});
  runtimeDir=undefined;
  BASE=undefined;
}

async function request(path,options={}) {
  const response=await fetch(`${BASE}${path}`,options);
  const data=(response.headers.get("content-type")||"").includes("application/json")?await response.json():await response.text();
  return {response,data,cookie:response.headers.get("set-cookie")?.split(";")[0]||""};
}

test.before(startServer);
test.after(stopServer);

test("serves rankings and gates private account pages",async()=>{
  assert.equal(BUILD,"8.5.0");
  const home=await request("/");
  assert.equal(home.response.status,200);
  assert.equal(home.response.headers.get("cache-control"),"private, no-store");
  assert.match(home.response.headers.get("vary"),/Cookie/i);
  assert.match(home.data,/YOUR NEXT<br \/>WORKOUT/);
  assert.match(home.data,/id="signupButton"[^>]*>Sign up/);
  assert.match(home.data,/id="accountButton"[^>]*>Log in/);
  assert.match(home.data,BUILD_LABEL);
  const account=await request("/account.html");
  assert.equal(account.response.status,200);
  assert.match(account.data,/action="\/auth\/signup"/);
  assert.match(account.data,/action="\/auth\/login"/);
  assert.match(account.data,BUILD_LABEL);
  const status=await request("/api/status");
  assert.equal(status.response.status,200);
  assert.equal(status.data.ok,true);
  assert.equal(status.data.build,BUILD);
  assert.equal(status.data.paymentsConfigured,false);
  assert.equal(typeof status.data.passwordResetEnabled,"boolean");
  assert.equal(typeof status.data.accountDeletionEnabled,"boolean");
  assert.equal(status.data.checkoutEnabled,false);
  const billing=await request("/api/billing/config");
  assert.equal(billing.response.status,200);
  assert.equal(billing.data.configured,false);
  assert.equal(billing.data.enabled,false);
  assert.equal(billing.data.clientToken,"");
  assert.equal(billing.data.productId,"","a current Paddle product must be explicitly configured");
  assert.equal(billing.data.priceId,"","a recurring Paddle price must be explicitly configured");
  assert.deepEqual(billing.data.price,{amount:"2.99",currency:"USD",interval:"month",frequency:1});
  assert.doesNotMatch(JSON.stringify(billing.data),/pdl_(?:live|sandbox|sdbx)_apikey_|pdl_ntfset_/i);
  for(const endpoint of ["/livez","/readyz","/healthz"]){
    const health=await request(endpoint,{headers:{"X-Request-ID":"edge-probe-request-1234"}});
    assert.equal(health.response.status,200,endpoint);
    assert.deepEqual(health.data,{ok:true},endpoint);
    assert.equal(health.response.headers.get("x-request-id"),"edge-probe-request-1234",endpoint);
    assert.deepEqual(Object.keys(health.data),["ok"],`${endpoint} must not expose storage or deployment details`);
  }
  const malformedCookie=await request("/api/me",{headers:{Cookie:"broken=%E0%A4%A"}});
  assert.equal(malformedCookie.response.status,401);
  const planner=await request("/planner.html",{redirect:"manual"});
  assert.equal(planner.response.status,200);
  assert.match(planner.data,/Free device plan[\s\S]*No account required[\s\S]*Use a synced plan/);
  const pendingPlanner=await request("/planner.html?add=flat-dumbbell-press",{redirect:"manual"});
  assert.equal(pendingPlanner.response.status,200);
  const discover=await request("/discover.html",{redirect:"manual"});
  assert.equal(discover.response.status,302);
  assert.equal(discover.response.headers.get("location"),"/account.html?mode=login&next=discover");
  const discoveryApi=await request("/api/discovery");
  assert.equal(discoveryApi.response.status,401);
});

test("serves public pricing, contact, and policy pages at friendly routes",async()=>{
  const pages={pricing:/MONTHLY SUBSCRIPTION/i,contact:/TALK TO/,policies:/PUBLIC POLICIES/,terms:/TERMS OF/,privacy:/PRIVACY/,refunds:/14-DAY/};
  for(const [slug,marker] of Object.entries(pages)) {
    for(const path of [`/${slug}`,`/${slug}/`,`/${slug}.html`]) {
      const page=await request(path);
      assert.equal(page.response.status,200,`${path} status`);
      assert.match(page.response.headers.get("content-type")||"",/^text\/html/i,`${path} content type`);
      assert.equal(page.response.headers.get("cache-control"),"no-cache",`${path} cache policy`);
      assert.doesNotMatch(page.response.headers.get("vary")||"",/Cookie/i,`${path} must not vary by account`);
      assert.match(page.data,marker,`${path} page marker`);
      assert.match(page.data,BUILD_LABEL,`${path} build label`);
    }
  }
});

test("serves recovery pages at friendly private routes",async()=>{
  const pages={"forgot-password":/SEND RESET LINK/,"reset-password":/NEW PASSWORD/,"delete-account":/THIS CANNOT BE UNDONE/};
  for(const [slug,marker] of Object.entries(pages)) {
    for(const path of [`/${slug}`,`/${slug}/`,`/${slug}.html`]) {
      const page=await request(path);
      assert.equal(page.response.status,200,path);
      assert.equal(page.response.headers.get("cache-control"),"private, no-store",path);
      assert.match(page.response.headers.get("vary"),/Cookie/i,path);
      assert.match(page.data,marker,path);
      assert.match(page.data,BUILD_LABEL,path);
    }
  }
});

test("does not expose physical project paths or private server data",async()=>{
  for(const path of ["/public/pages/index.html","/src/server.js","/src/data/discovery-data.json","/discovery-data.json","/data/strata.sqlite"]) {
    const response=await request(path);
    assert.equal(response.response.status,404,`${path} must stay private`);
  }
});

test("creates an account with a private default plan",async()=>{
  const sharedPassword="correct-horse-123";
  const signup=await request("/api/signup",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({name:"Test Lifter",email:"lifter@example.test",password:sharedPassword})});
  assert.equal(signup.response.status,201);
  assert.ok(signup.cookie.startsWith("strata_session="));
  assert.match(signup.response.headers.get("set-cookie"),/HttpOnly/);
  assert.match(signup.response.headers.get("set-cookie"),/SameSite=Strict/);

  const malformedAlongsideSession=await request("/api/me",{headers:{Cookie:`broken=%E0%A4%A; ${signup.cookie}`}});
  assert.equal(malformedAlongsideSession.response.status,200);

  const signedInHome=await request("/",{headers:{Cookie:signup.cookie}});
  assert.equal(signedInHome.response.status,200);
  assert.equal(signedInHome.response.headers.get("cache-control"),"private, no-store");
  assert.match(signedInHome.data,/Test profile/);
  assert.match(signedInHome.data,/id="signupButton"[^>]* hidden/);
  assert.match(signedInHome.data,/id="discoverButton"[^>]*href="\/pricing"[^>]*>Unlock Strata\+/);

  const plannerPage=await request("/planner.html",{headers:{Cookie:signup.cookie}});
  assert.equal(plannerPage.response.status,200);
  assert.equal(plannerPage.response.headers.get("cache-control"),"no-cache");
  assert.match(plannerPage.data,/BUILD YOUR/);
  assert.match(plannerPage.data,BUILD_LABEL);

  const discoverPage=await request("/discover.html",{headers:{Cookie:signup.cookie},redirect:"manual"});
  assert.equal(discoverPage.response.status,302);
  assert.match(discoverPage.response.headers.get("cache-control")||"",/no-store/);
  assert.equal(discoverPage.response.headers.get("location"),"/pricing?reason=discovery-required");

  const plan=await request("/api/plan",{headers:{Cookie:signup.cookie}});
  assert.equal(plan.response.status,200);
  assert.equal(plan.data.plan.restDay,"Sunday");
  assert.deepEqual(plan.data.plan.days.Monday,[]);
  const csrfToken=plan.data.csrfToken;
  assert.ok(csrfToken);

  const me=await request("/api/me",{headers:{Cookie:signup.cookie}});
  assert.equal(me.data.user.discovery.trial.eligible,true);
  const missingCsrf=await request("/api/discovery/trial",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json"},body:"{}"});
  assert.equal(missingCsrf.response.status,403);
  const trial=await request("/api/discovery/trial",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":me.data.csrfToken},body:JSON.stringify({durationMinutes:525_600,expiresAt:Number.MAX_SAFE_INTEGER})});
  assert.equal(trial.response.status,201);
  assert.equal(trial.data.user.discovery.active,true);
  assert.equal(trial.data.user.discovery.accessType,"trial");
  assert.equal(trial.data.user.discovery.trial.active,true);
  assert.equal(trial.data.user.discovery.trial.expiresAt-trial.data.user.discovery.trial.startedAt,STRATA_PLUS_TRIAL_MS,"client input cannot alter the server-owned 7-day window");
  const repeatedTrial=await request("/api/discovery/trial",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":me.data.csrfToken},body:"{}"});
  assert.equal(repeatedTrial.response.status,200,"repeating an active trial request is idempotent");
  assert.equal(repeatedTrial.data.user.discovery.trial.startedAt,trial.data.user.discovery.trial.startedAt,"a replay cannot move the trial start");
  assert.equal(repeatedTrial.data.user.discovery.trial.expiresAt,trial.data.user.discovery.trial.expiresAt,"a replay cannot extend the trial");
  const trialDiscovery=await request("/api/discovery",{headers:{Cookie:signup.cookie}});
  assert.equal(trialDiscovery.response.status,200);

  const profile={version:1,goal:"strength",level:"Intermediate",days:4,equipment:["Dumbbells","Bodyweight"],preferences:["stable"],limitations:[]};
  const missingProfileCsrf=await request("/api/preferences",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({preferences:profile})});
  assert.equal(missingProfileCsrf.response.status,403);
  assert.equal(missingProfileCsrf.data.code,"INVALID_CSRF");
  const wrongProfileCsrf=await request("/api/preferences",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":"wrong-token"},body:JSON.stringify({preferences:profile})});
  assert.equal(wrongProfileCsrf.response.status,403);
  assert.equal(wrongProfileCsrf.data.code,"INVALID_CSRF");
  const savedProfile=await request("/api/preferences",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({preferences:profile})});
  assert.equal(savedProfile.response.status,200);
  assert.deepEqual(savedProfile.data.preferences,profile);

  const unauthenticatedSave=await request("/api/plan",{method:"PUT",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({plan:plan.data.plan})});
  assert.equal(unauthenticatedSave.response.status,401);

  const missingPlanCsrf=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({plan:plan.data.plan,expectedPlanUpdatedAt:plan.data.planUpdatedAt})});
  assert.equal(missingPlanCsrf.response.status,403);
  assert.equal(missingPlanCsrf.data.code,"INVALID_CSRF");
  const wrongPlanCsrf=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":"wrong-token"},body:JSON.stringify({plan:plan.data.plan,expectedPlanUpdatedAt:plan.data.planUpdatedAt})});
  assert.equal(wrongPlanCsrf.response.status,403);
  assert.equal(wrongPlanCsrf.data.code,"INVALID_CSRF");

  const missingPlanVersion=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:plan.data.plan})});
  assert.equal(missingPlanVersion.response.status,400);
  assert.equal(missingPlanVersion.data.code,"PLAN_VERSION_REQUIRED");

  plan.data.plan.days.Monday.push({instanceId:"test-instance-001",exerciseId:"incline-smith-press",sets:3,reps:"8–10"});
  plan.data.plan.days.Tuesday.push({instanceId:"test-instance-001",exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"});
  const saved=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:plan.data.plan,expectedPlanUpdatedAt:plan.data.planUpdatedAt})});
  assert.equal(saved.response.status,200);
  assert.equal(saved.data.stats.planCount,2);
  const savedIds=[saved.data.plan.days.Monday[0].instanceId,saved.data.plan.days.Tuesday[0].instanceId];
  assert.equal(new Set(savedIds).size,2);

  const fractionalPlan=structuredClone(saved.data.plan);
  fractionalPlan.days.Monday[0].sets=2.5;
  const fractional=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:fractionalPlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(fractional.response.status,400);
  assert.equal(fractional.data.error,"Sets must be a whole number from 1 to 10.");

  const occupiedRestPlan=structuredClone(saved.data.plan);
  occupiedRestPlan.restDay="Monday";occupiedRestPlan.restDays=["Monday"];
  const occupiedRest=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:occupiedRestPlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(occupiedRest.response.status,400);
  assert.equal(occupiedRest.data.error,"Rest days must not contain exercises.");

  const invalidRestPlan=structuredClone(saved.data.plan);
  invalidRestPlan.restDay="Funday";invalidRestPlan.restDays=["Funday"];
  const invalidRest=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:invalidRestPlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(invalidRest.response.status,400);
  assert.equal(invalidRest.data.error,"Choose valid, unique rest days.");

  const malformedPlan=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:null,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(malformedPlan.response.status,400);

  const unknownExercisePlan=structuredClone(saved.data.plan);
  unknownExercisePlan.days.Wednesday.push({instanceId:"unknown-exercise-001",exerciseId:"not-in-the-library",sets:3,reps:"8–12"});
  const unknownExercise=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:unknownExercisePlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(unknownExercise.response.status,400);
  assert.equal(unknownExercise.data.error,"Plan contains an unknown exercise.");

  const newerPlan=structuredClone(saved.data.plan);
  newerPlan.days.Monday[0].reps="6–8";
  const newerSave=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:newerPlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(newerSave.response.status,200);
  assert.ok(newerSave.data.planUpdatedAt>saved.data.planUpdatedAt);
  const lostResponseRetry=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:newerPlan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(lostResponseRetry.response.status,200,"retrying an already-committed identical plan is idempotent");
  assert.equal(lostResponseRetry.data.reused,true);
  assert.equal(lostResponseRetry.data.planUpdatedAt,newerSave.data.planUpdatedAt,"an idempotent retry must not invent a new revision");
  const staleSave=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:JSON.stringify({plan:saved.data.plan,expectedPlanUpdatedAt:saved.data.planUpdatedAt})});
  assert.equal(staleSave.response.status,409);
  assert.equal(staleSave.data.code,"PLAN_CHANGED");
  assert.equal(staleSave.data.planUpdatedAt,newerSave.data.planUpdatedAt);
  assert.deepEqual(staleSave.data.plan,newerSave.data.plan,"a stale tab receives the authoritative plan without overwriting it");

  const oversizedBody=JSON.stringify({plan:saved.data.plan,padding:"😀".repeat(17000)});
  assert.ok(oversizedBody.length<65536);
  assert.ok(Buffer.byteLength(oversizedBody)>65536);
  const oversized=await request("/api/plan",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":csrfToken},body:oversizedBody});
  assert.equal(oversized.response.status,413);
  const healthAfterOversize=await request("/healthz");
  assert.equal(healthAfterOversize.response.status,200);

  const second=await request("/api/signup",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({name:"Second Lifter",email:"second@example.test",password:sharedPassword})});
  assert.equal(second.response.status,201);
  const database=new DatabaseSync(join(runtimeDir,"strata.sqlite"),{readOnly:true});
  const storedCredentials=database.prepare("SELECT email,password_hash,password_salt FROM users WHERE email IN (?,?) ORDER BY email").all("lifter@example.test","second@example.test");
  database.close();
  assert.equal(storedCredentials.length,2);
  assert.ok(storedCredentials.every((row)=>row.password_hash!==sharedPassword&&row.password_salt&&row.password_hash));
  assert.notEqual(storedCredentials[0].password_salt,storedCredentials[1].password_salt);
  assert.notEqual(storedCredentials[0].password_hash,storedCredentials[1].password_hash);
  const secondPlan=await request("/api/plan",{headers:{Cookie:second.cookie}});
  assert.equal(secondPlan.data.plan.days.Monday.length,0);

  const restored=await request("/api/plan",{headers:{Cookie:signup.cookie}});
  assert.equal(restored.data.plan.days.Monday.length,1);
  assert.equal(restored.data.plan.days.Tuesday.length,1);
  assert.equal(restored.data.plan.days.Monday[0].sets,3);
});

test("a Strata+ trial is one exact server-owned window across concurrent and expired replays",async()=>{
  const signup=await request("/api/signup",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({name:"Trial Boundary",email:"trial-boundary@example.test",password:"trial-boundary-password-123"})});
  assert.equal(signup.response.status,201);
  const me=await request("/api/me",{headers:{Cookie:signup.cookie}});
  const headers={Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":me.data.csrfToken};
  const attempts=await Promise.all([
    request("/api/discovery/trial",{method:"POST",headers,body:JSON.stringify({durationMinutes:1})}),
    request("/api/discovery/trial",{method:"POST",headers,body:JSON.stringify({durationMinutes:999_999})})
  ]);
  assert.deepEqual(attempts.map(({response})=>response.status).sort(),[200,201]);
  const windows=attempts.map(({data})=>data.user.discovery.trial);
  assert.equal(windows[0].startedAt,windows[1].startedAt,"concurrent activation keeps one start timestamp");
  assert.equal(windows[0].expiresAt,windows[1].expiresAt,"concurrent activation keeps one expiry timestamp");
  assert.equal(windows[0].expiresAt-windows[0].startedAt,STRATA_PLUS_TRIAL_MS,"the browser cannot shorten or extend the server window");

  const legacyDatabase=new DatabaseSync(join(runtimeDir,"strata.sqlite"));
  try{legacyDatabase.prepare("UPDATE discovery_trials SET expires_at=? WHERE user_id=?").run(windows[0].startedAt+10*24*60*60*1000,signup.data.user.id);}finally{legacyDatabase.close();}
  const clampedAccount=await request("/api/me",{headers:{Cookie:signup.cookie}});
  assert.equal(clampedAccount.data.user.discovery.trial.active,true);
  assert.equal(clampedAccount.data.user.discovery.trial.expiresAt,windows[0].startedAt+STRATA_PLUS_TRIAL_MS,"legacy longer rows are bounded by the current server policy");

  const expiredAt=Date.now()-1_000,startedAt=expiredAt-STRATA_PLUS_TRIAL_MS;
  const database=new DatabaseSync(join(runtimeDir,"strata.sqlite"));
  try{database.prepare("UPDATE discovery_trials SET started_at=?,expires_at=? WHERE user_id=?").run(startedAt,expiredAt,signup.data.user.id);}finally{database.close();}
  const expiredAccount=await request("/api/me",{headers:{Cookie:signup.cookie}});
  assert.equal(expiredAccount.data.user.discovery.active,false);
  assert.equal(expiredAccount.data.user.discovery.trial.active,false);
  assert.equal(expiredAccount.data.user.discovery.trial.eligible,false);
  const denied=await request("/api/discovery",{headers:{Cookie:signup.cookie}});
  assert.equal(denied.response.status,402,"server access closes as soon as the stored expiry passes");
  const replay=await request("/api/discovery/trial",{method:"POST",headers,body:"{}"});
  assert.equal(replay.response.status,409);
  assert.equal(replay.data.code,"TRIAL_ALREADY_USED");
  const afterReplay=new DatabaseSync(join(runtimeDir,"strata.sqlite"),{readOnly:true});
  try{
    const stored=afterReplay.prepare("SELECT started_at,expires_at FROM discovery_trials WHERE user_id=?").get(signup.data.user.id);
    assert.equal(stored.started_at,startedAt,"an expired replay cannot move the original start");
    assert.equal(stored.expires_at,expiredAt,"an expired replay cannot extend access");
  }finally{afterReplay.close();}
});

test("rejects incorrect passwords and cross-origin writes",async()=>{
  const badLogin=await request("/api/login",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({email:"lifter@example.test",password:"not-the-password"})});
  assert.equal(badLogin.response.status,401);

  const crossOrigin=await request("/api/login",{method:"POST",headers:{Origin:"https://attacker.invalid","Content-Type":"application/json"},body:JSON.stringify({email:"lifter@example.test",password:"correct-horse-123"})});
  assert.equal(crossOrigin.response.status,403);
});

test("logs out and signs back into the same account with the original password",async()=>{
  const credentials={name:"Returning Lifter",email:"returning@example.test",password:"remember-this-password-123"};
  const signup=await request("/api/signup",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify(credentials)});
  assert.equal(signup.response.status,201);
  const logout=await request("/api/logout",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE}});
  assert.equal(logout.response.status,200);
  assert.match(logout.response.headers.get("set-cookie")||"",/strata_session=;.*Max-Age=0/i);
  const repeatedLogout=await request("/api/logout",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE}});
  assert.equal(repeatedLogout.response.status,200,"logout must also clear stale or unauthenticated cookies");
  assert.match(repeatedLogout.response.headers.get("set-cookie")||"",/strata_session=;.*Max-Age=0/i);
  const afterLogout=await request("/api/me",{headers:{Cookie:signup.cookie}});
  assert.equal(afterLogout.response.status,401);
  const login=await request("/api/login",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({email:credentials.email,password:credentials.password})});
  assert.equal(login.response.status,200);
  assert.ok(login.cookie.startsWith("strata_session="));
  assert.equal(login.data.user.email,credentials.email);
  const restored=await request("/api/me",{headers:{Cookie:login.cookie}});
  assert.equal(restored.response.status,200);
  assert.equal(restored.data.user.name,credentials.name);
});

test("native account forms create and restore an account without modal JavaScript",async()=>{
  const password="native-form-password-123",email="native@example.test";
  const signup=await request("/auth/signup",{method:"POST",redirect:"manual",headers:{Origin:BASE,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({name:"Native Account",email,password,next:"pricing"}).toString()});
  assert.equal(signup.response.status,303);
  assert.equal(signup.response.headers.get("location"),"/pricing");
  assert.ok(signup.cookie.startsWith("strata_session="));
  const me=await request("/api/me",{headers:{Cookie:signup.cookie}});
  assert.equal(me.response.status,200);
  const logout=await request("/api/logout",{method:"POST",headers:{Cookie:signup.cookie,Origin:BASE}});
  assert.equal(logout.response.status,200);
  const requestedNext="/planner.html?add=flat-dumbbell-press";
  const failedLogin=await request("/auth/login",{method:"POST",redirect:"manual",headers:{Origin:BASE,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({email,password:"incorrect-password",next:requestedNext}).toString()});
  assert.equal(failedLogin.response.status,303);
  const failureLocation=new URL(failedLogin.response.headers.get("location"),BASE);
  assert.equal(failureLocation.pathname,"/account.html");
  assert.equal(failureLocation.searchParams.get("mode"),"login");
  assert.equal(failureLocation.searchParams.get("next"),"planner");
  assert.equal(failureLocation.searchParams.get("add"),"flat-dumbbell-press");
  assert.match(failureLocation.searchParams.get("error"),/incorrect/i);
  const login=await request("/auth/login",{method:"POST",redirect:"manual",headers:{Origin:BASE,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({email,password,next:requestedNext}).toString()});
  assert.equal(login.response.status,303);
  assert.equal(login.response.headers.get("location"),requestedNext);
  const restored=await request("/api/me",{headers:{Cookie:login.cookie}});
  assert.equal(restored.response.status,200);
  assert.equal(restored.data.user.email,email);
});

test("keeps unpaid accounts out of Strata+ while the free planner remains available",async()=>{
  const signup=await request("/api/signup",{method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({name:"Discovery Tester",email:"discover@example.test",password:"discovery-safe-789"})});
  assert.equal(signup.response.status,201);
  assert.equal(signup.data.user.discovery.active,false);

  const page=await request("/discover.html",{headers:{Cookie:signup.cookie},redirect:"manual"});
  assert.equal(page.response.status,302);
  assert.equal(page.response.headers.get("location"),"/pricing?reason=discovery-required");
  assert.match(page.response.headers.get("cache-control")||"",/no-store/);
  const engine=await request("/discovery-core.js",{headers:{Cookie:signup.cookie}});
  assert.equal(engine.response.status,200);
  assert.match(engine.data,/comparisonRecommendation/);

  const initial=await request("/api/discovery",{headers:{Cookie:signup.cookie}});
  assert.equal(initial.response.status,402);
  assert.equal(initial.data.code,"DISCOVERY_ACCESS_REQUIRED");

  const preferences={goal:"strength",level:"Beginner",days:3,equipment:["Dumbbells","Bodyweight"],preferences:["stable","simple-setup"],limitations:["no-overhead"]};
  const savedPreferences=await request("/api/preferences",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({preferences})});
  assert.equal(savedPreferences.response.status,402);
  assert.equal(savedPreferences.data.code,"DISCOVERY_ACCESS_REQUIRED");

  const rating={comfort:5,pump:5,enjoyment:4,stability:4,setup:3,overall:5};
  const savedRating=await request("/api/ratings/flat-dumbbell-press",{method:"PUT",headers:{Cookie:signup.cookie,Origin:BASE,"Content-Type":"application/json"},body:JSON.stringify({rating})});
  assert.equal(savedRating.response.status,402);
  assert.equal(savedRating.data.code,"DISCOVERY_ACCESS_REQUIRED");

  const planner=await request("/planner.html",{headers:{Cookie:signup.cookie}});
  assert.equal(planner.response.status,200);
  assert.match(planner.data,/BUILD YOUR/);
  const plan=await request("/api/plan",{headers:{Cookie:signup.cookie}});
  assert.equal(plan.response.status,200);

  const database=new DatabaseSync(join(runtimeDir,"strata.sqlite"),{readOnly:true});
  const preferenceCount=database.prepare("SELECT COUNT(*) AS count FROM preferences WHERE user_id=?").get(signup.data.user.id).count;
  const ratingCount=database.prepare("SELECT COUNT(*) AS count FROM ratings WHERE user_id=?").get(signup.data.user.id).count;
  database.close();
  assert.equal(preferenceCount,0);
  assert.equal(ratingCount,0);
});
