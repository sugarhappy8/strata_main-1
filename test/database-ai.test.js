"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {createStore}=require("../src/database");
const {fakeTursoFactory}=require("./support/workout-fixtures");

const ROOT=join(__dirname,".."),RUNTIME=join(ROOT,"test-runtime");

async function stores(){
  mkdirSync(RUNTIME,{recursive:true});const directory=mkdtempSync(join(RUNTIME,"ai-parity-"));
  const previous={NODE_ENV:process.env.NODE_ENV,STRATA_DATA_DIR:process.env.STRATA_DATA_DIR,TURSO_DATABASE_URL:process.env.TURSO_DATABASE_URL,TURSO_AUTH_TOKEN:process.env.TURSO_AUTH_TOKEN};
  process.env.NODE_ENV="test";process.env.STRATA_DATA_DIR=directory;delete process.env.TURSO_DATABASE_URL;delete process.env.TURSO_AUTH_TOKEN;
  const local=await createStore(ROOT);delete process.env.STRATA_DATA_DIR;process.env.TURSO_DATABASE_URL="https://ai-parity.invalid";process.env.TURSO_AUTH_TOKEN="test-token";
  const turso=await createStore(ROOT,{tursoClientFactory:fakeTursoFactory()});
  for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  return {local,turso,async close(){await Promise.all([local.close(),turso.close()]);rmSync(directory,{recursive:true,force:true});}};
}

