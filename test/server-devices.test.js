"use strict";

const test=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{createServer}=require("node:http"),{randomBytes}=require("node:crypto");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {grantStrataPlus}=require("./support/strata-plus-access");

const ROOT=join(__dirname,".."),CLIENT_BASIC=`Basic ${Buffer.from("polar-client:polar-secret").toString("base64")}`;
const DAY=24*60*60*1000,SCOPE="sleep:read nightly_recharge:read continuous_samples:read training_sessions:read";
let server,directory,base,polar;
const isoDate=(time)=>new Date(time).toISOString().slice(0,10);
const datesBetween=(from,to)=>{const dates=[];for(let time=Date.parse(`${from}T00:00:00Z`),end=Date.parse(`${to}T00:00:00Z`);time<end;time+=DAY)dates.push(isoDate(time));return dates;};

/** Local V4 OAuth and data stand-in. It intentionally provides no V3 registration, deletion, or webhook API. */
function startPolar(){
  const grants=new Map([
    ["code-alpha",{access:"access-alpha",refresh:"refresh-alpha",user:1001}],
    ["code-beta",{access:"access-beta",refresh:"refresh-beta",user:1002}],
    ["code-delta",{access:"access-delta",refresh:"refresh-delta",user:1003}],
    ["code-zeta",{access:"access-zeta",refresh:"refresh-zeta",user:1003}],
    ["code-delta2",{access:"access-delta2",refresh:"refresh-delta2",user:1003}],
    ["code-epsilon",{access:"access-epsilon",refresh:"refresh-epsilon",user:1004,expires:1}]
  ]);
  const state={calls:[],grants,usedCodes:new Set(),tokens:new Map([...grants.values()].map((grant)=>[grant.access,grant])),refreshed:[]};
  const today=isoDate(Date.now()),nights=()=>Array.from({length:10},(_,index)=>isoDate(Date.now()-index*DAY));
  const http=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://polar.test");let body="";for await(const chunk of req)body+=chunk;
    state.calls.push({method:req.method,path:url.pathname,search:url.search,authorization:String(req.headers.authorization||""),body});
    const send=(status,data)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(data===undefined?"":JSON.stringify(data));};
    if(url.pathname==="/oauth/token"&&req.method==="POST"){
      if(req.headers.authorization!==CLIENT_BASIC)return send(401,{error:"invalid_client"});
      const input=new URLSearchParams(body);
      if(input.get("grant_type")==="authorization_code"){
        const code=String(input.get("code")||""),grant=grants.get(code);if(!grant||state.usedCodes.has(code))return send(400,{error:"invalid_grant"});state.usedCodes.add(code);
        return send(200,{access_token:grant.access,refresh_token:grant.refresh,token_type:"bearer",expires_in:grant.expires||3600,scope:SCOPE,jti:`grant-${grant.user}`});
      }
      const refresh=String(input.get("refresh_token")||""),grant=[...grants.values()].find((item)=>item.refresh===refresh);
      if(!grant)return send(400,{error:"invalid_grant"});const access=`${grant.access}-refreshed`,nextRefresh=`${grant.refresh}-rotated`;
      state.tokens.set(access,grant);grant.access=access;grant.refresh=nextRefresh;state.refreshed.push(refresh);
      return send(200,{access_token:access,refresh_token:nextRefresh,token_type:"bearer",expires_in:43200,scope:SCOPE});
    }
    const token=String(req.headers.authorization||"").replace(/^Bearer /,""),grant=state.tokens.get(token);if(!grant)return send(401,{});
    if(url.pathname==="/v4/data/sleeps"){
      if(!url.searchParams.has("features"))return send(200,{nightSleeps:nights().map((sleepDate)=>({sleepDate}))});
      const sleepDate=url.searchParams.get("from");return send(200,{nightSleeps:[{sleepDate,sleepResult:{hypnogram:{sleepStart:`${sleepDate}T00:00:00Z`,sleepEnd:`${sleepDate}T07:06:40Z`}},sleepScore:{sleepScore:80,scoreRate:3},sleepEvaluation:{asleepDuration:"25000s",phaseDurations:{light:"14000s",deep:"5000s",rem:"6000s",unknown:"0s"},interruptions:{totalDuration:"600s"}}}]});
    }
    if(url.pathname==="/v4/data/nightly-recharge-results")return send(200,{nightlyRechargeResults:{nightlyRechargeResults:nights().map((sleepResultDate)=>({sleepResultDate,recoveryIndicator:sleepResultDate===today?2:4,ansStatus:0,ansRate:3,meanNightlyRecoveryRri:1200,meanNightlyRecoveryRmssd:60,meanNightlyRecoveryRespirationInterval:4286}))}});
    if(url.pathname==="/v4/data/continuous-samples")return send(200,{continuousSamples:{heartRateSamplesPerDay:datesBetween(url.searchParams.get("from"),url.searchParams.get("to")).map((date)=>({date,samples:[{heartRate:48,offsetMillis:10800000},{heartRate:49,offsetMillis:11100000},{heartRate:50,offsetMillis:11400000},{heartRate:130,offsetMillis:64800000}]}))}});
    if(url.pathname==="/v4/data/training-sessions/list")return send(200,{trainingSessions:[{identifier:{id:`ex-${grant.user}`},startTime:`${today}T00:30:00Z`,timezoneOffsetMinutes:0,durationMillis:2700000,name:"RUNNING",calories:400,hrAvg:140,hrMax:170,trainingLoad:80}]});
    send(404,{});
  });
  return new Promise((resolve)=>http.listen(0,"127.0.0.1",()=>resolve({...state,state,http,url:`http://127.0.0.1:${http.address().port}`})));
}

