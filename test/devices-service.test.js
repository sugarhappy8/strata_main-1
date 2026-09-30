"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {createHmac,randomBytes}=require("node:crypto");
const {devicesSettings,keyId,tokenKey}=require("../src/devices-config");
const {open,seal,sha256}=require("../src/devices-crypto");
const {CONSENT_VERSION,createDevicesService,publicConnection}=require("../src/devices");

const KEY=randomBytes(32).toString("base64"),NOW=Date.parse("2026-09-28T09:00:00Z");
const SETTINGS=devicesSettings({POLAR_CLIENT_ID:"client",POLAR_CLIENT_SECRET:"secret",DEVICE_TOKEN_KEY:KEY,POLAR_WEBHOOK_SECRET:"hook",APP_BASE_URL:"https://strata.test"});
const KEYS=[{id:keyId(tokenKey(KEY)),key:tokenKey(KEY)}];
const STATE="s".repeat(43);

function response(){return {status:0,body:null,headers:{},location:""};}
const http={
  json:(res,status,body,headers={})=>{res.status=status;res.body=body;res.headers=headers;},
  redirect:(res,location,headers={})=>{res.status=303;res.location=location;res.headers=headers;},
  bodyJson:async(req)=>req.body||{},
  bodyBuffer:async(req)=>Buffer.from(req.raw||"")
};
function request(method,{headers={},...overrides}={}){return {method,headers:{"content-type":"application/json",...headers},session:{id:"member",token_hash:"session-hash",csrf_token:"csrf"},...overrides};}
function harness({store={},polar={},sync={},settings=SETTINGS,rate=()=>true,plus=true,unique}={}){
  const calls=[],revocations=[];
  const fakeStore={
    async deviceConnection(){return null;},async deviceConnectionByProviderUser(){return null;},async insertDeviceConnectState(record){calls.push(["state",record]);return true;},
    async readDeviceConnectState(){return {used_at:null,expires_at:NOW+60000};},async discardDeviceConnectState(){},
    async consumeDeviceConnectState(){return {provider:"polar",redirect_uri:"https://strata.test/api/devices/polar/callback"};},
    async cancelDeviceRevocations(...args){calls.push(["cancel",...args]);},
    async upsertDeviceConnection(record){calls.push(["upsert",record]);return {user_id:record.userId,provider:"polar",status:"active",settings_json:record.settingsJson,connected_at:record.connectedAt,revision:1};},
    async deleteDeviceData(){return {provider_user_id:"111",token_sealed:seal(KEYS,"old-token")};},
    async insertDeviceRevocation(record){revocations.push(record);},
    async updateDeviceSettings(){return null;},
    async wellnessNights(){return [];},async wellnessDays(){return [];},async wellnessWorkouts(){return [];},async workouts(){return null;},
    ...store
  };
  const fakePolar={authorizeUrl:({state})=>`https://flow.polar.test/?state=${state}`,exchangeCode:async()=>({accessToken:"new-token",providerUserId:"222",expiresAt:null}),
    registerUser:async()=>({registered:true}),deregisterUser:async(...args)=>{calls.push(["deregister",...args]);return {removed:true};},...polar};
  const fakeSync={syncConnection:async()=>({status:"synced"}),markWebhook:async(id)=>calls.push(["webhook",id]),started:0,stopped:0,start(){this.started+=1;},stop(){this.stopped+=1;},...sync};
  const logs=[];
  const service=createDevicesService({store:fakeStore,settings,http,polar:fakePolar,sync:fakeSync,now:()=>NOW,
    auth:{requireSession:async(req,res)=>{if(!req.session){http.json(res,401,{error:"Sign in required."});return null;}return req.session;},validCsrf:(req)=>req.headers["x-csrf-token"]!=="wrong"},
    requireAccess:async(req,res)=>{if(!plus){http.json(res,402,{code:"DISCOVERY_ACCESS_REQUIRED"});return null;}return req.session;},
    trustedOrigin:(req)=>req.headers.origin!=="https://evil.test",rateAllowed:(req,key,max,windowMs)=>rate(key,max,windowMs),hasAccess:async()=>plus,
    logger:{info:(name)=>logs.push(name),warn:(name)=>logs.push(name),error:(name)=>logs.push(name)},...(unique?{isUniqueViolation:unique}:{})});
  return {service,calls,revocations,logs,sync:fakeSync};
}
async function call(service,method,path,overrides={}){const res=response(),handled=await service.handleApi(request(method,overrides),res,new URL(`https://strata.test${path}`));return {...res,handled};}

