"use strict";

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdirSync,mkdtempSync,readFileSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..","..");
const CAPTURE_DIR=process.env.STRATA_TRAIN_SCREENSHOT_DIR?resolve(process.env.STRATA_TRAIN_SCREENSHOT_DIR):null;
const WAIT_MS=10_000;
const PASSWORD="synthetic-training-e2e-123";
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public/data/exercises.json"),"utf8"));
let app,browser,baseUrl,runtimeDir,logs="",contextNumber=0;
const pageErrors=[];
const contexts=[];

async function unusedPort(){
  const server=http.createServer();
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});
  const port=server.address().port;
  await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;
}
async function startApp(){
  const port=await unusedPort();baseUrl=`http://127.0.0.1:${port}`;runtimeDir=mkdtempSync(join(tmpdir(),"strata-training-e2e-"));
  app=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{HOST:"127.0.0.1",PORT:String(port),NODE_ENV:"test",TZ:"UTC",TRUST_PROXY:"true",SECURE_COOKIES:"false",ADMIN_EMAIL:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",APP_BASE_URL:baseUrl},stdio:["ignore","pipe","pipe"]});
  for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{logs=(logs+chunk.toString()).slice(-16_384);});
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(app.exitCode!==null)throw new Error(`Training E2E server exited.\n${logs}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise(done=>setTimeout(done,50));
  }
  throw new Error(`Training E2E server did not become healthy.\n${logs}`);
}
async function cleanup(){
  try{await browser?.close();}finally{
    if(app&&app.exitCode===null&&app.signalCode===null){
      await new Promise(done=>{
        let settled=false,forceTimer;
        const finish=()=>{if(settled)return;settled=true;clearTimeout(forceTimer);done();};
        app.once("exit",finish);app.kill("SIGTERM");forceTimer=setTimeout(()=>{try{app.kill("SIGKILL");}catch{}finish();},2000);
      });
    }
    if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});
  }
}
async function newPage(options={}){
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",extraHTTPHeaders:{"X-Forwarded-For":`198.51.100.${++contextNumber}`},...options});
  contexts.push(context);context.setDefaultTimeout(WAIT_MS);
  await context.route(/^https:\/\//,route=>route.abort());
  const page=await context.newPage();page.on("pageerror",error=>pageErrors.push(`${page.url()}: ${error.message}`));
  return {context,page};
}
async function goto(page,path){await page.goto(path,{waitUntil:"domcontentloaded"});}
async function capture(page,name){if(!CAPTURE_DIR)return;mkdirSync(CAPTURE_DIR,{recursive:true});await page.screenshot({path:join(CAPTURE_DIR,name),fullPage:true});}
async function plannerReady(page){await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Saved");}
async function guestPlan(page){return page.evaluate(()=>JSON.parse(localStorage.getItem("strata_guest_plan_v1")));}
async function signup(context,label){
  const response=await context.request.post("/api/signup",{headers:{Origin:baseUrl},data:{name:`Training ${label}`,email:`training-${label}@example.test`,password:PASSWORD}});
  assert.equal(response.status(),201,await response.text());return(await response.json()).user;
}
async function activatePlus(context){
  const current=await accountPlan(context);
  const response=await context.request.post("/api/discovery/trial",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken},data:{}});
  assert.ok([200,201].includes(response.status()),await response.text());
}
async function accountPlan(context){const response=await context.request.get("/api/plan");assert.equal(response.status(),200);return response.json();}
async function savedAccountEdit(page,action){
  const response=page.waitForResponse(item=>new URL(item.url()).pathname==="/api/plan"&&item.request().method()==="PUT");
  await action();const saved=await response;assert.equal(saved.status(),200,await saved.text());await plannerReady(page);return saved.json();
}
function fixtureWeek(){
  return {version:1,restDay:"Sunday",days:Object.fromEntries(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(day=>[day,day==="Monday"?[{instanceId:"training-fixture",exerciseId:CATALOG.find(item=>item.equipment!=="Bodyweight"&&!/seconds|sec|min/i.test(item.reps)).id,sets:1,reps:"8–12"}]:[]]))};
}

test("training journeys use real browser controls and isolated local fixtures",{timeout:120_000},async t=>{
  await t.test("a visitor can inspect a private recommendation preview before signup",async()=>{
    const {context,page}=await newPage({viewport:{width:320,height:760},reducedMotion:"reduce"});
    await goto(page,"/");
    const submit=page.locator("#quickPreviewSubmit");await submit.waitFor({state:"visible"});await page.waitForFunction(()=>!globalThis.document.querySelector("#quickPreviewSubmit")?.disabled);
    assert.equal(await page.locator("[data-compare]").count(),0,"Guest homepage rankings must not expose Strata+ comparison controls");
    await page.selectOption("#quickPreviewGoal","hypertrophy");await page.selectOption("#quickPreviewGroup","chest");await page.selectOption("#quickPreviewEquipment","Dumbbells");await page.selectOption("#quickPreviewLevel","Intermediate");await submit.click();
    await page.locator("#quickPreviewResults .preview-result").first().waitFor({state:"visible"});
    assert.equal(await page.locator("#quickPreviewResults .preview-result").count(),3);
    assert.equal((await page.locator("#quickPreviewSummary").textContent())?.trim(),"3-day week ready");
    assert.match(await page.locator("#quickWeekMeta").textContent(),/^3 training days · \d+ movements · 35 minutes per session$/);
    assert.equal(await page.locator("#quickWeekGrid .quick-week-day").count(),7,"The preview must show every day before signup.");
    assert.equal(await page.locator("#quickWeekGrid .quick-week-day:not(.is-recovery)").count(),3,"The selected three-day schedule must remain visible.");
    assert.equal(await page.locator(".preview-reasons").count(),3);
    assert.equal(await page.locator(".preview-tradeoff").count(),3);
    assert.equal(await page.locator(".preview-scores").count(),3);
    assert.equal(await page.locator("#quickPreviewSummary").evaluate((node)=>node===globalThis.document.activeElement),true,"generated preview should move focus to its result summary");
    const consent=page.locator("#productSignalsConsent");await consent.waitFor({state:"visible"});
    assert.equal(await consent.evaluate((node)=>globalThis.getComputedStyle(node).position),"relative","optional signal consent must stay inline instead of covering the preview");
    const client=await page.evaluate(()=>({overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth,intent:JSON.parse(globalThis.localStorage.getItem("strata_activation_intent_v1"))}));
    assert.ok(client.overflow<=1,`guest preview overflows 320px by ${client.overflow}px`);
    assert.equal(client.intent.profile.goal,"hypertrophy");
    assert.deepEqual(client.intent.profile.equipment,["Dumbbells"]);
    assert.equal(client.intent.profile.level,"Intermediate");
    assert.equal(client.intent.profile.availability.length,3,"The private device draft must preserve the selected schedule for explicit account handoff.");
    await context.close();
  });
  await t.test("free planning supports rest toggles, replacement, undo, templates and portable imports",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    await goto(page,"/planner.html");await plannerReady(page);
    const guideTrigger=page.locator('.library-card [data-guide-exercise]').first();await guideTrigger.waitFor({state:"visible"});
    const actionHeights=await page.locator('.library-card').first().locator('.library-actions').locator('button,a').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().height));
    assert.ok(actionHeights.every(height=>height>=44),`Planner library actions must stay at least 44px tall: ${actionHeights.join(", ")}`);
    await guideTrigger.click();await page.locator('#exerciseGuideDialog').waitFor({state:"visible"});
    assert.match(await page.locator('#exerciseGuideBody').textContent(),/Set up[\s\S]*Technique cues[\s\S]*Common mistake[\s\S]*Same target, different equipment/);
    assert.equal(await page.locator('#exerciseGuideTitle').evaluate(node=>node===globalThis.document.activeElement),true,"The exercise guide should announce its focused title");
    await page.keyboard.press("Escape");await page.locator('#exerciseGuideDialog').waitFor({state:"hidden"});
    assert.equal(await guideTrigger.evaluate(node=>node===globalThis.document.activeElement),true,"Closing a guide should return focus to its exact trigger");
    await page.locator('[data-quick-add]').first().click();await plannerReady(page);
    const generated=await guestPlan(page),originalCount=Object.values(generated.days).flat().length;
    assert.ok(originalCount>0);
    assert.equal(await page.locator('#startPlannedWorkout').count(),0);
    assert.equal(await page.locator('#recommendRest').count(),0);
    await page.locator('[data-set-rest="Sunday"]').click();await plannerReady(page);
    await page.locator('[data-set-rest="Wednesday"]').click();await plannerReady(page);
    await page.locator('[data-set-rest="Saturday"]').click();await plannerReady(page);
    await page.reload({waitUntil:"domcontentloaded"});await plannerReady(page);
    assert.deepEqual((await guestPlan(page)).restDays,["Wednesday","Saturday"]);
    await page.locator('[data-set-rest="Wednesday"]').click();await plannerReady(page);
    assert.deepEqual((await guestPlan(page)).restDays,["Saturday"]);
    const card=page.locator('[data-day="Monday"] [data-instance-id]').first(),instance=await card.getAttribute("data-instance-id");
    await card.locator("[data-item-sets]").fill("4");await card.locator("[data-item-reps]").fill("6–8");
    await page.waitForFunction(id=>JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days.Monday.find(item=>item.instanceId===id)?.reps==="6–8",instance);
    await card.locator("[data-replace-item]").click();
    await page.locator("#replaceExerciseDialog").waitFor({state:"visible"});await page.fill("#replaceExerciseSearch","squat");
    const replacement=await page.locator("#replaceExerciseSelect option").nth(1).getAttribute("value");
    await page.selectOption("#replaceExerciseSelect",replacement);await page.click("#confirmReplaceExercise");
    await page.waitForFunction(({id,exerciseId})=>JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days.Monday.find(item=>item.instanceId===id)?.exerciseId===exerciseId,{id:instance,exerciseId:replacement});
    const replaced=(await guestPlan(page)).days.Monday.find(item=>item.instanceId===instance);
    assert.equal(replaced.sets,4);assert.equal(replaced.reps,"6–8");
    await page.locator(`[data-remove-item="${instance}"]`).click();
    await page.waitForFunction(id=>!JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days.Monday.some(item=>item.instanceId===id),instance);
    await page.click("#undoPlanRemoval");
    await page.waitForFunction(id=>JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days.Monday.some(item=>item.instanceId===id),instance);
    await page.click("#manageWeekTemplates");await page.fill("#weekTemplateName","My reusable week");await page.click("#saveWeekTemplate");
    await page.click("#closeWeekTemplates");await page.locator("[data-quick-add]").first().click();
    await page.waitForFunction(count=>Object.values(JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days).flat().length===count,originalCount+1);
    await page.click("#manageWeekTemplates");await page.selectOption("#weekTemplateSelect",{index:1});await page.click("#previewWeekTemplate");
    assert.equal(await page.locator("#applyWeekTemplate").isDisabled(),true,"Replacement requires the user's confirmation");
    await page.check("#confirmUseTemplate");await page.click("#applyWeekTemplate");
    await page.waitForFunction(count=>Object.values(JSON.parse(localStorage.getItem("strata_guest_plan_v1")).days).flat().length===count,originalCount);
    const duplicated=await guestPlan(page);assert.ok(!Object.values(duplicated.days).flat().some(item=>item.instanceId===instance),"A copied week gets new entry identities");
    await page.click("#manageWeekTemplates");
    await page.setInputFiles("#templateFile",{name:"portable-week.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({format:"strata-weekly-plan",version:1,plan:duplicated}))});
    await page.locator("#templatePreview").waitFor({state:"visible"});
    assert.deepEqual(await guestPlan(page),duplicated,"Import preview must not mutate the current week");
    assert.equal(await page.locator("#applyWeekTemplate").isDisabled(),true);
    await page.keyboard.press("Escape");assert.equal(await page.locator("#weekTemplatesDialog").isVisible(),false);
    assert.equal(await page.locator("#planInsights").evaluate(node=>node.open),false,"Plan evidence should start collapsed");
    const beforeReset=await guestPlan(page);await page.click("#resetWeeklyPlan");await page.locator("#resetWeekDialog").waitFor({state:"visible"});
    assert.deepEqual(await guestPlan(page),beforeReset,"Opening Reset week must not change the saved plan");
    await page.click("#closeResetWeek");assert.deepEqual(await guestPlan(page),beforeReset,"Canceling Reset week must preserve the plan");
    await page.click("#resetWeeklyPlan");await page.click("#confirmResetWeek");await plannerReady(page);
    const cleared=await guestPlan(page);assert.equal(Object.values(cleared.days).flat().length,0,"Reset week must clear all seven training days");assert.deepEqual(cleared.restDays,["Sunday"]);
    assert.equal(await page.locator("#resetWeeklyPlan").isDisabled(),true,"The canonical empty week cannot be reset again");
    await context.close();
  });

  await t.test("a signed-in reset clears only the editable account week through the normal save boundary",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});const user=await signup(context,"reset-week");
    await goto(page,"/planner.html");await plannerReady(page);await savedAccountEdit(page,()=>page.locator("[data-quick-add]").first().click());
    const before=await accountPlan(context);assert.equal(Object.values(before.plan.days).flat().length,1);
    await page.click("#resetWeeklyPlan");await page.locator("#resetWeekDialog").waitFor({state:"visible"});assert.equal(Object.values((await accountPlan(context)).plan.days).flat().length,1,"Opening reset must not write");
    await page.click("#closeResetWeek");assert.equal(await page.locator("#resetWeeklyPlan").evaluate(node=>node===globalThis.document.activeElement),true,"Cancel returns focus to Reset week");
    await page.click("#resetWeeklyPlan");
    const resetRequest=page.waitForRequest(request=>new URL(request.url()).pathname==="/api/plan"&&request.method()==="PUT");await page.click("#confirmResetWeek");const request=await resetRequest;await plannerReady(page);
    const body=request.postDataJSON(),saved=await accountPlan(context);assert.equal(body.expectedUserId,user.id);assert.equal(body.expectedPlanUpdatedAt,before.planUpdatedAt);assert.equal(Object.values(body.plan.days).flat().length,0);
    assert.equal(Object.values(saved.plan.days).flat().length,0);assert.deepEqual(saved.plan.restDays,["Sunday"]);assert.equal(await page.locator("#weekTitle").evaluate(node=>node===globalThis.document.activeElement),true,"Completed reset moves focus to the updated week");
    await context.close();
  });

  await t.test("an account draft survives a failed save and reload without overwriting a newer server week",async()=>{
    const {context,page}=await newPage();const user=await signup(context,"draft");
    await goto(page,"/planner.html");await plannerReady(page);
    await savedAccountEdit(page,()=>page.locator("[data-quick-add]").first().click());
    const instance=await page.locator('[data-day="Monday"] [data-instance-id]').first().getAttribute("data-instance-id");
    const blockSave=async route=>route.request().method()==="PUT"?route.abort():route.continue();
    await page.route("**/api/plan",blockSave);
    await page.locator(`[data-item-reps="${instance}"]`).fill("10–12");
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Couldn't save — Retry");
    const current=await accountPlan(context);current.plan.days.Monday[0].reps="2–4";
    const changed=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:current.plan,expectedPlanUpdatedAt:current.planUpdatedAt,expectedUserId:user.id}});
    assert.equal(changed.status(),200);const newer=await changed.json();
    page.once("dialog",dialog=>dialog.accept());await page.reload({waitUntil:"domcontentloaded"});
    await page.locator("#planConflictPanel").waitFor({state:"visible"});
    assert.match(await page.locator("#latestPlanSummary").textContent(),/2–4/);assert.match(await page.locator("#localPlanSummary").textContent(),/10–12/);
    assert.equal((await accountPlan(context)).planUpdatedAt,newer.planUpdatedAt,"Reload must not save recovered local edits");
    await page.click("#reviewLocalPlan");
    assert.equal((await accountPlan(context)).planUpdatedAt,newer.planUpdatedAt,"Review must remain separate from explicit save");
    await page.unroute("**/api/plan",blockSave);
    const save=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/plan"&&response.request().method()==="PUT");await page.click("#retryPlanSave");
    const response=await save;assert.equal(response.status(),200);assert.equal(response.request().postDataJSON().expectedPlanUpdatedAt,newer.planUpdatedAt);
    await plannerReady(page);assert.equal((await accountPlan(context)).plan.days.Monday[0].reps,"10–12");
    await context.close();
  });

  await t.test("an account switch blocks a stale tab from saving its week into the replacement account",async()=>{
    const {context,page}=await newPage();const original=await signup(context,"owner-a");
    await goto(page,"/planner.html");await plannerReady(page);
    const blockSave=async route=>route.request().method()==="PUT"?route.abort():route.continue();
    await page.route("**/api/plan",blockSave);await page.locator("[data-quick-add]").first().click();
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Couldn't save — Retry");
    const replacement=await signup(context,"owner-b");assert.notEqual(replacement.id,original.id);
    await page.unroute("**/api/plan",blockSave);const writes=[];
    page.on("request",request=>{if(new URL(request.url()).pathname==="/api/plan"&&request.method()==="PUT")writes.push(request);});
    await page.click("#retryPlanSave");await page.locator("#accountChangedNotice").waitFor({state:"visible"});
    assert.equal(writes.length,0,"Identity verification must reject before sending the old account's plan");
    assert.equal(await page.locator("#plannerShell").evaluate(node=>node.inert),true);
    const retained=await page.evaluate(id=>Object.keys(localStorage).filter(key=>key.startsWith(`strata_plan_draft_v1:user-${encodeURIComponent(id)}:`)).length,original.id);
    assert.ok(retained>0,"Recovery drafts stay scoped to the original account");
    assert.equal(Object.values((await accountPlan(context)).plan.days).flat().length,0,"The replacement account must remain untouched");
    await context.close();
  });

  await t.test("two stale workout tabs converge on the one active account session",async()=>{
    const {context,page:firstTab}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    const user=await signup(context,"two-tabs");await activatePlus(context);
    const current=await accountPlan(context);
    const seed=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:fixtureWeek(),expectedPlanUpdatedAt:current.planUpdatedAt}});assert.equal(seed.status(),200);
    const secondTab=await context.newPage();secondTab.on("pageerror",error=>pageErrors.push(`${secondTab.url()}: ${error.message}`));
    for(const page of [firstTab,secondTab]){await goto(page,"/workout.html?day=Monday");await page.locator("#startWorkout").waitFor({state:"visible"});}

    const firstCreate=firstTab.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await firstTab.click("#startWorkout");assert.equal((await firstCreate).status(),201);
    await firstTab.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");

    const secondCreate=secondTab.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await secondTab.click("#startWorkout");const conflict=await secondCreate;assert.equal(conflict.status(),409);
    assert.equal((await conflict.json()).code,"ACTIVE_WORKOUT_EXISTS");
    await secondTab.waitForFunction(()=>globalThis.document.querySelector("#workoutToast")?.classList.contains("is-visible"));
    assert.match(await secondTab.locator("#workoutToast").textContent(),/resumed it instead of starting another/i);
    assert.equal(await secondTab.locator("#sessionPanel").isVisible(),true);
    assert.equal(await secondTab.locator("#sessionTitle").evaluate(node=>globalThis.document.activeElement===node),true);
    assert.equal(await secondTab.locator('#recoveryList [data-recover]').count(),0,"an untouched rejected start leaves no duplicate recovery draft");
    const history=await context.request.get("/api/workouts?limit=20"),saved=await history.json();
    assert.equal(saved.workouts.filter(workout=>workout.status==="active").length,1);
    await context.close();
  });

  await t.test("Workout Memory searches beyond recent history, restores exact sets, and keeps all changes explicit",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    const user=await signup(context,"workout-memory");await activatePlus(context);
    const firstExercise=CATALOG.find(item=>item.equipment==="Barbell / Smith"&&!/seconds|sec|min/i.test(item.reps));
    const secondExercise=CATALOG.find(item=>item.id!==firstExercise.id&&item.equipment!=="Bodyweight"&&!/seconds|sec|min/i.test(item.reps));
    const current=await accountPlan(context),week=fixtureWeek();
    week.days.Monday=[{instanceId:"memory-plan-first",exerciseId:firstExercise.id,sets:2,reps:"8–12"},{instanceId:"memory-plan-second",exerciseId:secondExercise.id,sets:1,reps:"8–12"}];
    const seeded=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:week,expectedPlanUpdatedAt:current.planUpdatedAt,expectedUserId:user.id}});assert.equal(seeded.status(),200,await seeded.text());
    const csrf=(await accountPlan(context)).csrfToken,past={id:"memory-completed-session",title:"Previous Monday",planDay:"Monday",date:"2026-09-01",status:"completed",startedAt:Date.now()-604800000,completedAt:Date.now()-604799000,elapsedSeconds:1000,restEndsAt:null,entries:[{id:"memory-past-entry",exerciseId:firstExercise.id,planInstanceId:"memory-plan-first",measurement:"reps",loadType:"external",unit:"kg",prescribedReps:"8–12",note:"",effortType:"rir",supersetGroup:"",replacedFromExerciseId:"",sets:[{reps:10,weight:42.5,seconds:null,completed:true,effort:2},{reps:9,weight:42.5,seconds:null,completed:true,effort:1.5}]}]};
    const pastSave=await context.request.post("/api/workouts",{headers:{Origin:baseUrl,"X-CSRF-Token":csrf,"X-Strata-User":user.id},data:{workout:past}});assert.equal(pastSave.status(),201,await pastSave.text());
    for(let index=0;index<20;index+=1){
      const startedAt=past.startedAt+2_000+index*1_000,distractor={id:`memory-newer-${index}`,title:`Newer unrelated ${index}`,planDay:"Tuesday",date:"2026-09-02",status:"completed",startedAt,completedAt:startedAt+500,elapsedSeconds:500,restEndsAt:null,entries:[{id:`memory-newer-entry-${index}`,exerciseId:secondExercise.id,planInstanceId:"memory-plan-second",measurement:"reps",loadType:"external",unit:"kg",prescribedReps:"8–12",note:"",effortType:"none",supersetGroup:"",replacedFromExerciseId:"",sets:[{reps:8,weight:20+index,seconds:null,completed:true,effort:null}]}]};
      const distractorSave=await context.request.post("/api/workouts",{headers:{Origin:baseUrl,"X-CSRF-Token":csrf,"X-Strata-User":user.id},data:{workout:distractor}});assert.equal(distractorSave.status(),201,await distractorSave.text());
    }
    const memoryRequests=[];page.on("request",(request)=>{const url=new URL(request.url());if(url.pathname==="/api/workouts"&&url.searchParams.get("memory")==="1")memoryRequests.push(url.search);});
    await goto(page,"/workout.html?day=Monday");await page.locator("#startWorkout").waitFor({state:"visible"});await page.click("#startWorkout");await page.locator("#sessionPanel").waitFor({state:"visible"});
    let cards=page.locator("#sessionEntries [data-entry]"),first=cards.nth(0),second=cards.nth(1);
    const openMore=async(card)=>{const details=card.locator(".exercise-more");if(!await details.evaluate((node)=>node.open))await details.locator(":scope > summary").click();};
    await page.waitForFunction(()=>globalThis.document.querySelector("#sessionEntries [data-entry] .memory-previous")?.textContent?.includes("2026-09-01"));
    assert.ok(memoryRequests.some((search)=>search.includes("limit=100")&&search.includes("offset=0")),"Workout Memory must search beyond the 20-row visible history page.");
    const mobileLayout=await page.evaluate(()=>({overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth,targets:[...globalThis.document.querySelectorAll(".set-actions button,.workout-memory button,.exercise-actions button")].filter((node)=>node.getClientRects().length).map((node)=>node.getBoundingClientRect().height)}));assert.ok(mobileLayout.overflow<=1,`Workout Memory overflows 390px by ${mobileLayout.overflow}px`);assert.ok(mobileLayout.targets.every((height)=>height>=44),`Workout controls need 44px targets: ${mobileLayout.targets.join(", ")}`);
    assert.match(await first.locator(".workout-memory").textContent(),/Previous performance · 2026-09-01[\s\S]*42.5 kg/);assert.equal(await first.locator(".exercise-more").evaluate(node=>node.open),false,"Configuration should not compete with the live set logger by default");
    await first.locator("[data-use-last]").click();assert.equal(await first.locator('[data-set="0"] [data-actual="weight"]').inputValue(),"42.5");assert.equal(await first.locator('[data-set="1"] [data-actual="reps"]').inputValue(),"9");
    await openMore(first);await first.locator("[data-add-set]").click();first=page.locator("#sessionEntries [data-entry]").nth(0);assert.equal(await first.locator("[data-set]").count(),3);await first.locator('.set-more').nth(2).locator('summary').click();await first.locator('[data-remove-set="2"]').click();
    first=page.locator("#sessionEntries [data-entry]").nth(0);await first.locator('.set-more').nth(0).locator('summary').click();await first.locator('[data-duplicate-set="0"]').click();first=page.locator("#sessionEntries [data-entry]").nth(0);assert.equal(await first.locator('[data-set="1"] [data-complete]').getAttribute("aria-pressed"),"false");await first.locator('.set-more').nth(1).locator('summary').click();await first.locator('[data-remove-set="1"]').click();
    first=page.locator("#sessionEntries [data-entry]").nth(0);await openMore(first);await first.locator('[data-format="effortType"]').selectOption("rpe");first=page.locator("#sessionEntries [data-entry]").nth(0);await openMore(first);await first.locator('[data-set="0"] [data-actual="effort"]').fill("8.5");await first.locator("[data-entry-note]").fill("Bench notch 3; controlled lowering.");
    await first.locator(".advanced-tools summary").click();await first.locator("[data-warmup-load]").fill("100");await first.locator("[data-calc-warmup]").click();assert.match(await first.locator("[data-warmup-result]").textContent(),/40% · 40 kg × 8[\s\S]*80% · 80 kg × 3/);await first.locator("[data-plate-target]").fill("100");await first.locator("[data-calc-plates]").click();assert.match(await first.locator("[data-plate-result]").textContent(),/per side/);
    await first.locator("[data-toggle-superset]").click();cards=page.locator("#sessionEntries [data-entry]");assert.equal(await cards.filter({has:page.locator(".superset-badge")}).count(),2);
    second=cards.nth(1);const originalPlan=(await accountPlan(context)).plan;await openMore(second);await second.locator("[data-open-swap]").click();await page.locator("#swapDialog").waitFor({state:"visible"});assert.equal(await page.locator("#swapTitle").evaluate((node)=>node===globalThis.document.activeElement),true);assert.match(await page.locator("#swapComparison").textContent(),/Current[\s\S]*Alternative[\s\S]*FitScore[\s\S]*stability/i);
    await page.click("#reviewPlanSwap");await page.locator("#planSwapReview").waitFor({state:"visible"});assert.deepEqual((await accountPlan(context)).plan,originalPlan,"Reviewing a proposal must not change Plan");await page.click("#cancelPlanSwap");
    const workoutOnlyId=await page.locator("#swapExercise").inputValue();await page.click("#swapWorkoutOnly");await page.locator("#swapDialog").waitFor({state:"hidden"});assert.deepEqual((await accountPlan(context)).plan,originalPlan,"Workout-only replacement must leave Plan unchanged");await page.waitForFunction(()=>globalThis.document.querySelectorAll('#sessionEntries [data-entry]')[1]?.querySelector('.exercise-more > summary')===globalThis.document.activeElement);
    cards=page.locator("#sessionEntries [data-entry]");second=cards.nth(1);assert.match(await second.textContent(),/Replaced .* for this session/);assert.ok(workoutOnlyId);
    await openMore(second);await second.locator("[data-open-swap]").click();const lastingChoice=await page.locator("#swapExercise option").evaluateAll((options,original)=>options.map((option)=>option.value).find((value)=>value!==original),originalPlan.days.Monday[1].exerciseId);assert.ok(lastingChoice);await page.locator("#swapExercise").selectOption(lastingChoice);const approvedId=await page.locator("#swapExercise").inputValue();await page.click("#reviewPlanSwap");
    const planSaving=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/plan"&&response.request().method()==="PUT");await page.click("#approvePlanSwap");const planSaved=await planSaving;assert.equal(planSaved.status(),200,await planSaved.text());await page.locator("#swapDialog").waitFor({state:"hidden"});
    assert.equal((await accountPlan(context)).plan.days.Monday[1].exerciseId,approvedId,"Only explicit approval changes the saved Plan");
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");const active=(await (await context.request.get("/api/workouts?limit=20")).json()).workouts.find(item=>item.status==="active");const stored=(await (await context.request.get(`/api/workouts/${active.id}`)).json()).workout;
    assert.equal(stored.entries[0].note,"Bench notch 3; controlled lowering.");assert.equal(stored.entries[0].effortType,"rpe");assert.equal(stored.entries[0].sets[0].effort,8.5);assert.ok(stored.entries.every(entry=>entry.supersetGroup));
    await context.close();
  });

  await t.test("a Strata+ member logs actual work, resumes and sees the same completed results in history",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    const user=await signup(context,"mobile-workout");await activatePlus(context);
    const current=await accountPlan(context);
    const seed=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:fixtureWeek(),expectedPlanUpdatedAt:current.planUpdatedAt}});assert.equal(seed.status(),200);
    await goto(page,"/workout.html?day=Sunday");
    await page.locator("#trainingRoom").waitFor({state:"visible"});
    assert.equal(await page.locator("#startTitle").textContent(),"Nothing scheduled.");
    assert.equal(await page.locator("#planStatus").textContent(),"Nothing is scheduled for this day.");
    assert.equal(await page.locator("#startWorkout").isHidden(),true,"An empty recovery day must not leave a dead Start button");
    assert.equal(await page.locator("#resumeWorkout").isHidden(),true);
    assert.equal(await page.locator("#chooseScheduledDay").isVisible(),true);assert.match(await page.locator("#chooseScheduledDay").textContent(),/Choose another day/);
    assert.equal(await page.locator("#editWorkoutWeek").isVisible(),true);assert.match(await page.locator("#editWorkoutWeek").textContent(),/Edit weekly plan/);
    assert.equal(await page.locator("#openPlannerFromEmpty").isHidden(),true);
    assert.equal(await page.locator("#differentWorkout").isHidden(),true,"An empty day must not offer an alternative workout before one exists");
    await capture(page,"train-empty-day-mobile.png");
    await page.click("#chooseScheduledDay");assert.equal(await page.locator("#planDay").inputValue(),"Monday");
    assert.equal(await page.locator("#planStatus").textContent(),"Scheduled in your weekly plan.");
    assert.match(await page.locator("#startWorkout").textContent(),/Start workout/);
    assert.equal(await page.locator("#differentWorkout").isVisible(),true);assert.match(await page.locator("#differentWorkout").textContent(),/Create a different workout/);
    assert.equal(new URL(await page.locator("#differentWorkout a").getAttribute("href"),baseUrl).hash,"#sessionBuilder");
    await capture(page,"train-scheduled-mobile.png");
    const startLayout=await page.evaluate(()=>{const start=globalThis.document.querySelector("#startWorkout").getBoundingClientRect(),hero=globalThis.getComputedStyle(globalThis.document.querySelector(".hero"));return{bottom:start.bottom,viewport:globalThis.innerHeight,heroDisplay:hero.display,overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth};});
    assert.equal(startLayout.heroDisplay,"none","The entitled mobile workout summary should lead instead of a second marketing hero");assert.ok(startLayout.bottom<=startLayout.viewport-56,`Start action must fit above mobile navigation (${startLayout.bottom}/${startLayout.viewport})`);assert.ok(startLayout.overflow<=1);
    const creating=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await page.click("#startWorkout");const created=await creating;assert.equal(created.status(),201,await created.text());const workoutId=(await created.json()).workout.id;
    await page.locator("#sessionPanel").waitFor({state:"visible"});
    const entry=page.locator("#sessionEntries [data-entry]").first();
    await entry.locator('.exercise-more > summary').click();const exerciseGuide=entry.locator('.exercise-guide');await exerciseGuide.locator('summary').click();
    assert.match(await exerciseGuide.textContent(),/Set up[\s\S]*Purpose[\s\S]*Technique cues[\s\S]*Common mistake[\s\S]*Same target · other equipment/);
    await entry.locator('[data-actual="weight"]').fill("40");await entry.locator('[data-actual="reps"]').fill("8");await entry.locator('[data-complete="0"]').click();
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");
    assert.equal(await page.locator("#sessionProgress").getAttribute("value"),"100");
    assert.equal(await page.locator("#timerToggle").textContent(),"Pause");await page.click("#timerToggle");
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");
    await goto(page,"/account.html");await page.locator("#signedInCard").waitFor({state:"visible"});
    await page.waitForFunction(()=>globalThis.document.querySelector("#accountPrimaryLabel")?.textContent==="Continue workout");
    assert.match(await page.locator("#accountPrimaryAction").getAttribute("href"),/^\/workout\.html#resume=/);
    await page.click("#accountPrimaryAction");await page.locator("#sessionPanel").waitFor({state:"visible"});
    assert.equal(await page.locator("#sessionTitle").evaluate(node=>globalThis.document.activeElement===node),true,"Account’s next action should resume the active session directly");
    let duplicateStarts=0;page.on("request",request=>{if(new URL(request.url()).pathname==="/api/workouts"&&request.method()==="POST")duplicateStarts++;});
    await goto(page,"/workout.html?day=Monday");const historyResume=page.locator('#historyList [data-history]').first();await historyResume.waitFor({state:"visible"});
    assert.equal(await page.locator('#recoveryList [data-recover]').count(),0,"A clean saved active session must not also appear as recovery");
    assert.equal(await page.locator("#resumeWorkout").isVisible(),true,"The active workout owns the primary Resume action");
    assert.equal(await page.locator("#startWorkout").isHidden(),true,"An active session must not expose a redundant Start action");
    assert.equal(await page.locator("#chooseScheduledDay").isHidden(),true);assert.equal(await page.locator("#openPlannerFromEmpty").isHidden(),true);assert.equal(await page.locator("#differentWorkout").isHidden(),true);
    await capture(page,"train-active-mobile.png");
    await page.locator("#resumeWorkout").click();assert.equal(duplicateStarts,0,"Resuming must not create or orphan another account session");
    await page.locator("#sessionPanel").waitFor({state:"visible"});
    assert.equal(await entry.locator('[data-actual="weight"]').inputValue(),"40");assert.equal(await entry.locator('[data-actual="reps"]').inputValue(),"8");
    assert.equal(await entry.locator('[data-complete="0"]').getAttribute("aria-pressed"),"true");
    await page.click("#finishWorkout");await page.locator("#finishDialog").waitFor({state:"visible"});await page.click('#finishDialog button[value="finish"]');
    await page.locator("#celebration").waitFor({state:"visible"});
    await page.locator("#calendarNext").waitFor({state:"visible"});assert.match(await page.locator("#calendarLink").getAttribute("href"),/^data:text\/calendar;charset=utf-8,/);assert.match(await page.locator("#calendarNext").textContent(),/does not request notification access/i);
    await page.selectOption('#checkInDifficulty','3');await page.selectOption('#checkInEnergy','4');await page.selectOption('#checkInComfort','4');await page.selectOption('#checkInEnjoyment','5');
    const checkInSaving=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${workoutId}/check-in`&&response.request().method()==="POST");
    await page.click('#saveCheckIn');const checkInResponse=await checkInSaving;assert.equal(checkInResponse.status(),200,await checkInResponse.text());
    assert.deepEqual(checkInResponse.request().postDataJSON(),{checkIn:{difficulty:3,energy:4,comfort:4,enjoyment:5}});
    assert.ok(checkInResponse.request().headers()['x-csrf-token'],"The check-in write must carry CSRF proof");
    await page.waitForFunction(()=>globalThis.document.querySelector('#checkInStatus')?.textContent==="Saved");
    await page.locator('#progressionPanel').waitFor({state:"visible"});assert.match(await page.locator('#progressionPanel').textContent(),/Targets use your completed sets[\s\S]*Review and apply a target when you next train the same exercise/i);
    const restoredCheckIn=await context.request.get(`/api/workouts/${workoutId}/check-in`);assert.equal(restoredCheckIn.status(),200);assert.deepEqual((await restoredCheckIn.json()).checkIn.difficulty,3);
    await page.locator("#historyList [data-history]").first().click();
    await page.locator("#detailDialog").waitFor({state:"visible"});const details=await page.locator("#detailBody").textContent();
    assert.match(details,/40/);assert.match(details,/8/);assert.match(details,/kg/);
    await page.click("#closeDetail");await page.reload({waitUntil:"domcontentloaded"});
    await page.locator("#historyList [data-history]").first().waitFor({state:"visible"});assert.equal(await page.locator("#historyList [data-history]").count(),1,"A completed session survives reload without duplication");
    await context.close();
  });
  await t.test("a low-energy check-in proposes a review-first Plan change that the member explicitly approves",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    const user=await signup(context,"adaptation");await activatePlus(context);
    const current=await accountPlan(context),week=fixtureWeek();week.days.Monday[0].sets=3;
    const seed=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:week,expectedPlanUpdatedAt:current.planUpdatedAt,expectedUserId:user.id}});
    assert.equal(seed.status(),200,await seed.text());const seeded=await seed.json();
    await goto(page,"/workout.html?day=Monday");await page.locator("#startWorkout").waitFor({state:"visible"});
    const creating=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await page.click("#startWorkout");const created=await creating;assert.equal(created.status(),201,await created.text());const workoutId=(await created.json()).workout.id;
    const entry=page.locator("#sessionEntries [data-entry]").first();await entry.locator('[data-actual="weight"]').first().fill("30");await entry.locator('[data-actual="reps"]').first().fill("8");await entry.locator('[data-complete="0"]').click();
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");
    await page.click("#finishWorkout");await page.locator("#finishDialog").waitFor({state:"visible"});await page.click('#finishDialog button[value="finish"]');await page.locator("#celebration").waitFor({state:"visible"});
    await page.selectOption("#checkInDifficulty","4");await page.selectOption("#checkInEnergy","2");await page.selectOption("#checkInComfort","4");await page.selectOption("#checkInEnjoyment","3");
    const checkInSaving=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${workoutId}/check-in`&&response.request().method()==="POST");
    await page.click("#saveCheckIn");const checkInResponse=await checkInSaving;assert.equal(checkInResponse.status(),200,await checkInResponse.text());const checked=await checkInResponse.json();
    assert.equal(checked.adaptation?.status,"pending");assert.equal(checked.adaptation?.requiresApproval,true);assert.equal(checked.adaptation?.change?.fromSets,3);assert.equal(checked.adaptation?.change?.toSets,2);
    const proposal=page.locator("#adaptationProposal");await proposal.waitFor({state:"visible"});assert.match(await proposal.textContent(),/Plan change available[\s\S]*energy 2\/5[\s\S]*3 to 2 sets[\s\S]*No change happens unless you approve it/i);
    assert.equal(await proposal.locator("button").count(),0,"Plan owns approval; Train offers a shortcut without a second approval form");await page.click("#reviewAdaptation");await page.locator("#progressionCard").waitFor({state:"visible"});assert.equal(await page.locator("#planWorkspace").isVisible(),true);const approve=page.locator("#progressionAccept");
    const unchanged=await accountPlan(context);assert.equal(unchanged.plan.days.Monday[0].sets,3,"Saving low-energy feedback must not silently change Plan");assert.equal(unchanged.planUpdatedAt,seeded.planUpdatedAt);
    const accepting=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/training/adaptations/${checked.adaptation.id}`&&response.request().method()==="POST");
    await approve.click();const accepted=await accepting;assert.equal(accepted.status(),200,await accepted.text());assert.deepEqual(accepted.request().postDataJSON(),{decision:"accept",expectedPlanUpdatedAt:seeded.planUpdatedAt});assert.ok(accepted.request().headers()["x-csrf-token"],"The explicit approval must carry CSRF proof");
    await page.waitForFunction(()=>globalThis.document.querySelector("#progressionStatus")?.textContent?.includes("Saved."));
    const applied=await accountPlan(context);assert.equal(applied.plan.days.Monday[0].sets,2,"Only the visible approval action may apply the proposed reduction");assert.ok(applied.planUpdatedAt>seeded.planUpdatedAt);
    await context.close();
  });
  await t.test("account sessions persist actual values across reload, and identity-network errors never become guest access",async()=>{
    const {context,page}=await newPage();const user=await signup(context,"workout");await activatePlus(context);
    const current=await accountPlan(context);
    const seed=await context.request.put("/api/plan",{headers:{Origin:baseUrl,"X-CSRF-Token":current.csrfToken,"X-Strata-User":user.id},data:{plan:fixtureWeek(),expectedPlanUpdatedAt:current.planUpdatedAt,expectedUserId:user.id}});
    assert.equal(seed.status(),200);
    await goto(page,"/workout.html?day=Monday");await page.locator("#trainingRoom").waitFor({state:"visible"});await page.selectOption("#planDay","Monday");
    const creating=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
    await page.click("#startWorkout");const created=await creating;assert.equal(created.status(),201,await created.text());
    const first=await created.json();assert.equal(created.request().headers()["x-strata-user"],user.id);
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");
    const entry=page.locator("#sessionEntries [data-entry]").first();
    const blockWorkoutSave=route=>route.request().method()==="PUT"?route.abort():route.continue();await page.route(`**/api/workouts/${first.workout.id}`,blockWorkoutSave);
    await entry.locator('[data-actual="weight"]').fill("25");await entry.locator('[data-actual="reps"]').fill("9");await entry.locator('[data-complete="0"]').click();
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.dataset.state==="error");
    const workoutHistoryPattern=/\/api\/workouts\?/;
    let releaseHistory,historyRequestedResolve;
    const historyRelease=new Promise(resolve=>{releaseHistory=resolve;}),historyRequested=new Promise(resolve=>{historyRequestedResolve=resolve;});
    const blockWorkoutHistory=async route=>{historyRequestedResolve();await historyRelease;await route.continue();};
    await page.route(workoutHistoryPattern,blockWorkoutHistory);
    page.once("dialog",dialog=>dialog.accept());await page.reload({waitUntil:"domcontentloaded"});await historyRequested;await page.locator('#recoveryList [data-recover="0"]').waitFor({state:"visible"});
    assert.equal(await page.locator('#historyList [data-history]').count(),0,"A dirty device draft replaces the stale active-history Resume surface");
    assert.equal(await page.locator("#startWorkout").isHidden(),true,"An active session with a device recovery must not expose a redundant Start action while saved history is still loading");
    const historyLoaded=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="GET");releaseHistory();await historyLoaded;await page.unroute(workoutHistoryPattern,blockWorkoutHistory);
    await page.locator('#recoveryList [data-recover="0"]').click();await page.locator("#sessionPanel").waitFor({state:"visible"});await page.unroute(`**/api/workouts/${first.workout.id}`,blockWorkoutSave);
    assert.equal(await entry.locator('[data-actual="weight"]').inputValue(),"25");assert.equal(await entry.locator('[data-actual="reps"]').inputValue(),"9");assert.equal(await entry.locator('[data-complete="0"]').getAttribute("aria-pressed"),"true");
    const saving=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${first.workout.id}`&&response.request().method()==="PUT");await page.click("#saveNow");
    const saved=await saving;assert.equal(saved.status(),200,await saved.text());assert.equal(saved.request().postDataJSON().expectedRevision,first.workout.revision);
    await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");
    await page.click("#finishWorkout");await page.click('#finishDialog button[value="finish"]');await page.locator("#celebration").waitFor({state:"visible"});
    const persisted=await context.request.get(`/api/workouts/${first.workout.id}`);assert.equal(persisted.status(),200);const completed=(await persisted.json()).workout;
    assert.equal(completed.status,"completed");assert.equal(completed.entries[0].sets[0].weight,25);assert.equal(completed.entries[0].sets[0].reps,9);
    const disconnected=await context.newPage();disconnected.on("pageerror",error=>pageErrors.push(error.message));await disconnected.route("**/api/me",route=>route.abort());
    await goto(disconnected,"/workout.html");await disconnected.locator("#loadError").waitFor({state:"visible"});
    assert.equal(await disconnected.locator("#accessPanel").isVisible(),false,"A failed account check must not offer anonymous fallback as though the user signed out");
    assert.equal(await disconnected.locator("#trainingRoom").isVisible(),false,"Network failures must not silently select a guest log");
    await context.close();
  });
  await t.test("free accounts are gated; Strata+ setup creates an editable account week",async()=>{
    const {context,page}=await newPage({viewport:{width:390,height:844},reducedMotion:"reduce"});
    await goto(page,"/workout.html?guest=1");assert.match(page.url(),/account.html/);
    await signup(context,"setup");
    await goto(page,"/");await page.waitForFunction(()=>globalThis.document.querySelector("#catalogTotal")?.textContent==="320"&&globalThis.document.querySelector("#accountButton")?.textContent?.includes("profile"));
    assert.equal(await page.locator("[data-compare]").count(),0,"A signed-in free account must not receive homepage comparison controls");
    await goto(page,"/onboarding.html");assert.match(page.url(),/pricing/);
    await activatePlus(context);
    await goto(page,"/");await page.locator("[data-compare]").first().waitFor({state:"visible"});
    assert.ok(await page.locator("[data-compare]").count()>0,"A currently entitled member should retain homepage comparison controls");
    await goto(page,"/workout.html");await page.locator("#trainingRoom").waitFor({state:"visible"});await page.waitForFunction(()=>globalThis.document.querySelector("#planStatus")?.textContent==="You have not built a weekly plan yet.");
    assert.equal(await page.locator("#openPlannerFromEmpty").isVisible(),true);assert.match(await page.locator("#openPlannerFromEmpty").textContent(),/Build your first week/);
    for(const selector of ["#resumeWorkout","#chooseScheduledDay","#startWorkout","#differentWorkout","#editWorkoutWeek"])assert.equal(await page.locator(selector).isHidden(),true,`${selector} must stay hidden before a weekly plan exists`);
    assert.equal(await page.locator("#planDayField").isHidden(),true);assert.equal(await page.locator("#historyStats").isHidden(),true);assert.match(await page.locator("#historyList").textContent(),/progress appears after your first completed workout/i);
    await goto(page,"/discover.html");
    const firstWeekAction=page.getByRole('link',{name:'Build your first week',exact:true});
    await firstWeekAction.waitFor({state:"visible"});assert.equal(new URL(await firstWeekAction.getAttribute('href'),baseUrl).pathname,'/planner.html');
    await goto(page,"/onboarding.html");
    await page.waitForFunction(()=>globalThis.document.querySelector('#setupFields')?.disabled===false);
    await page.locator('#starterPath').waitFor({state:'visible'});await page.click('[data-equipment-preset="bodyweight"]');
    assert.deepEqual(await page.locator('input[name="equipment"]:checked').evaluateAll(nodes=>nodes.map(node=>node.value)),['Bodyweight']);
    const before=(await accountPlan(context)).plan;
    await page.click('#generateWeek');await page.locator('#saveControls').waitFor({state:'visible'});
    assert.deepEqual((await accountPlan(context)).plan,before);
    await page.click('#saveWeek');await page.locator('#startFirstWorkout').waitFor({state:'visible'});await page.locator('#openPlanner').waitFor({state:'visible'});
    const after=(await accountPlan(context)).plan,setupResponse=await context.request.get("/api/setup");
    assert.equal(setupResponse.status(),200);const savedSetup=await setupResponse.json();
    const trainingDays=Object.keys(after.days).filter(day=>after.days[day].length>0),restDays=Object.keys(after.days).filter(day=>after.days[day].length===0);
    assert.ok(Object.values(after.days).flat().length>0);assert.equal(trainingDays.length,savedSetup.preferences.days);assert.deepEqual(after.restDays,restDays);
    const firstWorkoutUrl=new URL(await page.locator('#startFirstWorkout').getAttribute('href'),baseUrl);assert.equal(firstWorkoutUrl.pathname,'/workout.html');assert.equal(firstWorkoutUrl.searchParams.get('day'),trainingDays[0]);
    await page.click('#openPlanner');await plannerReady(page);
    await context.close();
  });
  assert.deepEqual(pageErrors,[],`Unexpected browser errors:\n${pageErrors.join("\n")}`);
});

test.before(async()=>{
  try{await startApp();const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);}
  catch(error){await cleanup();throw error;}
});
test.after(cleanup);
