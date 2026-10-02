"use strict";

const {spawn}=require("node:child_process");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {performance}=require("node:perf_hooks");
const {createStore}=require("../src/database");

const ROOT=join(__dirname,"..");
const RUNTIME_ROOT=join(ROOT,"test-runtime");
const SAMPLE_COUNT=boundedInteger(process.env.STRATA_PERF_SAMPLES,40,10,500);
const WARMUP_COUNT=Math.min(8,Math.max(3,Math.floor(SAMPLE_COUNT/5)));
const STORAGE_FIXTURE_ACCOUNTS=500;

// These are regression tripwires for a quiet local/CI runner, not production
// SLOs. They are intentionally far above the checked-in measured baseline so
// normal scheduler noise does not turn the release check into a coin flip.
const PERFORMANCE_BUDGETS=Object.freeze({
  "endpoint.health":{medianMs:20,p95Ms:75},
  "endpoint.status":{medianMs:20,p95Ms:75},
  "endpoint.authenticatedPlan":{medianMs:35,p95Ms:125},
  "endpoint.authenticatedPlanSave":{medianMs:35,p95Ms:125},
  "storage.sessionLookup":{medianMs:5,p95Ms:20},
  "storage.planLookup":{medianMs:5,p95Ms:20},
  "storage.planCompareAndSwap":{medianMs:10,p95Ms:35}
});

function boundedInteger(value,fallback,min,max) {
  const parsed=Number(value??fallback);
  return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;
}

function percentile(sorted,fraction) {
  const index=Math.max(0,Math.ceil(sorted.length*fraction)-1);
  return sorted[index];
}

async function benchmark(name,operation) {
  for (let index=0;index<WARMUP_COUNT;index+=1) await operation();
  const durations=[];
  for (let index=0;index<SAMPLE_COUNT;index+=1) {
    const started=performance.now();
    await operation();
    durations.push(performance.now()-started);
  }
  durations.sort((left,right)=>left-right);
  return {
    name,
    samples:SAMPLE_COUNT,
    medianMs:Number(percentile(durations,0.5).toFixed(3)),
    p95Ms:Number(percentile(durations,0.95).toFixed(3))
  };
}

async function checkedJson(url,options) {
  const response=await fetch(url,options);
  const body=await response.json();
  if (!response.ok) throw new Error(`${options?.method||"GET"} ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return {response,body};
}

function isolatedServerEnvironment(dataDirectory) {
  return {
    PORT:"0",
    HOST:"127.0.0.1",
    NODE_ENV:"test",
    TZ:"UTC",
    STRATA_DATA_DIR:dataDirectory,
    TURSO_DATABASE_URL:"",
    TURSO_AUTH_TOKEN:"",
    TRUST_PROXY:"false",
    APP_BASE_URL:"",
    SECURE_COOKIES:"false",
    ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",
    EMAIL_VERIFICATION_ENABLED:"false",
    EMAIL_VERIFICATION_SECRET:"",
    // Keep the retired alias blank as well so an older checkout of the server
    // cannot inherit it when this benchmark script is reused during a bisect.
    EMAIL_VERIFICATION_HMAC_SECRET:"",
    EMAIL_FROM:"",
    EMAIL_REPLY_TO:"",
    SUPPORT_EMAIL:"",
    RESEND_API_KEY:"",
    RESEND_API_BASE:"",
    ADMIN_EMAIL:"",
    PADDLE_CHECKOUT_ENABLED:"false",
    PADDLE_ENFORCE_IP_ALLOWLIST:"false",
    PADDLE_CLIENT_TOKEN:"",
    PADDLE_API_KEY:"",
    PADDLE_WEBHOOK_SECRET:"",
    PADDLE_PRODUCT_ID:"",
    PADDLE_PRICE_ID:"",
    PADDLE_API_BASE:""
  };
}

async function startServer(dataDirectory) {
  const child=spawn(process.execPath,["server.js"],{
    cwd:ROOT,
    env:isolatedServerEnvironment(dataDirectory),
    stdio:["ignore","pipe","pipe"]
  });
  return new Promise((resolve,reject)=>{
    let output="",settled=false;
    const timer=setTimeout(()=>finish(new Error("Performance server startup timed out.")),8_000);
    function finish(error,baseUrl) {
      if (settled) return;
      settled=true;
      clearTimeout(timer);
      if (!error) { resolve({child,baseUrl}); return; }
      void stopServer(child).then(
        ()=>reject(error),
        (cleanupError)=>reject(new AggregateError([error,cleanupError],"Performance server startup and cleanup failed."))
      );
    }
    child.stdout.on("data",(chunk)=>{
      output=(output+chunk.toString()).slice(-4096);
      const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null,`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data",(chunk)=>process.stderr.write(chunk));
    child.once("error",finish);
    child.once("exit",(code,signal)=>finish(new Error(`Performance server exited before startup (${code??signal??"unknown"}).`)));
  });
}

