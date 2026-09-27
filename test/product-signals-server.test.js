"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EVENTS,RETENTION_DAYS,utcDay,createProductSignalsService}=require("../src/product-signals");
const {PRODUCT_SIGNAL_TABLE}=require("../src/product-signals-schema");

const NOW=Date.UTC(2026,8,7,18,30);

test("the server and database enforce the same product-event allowlist",()=>{
  const schemaEvents=[...PRODUCT_SIGNAL_TABLE.matchAll(/'([a-z_]+)'/g)].map((match)=>match[1]);
  assert.deepEqual(schemaEvents,EVENTS);
});

function response(){return {status:0,data:null,headers:null};}

function harness({rows=[],adminSession={id:"admin"},allowRate=()=>true}={}){
  const writes=[],cleanups=[],rateKeys=[];
  const store={
    async incrementProductSignal(day,name){writes.push({day,name});return true;},
    async productSignalCounts(since,through){store.range={since,through};return rows;},
    async deleteOldProductSignals(before){cleanups.push(before);return 2;}
  };
  const admin={async requireAdmin(req,res){if(adminSession)return adminSession;http.json(res,401,{error:"Sign in."});return null;}};
  const http={
    json(res,status,data,headers={}){res.status=status;res.data=data;res.headers=headers;},
    async bodyJson(req){return req.body;}
  };
  const service=createProductSignalsService({
    store,admin,http,now:()=>NOW,
    trustedOrigin:(req)=>req.trusted===true,
    requestAddress:(req)=>req.address,
    rateKeyAllowed:(key,max,windowMs)=>{rateKeys.push({key,max,windowMs});return allowRate(key,max,windowMs);}
  });
  return {service,store,writes,cleanups,rateKeys};
}

function request({method="POST",trusted=true,type="application/json",body={event:"preview_generated"},address="203.0.113.42"}={}){
  return {method,trusted,address,body,headers:{"content-type":type}};
}

test("anonymous product activity accepts only one allowlisted event and stores a UTC daily count",async()=>{
  const page=harness(),res=response();
  assert.equal(await page.service.handleApi(request(),res,new URL("https://strata.test/api/product-signals")),true);
  assert.equal(res.status,202);
  assert.deepEqual(res.data,{accepted:true});
  assert.deepEqual(page.writes,[{day:"2026-09-07",name:"preview_generated"}]);
  assert.equal(page.rateKeys.length,2);
  assert.doesNotMatch(JSON.stringify(page.rateKeys),/203\.0\.113\.42/);
  assert.match(page.rateKeys[0].key,/^product-signals:network:[a-f0-9]{64}$/);

  for(const body of [
    {event:"not_allowlisted"},
    {event:"preview_generated",email:"private@example.test"},
    {event:{name:"preview_generated"}},
    {}
  ]){
    const invalid=harness(),invalidResponse=response();
    await invalid.service.handleApi(request({body}),invalidResponse,new URL("https://strata.test/api/product-signals"));
    assert.equal(invalidResponse.status,400);
    assert.equal(invalid.writes.length,0);
  }
});

test("the public counter enforces method, origin, content type, and transient rate limits",async()=>{
  const cases=[
    {input:request({method:"GET"}),status:405,code:"PRODUCT_SIGNAL_METHOD"},
    {input:request({trusted:false}),status:403,code:"PRODUCT_SIGNAL_ORIGIN_REQUIRED"},
    {input:request({type:"text/plain"}),status:415,code:"JSON_REQUIRED"}
  ];
  for(const entry of cases){
    const page=harness(),res=response();
    await page.service.handleApi(entry.input,res,new URL("https://strata.test/api/product-signals"));
    assert.equal(res.status,entry.status);assert.equal(res.data.code,entry.code);assert.equal(page.writes.length,0);
  }
  const limited=harness({allowRate:()=>false}),res=response();
  await limited.service.handleApi(request(),res,new URL("https://strata.test/api/product-signals"));
  assert.equal(res.status,429);assert.equal(res.data.code,"PRODUCT_SIGNAL_RATE_LIMIT");assert.equal(limited.writes.length,0);
});

test("only an elevated admin receives bounded aggregate counts, never people or cohorts",async()=>{
  const page=harness({rows:[
    {event_day:"2026-09-06",event_name:"preview_generated",event_count:3},
    {event_day:"2026-09-07",event_name:"preview_generated",event_count:2},
    {event_day:"2026-09-07",event_name:"workout_started",event_count:4},
    {event_day:"2026-09-07",event_name:"unexpected_private_name",event_count:999}
  ]}),res=response();
  await page.service.handleApi(request({method:"GET"}),res,new URL("https://strata.test/api/admin/product-signals?days=999"));
  assert.equal(res.status,200);
  assert.deepEqual(page.store.range,{since:"2026-06-10",through:"2026-09-07"});
  assert.deepEqual(res.data.scope,{
    days:90,sinceDay:"2026-06-10",throughDay:"2026-09-07",retentionDays:90,
    measure:"aggregate_action_counts",uniquePeople:false,repeatedActionsIncrement:true
  });
  assert.equal(res.data.totals.preview_generated,5);
  assert.equal(res.data.totals.workout_started,4);
  assert.equal(Object.keys(res.data.totals).length,EVENTS.length);
  assert.equal(res.data.counts.some((entry)=>entry.name==="unexpected_private_name"),false);
  assert.doesNotMatch(JSON.stringify(res.data),/user|account|email|workout_json|cohort/i);

  const denied=harness({adminSession:null}),deniedResponse=response();
  await denied.service.handleApi(request({method:"GET"}),deniedResponse,new URL("https://strata.test/api/admin/product-signals"));
  assert.equal(deniedResponse.status,401);
  assert.equal(denied.store.range,undefined);
});

test("a missing, blank, or invalid aggregate range uses the 30-day default",async()=>{
  const cases=[["",30],["?days=",30],["?days=%20",30],["?days=abc",30],["?days=7.5",30],["?days=0",1],["?days=-4",1],["?days=7",7],["?days=90",90],["?days=91",90]];
  for(const [query,days] of cases){
    const page=harness(),res=response();
    await page.service.handleApi(request({method:"GET"}),res,new URL(`https://strata.test/api/admin/product-signals${query}`));
    assert.equal(res.status,200,query);assert.equal(res.data.scope.days,days,query||"(omitted)");
    assert.equal(page.store.range.through,"2026-09-07");assert.equal(page.store.range.since,utcDay(NOW-(days-1)*24*60*60*1000),query);
  }
});

test("aggregate cleanup keeps today plus 89 prior UTC days",async()=>{
  const page=harness();
  assert.equal(RETENTION_DAYS,90);
  assert.equal(utcDay(NOW),"2026-09-07");
  assert.equal(await page.service.cleanup(),2);
  assert.deepEqual(page.cleanups,["2026-06-10"]);
});

test("unrelated API paths are not consumed",async()=>{
  const page=harness(),res=response();
  assert.equal(await page.service.handleApi(request(),res,new URL("https://strata.test/api/status")),false);
  assert.equal(res.status,0);assert.equal(page.writes.length,0);
});
