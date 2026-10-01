"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const Logic=require("../public/scripts/ai-logic");
const {createClient}=require("../public/scripts/ai-api");

test("the chat asks for consent before anything can be sent, and rests when the day's budget is spent",()=>{
  const consent=Logic.statusView({configured:true,online:true,consent:false,dailyLimit:30,remainingToday:30});
  assert.equal(consent.canAsk,false);assert.equal(consent.needsConsent,true);assert.equal(consent.tone,"consent");assert.match(consent.detail,/Never your name, email, or Polar login/);
  const resting=Logic.statusView({configured:true,online:true,consent:true,resting:true,dailyLimit:30,remainingToday:12});
  assert.equal(resting.canAsk,false);assert.match(resting.title,/resting/);assert.match(resting.detail,/Daily Brief/);
  assert.equal(Logic.statusView({configured:true,online:true,consent:true,dailyLimit:30,remainingToday:5}).canAsk,true);
  assert.equal(Logic.statusView({configured:false,consent:false}).needsConsent,undefined,"an unconfigured server never asks for consent");
});

test("consent and note deletion go to their own routes with the account and CSRF checks",async()=>{
  const calls=[],client=createClient({fetchImpl:async(path,init)=>{calls.push({path,init});return new Response(JSON.stringify({ok:true}),{status:200,headers:{"Content-Type":"application/json"}});},getCsrfToken:()=>"csrf-1",getUserId:()=>"user-1"});
  await client.saveSettings({consent:true});await client.saveSettings({consent:true,dailyBrief:false});await client.deleteNotes();
  assert.deepEqual(calls.map(call=>[call.path,call.init.method,JSON.parse(call.init.body)]),[["/api/ai/settings","PUT",{consent:true}],["/api/ai/settings","PUT",{consent:true,dailyBrief:false}],["/api/ai/notes","DELETE",{}]]);
  assert.ok(calls.every(call=>call.init.headers["X-CSRF-Token"]==="csrf-1"));
});
