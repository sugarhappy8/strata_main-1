"use strict";
/* global document, getComputedStyle */

const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const http=require("node:http");
const {tmpdir}=require("node:os");
const {join,resolve}=require("node:path");
const test=require("node:test");
const {AxeBuilder}=require("@axe-core/playwright");
const {chromium}=require("playwright");

const ROOT=join(__dirname,"..","..");
const WAIT_MS=10_000;
const PASSWORD="coaching-browser-password-123";
let app,browser,baseUrl,runtimeDir,serverLogs="";

async function unusedPort(){
  const probe=http.createServer();
  await new Promise((done,reject)=>{probe.once("error",reject);probe.listen(0,"127.0.0.1",done);});
  const port=probe.address().port;
  await new Promise((done,reject)=>probe.close((error)=>error?reject(error):done()));
  return port;
}

async function startApp(){
  const port=await unusedPort();baseUrl=`http://127.0.0.1:${port}`;runtimeDir=mkdtempSync(join(tmpdir(),"strata-coaching-e2e-"));
  app=spawn(process.execPath,["server.js"],{
    cwd:ROOT,
    env:{...process.env,HOST:"127.0.0.1",PORT:String(port),NODE_ENV:"test",TZ:"UTC",TRUST_PROXY:"true",SECURE_COOKIES:"false",ADMIN_EMAIL:"",TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",STRATA_DATA_DIR:runtimeDir,ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRICE_ID:"",PADDLE_PRODUCT_ID:"",APP_BASE_URL:baseUrl},
    stdio:["ignore","pipe","pipe"]
  });
  for(const stream of [app.stdout,app.stderr])stream.on("data",(chunk)=>{serverLogs=(serverLogs+chunk.toString()).slice(-16_384);});
  const deadline=Date.now()+WAIT_MS;
  while(Date.now()<deadline){
    if(app.exitCode!==null)throw new Error(`Coaching E2E server exited during startup.\n${serverLogs}`);
    try{if((await fetch(`${baseUrl}/healthz`)).ok)return;}catch{}
    await new Promise((done)=>setTimeout(done,50));
  }
  throw new Error(`Coaching E2E server did not become healthy.\n${serverLogs}`);
}

async function stopApp(){
  if(!app||app.exitCode!==null||app.signalCode!==null)return;
  await new Promise((done)=>{
    let settled=false,forceTimer;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(forceTimer);done();};
    app.once("exit",finish);app.kill("SIGTERM");forceTimer=setTimeout(()=>{try{app.kill("SIGKILL");}catch{}finish();},2_000);
  });
}

async function cleanup(){
  try{await browser?.close();}
  finally{await stopApp();if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});}
}

async function signup(context,label){
  const response=await context.request.post("/api/signup",{headers:{Origin:baseUrl},data:{name:`Coaching ${label}`,email:`coaching-${label}@example.test`,password:PASSWORD}});
  assert.equal(response.status(),201,await response.text());
  return (await response.json()).user;
}

async function activatePlus(context){
  const plan=await context.request.get("/api/plan");assert.equal(plan.status(),200,await plan.text());
  const {csrfToken}=await plan.json(),response=await context.request.post("/api/discovery/trial",{headers:{Origin:baseUrl,"X-CSRF-Token":csrfToken},data:{}});
  assert.ok([200,201].includes(response.status()),await response.text());
}

function calorieNumber(text){return Number(String(text||"").replace(/[^0-9]/g,""));}

