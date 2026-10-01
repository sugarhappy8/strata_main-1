"use strict";

const test=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{mkdirSync,mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {ENERGY_MODEL_VERSION,addDays,currentWeekStart,localDate}=require("../src/coaching-core");
const {logPayload}=require("../src/coaching");
const {grantStrataPlus}=require("./support/strata-plus-access");
const ROOT=join(__dirname,"..");let server,directory,base;

async function launch(){
  mkdirSync(join(ROOT,"test-runtime"),{recursive:true});directory=mkdtempSync(join(ROOT,"test-runtime","coaching-http-"));
  server=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{...process.env,HOST:"127.0.0.1",PORT:"0",NODE_ENV:"test",ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRICE_ID:"",PADDLE_PRODUCT_ID:""},stdio:["ignore","pipe","pipe"]});
  base=await new Promise((resolve,reject)=>{let output="",errors="";const timer=setTimeout(()=>reject(new Error(`Coaching server startup timed out: ${errors}`)),6000);server.stdout.on("data",(chunk)=>{output=(output+chunk).slice(-4096);const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});server.stderr.on("data",(chunk)=>{errors=(errors+chunk).slice(-4096);});server.once("error",reject);server.once("exit",(code)=>reject(new Error(`Coaching server exited ${code}: ${errors}`)));});
}
async function stop(){if(server&&server.exitCode===null)await new Promise((resolve)=>{const timer=setTimeout(()=>server.kill("SIGKILL"),2000);server.once("exit",()=>{clearTimeout(timer);resolve();});server.kill("SIGTERM");});if(directory)rmSync(directory,{recursive:true,force:true});}
async function request(path,account=null,method="GET",body,headers={}){const response=await fetch(`${base}${path}`,{method,headers:{Origin:base,"Content-Type":"application/json",...(account?{Cookie:account.cookie,"X-CSRF-Token":account.csrf}:{}),...headers},...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});return {status:response.status,data:await response.json(),cookie:response.headers.get("set-cookie")?.split(";")[0]||""};}
async function account(suffix,{plus=true}={}){const signup=await request("/api/signup",null,"POST",{name:`Coach ${suffix}`,email:`coach-${suffix}@example.test`,password:"strong-coaching-password-123"});assert.equal(signup.status,201);const me=await request("/api/me",{cookie:signup.cookie,csrf:""});const result={cookie:signup.cookie,csrf:me.data.csrfToken,id:me.data.user.id};if(plus)grantStrataPlus(directory,result.id);return result;}
function profile(overrides={}){
  const version=overrides.version??4,activity=version===4?{dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate"}:{lifestyleActivity:"moderately_active"};
  return {version,measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",experience:"intermediate",...activity,workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,usualExercises:[{exerciseId:"flat-dumbbell-press",maxSets:4,maxReps:10,maxWeightKg:30}],availableEquipment:[],movementLimitations:[],caloriePattern:"zigzag",flexibleDay:null,macroPreference:"balanced",timeZone:"Asia/Dubai",...overrides};
}
function mealPreferences(overrides={}){return {allergyStatus:"none_known",allergens:[],otherAllergies:"",dietaryPattern:"omnivore",dietaryRequirements:[],favoriteFoods:["chicken","rice"],mealsPerDay:3,dailyBudgetCents:1800,...overrides};}

test.before(launch);test.after(stop);

test("every coaching endpoint fails closed without an authenticated active Strata+ entitlement",async()=>{
  for(const path of ["/api/coaching/profile","/api/coaching/week","/api/coaching/logs/2026-09-07","/api/coaching/food-options/2026-09-07"]){assert.equal((await request(path)).status,401,path);}
  const free=await account("free",{plus:false});
  for(const [path,method,body] of [["/api/coaching/profile","GET"],["/api/coaching/profile","PUT",{profile:profile(),expectedRevision:0}],["/api/coaching/week","GET"],["/api/coaching/logs/2026-09-07","GET"],["/api/coaching/logs/2026-09-07","PUT",{log:{calories:2000},expectedRevision:0}],["/api/coaching/food-options/2026-09-07","GET"]]){
    const result=await request(path,free,method,body);assert.equal(result.status,402,path);assert.equal(result.data.code,"DISCOVERY_ACCESS_REQUIRED");
  }
});

test("food options use the saved target, intake, allergies, favorites, meal count, and budget",async()=>{
  const member=await account("food-options"),saved=await request("/api/coaching/profile",member,"PUT",{profile:profile({mealPreferences:mealPreferences({allergyStatus:"listed",allergens:["milk","peanuts"],favoriteFoods:["chicken","rice"],mealsPerDay:4,dailyBudgetCents:1600})}),expectedRevision:0});
  assert.equal(saved.status,200);const date=saved.data.week.weekStart,target=saved.data.week.nutrition.dailyTargets.find((day)=>day.date===date);
  assert.equal((await request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories:600,proteinG:40,carbsG:70,fatG:18},expectedRevision:0})).status,200);
  const result=await request(`/api/coaching/food-options/${date}`,member);assert.equal(result.status,200);assert.equal(result.data.csrfToken,member.csrf);assert.ok(["ready","limited"].includes(result.data.status));assert.equal(result.data.options.length,3);assert.equal(result.data.remaining.calories,target.calories-600);assert.ok(result.data.mealsRemaining>=1&&result.data.mealsRemaining<=4);assert.match(result.data.nutritionProvenance.url,/fdc\.nal\.usda\.gov/);assert.match(result.data.costDisclaimer,/not live store prices/i);
  for(const option of result.data.options)for(const meal of option.meals){assert.equal(meal.allergens.includes("milk"),false);assert.equal(meal.allergens.includes("peanuts"),false);}
  assert.equal((await request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories:700,proteinG:null,carbsG:null,fatG:null},expectedRevision:1})).status,200);
  const caloriesOnly=await request(`/api/coaching/food-options/${date}`,member);assert.equal(caloriesOnly.status,200);assert.equal(caloriesOnly.data.remaining.calories,target.calories-700);assert.equal(caloriesOnly.data.remaining.proteinG,null);assert.ok(caloriesOnly.data.options.every((option)=>option.macroDifference===null));
  assert.equal((await request(`/api/coaching/food-options/${date}`,member,"POST",{})).status,405);
  assert.equal((await request(`/api/coaching/food-options/${saved.data.week.nextWeekStart}`,member)).data.code,"COACHING_LOG_OUTSIDE_CURRENT_WEEK");

  const legacy=await account("food-options-legacy"),legacySaved=await request("/api/coaching/profile",legacy,"PUT",{profile:profile(),expectedRevision:0});
  const missing=await request(`/api/coaching/food-options/${legacySaved.data.week.weekStart}`,legacy);assert.equal(missing.status,409);assert.equal(missing.data.code,"MEAL_PREFERENCES_REQUIRED");
  const unsure=await request("/api/coaching/profile",legacy,"PUT",{profile:profile({mealPreferences:mealPreferences({allergyStatus:"other_or_unsure",otherAllergies:"Uncommon spice reaction"})}),expectedRevision:1});
  const manual=await request(`/api/coaching/food-options/${unsure.data.week.weekStart}`,legacy);assert.equal(manual.status,200);assert.equal(manual.data.status,"manual_review");assert.deepEqual(manual.data.options,[]);
});

