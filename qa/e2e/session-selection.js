"use strict";

const assert=require("node:assert/strict");
const {existsSync,mkdirSync,readFileSync}=require("node:fs");
const {extname,join,resolve}=require("node:path");
const test=require("node:test");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..",".."),ORIGIN="http://strata-session.test";
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public/data/exercises.json"),"utf8"));
const DISCOVERY=JSON.parse(readFileSync(join(ROOT,"src/data/discovery-data.json"),"utf8"));
const EXERCISES=new Map(CATALOG.map((exercise)=>[exercise.id,exercise]));
const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const USER={id:"session-selection-member",name:"Session Selection",discovery:{active:true}};
const CSRF="session-selection-csrf";
const PREFERENCES={goal:"hypertrophy",level:"Advanced",days:4,equipment:[...new Set(CATALOG.map((exercise)=>exercise.equipment))],preferences:[],limitations:[]};
const MODES=[{value:"random",label:"Random"},{value:"not-in-week",label:"Not in my week"},{value:"needs-focus",label:"Needs focus"},{value:"preferences",label:"My preferences"}];
let browser;

function fixtureWeek(){
  return{version:1,restDay:"Sunday",restDays:["Sunday"],days:Object.fromEntries(DAYS.map((day)=>[day,day==="Monday"?[{instanceId:"existing-monday",exerciseId:"incline-smith-press",sets:4,reps:"6–8"}]:day==="Wednesday"?[{instanceId:"existing-wednesday",exerciseId:"flat-dumbbell-press",sets:2,reps:"10–12"}]:[]]))};
}
function workout({id="completed-chest",daysAgo=1,status="completed",summaries=[]}={}){
  const when=new Date();when.setUTCDate(when.getUTCDate()-daysAgo);
  return{id,title:"Fixture session",date:when.toISOString().slice(0,10),planDay:"Monday",status,startedAt:when.getTime(),completedAt:status==="completed"?when.getTime()+1000:null,exerciseSummaries:summaries};
}
function focusHistory(){
  return[
    workout({summaries:[{exerciseId:"incline-smith-press",completedSets:12},{exerciseId:"cable-serratus-punch",completedSets:12},{exerciseId:"flat-dumbbell-press",completedSets:0}]}),
    workout({id:"active-does-not-count",status:"active",summaries:[{exerciseId:"flat-dumbbell-press",completedSets:100}]}),
    workout({id:"old-does-not-count",daysAgo:40,summaries:[{exerciseId:"flat-dumbbell-press",completedSets:100}]})
  ];
}
function staticAsset(pathname){
  if(pathname.includes(".."))return null;
  const relative=pathname.replace(/^\//,""),extension=extname(relative),folder=extension===".html"?"pages":extension===".js"?"scripts":extension===".css"?"styles":"";
  const candidates=[join(ROOT,"public",relative),...(folder?[join(ROOT,"public",folder,relative)]:[])];
  return candidates.find((candidate)=>existsSync(candidate))||null;
}
async function fixture(t,{plan=fixtureWeek(),workouts=focusHistory(),historyAvailable=true,hasMore=false,ratings=[],conflictOnSave=false}={}){
  const context=await browser.newContext({baseURL:ORIGIN,serviceWorkers:"block",viewport:{width:390,height:844},reducedMotion:"reduce",timezoneId:"UTC"});
  t.after(()=>context.close());context.setDefaultTimeout(8_000);
  const page=await context.newPage(),errors=[],unexpected=[],writes=[];
  let savedPlan=structuredClone(plan),revision=1730000000000;
  page.on("pageerror",(error)=>errors.push(error.message));
  // A fixed sequence makes the fresh-random-picks regression reproducible.
  await context.addInitScript(()=>{let seed=781;Math.random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};});
  await context.route("**/*",async(route)=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname;
    if(url.origin!==ORIGIN){await route.abort();return;}
    const json=(value,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
    if(path==="/api/discovery")return json({user:USER,csrfToken:CSRF,exercises:CATALOG,...DISCOVERY,preferences:PREFERENCES,ratings:{aggregates:[],user:ratings},weeklyPlan:savedPlan,weeklyPlanUpdatedAt:revision,monthlyPlan:null,monthlyPlanUpdatedAt:0});
    if(path==="/api/me")return json({user:USER,csrfToken:CSRF});
    if(path==="/api/workouts")return historyAvailable?json({workouts,hasMore,csrfToken:CSRF}):json({error:"History temporarily unavailable"},503);
    if(path==="/api/training")return json({user:USER,csrfToken:CSRF,block:null,adaptation:null});
    if(path==="/api/training-log")return json({from:"",to:"",entries:[]});
    if(path==="/api/snapshots")return json({from:"",to:"",snapshots:[]});
    if(path==="/api/plan"){
      if(request.method()==="PUT"){
        const payload=request.postDataJSON();writes.push({payload,csrf:request.headers()["x-csrf-token"]});
        if(conflictOnSave&&writes.length===1){
          const existingIds=new Set(Object.values(savedPlan.days).flat().map((entry)=>entry.exerciseId)),overlap=Object.values(payload.plan.days).flat().find((entry)=>!existingIds.has(entry.exerciseId));
          savedPlan.days.Friday.push({...overlap,instanceId:"concurrent-friday-pick"});revision+=1;
          return json({error:"Your weekly plan changed.",code:"PLAN_CHANGED",plan:savedPlan,planUpdatedAt:revision},409);
        }
        savedPlan=structuredClone(payload.plan);revision+=1;
      }
      return json({user:USER,csrfToken:CSRF,plan:savedPlan,planUpdatedAt:revision});
    }
    if(path.startsWith("/api/")){unexpected.push(`${request.method()} ${path}`);return json({error:"Unexpected fixture API"},404);}
    const file=staticAsset(path);
    if(!file){unexpected.push(path);await route.fulfill({status:404,body:"Missing fixture asset"});return;}
    await route.fulfill({path:file});
  });
  await page.goto("/discover.html#sessionBuilder",{waitUntil:"domcontentloaded"});
  await page.locator("#sessionBuilder").waitFor({state:"visible"});
  await page.waitForFunction(()=>!globalThis.document.querySelector("#sessionStatus")?.textContent?.startsWith("Loading"));
  if(historyAvailable)await page.waitForFunction(()=>globalThis.document.querySelector("#progressSessions")?.textContent!=="—"||globalThis.document.querySelector("#progressFirstWorkout")?.hidden===false);
  else await page.waitForFunction(()=>globalThis.document.querySelector("#todayPreviousValue")?.textContent==="History unavailable");
  return{page,writes,errors,unexpected,savedPlan:()=>structuredClone(savedPlan)};
}
async function selectedIds(page){return page.locator("#sessionResults .session-result-card [data-open-detail]").evaluateAll((nodes)=>nodes.map((node)=>node.getAttribute("data-open-detail")));}
async function generate(page){
  await page.locator("#sessionGenerate").click();
  await page.locator("#sessionResults .session-result-card").first().waitFor({state:"visible"});
  const ids=await selectedIds(page);assert.ok(ids.length>0,"A generated session must contain catalog movements");
  assert.equal(new Set(ids).size,ids.length,"A session must not repeat a movement");
  assert.ok(ids.every((id)=>EXERCISES.has(id)),"Every pick must resolve to the catalog");return ids;
}
function healthy(fixture){assert.deepEqual(fixture.errors,[]);assert.deepEqual(fixture.unexpected,[]);}