test("a Strata+ member builds, tracks, reloads, and safely refreshes a coaching week",{timeout:60_000},async()=>{
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",timezoneId:"UTC",viewport:{width:1280,height:900},extraHTTPHeaders:{"X-Forwarded-For":"198.51.100.241"}});
  context.setDefaultTimeout(WAIT_MS);
  const page=await context.newPage(),pageErrors=[];page.on("pageerror",(error)=>pageErrors.push(error.message));
  try{
    await page.emulateMedia({reducedMotion:"reduce"});
    const user=await signup(context,"owner");await activatePlus(context);
    await page.goto("/discover.html",{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>globalThis.document.querySelector("#userName")?.textContent==="Coaching owner");
    const destinations=page.locator(".destination-nav .destination-link");
    assert.equal(await destinations.count(),5);assert.match((await destinations.nth(4).textContent())||"",/Personal training/i);
    await page.evaluate(async()=>{await globalThis.document.fonts.ready;});
    await destinations.nth(4).click();await page.locator("#coachingSetup").waitFor({state:"visible"});
    await page.evaluate(()=>new Promise((resolveFrame)=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolveFrame))));

    for(const {width,height} of [{width:1440,height:1000},{width:768,height:844},{width:390,height:844},{width:320,height:844}]){
      await page.setViewportSize({width,height});
      const setupLayout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,firstSectionTop:document.querySelector("#coachingBodyInputs")?.getBoundingClientRect().top||Infinity}));
      assert.ok(setupLayout.overflow<=1,`coaching setup overflows ${width}px by ${setupLayout.overflow}px`);
      assert.ok(setupLayout.firstSectionTop<=height,`the first coaching inputs should begin in the initial ${width}px viewport`);
    }
    for(const width of [768,320]){
      await page.setViewportSize({width,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
      const reflow=await page.evaluate(()=>{const workspace=document.querySelector("#coachingWorkspace"),right=workspace.getBoundingClientRect().right;return{overflow:workspace.scrollWidth-workspace.clientWidth,titleOverflow:document.querySelector("#coachingSetupTitle").scrollWidth-document.querySelector("#coachingSetupTitle").clientWidth,mapOverflow:[...document.querySelectorAll(".coaching-setup-map a")].some((node)=>node.scrollWidth>node.clientWidth+1),offenders:[...workspace.querySelectorAll("*")].filter((node)=>node.getBoundingClientRect().right>right+1).slice(0,8).map((node)=>`${node.tagName}#${node.id}.${node.className}:${node.textContent?.trim().slice(0,45)}`)};});
      assert.ok(reflow.overflow<=1,`coaching setup overflows ${width}px by ${reflow.overflow}px at 200% text: ${reflow.offenders.join(", ")}`);assert.ok(reflow.titleOverflow<=1,`coaching title clips at ${width}px and 200% text`);assert.equal(reflow.mapOverflow,false,`coaching step labels clip at ${width}px and 200% text`);
    }
    await page.evaluate(()=>{document.documentElement.style.fontSize="";});
    await page.setViewportSize({width:1280,height:900});
    const accessibility=await new AxeBuilder({page}).include("#coachingSetup").analyze();assert.deepEqual(accessibility.violations.map(({id})=>id),[],`coaching setup accessibility violations: ${accessibility.violations.map(({id})=>id).join(", ")}`);

    await page.fill("#coachingAge","31");await page.fill("#coachingHeight","178");await page.fill("#coachingWeight","82");await page.fill("#coachingBodyFat","18.5");await page.selectOption("#coachingSex","male");
    await page.selectOption("#coachingDailyMovement","mostly_seated");await page.fill("#coachingAdditionalActivityMinutes","180");await page.locator("#coachingAdditionalActivityMinutes").dispatchEvent("input");await page.selectOption("#coachingAdditionalActivityIntensity","moderate");await page.selectOption("#coachingGoal","deficit");await page.selectOption("#coachingGoalPace","gentle");await page.selectOption("#coachingExperience","intermediate");await page.fill("#coachingFrequency","3");await page.locator("#coachingFrequency").dispatchEvent("change");await page.selectOption("#coachingDuration","60");
    assert.deepEqual(await page.locator('input[name="trainingDays"]:checked').evaluateAll((nodes)=>nodes.map((node)=>node.value)),["Monday","Wednesday","Friday"]);
    await page.click("#coachingAddCapability");const capability=page.locator("#coachingCapabilityRows .coaching-capability-row").first();
    await page.setViewportSize({width:390,height:844});assert.deepEqual(await capability.locator("label > span").allTextContents(),["Exercise","Sets","Reps","Weight","Unit"]);assert.equal(await capability.locator("label > span").evaluateAll((nodes)=>nodes.every((node)=>getComputedStyle(node).display!=="none")),true,"capability field labels must be visible on mobile");await page.setViewportSize({width:1280,height:900});
    await capability.locator("[data-capability-exercise]").fill("Flat Dumbbell Press");await capability.locator("[data-capability-sets]").fill("4");await capability.locator("[data-capability-reps]").fill("10");await capability.locator("[data-capability-weight]").fill("32");await capability.locator("[data-capability-unit]").selectOption("kg");
    await page.selectOption("#coachingTrainingGoal","strength");await page.check('input[name="caloriePattern"][value="training_day"]');await page.check("#coachingMacrosEnabled");await page.selectOption("#coachingMacroPreference","higher_protein");await page.check("#mealAllergyNone");await page.selectOption("#mealDietaryPattern","omnivore");await page.selectOption("#mealMealsPerDay","3");await page.fill("#mealDailyBudget","15.00");await page.check('input[name="mealFavorite"][value="chicken"]');await page.check('input[name="mealFavorite"][value="rice"]');

    const profileResponsePromise=page.waitForResponse((response)=>new URL(response.url()).pathname==="/api/coaching/profile"&&response.request().method()==="PUT"),foodOptionsPromise=page.waitForResponse((response)=>new URL(response.url()).pathname.startsWith("/api/coaching/food-options/")&&response.request().method()==="GET");
    await page.click("#coachingGenerate");const profileResponse=await profileResponsePromise;assert.equal(profileResponse.status(),200,await profileResponse.text());
    const profileRequest=profileResponse.request(),profileBody=profileRequest.postDataJSON(),profileResult=await profileResponse.json();
    assert.ok(profileRequest.headers()["x-csrf-token"]);assert.equal(profileBody.expectedUserId,user.id);assert.equal(profileBody.expectedRevision,0);
    assert.deepEqual({version:profileBody.profile.version,measurementSystem:profileBody.profile.measurementSystem,preferredLoadUnit:profileBody.profile.preferredLoadUnit,age:profileBody.profile.age,heightCm:profileBody.profile.heightCm,weightKg:profileBody.profile.weightKg,bodyFatPercent:profileBody.profile.bodyFatPercent,sexForEquation:profileBody.profile.sexForEquation,goal:profileBody.profile.goal,goalPace:profileBody.profile.goalPace,experience:profileBody.profile.experience,dailyMovement:profileBody.profile.dailyMovement,additionalActivityMinutesPerWeek:profileBody.profile.additionalActivityMinutesPerWeek,additionalActivityIntensity:profileBody.profile.additionalActivityIntensity,workoutDays:profileBody.profile.workoutDays,sessionMinutes:profileBody.profile.sessionMinutes,caloriePattern:profileBody.profile.caloriePattern,macroPreference:profileBody.profile.macroPreference,mealPreferences:profileBody.profile.mealPreferences},{version:4,measurementSystem:"metric",preferredLoadUnit:"kg",age:31,heightCm:178,weightKg:82,bodyFatPercent:18.5,sexForEquation:"male",goal:"fat_loss",goalPace:"gentle",experience:"intermediate",dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:180,additionalActivityIntensity:"moderate",workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,caloriePattern:"zigzag",macroPreference:"higher_protein",mealPreferences:{allergyStatus:"none_known",allergens:[],otherAllergies:"",dietaryPattern:"omnivore",dietaryRequirements:[],favoriteFoods:["chicken","rice"],mealsPerDay:3,dailyBudgetCents:1500}});
    assert.deepEqual(profileBody.profile.usualExercises,[{exerciseId:"flat-dumbbell-press",maxSets:4,maxReps:10,maxWeightKg:32}]);assert.ok(profileBody.profile.availableEquipment.includes("Dumbbells"));assert.equal(profileResult.profile.revision,1);

    assert.equal(profileBody.profile.trainingGoal,"strength");await page.locator("#coachingDashboard").waitFor({state:"visible"});assert.equal(await page.locator("#coachingDashboardTitle").evaluate((node)=>node===globalThis.document.activeElement),true,"successful generation should focus the visible dashboard heading");
    assert.equal(await page.locator("#coachingWeekGrid .coaching-day-card").count(),7);assert.equal(await page.locator("#coachingWeekGrid .coaching-day-card.is-training").count(),3);assert.match((await page.locator("#coachingWeekGrid").textContent())||"",/Flat Dumbbell Press/);
    assert.equal(await page.locator("#coachingCalorieWeek .coaching-calorie-card").count(),7);const renderedCalories=await page.locator("#coachingCalorieWeek .coaching-calorie-card > strong").allTextContents();assert.ok(new Set(renderedCalories.map(calorieNumber)).size>1,"zigzag targets must visibly vary by day");
    const goalOptions=page.locator("#coachingGoalComparison .coaching-goal-option");assert.equal(await goalOptions.count(),3);assert.deepEqual(await goalOptions.locator("span").allTextContents(),["Deficit","Maintenance","Surplus"]);assert.equal(await page.locator("#coachingGoalComparison .coaching-goal-option.is-selected").count(),1);
    const maintenanceText=(await page.locator("#coachingTdee").textContent())?.trim();assert.equal(await page.locator("#coachingTdee").evaluate(node=>node.previousElementSibling.textContent),"Maintenance is");assert.match(maintenanceText,/^\d[\d,]* kcal\/day$/,"maintenance must show one daily value");assert.equal(calorieNumber(maintenanceText),profileResult.week.nutrition.maintenance.targetKcal,"the headline must use the accepted server target");assert.match((await page.locator("#coachingTdeeDetail").textContent())||"",/Planning range:.*not a confidence interval or measured expenditure/i,"uncertainty remains visible below the point value");
    const comparisonValues=await goalOptions.locator("strong").allTextContents();for(const value of comparisonValues)assert.match(value,/^\d[\d,]* kcal\/day$/);assert.deepEqual(comparisonValues.map(calorieNumber),[profileResult.week.nutrition.deficit.targetKcal,profileResult.week.nutrition.maintenance.targetKcal,profileResult.week.nutrition.bulk.targetKcal]);
    const restingMethod=(await page.locator("#coachingBmrMethod").textContent())||"";assert.match(restingMethod,/Mifflin–St Jeor/i,"the resting estimate should name its primary resting-energy equation");assert.match(restingMethod,/Body-fat cross-check: about .* Cunningham 1991 .* noisy body-fat input/i,"body fat should remain a correctly attributed secondary cross-check");const activityDetail=(await page.locator("#coachingTdeeDetail").textContent())||"";assert.match(activityDetail,/generated sessions: about/i,"maintenance should expose the generated-session contribution");assert.match(activityDetail,/other activity: about/i,"maintenance should expose separately entered activity");assert.match((await page.locator("#coachingTargetDetail").textContent())||"",/0\.25% body weight\/week requested/i,"the displayed deficit must expose its weight-relative pace");assert.match((await page.locator("#coachingMethodList").textContent())||"",/Cunningham resting-energy cross-check/i);assert.ok(await page.locator("#coachingProjectionChart svg[role=img]").count()===1);assert.match((await page.locator("#coachingProjectionNote").textContent())||"",/not .*promise|not a prediction interval|not a confidence interval/i);
    assert.match((await page.locator("#coachingCalibrationTitle").textContent())||"",/STARTING ESTIMATE/i);assert.equal((await page.locator("#coachingCalibrationIntake").textContent())?.trim(),"0 logged · 0 aligned");assert.equal((await page.locator("#coachingCalibrationWeights").textContent())?.trim(),"0 / 8 · 0 / 14 days");assert.match((await page.locator("#coachingCalibrationExplanation").textContent())||"",/14 consecutive complete intake days/i);
    await page.getByText("Training coverage",{exact:true}).click();assert.match((await page.locator("#coachingTrainingCoverage").textContent())||"",/direct sets over/);assert.match((await page.locator("#coachingCalibrationAdjustment").textContent())||"",/equation baseline/);
    const foodOptionsResponse=await foodOptionsPromise;assert.equal(foodOptionsResponse.status(),200,await foodOptionsResponse.text());const foodResult=await foodOptionsResponse.json();await page.locator("#coachingFoodOptions .coaching-meal-card").first().waitFor();assert.equal(await page.locator("#coachingFoodOptions .coaching-meal-card").count(),3);assert.match((await page.locator("#coachingFoodStatus").textContent())||"",foodResult.status==="ready"?/approximate options.*saved intake/i:/partial meal ideas/i);const foodText=(await page.locator("#coachingFoodOptions").textContent())||"";assert.match(foodText,/Est\. cost/i);assert.match(foodText,/Amounts for this portion:/);assert.match(foodText,/remaining plan/);for(const option of foodResult.options)for(const meal of option.meals)for(const amount of meal.ingredients)assert.ok(foodText.includes(amount),`scaled ingredient missing: ${amount}`);
    const foodAccessibility=await new AxeBuilder({page}).include("#coachingFood").analyze();assert.deepEqual(foodAccessibility.violations.map(({id})=>id),[],`food-option accessibility violations: ${foodAccessibility.violations.map(({id})=>id).join(", ")}`);
    for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:900});const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,calibrationOverflow:document.querySelector("#coachingCalibration").scrollWidth-document.querySelector("#coachingCalibration").clientWidth,logOverflow:document.querySelector("#coachingLogForm").scrollWidth-document.querySelector("#coachingLogForm").clientWidth}));assert.ok(layout.overflow<=1,`coaching dashboard overflows ${width}px by ${layout.overflow}px`);assert.ok(layout.calibrationOverflow<=1,`calibration panel overflows ${width}px by ${layout.calibrationOverflow}px`);assert.ok(layout.logOverflow<=1,`daily log overflows ${width}px by ${layout.logOverflow}px`);if([1440,390].includes(width)){const artifacts=join(ROOT,"test-runtime","coaching-screens");mkdirSync(artifacts,{recursive:true});await page.locator(".coaching-metrics").screenshot({path:join(artifacts,`energy-targets-${width}.png`)});await page.locator("#coachingCalibration").screenshot({path:join(artifacts,`calibration-${width}.png`)});await page.locator("#coachingFoodOptions .coaching-meal-card").first().screenshot({path:join(artifacts,`food-${width}.png`)});await page.locator("#coachingTrainingCoverage").screenshot({path:join(artifacts,`training-coverage-${width}.png`)});}}await page.setViewportSize({width:1280,height:900});

    const date=await page.locator("#coachingLogDate").inputValue(),target=profileResult.week.nutrition.dailyTargets.find((entry)=>entry.date===date).calories;
    await page.fill("#coachingCaloriesEaten","1800");await page.fill("#coachingMorningWeight","82.1");await page.check("#coachingDayComplete");await page.fill("#coachingProteinEaten","150");await page.fill("#coachingCarbsEaten","200");await page.fill("#coachingFatEaten","60");
    const logResponsePromise=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/coaching/logs/${date}`&&response.request().method()==="PUT");await page.click("#coachingSaveLog");const logResponse=await logResponsePromise;assert.equal(logResponse.status(),200,await logResponse.text());
    const logBody=logResponse.request().postDataJSON(),savedLog=await logResponse.json();assert.ok(logResponse.request().headers()["x-csrf-token"]);assert.equal(logBody.expectedUserId,user.id);assert.equal(logBody.expectedRevision,0);assert.deepEqual(logBody.log,{calories:1800,proteinG:150,carbsG:200,fatG:60,morningWeightKg:82.1,complete:true});assert.equal(savedLog.log.remainingCalories,Math.max(0,target-1800));

    assert.equal(await page.locator("#coachingLogDate option").count(),43,"the diary covers 42 previous dates and today");
    const historicalDate=profileResult.week.logTargets.find((entry)=>entry.calories==null&&entry.date<profileResult.week.weekStart).date;
    await page.selectOption("#coachingLogDate",historicalDate);assert.match((await page.locator("#coachingProgressSummary").textContent())||"",/No target was saved/);assert.equal(await page.locator("#coachingFoodRefresh").isDisabled(),true);assert.match((await page.locator("#coachingFoodStatus").textContent())||"",/Historical intake/);
    await page.fill("#coachingCaloriesEaten","1900");await page.fill("#coachingMorningWeight","81.9");await page.check("#coachingDayComplete");const historicalSave=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/coaching/logs/${historicalDate}`&&response.request().method()==="PUT");await page.click("#coachingSaveLog");const historyResponse=await historicalSave;assert.equal(historyResponse.status(),200);const historyResult=await historyResponse.json();assert.equal(historyResult.log.remainingCalories,null);await page.waitForFunction(()=>!document.querySelector("#coachingSaveLog").disabled);
    let releaseHistory;const historyGate=new Promise(resolve=>{releaseHistory=resolve;});await page.route(`**/api/coaching/logs/${historicalDate}`,async route=>{if(route.request().method()==="PUT")await historyGate;await route.continue();});await page.fill("#coachingCaloriesEaten","1925");const delayedHistory=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/coaching/logs/${historicalDate}`&&response.request().method()==="PUT");await page.click("#coachingSaveLog");await page.selectOption("#coachingLogDate",date);await page.fill("#coachingCaloriesEaten","1999");releaseHistory();assert.equal((await delayedHistory).status(),200);await page.waitForFunction(()=>/newer entries/.test(document.querySelector("#coachingLogStatus").textContent));assert.equal(await page.locator("#coachingLogDate").inputValue(),date);assert.equal(await page.locator("#coachingCaloriesEaten").inputValue(),"1999");await page.unroute(`**/api/coaching/logs/${historicalDate}`);

    await page.reload({waitUntil:"domcontentloaded"});await page.locator("#coachingDashboard").waitFor({state:"visible"});assert.equal(await page.locator("#coachingCaloriesEaten").inputValue(),"1800");assert.equal(await page.locator("#coachingMorningWeight").inputValue(),"82.1");assert.equal(await page.locator("#coachingDayComplete").isChecked(),true);assert.equal(await page.locator("#coachingProteinEaten").inputValue(),"150");assert.match((await page.locator("#coachingProgressSummary").textContent())||"",/1,800 kcal/);await page.locator("#coachingFoodOptions .coaching-meal-card").first().waitFor();
    await destinations.nth(2).click();await page.locator("#progressCalorieCard").waitFor({state:"visible"});assert.equal(await page.locator("#progressCoachingCaloriesEaten").inputValue(),"1800");assert.equal(await page.locator("#progressCoachingMorningWeight").inputValue(),"82.1");assert.equal(await page.locator("#progressCoachingDayComplete").isChecked(),true);assert.equal(await page.locator("#progressCoachingProteinEaten").inputValue(),"150");assert.equal(await page.locator("#progressCoachingFoodOptions .coaching-meal-card").count(),3);assert.match((await page.locator("#progressCalorieTitle").textContent())||"",/LOG [A-Z]+’S TOTAL/);assert.equal(await page.locator(".progress-calorie-form label > span").first().evaluate((node)=>globalThis.getComputedStyle(node).color),"rgb(16, 17, 15)");
    let releaseFood;const foodGate=new Promise((resolveGate)=>{releaseFood=resolveGate;});await page.route("**/api/coaching/food-options/**",async(route)=>{await foodGate;await route.continue();});const refreshedFood=page.waitForResponse((response)=>new URL(response.url()).pathname.startsWith("/api/coaching/food-options/")&&response.request().method()==="GET");await page.click("#progressCoachingFoodRefresh");await page.waitForFunction(()=>globalThis.document.querySelector("#progressCoachingFoodOptions")?.getAttribute("aria-busy")==="true");assert.equal((await page.locator("#progressCoachingFoodOptions").textContent())?.trim(),"","stale meal cards must clear while a refreshed day is being matched");releaseFood();assert.equal((await refreshedFood).status(),200);await page.locator("#progressCoachingFoodOptions .coaching-meal-card").first().waitFor();assert.equal(await page.locator("#progressCoachingFoodTitle").evaluate((node)=>node===globalThis.document.activeElement),true,"Progress refresh should focus its own visible result heading");await page.unroute("**/api/coaching/food-options/**");
    await page.fill("#progressCoachingCaloriesEaten","1825");await page.fill("#progressCoachingMorningWeight","82.0");await page.fill("#progressCoachingProteinEaten","151");await page.fill("#progressCoachingCarbsEaten","201");await page.fill("#progressCoachingFatEaten","61");const progressSavePromise=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/coaching/logs/${date}`&&response.request().method()==="PUT");await page.click("#progressCoachingSaveLog");const progressSave=await progressSavePromise;assert.equal(progressSave.status(),200,await progressSave.text());assert.equal(progressSave.request().postDataJSON().expectedRevision,1);assert.deepEqual(progressSave.request().postDataJSON().log,{calories:1825,proteinG:151,carbsG:201,fatG:61,morningWeightKg:82,complete:true});assert.equal((await progressSave.json()).log.revision,2);assert.match((await page.locator("#progressCoachingSummary").textContent())||"",/1,825 kcal/);await destinations.nth(4).click();await page.locator("#coachingDashboard").waitFor({state:"visible"});

    const snapshotResponse=await context.request.get("/api/coaching/week");assert.equal(snapshotResponse.status(),200);const snapshot=await snapshotResponse.json();
    const external=await context.request.put(`/api/coaching/logs/${date}`,{headers:{Origin:baseUrl,"X-CSRF-Token":snapshot.csrfToken},data:{log:{calories:1900,proteinG:155,carbsG:210,fatG:65,morningWeightKg:82.2,complete:true},expectedRevision:2,expectedUserId:user.id}});assert.equal(external.status(),200,await external.text());
    await page.fill("#coachingCaloriesEaten","1850");await page.fill("#coachingProteinEaten","152");await page.fill("#coachingCarbsEaten","205");await page.fill("#coachingFatEaten","62");
    const conflictPromise=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/coaching/logs/${date}`&&response.request().method()==="PUT");await page.click("#coachingSaveLog");const conflict=await conflictPromise;assert.equal(conflict.status(),409);await page.waitForFunction(()=>/latest revision is loaded/i.test(globalThis.document.querySelector("#coachingLogStatus")?.textContent||""));assert.equal(await page.locator("#coachingCaloriesEaten").inputValue(),"1850","the reviewed local entry should remain on screen while its revision advances");
    const recoveredPromise=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/coaching/logs/${date}`&&response.request().method()==="PUT"&&response.status()===200);await page.click("#coachingSaveLog");const recovered=await recoveredPromise;assert.equal(recovered.request().postDataJSON().expectedRevision,3);assert.equal((await recovered.json()).log.revision,4);

    await page.click("#coachingEditProfile");await page.uncheck("#coachingMacrosEnabled");const macrosOffPromise=page.waitForResponse((response)=>new URL(response.url()).pathname==="/api/coaching/profile"&&response.request().method()==="PUT");await page.click("#coachingGenerate");const macrosOff=await macrosOffPromise;assert.equal(macrosOff.status(),200,await macrosOff.text());await page.locator("#coachingDashboard").waitFor({state:"visible"});assert.equal(await page.locator(".coaching-macro-log").first().isHidden(),true);assert.equal(await page.locator("#coachingProteinEaten").inputValue(),"");
    await page.fill("#coachingCaloriesEaten","1875");const calorieOnlyPromise=page.waitForResponse((response)=>new URL(response.url()).pathname===`/api/coaching/logs/${date}`&&response.request().method()==="PUT");await page.click("#coachingSaveLog");const calorieOnly=await calorieOnlyPromise;assert.equal(calorieOnly.status(),200,await calorieOnly.text());assert.deepEqual(calorieOnly.request().postDataJSON().log,{calories:1875,morningWeightKg:82,complete:true});

    let releaseDiscovery,finishDiscovery;const discoveryGate=new Promise((resolveGate)=>{releaseDiscovery=resolveGate;}),discoveryHandled=new Promise((resolveHandled)=>{finishDiscovery=resolveHandled;});
    await page.route("**/api/discovery",async(route)=>{await discoveryGate;try{await route.continue();}finally{finishDiscovery();}});await signup(context,"replacement");
    await page.evaluate(()=>globalThis.dispatchEvent(new Event("focus")));await page.waitForFunction(()=>globalThis.document.querySelector("#userName")?.textContent==="Checking account…");
    const purged=await page.evaluate(()=>({height:globalThis.document.querySelector("#coachingHeight")?.value,weight:globalThis.document.querySelector("#coachingWeight")?.value,capabilities:globalThis.document.querySelector("#coachingCapabilityRows")?.textContent,week:globalThis.document.querySelector("#coachingWeekGrid")?.textContent,calories:globalThis.document.querySelector("#coachingCaloriesEaten")?.value,morningWeight:globalThis.document.querySelector("#coachingMorningWeight")?.value,dayComplete:globalThis.document.querySelector("#coachingDayComplete")?.checked,calibration:globalThis.document.querySelector("#coachingCalibrationExplanation")?.textContent,calibrationObserved:globalThis.document.querySelector("#coachingCalibrationObserved")?.textContent,calibrationCutoff:globalThis.document.querySelector("#coachingCalibrationCutoff")?.textContent,projection:globalThis.document.querySelector("#coachingProjectionChart")?.textContent,foodOptions:globalThis.document.querySelector("#coachingFoodOptions")?.textContent,allergyChecked:[...globalThis.document.querySelectorAll('input[name="mealAllergyStatus"]')].some((input)=>input.checked),mainHidden:globalThis.document.querySelector("main")?.hidden}));
    assert.deepEqual(purged,{height:"",weight:"",capabilities:"",week:"",calories:"",morningWeight:"",dayComplete:false,calibration:"",calibrationObserved:"Not ready",calibrationCutoff:"",projection:"",foodOptions:"",allergyChecked:false,mainHidden:true},"account revalidation must purge prior health, food-preference, calibration, and intake data before loading the next account");releaseDiscovery();await discoveryHandled;
    await page.unroute("**/api/discovery");assert.deepEqual(pageErrors,[],`Unexpected browser errors:\n${pageErrors.join("\n")}`);
  }finally{await context.close();}
});

