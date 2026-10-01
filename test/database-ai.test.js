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