test("profile and weekly snapshot routes enforce mutation boundaries and optimistic revisions",async()=>{
  const member=await account("profile");
  assert.deepEqual((await request("/api/coaching/profile",member)).data.profile,null);
  assert.equal((await request("/api/coaching/week",member)).data.code,"COACHING_PROFILE_REQUIRED");
  assert.equal((await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0},{"X-CSRF-Token":"wrong"})).status,403);
  const wrongType=await request("/api/coaching/profile",member,"PUT",JSON.stringify({profile:profile(),expectedRevision:0}),{"Content-Type":"text/plain"});assert.equal(wrongType.status,415);assert.equal(wrongType.data.code,"JSON_REQUIRED");
  const wrongAccount=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0,expectedUserId:"someone-else"});assert.equal(wrongAccount.status,409);assert.equal(wrongAccount.data.code,"COACHING_ACCOUNT_CHANGED");
  const age18=await request("/api/coaching/profile",member,"PUT",{profile:profile({age:18}),expectedRevision:0});assert.equal(age18.status,400);assert.match(age18.data.error,/19 to 80/);
  for(const version of [2,3]){const unreviewed=await request("/api/coaching/profile",member,"PUT",{profile:profile({version,mealPreferences:version===2?mealPreferences():null}),expectedRevision:0});assert.equal(unreviewed.status,409);assert.equal(unreviewed.data.code,"COACHING_ACTIVITY_REVIEW_REQUIRED");}
  const nullSex=await request("/api/coaching/profile",member,"PUT",{profile:profile({bodyFatPercent:20,sexForEquation:null}),expectedRevision:0});assert.equal(nullSex.status,400);assert.match(nullSex.data.error,/required for a new or updated/);
  const saved=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0,expectedUserId:member.id});
  assert.equal(saved.status,200);assert.equal(saved.data.profile.revision,1);assert.equal(saved.data.profile.sessionsPerWeek,3);assert.equal(saved.data.week.profileRevision,1);assert.equal(saved.data.week.energyModelVersion,ENERGY_MODEL_VERSION);assert.equal(saved.data.week.training.sessions.length,3);assert.equal(saved.data.week.nutrition.dailyTargets.length,7);assert.equal(saved.data.logs.length,0);
  const week=await request("/api/coaching/week",member);assert.equal(week.status,200);assert.equal(week.data.week.planKey,saved.data.week.planKey);assert.equal(week.data.week.generatedAt,saved.data.week.generatedAt,"same-week reads reuse the persisted snapshot");
  const stale=await request("/api/coaching/profile",member,"PUT",{profile:profile({weightKg:81}),expectedRevision:0});assert.equal(stale.status,409);assert.equal(stale.data.code,"COACHING_PROFILE_CHANGED");assert.equal(stale.data.profile.weightKg,80);
  const invalid=await request("/api/coaching/profile",member,"PUT",{profile:{...profile(),userId:"untrusted"},expectedRevision:1});assert.equal(invalid.status,400);assert.match(invalid.data.error,/unsupported fields/);
  const updated=await request("/api/coaching/profile",member,"PUT",{profile:profile({weightKg:81}),expectedRevision:1});assert.equal(updated.status,200);assert.equal(updated.data.profile.revision,2);assert.equal(updated.data.week.profileRevision,2);assert.notEqual(updated.data.week.planKey,saved.data.week.planKey);
  assert.equal((await request("/api/coaching/profile",member,"DELETE",{})).status,405);
});

