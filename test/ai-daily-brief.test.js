"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {CARE_FALLBACK,briefSchema,createDailyBriefJob,localParts,validateBrief}=require("../src/ai-daily-brief");

const good={readiness:{level:"steady",summary:"Recovery was OK after a short night."},recommendation:{title:"Train as planned, keep effort moderate",detail:"Your plan has Upper A today. Stop two reps before failure on the presses."},planAdjustments:[{day:"Thursday",change:"Swap squats for leg press",reason:"Knee comfort was low last week."}],insight:"You trained 3 of 4 planned days last week.",careNote:"See a doctor."};

test("the brief schema is strict: every field required and nothing extra allowed",()=>{
  const schema=briefSchema(),walk=(node)=>{if(node?.type==="object"){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());Object.values(node.properties).forEach(walk);}if(node?.items)walk(node.items);(node?.anyOf||[]).forEach(walk);};
  walk(schema);
});

test("briefs are validated, trimmed, and only carry a care note when STRATA flagged one",()=>{
  const brief=validateBrief(good);
  assert.equal(brief.careNote,null,"a model-invented care note is dropped without a flag");assert.equal(brief.planAdjustments.length,1);assert.equal(brief.version,1);
  assert.equal(validateBrief(good,{flags:["x"]}).careNote,"See a doctor.");
  assert.equal(validateBrief({...good,careNote:null},{flags:["x"]}).careNote,CARE_FALLBACK);
  assert.equal(validateBrief({...good,readiness:{level:"great",summary:"x"}}),null);assert.equal(validateBrief({...good,recommendation:{title:"",detail:"x"}}),null);assert.equal(validateBrief(null),null);
  const long=validateBrief({...good,insight:"x".repeat(900),planAdjustments:[...Array(5)].map(()=>({day:"Monday",change:"c",reason:"r"})).concat([{day:"Someday",change:"c",reason:"r"}])});
  assert.equal(long.insight.length,240);assert.equal(long.planAdjustments.length,2);
  assert.deepEqual(localParts(Date.parse("2026-10-01T03:30:00Z"),"Asia/Dubai"),{date:"2026-10-01",hour:7});assert.deepEqual(localParts(Date.parse("2026-10-01T03:30:00Z"),"Not/AZone"),{date:"2026-10-01",hour:3});
});

function fixture({hour="06:00",consent=true,hasNight=true,polar=false,answers=[good]}={}){
  const saved=[],refunds=[],records=[],snapshot={snapshot_json:JSON.stringify({sleep:hasNight?{asleepSeconds:25000}:null}),brief_json:null};
  const store={
    async dailySnapshots(){return [snapshot];},
    async deviceConnection(){return polar?{status:"active"}:null;},
    async briefCandidates(limit,offset){return offset===0&&consent?[{user_id:"m1",profile_json:JSON.stringify({timeZone:"UTC"})}]:[];},
    async aiSettings(){return consent?{consent_at:1,daily_brief:1}:null;},
    async coachingProfile(){return {profile_json:JSON.stringify({timeZone:"UTC"})};},
    async saveDailyBrief(userId,date,json){saved.push({userId,date,brief:JSON.parse(json)});snapshot.brief_json=json;return true;}
  };
  const dataService={snapshots:{read:async()=>[{date:"2026-10-01",sleep:{asleepSeconds:25000},recovery:{label:"OK",stress:"usual"},heart:null,training:{status:"planned",done:[]},nutrition:null}]},trainingLog:{read:async()=>[]},rankingsSignals:async()=>({trained:[]}),planChanges:async()=>[]};
  const calls=[],provider={configured:true,async complete(request){calls.push(request);const next=answers.shift();if(next instanceof Error)throw next;return {data:next,model:"m",usage:{totalTokens:200}};}};
  const quota={async reserve(){return {ok:true,date:"2026-10-01"};},async record(kind,user,date,tokens){records.push(tokens);},async refund(){refunds.push(1);}};
  const job=createDailyBriefJob({store,dataService,provider,quota,hasAccess:async()=>true,now:()=>Date.parse(`2026-10-01T${hour}:00Z`)});
  return {job,saved,calls,refunds,records};
}

test("the morning job writes one brief per member and day, in the member's own morning",async()=>{
  const early=fixture({hour:"04:00"});assert.deepEqual(await early.job.tick(),[]);assert.equal(early.calls.length,0,"nothing before 05:00 local");
  const {job,saved,calls,records}=fixture();
  assert.deepEqual(await job.tick(),[{status:"saved"}]);assert.equal(saved.length,1);assert.equal(saved[0].brief.generatedBy,"ai");assert.equal(saved[0].brief.recommendation.title,"Train as planned, keep effort moderate");
  assert.equal(calls[0].reasoningEffort,"low");assert.equal(calls[0].responseFormat.type,"json_schema");assert.match(calls[0].messages[1].content,/Today is 2026-10-01/);assert.doesNotMatch(JSON.stringify(calls[0].messages),/@|token/i);
  assert.deepEqual(records,[200]);assert.deepEqual(await job.tick(),[],"a stored brief is never regenerated the same day");
  const noConsent=fixture({consent:false});assert.deepEqual(await noConsent.job.tick(),[]);assert.equal(noConsent.calls.length,0,"no consent, no provider call");
  const waiting=fixture({polar:true,hasNight:false});assert.deepEqual(await waiting.job.tick(),[],"a Polar member's brief waits for last night");
});

test("an unreadable answer gets one retry, and a failed member backs off instead of retrying every minute",async()=>{
  const retried=fixture({answers:[{bad:true},good]});assert.deepEqual(await retried.job.tick(),[{status:"saved"}]);assert.equal(retried.calls.length,2);assert.match(retried.calls[1].messages[1].content,/did not match the schema/);
  const failing=fixture({answers:[{bad:true},{bad:true},good]});assert.deepEqual(await failing.job.tick(),[{status:"failed",code:"AI_BAD_OUTPUT"}]);
  assert.deepEqual(await failing.job.tick(),[],"the member waits an hour after a failure");
  const offline=fixture({answers:[Object.assign(new Error("offline"),{code:"AI_OFFLINE"})]});await offline.job.tick();assert.deepEqual(offline.refunds,[1],"a request that never reached the model is refunded");
});
