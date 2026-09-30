"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {createHmac}=require("node:crypto");
const {createPolarClient,polarError,validWebhookSignature}=require("../src/polar-client");

const settings={polar:{clientId:"client-id",clientSecret:"client-secret",authorizeUrl:"https://flow.polar.test/oauth2/authorization",tokenUrl:"https://remote.polar.test/v2/oauth2/token",apiBase:"https://api.polar.test"}};

/** A scripted fetch: each call takes the next answer and records what STRATA sent. */
function scriptedFetch(answers){
  const calls=[];
  async function fetchImpl(url,init={}){
    calls.push({url:String(url),method:init.method||"GET",headers:init.headers||{},body:init.body,signal:init.signal});
    const next=answers.shift();
    if(!next)throw new Error("Unexpected Polar request");
    if(next instanceof Error)throw next;
    const {status=200,body=null,headers={}}=next;
    return new Response(body===null||status===204?null:typeof body==="string"?body:JSON.stringify(body),{status,headers});
  }
  return {fetchImpl,calls};
}

test("the authorize address asks only for AccessLink read access and carries the state",()=>{
  const client=createPolarClient({settings,fetchImpl:scriptedFetch([]).fetchImpl});
  const url=new URL(client.authorizeUrl({state:"state-value",redirectUri:"https://strata.test/api/devices/polar/callback"}));
  assert.equal(url.origin+url.pathname,settings.polar.authorizeUrl);
  assert.deepEqual(Object.fromEntries(url.searchParams),{response_type:"code",client_id:"client-id",redirect_uri:"https://strata.test/api/devices/polar/callback",scope:"accesslink.read_all",state:"state-value"});
});