test("connected-device routes answer only their own paths and methods",async()=>{
  const {service}=harness();
  assert.equal((await call(service,"GET","/api/other")).handled,false);
  const wrong=await call(service,"POST","/api/wellness/today");assert.equal(wrong.status,405);assert.equal(wrong.headers.Allow,"GET");
  const head=await call(service,"HEAD","/api/wellness/today");assert.equal(head.status,200);
  const signedOut=await call(service,"GET","/api/devices",{session:null});assert.equal(signedOut.status,401);
  assert.equal((await call(service,"DELETE","/api/devices/polar",{session:null})).status,401);
  assert.throws(()=>createDevicesService({}),/Connected devices require/);
  assert.deepEqual(publicConnection(null),null);
  assert.deepEqual(publicConnection({provider:"polar",status:"active",settings_json:"not json",revision:"2",last_sync_at:null}).settings,{recoverySuggestions:true});
  assert.equal(CONSENT_VERSION,"2026-10-polar-1");
});

test("reads and connection attempts are rate limited and fail closed when Polar is not set up",async()=>{
  const limited=harness({rate:(key)=>!/devices:(read|connect)/.test(key)});
  const read=await call(limited.service,"GET","/api/devices");assert.equal(read.status,429);assert.equal(read.body.code,"DEVICES_RATE_LIMIT");
  assert.equal((await call(limited.service,"GET","/api/wellness/trends")).status,429);
  assert.equal((await call(limited.service,"POST","/api/devices/polar/connect",{body:{}})).status,429);
  const off=harness({settings:devicesSettings({})});
  const connect=await call(off.service,"POST","/api/devices/polar/connect",{body:{}});assert.equal(connect.status,503);assert.equal(connect.body.code,"DEVICES_NOT_CONFIGURED");
  off.service.start();assert.equal(off.sync.started,0,"the sync loop stays off without settings");off.service.stop();assert.equal(off.sync.stopped,1);
  const on=harness();on.service.start();assert.equal(on.sync.started,1);
  const suspended=harness({store:{insertDeviceConnectState:async()=>false}});
  assert.equal((await call(suspended.service,"POST","/api/devices/polar/connect",{body:{}})).body.code,"DEVICES_ACCOUNT_CHANGED");
  const connected=await call(on.service,"POST","/api/devices/polar/connect",{body:{}});
  assert.equal(connected.status,200);assert.match(connected.body.authorizeUrl,/^https:\/\/flow\.polar\.test\/\?state=[A-Za-z0-9_-]{43}$/);
  const state=on.calls.find((entry)=>entry[0]==="state")[1];
  assert.equal(state.stateHash,sha256(new URL(connected.body.authorizeUrl).searchParams.get("state")));assert.equal(state.sessionHash,"session-hash");assert.equal(state.redirectUri,"https://strata.test/api/devices/polar/callback");
  assert.equal((await call(on.service,"POST","/api/devices/polar/connect",{body:{},headers:{"x-csrf-token":"wrong"}})).status,403);
});

