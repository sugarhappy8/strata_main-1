"use strict";

const assert=require("node:assert/strict");
const {existsSync,mkdirSync,readFileSync}=require("node:fs");
const {extname,join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..",".."),ORIGIN="http://strata-plus-state.test";
const CAPTURE_DIR=process.env.STRATA_STATE_SCREENSHOT_DIR?resolve(process.env.STRATA_STATE_SCREENSHOT_DIR):null;
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public/data/exercises.json"),"utf8"));
const DISCOVERY=JSON.parse(readFileSync(join(ROOT,"src/data/discovery-data.json"),"utf8"));
const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const USER={id:"state-matrix-member",name:"State Matrix",discovery:{active:true}};
const CSRF="state-matrix-csrf";
const PREFERENCES={goal:"hypertrophy",level:"Intermediate",days:4,equipment:[...new Set(CATALOG.map((item)=>item.equipment))],preferences:[],limitations:[]};
let browser;

function emptyWeek(){return{version:1,restDay:"Sunday",restDays:["Sunday"],days:Object.fromEntries(DAYS.map((day)=>[day,[]]))};}
function scheduledWeek(){const plan=emptyWeek();plan.days.Monday=[{instanceId:"state-monday-press",exerciseId:"incline-smith-press",sets:3,reps:"6–10"}];return plan;}
function isoDate(daysAgo=0){const date=new Date();date.setUTCDate(date.getUTCDate()-daysAgo);return date.toISOString().slice(0,10);}
function summary(maxWeight,volume=maxWeight*24){return{exerciseId:"incline-smith-press",measurement:"reps",loadType:"external",unit:"kg",completedSets:3,maxWeight,maxReps:8,volume};}
function completed(id,daysAgo,maxWeight){const startedAt=Date.now()-daysAgo*86_400_000;return{id,title:"Monday workout",date:isoDate(daysAgo),planDay:"Monday",status:"completed",startedAt,completedAt:startedAt+1_800_000,elapsedSeconds:1800,completedSets:3,totalSets:3,exerciseCount:1,exerciseSummaries:[summary(maxWeight)]};}
function active(){return{id:"active-state-workout",title:"Monday workout",date:isoDate(),planDay:"Monday",status:"active",startedAt:Date.now()-600_000,completedAt:null,elapsedSeconds:600,completedSets:1,totalSets:3,exerciseCount:1,exerciseSummaries:[summary(35,280)]};}
function staticAsset(pathname){
  if(pathname.includes(".."))return null;
  const relative=pathname.replace(/^\//,""),extension=extname(relative),folder=extension===".html"?"pages":extension===".js"?"scripts":extension===".css"?"styles":"";
  return [join(ROOT,"public",relative),...(folder?[join(ROOT,"public",folder,relative)]:[])].find((candidate)=>existsSync(candidate))||null;
}

async function fixture(t,{plan=scheduledWeek(),workouts=[],historyMode="ready",path="/discover.html"}={}){
  const context=await browser.newContext({baseURL:ORIGIN,serviceWorkers:"block",viewport:{width:390,height:844},reducedMotion:"reduce",timezoneId:"UTC"});
  t.after(()=>context.close());context.setDefaultTimeout(10_000);
  const page=await context.newPage(),errors=[],unexpected=[],monthlyWrites=[];
  let historyCalls=0,releaseHistory;
  const historyGate=new Promise((resolveGate)=>{releaseHistory=resolveGate;});
  page.on("pageerror",(error)=>errors.push(error.message));
  await context.route("**/*",async(route)=>{
    const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
    if(url.origin!==ORIGIN){await route.abort();return;}
    const json=(value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
    if(pathname==="/api/discovery")return json({user:USER,csrfToken:CSRF,exercises:CATALOG,...DISCOVERY,preferences:PREFERENCES,ratings:{aggregates:[],user:[]},weeklyPlan:plan,weeklyPlanUpdatedAt:1730000000000,monthlyPlan:null,monthlyPlanUpdatedAt:0});
    if(pathname==="/api/coaching/profile")return json({profile:null,csrfToken:CSRF});
    if(pathname==="/api/me")return json({user:USER,csrfToken:CSRF});
    if(pathname==="/api/workouts"){
      historyCalls+=1;
      if(historyMode==="pending-error"&&historyCalls===1){await historyGate;return json({error:"Fixture history unavailable"},503);}
      return json({user:USER,csrfToken:CSRF,workouts,hasMore:false});
    }
    if(pathname==="/api/training")return json({user:USER,csrfToken:CSRF,block:null,adaptation:null});
    if(pathname==="/api/ratings/aggregates")return json({csrfToken:CSRF,aggregates:[]});
    if(pathname==="/api/monthly-plan"&&request.method()==="PUT"){
      const payload=request.postDataJSON(),monthlyPlan={...payload.monthlyPlan,updatedAt:1730000000100+monthlyWrites.length};
      monthlyWrites.push({payload,csrf:request.headers()["x-csrf-token"]});return json({user:USER,csrfToken:CSRF,monthlyPlan});
    }
    if(pathname.startsWith("/api/")){unexpected.push(`${request.method()} ${pathname}`);return json({error:"Unexpected fixture API"},404);}
    const file=staticAsset(pathname);
    if(!file){unexpected.push(pathname);await route.fulfill({status:404,body:"Missing fixture asset"});return;}
    await route.fulfill({path:file});
  });
  await page.goto(path,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>globalThis.document.querySelector("#userName")?.textContent==="State Matrix");
  return{page,errors,unexpected,monthlyWrites,releaseHistory:()=>releaseHistory(),historyCalls:()=>historyCalls};
}

function healthy(value){assert.deepEqual(value.errors,[]);assert.deepEqual(value.unexpected,[]);}
async function capture(page,name){if(!CAPTURE_DIR)return;mkdirSync(CAPTURE_DIR,{recursive:true});await page.screenshot({path:join(CAPTURE_DIR,name),fullPage:true});}

test("Strata+ distinguishes loading, error, empty history, and the no-plan next action",{timeout:25_000},async(t)=>{
  const f=await fixture(t,{plan:null,historyMode:"pending-error",path:"/discover.html#progressWorkspace"}),{page}=f;
  await page.locator("#progressLoadingState").waitFor({state:"visible"});
  assert.equal(await page.locator("#progressLoadError").isHidden(),true);assert.equal(await page.locator("#progressFirstWorkout").isHidden(),true);assert.equal(await page.locator("#progressHistoryContent").isHidden(),true);
  assert.equal((await page.locator("#progressAdherence").textContent()).trim(),"");
  f.releaseHistory();await page.locator("#progressLoadError").waitFor({state:"visible"});await page.locator("#progressRetry").waitFor({state:"visible"});
  assert.equal(await page.locator("#progressLoadingState").isHidden(),true);assert.equal(await page.locator("#progressFirstWorkout").isHidden(),true);assert.match(await page.locator("#progressLoadErrorMessage").textContent(),/could not be loaded/i);
  await page.locator("#progressRetry").focus();await page.keyboard.press("Enter");await page.locator("#progressFirstWorkout").waitFor({state:"visible"});
  assert.equal(f.historyCalls(),2);assert.equal(await page.locator("#progressLoadingState").isHidden(),true);assert.equal(await page.locator("#progressLoadError").isHidden(),true);assert.equal(await page.locator("#progressHistoryContent").isHidden(),true);
  await page.locator('[data-feature-target="today"]').first().click();await page.locator("#todayWorkspace").waitFor({state:"visible"});
  assert.equal(await page.locator("#weeklyPulseDetail").textContent(),"You have not built a weekly plan yet.");assert.match(await page.locator("#plusStartWorkout").textContent(),/Build your first week/);assert.equal(await page.locator("#plusStartWorkout").getAttribute("href"),"/planner.html");
  assert.equal(await page.locator("#weeklyPulseFooter").isHidden(),true);assert.equal(await page.locator("#todayAlternativeWorkout").isHidden(),true);
  await capture(page,"strata-plus-no-plan-mobile.png");
  healthy(f);
});

test("a deep-linked workspace skip link keeps the selected Strata+ destination",{timeout:20_000},async(t)=>{
  const f=await fixture(t,{path:"/discover.html#coachingWorkspace"}),{page}=f;
  await page.locator("#coachingSetup").waitFor({state:"visible"});assert.equal(await page.locator("#activeWorkspaceSkip").getAttribute("href"),"#coachingWorkspaceTitle");
  await page.locator("#activeWorkspaceSkip").focus();await page.keyboard.press("Enter");await page.waitForFunction(()=>globalThis.document.activeElement?.id==="coachingWorkspaceTitle");
  assert.equal(await page.locator("#coachingWorkspace").isVisible(),true);assert.equal(await page.locator('[data-feature-target="nutrition"].destination-link').getAttribute("aria-current"),"location");assert.equal(await page.locator("[data-feature-panel]:not([hidden])").count(),1);healthy(f);
});

test("the six Strata+ destinations retain keyboard focus, mobile identity, reduced motion, and a 31-day browser flow",{timeout:30_000},async(t)=>{
  const f=await fixture(t),{page}=f;
  await page.locator("#progressFirstWorkout").waitFor({state:"attached"});await page.waitForFunction(()=>globalThis.document.querySelector("#progressFirstWorkout")?.hidden===false);
  assert.match(await page.locator("#plusStartWorkout").textContent(),/Start workout/);assert.equal(await page.locator("#todayAlternativeWorkout").isVisible(),true);
  const primary=page.locator(".destination-nav .destination-link");
  assert.deepEqual(await primary.locator("span").allTextContents(),["Overview","Plan","Train","Nutrition","Progress","Exercises"]);
  const mobile=page.locator(".studio-nav-mobile");assert.equal(await mobile.isVisible(),true);assert.deepEqual(await mobile.locator("a").allTextContents(),["Exercises","Strata+","Plan","Train"]);assert.equal(await mobile.locator('[aria-current="page"]').textContent(),"Strata+");
  const layout=await page.evaluate(()=>({overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth,reduced:globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,motion:[...globalThis.document.querySelectorAll(".destination-link")].map((node)=>{const style=globalThis.getComputedStyle(node);return[style.animationDuration,style.transitionDuration];})}));
  assert.ok(layout.overflow<=1,`Strata+ overflows the 390px viewport by ${layout.overflow}px`);assert.equal(layout.reduced,true);for(const durations of layout.motion)for(const value of durations)assert.ok(value.split(",").every((part)=>Number.parseFloat(part)===0),`Reduced motion left ${value}`);

  for(const [label,panel,heading] of [["Overview","todayWorkspace","todayTitle"],["Plan","planWorkspace","planWorkspaceTitle"],["Progress","progressWorkspace","progressWorkspaceTitle"],["Exercises","exploreWorkspace","exploreWorkspaceTitle"],["Nutrition","nutritionWorkspace","nutritionWorkspaceTitle"]]){
    const link=primary.filter({hasText:label}).first();await link.focus();await page.keyboard.press("Enter");await page.locator(`#${panel}`).waitFor({state:"visible"});await page.waitForFunction((hash)=>globalThis.location.hash===hash,`#${panel}`);
    await page.waitForFunction((id)=>globalThis.document.activeElement?.id===id,heading);assert.equal(await link.getAttribute("aria-current"),"location");assert.equal(await page.locator("[data-feature-panel]:not([hidden])").count(),1);
    const visible=await link.evaluate((node)=>{const rail=node.parentElement,linkBox=node.getBoundingClientRect(),railBox=rail.getBoundingClientRect();return linkBox.left>=railBox.left-1&&linkBox.right<=railBox.right+1;});assert.equal(visible,true,`${label} should remain visible in the mobile destination rail`);
  }
  assert.equal(await page.locator("#scoreGuide").isHidden(),true,"Coaching should not show the exercise-score guide");await primary.filter({hasText:"Exercises"}).first().click();assert.equal(await page.locator("#scoreGuide").isVisible(),true);assert.equal(await page.locator("#scoreGuideDetails").evaluate((node)=>node.open),false);assert.equal(await page.locator("#scoreGuide").count(),1);

  await primary.filter({hasText:"Plan"}).first().click();assert.equal(await page.locator("#planSummaryTitle").textContent(),"YOUR WEEKLY PLAN");
  for(const id of ["workoutBuilderDetails","planAheadDetails","reuseWeekDetails"])assert.equal(await page.locator(`#${id}`).evaluate((node)=>node.open),false);
  await page.setViewportSize({width:1440,height:1000});await capture(page,"strata-plus-plan-desktop.png");await page.setViewportSize({width:390,height:844});await capture(page,"strata-plus-plan-mobile.png");
  await page.locator("#planAheadDetails > summary").click();await page.locator('#planAheadDetails [data-feature-target="monthly"]').click();await page.locator("#monthlyPlan").waitFor({state:"visible"});
  await page.locator("#monthlySourceAccount").click();await page.waitForFunction(()=>globalThis.document.querySelector("#monthlyPlanStatus")?.textContent?.includes("private snapshot"));
  const saved=page.waitForResponse((response)=>new URL(response.url()).pathname==="/api/monthly-plan"&&response.request().method()==="PUT");await page.locator("#generateMonthlyPlan").click();assert.equal((await saved).status(),200);
  await page.locator("#monthlyResults").waitFor({state:"visible"});assert.equal(await page.locator("#monthlyDays .monthly-day-card").count(),31);assert.match(await page.locator("#monthlySummary").textContent(),/Plan\s*31 days/);
  assert.equal(f.monthlyWrites.length,1);assert.equal(f.monthlyWrites[0].csrf,CSRF);assert.equal(f.monthlyWrites[0].payload.expectedUpdatedAt,0);assert.equal(f.monthlyWrites[0].payload.monthlyPlan.days.length,31);
  healthy(f);
});

test("Strata+ shows Resume for an active session and only real metrics for populated history",{timeout:20_000},async(t)=>{
  const workouts=[active(),completed("new-best",0,40),completed("old-baseline",7,30)],f=await fixture(t,{workouts}),{page}=f;
  await page.waitForFunction(()=>globalThis.document.querySelector("#progressHistoryContent")?.hidden===false);
  await page.locator("#plusStartWorkout").filter({hasText:"Resume workout"}).waitFor({state:"visible"});
  assert.match(await page.locator("#plusStartWorkout").textContent(),/Resume workout/);assert.match(await page.locator("#plusStartWorkout").getAttribute("href"),/^\/workout\.html#resume=active-state-workout$/);
  assert.equal(await page.locator("#todayAlternativeWorkout").isHidden(),true,"An active session must remain the only workout action");
  await page.locator('.destination-link[data-feature-target="progress"]').click();await page.locator("#progressHistoryContent").waitFor({state:"visible"});
  assert.equal(await page.locator("#progressLoadingState").isHidden(),true);assert.equal(await page.locator("#progressLoadError").isHidden(),true);assert.equal(await page.locator("#progressFirstWorkout").isHidden(),true);
  assert.notEqual((await page.locator("#progressAdherence").textContent()).trim(),"");assert.match(await page.locator("#progressSessions").textContent(),/^2$/);assert.match(await page.locator("#repeatImprovementList").textContent(),/30 kg\s*→\s*40 kg/);assert.match(await page.locator("#personalBestList").textContent(),/Incline Smith Press/);
  await capture(page,"strata-plus-progress-mobile.png");
  assert.equal(await page.locator("#scoreGuide").isHidden(),true);healthy(f);
});

test.before(async()=>{const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);});
test.after(()=>browser?.close());
