"use strict";
/* global document */

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdtempSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve}=require("node:path");
const test=require("node:test");
const {AxeBuilder}=require("@axe-core/playwright");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..","..");
const WAIT_MS=15_000;
const PASSWORD="strata-ai-browser-password-123";
const SCREENSHOTS=process.env.STRATA_AI_SCREENSHOTS||"";
let app,model,browser,baseUrl,runtimeDir,serverLogs="",breakNext=0;

async function unusedPort(){
  const probe=http.createServer();
  await new Promise((done,reject)=>{probe.once("error",reject);probe.listen(0,"127.0.0.1",done);});
  const port=probe.address().port;
  await new Promise((done,reject)=>probe.close((error)=>error?reject(error):done()));
  return port;
}

// A scripted OpenAI-compatible model: it answers from the prompt STRATA sends, using real shortlist codes.
function modelReply(messages){
  const system=messages[0]?.content||"",question=messages.at(-1)?.content||"";
  const code=(prefix,index=1)=>system.match(new RegExp(`^(${prefix}\\d+) `,"gm"))?.[index-1]?.trim()||`${prefix}1`;
  if(breakNext>0){breakNext-=1;return "Sorry, I can't format that.";}
  if(/suggestions/.test(question)){
    const saved=/Monday: ([^,\d]+?) \d+x/.exec(system)?.[1]?.trim()||"Unknown";
    return JSON.stringify({reply:"Your week is balanced. Two small changes would help.",week:null,nutrition:null,search:[],suggestions:[{text:"Add a set to your first exercise once it feels easy.",swap:{day:"Monday",from:saved,to:code("CH",3)}},{text:"Keep one full rest day between hard leg sessions."}]});
  }
  if(/calorie|calories/i.test(question))return JSON.stringify({reply:"Here are gentle fat-loss targets that match your training days.",week:null,search:[],suggestions:[],nutrition:{goal:"fat_loss",pace:"gentle",pattern:"zigzag",flexibleDay:null,macros:"higher_protein"}});
  const day=(name,day,codes)=>({day,name,exercises:codes.map((entry)=>({code:entry,sets:3,reps:"8-12"}))});
  return JSON.stringify({reply:"Here is a three-day full-body week. Want matching calorie targets?",nutrition:null,search:[],suggestions:[],week:{title:"Three full-body days",focus:"balanced",sessionMinutes:45,days:[
    day("Full body A","Monday",[code("CH"),code("BK"),code("LG"),code("CR")]),day("Full body B","Wednesday",[code("SH"),code("GL"),code("BK",2),code("AR")]),day("Full body C","Friday",[code("CH",2),code("LG",2),code("CV"),code("AR",2)])
  ]}});
}

async function startModel(){
  const port=await unusedPort();
  model=http.createServer((req,res)=>{
    let body="";req.on("data",(chunk)=>{body+=chunk;});
    req.on("end",()=>{
      if(req.headers.authorization!=="Bearer e2e-key"){res.writeHead(401).end("{}");return;}
      if(req.url==="/v1/models"){res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({data:[{id:"e2e-model"}]}));return;}
      const content=modelReply(JSON.parse(body).messages||[]);
      setTimeout(()=>res.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({choices:[{message:{content}}]})),400);
    });
  });
  await new Promise((done)=>model.listen(port,"127.0.0.1",done));
  return `http://127.0.0.1:${port}/v1`;
}