test("session choices honor muscle targets, invalidate stale previews, and save only after Add",{timeout:30_000},async(t)=>{
  const f=await fixture(t),{page,writes}=f,original=f.savedPlan();
  const choices=await page.locator("#sessionSelectionMode option").evaluateAll((nodes)=>nodes.map((node)=>({value:node.value,label:node.textContent.trim()})));
  assert.deepEqual(choices,MODES);assert.equal(await page.locator("#sessionSelectionMode").inputValue(),"random");assert.equal(await page.locator("#sessionAddAll").isHidden(),true);
  await page.selectOption("#sessionLength","20");await page.selectOption("#sessionMuscleGroup","chest");await page.selectOption("#sessionMuscleTarget","Upper chest");
  const combinations=new Set();
  for(let build=0;build<4;build+=1)combinations.add((await generate(page)).slice().sort().join(","));
  assert.ok(combinations.size>1,"Repeated random builds must draw fresh movement choices");
  for(const {value} of MODES){
    await page.selectOption("#sessionSelectionMode",value);
    const ids=await generate(page);assert.ok(ids.every((id)=>EXERCISES.get(id).group==="chest"&&EXERCISES.get(id).sub==="Upper chest"),`${value} must respect both explicit muscle choices`);
    if(value==="not-in-week")assert.ok(!ids.includes("incline-smith-press"),"Not in my week must exclude a planned movement even on another day");
    assert.ok((await page.locator("#sessionSelectionHelp").textContent()).trim(),"Each selection method needs a visible explanation");
  }
  assert.equal(writes.length,0,"Changing methods and generating previews must not save Plan");assert.deepEqual(f.savedPlan(),original);assert.equal(await page.locator("#sessionOpenPlan").isHidden(),true,"Open weekly plan must remain hidden until the session has been saved");
  for(const [selector,value] of [["#sessionLength","35"],["#sessionSelectionMode","random"],["#sessionMuscleTarget","all"],["#sessionMuscleGroup","back"],["#sessionGroup","lower"]]){
    await page.selectOption(selector,value);assert.equal(await page.locator("#sessionAddAll").isHidden(),true,`${selector} must invalidate the approved preview`);assert.equal((await selectedIds(page)).length,0,"Stale movement cards must be removed");await generate(page);
  }
  const groups=await page.locator("#sessionMuscleGroup option").evaluateAll((nodes)=>nodes.map((node)=>node.value));
  assert.equal(await page.locator("#sessionMuscleGroup").inputValue(),"all","An incompatible explicit muscle resets when training focus changes");assert.ok(!groups.includes("back")&&!groups.includes("chest"),"Lower-body focus must not offer upper-body muscle groups");
  await page.selectOption("#sessionGroup","full");await page.selectOption("#sessionSelectionMode","not-in-week");await page.selectOption("#sessionDay","Monday");
  const ids=await generate(page);const existingIds=new Set(Object.values(original.days).flat().map((entry)=>entry.exerciseId));assert.ok(ids.every((id)=>!existingIds.has(id)));assert.equal(writes.length,0);
  const response=page.waitForResponse((item)=>new URL(item.url()).pathname==="/api/plan"&&item.request().method()==="PUT");await page.locator("#sessionAddAll").click();assert.equal((await response).status(),200);
  await page.waitForFunction(()=>globalThis.document.querySelector("#sessionStatus")?.textContent?.startsWith("Saved."));
  assert.equal(writes.length,1);assert.equal(writes[0].csrf,CSRF);assert.equal(writes[0].payload.expectedPlanUpdatedAt,1730000000000);
  const saved=f.savedPlan();assert.deepEqual(saved.days.Monday.slice(0,original.days.Monday.length),original.days.Monday,"Add must preserve existing exercises and prescriptions on the selected day");
  assert.deepEqual(new Set(saved.days.Monday.slice(original.days.Monday.length).map((entry)=>entry.exerciseId)),new Set(ids));
  for(const day of DAYS.filter((day)=>day!=="Monday"))assert.deepEqual(saved.days[day],original.days[day],`${day} must remain unchanged`);
  assert.deepEqual(saved.restDays,original.restDays);assert.equal(await page.locator("#sessionOpenPlan").isVisible(),true);
  await page.selectOption("#sessionDay","Tuesday");assert.equal(await page.locator("#sessionAddAll").isDisabled(),true,"A saved Not in my week session cannot be added again on a different day");assert.equal(writes.length,1);healthy(f);
});

