"use strict";

const test=require("node:test"),assert=require("node:assert/strict");
const {spawn}=require("node:child_process"),{createServer}=require("node:http"),{createHmac,randomBytes}=require("node:crypto");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs"),{join}=require("node:path");
const {DatabaseSync}=require("node:sqlite");

const ROOT=join(__dirname,"..");
const CLIENT_BASIC=`Basic ${Buffer.from("polar-client:polar-secret").toString("base64")}`,WEBHOOK_SECRET="polar-webhook-secret";
const DAY=24*60*60*1000;
let server,directory,base,polar;

const isoDate=(time)=>new Date(time).toISOString().slice(0,10);

/** A stand-in for Polar's OAuth and AccessLink endpoints, holding one registration per Polar user. */
function startPolar(){
  const state={calls:[],registered:new Map(),deregistered:[],failDelete:false,grants:new Map([
    ["code-alpha",{token:"token-alpha",user:1001}],["code-beta",{token:"token-beta",user:1002}],["code-gamma",{token:"token-gamma",user:1001}],["code-delta",{token:"token-delta",user:1003}],["code-epsilon",{token:"token-epsilon",user:1004}]
  ])};
  const today=isoDate(Date.now());
  const nights=()=>Array.from({length:10},(_,index)=>isoDate(Date.now()-index*DAY));
  const http=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://polar.test");let body="";for await(const chunk of req)body+=chunk;
    state.calls.push({method:req.method,path:url.pathname,authorization:String(req.headers.authorization||""),body});
    const send=(status,data)=>{res.writeHead(status,{"Content-Type":"application/json"});res.end(data===undefined?"":JSON.stringify(data));};
    if(url.pathname==="/v2/oauth2/token"&&req.method==="POST"){
      if(req.headers.authorization!==CLIENT_BASIC)return send(401,{error:"invalid_client"});
      const grant=state.grants.get(new URLSearchParams(body).get("code"));
      return grant?send(200,{access_token:grant.token,token_type:"bearer",expires_in:315360000,x_user_id:grant.user}):send(400,{error:"invalid_grant"});
    }
    const token=String(req.headers.authorization||"").replace(/^Bearer /,""),user=[...state.grants.values()].find((grant)=>grant.token===token)?.user;
    if(!user)return send(401,{});
    if(url.pathname==="/v3/users"&&req.method==="POST"){if(state.registered.has(user))return send(409,{});state.registered.set(user,JSON.parse(body)["member-id"]);return send(200,{"polar-user-id":user});}
    const removal=url.pathname.match(/^\/v3\/users\/(\d+)$/);
    if(removal&&req.method==="DELETE"){if(state.failDelete)return send(503,{});state.registered.delete(Number(removal[1]));state.deregistered.push(Number(removal[1]));res.writeHead(204);return res.end();}
    if(!state.registered.has(user))return send(403,{});
    if(url.pathname==="/v3/users/sleep")return send(200,{nights:nights().map((date)=>({date,light_sleep:14000,deep_sleep:5000,rem_sleep:6000,sleep_score:80,sleep_charge:3,total_interruption_duration:600}))});
    if(url.pathname==="/v3/users/nightly-recharge")return send(200,{recharges:nights().map((date)=>({date,nightly_recharge_status:date===today?2:4,ans_charge:0,ans_charge_status:3,heart_rate_avg:50,heart_rate_variability_avg:60,breathing_rate_avg:14}))});
    const heart=url.pathname.match(/^\/v3\/users\/continuous-heart-rate\/(\d{4}-\d{2}-\d{2})$/);
    if(heart)return send(200,{date:heart[1],heart_rate_samples:[{heart_rate:48,sample_time:"03:00:00"},{heart_rate:49,sample_time:"03:05:00"},{heart_rate:50,sample_time:"03:10:00"},{heart_rate:130,sample_time:"18:00:00"}]});
    if(url.pathname==="/v3/exercises")return send(200,[{id:`ex-${user}`,start_time:`${today}T00:30:00`,start_time_utc_offset:0,duration:"PT45M",sport:"RUNNING",calories:400,heart_rate:{average:140,maximum:170},training_load:80}]);
    send(404,{});
  });
  return new Promise((resolve)=>http.listen(0,"127.0.0.1",()=>resolve({...state,state,http,url:`http://127.0.0.1:${http.address().port}`})));
}