async function scenario(store,suffix){
  const now=1_900_000_000_000,user={id:`ai-${suffix}`,name:"AI Member",email:`ai-${suffix}@example.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:now,emailVerifiedAt:now};
  await store.insertUser(user);
  const none=await store.aiSettings(user.id);
  const granted=await store.upsertAiSettings(user.id,{consentAt:now+1,consentVersion:1,dailyBrief:true,updatedAt:now+1});
  const briefOff=await store.upsertAiSettings(user.id,{consentAt:now+1,consentVersion:1,dailyBrief:false,updatedAt:now+2});
  const candidatesOff=(await store.briefCandidates(10,0)).filter((row)=>row.user_id===user.id).length;
  await store.upsertAiSettings(user.id,{consentAt:now+1,consentVersion:1,dailyBrief:true,updatedAt:now+3});
  const candidatesOn=(await store.briefCandidates(10,0)).filter((row)=>row.user_id===user.id).length;
  for(const [scope,kind,requests,tokens] of [["global","chat",1,0],[user.id,"chat",1,0],["global","chat",0,1200],[user.id,"chat",0,1200],["global","brief",1,300],[user.id,"brief",1,300]])await store.addAiUsage("2030-03-04",scope,kind,requests,tokens);
  await store.addAiUsage("2030-03-04",user.id,"chat",1,0);await store.refundAiUsage("2030-03-04",user.id,"chat");await store.refundAiUsage("2030-03-04","nobody","chat");
  const mine=(await store.aiUsage("2030-03-04",user.id)).map((row)=>[row.kind,Number(row.requests),Number(row.tokens)]).sort();
  const totals=(await store.aiUsageTotals("2030-03-04")).map((row)=>[row.kind,Number(row.requests),Number(row.tokens)]);
  const top=(await store.aiUsageTop("2030-03-04",5)).map((row)=>[row.user_id,row.email,Number(row.requests),Number(row.tokens)]);
  const exported=await store.accountExport(user.id);
  await store.addAiUsage("2030-01-01",user.id,"chat",1,10);await store.deleteOldAiUsage("2030-02-01");const pruned=(await store.aiUsage("2030-01-01",user.id)).length;
  await store.upsertAccountAction({requestId:`delete-${suffix}`,userId:user.id,purpose:"account_delete",tokenHash:`delete-token-${suffix}`,expiresAt:now+1000,deliveryState:"sent",createdAt:now+9,updatedAt:now+9});
  const deletion=await store.deleteAccount(`delete-token-${suffix}`,now+10,"email-hash");
  return {none,granted:{consent:Number(granted.consent_at),brief:Number(granted.daily_brief)},briefOff:Number(briefOff.daily_brief),candidatesOff,candidatesOn,mine,totals,top,
    exported:{settings:Boolean(exported.aiSettings),usage:exported.aiUsage.length},pruned,deleted:deletion.status,after:{settings:await store.aiSettings(user.id),usage:(await store.aiUsage("2030-03-04",user.id)).length,global:(await store.aiUsage("2030-03-04","global")).length}};
}

test("SQLite and Turso keep Strata AI consent, usage, export, and deletion identical",{concurrency:false},async()=>{
  const pair=await stores();
  try{
    const local=await scenario(pair.local,"local"),turso=await scenario(pair.turso,"turso");
    assert.deepEqual({...turso,top:turso.top.map(row=>row.slice(2))},{...local,top:local.top.map(row=>row.slice(2))});
    assert.equal(local.none,null);assert.deepEqual(local.granted,{consent:1_900_000_000_001,brief:1});assert.equal(local.briefOff,0);
    assert.equal(local.candidatesOff,0,"members who turned the brief off are never candidates");assert.equal(local.candidatesOn,1);
    assert.deepEqual(local.mine,[["brief",1,300],["chat",1,1200]],"a refund gives back only the extra request");
    assert.deepEqual(local.totals,[["brief",1,300],["chat",1,1200]]);assert.deepEqual(local.top,[["ai-local","ai-local@example.test",2,1500]]);
    assert.deepEqual(local.exported,{settings:true,usage:2});assert.equal(local.pruned,0);
    assert.equal(local.deleted,"deleted");assert.deepEqual(local.after,{settings:null,usage:0,global:2},"the member's rows go; the organization's totals stay");
  }finally{await pair.close();}
});

test("SQLite and Turso claim AI requests with one conditional write that stops at each limit",{concurrency:false},async()=>{
  const pair=await stores();
  try{
    for(const store of [pair.local,pair.turso]){
      const day="2030-04-01",claims=[];
      // A member allowance of 2: the third claim returns nothing and leaves the count at the limit.
      for(let index=0;index<3;index+=1)claims.push(await store.claimMemberAiRequest(day,"member-a","chat",2));
      assert.deepEqual(claims,[true,true,false]);
      assert.deepEqual((await store.aiUsage(day,"member-a")).map((row)=>Number(row.requests)),[2]);
      assert.equal(await store.claimMemberAiRequest(day,"member-z","chat",0),false,"a zero allowance never inserts a row");
      // The shared budget: 3 per day, of which chat may use 2.
      assert.deepEqual([await store.claimGlobalAiRequest(day,"chat",3,2),await store.claimGlobalAiRequest(day,"chat",3,2),await store.claimGlobalAiRequest(day,"chat",3,2)],[true,true,false],"chat stops at its share");
      assert.deepEqual([await store.claimGlobalAiRequest(day,"brief",3,3),await store.claimGlobalAiRequest(day,"brief",3,3)],[true,false],"nothing passes the daily total");
      assert.deepEqual((await store.aiUsage(day,"global")).map((row)=>[row.kind,Number(row.requests)]).sort(),[["brief",1],["chat",2]]);
      await store.refundAiUsage(day,"global","chat");
      assert.equal(await store.claimGlobalAiRequest(day,"chat",3,2),true,"a refund frees its place again");
      assert.equal(await store.claimGlobalAiRequest(day,"chat",3,2),false);
    }
  }finally{await pair.close();}
});

test("SQLite and Turso queue AI requests: one unfinished per member, oldest first, message dropped when finished",{concurrency:false},async()=>{
  const {isUniqueViolation}=require("../src/database");
  const pair=await stores();
  try{
    for(const store of [pair.local,pair.turso]){
      const job=(id,userId,createdAt)=>({id,userId,kind:"chat",requestJson:JSON.stringify({message:`private ${id}`}),usageDate:"2030-05-01",createdAt});
      for(const id of ["queue-a","queue-b"])await store.insertUser({id,name:id,email:`${id}-${store.kind}@example.test`,passwordHash:"hash",passwordSalt:"salt",createdAt:1,emailVerifiedAt:1});
      const first=await store.insertAiJob(job("job-1","queue-a",100));
      assert.deepEqual({...first},{id:"job-1",user_id:"queue-a",kind:"chat",status:"queued",request_json:"{\"message\":\"private job-1\"}",usage_date:"2030-05-01",tokens:0,result_json:null,error_json:null,created_at:100,finished_at:null});
      await assert.rejects(store.insertAiJob(job("job-2","queue-a",101)),(error)=>isUniqueViolation(error),"a member has one unfinished request");
      await store.insertAiJob(job("job-3","queue-b",102));
      assert.deepEqual([await store.queuedAiJobs(),await store.aiJobPosition("job-1"),await store.aiJobPosition("job-3")],[2,1,2]);
      assert.equal((await store.activeAiJob("queue-a"))?.id,"job-1");
      assert.equal(await store.aiJob("job-1","queue-b"),null,"a member reads only their own request");

      const claimed=await store.claimAiJob(5_000);
      assert.deepEqual([claimed?.id,claimed?.status],["job-1","running"],"the oldest queued request is claimed");
      assert.deepEqual([await store.queuedAiJobs(),await store.aiJobPosition("job-3")],[1,1]);
      await store.requeueStaleAiJobs(4_999);
      assert.equal((await store.aiJob("job-1","queue-a"))?.status,"running","a live lease is left alone");
      await store.requeueStaleAiJobs(5_001);
      assert.equal((await store.aiJob("job-1","queue-a"))?.status,"queued","an expired lease is queued again");
      assert.equal((await store.claimAiJob(9_000))?.id,"job-1");

      await store.finishAiJob("job-1",{status:"done",tokens:321,resultJson:"{\"reply\":\"ok\"}",errorJson:null,finishedAt:6_000});
      const done=await store.aiJob("job-1","queue-a");
      assert.deepEqual([done?.status,done?.request_json,done?.result_json,Number(done?.tokens)],["done",null,"{\"reply\":\"ok\"}",321],"the member's message is dropped once answered");
      assert.equal(await store.activeAiJob("queue-a"),null);
      await store.insertAiJob(job("job-4","queue-a",200));
      await store.deleteFinishedAiJobs(6_000);assert.ok(await store.aiJob("job-1","queue-a"));
      await store.deleteFinishedAiJobs(6_001);assert.equal(await store.aiJob("job-1","queue-a"),null,"answers are removed after their time");

      await store.upsertAccountAction({requestId:`jobs-delete-${store.kind}`,userId:"queue-a",purpose:"account_delete",tokenHash:`jobs-delete-${store.kind}`,expiresAt:1e12,deliveryState:"sent",createdAt:1,updatedAt:1});
      assert.equal((await store.deleteAccount(`jobs-delete-${store.kind}`,2,"hash")).status,"deleted");
      assert.equal(await store.aiJob("job-4","queue-a"),null,"deleting the member removes their requests");
      assert.ok(await store.aiJob("job-3","queue-b"));
    }
  }finally{await pair.close();}
});