test("exchanging a code uses the app's Basic credentials and validates Polar's answer",async()=>{
  const {fetchImpl,calls}=scriptedFetch([
    {body:{access_token:"member-token",token_type:"bearer",expires_in:3600,x_user_id:12345}},
    {status:400,body:{error:"invalid_grant"}},
    {body:{access_token:"member-token",x_user_id:"not-a-number"}},
    {body:"not json",headers:{"Content-Type":"application/json"}},
    {body:{access_token:"member-token",x_user_id:1}}
  ]);
  const client=createPolarClient({settings,fetchImpl,now:()=>1000});
  assert.deepEqual(await client.exchangeCode("the-code","https://strata.test/cb"),{accessToken:"member-token",providerUserId:"12345",expiresAt:1000+3600*1000});
  assert.equal(calls[0].method,"POST");assert.equal(calls[0].url,settings.polar.tokenUrl);
  assert.equal(calls[0].headers.Authorization,`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)),{grant_type:"authorization_code",code:"the-code",redirect_uri:"https://strata.test/cb"});
  assert.ok(calls[0].signal instanceof AbortSignal,"every Polar request has a timeout");
  await assert.rejects(client.exchangeCode("used","https://strata.test/cb"),(error)=>error.code==="POLAR_CODE_REJECTED"&&error.status===400);
  await assert.rejects(client.exchangeCode("odd","https://strata.test/cb"),(error)=>error.code==="POLAR_BAD_RESPONSE");
  await assert.rejects(client.exchangeCode("broken","https://strata.test/cb"),(error)=>error.code==="POLAR_BAD_RESPONSE");
  assert.equal((await client.exchangeCode("no-expiry","https://strata.test/cb")).expiresAt,null);
});

test("member requests send the member's own token and treat empty answers as no data",async()=>{
  const {fetchImpl,calls}=scriptedFetch([
    {status:200,body:{member_id:"ref"}},{status:409,body:{}},
    {status:204},{status:404},{status:401},
    {body:{nights:[]}},{status:204},{body:{recharges:[]}},{status:404},{body:{heart_rate_samples:[]}},{body:[{id:"e1"}]}
  ]);
  const client=createPolarClient({settings,fetchImpl});
  assert.deepEqual(await client.registerUser("token-a","member-ref"),{registered:true});
  assert.equal(calls[0].url,"https://api.polar.test/v3/users");assert.equal(calls[0].headers.Authorization,"Bearer token-a");assert.deepEqual(JSON.parse(calls[0].body),{"member-id":"member-ref"});
  assert.deepEqual(await client.registerUser("token-a","member-ref"),{registered:false});
  for(let index=0;index<3;index+=1)assert.deepEqual(await client.deregisterUser("token-a","12345"),{removed:true});
  assert.equal(calls[2].method,"DELETE");assert.equal(calls[2].url,"https://api.polar.test/v3/users/12345");
  assert.deepEqual(await client.sleep("token-a"),{nights:[]});assert.equal(await client.sleep("token-a"),null);
  assert.deepEqual(await client.nightlyRecharge("token-a"),{recharges:[]});assert.equal(await client.nightlyRecharge("token-a"),null);
  assert.deepEqual(await client.heartRate("token-a","2026-09-28"),{heart_rate_samples:[]});assert.equal(calls.at(-1).url,"https://api.polar.test/v3/users/continuous-heart-rate/2026-09-28");
  assert.deepEqual(await client.exercises("token-a"),[{id:"e1"}]);assert.equal(calls.at(-1).url,"https://api.polar.test/v3/exercises");
});

test("Polar failures become typed errors a sync can act on",async()=>{
  const {fetchImpl}=scriptedFetch([{status:401},{status:403},{status:503},{status:418},{status:500},new TypeError("fetch failed"),Object.assign(new Error("slow"),{name:"TimeoutError"})]);
  const client=createPolarClient({settings,fetchImpl});
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_AUTH"&&error.status===401);
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_AUTH");
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_UNAVAILABLE"&&error.status===503);
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_BAD_RESPONSE"&&/418/.test(error.message));
  await assert.rejects(client.deregisterUser("t","1"),(error)=>error.code==="POLAR_UNAVAILABLE");
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_UNAVAILABLE");
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_TIMEOUT");
  const error=polarError("X","message");assert.equal(error.status,502);assert.equal(error.code,"X");
});

test("the client stops at 80% of a Polar rate-limit window and honours 429 answers",async()=>{
  let time=1_000_000;
  const {fetchImpl,calls}=scriptedFetch([
    {body:{nights:[]},headers:{"RateLimit-Usage":"399, 100","RateLimit-Limit":"500, 5000","RateLimit-Reset":"600, 80000"}},
    {body:{nights:[]},headers:{"RateLimit-Usage":"400, 100","RateLimit-Limit":"500, 5000","RateLimit-Reset":"600, 80000"}},
    {status:429,headers:{"Retry-After":"30"}},
    {status:429}
  ]);
  const client=createPolarClient({settings,fetchImpl,now:()=>time});
  await client.sleep("t");assert.equal(client.blockedUntil(),0,"below 80% nothing waits");
  await client.sleep("t");assert.equal(client.blockedUntil(),time+600*1000);
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+600*1000);
  assert.equal(calls.length,2,"a blocked request never reaches Polar");
  time+=600*1000;
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+30*1000);
  time+=30*1000;
  await assert.rejects(client.sleep("t"),(error)=>error.code==="POLAR_RATE_LIMIT"&&error.retryAt===time+60*1000,"a bare 429 waits a minute");
});

test("webhook management uses the app credentials, and signatures are checked over the raw body",async()=>{
  const {fetchImpl,calls}=scriptedFetch([{status:201,body:{data:{id:"hook",signature_secret_key:"secret"}}},{body:{data:[]}},{status:204}]);
  const client=createPolarClient({settings,fetchImpl});
  assert.deepEqual(await client.webhook("POST","",{events:["EXERCISE"],url:"https://strata.test/api/devices/polar/webhook"}),{data:{id:"hook",signature_secret_key:"secret"}});
  assert.equal(calls[0].url,"https://api.polar.test/v3/webhooks");assert.equal(calls[0].headers.Authorization,`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);assert.equal(calls[0].headers["Content-Type"],"application/json");
  assert.deepEqual(await client.webhook("GET",""),{data:[]});assert.equal(calls[1].headers["Content-Type"],undefined);assert.equal(calls[1].body,undefined);
  assert.equal(await client.webhook("DELETE","/hook"),null);assert.equal(calls[2].url,"https://api.polar.test/v3/webhooks/hook");

  const raw=Buffer.from('{"event":"SLEEP","user_id":12345}'),digest=createHmac("sha256","hook-secret").update(raw);
  const hex=digest.digest("hex"),base64=Buffer.from(hex,"hex").toString("base64");
  assert.equal(validWebhookSignature(raw,hex,"hook-secret"),true);assert.equal(validWebhookSignature(raw,hex.toUpperCase(),"hook-secret"),true);
  assert.equal(validWebhookSignature(raw,`sha256=${hex}`,"hook-secret"),true);assert.equal(validWebhookSignature(raw,base64,"hook-secret"),true);
  assert.equal(validWebhookSignature(Buffer.from('{"event":"SLEEP","user_id":1}'),hex,"hook-secret"),false);
  assert.equal(validWebhookSignature(raw,hex,"other-secret"),false);assert.equal(validWebhookSignature(raw,hex,""),false);
  assert.equal(validWebhookSignature(raw,undefined,"hook-secret"),false);assert.equal(validWebhookSignature(raw,"a".repeat(300),"hook-secret"),false);
});