async function launch(){
  polar=await startPolar();
  mkdirSync(join(ROOT,"test-runtime"),{recursive:true});directory=mkdtempSync(join(ROOT,"test-runtime","devices-http-"));
  server=spawn(process.execPath,["server.js"],{cwd:ROOT,env:{...process.env,HOST:"127.0.0.1",PORT:"0",NODE_ENV:"test",ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",STRATA_DATA_DIR:directory,TURSO_DATABASE_URL:"",TURSO_AUTH_TOKEN:"",EMAIL_VERIFICATION_ENABLED:"false",PADDLE_CHECKOUT_ENABLED:"false",PADDLE_CLIENT_TOKEN:"",PADDLE_API_KEY:"",PADDLE_WEBHOOK_SECRET:"",PADDLE_PRICE_ID:"",PADDLE_PRODUCT_ID:"",
    APP_BASE_URL:"",POLAR_REDIRECT_URI:"",POLAR_CLIENT_ID:"polar-client",POLAR_CLIENT_SECRET:"polar-secret",POLAR_WEBHOOK_SECRET:WEBHOOK_SECRET,DEVICE_TOKEN_KEY:randomBytes(32).toString("base64"),DEVICE_TOKEN_KEY_PREVIOUS:"",
    POLAR_AUTH_URL:`${polar.url}/oauth2/authorization`,POLAR_TOKEN_URL:`${polar.url}/v2/oauth2/token`,POLAR_API_URL:polar.url,DEVICE_SYNC_INTERVAL_MS:"200"},stdio:["ignore","pipe","pipe"]});
  base=await new Promise((resolve,reject)=>{let output="",errors="";const timer=setTimeout(()=>reject(new Error(`Devices server startup timed out: ${errors}`)),6000);server.stdout.on("data",(chunk)=>{output=(output+chunk).slice(-4096);const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});server.stderr.on("data",(chunk)=>{errors=(errors+chunk).slice(-4096);});server.once("error",reject);server.once("exit",(code)=>reject(new Error(`Devices server exited ${code}: ${errors}`)));});
}
async function stop(){
  if(server&&server.exitCode===null)await new Promise((resolve)=>{const timer=setTimeout(()=>server.kill("SIGKILL"),2000);server.once("exit",()=>{clearTimeout(timer);resolve();});server.kill("SIGTERM");});
  await new Promise((resolve)=>polar?.http.close(resolve)||resolve());
  if(directory)rmSync(directory,{recursive:true,force:true});
}
async function request(path,account=null,method="GET",body,headers={}){
  const response=await fetch(`${base}${path}`,{method,redirect:"manual",headers:{Origin:base,"Content-Type":"application/json",...(account?{Cookie:account.cookie,"X-CSRF-Token":account.csrf}:{}),...headers},...(body===undefined?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
  const text=await response.text();let data=null;try{data=text?JSON.parse(text):null;}catch{data=text;}
  return {status:response.status,data,text,headers:response.headers,cookie:response.headers.get("set-cookie")?.split(";")[0]||""};
}
async function account(suffix,{plus=true}={}){
  const password="strong-devices-password-123",email=`devices-${suffix}@example.test`;
  const signup=await request("/api/signup",null,"POST",{name:`Member ${suffix}`,email,password});assert.equal(signup.status,201);
  const me=await request("/api/me",{cookie:signup.cookie,csrf:""});const result={cookie:signup.cookie,csrf:me.data.csrfToken,id:me.data.user.id,email,password};
  if(plus)assert.ok([200,201].includes((await request("/api/discovery/trial",result,"POST",{})).status));
  return result;
}
async function signIn(member){const login=await request("/api/login",null,"POST",{email:member.email,password:member.password});assert.equal(login.status,200);const me=await request("/api/me",{cookie:login.cookie,csrf:""});return {...member,cookie:login.cookie,csrf:me.data.csrfToken};}
/** Starts connecting and follows Polar's redirect back to the callback, returning the parked code cookie. */
async function authorize(member,code){
  const started=await request("/api/devices/polar/connect",member,"POST",{});assert.equal(started.status,200,JSON.stringify(started.data));
  const authorizeUrl=new URL(started.data.authorizeUrl),state=authorizeUrl.searchParams.get("state");
  const back=await request(`/api/devices/polar/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`);
  return {started,authorizeUrl,state,back,returnCookie:back.cookie};
}
const complete=(member,returnCookie)=>request("/api/devices/polar/complete",{...member,cookie:[member.cookie,returnCookie].filter(Boolean).join("; ")},"POST",{});
async function until(check,label,timeoutMs=8000){const started=Date.now();while(Date.now()-started<timeoutMs){const value=await check();if(value)return value;await new Promise((resolve)=>setTimeout(resolve,100));}throw new Error(`Timed out waiting for ${label}`);}
const signed=(body)=>createHmac("sha256",WEBHOOK_SECRET).update(body).digest("hex");

test.before(launch);test.after(stop);

test("connected-device routes require a session, and every Polar feature requires Strata+",async()=>{
  for(const path of ["/api/devices","/api/wellness/today","/api/wellness/trends","/api/wellness/workouts"])assert.equal((await request(path)).status,401,path);
  const free=await account("free",{plus:false});
  const status=await request("/api/devices",free);
  assert.equal(status.status,200);assert.deepEqual({configured:status.data.configured,plus:status.data.plus,connection:status.data.connection},{configured:true,plus:false,connection:null});
  for(const [path,method] of [["/api/devices/polar/connect","POST"],["/api/devices/polar/complete","POST"],["/api/devices/polar/sync","POST"],["/api/devices/settings","PUT"],["/api/wellness/today","GET"],["/api/wellness/trends","GET"],["/api/wellness/workouts","GET"]]){
    const result=await request(path,free,method,method==="GET"?undefined:{});assert.equal(result.status,402,path);assert.equal(result.data.code,"DISCOVERY_ACCESS_REQUIRED");
  }
  const member=await account("guards");
  assert.equal((await request("/api/devices/polar/connect",member,"POST",{},{"X-CSRF-Token":"wrong"})).status,403);
  assert.equal((await request("/api/devices/polar/connect",member,"POST",{},{Origin:"https://evil.example"})).status,403);
  assert.equal((await request("/api/devices/polar/connect",member,"POST","{}",{"Content-Type":"text/plain"})).status,415);
  const extra=await request("/api/devices/polar/connect",member,"POST",{provider:"whoop"});assert.equal(extra.status,400);assert.equal(extra.data.code,"DEVICES_INVALID_REQUEST");
  const other=await request("/api/devices/polar/connect",member,"POST",{expectedUserId:"someone-else"});assert.equal(other.status,409);assert.equal(other.data.code,"DEVICES_ACCOUNT_CHANGED");
  const wrongMethod=await request("/api/devices/polar/connect",member);assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get("allow"),"POST");
  const notConnected=await request("/api/devices/polar/sync",member,"POST",{});assert.equal(notConnected.status,404);assert.equal(notConnected.data.code,"DEVICES_NOT_CONNECTED");
  const today=await request("/api/wellness/today",member);assert.equal(today.status,200);assert.equal(today.data.connected,false);assert.equal(today.data.connection,null);
  assert.deepEqual((await request("/api/devices/polar",member,"DELETE",{})).data.disconnected,false);
});

test("a Strata+ member connects their own Polar account and sees their recovery, sleep, heart rate, and workouts",async()=>{
  const member=await account("alpha");
  const {authorizeUrl,back,returnCookie}=await authorize(member,"code-alpha");
  assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`,`${polar.url}/oauth2/authorization`);
  assert.equal(authorizeUrl.searchParams.get("client_id"),"polar-client");assert.equal(authorizeUrl.searchParams.get("scope"),"accesslink.read_all");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"),`${base}/api/devices/polar/callback`);
  assert.equal(back.status,303);assert.equal(back.headers.get("location"),"/account.html?devices=polar-return#connectedDevices");
  const parked=back.headers.get("set-cookie");
  assert.match(parked,/^strata_device_return=/);assert.match(parked,/Path=\/api\/devices\/polar\/complete/);assert.match(parked,/HttpOnly/);assert.match(parked,/SameSite=Lax/);
  assert.equal(polar.calls.some((call)=>call.path==="/v2/oauth2/token"),false,"nothing is exchanged until the member's own session completes it");

  const done=await complete(member,returnCookie);
  assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.connection.status,"active");assert.equal(done.data.connection.importing,true);
  assert.match(done.headers.get("set-cookie"),/strata_device_return=;.*Max-Age=0/);
  for(const secret of ["token-alpha","1001","member_ref","token_sealed"])assert.equal(done.text.includes(secret),false,secret);
  assert.equal(polar.registered.has(1001),true);
  assert.ok(polar.calls.some((call)=>call.path==="/v3/users"&&call.authorization==="Bearer token-alpha"));
  const replay=await complete(member,returnCookie);assert.equal(replay.status,409);assert.equal(replay.data.code,"DEVICES_CONNECT_EXPIRED");

  const synced=await until(async()=>{const result=await request("/api/devices",member);return result.data.connection?.lastSyncAt?result:null;},"the first import");
  assert.deepEqual({plus:synced.data.plus,status:synced.data.connection.status,importing:synced.data.connection.importing,lastError:synced.data.connection.lastError,settings:synced.data.connection.settings},{plus:true,status:"active",importing:false,lastError:null,settings:{recoverySuggestions:true}});

  const today=await request("/api/wellness/today",member);
  assert.equal(today.status,200);const summary=today.data.summary;
  assert.equal(summary.state,"current");assert.equal(summary.recovery.label,"Poor");assert.equal(summary.stress.level,"usual");
  assert.deepEqual(summary.lighterSession,{offer:true,reason:"recovery",note:null});assert.equal(summary.sleep.asleepSeconds,25000);assert.equal(summary.heart.today.resting,49);
  const trends=await request("/api/wellness/trends?weeks=8",member);
  assert.equal(trends.status,200);assert.equal(trends.data.trends.weeks,8);assert.equal(trends.data.trends.series.length,10);assert.equal(trends.data.trends.training.length,8);assert.equal(trends.data.trends.training.at(-1).cardioLoad,80);
  assert.equal((await request("/api/wellness/trends?weeks=3",member)).data.trends.weeks,4,"unsupported ranges fall back to four weeks");
  const workouts=await request("/api/wellness/workouts?days=7",member);
  assert.equal(workouts.status,200);assert.deepEqual(workouts.data.workouts.map((item)=>[item.sport,item.durationSeconds,item.cardioLoad]),[["Running",2700,80]]);

  const revision=synced.data.connection.revision;
  const invalid=await request("/api/devices/settings",member,"PUT",{provider:"polar",settings:{recoverySuggestions:"no"},expectedRevision:revision});assert.equal(invalid.status,400);
  const saved=await request("/api/devices/settings",member,"PUT",{provider:"polar",settings:{recoverySuggestions:false},expectedRevision:revision});
  assert.equal(saved.status,200);assert.deepEqual(saved.data.connection.settings,{recoverySuggestions:false});
  const stale=await request("/api/devices/settings",member,"PUT",{provider:"polar",settings:{recoverySuggestions:true},expectedRevision:revision});assert.equal(stale.status,409);assert.equal(stale.data.code,"DEVICES_CHANGED");
  assert.deepEqual((await request("/api/wellness/today",member)).data.summary.lighterSession,{offer:false,reason:null,note:null},"turning suggestions off removes the offer");
  const soon=await request("/api/devices/polar/sync",member,"POST",{});assert.equal(soon.status,429);assert.equal(soon.data.code,"DEVICES_SYNC_TOO_SOON");assert.ok(soon.data.retryAt>Date.now());

  const exported=await request("/api/account/export",member,"POST",{});
  assert.equal(exported.status,200);assert.equal(exported.data.devices.connections[0].provider,"polar");assert.deepEqual(exported.data.devices.connections[0].settings,{recoverySuggestions:false});
  assert.equal(exported.data.devices.nights.length,10);assert.equal(exported.data.devices.workouts.length,1);assert.ok(exported.data.devices.days.length>=28);
  for(const secret of ["token-alpha","token_sealed","tokenSealed","member_ref","provider_user_id"])assert.equal(exported.text.includes(secret),false,secret);

  const disconnected=await request("/api/devices/polar",member,"DELETE",{});
  assert.equal(disconnected.status,200);assert.equal(disconnected.data.disconnected,true);
  assert.deepEqual(polar.deregistered,[1001]);assert.ok(polar.calls.some((call)=>call.method==="DELETE"&&call.path==="/v3/users/1001"&&call.authorization==="Bearer token-alpha"));
  assert.equal((await request("/api/devices",member)).data.connection,null);
  const after=await request("/api/account/export",member,"POST",{});assert.deepEqual(after.data.devices,{connections:[],nights:[],days:[],workouts:[]},"disconnecting deletes the imported data");
});

test("connect requests are single-use, stay with the sign-in that started them, and one Polar account links to one member",async()=>{
  const beta=await account("beta");
  const bad=await request("/api/devices/polar/callback?state=short&code=x");assert.equal(bad.headers.get("location"),"/account.html?devices=polar-failed#connectedDevices");assert.equal(bad.cookie,"");
  const unknown=await request(`/api/devices/polar/callback?state=${"a".repeat(43)}&code=x`);assert.equal(unknown.headers.get("location"),"/account.html?devices=polar-expired#connectedDevices");
  const declined=await request("/api/devices/polar/connect",beta,"POST",{}),declinedState=new URL(declined.data.authorizeUrl).searchParams.get("state");
  const denied=await request(`/api/devices/polar/callback?state=${declinedState}&error=access_denied`);assert.equal(denied.headers.get("location"),"/account.html?devices=polar-declined#connectedDevices");
  assert.equal((await request(`/api/devices/polar/callback?state=${declinedState}&code=code-beta`)).headers.get("location"),"/account.html?devices=polar-expired#connectedDevices","a declined request cannot be reused");
  const oddCode=await authorize(beta,"code with spaces");assert.equal(oddCode.back.headers.get("location"),"/account.html?devices=polar-failed#connectedDevices");

  const missing=await complete(beta,"");assert.equal(missing.status,409);assert.equal(missing.data.code,"DEVICES_CONNECT_EXPIRED");
  const started=await authorize(beta,"code-beta"),otherSignIn=await signIn(beta);
  const elsewhere=await complete(otherSignIn,started.returnCookie);assert.equal(elsewhere.status,409,"another sign-in of the same member cannot finish it");assert.equal(elsewhere.data.code,"DEVICES_CONNECT_EXPIRED");
  const intruder=await account("intruder");
  assert.equal((await complete(intruder,started.returnCookie)).data.code,"DEVICES_CONNECT_EXPIRED","another member cannot finish it");

  const rejected=await authorize(beta,"code-unknown");const rejection=await complete(beta,rejected.returnCookie);assert.equal(rejection.status,400);assert.equal(rejection.data.code,"POLAR_CODE_REJECTED");

  const owner=await account("owner");
  assert.equal((await complete(owner,(await authorize(owner,"code-delta")).returnCookie)).status,200);
  const taker=await account("taker");
  const taken=await complete(taker,(await authorize(taker,"code-delta")).returnCookie);
  assert.equal(taken.status,409);assert.equal(taken.data.code,"DEVICES_ALREADY_LINKED");assert.equal((await request("/api/devices",taker)).data.connection,null);

  // Reconnecting after a disconnect Polar never heard about still works, and the stale revocation is dropped.
  polar.state.failDelete=true;
  assert.equal((await request("/api/devices/polar",owner,"DELETE",{})).data.disconnected,true);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));
  try{
    assert.deepEqual(database.prepare("SELECT provider,provider_user_id FROM device_revocations").all().map((row)=>({...row})),[{provider:"polar",provider_user_id:"1003"}]);
    polar.state.failDelete=false;
    const again=await complete(owner,(await authorize(owner,"code-delta")).returnCookie);
    assert.equal(again.status,200,JSON.stringify(again.data));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_revocations").get().count,0);
    assert.equal(polar.registered.has(1003),true,"Polar's existing registration is kept");
  }finally{database.close();}
});

test("Polar webhooks are signature-checked and only make a connection sync sooner",async()=>{
  const ping=await request("/api/devices/polar/webhook",null,"POST",{event:"PING",timestamp:"2026-09-28T10:00:00Z"},{Origin:""});assert.equal(ping.status,200);
  const member=await account("hooked");
  assert.equal((await complete(member,(await authorize(member,"code-epsilon")).returnCookie)).status,200);
  await until(async()=>(await request("/api/devices",member)).data.connection?.lastSyncAt,"the hooked import");
  const body=JSON.stringify({event:"SLEEP",user_id:1004,entity_id:"x",timestamp:"2026-09-28T10:00:00Z"});
  assert.equal((await request("/api/devices/polar/webhook",null,"POST",body,{Origin:""})).status,401);
  assert.equal((await request("/api/devices/polar/webhook",null,"POST",body,{Origin:"","Polar-Webhook-Signature":signed(`${body} `)})).status,401);
  assert.equal((await request("/api/devices/polar/webhook",null,"POST","not json",{Origin:""})).status,400);
  assert.equal((await request("/api/devices/polar/webhook")).status,405);
  const database=new DatabaseSync(join(directory,"strata.sqlite"));
  try{
    const before=Number(database.prepare("SELECT next_sync_at FROM device_connections WHERE provider_user_id='1004'").get().next_sync_at);
    assert.ok(before>Date.now()+60*60*1000,"after a sync the next check is the next day");
    const accepted=await request("/api/devices/polar/webhook",null,"POST",body,{Origin:"","Polar-Webhook-Signature":signed(body)});
    assert.equal(accepted.status,200);
    assert.ok(Number(database.prepare("SELECT next_sync_at FROM device_connections WHERE provider_user_id='1004'").get().next_sync_at)<=Date.now()+60*1000);

    // Sync now waits for a reconnect when Polar stopped accepting the token, and otherwise starts right away.
    database.prepare("UPDATE device_connections SET status='reconnect' WHERE provider_user_id='1004'").run();
    const reconnect=await request("/api/devices/polar/sync",member,"POST",{});assert.equal(reconnect.status,409);assert.equal(reconnect.data.code,"DEVICES_RECONNECT");
    const earlier=Date.now()-10*60*1000;
    database.prepare("UPDATE device_connections SET status='active',last_sync_at=? WHERE provider_user_id='1004'").run(earlier);
    const started=await request("/api/devices/polar/sync",member,"POST",{});
    assert.equal(started.status,202);assert.equal(started.data.connection.importing,true);
    await until(()=>Number(database.prepare("SELECT last_sync_at FROM device_connections WHERE provider_user_id='1004'").get().last_sync_at)>earlier,"the requested sync");
  }finally{database.close();}
});
