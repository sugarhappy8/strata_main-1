"use strict";

const test=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{mkdirSync,mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {grantStrataPlus}=require("./support/strata-plus-access");
const ROOT=join(__dirname,"..");let server,directory,base;

async function launch(){
  mkdirSync(join(ROOT,"test-runtime"),{recursive:true});directory=mkdtempSync(join(ROOT,"test-runtime","data-layer-http-"));
  server=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{...process.env,HOST:"127.0.0.1",PORT:"0",NODE_ENV:"test",ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRICE_ID:"",PADDLE_PRODUCT_ID:""},stdio:["ignore","pipe","pipe"]});
  base=await new Promise((resolve,reject)=>{let output="",errors="";const timer=setTimeout(()=>reject(new Error(`Data-layer server startup timed out: ${errors}`)),6000);server.stdout.on("data",(chunk)=>{output=(output+chunk).slice(-4096);const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});server.stderr.on("data",(chunk)=>{errors=(errors+chunk).slice(-4096);});server.once("error",reject);server.once("exit",(code)=>reject(new Error(`Coaching server exited ${code}: ${errors}`)));});
}
async function stop(){if(server&&server.exitCode===null)await new Promise((resolve)=>{const timer=setTimeout(()=>server.kill("SIGKILL"),2000);server.once("exit",()=>{clearTimeout(timer);resolve();});server.kill("SIGTERM");});if(directory)rmSync(directory,{recursive:true,force:true});}
async function request(path,account=null,method="GET",body,headers={}){const response=await fetch(`${base}${path}`,{method,headers:{Origin:base,"Content-Type":"application/json",...(account?{Cookie:account.cookie,"X-CSRF-Token":account.csrf}:{}),...headers},...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});return {status:response.status,data:await response.json(),cookie:response.headers.get("set-cookie")?.split(";")[0]||""};}
async function account(suffix,{plus=true}={}){const signup=await request("/api/signup",null,"POST",{name:`Data ${suffix}`,email:`data-${suffix}@example.test`,password:"strong-coaching-password-123"});assert.equal(signup.status,201);const me=await request("/api/me",{cookie:signup.cookie,csrf:""});const result={cookie:signup.cookie,csrf:me.data.csrfToken,id:me.data.user.id};if(plus)grantStrataPlus(directory,result.id);return result;}
function profile(overrides={}){
  const version=overrides.version??4,activity=version===4?{dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate"}:{lifestyleActivity:"moderately_active"};
  return {version,measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",experience:"intermediate",...activity,workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,usualExercises:[{exerciseId:"flat-dumbbell-press",maxSets:4,maxReps:10,maxWeightKg:30}],availableEquipment:[],movementLimitations:[],caloriePattern:"zigzag",flexibleDay:null,macroPreference:"balanced",timeZone:"Asia/Dubai",...overrides};
}

test.before(launch);test.after(stop);

const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const today=()=>new Date().toISOString().slice(0,10),weekday=(date)=>DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay()+6)%7];
const emptyWeek=()=>Object.fromEntries(DAYS.map(day=>[day,[]]));
function completedWorkout(id,date,startedAt,planDay=""){return {id,title:"Strength",planDay,date,status:"completed",startedAt,completedAt:startedAt+50*60000,elapsedSeconds:3000,restEndsAt:null,entries:[{id:"entry-1",exerciseId:"flat-dumbbell-press",measurement:"reps",loadType:"external",unit:"kg",prescribedReps:"8–12",sets:[{reps:10,weight:20,seconds:null,completed:true},{reps:9,weight:20,seconds:null,completed:true}]}]};}

test("the data routes require a session, and the Training Log and snapshots require Strata+",async()=>{
  for(const path of ["/api/profile","/api/training-log","/api/snapshots"])assert.equal((await request(path)).status,401,path);
  const free=await account("free",{plus:false});
  assert.equal((await request("/api/profile",free)).status,200,"every member has an Athlete Profile");
  for(const path of ["/api/training-log","/api/snapshots"]){const result=await request(path,free);assert.equal(result.status,402,path);assert.equal(result.data.code,"DISCOVERY_ACCESS_REQUIRED");}
  const member=await account("ranges");
  assert.equal((await request("/api/training-log?from=2026-01-01&to=2026-12-31",member)).data.code,"INVALID_TRAINING_LOG_RANGE");
  assert.equal((await request("/api/snapshots?from=2026-01-01&to=2026-03-01",member)).data.code,"INVALID_SNAPSHOT_RANGE");
  assert.equal((await request("/api/snapshots",member,"POST",{})).status,405);
});

