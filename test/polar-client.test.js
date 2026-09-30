"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {POLAR_SCOPES,createPolarClient,parsePolarCredentials,polarError,serializePolarCredentials}=require("../src/polar-client");

const settings={polar:{clientId:"client-id",clientSecret:"client-secret",authorizeUrl:"https://auth.polar.test/oauth/authorize",tokenUrl:"https://auth.polar.test/oauth/token",apiBase:"https://api.polar.test/v4/data"}};
const scope=POLAR_SCOPES.join(" ");

/** A scripted fetch: each call takes the next answer and records what STRATA sent. */
function scriptedFetch(answers){
  const calls=[];
  async function fetchImpl(url,init={}){
    calls.push({url:String(url),method:init.method||"GET",headers:init.headers||{},body:init.body,signal:init.signal});
    const next=answers.shift();if(!next)throw new Error("Unexpected Polar request");if(next instanceof Error)throw next;
    const {status=200,body=null,headers={}}=next;
    return new Response(body===null||status===204?null:typeof body==="string"?body:JSON.stringify(body),{status,headers});
  }
  return {fetchImpl,calls};
}
const credentials=(overrides={})=>({version:4,accessToken:"access-old",refreshToken:"refresh-old",expiresAt:10_000,scopes:[...POLAR_SCOPES],...overrides});

test("the authorize address asks only for STRATA's granular V4 read scopes",()=>{
  const client=createPolarClient({settings,fetchImpl:scriptedFetch([]).fetchImpl});
  const url=new URL(client.authorizeUrl({state:"state-value",redirectUri:"https://strata.test/api/devices/polar/callback"}));
  assert.equal(url.origin+url.pathname,settings.polar.authorizeUrl);
  assert.deepEqual(Object.fromEntries(url.searchParams),{response_type:"code",client_id:"client-id",redirect_uri:"https://strata.test/api/devices/polar/callback",scope,state:"state-value"});
});

test("V4 credentials are versioned, validated, and reject sealed V3 access tokens",()=>{
  const value=serializePolarCredentials(credentials());
  assert.deepEqual(parsePolarCredentials(value),credentials());
  for(const invalid of ["member-token",JSON.stringify({...credentials(),version:3}),JSON.stringify({...credentials(),refreshToken:""}),JSON.stringify({...credentials(),expiresAt:null}),JSON.stringify({...credentials(),scopes:["sleep:read"]})])
    assert.throws(()=>parsePolarCredentials(invalid),(error)=>error.code==="POLAR_V4_RECONNECT"&&error.status===401);
});