test("a concurrent weekly-plan edit blocks stale Not in my week picks until rebuilt",{timeout:20_000},async(t)=>{
  const f=await fixture(t,{conflictOnSave:true}),{page}=f;await page.selectOption("#sessionSelectionMode","not-in-week");await page.selectOption("#sessionDay","Monday");
  await generate(page);const response=page.waitForResponse((item)=>new URL(item.url()).pathname==="/api/plan"&&item.request().method()==="PUT");await page.locator("#sessionAddAll").click();assert.equal((await response).status(),409);
  await page.waitForFunction(()=>globalThis.document.querySelector("#sessionStatus")?.textContent?.includes("latest plan"));
  const concurrent=f.savedPlan(),newId=concurrent.days.Friday[0].exerciseId;
  assert.equal(await page.locator("#sessionAddAll").isDisabled(),true,"A conflicting weekly-plan reload must recheck strict exclusion before a retry");
  await page.selectOption("#sessionDay","Tuesday");assert.equal(await page.locator("#sessionAddAll").isDisabled(),true,"Switching the destination must not bypass current-week exclusion");assert.equal(f.writes.length,1);
  const refreshed=await generate(page);assert.ok(!refreshed.includes(newId),"A rebuilt session must exclude the newly planned exercise");assert.equal(await page.locator("#sessionAddAll").isDisabled(),false);assert.deepEqual(f.savedPlan(),concurrent);healthy(f);
});

