"use strict";

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdtempSync,readFileSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve:resolvePath}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");
const W=require("../../public/scripts/workout-core.js");

const ROOT=join(__dirname,"..","..");
const WAIT_MS=15_000;
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public","data","exercises.json"),"utf8"));
const EXERCISE=CATALOG.find((item)=>item.equipment!=="Bodyweight"&&!/seconds|sec|min/i.test(item.reps));
const OWNER="account:42";

async function unusedPort(){
  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));
  return port;
}

async function stopChild(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolve)=>{
    let forceTimer,settled=false;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(forceTimer);child.off("exit",finish);resolve();};
    child.once("exit",finish);
    child.kill("SIGTERM");
    forceTimer=setTimeout(()=>{try{child.kill("SIGKILL");}catch{}finish();},2_000);
  });
}

async function waitForApp(child,baseUrl,logs){
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`Offline safety E2E server exited.\n${logs()}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise((resolve)=>setTimeout(resolve,50));
  }
  throw new Error(`Offline safety E2E server did not become healthy.\n${logs()}`);
}

// A device draft exactly as the online workout page leaves it before the network drops.
function deviceDraft(id,change=()=>{}){
  const workout=W.createWorkout({days:{Monday:[{exerciseId:EXERCISE.id,sets:2,reps:"8–12"}]}},"Monday",CATALOG,Date.now()-600_000);
  workout.id=id;workout.entries[0].effortType="rir";change(workout);
  const draftKey=`${W.draftPrefix(OWNER)}${id}`;
  return{draftKey,context:{version:1,ownerId:OWNER,userId:"42",draftKey,contextId:`device-${id}`,authorizedUntil:Date.now()+60*60*1000},record:{ownerId:OWNER,contextId:`device-${id}`,workout,dirty:true,savedAt:Date.now()}};
}

async function openDraft(page,draft){
  await page.goto("/workout-offline.html",{waitUntil:"load"});
  await page.evaluate(({draftKey,context,record})=>{localStorage.clear();localStorage.setItem("strata_workout_offline_context_v1",JSON.stringify(context));localStorage.setItem(draftKey,JSON.stringify(record));},draft);
  await page.reload({waitUntil:"load"});
  await page.locator("#offlineSession").waitFor({state:"visible"});
}

const stored=(page,draft)=>page.evaluate((key)=>JSON.parse(localStorage.getItem(key)||"null"),draft.draftKey);
const field=(page,set,name)=>page.locator(`#offlineEntries [data-set="${set}"] [data-value="${name}"]`);
const completeBox=(page,set)=>page.locator(`#offlineEntries [data-set="${set}"] [data-complete]`);

test("offline logging keeps the last valid device copy readable and reports saves truthfully",{timeout:90_000},async()=>{
  const runtimeDir=mkdtempSync(join(tmpdir(),"strata-offline-safety-e2e-"));
  const port=await unusedPort(),baseUrl=`http://127.0.0.1:${port}`;
  let logOutput="",app,browser;
  const pageErrors=[];
  try{
    app=spawn(process.execPath,["server.js"],{
      cwd:ROOT,
      env:{
        HOST:"127.0.0.1",PORT:String(port),NODE_ENV:"test",TZ:"UTC",TRUST_PROXY:"true",SECURE_COOKIES:"false",
        ADMIN_EMAIL:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,
        ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",
        APP_BASE_URL:baseUrl
      },
      stdio:["ignore","pipe","pipe"]
    });
    for(const stream of [app.stdout,app.stderr])stream.on("data",(chunk)=>{logOutput=(logOutput+chunk.toString()).slice(-16_384);});
    await waitForApp(app,baseUrl,()=>logOutput);

    const launchOptions={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)launchOptions.executablePath=resolvePath(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    browser=await chromium.launch(launchOptions);
    const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",viewport:{width:390,height:844},reducedMotion:"reduce"});
    context.setDefaultTimeout(WAIT_MS);
    await context.route(/^https:\/\//,(route)=>route.abort());
    const page=await context.newPage();
    page.on("pageerror",(error)=>pageErrors.push(`${page.url()}: ${error.stack||error.message}`));

    // Invalid numbers stay visible for correction but never replace the stored draft (B2).
    const draft=deviceDraft("offline-safety-main");
    await openDraft(page,draft);
    assert.equal(await field(page,0,"reps").getAttribute("min"),"1");
    assert.equal(await field(page,0,"reps").getAttribute("step"),"1");
    assert.equal(await field(page,0,"effort").getAttribute("step"),"0.5");
    for(const [name,value,message] of [["reps","-1",/repetitions from 1 to 1,000/],["reps","2.5",/repetitions from 1 to 1,000/],["weight","1000.5",/load from 0 to 1,000/],["effort","11",/RIR must be from 0 to 10/]]){
      await field(page,0,name).fill(value);
      assert.equal(await field(page,0,name).getAttribute("aria-invalid"),"true",`${name} ${value}`);
      assert.match(await page.locator("#offlineError").textContent(),message);
      assert.equal((await stored(page,draft)).workout.entries[0].sets[0][name],null,`${name} ${value} must not be stored`);
    }
    await completeBox(page,0).click();
    assert.equal(await completeBox(page,0).isChecked(),false,"a set with a highlighted value cannot be completed");
    assert.match(await page.locator("#offlineError").textContent(),/Correct this set’s highlighted value before completing it\./);
    await page.reload({waitUntil:"load"});
    await page.locator("#offlineSession").waitFor({state:"visible"});
    assert.equal(await page.locator("#offlineUnavailable").isVisible(),false,"the draft still opens after invalid input and a reload");

    await field(page,0,"weight").fill("40");await field(page,0,"reps").fill("8");await field(page,0,"effort").fill("2");
    await completeBox(page,0).check();
    await page.waitForFunction(()=>globalThis.document.querySelector("#deviceSaveState")?.textContent==="Saved on device");
    assert.deepEqual((await stored(page,draft)).workout.entries[0].sets[0],{reps:8,weight:40,seconds:null,completed:true,effort:2});

    // A completed set is read-only until it is reopened, so its data cannot become invalid (B3).
    for(const name of ["weight","reps","effort"])assert.equal(await field(page,0,name).isDisabled(),true,name);
    await page.reload({waitUntil:"load"});
    await page.locator("#offlineSession").waitFor({state:"visible"});
    assert.equal(await field(page,0,"reps").isDisabled(),true);
    await completeBox(page,0).uncheck();
    assert.equal(await field(page,0,"reps").isDisabled(),false,"unchecking reopens the set for editing");
    await completeBox(page,0).check();
    assert.equal((await stored(page,draft)).workout.entries[0].sets[0].completed,true);

    // A failed device write is never followed by a success label, even after re-rendering or finishing (B5).
    await page.evaluate(()=>{globalThis.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException("Storage is full.","QuotaExceededError");};});
    await field(page,1,"weight").fill("40");await field(page,1,"reps").fill("7");
    await completeBox(page,1).check();
    assert.equal(await page.locator("#deviceSaveState").textContent(),"Couldn't save — Retry");
    assert.match(await page.locator("#offlineError").textContent(),/could not keep the latest device changes/);
    await page.click("#finishOffline");
    await page.locator("#finishOfflineDialog").waitFor({state:"visible"});
    assert.match(await page.locator("#finishOfflineCounts").textContent(),/completed 2 of 2 sets/);
    await page.click('#finishOfflineDialog button[value="finish"]');
    await page.waitForFunction(()=>/not stored on the device yet/.test(globalThis.document.querySelector("#offlineError")?.textContent||""));
    assert.equal(await page.locator("#deviceSaveState").textContent(),"Couldn't save — Retry");
    assert.match(await page.locator("#offlineError").textContent(),/could not keep the latest device changes[\s\S]*not stored on the device yet/);
    assert.equal((await stored(page,draft)).workout.status,"active","the failed finish did not reach storage");
    await page.evaluate(()=>{Storage.prototype.setItem=globalThis.__setItem;});
    await page.click("#saveOnDevice");
    assert.equal(await page.locator("#deviceSaveState").textContent(),"Saved on device");
    assert.equal(await page.locator("#offlineError").isHidden(),true);
    const finished=await stored(page,draft);
    assert.equal(finished.workout.status,"completed");
    assert.equal(W.readDraft(JSON.stringify(finished),OWNER)?.workout.status,"completed");

    // Finish requires a completed set, matching the server rule, so a finished workout can always sync (B4).
    const empty=deviceDraft("offline-safety-empty");
    await openDraft(page,empty);
    await page.click("#finishOffline");
    assert.equal(await page.locator("#finishOfflineDialog").isVisible(),false);
    assert.match(await page.locator("#offlineError").textContent(),/Complete at least one set before finishing a workout\./);
    assert.equal((await stored(page,empty)).workout.status,"active");

    // Drafts saved by older builds reopen with a visible explanation instead of disappearing.
    const finishedEmpty=deviceDraft("offline-safety-legacy-finish",(workout)=>{workout.status="completed";workout.completedAt=Date.now();});
    await openDraft(page,finishedEmpty);
    assert.match(await page.locator("#offlineError").textContent(),/finished on this device without a completed set, so it has been reopened/);
    assert.equal(await page.locator("#finishOffline").isDisabled(),false);
    const poisoned=deviceDraft("offline-safety-legacy-value",(workout)=>{workout.entries[0].sets[0].reps=-1;});
    assert.equal(W.readDraft(JSON.stringify(poisoned.record),OWNER),null,"the fixture reproduces a draft older builds could not reopen");
    await openDraft(page,poisoned);
    assert.match(await page.locator("#offlineError").textContent(),/cleared to reopen the workout: .+ set 1 reps \(-1\)/);
    assert.equal(await field(page,0,"reps").inputValue(),"");
    await field(page,0,"reps").fill("6");
    assert.ok(W.readDraft(JSON.stringify(await stored(page,poisoned)),OWNER),"the next save stores a readable draft again");

    assert.deepEqual(pageErrors,[],`Unexpected browser errors:\n${pageErrors.join("\n")}`);
    await context.close();
  }finally{
    try{await browser?.close();}finally{
      await stopChild(app);
      rmSync(runtimeDir,{recursive:true,force:true});
    }
  }
});
