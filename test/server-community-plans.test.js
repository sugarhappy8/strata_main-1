"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {spawn}=require("node:child_process");
const {mkdirSync,mkdtempSync,rmSync}=require("node:fs");
const {join}=require("node:path");
const {grantStrataPlus}=require("./support/strata-plus-access");

const PROJECT_ROOT=join(__dirname,"..");
let app;
let runtimeDir;
let BASE;

async function startApp(){
  mkdirSync(join(PROJECT_ROOT,"test-runtime"),{recursive:true});
  runtimeDir=mkdtempSync(join(PROJECT_ROOT,"test-runtime","server-community-plans-"));
  app=spawn(process.execPath,["server.js"],{
    cwd:PROJECT_ROOT,
    env:{
      ...process.env,
      PORT:"0",
      HOST:"127.0.0.1",
      NODE_ENV:"test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"true",
      TURSO_DATABASE_URL:"",
      TURSO_AUTH_TOKEN:"",
      STRATA_DATA_DIR:runtimeDir,
      PADDLE_CHECKOUT_ENABLED:"false",
      PADDLE_CLIENT_TOKEN:"",
      PADDLE_API_KEY:"",
      PADDLE_WEBHOOK_SECRET:"",
      PADDLE_PRODUCT_ID:"",
      PADDLE_PRICE_ID:""
    },
    stdio:["ignore","pipe","pipe"]
  });
  BASE=await new Promise((resolve,reject)=>{
    let output="",errors="",settled=false;
    const timer=setTimeout(()=>finish(new Error(`Server startup timed out. ${errors}`)),5000);
    function finish(error,value){
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(error)reject(error);else resolve(value);
    }
    app.stdout.on("data",(chunk)=>{
      output=(output+chunk.toString()).slice(-4096);
      const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if(match)finish(null,`http://127.0.0.1:${match[1]}`);
    });
    app.stderr.on("data",(chunk)=>{errors=(errors+chunk.toString()).slice(-4096);});
    app.once("error",finish);
    app.once("exit",(code,signal)=>finish(new Error(`Server exited before startup (${code??signal??"unknown"}). ${errors}`)));
  });
}

async function stopApp(){
  const child=app;
  app=undefined;
  if(child&&child.exitCode===null&&child.signalCode===null){
    await new Promise((resolve)=>{
      let timer;
      child.once("exit",()=>{clearTimeout(timer);resolve();});
      child.kill("SIGTERM");
      timer=setTimeout(()=>child.kill("SIGKILL"),2000);
    });
  }
  if(runtimeDir)rmSync(runtimeDir,{recursive:true,force:true});
  runtimeDir=undefined;
  BASE=undefined;
}

async function request(path,options={}){
  const response=await fetch(`${BASE}${path}`,options);
  const contentType=response.headers.get("content-type")||"";
  const data=contentType.includes("application/json")?await response.json():await response.text();
  return {response,data,cookie:response.headers.get("set-cookie")?.split(";")[0]||""};
}

async function signup(suffix,name=`Community ${suffix}`){
  const email=`community-${suffix.toLowerCase()}@example.test`;
  const result=await request("/api/signup",{
    method:"POST",
    headers:{Origin:BASE,"Content-Type":"application/json"},
    body:JSON.stringify({name,email,password:`community-password-${suffix.toLowerCase()}-123`})
  });
  assert.equal(result.response.status,201);
  const me=await request("/api/me",{headers:{Cookie:result.cookie}});
  assert.equal(me.response.status,200);
  assert.ok(me.data.csrfToken);
  return {cookie:result.cookie,csrfToken:me.data.csrfToken,user:me.data.user,email};
}

function grantPlus(account){grantStrataPlus(runtimeDir,account.user.id);}

function weeklyPlan(exerciseId="flat-dumbbell-press",instanceId="community-instance-001"){
  const days=Object.fromEntries(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].map((day)=>[day,[]]));
  days.Monday=[{instanceId,exerciseId,sets:4,reps:"8–12"}];
  return {version:1,restDay:"Sunday",restDays:["Sunday"],days};
}

function write(account,path,body,{method="POST",csrf=account.csrfToken,origin=BASE}={}){
  const headers={Cookie:account.cookie,"Content-Type":"application/json"};
  if(csrf!==null)headers["X-CSRF-Token"]=csrf;
  if(origin!==null)headers.Origin=origin;
  return request(path,{method,headers,body:JSON.stringify(body)});
}