test("an equipment-limited beginner sees honest training gaps while calories and diary remain usable",async()=>{
  const context=await browser.newContext({baseURL:baseUrl,serviceWorkers:"block",timezoneId:"UTC",viewport:{width:390,height:844},extraHTTPHeaders:{"X-Forwarded-For":"198.51.100.242"}});
  try{
    await signup(context,"bodyweight-beginner");await activatePlus(context);
    const session=await (await context.request.get("/api/me")).json(),profile={version:4,measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",experience:"beginner",dailyMovement:"lightly_moving",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:30,usualExercises:[],availableEquipment:["Bodyweight"],movementLimitations:[],caloriePattern:"steady",flexibleDay:null,macroPreference:null,timeZone:"UTC"};
    const saved=await context.request.put("/api/coaching/profile",{headers:{Origin:baseUrl,"X-CSRF-Token":session.csrfToken},data:{profile,expectedRevision:0}});
    assert.equal(saved.status(),200,await saved.text());
    const page=await context.newPage();await page.goto("/discover.html#coachingWorkspace",{waitUntil:"domcontentloaded"});await page.locator("#coachingDashboard").waitFor({state:"visible"});
    assert.equal(await page.locator("#coachingCalorieWeek .coaching-calorie-card").count(),7);
    assert.match((await page.locator("#coachingWeekGrid").textContent())||"",/partial|unavailable/i);
    assert.match((await page.locator("#coachingWeekGrid").textContent())||"",/Knee-dominant legs/);
    assert.match((await page.locator("#coachingPlanMethod").textContent())||"",/review/i);
    await page.fill("#coachingCaloriesEaten","2000");const response=page.waitForResponse(r=>new URL(r.url()).pathname.startsWith("/api/coaching/logs/")&&r.request().method()==="PUT");await page.click("#coachingSaveLog");assert.equal((await response).status(),200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)<=1);
  }finally{await context.close();}
});

test.before(async()=>{
  try{await startApp();const options={headless:true};if(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)options.executablePath=resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);browser=await chromium.launch(options);}
  catch(error){await cleanup();throw error;}
});
test.after(cleanup);