async function stopServer(child) {
  if (!child||child.exitCode!==null||child.signalCode!==null) return;
  await new Promise((resolve)=>{
    let softTimer,hardTimer,settled=false;
    const finish=()=>{
      if (settled) return;
      settled=true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      child.off("exit",finish);
      resolve();
    };
    child.once("exit",finish);
    if (child.exitCode!==null||child.signalCode!==null) { finish(); return; }
    softTimer=setTimeout(()=>{
      hardTimer=setTimeout(finish,2_000);
      if (child.exitCode!==null||child.signalCode!==null) { finish(); return; }
      try { child.kill("SIGKILL"); } catch { finish(); }
    },2_000);
    try { child.kill("SIGTERM"); } catch { finish(); }
  });
}

async function endpointEvidence(dataDirectory) {
  const {child,baseUrl}=await startServer(dataDirectory);
  try {
    const signup=await checkedJson(`${baseUrl}/api/signup`,{
      method:"POST",
      headers:{Origin:baseUrl,"Content-Type":"application/json"},
      body:JSON.stringify({name:"Performance Check",email:"performance@example.test",password:"performance-check-password"})
    });
    const cookie=(signup.response.headers.get("set-cookie")||"").split(";",1)[0];
    if (!cookie) throw new Error("Performance account did not receive a session cookie.");
    const plan=await checkedJson(`${baseUrl}/api/plan`,{headers:{Cookie:cookie}});
    if (!plan.body.csrfToken) throw new Error("Performance account did not receive a CSRF token.");
    let planRevision=plan.body.planUpdatedAt;

    const results=[];
    results.push(await benchmark("endpoint.health",async()=>{
        const {body}=await checkedJson(`${baseUrl}/healthz`);
        if (body.ok!==true) throw new Error("Health response was not healthy.");
      }));
    results.push(await benchmark("endpoint.status",async()=>{
        const {body}=await checkedJson(`${baseUrl}/api/status`);
        if (body.ok!==true||typeof body.version!=="string"||Object.keys(body).length!==2) throw new Error("Status response was not the minimal public status.");
      }));
    results.push(await benchmark("endpoint.authenticatedPlan",async()=>{
        const {body}=await checkedJson(`${baseUrl}/api/plan`,{headers:{Cookie:cookie}});
        if (!body.plan||!body.csrfToken) throw new Error("Authenticated plan response was incomplete.");
      }));
    results.push(await benchmark("endpoint.authenticatedPlanSave",async()=>{
        const {body}=await checkedJson(`${baseUrl}/api/plan`,{
          method:"PUT",
          headers:{Cookie:cookie,Origin:baseUrl,"Content-Type":"application/json","X-CSRF-Token":plan.body.csrfToken},
          body:JSON.stringify({plan:plan.body.plan,expectedPlanUpdatedAt:planRevision})
        });
        if (!Number.isSafeInteger(body.planUpdatedAt)||body.planUpdatedAt<=planRevision) {
          throw new Error("Authenticated plan save did not advance its compare-and-swap revision.");
        }
        planRevision=body.planUpdatedAt;
      }));
    return results;
  } finally {
    await stopServer(child);
  }
}