test("daily calorie, macro, morning-weight, and completeness logs are date-bounded, account-scoped, and conflict safe",async()=>{
  const owner=await account("logs"),other=await account("logs-other");
  const setup=await request("/api/coaching/profile",owner,"PUT",{profile:profile({caloriePattern:"flexible_day",flexibleDay:"Saturday"}),expectedRevision:0});assert.equal(setup.status,200);
  const date=setup.data.week.weekStart,target=setup.data.week.nutrition.dailyTargets.find((day)=>day.date===date).calories;
  assert.equal((await request(`/api/coaching/logs/${date}`,owner)).data.log,null);
  const partial=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:2000,proteinG:150},expectedRevision:0});assert.equal(partial.status,400);assert.equal(partial.data.code,"INVALID_COACHING_LOG");
  const invalidWeight=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:2000,morningWeightKg:34.9,complete:true},expectedRevision:0});assert.equal(invalidWeight.status,400);assert.equal(invalidWeight.data.code,"INVALID_COACHING_LOG");
  const wrongDate=setup.data.week.nextWeekStart;const outside=await request(`/api/coaching/logs/${wrongDate}`,owner,"PUT",{log:{calories:2000},expectedRevision:0});assert.equal(outside.status,400);assert.equal(outside.data.code,"COACHING_LOG_OUTSIDE_DIARY_WINDOW");
  const saved=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:target-100,proteinG:150,carbsG:220,fatG:70,morningWeightKg:80.2,complete:true},expectedRevision:0,expectedUserId:owner.id});
  assert.equal(saved.status,200);assert.equal(saved.data.log.revision,1);assert.equal(saved.data.log.remainingCalories,100);assert.equal(saved.data.log.overCalories,0);assert.equal(saved.data.log.morningWeightKg,80.2);assert.equal(saved.data.log.complete,true);
  const stale=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:9999},expectedRevision:0});assert.equal(stale.status,409);assert.equal(stale.data.code,"COACHING_LOG_CHANGED");assert.equal(stale.data.log.calories,target-100);
  const legacyUpdate=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:target},expectedRevision:1});assert.equal(legacyUpdate.status,200);assert.equal(legacyUpdate.data.log.morningWeightKg,80.2);assert.equal(legacyUpdate.data.log.complete,true,"omitted observation fields retain the stored values for older clients");
  const over=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:target+50,morningWeightKg:null,complete:false},expectedRevision:2});assert.equal(over.status,200);assert.equal(over.data.log.remainingCalories,0);assert.equal(over.data.log.overCalories,50);assert.equal(over.data.log.morningWeightKg,null);assert.equal(over.data.log.complete,false);
  const macrosOff=await request("/api/coaching/profile",owner,"PUT",{profile:profile({caloriePattern:"flexible_day",flexibleDay:"Saturday",macroPreference:null}),expectedRevision:1});assert.equal(macrosOff.status,200);
  const calorieOnly=await request(`/api/coaching/logs/${date}`,owner,"PUT",{log:{calories:target,morningWeightKg:79.8,complete:true},expectedRevision:3});assert.equal(calorieOnly.status,200);assert.deepEqual([calorieOnly.data.log.proteinG,calorieOnly.data.log.carbsG,calorieOnly.data.log.fatG],[150,220,70],"hidden macro fields must preserve existing observations");assert.equal(calorieOnly.data.log.morningWeightKg,79.8);assert.equal(calorieOnly.data.log.complete,true);
  const week=await request("/api/coaching/week",owner);assert.equal(week.data.logs.length,1);assert.equal(week.data.logs[0].revision,4);
  assert.deepEqual((await request("/api/coaching/profile",other)).data.profile,null);assert.equal((await request(`/api/coaching/logs/${date}`,other)).data.code,"COACHING_PROFILE_REQUIRED");
});