async function launch(){
  polar=await startPolar();mkdirSync(join(ROOT,"test-runtime"),{recursive:true});directory=mkdtempSync(join(ROOT,"test-runtime","devices-http-"));
  server=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{...process.env,HOST:"127.0.0.1",PORT:"0",NODE_ENV:"test",ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRICE_ID:"",PADDLE_PRODUCT_ID:"",
    APP_BASE_URL:"",POLAR_REDIRECT_URI:"",POLAR_CLIENT_ID:"polar-client",POLAR_CLIENT_SECRET:"polar-secret",DEVICE_TOKEN_KEY:randomBytes(32).toString("base64"),DEVICE_TOKEN_KEY_PREVIOUS:"",
    POLAR_AUTH_URL:`${polar.url}/oauth/authorize`,POLAR_TOKEN_URL:`${polar.url}/oauth/token`,POLAR_API_URL:`${polar.url}/v4/data`,DEVICE_SYNC_INTERVAL_MS:"200"},stdio:["ignore","pipe","pipe"]});
  base=await new Promise((resolve,reject)=>{let output="",errors="";const timer=setTimeout(()=>reject(new Error(`Devices server startup timed out: ${errors}`)),6000);server.stdout.on("data",(chunk)=>{output=(output+chunk).slice(-4096);const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});server.stderr.on("data",(chunk)=>{errors=(errors+chunk).slice(-4096);});server.once("error",reject);server.once("exit",(code)=>reject(new Error(`Devices server exited ${code}: ${errors}`)));});
}
async function stop(){
  if(server&&server.exitCode===null)await new Promise((resolve)=>{const timer=setTimeout(()=>server.kill("SIGKILL"),2000);server.once("exit",()=>{clearTimeout(timer);resolve();});server.kill("SIGTERM");});
  await new Promise((resolve)=>polar?.http.close(resolve)||resolve());if(directory)rmSync(directory,{recursive:true,force:true});
}
async function request(path,account=null,method="GET",body,headers={}){
  const response=await fetch(`${base}${path}`,{method,redirect:"manual",headers:{Origin:base,"Content-Type":"application/json",...(account?{Cookie:account.cookie,"X-CSRF-Token":account.csrf}:{}),...headers},...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
  const text=await response.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data=text;}return {status:response.status,data,text,headers:response.headers,cookie:response.headers.get("set-cookie")?.split(";")[0]||""};
}
async function account(suffix,{plus=true}={}){
  const password="strong-devices-password-123",email=`devices-${suffix}@example.test`,signup=await request("/api/signup",null,"POST",{name:`Member ${suffix}`,email,password});assert.equal(signup.status,201);
  const me=await request("/api/me",{cookie:signup.cookie,csrf:""}),result={cookie:signup.cookie,csrf:me.data.csrfToken,id:me.data.user.id,email,password};if(plus)grantStrataPlus(directory,result.id);return result;
}
async function signIn(member){const login=await request("/api/login",null,"POST",{email:member.email,password:member.password});assert.equal(login.status,200);const me=await request("/api/me",{cookie:login.cookie,csrf:""});return {...member,cookie:login.cookie,csrf:me.data.csrfToken};}
async function authorize(member,code){
  const started=await request("/api/devices/polar/connect",member,"POST",{});assert.equal(started.status,200,JSON.stringify(started.data));const authorizeUrl=new URL(started.data.authorizeUrl),state=authorizeUrl.searchParams.get("state");
  const back=await request(`/api/devices/polar/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);return {authorizeUrl,back,returnCookie:back.cookie};
}
const complete=(member,returnCookie)=>request("/api/devices/polar/complete",{...member,cookie:[member.cookie,returnCookie].filter(Boolean).join("; ")},"POST",{});
async function until(check,label,timeoutMs=8000){const started=Date.now();while(Date.now()-started<timeoutMs){const value=await check();if(value)return value;await new Promise((resolve)=>setTimeout(resolve,100));}throw new Error(`Timed out waiting for ${label}`);}

test.before(launch);test.after(stop);

test("connected-device routes require a session, and every Polar feature requires Strata+",async()=>{
  for(const path of ["/api/devices","/api/wellness/today","/api/wellness/trends","/api/wellness/workouts"])assert.equal((await request(path)).status,401,path);
  const free=await account("free",{plus:false}),status=await request("/api/devices",free);assert.equal(status.status,200);assert.deepEqual({configured:status.data.configured,plus:status.data.plus,connection:status.data.connection},{configured:true,plus:false,connection:null});
  for(const [path,method] of [["/api/devices/polar/connect","POST"],["/api/devices/polar/complete","POST"],["/api/devices/polar/sync","POST"],["/api/devices/settings","PUT"],["/api/wellness/today","GET"],["/api/wellness/trends","GET"],["/api/wellness/workouts","GET"]]){
    const result=await request(path,free,method,method==="GET"?undefined:{});assert.equal(result.status,402,path);assert.equal(result.data.code,"DISCOVERY_ACCESS_REQUIRED");
  }
  const member=await account("guards");assert.equal((await request("/api/devices/polar/connect",member,"POST",{},{"X-CSRF-Token":"wrong"})).status,403);assert.equal((await request("/api/devices/polar/connect",member,"POST",{},{Origin:"https://evil.example"})).status,403);
  assert.equal((await request("/api/devices/polar/connect",member,"POST","{}",{"Content-Type":"text/plain"})).status,415);assert.equal((await request("/api/devices/polar/connect",member,"POST",{provider:"whoop"})).status,400);
  assert.equal((await request("/api/devices/polar/connect",member,"POST",{expectedUserId:"someone-else"})).status,409);assert.equal((await request("/api/devices/polar/connect",member)).status,405);
  assert.equal((await request("/api/devices/polar/sync",member,"POST",{})).status,404);assert.equal((await request("/api/wellness/today",member)).data.connected,false);assert.equal((await request("/api/devices/polar",member,"DELETE",{})).data.disconnected,false);
});

test("a member connects through V4 and sees recovery, sleep, heart rate, and workouts",async()=>{
  const member=await account("alpha"),{authorizeUrl,back,returnCookie}=await authorize(member,"code-alpha");
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`,`${polar.url}/oauth/authorize`);assert.equal(authorizeUrl.searchParams.get("scope"),SCOPE);assert.equal(authorizeUrl.searchParams.get("redirect_uri"),`${base}/api/devices/polar/callback`);
  assert.equal(back.status,303);assert.match(back.headers.get("set-cookie"),/^strata_device_return=.*HttpOnly; SameSite=Lax/);assert.equal(polar.calls.some((call)=>call.path==="/oauth/token"),false);
  const done=await complete(member,returnCookie);assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.connection.status,"active");for(const secret of ["access-alpha","refresh-alpha","1001","member_ref","token_sealed"])assert.equal(done.text.includes(secret),false,secret);
  assert.ok(polar.calls.some((call)=>call.path==="/oauth/token"&&call.authorization===CLIENT_BASIC));assert.equal(polar.calls.some((call)=>call.path.startsWith("/v3/")),false);assert.equal((await complete(member,returnCookie)).data.code,"DEVICES_CONNECT_EXPIRED");
  const synced=await until(async()=>{const result=await request("/api/devices",member);return result.data.connection?.lastSyncAt?result:null;},"the first V4 import");assert.deepEqual({status:synced.data.connection.status,lastError:synced.data.connection.lastError,settings:synced.data.connection.settings},{status:"active",lastError:null,settings:{recoverySuggestions:true}});
  const summary=(await request("/api/wellness/today",member)).data.summary;assert.equal(summary.recovery.label,"Poor");assert.equal(summary.stress.level,"usual");assert.equal(summary.sleep.asleepSeconds,25000);assert.equal(summary.heart.today.resting,49);assert.equal(summary.lighterSession.offer,true);
  const trends=await request("/api/wellness/trends?weeks=8",member);assert.equal(trends.data.trends.series.length,10);assert.equal(trends.data.trends.training.at(-1).cardioLoad,80);
  const workouts=await request("/api/wellness/workouts?days=7",member);assert.deepEqual(workouts.data.workouts.map((item)=>[item.sport,item.durationSeconds,item.cardioLoad]),[["Running",2700,80]]);
  const revision=synced.data.connection.revision,saved=await request("/api/devices/settings",member,"PUT",{provider:"polar",settings:{recoverySuggestions:false},expectedRevision:revision});assert.equal(saved.status,200);assert.equal((await request("/api/devices/polar/sync",member,"POST",{})).status,429);
  const exported=await request("/api/account/export",member,"POST",{});assert.equal(exported.data.devices.nights.length,10);assert.equal(exported.data.devices.workouts.length,1);assert.equal(exported.data.devices.days.length,28);for(const secret of ["access-alpha","refresh-alpha","token_sealed","member_ref","provider_user_id"])assert.equal(exported.text.includes(secret),false,secret);
  assert.equal((await request("/api/devices/polar",member,"DELETE",{})).data.disconnected,true);assert.equal(polar.calls.some((call)=>call.method==="DELETE"),false);assert.equal((await request("/api/devices",member)).data.connection,null);
  assert.deepEqual((await request("/api/account/export",member,"POST",{})).data.devices,{connections:[],nights:[],days:[],workouts:[]});
});