async function startApp(){
  const modelBase=await startModel(),port=await unusedPort();baseUrl=`http://127.0.0.1:${port}`;runtimeDir=mkdtempSync(join(tmpdir(),"strata-ai-e2e-"));
  app=spawn(process.execPath,["server.js"],{
    cwd:ROOT,
    env:{...process.env,HOST:"127.0.0.1",PORT:String(port),NODE_ENV:"test",TZ:"UTC",TRUST_PROXY:"true",SECURE_COOKIES:"false",ADMIN_EMAIL:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",AI_BASE_URL:modelBase,AI_API_KEY:"e2e-key",AI_MODEL:"e2e-model",AI_TIMEOUT_MS:"10000"},
    stdio:["ignore","pipe","pipe"]
  });
  for(const stream of [app.stdout,app.stderr])stream.on("data",(chunk)=>{serverLogs=(serverLogs+chunk.toString()).slice(-16_384);});
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(app.exitCode!==null)throw new Error(`Strata AI E2E server exited during startup.\n${serverLogs}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise((done)=>setTimeout(done,50));
  }
  throw new Error(`Strata AI E2E server did not become healthy.\n${serverLogs}`);
}

async function cleanup(){
  try{await browser?.close();}
  finally{
    if(app&&app.exitCode===null)await new Promise((done)=>{app.once("exit",done);app.kill("SIGTERM");setTimeout(()=>{try{app.kill("SIGKILL");}catch{}done();},2_000);});
    await new Promise((done)=>model?model.close(done):done());
    if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});
  }
}

async function signup(context,label){
  const response=await context.request.post("/api/signup",{headers:{Origin:baseUrl},data:{name:`AI ${label}`,email:`ai-${label}@example.test`,password:PASSWORD}});
  assert.equal(response.status(),201,await response.text());
  return (await response.json()).user;
}
async function csrf(context){return (await (await context.request.get("/api/plan")).json()).csrfToken;}
async function activatePlus(context){
  const response=await context.request.post("/api/discovery/trial",{headers:{Origin:baseUrl,"X-CSRF-Token":await csrf(context)},data:{}});
  assert.ok([200,201].includes(response.status()),await response.text());
}
async function savedPlan(context){return (await (await context.request.get("/api/plan")).json()).plan;}
const trainingDays=(plan)=>Object.entries(plan.days).filter(([,items])=>items.length).map(([day])=>day);
async function lastAnswer(page,count){
  await page.locator("#aiConversation .ai-turn-assistant").nth(count-1).waitFor({state:"visible",timeout:WAIT_MS});
  return page.locator("#aiConversation .ai-turn-assistant").nth(count-1);
}
async function shot(page,name){if(SCREENSHOTS)await page.screenshot({path:join(SCREENSHOTS,`${name}.png`)});}
async function noOverflow(page,label){
  for(const width of [1280,768,390,320]){
    await page.setViewportSize({width,height:900});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
    assert.ok(overflow<=1,`${label} overflows ${width}px by ${overflow}px`);
    if(width===390){await page.evaluate(()=>globalThis.scrollTo(0,document.querySelector(".ai-turn-assistant")?.getBoundingClientRect().top+globalThis.scrollY-80||0));await shot(page,`${label}-390`);}
  }
  await page.setViewportSize({width:1280,height:900});
}

test("members without Strata+ are sent to pricing, and the homepage points each visitor to the right place",{timeout:60_000},async()=>{
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",viewport:{width:1280,height:900},extraHTTPHeaders:{"X-Forwarded-For":"198.51.100.61"}});
  context.setDefaultTimeout(WAIT_MS);
  const page=await context.newPage();
  try{
    await page.goto("/",{waitUntil:"domcontentloaded"});
    assert.equal(await page.locator("#aiOfferLink").getAttribute("href"),"/pricing?reason=ai");
    assert.match(await page.locator("#aiOfferTitle").textContent(),/Don’t feel like planning things yourself\? Ask Strata AI to do it for you\./);
    await page.locator("#strataAi").scrollIntoViewIfNeeded();await shot(page,"home-ai");
    await page.setViewportSize({width:390,height:844});await page.locator("#strataAi").scrollIntoViewIfNeeded();await shot(page,"home-ai-390");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=1,"the homepage call to action fits a phone");
    await page.setViewportSize({width:1280,height:900});
    await page.goto("/ai",{waitUntil:"domcontentloaded"});
    assert.match(new URL(page.url()).search,/mode=login&next=ai/,"signed-out visitors sign in first");
    await signup(context,"free");
    await page.goto("/ai",{waitUntil:"domcontentloaded"});
    assert.equal(new URL(page.url()).pathname,"/pricing");assert.equal(new URL(page.url()).searchParams.get("reason"),"ai");
    await page.waitForFunction(()=>/Strata AI is included with Strata\+/.test(document.querySelector("#purchaseStatus")?.textContent||""));
    await shot(page,"pricing-ai");
    await activatePlus(context);
    await page.goto("/",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.querySelector("#aiOfferLink")?.getAttribute("href")==="/ai");
    await page.goto("/pricing?reason=ai",{waitUntil:"domcontentloaded"});
    await page.locator("#openDiscovery").waitFor({state:"visible"});
    assert.equal(await page.locator("#openDiscovery").getAttribute("href"),"/ai");assert.match(await page.locator("#openDiscovery").textContent(),/Open Strata AI/);
  }finally{await context.close();}
});

test("a Strata+ member plans a week, adds nutrition, applies a suggestion, and picks up after a reload",{timeout:120_000},async()=>{
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",timezoneId:"UTC",viewport:{width:1280,height:900},extraHTTPHeaders:{"X-Forwarded-For":"198.51.100.62"}});
  context.setDefaultTimeout(WAIT_MS);
  const page=await context.newPage(),pageErrors=[];page.on("pageerror",(error)=>pageErrors.push(error.message));
  try{
    await page.emulateMedia({reducedMotion:"reduce"});
    await signup(context,"member");await activatePlus(context);
    await page.goto("/ai",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>document.querySelector("#aiStatus")?.dataset.tone==="online");
    assert.equal(await page.locator("#userName").textContent(),"AI member");
    assert.match(await page.locator("#aiStatusDetail").textContent(),/30 of 30 requests left today/);
    assert.equal(await page.locator("#aiStarters button").count(),4);
    await shot(page,"ai-empty");
    const empty=await new AxeBuilder({page}).include("main").analyze();
    assert.deepEqual(empty.violations.map(({id})=>id),[],`empty page accessibility: ${empty.violations.map(({id})=>id).join(", ")}`);

    // A starter sends immediately; the page waits in line, then shows the checked week.
    await page.locator("#aiStarters button").first().click();
    await page.locator("#aiConversation .ai-turn-pending").waitFor({state:"visible"});
    assert.equal(await page.locator("#aiSend").isDisabled(),true,"one request at a time");
    const week=await lastAnswer(page,1);
    assert.match(await week.locator(".ai-reply").textContent(),/three-day full-body week/);
    assert.equal(await week.locator(".ai-week-strip li.is-training").count(),3);assert.equal(await week.locator(".ai-day").count(),3);
    assert.match(await week.locator(".ai-card-meta").textContent(),/3 training days · about 35 min each · 36 working sets/);
    assert.equal(await page.locator("#aiConversation .ai-turn-user").first().textContent(),"Plan a 3-day full-body week for me.");
    await shot(page,"ai-week");
    const withWeek=await new AxeBuilder({page}).include("#aiConversation").analyze();
    assert.deepEqual(withWeek.violations.map(({id})=>id),[],`week proposal accessibility: ${withWeek.violations.map(({id})=>id).join(", ")}`);

    await week.getByRole("button",{name:"Apply to my plan"}).click();
    await week.locator(".ai-applied").waitFor({state:"visible"});
    assert.deepEqual(trainingDays(await savedPlan(context)),["Monday","Wednesday","Friday"]);

    // Nutrition needs the personal setup first, then comes from STRATA's calculator.
    assert.deepEqual(await week.locator(".ai-followup").allTextContents(),["Add matching calorie targets","Make sessions shorter"]);
    await week.getByRole("button",{name:"Add matching calorie targets"}).click();
    await page.locator("#aiConversation .ai-turn-user").nth(1).waitFor();
    assert.equal(await page.locator("#aiConversation .ai-followup").count(),0,"quick replies belong to the latest answer only");
    const setup=await lastAnswer(page,2);
    await setup.getByRole("link",{name:"Complete personal setup"}).waitFor({state:"visible"});
    const profile={version:4,measurementSystem:"metric",preferredLoadUnit:"kg",age:32,heightCm:175,weightKg:78,bodyFatPercent:null,sexForEquation:"female",goal:"maintenance",goalPace:"moderate",experience:"intermediate",dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",workoutDays:["Tuesday","Thursday"],sessionMinutes:60,usualExercises:[],availableEquipment:[],movementLimitations:[],caloriePattern:"steady",flexibleDay:null,macroPreference:null,timeZone:"UTC",mealPreferences:null};
    const created=await context.request.put("/api/coaching/profile",{headers:{Origin:baseUrl,"X-CSRF-Token":await csrf(context)},data:{profile,expectedRevision:0}});
    assert.equal(created.status(),200,await created.text());
    await page.fill("#aiMessage","Please set my calories now");await page.click("#aiSend");
    const nutrition=await lastAnswer(page,3);
    await nutrition.locator(".ai-nutrition h3").waitFor({state:"visible"});
    assert.match(await nutrition.locator(".ai-nutrition h3").textContent(),/kcal\/day average/);
    assert.match(await nutrition.locator(".ai-math").textContent(),/maintenance − \d[\d,]* deficit = /);
    assert.equal(await nutrition.locator(".ai-targets li").count(),7);assert.equal(await nutrition.locator(".ai-targets li.is-training").count(),3);
    assert.match(await nutrition.locator(".ai-nutrition").textContent(),/will change to Mon, Wed and Fri with 30-minute sessions, so the targets match your saved plan/);
    await shot(page,"ai-nutrition");
    await nutrition.getByRole("button",{name:"Apply nutrition targets"}).click();
    await nutrition.locator(".ai-applied").waitFor({state:"visible"});
    const saved=await (await context.request.get("/api/coaching/profile")).json();
    assert.equal(saved.profile.goal,"fat_loss");assert.equal(saved.profile.caloriePattern,"zigzag");assert.deepEqual(saved.profile.workoutDays,["Monday","Wednesday","Friday"]);

    // Suggestions can swap one exercise in the saved plan.
    await page.click("#aiSuggest");
    const tips=await lastAnswer(page,4);
    const swap=tips.locator(".ai-swap").first();await swap.waitFor({state:"visible"});
    const before=(await savedPlan(context)).days.Monday.map((item)=>item.exerciseId);
    await swap.getByRole("button",{name:"Apply swap"}).click();
    await swap.locator(".ai-applied").waitFor({state:"visible"});
    const after=(await savedPlan(context)).days.Monday.map((item)=>item.exerciseId);
    assert.notDeepEqual(after,before);assert.equal(after.length,before.length);assert.deepEqual(after.slice(1),before.slice(1),"only the suggested exercise changes");

    // Applying another week over a saved plan asks first, and keeping the plan changes nothing.
    await week.getByRole("button",{name:"Ask for changes"}).count().then((count)=>assert.equal(count,0,"an applied week offers no second apply"));
    await page.fill("#aiMessage","Plan a full-body week again");await page.keyboard.press("Enter");
    const second=await lastAnswer(page,5);
    await second.getByRole("button",{name:"Apply to my plan"}).click();
    await page.locator("#aiConfirm").waitFor({state:"visible"});
    assert.match(await page.locator("#aiConfirmText").textContent(),/Your current plan has 12 exercises/);
    await page.getByRole("button",{name:"Keep my plan"}).click();
    assert.deepEqual((await savedPlan(context)).days.Monday.map((item)=>item.exerciseId),after);
    assert.equal(await second.locator(".ai-applied").count(),0);

    // A broken answer shows a retry that asks again without repeating the message.
    breakNext=2;
    await page.fill("#aiMessage","Plan a full-body week with more rest");await page.keyboard.press("Enter");
    const failed=page.locator("#aiConversation .ai-turn-error");await failed.waitFor({state:"visible"});
    assert.match(await failed.textContent(),/could not be read/);
    await failed.getByRole("button",{name:"Try again"}).click();
    await lastAnswer(page,6);
    assert.equal(await page.locator("#aiConversation .ai-turn-error").count(),0);
    assert.equal(await page.locator("#aiConversation .ai-turn-user").count(),6,"the retry reuses the original message");

    await noOverflow(page,"ai-conversation");
    await page.reload({waitUntil:"domcontentloaded"});
    await lastAnswer(page,6);
    assert.equal(await page.locator("#aiConversation .ai-applied").count(),3,"applied states survive a reload in this tab");
    assert.match(await page.locator("#aiStatusDetail").textContent(),/2[0-9] of 30 requests left today/);
    await page.click("#aiReset");
    assert.equal(await page.locator("#aiConversation > li").count(),0);assert.equal(await page.locator("#aiEmpty").isVisible(),true);
    assert.deepEqual(pageErrors,[]);
  }finally{await context.close();}
});

test.before(async()=>{
  try{await startApp();const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);}
  catch(error){await cleanup();throw error;}
});
test.after(cleanup);