test("new weekly snapshots use only the bounded prior evidence window for a trend-informed estimate",async()=>{
  const member=await account("calibration"),weekStart=currentWeekStart(Date.now(),"Asia/Dubai"),database=new DatabaseSync(join(directory,"strata.sqlite"));
  try{
    const insert=database.prepare("INSERT INTO coaching_daily_logs(user_id,log_date,calories,protein_g,carbs_g,fat_g,morning_weight_kg,intake_complete,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
    for(let index=0;index<21;index+=1)insert.run(member.id,addDays(weekStart,index-21),2700,null,null,null,82.6-index*.02,1,1,Date.now()+index);
  }finally{database.close();}
  const saved=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0}),calibration=saved.data.week?.nutrition?.maintenance?.calibration;
  assert.equal(saved.status,200);assert.equal(calibration.status,"trend_informed");assert.equal(calibration.windowEnd,addDays(weekStart,-1));assert.deepEqual({complete:calibration.evidence.completeCalorieDays,weights:calibration.evidence.morningWeightDays},{complete:21,weights:21});assert.notEqual(calibration.appliedAdjustmentKcal,0);
  assert.equal(saved.data.week.nutrition.maintenance.targetKcal,saved.data.week.nutrition.maintenance.baselineKcal+calibration.appliedAdjustmentKcal);
  const replay=await request("/api/coaching/week",member);assert.equal(replay.status,200);assert.equal(replay.data.week.planKey,saved.data.week.planKey);assert.equal(replay.data.week.generatedAt,saved.data.week.generatedAt);
});

test("stored age-18 null-sex legacy profiles remain readable without changing their energy semantics",async()=>{
  const member=await account("legacy-energy"),database=new DatabaseSync(join(directory,"strata.sqlite")),legacy={...profile({version:1,age:18,bodyFatPercent:20,sexForEquation:null}),sessionsPerWeek:3};
  try{database.prepare("INSERT INTO coaching_profiles(user_id,profile_json,revision,updated_at) VALUES(?,?,?,?)").run(member.id,JSON.stringify(legacy),1,Date.now());}finally{database.close();}
  const read=await request("/api/coaching/profile",member);assert.equal(read.status,200);assert.equal(read.data.profile.age,18);assert.equal(read.data.profile.sexForEquation,null);
  const week=await request("/api/coaching/week",member);assert.equal(week.status,200);assert.equal(week.data.week.inputs.version,1);assert.equal(week.data.week.nutrition.energySemantics,"legacy_rmr_activity_multiplier");assert.equal(week.data.week.nutrition.primaryEquation,"legacy_cunningham_activity_fallback");assert.equal(week.data.week.nutrition.equation,"cunningham_1991");assert.equal(week.data.week.nutrition.maintenance.baselineKcal,2725);assert.equal(week.data.week.nutrition.maintenance.calibration.status,"legacy_profile");assert.equal(week.data.week.nutrition.maintenance.calibration.appliedAdjustmentKcal,0);
});

