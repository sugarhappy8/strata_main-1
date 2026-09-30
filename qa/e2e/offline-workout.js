"use strict";

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdtempSync,readFileSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve:resolvePath}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..","..");
const WAIT_MS=15_000;
const PASSWORD="offline-workout-e2e-password-123";
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public","data","exercises.json"),"utf8"));

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

function fixtureWeek(){
  const exercise=CATALOG.find((item)=>item.equipment!=="Bodyweight"&&!/seconds|sec|min/i.test(item.reps));
  assert.ok(exercise,"The fixture needs one externally loaded repetition exercise.");
  const days={Monday:[{instanceId:"offline-plan-monday",exerciseId:exercise.id,sets:1,reps:"8–12"}]};
  for(const day of ["Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"])days[day]=[];
  return{version:1,restDay:"Sunday",days};
}

async function waitForApp(child,baseUrl,logs){
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(child.exitCode!==null)throw new Error(`Offline workout E2E server exited.\n${logs()}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise((resolve)=>setTimeout(resolve,50));
  }
  throw new Error(`Offline workout E2E server did not become healthy.\n${logs()}`);
}

async function inspectCaches(page,secrets){
  return page.evaluate(async(secretValues)=>{
    const cacheNames=await globalThis.caches.keys(),urls=[],leaks=[];
    for(const cacheName of cacheNames){
      const cache=await globalThis.caches.open(cacheName);
      for(const request of await cache.keys()){
        urls.push(request.url);
        const response=await cache.match(request),type=response?.headers.get("content-type")||"";
        if(!response||!/text|json|javascript|css|svg/i.test(type))continue;
        const body=await response.clone().text();
        for(const secret of secretValues){if(secret&&body.includes(secret))leaks.push({url:request.url,secret});}
      }
    }
    return{cacheNames,urls,leaks};
  },secrets);
}

test("an authorized active workout continues offline without caching private account data",{timeout:90_000},async()=>{
  const runtimeDir=mkdtempSync(join(tmpdir(),"strata-offline-workout-e2e-"));
  const port=await unusedPort(),baseUrl=`http://127.0.0.1:${port}`;
  let logOutput="",app,browser,context;
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
    context=await browser.newContext({
      baseURL:baseUrl,
      serviceWorkers:"allow",
      viewport:{width:390,height:844},
      reducedMotion:"reduce",
      extraHTTPHeaders:{"X-Forwarded-For":"198.51.100.75"}
    });
    context.setDefaultTimeout(WAIT_MS);
    await context.route(/^https:\/\//,(route)=>route.abort());
    const page=await context.newPage();
    page.on("pageerror",(error)=>pageErrors.push(`${page.url()}: ${error.stack||error.message}`));

    const email="offline-workout@example.test";
    const signup=await context.request.post("/api/signup",{headers:{Origin:baseUrl},data:{name:"Offline Workout",email,password:PASSWORD}});
    assert.equal(signup.status(),201,await signup.text());
    const user=(await signup.json()).user;

    const initialPlan=await context.request.get("/api/plan");
    assert.equal(initialPlan.status(),200,await initialPlan.text());
    const account=await initialPlan.json();
    const trialResponse=await context.request.post("/api/discovery/trial",{headers:{Origin:baseUrl,"X-CSRF-Token":account.csrfToken},data:{}});
    assert.equal(trialResponse.status(),201,await trialResponse.text());
    const trial=(await trialResponse.json()).user.discovery.trial;
    assert.ok(Number(trial.expiresAt)>Date.now(),"The account should receive a live server-owned trial window.");
    assert.ok(Number(trial.expiresAt)<=Date.now()+7*24*60*60*1000,"The browser flow must use the 7-day trial, not a longer client-selected window.");

    const planResponse=await context.request.put("/api/plan",{
      headers:{Origin:baseUrl,"X-CSRF-Token":account.csrfToken,"X-Strata-User":user.id},
      data:{plan:fixtureWeek(),expectedPlanUpdatedAt:account.planUpdatedAt,expectedUserId:user.id}
    });
    assert.equal(planResponse.status(),200,await planResponse.text());

    await page.goto("/workout.html?day=Monday",{waitUntil:"load"});
    await page.locator("#startWorkout").waitFor({state:"visible"});
    const creating=page.waitForResponse((response)=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await page.click("#startWorkout");
    const created=await creating;
    assert.equal(created.status(),201,await created.text());
    const workout=(await created.json()).workout;
    await page.waitForFunction(()=>["Synced","Saved to your account"].includes(globalThis.document.querySelector("#saveStatus")?.textContent));

    await page.waitForFunction(async()=>{
      if(!("serviceWorker" in navigator)||!navigator.serviceWorker.controller)return false;
      const registration=await navigator.serviceWorker.ready;
      return registration.active?.state==="activated"&&Boolean(await globalThis.caches.match("/workout-offline.html"));
    });

    const stored=await page.evaluate(()=>{
      const context=JSON.parse(localStorage.getItem("strata_workout_offline_context_v1")||"null");
      return{context,draft:context?JSON.parse(localStorage.getItem(context.draftKey)||"null"):null};
    });
    assert.equal(stored.context.userId,String(user.id));
    assert.equal(stored.context.ownerId,`account:${user.id}`);
    assert.equal(stored.context.authorizedUntil,Number(trial.expiresAt));
    assert.ok(stored.context.draftKey.startsWith(`strata_workout_draft_v1:${encodeURIComponent(`account:${user.id}`)}:`));
    assert.equal(stored.draft.ownerId,stored.context.ownerId);
    assert.equal(stored.draft.contextId,stored.context.contextId);
    assert.equal(stored.draft.workout.id,workout.id);
    assert.equal(stored.draft.dirty,false,"The initial account save should leave a clean device record before going offline.");

    const cacheAudit=await inspectCaches(page,[email,String(user.id),workout.id]);
    assert.ok(cacheAudit.cacheNames.some((name)=>name.startsWith("strata-static-")),"The offline static cache should be installed.");
    const privatePaths=new Set(["/","/index.html","/account.html","/discover.html","/onboarding.html","/workout.html","/admin.html"]);
    for(const value of cacheAudit.urls){
      const url=new URL(value);
      assert.equal(url.pathname.startsWith("/api/")||url.pathname.startsWith("/auth/"),false,`Private endpoint was cached: ${url.pathname}`);
      assert.equal(privatePaths.has(url.pathname),false,`Private account page was cached: ${url.pathname}`);
    }
    assert.deepEqual(cacheAudit.leaks,[],"Cached public assets must not contain the account, email, or workout identity.");

    await context.setOffline(true);
    await page.goto("/workout.html",{waitUntil:"domcontentloaded"});
    assert.equal(new URL(page.url()).pathname,"/workout.html","The generic shell should answer at the requested workout URL.");
    await page.locator("#offlineSession").waitFor({state:"visible"});
    assert.equal(await page.locator("#offlineUnavailable").isVisible(),false);
    assert.match(await page.locator("#offlineSessionMeta").textContent(),/authorized on this device/i);

    const offlineEntry=page.locator("#offlineEntries [data-entry]").first();
    await offlineEntry.locator('[data-value="weight"]').first().fill("37.5");
    await offlineEntry.locator('[data-value="reps"]').first().fill("9");
    await offlineEntry.locator("[data-complete]").first().check();
    await page.waitForFunction(()=>globalThis.document.querySelector("#deviceSaveState")?.textContent==="Saved on device"&&globalThis.document.querySelector("#syncState")?.textContent==="Sync pending");
    const offlineDraft=await page.evaluate((draftKey)=>JSON.parse(localStorage.getItem(draftKey)||"null"),stored.context.draftKey);
    assert.equal(offlineDraft.dirty,true);
    assert.equal(offlineDraft.ownerId,`account:${user.id}`);
    assert.equal(offlineDraft.workout.entries[0].sets[0].weight,37.5);
    assert.equal(offlineDraft.workout.entries[0].sets[0].reps,9);
    assert.equal(offlineDraft.workout.entries[0].sets[0].completed,true);

    await context.setOffline(false);
    await page.waitForFunction(()=>navigator.onLine===true);
    await Promise.all([
      page.waitForURL((url)=>url.pathname==="/workout.html"&&url.hash.startsWith("#resume=")),
      page.click("#syncWorkout")
    ]);
    try{await page.locator("#sessionPanel").waitFor({state:"visible"});}
    catch(error){
      const state=await page.evaluate(()=>({url:globalThis.location.href,title:globalThis.document.title,loadError:globalThis.document.querySelector("#loadErrorMessage")?.textContent||"",offlineError:globalThis.document.querySelector("#offlineError")?.textContent||"",body:globalThis.document.body.innerText.slice(0,1200)}));
      throw new Error(`Reconnected workout did not recover its device draft: ${JSON.stringify(state)}`,{cause:error});
    }
    const recoveredEntry=page.locator("#sessionEntries [data-entry]").first();
    assert.equal(await recoveredEntry.locator('[data-actual="weight"]').first().inputValue(),"37.5");
    assert.equal(await recoveredEntry.locator('[data-actual="reps"]').first().inputValue(),"9");
    assert.equal(await recoveredEntry.locator('[data-complete="0"]').getAttribute("aria-pressed"),"true");

    const syncing=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/workouts/${workout.id}`&&response.request().method()==="PUT");
    await page.click("#saveNow");
    const synced=await syncing;
    assert.equal(synced.status(),200,await synced.text());
    await page.waitForFunction(()=>["Synced","Saved to your account"].includes(globalThis.document.querySelector("#saveStatus")?.textContent));
    const serverWorkout=await context.request.get(`/api/workouts/${workout.id}`);
    assert.equal(serverWorkout.status(),200,await serverWorkout.text());
    const savedWorkout=(await serverWorkout.json()).workout;
    assert.equal(savedWorkout.entries[0].sets[0].weight,37.5);
    assert.equal(savedWorkout.entries[0].sets[0].reps,9);
    assert.equal(savedWorkout.entries[0].sets[0].completed,true);
    const postSyncCacheAudit=await inspectCaches(page,[email,String(user.id),workout.id]);
    for(const value of postSyncCacheAudit.urls){
      const url=new URL(value);
      assert.equal(url.pathname.startsWith("/api/")||url.pathname.startsWith("/auth/"),false,`Private endpoint was cached after sync: ${url.pathname}`);
      assert.equal(privatePaths.has(url.pathname),false,`Private account page was cached after sync: ${url.pathname}`);
    }
    assert.deepEqual(postSyncCacheAudit.leaks,[],"Reconnection must not add account or workout values to CacheStorage.");

    await context.setOffline(true);
    await page.goto("/workout.html",{waitUntil:"domcontentloaded"});
    await page.locator("#offlineSession").waitFor({state:"visible"});
    const expiredFixture=await page.evaluate(()=>{
      const key="strata_workout_offline_context_v1",context=JSON.parse(localStorage.getItem(key));
      context.authorizedUntil=Date.now()-1;
      localStorage.setItem(key,JSON.stringify(context));
      return{draftKey:context.draftKey,draft:localStorage.getItem(context.draftKey)};
    });
    const expiredPage=await context.newPage();
    expiredPage.on("pageerror",(error)=>pageErrors.push(`${expiredPage.url()}: ${error.stack||error.message}`));
    await expiredPage.goto("/workout.html",{waitUntil:"domcontentloaded"});
    await expiredPage.locator("#offlineUnavailable").waitFor({state:"visible"});
    assert.equal(await expiredPage.locator("#offlineSession").isVisible(),false);
    assert.match(await expiredPage.locator("#offlineUnavailableMessage").textContent(),/reconnect|sign in|active workout/i);
    assert.equal(await expiredPage.evaluate((draftKey)=>localStorage.getItem(draftKey),expiredFixture.draftKey),expiredFixture.draft,"Refusing expired authorization must not delete or rewrite the device draft.");

    assert.deepEqual(pageErrors,[],`Unexpected browser errors:\n${pageErrors.join("\n")}`);
  }finally{
    try{await context?.setOffline(false);}catch{}
    try{await browser?.close();}finally{
      await stopChild(app);
      rmSync(runtimeDir,{recursive:true,force:true});
    }
  }
});