test("the redirect back from Polar is rate limited and never links anything by itself",async()=>{
  const limited=harness({rate:(key)=>key!=="devices:callback"});
  assert.equal((await call(limited.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=abc`,{session:null})).location,"/account.html?devices=polar-failed#connectedDevices");
  const used=harness({store:{readDeviceConnectState:async()=>({used_at:NOW-1,expires_at:NOW+1000})}});
  assert.equal((await call(used.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=abc`,{session:null})).location,"/account.html?devices=polar-expired#connectedDevices");
  const expired=harness({store:{readDeviceConnectState:async()=>({used_at:null,expires_at:NOW})}});
  assert.equal((await call(expired.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=abc`,{session:null})).location,"/account.html?devices=polar-expired#connectedDevices");
  const failed=harness();
  assert.equal((await call(failed.service,"GET",`/api/devices/polar/callback?state=${STATE}&error=server_error`,{session:null})).location,"/account.html?devices=polar-failed#connectedDevices");
  assert.equal((await call(failed.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=${"x".repeat(600)}`,{session:null})).location,"/account.html?devices=polar-failed#connectedDevices");
  const ok=await call(failed.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=abc`,{session:null});
  assert.match(ok.headers["Set-Cookie"],/^strata_device_return=s{43}\.abc; Path=\/api\/devices\/polar\/complete; HttpOnly; SameSite=Lax; Max-Age=600$/);
  const secure=harness({settings:devicesSettings({POLAR_CLIENT_ID:"client",POLAR_CLIENT_SECRET:"secret",DEVICE_TOKEN_KEY:KEY,SECURE_COOKIES:"true"})});
  assert.match((await call(secure.service,"GET",`/api/devices/polar/callback?state=${STATE}&code=abc`,{session:null})).headers["Set-Cookie"],/; Secure$/);
});

test("completing a connection maps Polar failures, replaces a different Polar account, and handles races",async()=>{
  const cookie={cookie:`other=1; strata_device_return=${STATE}.the-code`};
  const complete=(service,extra={})=>call(service,"POST","/api/devices/polar/complete",{body:{},headers:{...cookie,...extra}});
  const unreadable=await complete(harness().service,{cookie:"strata_device_return=%E0%A4%A"});assert.equal(unreadable.body.code,"DEVICES_CONNECT_EXPIRED");
  const rejected=harness({polar:{exchangeCode:async()=>{throw Object.assign(new Error("Polar did not accept this sign-in."),{code:"POLAR_CODE_REJECTED"});}}});
  const answer=await complete(rejected.service);assert.equal(answer.status,400);assert.match(answer.headers["Set-Cookie"],/Max-Age=0/);
  const down=harness({polar:{registerUser:async()=>{throw Object.assign(new Error("401"),{code:"POLAR_AUTH",status:401});}}});
  const unavailable=await complete(down.service);assert.equal(unavailable.status,503,"a Polar sign-in problem is never reported as the member's own session");assert.equal(unavailable.body.code,"POLAR_AUTH");
  const bug=harness({polar:{exchangeCode:async()=>{throw new TypeError("bug");}}});
  await assert.rejects(complete(bug.service),/bug/);

  const replacing=harness({store:{deviceConnection:async()=>({provider_user_id:"111",settings_json:"{\"recoverySuggestions\":false}"})}});
  const replaced=await complete(replacing.service);
  assert.equal(replaced.status,200);assert.equal(replaced.body.connection.importing,true);
  assert.deepEqual(replacing.calls.filter((entry)=>entry[0]==="cancel"),[["cancel","polar","222"]],"a pending revocation for the new Polar account is dropped");
  assert.deepEqual(replacing.calls.find((entry)=>entry[0]==="deregister"),["deregister","old-token","111"],"the previous Polar account is released");
  const record=replacing.calls.find((entry)=>entry[0]==="upsert")[1];
  assert.equal(record.settingsJson,JSON.stringify({recoverySuggestions:true}),"another Polar account starts with default settings");assert.equal(open(KEYS,record.tokenSealed),"new-token");assert.equal(record.consentVersion,CONSENT_VERSION);

  const same=harness({store:{deviceConnection:async()=>({provider_user_id:"222",settings_json:"{\"recoverySuggestions\":false}"})}});
  await complete(same.service);assert.equal(same.calls.find((entry)=>entry[0]==="upsert")[1].settingsJson,"{\"recoverySuggestions\":false}","reconnecting keeps the member's settings");
  const race=harness({store:{upsertDeviceConnection:async()=>{throw new Error("UNIQUE constraint failed: device_connections.provider, device_connections.provider_user_id");}}});
  assert.equal((await complete(race.service)).body.code,"DEVICES_ALREADY_LINKED");
  const customRace=harness({unique:()=>true,store:{upsertDeviceConnection:async()=>{throw new Error("duplicate");}}});
  assert.equal((await complete(customRace.service)).body.code,"DEVICES_ALREADY_LINKED");
  const broken=harness({store:{upsertDeviceConnection:async()=>{throw new Error("disk full");}}});
  await assert.rejects(complete(broken.service),/disk full/);
  const gone=harness({store:{upsertDeviceConnection:async()=>null}});
  assert.equal((await complete(gone.service)).body.code,"DEVICES_ACCOUNT_CHANGED");
  const failingImport=harness({sync:{syncConnection:async()=>{throw new Error("sync crashed");}}});
  assert.equal((await complete(failingImport.service)).status,200);await new Promise(setImmediate);assert.ok(failingImport.logs.includes("device.sync_start_failed"));
});

test("disconnect queues a revocation when Polar cannot be reached and skips tokens it cannot read",async()=>{
  const down=harness({polar:{deregisterUser:async()=>{throw Object.assign(new Error("down"),{code:"POLAR_UNAVAILABLE"});}}});
  const result=await call(down.service,"DELETE","/api/devices/polar",{body:{}});
  assert.equal(result.body.disconnected,true);assert.equal(down.revocations.length,1);assert.equal(down.revocations[0].providerUserId,"111");assert.equal(down.revocations[0].nextAttemptAt,NOW+60000);
  const lostKey=harness({store:{deleteDeviceData:async()=>({provider_user_id:"111",token_sealed:"v1.unknown.a.b.c"})}});
  assert.equal((await call(lostKey.service,"DELETE","/api/devices/polar",{body:{}})).body.disconnected,true);assert.equal(lostKey.revocations.length,0);
  const csrf=await call(harness().service,"DELETE","/api/devices/polar",{body:{},headers:{"x-csrf-token":"wrong"}});assert.equal(csrf.status,403);
  const origin=await call(harness().service,"DELETE","/api/devices/polar",{body:{},headers:{origin:"https://evil.test"}});assert.equal(origin.body.code,"DEVICES_ORIGIN_REQUIRED");
});

test("settings and wellness reads validate their input",async()=>{
  const {service}=harness();
  for(const body of [{provider:"whoop",settings:{recoverySuggestions:true},expectedRevision:1},{provider:"polar",settings:[],expectedRevision:1},{provider:"polar",settings:{recoverySuggestions:true,extra:1},expectedRevision:1},{provider:"polar",settings:{recoverySuggestions:true},expectedRevision:0}]){
    assert.equal((await call(service,"PUT","/api/devices/settings",{body})).status,400,JSON.stringify(body));
  }
  assert.equal((await call(service,"PUT","/api/devices/settings",{body:{provider:"polar",settings:{recoverySuggestions:true},expectedRevision:1}})).body.code,"DEVICES_CHANGED");
  const reconnect=harness({store:{deviceConnection:async()=>({status:"reconnect",provider:"polar",settings_json:"{}"})}});
  assert.equal((await call(reconnect.service,"POST","/api/devices/polar/sync",{body:{}})).body.code,"DEVICES_RECONNECT");
  const connected=harness({store:{deviceConnection:async()=>({status:"active",provider:"polar",settings_json:"{}",last_sync_at:NOW-1000}),workouts:async()=>[{summary_json:"not json"},{summary_json:JSON.stringify({status:"completed",date:"2026-09-27"})}]}});
  const trends=await call(connected.service,"GET","/api/wellness/trends?weeks=12&date=2026-09-28");
  assert.equal(trends.body.trends.weeks,12);assert.equal(trends.body.trends.training.at(-1).strataWorkouts,1);
  const farDate=await call(connected.service,"GET","/api/wellness/today?date=2026-01-01");assert.equal(farDate.body.today,"2026-09-28","a date far from the server's today is ignored");
  const workouts=await call(connected.service,"GET","/api/wellness/workouts?days=500");assert.deepEqual(workouts.body.workouts,[]);
  const lapsed=harness({plus:false});assert.equal((await call(lapsed.service,"GET","/api/wellness/today")).status,402);
  const status=await call(lapsed.service,"GET","/api/devices");assert.equal(status.status,200);assert.equal(status.body.plus,false);
});

test("webhooks need a signature, a configured secret, and a sane Polar user",async()=>{
  const body=JSON.stringify({event:"EXERCISE",user_id:12345}),signature=createHmac("sha256","hook").update(body).digest("hex");
  const hook=async(service,raw,headers={},method="POST")=>{const res=response();await service.handleWebhook({method,headers,raw},res);return res;};
  const {service,calls}=harness();
  assert.equal((await hook(service,body,{"polar-webhook-signature":signature})).status,200);assert.deepEqual(calls.filter((entry)=>entry[0]==="webhook"),[["webhook","12345"]]);
  assert.equal((await hook(service,JSON.stringify({event:"SLEEP",user_id:"abc"}),{"polar-webhook-signature":createHmac("sha256","hook").update(JSON.stringify({event:"SLEEP",user_id:"abc"})).digest("hex")})).status,200);
  assert.equal(calls.filter((entry)=>entry[0]==="webhook").length,1,"an unusable Polar user is ignored");
  const unsigned=harness({settings:devicesSettings({POLAR_CLIENT_ID:"client",POLAR_CLIENT_SECRET:"secret",DEVICE_TOKEN_KEY:KEY})});
  assert.equal((await hook(unsigned.service,body,{"polar-webhook-signature":signature})).status,401,"no secret means no accepted events");assert.ok(unsigned.logs.includes("device.webhook_rejected"));
  const flooded=harness({rate:(key)=>key!=="devices:webhook"});const limited=await hook(flooded.service,body,{"polar-webhook-signature":signature});
  assert.equal(limited.status,429);assert.equal(limited.headers["Retry-After"],"60");
  assert.equal((await hook(service,body,{},"GET")).status,405);
});