test("existing equipment-limited profiles keep their weekly dashboard and diary without claiming new equipment",async()=>{
  for(const equipment of ["Bodyweight","Cables","Resistance band"]){
    const member=await account(`limited-${equipment.toLowerCase().replaceAll(" ","-")}`),input={...profile({experience:"beginner",availableEquipment:[equipment],usualExercises:[]}),sessionsPerWeek:3},database=new DatabaseSync(join(directory,"strata.sqlite"));
    try{database.prepare("INSERT INTO coaching_profiles(user_id,profile_json,revision,updated_at) VALUES(?,?,?,?)").run(member.id,JSON.stringify(input),1,Date.now());}finally{database.close();}
    const read=await request("/api/coaching/week",member);assert.equal(read.status,200,JSON.stringify(read.data));
    assert.equal(read.data.week.training.summary.reviewNeeded,true);assert.equal(read.data.week.nutrition.dailyTargets.length,7);
    assert.deepEqual(read.data.week.inputs.availableEquipment,[equipment]);assert.equal(read.data.week.inputs.experience,"beginner");
    for(const session of read.data.week.training.sessions)if(session.status!=="ready"){assert.ok(session.missingRoles.length);assert.ok(session.readinessWarning);}
    const date=read.data.week.weekStart,saved=await request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories:2000,complete:true},expectedRevision:0});
    assert.equal(saved.status,200);assert.ok(saved.data.log.targetCalories>0);
    const replay=await request("/api/coaching/week",member);assert.equal(replay.status,200);assert.equal(replay.data.week.planKey,read.data.week.planKey);
  }
});

test("concurrent first reads return the same persisted weekly snapshot",async()=>{
  const member=await account("week-race"),created=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0});assert.equal(created.status,200);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));try{database.prepare("DELETE FROM coaching_weeks WHERE user_id=?").run(member.id);}finally{database.close();}
  const [first,second]=await Promise.all([request("/api/coaching/week",member),request("/api/coaching/week",member)]);assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(first.data.week.planKey,second.data.week.planKey);assert.equal(first.data.week.generatedAt,second.data.week.generatedAt);
});

test("coaching row mapping treats adapter string zero as false",()=>{
  const mapped=logPayload({log_date:"2030-03-04",calories:2000,protein_g:null,carbs_g:null,fat_g:null,morning_weight_kg:null,intake_complete:"0",revision:1,updated_at:1});assert.equal(mapped.complete,false);
});