async function saveWeeklyPlan(account,plan){
  const saved=await write(account,"/api/plan",{plan,expectedPlanUpdatedAt:account.planUpdatedAt||0},{method:"PUT"});
  assert.equal(saved.response.status,200);
  assert.ok(Number.isSafeInteger(saved.data.planUpdatedAt)&&saved.data.planUpdatedAt>0);
  account.planUpdatedAt=saved.data.planUpdatedAt;
  return saved.data;
}

function assertNoPrivateIdentity(payload,accounts){
  const serialized=JSON.stringify(payload);
  for(const account of accounts){
    assert.doesNotMatch(serialized,new RegExp(account.email.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"));
    assert.doesNotMatch(serialized,new RegExp(account.user.id.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.doesNotMatch(serialized,new RegExp(account.csrfToken.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
  assert.doesNotMatch(serialized,/"(?:email|user_?id|owner_?id|csrfToken|session|password|token)"\s*:/i);
}

test.before(startApp);
test.after(stopApp);

test("signed-in members can publish a private plan snapshot, while the community catalog and apply flow require Strata+",async()=>{
  const owner=await signup("Owner","Community\u061C\n\u202E\u200FOwner");
  const viewer=await signup("Viewer");
  const outsider=await signup("Outsider");
  const initialOwnerPlan=weeklyPlan();
  const initialOwnerSave=await saveWeeklyPlan(owner,initialOwnerPlan);

  const anonymousPublish=await request("/api/community-plans",{
    method:"POST",headers:{Origin:BASE,"Content-Type":"application/json"},
    body:JSON.stringify({title:"Anonymous upload",published:true})
  });
  assert.equal(anonymousPublish.response.status,401);

  const missingCsrf=await write(owner,"/api/community-plans",{title:"Owner push day",description:"A focused chest session.",published:true},{csrf:null});
  assert.equal(missingCsrf.response.status,403);
  const wrongCsrf=await write(owner,"/api/community-plans",{title:"Owner push day",published:true},{csrf:viewer.csrfToken});
  assert.equal(wrongCsrf.response.status,403);
  const crossOrigin=await write(owner,"/api/community-plans",{title:"Owner push day",published:true},{origin:"https://attacker.invalid"});
  assert.equal(crossOrigin.response.status,403);

  const suppliedPlan=weeklyPlan("not-a-real-exercise","invalid-upload-001");
  const rejectedPlan=await write(owner,"/api/community-plans",{
    title:"Invalid upload",published:true,plan:suppliedPlan,
    expectedPlanUpdatedAt:initialOwnerSave.planUpdatedAt
  });
  assert.equal(rejectedPlan.response.status,400);
  assert.equal(rejectedPlan.data.code,"COMMUNITY_PLAN_BODY_NOT_ALLOWED");
  assert.match(rejectedPlan.data.error,/save your weekly plan/i);
  assert.deepEqual((await request("/api/plan",{headers:{Cookie:owner.cookie}})).data.plan,initialOwnerPlan,"rejected publish input cannot mutate the private plan");

  const uploadedPlan=weeklyPlan("machine-chest-press","uploaded-plan-001");
  const uploadedSave=await saveWeeklyPlan(owner,uploadedPlan);
  const missingRevision=await write(owner,"/api/community-plans",{title:"Missing revision",published:true});
  assert.equal(missingRevision.response.status,400);
  assert.equal(missingRevision.data.code,"INVALID_COMMUNITY_REVISION");
  const stalePublish=await write(owner,"/api/community-plans",{
    title:"Stale snapshot",published:true,expectedPlanUpdatedAt:initialOwnerSave.planUpdatedAt
  });
  assert.equal(stalePublish.response.status,409);
  assert.equal(stalePublish.data.code,"PLAN_CHANGED");
  assert.equal((await request("/api/community-plans/mine",{headers:{Cookie:owner.cookie}})).data.plans.length,0,"a stale publish creates no listing");
  const published=await write(owner,"/api/community-plans",{
    title:"  Owner push day  ",
    description:"A focused chest session.",
    published:true,
    expectedPlanUpdatedAt:uploadedSave.planUpdatedAt,
    email:"injected@example.test",
    userId:viewer.user.id
  });
  assert.equal(published.response.status,200,"a signed-in free member may publish their current weekly plan");
  assert.equal(published.data.ok,true);
  assert.equal(published.data.plan.title,"Owner push day");
  assert.equal(published.data.plan.published,true);
  assert.equal(published.data.planUpdatedAt,uploadedSave.planUpdatedAt);
  assert.ok(published.data.plan.id);
  const communityPlanId=published.data.plan.id;

  const mine=await request("/api/community-plans/mine",{headers:{Cookie:owner.cookie}});
  assert.equal(mine.response.status,200);
  assert.equal(mine.data.plans.length,1);
  assert.equal(mine.data.plans[0].id,communityPlanId);
  assert.equal(mine.data.plans[0].published,true);

  const lockedCatalog=await request("/api/community-plans?limit=10&offset=0",{headers:{Cookie:viewer.cookie}});
  assert.equal(lockedCatalog.response.status,402);
  assert.equal(lockedCatalog.data.code,"DISCOVERY_ACCESS_REQUIRED");
  const lockedView=await request(`/api/community-plans/${communityPlanId}`,{headers:{Cookie:viewer.cookie}});
  assert.equal(lockedView.response.status,402);
  const lockedApply=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,{});
  assert.equal(lockedApply.response.status,402);

  grantPlus(viewer);
  const catalog=await request("/api/community-plans?limit=10&offset=0",{headers:{Cookie:viewer.cookie}});
  assert.equal(catalog.response.status,200);
  assert.equal(catalog.response.headers.get("cache-control"),"no-store");
  assert.ok(Array.isArray(catalog.data.plans));
  assert.equal(catalog.data.plans.length,1);
  assert.equal(catalog.data.plans[0].id,communityPlanId);
  assert.equal(catalog.data.plans[0].title,"Owner push day");
  assert.equal(catalog.data.plans[0].authorName,"Community Owner");
  assert.deepEqual(Object.keys(catalog.data.pagination).sort(),["limit","nextOffset","offset"]);
  assert.equal(catalog.data.pagination.limit,10);
  assert.equal(catalog.data.pagination.offset,0);
  assertNoPrivateIdentity(catalog.data,[owner,viewer,outsider]);

  const detail=await request(`/api/community-plans/${communityPlanId}`,{headers:{Cookie:viewer.cookie}});
  assert.equal(detail.response.status,200);
  assert.equal(detail.data.plan.id,communityPlanId);
  assert.deepEqual(detail.data.plan.plan,uploadedPlan,"a valid uploaded weekly plan is sanitized and preserved as a snapshot");
  assertNoPrivateIdentity(detail.data,[owner,viewer,outsider]);

  const changedOwnerSave=await saveWeeklyPlan(owner,weeklyPlan("incline-smith-press","changed-owner-plan-001"));
  assert.notDeepEqual(changedOwnerSave.plan,uploadedPlan);
  const beforeApply=await request("/api/plan",{headers:{Cookie:viewer.cookie}});
  assert.notDeepEqual(beforeApply.data.plan,uploadedPlan);
  assert.equal(beforeApply.data.planUpdatedAt,0);
  const discoveryBeforeApply=await request("/api/discovery",{headers:{Cookie:viewer.cookie}});
  assert.equal(discoveryBeforeApply.data.weeklyPlanUpdatedAt,beforeApply.data.planUpdatedAt);
  assert.deepEqual(discoveryBeforeApply.data.weeklyPlan,beforeApply.data.plan);

  const applyRequest={sourceUpdatedAt:published.data.plan.updatedAt,targetUpdatedAt:beforeApply.data.planUpdatedAt};
  const applyWithoutCsrf=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,applyRequest,{csrf:null});
  assert.equal(applyWithoutCsrf.response.status,403);
  const applyWrongCsrf=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,applyRequest,{csrf:owner.csrfToken});
  assert.equal(applyWrongCsrf.response.status,403);
  const oversizedApply=await request(`/api/community-plans/${communityPlanId}/apply`,{
    method:"POST",
    headers:{Cookie:viewer.cookie,Origin:BASE,"Content-Type":"application/json","X-CSRF-Token":viewer.csrfToken},
    body:JSON.stringify({...applyRequest,padding:"x".repeat(70_000)})
  });
  assert.equal(oversizedApply.response.status,413,"apply requests use the normal bounded JSON-body reader");
  const staleSource=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,{...applyRequest,sourceUpdatedAt:applyRequest.sourceUpdatedAt-1});
  assert.equal(staleSource.response.status,409);
  assert.equal(staleSource.data.code,"COMMUNITY_PLAN_CHANGED");
  const staleTarget=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,{...applyRequest,targetUpdatedAt:applyRequest.targetUpdatedAt+1});
  assert.equal(staleTarget.response.status,409);
  assert.equal(staleTarget.data.code,"COMMUNITY_PLAN_CHANGED");
  const applied=await write(viewer,`/api/community-plans/${communityPlanId}/apply`,applyRequest);
  assert.equal(applied.response.status,200);
  assert.equal(applied.data.ok,true);
  assert.deepEqual(applied.data.plan,uploadedPlan);
  assert.ok(applied.data.planUpdatedAt>beforeApply.data.planUpdatedAt);
  assert.deepEqual(applied.data.source,{id:communityPlanId,title:"Owner push day",authorName:"Community Owner"});
  assertNoPrivateIdentity(applied.data.source,[owner,viewer,outsider]);
  const afterApply=await request("/api/plan",{headers:{Cookie:viewer.cookie}});
  assert.deepEqual(afterApply.data.plan,uploadedPlan,"later owner edits do not mutate the uploaded snapshot, and apply replaces the viewer's saved planner");
  assert.equal(afterApply.data.planUpdatedAt,applied.data.planUpdatedAt);
});

test("only an upload owner can unpublish, republish, or delete it, and unpublished plans disappear from Strata+",async()=>{
  const owner=await signup("Manager");
  const viewer=await signup("Reader");
  grantPlus(viewer);
  const ownerSave=await saveWeeklyPlan(owner,weeklyPlan("neutral-pulldown","managed-plan-001"));
  const created=await write(owner,"/api/community-plans",{
    title:"Managed back day",description:"Owner-controlled listing.",published:true,
    expectedPlanUpdatedAt:ownerSave.planUpdatedAt
  });
  assert.equal(created.response.status,200);
  const id=created.data.plan.id;

  const viewerMutation=await write(viewer,`/api/community-plans/${id}`,{published:false},{method:"PATCH"});
  assert.equal(viewerMutation.response.status,403);
  const missingOwnerCsrf=await write(owner,`/api/community-plans/${id}`,{published:false},{method:"PATCH",csrf:null});
  assert.equal(missingOwnerCsrf.response.status,403);
  const unpublished=await write(owner,`/api/community-plans/${id}`,{published:false},{method:"PATCH"});
  assert.equal(unpublished.response.status,200);
  assert.equal(unpublished.data.plan.published,false);

  const hiddenCatalog=await request("/api/community-plans",{headers:{Cookie:viewer.cookie}});
  assert.equal(hiddenCatalog.response.status,200);
  assert.equal(hiddenCatalog.data.plans.some((plan)=>plan.id===id),false);
  assert.equal((await request(`/api/community-plans/${id}`,{headers:{Cookie:viewer.cookie}})).response.status,404);
  assert.equal((await write(viewer,`/api/community-plans/${id}/apply`,{sourceUpdatedAt:created.data.plan.updatedAt,targetUpdatedAt:0})).response.status,404);
  const ownerList=await request("/api/community-plans/mine",{headers:{Cookie:owner.cookie}});
  assert.equal(ownerList.response.status,200);
  assert.equal(ownerList.data.plans.find((plan)=>plan.id===id)?.published,false,"owners retain management access to unpublished uploads");

  const republished=await write(owner,`/api/community-plans/${id}`,{published:true},{method:"PATCH"});
  assert.equal(republished.response.status,200);
  assert.equal(republished.data.plan.published,true);
  assert.equal((await request(`/api/community-plans/${id}`,{headers:{Cookie:viewer.cookie}})).response.status,200);

  const viewerDelete=await write(viewer,`/api/community-plans/${id}`,{}, {method:"DELETE"});
  assert.equal(viewerDelete.response.status,403);
  const missingDeleteCsrf=await write(owner,`/api/community-plans/${id}`,{}, {method:"DELETE",csrf:null});
  assert.equal(missingDeleteCsrf.response.status,403);
  const deleted=await write(owner,`/api/community-plans/${id}`,{}, {method:"DELETE"});
  assert.equal(deleted.response.status,200);
  assert.equal(deleted.data.ok,true);
  assert.equal((await request(`/api/community-plans/${id}`,{headers:{Cookie:viewer.cookie}})).response.status,404);
  const mineAfterDelete=await request("/api/community-plans/mine",{headers:{Cookie:owner.cookie}});
  assert.equal(mineAfterDelete.data.plans.some((plan)=>plan.id===id),false);
});
