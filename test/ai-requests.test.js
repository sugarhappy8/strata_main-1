"use strict";

// Strata AI request intake against a store with network-like latency (as on Turso): a member's simultaneous requests
// are marked in flight before the first await, so only one reaches the quota and the queue.
const test=require("node:test"),assert=require("node:assert/strict");
const {createAiService}=require("../src/ai");

const pause=()=>new Promise((resolve)=>setImmediate(resolve));

function harness(){
  const reserved=[],responses=[];
  const store={async aiSettings(){await pause();return {consent_at:1,consent_version:1,daily_brief:1,updated_at:1};}};
  const quota={limits:{userDaily:6},async reserve(kind,userId){await pause();reserved.push(userId);return {ok:true,date:"2030-01-01"};},async record(){},async refund(){}};
  // The model never answers here, so an accepted request stays running.
  const provider={configured:true,model:"m",complete:()=>new Promise(()=>{}),health:async()=>({})};
  const service=createAiService({
    store,auth:{validCsrf:()=>true},requireAccess:async()=>({id:"member-1",csrf_token:"token"}),trustedOrigin:()=>true,rateAllowed:()=>true,
    http:{json(res,status,data){responses.push({status,data});res.status=status;},async bodyJson(req){await pause();return req.body;}},
    provider,getPlanSnapshot:async()=>new Promise(()=>{}),quota,config:{maxConcurrent:1,maxQueue:20}
  });
  const ask=async()=>{const res={};await service.handleApi({method:"POST",headers:{"content-type":"application/json"},body:{kind:"chat",message:"Plan my week"}},res,new URL("https://strata.test/api/ai/requests"));return res.status;};
  return {service,ask,reserved,responses};
}

test("simultaneous requests from one member start one job and claim the quota once",async()=>{
  const page=harness();
  const statuses=await Promise.all(Array.from({length:5},()=>page.ask()));
  assert.deepEqual(statuses.sort(),[202,409,409,409,409]);
  assert.ok(page.responses.filter(({status})=>status===409).every(({data})=>data.code==="AI_REQUEST_IN_PROGRESS"));
  assert.deepEqual(page.reserved,["member-1"],"only the accepted request reached the quota");
  assert.equal(page.service.stats().jobs,1);
});

test("a refused request clears the in-flight mark so the member can ask again",async()=>{
  const page=harness();
  const res={};
  await page.service.handleApi({method:"POST",headers:{"content-type":"application/json"},body:{kind:"chat",message:""}},res,new URL("https://strata.test/api/ai/requests"));
  assert.equal(res.status,400);
  assert.equal(await page.ask(),202,"the earlier failure did not leave the member marked busy");
});