test("deployment preserves a coherent saved week and historical diary edits retain their original targets",async()=>{
  const member=await account("snapshot-continuity"),created=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0});
  assert.equal(created.status,200);
  const current=structuredClone(created.data.week),sunday=addDays(current.weekStart,-1),previousStart=addDays(current.weekStart,-7),past={...structuredClone(current),weekStart:previousStart,weekEnd:sunday,profileRevision:1,planKey:"previous-saved-plan",nutrition:{...current.nutrition,dailyTargets:[{date:sunday,day:"Sunday",calories:2345,macros:null,kind:"standard"}]}};
  current.energyModelVersion="energy-planning-v2";current.generationVersion="coaching-week-v3";
  const database=new DatabaseSync(join(directory,"strata.sqlite"));
  try{
    database.prepare("UPDATE coaching_weeks SET snapshot_json=? WHERE user_id=? AND week_start=?").run(JSON.stringify(current),member.id,current.weekStart);
    database.prepare("INSERT INTO coaching_weeks(user_id,week_start,plan_key,profile_revision,snapshot_json,generated_at) VALUES(?,?,?,?,?,?)").run(member.id,previousStart,past.planKey,1,JSON.stringify(past),Date.now()-7*86400000);
  }finally{database.close();}
  const before=await request("/api/coaching/week",member);
  assert.equal(before.status,200);assert.equal(before.data.week.energyModelVersion,"energy-planning-v2");assert.equal(before.data.week.modelUpdateAvailable,true);
  assert.equal(before.data.week.generatedAt,current.generatedAt);assert.equal(before.data.week.planKey,current.planKey);
  assert.equal(before.data.week.logTargets.find(day=>day.date===sunday).calories,2345);
  const saved=await request(`/api/coaching/logs/${sunday}`,member,"PUT",{log:{calories:2200,complete:true,morningWeightKg:80},expectedRevision:0});
  assert.equal(saved.status,200);assert.equal(saved.data.log.targetCalories,2345);assert.equal(saved.data.log.remainingCalories,145);
  const unknownDate=addDays(previousStart,-1),unknown=await request(`/api/coaching/logs/${unknownDate}`,member,"PUT",{log:{calories:2100,complete:true},expectedRevision:0});
  assert.equal(unknown.status,200);assert.equal(unknown.data.log.targetCalories,null);assert.equal(unknown.data.log.remainingCalories,null);
  const after=await request("/api/coaching/week",member);
  assert.equal(after.data.week.planKey,current.planKey);assert.deepEqual(after.data.week.nutrition,current.nutrition);assert.equal(after.data.logs.length,2);
  const today=localDate(Date.now(),"Asia/Dubai");
  for(const outside of [addDays(today,1),addDays(today,-43)])assert.equal((await request(`/api/coaching/logs/${outside}`,member,"PUT",{log:{calories:2100},expectedRevision:0})).data.code,"COACHING_LOG_OUTSIDE_DIARY_WINDOW");
  const oldest=await request(`/api/coaching/logs/${addDays(today,-42)}`,member,"PUT",{log:{calories:2100},expectedRevision:0});assert.equal(oldest.status,200);
  const reviewed=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:1});
  assert.equal(reviewed.status,200);assert.equal(reviewed.data.week.energyModelVersion,ENERGY_MODEL_VERSION);assert.equal(reviewed.data.week.modelUpdateAvailable,false);assert.notEqual(reviewed.data.week.planKey,current.planKey);
});

test("expired Strata+ access denies existing coaching data without mutating it",async()=>{
  const member=await account("expired"),setup=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0}),date=setup.data.week.weekStart;
  assert.equal((await request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories:2000},expectedRevision:0})).status,200);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));
  const before={profile:database.prepare("SELECT profile_json,revision FROM coaching_profiles WHERE user_id=?").get(member.id),log:database.prepare("SELECT calories,revision FROM coaching_daily_logs WHERE user_id=? AND log_date=?").get(member.id,date)};
  database.prepare("UPDATE admin_account_controls SET grant_expires_at=? WHERE user_id=?").run(Date.now()-1,member.id);database.close();
  const attempts=[
    ["/api/coaching/profile","GET"],
    ["/api/coaching/profile","PUT",{profile:profile({weightKg:99}),expectedRevision:1}],
    ["/api/coaching/week","GET"],
    [`/api/coaching/food-options/${date}`,"GET"],
    [`/api/coaching/logs/${date}`,"GET"],
    [`/api/coaching/logs/${date}`,"PUT",{log:{calories:9999},expectedRevision:1}]
  ];
  for(const [path,method,body] of attempts){const response=await request(path,member,method,body);assert.equal(response.status,402,path);assert.equal(response.data.code,"DISCOVERY_ACCESS_REQUIRED");}
  const check=new DatabaseSync(join(directory,"strata.sqlite"),{readOnly:true}),after={profile:check.prepare("SELECT profile_json,revision FROM coaching_profiles WHERE user_id=?").get(member.id),log:check.prepare("SELECT calories,revision FROM coaching_daily_logs WHERE user_id=? AND log_date=?").get(member.id,date)};check.close();assert.deepEqual(after,before);
});