test("Needs focus uses recent completed sets and My preferences respects the member's rating",{timeout:20_000},async(t)=>{
  const f=await fixture(t,{ratings:[{exercise_id:"archer-pushup",overall:5,enjoyment:5}]}),{page}=f;
  await page.selectOption("#sessionLength","20");await page.selectOption("#sessionMuscleGroup","chest");await page.selectOption("#sessionSelectionMode","needs-focus");
  const focusIds=await generate(page);assert.equal(EXERCISES.get(focusIds[0]).sub,"Mid / lower chest","Active sessions, zero-set summaries, and history older than 28 days must not count as recent focus");
  assert.match(await page.locator("#sessionResults").textContent(),/28|recent/i,"The result must disclose the history window");
  await page.selectOption("#sessionSelectionMode","preferences");const preferenceIds=await generate(page);assert.equal(preferenceIds[0],"archer-pushup","A member's explicit positive rating must affect selection even for a lower FitScore movement");
  assert.match(await page.locator("#sessionResults").textContent(),/rat(?:ed|ing)|5\s*\/\s*5/i,"The result must explain the preference signal");assert.equal(f.writes.length,0);healthy(f);
});

test("history fallbacks are explicit and week exclusion never fills a depleted pool with repeats",{timeout:30_000},async(t)=>{
  for(const historyAvailable of [true,false])await t.test(historyAvailable?"no completed history":"history unavailable",async(subtest)=>{
    const f=await fixture(subtest,{workouts:[],historyAvailable}),{page}=f;
    await page.selectOption("#sessionSelectionMode","needs-focus");await generate(page);
    const copy=`${await page.locator("#sessionSelectionHelp").textContent()} ${await page.locator("#sessionResults").textContent()} ${await page.locator("#sessionStatus").textContent()}`;
    assert.match(copy,historyAvailable?/no (?:recent |completed |logged )*(?:workout|session|histor|set)|not enough|no relevant/i:/unavailable|could not|couldn't/i,"The fallback must distinguish missing logs from failed history loading");
    assert.doesNotMatch(copy,/you (?:have )?neglected|you (?:have not|haven't|never) trained/i,"Missing evidence must not be described as a known training deficit");assert.equal(f.writes.length,0);healthy(f);
  });
  await t.test("all target exercises are already planned",async(subtest)=>{
    const plan=fixtureWeek(),upper=CATALOG.filter((exercise)=>exercise.group==="chest"&&exercise.sub==="Upper chest");
    plan.days.Tuesday=upper.map((exercise,index)=>({instanceId:`depleted-target-${index}`,exerciseId:exercise.id,sets:3,reps:"8–12"}));
    const f=await fixture(subtest,{plan}),{page}=f;await page.selectOption("#sessionMuscleGroup","chest");await page.selectOption("#sessionMuscleTarget","Upper chest");await page.selectOption("#sessionSelectionMode","not-in-week");await page.locator("#sessionGenerate").click();
    assert.equal((await selectedIds(page)).length,0,"A depleted pool must not silently repeat planned exercises");assert.equal(await page.locator("#sessionAddAll").isHidden(),true);assert.match(await page.locator("#sessionStatus").textContent(),/week|planned|scheduled/i);assert.equal(f.writes.length,0);assert.deepEqual(f.savedPlan(),plan);healthy(f);
  });
});

test("session brief and result controls stay readable with touch targets at 320, 390, and 1440 pixels",{timeout:20_000},async(t)=>{
  const f=await fixture(t),{page}=f;await page.selectOption("#sessionSelectionMode","preferences");await page.selectOption("#sessionMuscleGroup","chest");await page.selectOption("#sessionMuscleTarget","Mid / lower chest");await generate(page);
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(()=>({overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth,controls:[...globalThis.document.querySelectorAll("#sessionBuilderForm select,#sessionBuilderForm button,#sessionResults button,#sessionAddAll")].filter((node)=>node.getClientRects().length).map((node)=>{const box=node.getBoundingClientRect();return{id:node.id||node.textContent.trim(),left:box.left,right:box.right,width:box.width,height:box.height};})}));
    assert.ok(layout.overflow<=1,`Session builder overflows ${width}px by ${layout.overflow}px`);
    for(const control of layout.controls){assert.ok(control.width>=44&&control.height>=44,`${control.id} must retain a 44px touch target at ${width}px`);assert.ok(control.left>=-.5&&control.right<=width+.5,`${control.id} must stay in the viewport at ${width}px`);}
    if(process.env.STRATA_SESSION_SCREENSHOT_DIR){const output=resolve(process.env.STRATA_SESSION_SCREENSHOT_DIR);mkdirSync(output,{recursive:true});await page.evaluate(()=>{globalThis.document.activeElement?.blur();globalThis.scrollTo(0,0);});await page.screenshot({path:join(output,`session-selection-${width}.png`),fullPage:true});}
  }
  assert.equal(f.writes.length,0);healthy(f);
});

test.before(async()=>{const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);});
test.after(()=>browser?.close());