test("plan saves are tagged by source and the Training Log carries the tag",async()=>{
  const member=await account("plan-source"),date=today(),day=weekday(date),current=await request("/api/plan",member);
  const plan={version:1,restDay:null,restDays:[],days:{...emptyWeek(),[day]:[{instanceId:"today-press-1",exerciseId:"flat-dumbbell-press",sets:3,reps:"8–12"}]}};
  const ai=await request("/api/plan",member,"PUT",{plan,expectedPlanUpdatedAt:current.data.planUpdatedAt,source:"ai"});assert.equal(ai.status,200);
  let log=await request(`/api/training-log?from=${date}&to=${date}`,member);
  assert.deepEqual(log.data.entries.map(entry=>[entry.kind,entry.source,entry.status]),[["planned","ai","planned"]],"an accepted Strata AI week is tagged as AI");
  const manual=await request("/api/plan",member,"PUT",{plan:{...plan,days:{...plan.days,[day]:[{instanceId:"today-press-1",exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"}]}},expectedPlanUpdatedAt:ai.data.planUpdatedAt,source:"system"});assert.equal(manual.status,200);
  log=await request(`/api/training-log?from=${date}&to=${date}`,member);assert.equal(log.data.entries[0].source,"manual","clients cannot claim a system source");assert.equal(log.data.entries[0].totalSets,4);
});

test("a finished workout and a matching Polar session become one Training Log entry and a done day",async()=>{
  const member=await account("polar-link"),date=today(),started=Date.now()-2*3600000;
  const posted=await request("/api/workouts",member,"POST",{workout:completedWorkout("strength-today",date,started)});assert.equal(posted.status,201,JSON.stringify(posted.data));
  const database=new DatabaseSync(join(directory,"strata.sqlite"),{timeout:5000});
  try{database.prepare("INSERT INTO wellness_workouts(user_id,provider,external_id,started_at,local_date,duration_seconds,sport,calories,hr_avg,hr_max,cardio_load,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(member.id,"polar","polar-ex-1",started+5*60000,date,2400,"Strength training",310,118,161,38.5,Date.now());}finally{database.close();}
  const log=await request(`/api/training-log?from=${date}&to=${date}`,member);assert.equal(log.status,200);
  assert.deepEqual(log.data.entries.map(entry=>[entry.kind,entry.source,entry.status]),[["workout","manual","completed"]],"the Polar session is not a second entry");
  assert.equal(log.data.entries[0].device.externalId,"polar-ex-1");assert.equal(log.data.entries[0].device.cardioLoad,38.5);
  const check=new DatabaseSync(join(directory,"strata.sqlite"),{timeout:5000});
  try{assert.deepEqual(check.prepare("SELECT external_id,workout_id,method FROM training_links WHERE user_id=?").all(member.id).map(row=>({...row})),[{external_id:"polar-ex-1",workout_id:"strength-today",method:"time_overlap"}]);}finally{check.close();}
  const snapshots=await request(`/api/snapshots?from=${date}&to=${date}`,member);assert.equal(snapshots.status,200);
  const snapshot=snapshots.data.snapshots[0];assert.equal(snapshot.date,date);assert.equal(snapshot.training.status,"extra","a workout started outside the plan is extra training");
  assert.equal(snapshot.training.done[0].cardioLoad,38.5);assert.equal(snapshot.brief,null);
});

test("a diary entry rebuilds that day's snapshot",async()=>{
  const member=await account("diary-snapshot");
  const saved=await request("/api/coaching/profile",member,"PUT",{profile:profile(),expectedRevision:0});assert.equal(saved.status,200);
  const date=saved.data.week.logTargets?.[0]?.date||today();
  assert.equal((await request(`/api/coaching/logs/${date}`,member,"PUT",{log:{calories:2150,proteinG:150,carbsG:220,fatG:70},expectedRevision:0})).status,200);
  const snapshots=await request(`/api/snapshots?from=${date}&to=${date}`,member);assert.equal(snapshots.status,200);
  assert.equal(snapshots.data.snapshots[0].nutrition.calories,2150);assert.ok(snapshots.data.snapshots[0].sources.includes("manual"));
});