test("connect state stays session-bound; V4's missing stable subject is handled explicitly",async()=>{
  const beta=await account("beta");assert.equal((await request("/api/devices/polar/callback?state=short&code=x")).headers.get("location"),"/account.html?devices=polar-failed#connectedDevices");
  const declined=await request("/api/devices/polar/connect",beta,"POST",{}),state=new URL(declined.data.authorizeUrl).searchParams.get("state");assert.equal((await request(`/api/devices/polar/callback?state=${state}&error=access_denied`)).headers.get("location"),"/account.html?devices=polar-declined#connectedDevices");
  const started=await authorize(beta,"code-beta"),otherSignIn=await signIn(beta);assert.equal((await complete(otherSignIn,started.returnCookie)).data.code,"DEVICES_CONNECT_EXPIRED");
  const rejected=await authorize(beta,"code-unknown");assert.equal((await complete(beta,rejected.returnCookie)).data.code,"POLAR_CODE_REJECTED");
  const owner=await account("owner"),taker=await account("taker");assert.equal((await complete(owner,(await authorize(owner,"code-delta")).returnCookie)).status,200);
  // Polar V4 provides no documented stable subject, so independent grants for one Polar account cannot be de-duplicated safely.
  assert.equal((await complete(taker,(await authorize(taker,"code-zeta")).returnCookie)).status,200);
  assert.equal((await request("/api/devices/polar",owner,"DELETE",{})).data.disconnected,true);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));try{
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_revocations").get().count,0);
    assert.equal((await complete(owner,(await authorize(owner,"code-delta2")).returnCookie)).status,200);assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_revocations").get().count,0);
  }finally{database.close();}
});

test("expiring grants rotate before reads, polling replaces the removed V4 webhook route",async()=>{
  assert.equal((await request("/api/devices/polar/webhook",null,"POST",{})).status,404);
  const member=await account("refresh"),done=await complete(member,(await authorize(member,"code-epsilon")).returnCookie);assert.equal(done.status,200);
  await until(async()=>(await request("/api/devices",member)).data.connection?.lastSyncAt,"the refreshed import");assert.deepEqual(polar.refreshed,["refresh-epsilon"]);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));try{
    database.prepare("UPDATE device_connections SET status='reconnect' WHERE user_id=?").run(member.id);assert.equal((await request("/api/devices/polar/sync",member,"POST",{})).data.code,"DEVICES_RECONNECT");
    const earlier=Date.now()-10*60*1000;database.prepare("UPDATE device_connections SET status='active',last_sync_at=? WHERE user_id=?").run(earlier,member.id);
    const started=await request("/api/devices/polar/sync",member,"POST",{});assert.equal(started.status,202);await until(()=>Number(database.prepare("SELECT last_sync_at FROM device_connections WHERE user_id=?").get(member.id).last_sync_at)>earlier,"the requested polling sync");
  }finally{database.close();}
});