test("same-date logs remain isolated and reject a client-supplied different account",async()=>{
  const first=await account("isolation-a"),second=await account("isolation-b"),firstSetup=await request("/api/coaching/profile",first,"PUT",{profile:profile(),expectedRevision:0}),secondSetup=await request("/api/coaching/profile",second,"PUT",{profile:profile(),expectedRevision:0});
  const date=firstSetup.data.week.weekStart;assert.equal(secondSetup.data.week.weekStart,date);
  const mismatch=await request(`/api/coaching/logs/${date}`,first,"PUT",{log:{calories:1999},expectedRevision:0,expectedUserId:second.id});assert.equal(mismatch.status,409);assert.equal(mismatch.data.code,"COACHING_ACCOUNT_CHANGED");
  assert.equal((await request(`/api/coaching/logs/${date}`,first,"PUT",{log:{calories:1800},expectedRevision:0})).status,200);
  assert.equal((await request(`/api/coaching/logs/${date}`,second,"PUT",{log:{calories:2600},expectedRevision:0})).status,200);
  assert.equal((await request(`/api/coaching/logs/${date}`,first)).data.log.calories,1800);assert.equal((await request(`/api/coaching/logs/${date}`,second)).data.log.calories,2600);
});

test("profile and log compare-and-swap races have exactly one winner",async()=>{
  const member=await account("cas"),created=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0});assert.equal(created.status,200);
  const profileRace=await Promise.all([81,82].map((weightKg)=>request("/api/coaching/profile",member,"PUT",{profile:profile({weightKg}),expectedRevision:1})));
  assert.deepEqual(profileRace.map((item)=>item.status).sort(),[200,409]);const current=await request("/api/coaching/profile",member);assert.equal(current.data.profile.revision,2);assert.ok([81,82].includes(current.data.profile.weightKg));
  const date=(await request("/api/coaching/week",member)).data.week.weekStart,logRace=await Promise.all([1900,2100].map((calories)=>request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories},expectedRevision:0})));
  assert.deepEqual(logRace.map((item)=>item.status).sort(),[200,409]);const log=await request(`/api/coaching/logs/${date}`,member);assert.equal(log.data.log.revision,1);assert.ok([1900,2100].includes(log.data.log.calories));
});

test("the Athlete Profile keeps the ranking lens and the coaching profile telling one story",async()=>{
  const member=await account("athlete-profile");
  const before=await request("/api/profile",member);assert.equal(before.status,200);assert.equal(before.data.profile.training.source,"preferences");assert.equal(before.data.profile.body,null);
  const saved=await request("/api/coaching/profile",member,"PUT",{profile:profile({experience:"advanced",trainingGoal:"strength",availableEquipment:["Dumbbells"],movementLimitations:["no-overhead"]}),expectedRevision:0});
  assert.equal(saved.status,200);
  const mirrored=await request("/api/profile",member);
  assert.equal(mirrored.data.profile.training.source,"coaching");assert.equal(mirrored.data.profile.training.experience,"advanced");assert.deepEqual(mirrored.data.profile.training.workoutDays,["Monday","Wednesday","Friday"]);
  assert.equal(mirrored.data.profile.rankingLens.level,"Advanced");assert.equal(mirrored.data.profile.rankingLens.goal,"strength");assert.equal(mirrored.data.profile.rankingLens.days,3);assert.deepEqual(mirrored.data.profile.rankingLens.equipment,["Dumbbells"]);assert.deepEqual(mirrored.data.profile.rankingLens.limitations,["no-overhead"]);
  assert.equal(mirrored.data.profile.body.weightKg,80);assert.equal(mirrored.data.profile.coachingRevision,1);
  const lens=await request("/api/preferences",member,"PUT",{preferences:{version:1,goal:"hypertrophy",level:"Beginner",days:3,equipment:["Bodyweight"],preferences:["compound"],limitations:[]}});
  assert.equal(lens.status,200);
  const coaching=await request("/api/coaching/profile",member);
  assert.equal(coaching.data.profile.experience,"beginner");assert.equal(coaching.data.profile.trainingGoal,"hypertrophy");assert.deepEqual(coaching.data.profile.availableEquipment,["Bodyweight"]);assert.deepEqual(coaching.data.profile.movementLimitations,[]);
  assert.equal(coaching.data.profile.revision,2,"the mirrored write is an ordinary revision bump");
  assert.equal(coaching.data.profile.sessionMinutes,60,"coaching-only fields are untouched");
  const stale=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:1});
  assert.equal(stale.status,409);assert.equal(stale.data.code,"COACHING_PROFILE_CHANGED","a client that saved before the lens changed must reload rather than overwrite");
  assert.equal((await request("/api/profile")).status,401);
});

