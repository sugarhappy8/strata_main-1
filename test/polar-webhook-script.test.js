"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {DEFAULT_EVENTS,eventsFrom,parseArgs,run,webhookUrl}=require("../scripts/polar-webhook");

const ENV={POLAR_CLIENT_ID:"client",POLAR_CLIENT_SECRET:"secret",APP_BASE_URL:"https://strata.example/"};
function fakeClient(existing=[]){
  const calls=[];
  return {calls,async webhook(method,path,body){calls.push([method,path,body]);if(method==="GET")return {data:existing};if(method==="POST")return {data:{id:"hook-1",url:body.url,events:body.events,signature_secret_key:"shown-once"}};return null;}};
}
const logger=()=>{const lines=[];return {lines,log:(line)=>lines.push(String(line))};};

test("the webhook script reads its command and options strictly",()=>{
  assert.deepEqual(parseArgs([]),{command:"status",options:{}});
  assert.deepEqual(parseArgs(["create","--url","https://x.example/hook","--events","EXERCISE,SLEEP"]),{command:"create",options:{url:"https://x.example/hook",events:"EXERCISE,SLEEP"}});
  assert.throws(()=>parseArgs(["launch"]),/Unknown command/);assert.throws(()=>parseArgs(["create","--url"]),/incomplete/);assert.throws(()=>parseArgs(["create","--force","yes"]),/Unknown/);
  assert.equal(webhookUrl({},ENV),"https://strata.example/api/devices/polar/webhook");
  assert.throws(()=>webhookUrl({},{APP_BASE_URL:"http://strata.example"}),/https/);assert.throws(()=>webhookUrl({},{}),/APP_BASE_URL/);
  assert.deepEqual(eventsFrom({}),[...DEFAULT_EVENTS]);assert.deepEqual(eventsFrom({events:" exercise , sleep "}),["EXERCISE","SLEEP"]);assert.throws(()=>eventsFrom({events:"bad-name"}),/comma-separated/);
});

test("status, create, and delete manage the app's one Polar webhook",async()=>{
  const empty=fakeClient(),log=logger();
  assert.deepEqual(await run({command:"status",options:{},env:ENV,client:empty,logger:log}),{webhooks:0});assert.match(log.lines[0],/No Polar webhook/);
  const created=await run({command:"create",options:{},env:ENV,client:empty,logger:log});
  assert.deepEqual(created,{created:true,secret:true});
  assert.deepEqual(empty.calls.at(-1),["POST","",{events:[...DEFAULT_EVENTS],url:"https://strata.example/api/devices/polar/webhook"}]);
  assert.match(log.lines.at(-1),/POLAR_WEBHOOK_SECRET[\s\S]*shown-once/);

  const existing=fakeClient([{id:"hook-1",url:"https://strata.example/api/devices/polar/webhook",events:["EXERCISE"],active:false}]),statusLog=logger();
  assert.deepEqual(await run({command:"status",options:{},env:ENV,client:existing,logger:statusLog}),{webhooks:1});assert.match(statusLog.lines[0],/hook-1 .* EXERCISE · inactive/);
  await assert.rejects(run({command:"create",options:{},env:ENV,client:existing,logger:logger()}),/already has a webhook/);
  assert.deepEqual(await run({command:"delete",options:{},env:ENV,client:existing,logger:logger()}),{deleted:true});assert.deepEqual(existing.calls.at(-1),["DELETE","/hook-1",undefined]);
  assert.deepEqual(await run({command:"delete",options:{},env:ENV,client:fakeClient(),logger:logger()}),{deleted:false});
  const single=fakeClient({id:"solo",url:"https://strata.example/hook",events:["SLEEP"]});
  assert.deepEqual(await run({command:"status",options:{},env:ENV,client:single,logger:logger()}),{webhooks:1});
  const noSecret={async webhook(method){return method==="GET"?{data:[]}:{data:{id:"hook-2"}};}},noSecretLog=logger();
  assert.deepEqual(await run({command:"create",options:{url:"https://strata.example/custom"},env:ENV,client:noSecret,logger:noSecretLog}),{created:true,secret:false});assert.match(noSecretLog.lines.at(-1),/did not return a signing secret/);
  await assert.rejects(run({command:"status",options:{},env:{},client:empty,logger:logger()}),/POLAR_CLIENT_ID/);
});