async function storageEvidence(dataDirectory) {
  const previous={
    NODE_ENV:process.env.NODE_ENV,
    STRATA_DATA_DIR:process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL:process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN:process.env.TURSO_AUTH_TOKEN
  };
  process.env.NODE_ENV="test";
  process.env.STRATA_DATA_DIR=dataDirectory;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  let store;
  try {
    store=await createStore(ROOT);
    const createdAt=1_700_000_000_000;
    const userId="performance-store-user";
    const tokenHash="performance-store-session";
    const planJson=JSON.stringify({version:1,restDay:"Sunday",days:{Monday:[],Tuesday:[],Wednesday:[],Thursday:[],Friday:[],Saturday:[],Sunday:[]}});
    await store.insertUser({
      id:userId,name:"Performance Store User",email:"performance-store@example.test",
      passwordHash:"performance-hash",passwordSalt:"performance-salt",createdAt,emailVerifiedAt:createdAt
    });
    await store.insertSession({tokenHash,userId,csrfToken:"performance-csrf",expiresAt:createdAt+86_400_000,createdAt,authVersion:1});
    let planRevision=createdAt;
    const initialPlan=await store.upsertPlan(userId,planJson,planRevision,0);
    if (!initialPlan) throw new Error("Performance plan fixture could not be created.");
    for (let index=1;index<STORAGE_FIXTURE_ACCOUNTS;index+=1) {
      const fixtureId=`performance-fixture-${index}`;
      await store.insertUser({
        id:fixtureId,name:`Fixture ${index}`,email:`performance-fixture-${index}@example.test`,
        passwordHash:"performance-hash",passwordSalt:"performance-salt",createdAt:createdAt+index,emailVerifiedAt:createdAt+index
      });
      await store.insertSession({
        tokenHash:`performance-session-${index}`,userId:fixtureId,csrfToken:`performance-csrf-${index}`,
        expiresAt:createdAt+86_400_000,createdAt:createdAt+index,authVersion:1
      });
      await store.upsertPlan(fixtureId,planJson,createdAt+index,0);
    }

    const results=[];
    results.push(await benchmark("storage.sessionLookup",async()=>{
        const session=await store.session(tokenHash,createdAt+1);
        if (session?.id!==userId) throw new Error("Indexed session lookup missed its fixture.");
      }));
    results.push(await benchmark("storage.planLookup",async()=>{
        const plan=await store.plan(userId);
        if (plan?.plan_json!==planJson) throw new Error("Indexed plan lookup missed its fixture.");
      }));
    results.push(await benchmark("storage.planCompareAndSwap",async()=>{
        const nextRevision=planRevision+1;
        const saved=await store.upsertPlan(userId,planJson,nextRevision,planRevision);
        if (Number(saved?.updated_at)!==nextRevision) throw new Error("Plan compare-and-swap lost its fixture revision.");
        planRevision=nextRevision;
      }));
    return results;
  } finally {
    await store?.close();
    for (const [key,value] of Object.entries(previous)) {
      if (value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
}

function assess(results) {
  return results.map((result)=>{
    const budget=PERFORMANCE_BUDGETS[result.name];
    const passed=result.medianMs<=budget.medianMs&&result.p95Ms<=budget.p95Ms;
    return {...result,budgetMedianMs:budget.medianMs,budgetP95Ms:budget.p95Ms,passed};
  });
}

async function main() {
  mkdirSync(RUNTIME_ROOT,{recursive:true});
  const runDirectory=mkdtempSync(join(RUNTIME_ROOT,"performance-"));
  const endpointDirectory=join(runDirectory,"endpoint");
  const storageDirectory=join(runDirectory,"storage");
  mkdirSync(endpointDirectory);
  mkdirSync(storageDirectory);
  try {
    const results=assess([
      ...await endpointEvidence(endpointDirectory),
      ...await storageEvidence(storageDirectory)
    ]);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({
        runtime:{node:process.version,platform:process.platform,architecture:process.arch},
        samples:SAMPLE_COUNT,
        warmups:WARMUP_COUNT,
        storageFixtureAccounts:STORAGE_FIXTURE_ACCOUNTS,
        results
      },null,2));
    } else {
      console.table(results);
      console.log(`Performance evidence: ${SAMPLE_COUNT} measured samples after ${WARMUP_COUNT} warmups per operation.`);
    }
    const failed=results.filter((result)=>!result.passed);
    if (failed.length) throw new Error(`Performance budgets exceeded: ${failed.map((result)=>result.name).join(", ")}.`);
  } finally {
    rmSync(runDirectory,{recursive:true,force:true});
  }
}

if (require.main===module) main().catch((error)=>{console.error(error.message);process.exitCode=1;});

module.exports={PERFORMANCE_BUDGETS,SAMPLE_COUNT,WARMUP_COUNT,STORAGE_FIXTURE_ACCOUNTS,benchmark,percentile,assess,isolatedServerEnvironment};
