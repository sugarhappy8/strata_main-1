"use strict";

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {mkdirSync,mkdtempSync,readFileSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const test=require("node:test");
const {chromium}=require("playwright");
const {grantStrataPlus}=require("../../test/support/strata-plus-access");
const {sanitizeWorkout,summarizeWorkout}=require("../../src/workouts");

const ROOT=join(__dirname,"..","..");
const WAIT_MS=12_000;
const CATALOG=JSON.parse(readFileSync(join(ROOT,"public/data/exercises.json"),"utf8"));
const EXERCISE=CATALOG.find(item=>item.equipment==="Barbell / Smith"&&!/seconds|sec|min/i.test(item.reps));
const OTHER_EXERCISE=CATALOG.find(item=>item.id!==EXERCISE.id&&item.equipment!=="Bodyweight"&&!/seconds|sec|min/i.test(item.reps));
const CAPTURE_DIR=process.env.STRATA_PROGRESSION_SCREENSHOTS||(process.platform==="darwin"?"/private/tmp/strata-782-progression-qa":join(tmpdir(),"strata-782-progression-qa"));
const DAY_MS=86_400_000;
let app,browser,baseUrl,runtimeDir,logs="",contextNumber=0;
const pageErrors=[];

async function unusedPort(){
  const server=http.createServer();
  await new Promise((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});
  const port=server.address().port;
  await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;
}
async function startApp(){
  const port=await unusedPort();baseUrl=`http://127.0.0.1:${port}`;runtimeDir=mkdtempSync(join(tmpdir(),"strata-progression-e2e-"));
  app=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{HOST:"127.0.0.1",PORT:String(port),NODE_ENV:"test",TZ:"UTC",TRUST_PROXY:"true",SECURE_COOKIES:"false",ADMIN_EMAIL:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",APP_BASE_URL:baseUrl},stdio:["ignore","pipe","pipe"]});
  for(const stream of [app.stdout,app.stderr])stream.on("data",chunk=>{logs=(logs+chunk.toString()).slice(-16_384);});
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(app.exitCode!==null)throw new Error(`Progression E2E server exited.\n${logs}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise(done=>setTimeout(done,50));
  }
  throw new Error(`Progression E2E server did not become healthy.\n${logs}`);
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
async function read(context,path){
  const response=await context.request.get(path);assert.equal(response.status(),200,await response.text());return response.json();
}
async function newMember(label,{sets=3}={}){
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",viewport:{width:390,height:844},reducedMotion:"reduce",extraHTTPHeaders:{"X-Forwarded-For":`198.51.100.${++contextNumber}`}});
  context.setDefaultTimeout(WAIT_MS);await context.route(/^https:\/\//,route=>route.abort());
  const page=await context.newPage();page.on("pageerror",error=>pageErrors.push(`${page.url()}: ${error.message}`));
  const signup=await context.request.post("/api/signup",{headers:{Origin:baseUrl},data:{name:`Progression ${label}`,email:`progression-${label}@example.test`,password:"synthetic-progression-e2e-123"}});
  assert.equal(signup.status(),201,await signup.text());const user=(await signup.json()).user;
  const initial=await read(context,"/api/plan"),headers={Origin:baseUrl,"X-CSRF-Token":initial.csrfToken,"X-Strata-User":user.id};
  grantStrataPlus(runtimeDir,user.id);
  const plan={version:1,restDay:"Sunday",days:Object.fromEntries(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map(day=>[day,["Monday","Wednesday"].includes(day)?[{instanceId:`progression-${day.toLowerCase()}`,exerciseId:EXERCISE.id,sets,reps:"8–12"}]:[]]))};
  const saved=await context.request.put("/api/plan",{headers,data:{plan,expectedPlanUpdatedAt:initial.planUpdatedAt,expectedUserId:user.id}});
  assert.equal(saved.status(),200,await saved.text());return{context,page,user,headers};
}
function completedFixture(id,daysAgo,{exerciseId=EXERCISE.id,reps=[12,12,12],weight=40,offset=0}={}){
  const startedAt=Date.now()-daysAgo*DAY_MS+offset;
  return sanitizeWorkout({id,title:`Logged ${id}`,planDay:"Monday",date:new Date(startedAt).toISOString().slice(0,10),status:"completed",startedAt,completedAt:startedAt+600_000,elapsedSeconds:600,restEndsAt:null,entries:[{id:`${id}-entry`,exerciseId,planInstanceId:"progression-monday",measurement:"reps",loadType:"external",unit:"kg",prescribedReps:"8–12",note:"",effortType:"none",supersetGroup:"",replacedFromExerciseId:"",sets:reps.map(value=>({reps:value,weight,seconds:null,completed:true,effort:null}))}]});
}
async function saveFixture(member,workout){
  const response=await member.context.request.post("/api/workouts",{headers:member.headers,data:{workout}});
  assert.equal(response.status(),201,await response.text());return(await response.json()).workout;
}
function seedUnrelatedHistory(member,count=105){
  // Only this isolated test database is written directly, avoiding API rate limits
  // while retaining the same validated workout/summary format as real writes.
  const database=new DatabaseSync(join(runtimeDir,"strata.sqlite"),{timeout:5000,enableForeignKeyConstraints:true});
  try{
    const insert=database.prepare("INSERT INTO workouts (user_id,id,workout_json,summary_json,create_hash,started_at,revision,updated_at) VALUES (?,?,?,?,?,?,1,?)");
    database.exec("BEGIN");
    for(let index=0;index<count;index+=1){
      const workout=completedFixture(`unrelated-${index}`,5,{exerciseId:OTHER_EXERCISE.id,reps:[8],weight:20,offset:index*1000}),serialized=JSON.stringify(workout);
      insert.run(member.user.id,workout.id,serialized,JSON.stringify(summarizeWorkout(workout)),createHash("sha256").update(serialized).digest("hex"),workout.startedAt,workout.completedAt);
    }
    database.exec("COMMIT");
  }finally{database.close();}
}
async function startWednesday(member){
  const {page}=member;await page.goto("/workout.html?day=Wednesday",{waitUntil:"domcontentloaded"});await page.locator("#startWorkout").waitFor({state:"visible"});
  const creating=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/workouts"&&response.request().method()==="POST");
  await page.click("#startWorkout");const response=await creating;assert.equal(response.status(),201,await response.text());
  await page.locator("#sessionPanel").waitFor({state:"visible"});await synced(page);return(await response.json()).workout;
}
async function synced(page){await page.waitForFunction(()=>globalThis.document.querySelector("#saveStatus")?.textContent==="Synced");}
function entry(page){return page.locator("#sessionEntries [data-entry]").first();}
async function logAndFinish(member,{sets=3,reps=12,weight=40}={}){
  const {page}=member;
  for(let index=0;index<sets;index+=1){
    const row=entry(page).locator(`[data-set="${index}"]`);
    await row.locator('[data-actual="weight"]').fill(String(weight));await row.locator('[data-actual="reps"]').fill(String(reps));await row.locator("[data-complete]").click();
  }
  await synced(page);await page.click("#finishWorkout");await page.locator("#finishDialog").waitFor({state:"visible"});await page.click('#finishDialog button[value="finish"]');
  await page.locator("#celebration").waitFor({state:"visible"});await page.locator("#progressionPanel").waitFor({state:"visible"});
}
// The panel shows a placeholder while the page's own progression request is in flight; read it only after that request settles.
async function progressionText(page){
  await page.waitForFunction(()=>{const text=globalThis.document.querySelector("#progressionPanel")?.textContent||"";return Boolean(text)&&!text.includes("Checking completed sets");});
  return page.locator("#progressionPanel").textContent();
}
async function captureAndCheckLayout(page,width,label){
  await page.setViewportSize({width,height:width>=1000?1000:844});
  const target=entry(page).locator(".memory-target");await target.waitFor({state:"visible"});await target.scrollIntoViewIfNeeded();
  const layout=await page.evaluate(()=>{
    const card=globalThis.document.querySelector("#sessionEntries [data-entry]"),target=card.querySelector(".memory-target"),table=card.querySelector(".sets-scroll");
    return{overflow:globalThis.document.documentElement.scrollWidth-globalThis.document.documentElement.clientWidth,targetBottom:target.getBoundingClientRect().bottom,tableTop:table.getBoundingClientRect().top,buttons:[...target.querySelectorAll("button")].filter(node=>node.getClientRects().length).map(node=>node.getBoundingClientRect().height)};
  });
  assert.ok(layout.overflow<=1,`${width}px training view overflows by ${layout.overflow}px`);
  assert.ok(layout.targetBottom<=layout.tableTop+1,"Next-load guidance must appear before the set logger without opening More options");
  assert.ok(layout.buttons.length>0&&layout.buttons.every(height=>height>=44),`${width}px progression buttons need 44px touch targets: ${layout.buttons.join(", ")}`);
  mkdirSync(CAPTURE_DIR,{recursive:true});await page.screenshot({path:join(CAPTURE_DIR,`${label}-${width}.png`),fullPage:true});
  await target.evaluate(node=>node.scrollIntoView({block:"center"}));
  await target.screenshot({path:join(CAPTURE_DIR,`${label}-card-${width}.png`)});
}

test("Train carries earned weight progression into the next session",{timeout:180_000},async t=>{
  await t.test("history older than 100 sessions yields exact targets; explicit apply persists only the active workout",async()=>{
    const member=await newMember("earned"),{context,page}=member;
    const first=await saveFixture(member,completedFixture("earned-first",14)),second=await saveFixture(member,completedFixture("earned-second",7));
    seedUnrelatedHistory(member);const beforePlan=await read(context,"/api/plan");
    const progressionReads=[];page.on("request",request=>{if(/\/api\/workouts\/[^/]+\/progression$/.test(new URL(request.url()).pathname))progressionReads.push(request.url());});
    const active=await startWednesday(member);
    await page.waitForFunction(()=>globalThis.document.querySelector("#sessionEntries [data-entry] .memory-target")?.textContent?.includes("42.5"));
    assert.ok(progressionReads.some(url=>url.endsWith(`/api/workouts/${second.id}/progression`)),"The next-load card must read authoritative guidance for its actual source workout");
    const proposal=await read(context,`/api/workouts/${second.id}/progression`),suggestion=proposal.progression.suggestions.find(item=>item.exerciseId===EXERCISE.id);
    assert.equal(suggestion.action,"increase_load");assert.equal(suggestion.target.weight,42.5);assert.equal(suggestion.target.reps,8);
    assert.equal(suggestion.targetSets.length,3);assert.ok(suggestion.targetSets.every(set=>set.weight===42.5&&set.reps===8));
    assert.match(await entry(page).locator(".memory-target").textContent(),/42\.5\s*kg/);
    assert.match(await entry(page).locator(".memory-previous").textContent(),/40\s*kg/);
    assert.doesNotMatch(await entry(page).locator(".memory-previous").textContent(),/42\.5/);
    assert.equal(await entry(page).locator('[data-set="0"] [data-actual="weight"]').inputValue(),"","Reading a suggestion must not prefill actual performance");
    const writes=[];page.on("request",request=>{if(new URL(request.url()).pathname===`/api/workouts/${active.id}`&&request.method()==="PUT")writes.push(request);});
    for(const width of [1440,390,320])await captureAndCheckLayout(page,width,"next-weight");
    assert.equal(writes.length,0,"Inspecting progression across viewports must not write workout values");
    await page.setViewportSize({width:390,height:844});
    const saving=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${active.id}`&&response.request().method()==="PUT");
    await entry(page).locator("[data-apply-target]").click();const saved=await saving;assert.equal(saved.status(),200,await saved.text());await synced(page);
    for(let index=0;index<3;index+=1){
      const row=entry(page).locator(`[data-set="${index}"]`);
      assert.equal(await row.locator('[data-actual="weight"]').inputValue(),"42.5");assert.equal(await row.locator('[data-actual="reps"]').inputValue(),"8");assert.equal(await row.locator("[data-complete]").getAttribute("aria-pressed"),"false");
    }
    const stored=(await read(context,`/api/workouts/${active.id}`)).workout;
    assert.ok(stored.entries[0].sets.every(set=>set.weight===42.5&&set.reps===8&&!set.completed));
    assert.deepEqual((await read(context,`/api/workouts/${first.id}`)).workout,first,"Applying a target must not change the older source workout");
    assert.deepEqual((await read(context,`/api/workouts/${second.id}`)).workout,second,"Applying a target must not rewrite the latest recorded performance");
    assert.deepEqual((await read(context,"/api/plan")).plan,beforePlan.plan,"Applying a weight target must not rewrite the weekly planner");
    await logAndFinish(member);
    const completed=await read(context,`/api/workouts/${active.id}/progression`);
    assert.equal(completed.checkIn,null);assert.equal(completed.progression.suggestions[0].action,"increase_load");
    assert.match(await progressionText(page),/42\.5\s*kg/);
    assert.equal(await page.locator("#checkInDifficulty").inputValue(),"","Next-session guidance must be visible before the optional check-in");
    await page.screenshot({path:join(CAPTURE_DIR,"after-workout-390.png"),fullPage:true});
    await page.locator("#progressionPanel").evaluate(node=>node.scrollIntoView({block:"center"}));
    await page.locator("#progressionPanel").screenshot({path:join(CAPTURE_DIR,"after-workout-card-390.png")});
    await page.selectOption("#checkInDifficulty","5");await page.selectOption("#checkInEnergy","2");await page.selectOption("#checkInComfort","4");await page.selectOption("#checkInEnjoyment","3");
    const checking=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${active.id}/check-in`&&response.request().method()==="POST");
    await page.click("#saveCheckIn");const check=await checking;assert.equal(check.status(),200,await check.text());
    const checked=await check.json();assert.equal(checked.progression.suggestions[0].action,"repeat");assert.equal(checked.progression.suggestions[0].target.weight,40);
    await page.waitForFunction(()=>globalThis.document.querySelector("#progressionPanel")?.textContent?.includes("Repeat"));
    assert.doesNotMatch(await page.locator("#progressionPanel").textContent(),/42\.5\s*kg/);
    assert.deepEqual((await read(context,"/api/plan")).plan,beforePlan.plan,"An adverse check-in can suggest a change but cannot apply it");
    await context.close();
  });
  await t.test("a first completed session gives a repeat baseline without demanding a check-in",async()=>{
    const member=await newMember("baseline"),{context,page}=member,active=await startWednesday(member);
    await page.waitForFunction(()=>globalThis.document.querySelector("#sessionEntries [data-entry] .memory-previous")?.textContent?.includes("No previous"));
    assert.doesNotMatch(await entry(page).locator(".memory-target").textContent(),/42\.5/);
    await logAndFinish(member);
    const result=await read(context,`/api/workouts/${active.id}/progression`),suggestion=result.progression.suggestions[0];
    assert.equal(result.checkIn,null);assert.equal(suggestion.action,"repeat");assert.equal(suggestion.target.weight,40);
    const baselinePanel=await progressionText(page);assert.match(baselinePanel,/40\s*kg/);assert.doesNotMatch(baselinePanel,/42\.5/);
    await context.close();
  });
  await t.test("an unfinished three-set prescription cannot earn a heavier target",async()=>{
    const member=await newMember("unfinished"),{context,page}=member;
    await saveFixture(member,completedFixture("unfinished-prior",7));const active=await startWednesday(member);
    await logAndFinish(member,{sets:1});
    const result=await read(context,`/api/workouts/${active.id}/progression`),suggestion=result.progression.suggestions[0];
    assert.equal(suggestion.action,"repeat");assert.doesNotMatch(await page.locator("#progressionPanel").textContent(),/42\.5/);
    await context.close();
  });
  await t.test("a source with a different set prescription cannot apply an earned three-set target",async()=>{
    const member=await newMember("different-prescription",{sets:2}),{context,page}=member;
    await saveFixture(member,completedFixture("different-first",14));const second=await saveFixture(member,completedFixture("different-second",7));
    assert.equal((await read(context,`/api/workouts/${second.id}/progression`)).progression.suggestions[0].action,"increase_load");
    const active=await startWednesday(member);
    await page.waitForFunction(()=>globalThis.document.querySelector("#sessionEntries [data-entry] .memory-previous")?.textContent?.includes("40 kg"));
    // Await the source fetch rather than allowing a transient loading state to
    // satisfy the disabled-application assertion.
    await page.waitForFunction(()=>{const target=globalThis.document.querySelector("#sessionEntries [data-entry] .memory-target");return target&&!/checking|loading|after the saved-history/i.test(target.textContent);});
    assert.doesNotMatch(await entry(page).locator(".memory-target").textContent(),/42\.5/);
    assert.equal(await entry(page).locator('[data-set="0"] [data-actual="weight"]').inputValue(),"");
    assert.equal((await read(context,`/api/workouts/${active.id}`)).workout.entries[0].sets.length,2,"Incompatible history must preserve today's set count");
    await context.close();
  });
  await t.test("late target guidance preserves live inputs, focused notes and open options",async()=>{
    const member=await newMember("late-guidance"),{context,page}=member;
    await saveFixture(member,completedFixture("late-first",14));const source=await saveFixture(member,completedFixture("late-second",7));
    let releaseSource,sourceRequested;
    const release=new Promise(done=>{releaseSource=done;}),requested=new Promise(done=>{sourceRequested=done;});
    await page.route(`**/api/workouts/${source.id}/progression`,async route=>{sourceRequested();await release;await route.continue();});
    try{
      const active=await startWednesday(member);await requested;
      assert.match(await entry(page).locator(".memory-target").textContent(),/checking/i);
      const options=entry(page).locator(".exercise-more");await options.locator(":scope > summary").click();
      const load=entry(page).locator('[data-set="0"] [data-actual="weight"]'),reps=entry(page).locator('[data-set="0"] [data-actual="reps"]'),note=entry(page).locator("[data-entry-note]");
      await load.fill("37.5");await reps.fill("11");await note.fill("Bench notch 3; keep elbows under wrists.");
      const loadNode=await load.elementHandle(),repsNode=await reps.elementHandle(),noteNode=await note.elementHandle(),optionsNode=await options.elementHandle();
      await note.evaluate(node=>{node.focus();node.setSelectionRange(6,13);});
      const hydration=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${source.id}/progression`);
      releaseSource();assert.equal((await hydration).status(),200);
      await page.waitForFunction(()=>globalThis.document.querySelector("#sessionEntries [data-entry] .memory-target")?.textContent?.includes("42.5"));
      assert.equal(await loadNode.evaluate(node=>node.isConnected&&node===globalThis.document.querySelector('#sessionEntries [data-entry] [data-set="0"] [data-actual="weight"]')),true,"Guidance hydration must preserve the existing load input node");
      assert.equal(await repsNode.evaluate(node=>node.isConnected&&node===globalThis.document.querySelector('#sessionEntries [data-entry] [data-set="0"] [data-actual="reps"]')),true,"Guidance hydration must preserve the existing rep input node");
      assert.equal(await optionsNode.evaluate(node=>node.isConnected&&node.open),true,"Guidance hydration must not collapse More options");
      assert.deepEqual(await noteNode.evaluate(node=>({connected:node.isConnected,focused:node===globalThis.document.activeElement,value:node.value,start:node.selectionStart,end:node.selectionEnd})),{connected:true,focused:true,value:"Bench notch 3; keep elbows under wrists.",start:6,end:13},"Guidance hydration must preserve focus, entered notes and cursor selection");
      assert.equal(await load.inputValue(),"37.5");assert.equal(await reps.inputValue(),"11");
      assert.equal(await entry(page).locator("[data-apply-target]").isDisabled(),true,"A late suggestion cannot overwrite values the member already entered");
      await synced(page);const saved=(await read(context,`/api/workouts/${active.id}`)).workout;
      assert.equal(saved.entries[0].sets[0].weight,37.5);assert.equal(saved.entries[0].sets[0].reps,11);assert.equal(saved.entries[0].note,"Bench notch 3; keep elbows under wrists.");
    }finally{releaseSource();await context.close();}
  });
  await t.test("unchecked draft values from a completed source can never become an apply target",async()=>{
    const member=await newMember("unchecked-drafts"),{context,page}=member;
    await saveFixture(member,completedFixture("draft-prior",14));
    const fixture=completedFixture("draft-source",7);fixture.entries[0].sets[2]={reps:999,weight:1000,seconds:null,completed:false,effort:null};
    const source=await saveFixture(member,fixture);
    const hydration=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workouts/${source.id}/progression`);
    const active=await startWednesday(member),response=await hydration;assert.equal(response.status(),200);
    const guidance=await response.json(),suggestion=guidance.progression.suggestions[0];
    assert.equal(suggestion.action,"repeat");assert.equal(suggestion.targetSets[2].weight,null);assert.equal(suggestion.targetSets[2].reps,null);
    await page.waitForFunction(()=>/incomplete|manually/i.test(globalThis.document.querySelector("#sessionEntries [data-entry] .memory-target")?.textContent||""));
    assert.doesNotMatch(await entry(page).locator(".memory-target").textContent(),/999|1,?000/);
    assert.equal(await entry(page).locator("[data-apply-target]:enabled").count(),0,"Incomplete source evidence must not expose an applicable target");
    const stored=(await read(context,`/api/workouts/${active.id}`)).workout;
    assert.ok(stored.entries[0].sets.every(set=>set.weight===null&&set.reps===null&&!set.completed));
    assert.deepEqual((await read(context,`/api/workouts/${source.id}`)).workout,source,"Ignoring an unchecked draft must not mutate historical records");
    await context.close();
  });
  assert.deepEqual(pageErrors,[],`Unexpected browser errors:\n${pageErrors.join("\n")}`);
});

test.before(async()=>{
  try{await startApp();const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);}
  catch(error){await cleanup();throw error;}
});
test.after(cleanup);