test("exchanging a code uses Basic credentials and requires a complete V4 grant",async()=>{
  const {fetchImpl,calls}=scriptedFetch([
    {body:{access_token:"access-new",refresh_token:"refresh-new",token_type:"Bearer",expires_in:43200,scope,jti:"ignored"}},
    {status:400,body:{error:"invalid_grant"}},
    {body:{access_token:"access",expires_in:43200,scope}},
    {body:{access_token:"access",refresh_token:"refresh",expires_in:43200,scope:"sleep:read"}},
    {body:"not json",headers:{"Content-Type":"application/json"}}
  ]);
  const client=createPolarClient({settings,fetchImpl,now:()=>1000});
  assert.deepEqual(await client.exchangeCode("the-code","https://strata.test/cb"),{version:4,accessToken:"access-new",refreshToken:"refresh-new",expiresAt:1000+43200*1000,scopes:[...POLAR_SCOPES]});
  assert.equal(calls[0].method,"POST");assert.equal(calls[0].url,settings.polar.tokenUrl);
  assert.equal(calls[0].headers.Authorization,`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)),{grant_type:"authorization_code",code:"the-code",redirect_uri:"https://strata.test/cb"});
  assert.ok(calls[0].signal instanceof AbortSignal,"every Polar request has a timeout");
  await assert.rejects(client.exchangeCode("used","https://strata.test/cb"),(error)=>error.code==="POLAR_CODE_REJECTED"&&error.status===400);
  await assert.rejects(client.exchangeCode("missing","https://strata.test/cb"),(error)=>error.code==="POLAR_BAD_RESPONSE");
  await assert.rejects(client.exchangeCode("scopes","https://strata.test/cb"),(error)=>error.code==="POLAR_BAD_RESPONSE");
  await assert.rejects(client.exchangeCode("broken","https://strata.test/cb"),(error)=>error.code==="POLAR_BAD_RESPONSE");
});

test("near-expiry credentials refresh once and rotate the sealed grant",async()=>{
  const {fetchImpl,calls}=scriptedFetch([{body:{access_token:"access-new",refresh_token:"refresh-new",token_type:"bearer",expires_in:43200,scope}},{status:400,body:{error:"invalid_grant"}}]);
  let time=1_000_000;const client=createPolarClient({settings,fetchImpl,now:()=>time});
  const fresh=credentials({expiresAt:time+10*60*1000});assert.deepEqual(await client.refreshCredentials(fresh),{credentials:fresh,refreshed:false});assert.equal(calls.length,0);
  const old=credentials({expiresAt:time+60*1000});const result=await client.refreshCredentials(old);
  assert.deepEqual(result,{credentials:{version:4,accessToken:"access-new",refreshToken:"refresh-new",expiresAt:time+43200*1000,scopes:[...POLAR_SCOPES]},refreshed:true});
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)),{grant_type:"refresh_token",refresh_token:"refresh-old"});
  await assert.rejects(client.refreshCredentials(old),(error)=>error.code==="POLAR_AUTH"&&error.status===401);
});

test("V4 reads use exclusive ranges, repeated sleep features, and one continuous-samples request",async()=>{
  const {fetchImpl,calls}=scriptedFetch([
    {body:{nightSleeps:[{sleepDate:"2026-09-27"},{sleepDate:"bad"},{sleepDate:"2026-09-27"}]}},
    {body:{nightSleeps:[{sleepDate:"2026-09-27",sleepScore:{sleepScore:80}}]}},
    {body:{nightlyRechargeResults:{nightlyRechargeResults:[]}}},
    {body:{continuousSamples:{heartRateSamplesPerDay:[]}}},
    {body:{trainingSessions:[]}},
    {status:204}
  ]);
  const client=createPolarClient({settings,fetchImpl});
  assert.deepEqual(await client.sleep("token","2026-09-01","2026-09-29"),{nightSleeps:[{sleepDate:"2026-09-27",sleepScore:{sleepScore:80}}]});
  assert.deepEqual(await client.nightlyRecharge("token","2026-09-01","2026-09-29"),{nightlyRechargeResults:{nightlyRechargeResults:[]}});
  assert.deepEqual(await client.heartRate("token","2026-09-01","2026-09-29"),{continuousSamples:{heartRateSamplesPerDay:[]}});
  assert.deepEqual(await client.exercises("token","2026-09-01","2026-09-29"),{trainingSessions:[]});
  assert.equal(await client.sleep("token","2026-09-01","2026-09-29"),null);
  for(const call of calls)assert.equal(call.headers.Authorization,"Bearer token");
  assert.equal(new URL(calls[0].url).pathname,"/v4/data/sleeps");assert.deepEqual([...new URL(calls[0].url).searchParams.entries()],[ ["from","2026-09-01"],["to","2026-09-29"] ]);
  const detail=new URL(calls[1].url);assert.equal(detail.searchParams.get("to"),"2026-09-28");assert.deepEqual(detail.searchParams.getAll("features"),["sleep-result","sleep-evaluation","sleep-score"]);
  assert.equal(new URL(calls[2].url).pathname,"/v4/data/nightly-recharge-results");
  assert.deepEqual(new URL(calls[3].url).searchParams.getAll("features"),["heart-rate-samples"]);
  assert.equal(new URL(calls[4].url).pathname,"/v4/data/training-sessions/list");
});

test("bad ranges, wrong routes, malformed envelopes, and network failures are typed",async()=>{
  const {fetchImpl}=scriptedFetch([{status:404},{status:401},{status:403},{status:503},{status:418},{body:{}},new TypeError("fetch failed"),Object.assign(new Error("slow"),{name:"TimeoutError"})]);
  const client=createPolarClient({settings,fetchImpl});
  for(const range of [["2026-09-01","2026-09-01"],["bad","2026-09-02"],["2026-01-01","2026-09-01"]])await assert.rejects(client.exercises("t",...range),(error)=>error.code==="POLAR_RANGE");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_BAD_RESPONSE"&&/404/.test(error.message));
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_AUTH");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_AUTH");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_UNAVAILABLE");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_BAD_RESPONSE"&&/418/.test(error.message));
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_BAD_RESPONSE");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_UNAVAILABLE");
  await assert.rejects(client.exercises("t","2026-09-01","2026-09-02"),(error)=>error.code==="POLAR_TIMEOUT");
  const error=polarError("X","message");assert.equal(error.status,502);assert.equal(error.code,"X");
});

test("the client observes reported limits when present and honours 429 answers",async()=>{
  let time=1_000_000;
  const {fetchImpl,calls}=scriptedFetch([
    {body:{trainingSessions:[]},headers:{"RateLimit-Usage":"399, 100","RateLimit-Limit":"500, 5000","RateLimit-Reset":"600, 80000"}},
    {body:{trainingSessions:[]},headers:{"RateLimit-Usage":"400, 100","RateLimit-Limit":"500, 5000","RateLimit-Reset":"600, 80000"}},
    {status:429,headers:{"Retry-After":"30"}},{status:429}
  ]);
  const client=createPolarClient({settings,fetchImpl,now:()=>time}),read=()=>client.exercises("t","2026-09-01","2026-09-02");
  await read();assert.equal(client.blockedUntil(),0);await read();assert.equal(client.blockedUntil(),time+600*1000);
  await assert.rejects(read(),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+600*1000);assert.equal(calls.length,2);
  time+=600*1000;await assert.rejects(read(),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+30*1000);
  time+=30*1000;await assert.rejects(read(),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+60*1000);
});
