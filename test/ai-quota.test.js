"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {createAiQuota}=require("../src/ai-quota");

function memoryStore(){
  const rows=new Map(),key=(date,scope,kind)=>`${date}|${scope}|${kind}`;
  return {rows,
    async aiUsage(date,scope){return [...rows.entries()].filter(([name])=>name.startsWith(`${date}|${scope}|`)).map(([name,value])=>({kind:name.split("|")[2],...value}));},
    async addAiUsage(date,scope,kind,requests,tokens){const current=rows.get(key(date,scope,kind))||{requests:0,tokens:0};rows.set(key(date,scope,kind),{requests:current.requests+requests,tokens:current.tokens+tokens});},
    async refundAiUsage(date,scope,kind){const current=rows.get(key(date,scope,kind));if(current)current.requests=Math.max(0,current.requests-1);},
    async aiUsageTotals(date){return ["brief","chat"].map(kind=>({kind,...(rows.get(key(date,"global",kind))||{requests:0,tokens:0})}));},
    async aiUsageTop(date,limit){const users=new Map();for(const [name,value] of rows){const [day,scope]=name.split("|");if(day!==date||scope==="global")continue;const current=users.get(scope)||{user_id:scope,email:null,requests:0,tokens:0};current.requests+=value.requests;current.tokens+=value.tokens;users.set(scope,current);}return [...users.values()].sort((a,b)=>b.tokens-a.tokens).slice(0,limit);},
    async deleteOldAiUsage(){}
  };
}

test("chat stops at its share of the day so Daily Briefs keep their reserve",async()=>{
  let time=Date.parse("2026-10-01T08:00:00Z");const store=memoryStore(),quota=createAiQuota({store,now:()=>time,limits:{dailyRequests:10,briefShare:0.4,perMinute:100,userDaily:50}});
  assert.equal(quota.limits.chatCap,6);
  for(let index=0;index<6;index+=1)assert.equal((await quota.reserve("chat",`member-${index}`)).ok,true);
  assert.deepEqual(await quota.reserve("chat","member-x"),{ok:false,code:"AI_RESTING"},"chat is resting once its share is used");
  assert.equal((await quota.memberStatus("member-x")).resting,true);
  for(let index=0;index<4;index+=1)assert.equal((await quota.reserve("brief",`member-${index}`)).ok,true,"briefs still have their reserve");
  assert.deepEqual(await quota.reserve("brief","member-9"),{ok:false,code:"AI_RESTING"},"nothing runs past the daily budget");
  time+=24*60*60*1000;assert.equal((await quota.reserve("chat","member-x")).ok,true,"a new UTC day starts a new budget");
});

test("members have their own chat allowance and the minute cap holds bursts back",async()=>{
  let time=Date.parse("2026-10-01T08:00:00Z");const store=memoryStore(),quota=createAiQuota({store,now:()=>time,limits:{dailyRequests:100,briefShare:0,perMinute:3,userDaily:2}});
  assert.equal((await quota.reserve("chat","a")).ok,true);assert.equal((await quota.reserve("chat","a")).ok,true);
  assert.deepEqual(await quota.reserve("chat","a"),{ok:false,code:"AI_DAILY_LIMIT"});
  assert.equal((await quota.reserve("chat","b")).ok,true);
  const busy=await quota.reserve("chat","c");assert.equal(busy.code,"AI_BUSY");assert.equal(busy.retryAt,time+60000);
  time+=60000;assert.equal((await quota.reserve("chat","c")).ok,true,"the next minute has room again");
  assert.deepEqual(await quota.memberStatus("a"),{dailyLimit:2,usedToday:2,remainingToday:0,resting:false});
});

test("tokens are recorded, failed requests are refunded, and the owner sees the heaviest users",async()=>{
  const time=Date.parse("2026-10-01T08:00:00Z"),store=memoryStore(),quota=createAiQuota({store,now:()=>time,limits:{dailyRequests:100,briefShare:0.4,perMinute:100,userDaily:10}});
  const claim=await quota.reserve("chat","a");await quota.record("chat","a",claim.date,1500);await quota.record("chat","a",claim.date,0);
  const failed=await quota.reserve("chat","b");await quota.refund("chat","b",failed.date);
  await quota.reserve("brief","b");await quota.record("brief","b","2026-10-01",400);
  const summary=await quota.adminSummary(5);
  assert.deepEqual(summary.totals,[{kind:"brief",requests:1,tokens:400},{kind:"chat",requests:1,tokens:1500}]);
  assert.deepEqual(summary.topUsers.map(row=>[row.userId,row.requests,row.tokens]),[["a",1,1500],["b",1,400]],"the refunded chat request is not counted");
  assert.equal(summary.chatCap,60);assert.equal(summary.dailyRequests,100);
});
