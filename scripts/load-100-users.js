"use strict";

// Local Linux/CI capacity exercise. This deliberately accepts no remote URL.
// Run after installing Node 24 dependencies: node scripts/load-100-users.js --json
// When located outside scripts/, set STRATA_LOAD_PROJECT_ROOT to the checkout.
// By default each virtual user binds a real 127.0.0.x source address. Add
// --shared-ip to put every user on 127.0.0.2, modeling shared office/gym Wi-Fi.
// Both modes preserve the real network and identity authentication guards.
const assert=require("node:assert/strict");
const {spawn,execFileSync}=require("node:child_process");
const {mkdirSync,mkdtempSync,rmSync,readFileSync,readdirSync}=require("node:fs");
const http=require("node:http");
const {availableParallelism,totalmem}=require("node:os");
const {join,resolve}=require("node:path");
const {performance}=require("node:perf_hooks");
const {gunzipSync}=require("node:zlib");

const ROOT=resolve(process.env.STRATA_LOAD_PROJECT_ROOT||join(__dirname,".."));
const {isolatedServerEnvironment}=require(join(ROOT,"scripts","performance-check.js"));
const {grantStrataPlus}=require(join(ROOT,"test","support","strata-plus-access.js"));
const USERS=100;
const SHARED_IP=process.argv.includes("--shared-ip");
const roundsInput=Number(process.env.STRATA_LOAD_ROUNDS||5);
const ROUNDS=Number.isSafeInteger(roundsInput)&&roundsInput>=1&&roundsInput<=100?roundsInput:5;
const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
// Quiet local-runner regression budgets; these are not production SLOs.
const AUTH_P95_BUDGET_MS=15000;
const OTHER_P95_BUDGET_MS=2500;
const observations=[];
const phases=[];
const resourceSegments=[];
const RESOURCE_SAMPLE_MS=100;
let inFlight=0,phasePeak=0,baseUrl="",workloadCompleted=false,reportPrinted=false;

// Measure the actual application child, not this HTTP load-generator process.
// CPU percentages use one logical core as 100%; values above 100% are possible.
function monitorServer(child,label) {
  const ticksPerSecond=Number(execFileSync("getconf",["CLK_TCK"],{encoding:"utf8",timeout:2000}).trim());
  assert.ok(Number.isFinite(ticksPerSecond)&&ticksPerSecond>0,"Linux CPU clock frequency is unavailable.");
  // Some container runners expose the host's /proc while Node sees namespaced
  // PIDs. Verify both parent and namespace PID before measuring a process.
  const parentPid=readFileSync("/proc/self/status","utf8").match(/^Pid:\s+(\d+)/m)?.[1];
  const candidates=[String(child.pid),...readdirSync("/proc").filter((name)=>/^\d+$/.test(name)&&name!==String(child.pid))];
  const procPid=candidates.find((candidate)=>{
    try {
      const status=readFileSync(`/proc/${candidate}/status`,"utf8");
      const namespacePid=status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).at(-1)||candidate;
      return status.match(/^PPid:\s+(\d+)/m)?.[1]===parentPid&&namespacePid===String(child.pid);
    } catch(error) { if(error.code==="ENOENT"||error.code==="ESRCH")return false;throw error; }
  });
  assert.ok(procPid,"The application process could not be identified safely in /proc.");
  function snapshot() {
    const stat=readFileSync(`/proc/${procPid}/stat`,"utf8");
    const fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
    const status=readFileSync(`/proc/${procPid}/status`,"utf8");
    const memory=(name)=>Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB$`,"m"))?.[1]||0)/1024;
    return {at:performance.now(),userTicks:Number(fields[11]),systemTicks:Number(fields[12]),rssMiB:memory("VmRSS"),peakRssMiB:memory("VmHWM")};
  }
  const first=snapshot();
  let latest=first,peakSampledCpuPercentOneCore=0,peakResidentMemoryMiB=first.peakRssMiB,samples=1;
  function sample() {
    try {
      const current=snapshot(),elapsed=current.at-latest.at;
      const cpuMs=((current.userTicks+current.systemTicks)-(latest.userTicks+latest.systemTicks))/ticksPerSecond*1000;
      // End-of-phase samples can be very close; only regular-size intervals
      // contribute to the sampled CPU peak to avoid tick-resolution artifacts.
      if(elapsed>=RESOURCE_SAMPLE_MS/2)peakSampledCpuPercentOneCore=Math.max(peakSampledCpuPercentOneCore,100*cpuMs/elapsed);
      peakResidentMemoryMiB=Math.max(peakResidentMemoryMiB,current.peakRssMiB,current.rssMiB);
      latest=current;samples+=1;
    } catch(error) {
      if(error.code!=="ENOENT"&&error.code!=="ESRCH")throw error;
    }
  }
  const timer=setInterval(sample,RESOURCE_SAMPLE_MS);timer.unref();
  let stopped=false;
  return ()=>{
    if(stopped)return;stopped=true;
    clearInterval(timer);sample();
    const elapsedMs=latest.at-first.at;
    const userCpuMs=(latest.userTicks-first.userTicks)/ticksPerSecond*1000;
    const systemCpuMs=(latest.systemTicks-first.systemTicks)/ticksPerSecond*1000;
    resourceSegments.push({label,pid:child.pid,samples,elapsedMs:Number(elapsedMs.toFixed(1)),userCpuMs,systemCpuMs,
      averageCpuPercentOneCore:Number((100*(userCpuMs+systemCpuMs)/Math.max(1,elapsedMs)).toFixed(1)),
      peakSampledCpuPercentOneCore:Number(peakSampledCpuPercentOneCore.toFixed(1)),peakResidentMemoryMiB:Number(peakResidentMemoryMiB.toFixed(2))});
  };
}

function newAgent(index,sharedIp=SHARED_IP) {
  return new http.Agent({keepAlive:true,maxSockets:2,localAddress:sharedIp?"127.0.0.2":`127.0.0.${index+2}`});
}

function request(user,path,{method="GET",body,headers={},expected=[200],metric=path}={}) {
  const target=new URL(path,baseUrl);
  assert.equal(target.hostname,"127.0.0.1","The load exercise must remain on its isolated loopback server.");
  assert.equal(target.protocol,"http:");
  const payload=body===undefined?undefined:JSON.stringify(body);
  const started=performance.now();
  inFlight+=1;
  phasePeak=Math.max(phasePeak,inFlight);
  return new Promise((resolveRequest,reject)=>{
    let settled=false,timer;
    const finish=(error,result)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      inFlight-=1;
      observations.push({metric,status:result?.status||0,durationMs:performance.now()-started,failed:Boolean(error)});
      if(error)reject(error);else resolveRequest(result);
    };
    const req=http.request(target,{
      method,agent:user.agent,
      headers:{
        "Accept-Encoding":"gzip",
        ...(user.cookie?{Cookie:user.cookie}:{}),
        ...(method!=="GET"?{Origin:baseUrl}:{}),
        ...(payload===undefined?{}:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)}),
        ...(user.csrfToken?{"X-CSRF-Token":user.csrfToken}:{}),
        ...headers
      }
    },(response)=>{
      const chunks=[];
      response.on("error",(error)=>finish(error));
      response.on("data",(chunk)=>chunks.push(chunk));
      response.on("end",()=>{
        const result={status:response.statusCode,headers:response.headers,body:null};
        try {
          let bytes=Buffer.concat(chunks);
          if(response.headers["content-encoding"]==="gzip")bytes=gunzipSync(bytes);
          result.body=JSON.parse(bytes.toString("utf8"));
          assert.ok(expected.includes(response.statusCode),`${method} ${path}: expected ${expected.join("/")}, received ${response.statusCode} (${result.body.code||result.body.error||"unexpected response"}).`);
          finish(null,result);
        } catch(error) { finish(error,result); }
      });
    });
    req.once("error",(error)=>finish(error));
    timer=setTimeout(()=>req.destroy(new Error(`${method} ${path} exceeded the 30-second local deadline.`)),30000);
    req.end(payload);
  });
}

async function allUsers(users,operation) {
  const outcomes=await Promise.allSettled(users.map(operation));
  const failures=outcomes.filter((outcome)=>outcome.status==="rejected");
  if(failures.length)throw new AggregateError(failures.map((outcome)=>outcome.reason),`${failures.length} virtual user(s) failed: ${failures[0].reason.message}`);
}

async function phase(name,operation) {
  assert.equal(inFlight,0);
  const started=performance.now(),before=observations.length;
  phasePeak=0;
  await operation();
  const durationMs=performance.now()-started,requests=observations.length-before;
  phases.push({name,requests,durationMs:Number(durationMs.toFixed(1)),requestsPerSecond:Number((requests/(durationMs/1000)).toFixed(1)),peakInFlight:phasePeak});
}

function fixturePlan(user,round=0,variant=0) {
  return {
    version:1,restDay:"Sunday",restDays:["Sunday"],
    days:Object.fromEntries(DAYS.map((day,dayIndex)=>[
      day,dayIndex%2===0&&dayIndex<6?Array.from({length:4},(_,slot)=>({
        instanceId:`load-user-${user.index}-day-${dayIndex}-slot-${slot}`,
        exerciseId:user.exerciseIds[(user.index+dayIndex+slot)%user.exerciseIds.length],
        sets:3+(round%3),reps:variant===1?"6-8":variant===2?"12-15":"8-12"
      })):[]
    ]))
  };
}

function save(user,plan,revision,options={}) {
  return request(user,"/api/plan",{
    method:"PUT",metric:"plan.save",body:{plan,expectedPlanUpdatedAt:revision,userId:user.otherId},...options
  });
}

function checkedIdentity(user,body) {
  assert.equal(body.user.id,user.id,"A session returned another user's identity.");
  assert.equal(body.user.email,user.email);
}

function checkedPlan(user,result) {
  checkedIdentity(user,result.body);
  assert.deepEqual(result.body.plan,user.plan,"An account read a different private plan.");
  assert.equal(result.body.planUpdatedAt,user.revision);
  assert.equal(result.headers["cache-control"],"no-store");
}

function fixtureWorkout(user) {
  const startedAt=Date.now();
  const entry=(id,exerciseId,measurement,loadType,count)=>({id,exerciseId,measurement,loadType,unit:"kg",prescribedReps:measurement==="timed"?"30 seconds":"8-12",
    sets:Array.from({length:count},()=>({reps:null,weight:null,seconds:null,completed:false}))});
  return {id:`load-workout-${user.index}`,title:`Private workout ${user.index}`,planDay:"Monday",date:new Date(startedAt).toISOString().slice(0,10),
    status:"active",startedAt,completedAt:null,elapsedSeconds:0,restEndsAt:null,
    entries:[entry("external","flat-dumbbell-press","reps","external",3),entry("bodyweight","standard-pushup","reps","bodyweight",1),
      entry("timed","front-plank","timed","bodyweight",1),entry("assisted","pullup","reps","assisted",1)]};
}

function saveWorkout(user,workout,revision,options={}) {
  return request(user,`/api/workouts/${workout.id}`,{method:"PUT",metric:"workout.save",body:{workout,expectedRevision:revision,userId:user.otherId},...options});
}

function checkedWorkout(user,result) {
  assert.deepEqual(result.body.workout,user.workout,"An account read another workout or lost its logged set data.");
  assert.equal(result.headers["cache-control"],"no-store");
}

function checkedWorkoutHistory(user,result) {
  assert.equal(result.headers["cache-control"],"no-store");
  assert.equal(result.body.hasMore,false);
  assert.equal(result.body.workouts.length,1,"Workout history must contain only this account's session.");
  const [summary]=result.body.workouts;
  assert.equal(summary.id,user.workout.id);assert.equal(summary.revision,user.workout.revision);
  assert.equal(summary.status,"completed");assert.equal(summary.totalSets,6);assert.equal(summary.completedSets,6);
  const external=summary.exerciseSummaries.find((entry)=>entry.loadType==="external");
  assert.equal(external.volume,user.workout.entries[0].sets.reduce((total,set)=>total+set.reps*set.weight,0));
  for(const entry of summary.exerciseSummaries.filter((entry)=>entry.loadType!=="external")) {
    assert.equal(entry.volume,0,"Bodyweight and assistance must not produce invented external-load volume.");
    assert.equal(entry.maxWeight,null,"Assistance is not a lifted-weight personal record.");
  }
  assert.equal(summary.exerciseSummaries.find((entry)=>entry.measurement==="timed").totalSeconds,30+user.index);
}

async function startServer(dataDirectory) {
  const environment=isolatedServerEnvironment(dataDirectory);
  // This checked-in test environment is an allowlist, not a copy of the shell:
  // no production credentials, payment provider, or transactional emails.
  assert.equal(environment.NODE_ENV,"test");
  assert.equal(environment.TRUST_PROXY,"false");
  assert.equal(environment.TURSO_DATABASE_URL,"");
  assert.equal(environment.RESEND_API_KEY,"");
  const child=spawn(process.execPath,["server.js"],{cwd:ROOT,env:environment,stdio:["ignore","pipe","pipe"]});
  try {
    const url=await new Promise((resolveUrl,reject)=>{
      let output="",errors="",settled=false;
      const timer=setTimeout(()=>finish(new Error("Load server startup exceeded 10 seconds.")),10000);
      function finish(error,value) {
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        if(error)reject(error);else resolveUrl(value);
      }
      child.stdout.on("data",(chunk)=>{
        output=(output+chunk.toString()).slice(-8192);
        const match=output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
        if(match)finish(null,`http://127.0.0.1:${match[1]}`);
      });
      child.stderr.on("data",(chunk)=>{errors=(errors+chunk.toString()).slice(-8192);});
      child.once("error",(error)=>finish(error));
      child.once("exit",(code,signal)=>finish(new Error(`Load server exited before startup (${code??signal}): ${errors}`)));
    });
    return {child,url,stopMonitoring:monitorServer(child,resourceSegments.length===0?"initial server":"restarted server")};
  } catch(error) {
    await stopServer(child);
    throw error;
  }
}

async function stopServer(child) {
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  await new Promise((resolveStop)=>{
    const timer=setTimeout(()=>child.kill("SIGKILL"),2000);
    child.once("exit",()=>{clearTimeout(timer);resolveStop();});
    child.kill("SIGTERM");
  });
}

function report() {
  const results=[...new Set(observations.map((item)=>item.metric))].map((metric)=>{
    const samples=observations.filter((item)=>item.metric===metric);
    const durations=samples.map((item)=>item.durationMs).sort((left,right)=>left-right);
    const percentile=(fraction)=>Number(durations[Math.max(0,Math.ceil(durations.length*fraction)-1)].toFixed(2));
    const p95Ms=percentile(0.95),budgetP95Ms=metric.startsWith("auth.")?AUTH_P95_BUDGET_MS:OTHER_P95_BUDGET_MS;
    const errors=samples.filter((item)=>item.failed).length;
    return {metric,requests:samples.length,medianMs:percentile(0.5),p95Ms,maxMs:percentile(1),budgetP95Ms,errors,passed:errors===0&&p95Ms<=budgetP95Ms};
  });
  return {
    workloadCompleted,
    runtime:{node:process.version,platform:process.platform,architecture:process.arch,logicalCpusAvailable:availableParallelism(),hostMemoryMiB:Math.round(totalmem()/1048576)},
    resources:{measurement:"Application child process /proc status and CPU ticks; ready-to-stop intervals; memory high-water mark includes startup",sampleIntervalMs:RESOURCE_SAMPLE_MS,
      cpuTimeMs:resourceSegments.reduce((total,item)=>total+item.userCpuMs+item.systemCpuMs,0),
      peakResidentMemoryMiB:Math.max(0,...resourceSegments.map((item)=>item.peakResidentMemoryMiB)),segments:resourceSegments},
    users:USERS,rounds:ROUNDS,sourceMode:SHARED_IP?"one shared source IP":"100 distinct source IPs",storage:"isolated local SQLite",requestCount:observations.length,
    unexpectedHttpErrors:observations.filter((item)=>item.failed).length,
    expectedConflictResponses:observations.filter((item)=>item.status===409).length,
    phases,results,
    scope:"100 real signup/login sessions; compressed catalog reads; 100 concurrent plan and workout workflows; competing plan and workout tab saves; workout create retries, set logging, completion and history summaries; CSRF and cross-account read/write/delete isolation; malformed-input rejection; identity auth limits across real and spoofed addresses; restart persistence; stale and successful workout deletion; logout revocation. All production network and identity rate limits remain enabled.",
    limitations:[
      "Local regression evidence only: does not certify hosted capacity, Turso latency/quotas, email delivery, billing, browser rendering, or internet traffic.",
      SHARED_IP?"All 100 signups/logins share one real source IP. The separate 10-attempt identity guard is also checked after the main workload.":"Virtual users have separate real source IPs. Run again with --shared-ip to verify 100 people sharing a public address.",
      "Signup uses the existing explicit test-only verification bypass; no email provider or payment service is contacted.",
      "CPU and memory are measured for the local application process only, excluding the load generator and any production database, proxy, or platform overhead. Local latency budgets are regression limits, not production SLOs."
    ]
  };
}

async function main() {
  assert.equal(process.platform,"linux","This script uses Linux's 127.0.0.0/8 loopback interface; run it on Linux/CI without weakening auth limits.");
  mkdirSync(join(ROOT,"test-runtime"),{recursive:true});
  const directory=mkdtempSync(join(ROOT,"test-runtime","load-100-"));
  const users=Array.from({length:USERS},(_,index)=>({index,agent:newAgent(index),email:`load-user-${index}@example.test`,password:`isolated-load-password-${index}-only`}));
  let server;
  try {
    server=await startServer(directory);
    baseUrl=server.url;
    const status=await request(users[0],"/api/status",{metric:"status"});
    assert.deepEqual(Object.keys(status.body).sort(),["ok","version"],"the public status shows nothing about the setup");

    await phase("100 simultaneous signups",()=>allUsers(users,async(user)=>{
      const result=await request(user,"/api/signup",{method:"POST",metric:"auth.signup",expected:[201],body:{name:`Load User ${user.index}`,email:user.email,password:user.password}});
      user.id=result.body.user.id;
      user.signupCookie=result.headers["set-cookie"]?.find((value)=>value.startsWith("strata_session="))?.split(";",1)[0];
      assert.ok(user.signupCookie,"Signup did not create a real session cookie.");
    }));
    assert.equal(new Set(users.map((user)=>user.id)).size,USERS);
    await phase("100 simultaneous logins",()=>allUsers(users,async(user)=>{
      const result=await request(user,"/api/login",{method:"POST",metric:"auth.login",body:{email:user.email,password:user.password}});
      checkedIdentity(user,result.body);
      user.cookie=result.headers["set-cookie"]?.find((value)=>value.startsWith("strata_session="))?.split(";",1)[0];
      assert.ok(user.cookie);
      assert.notEqual(user.cookie,user.signupCookie,"Login must mint a new session token.");
      user.otherId=users[(user.index+1)%USERS].id;
    }));
    assert.equal(new Set(users.map((user)=>user.cookie)).size,USERS);

    await phase("Session and compressed catalog reads",()=>allUsers(users,async(user)=>{
      const plan=await request(user,"/api/plan",{metric:"plan.initial"});
      checkedIdentity(user,plan.body);
      assert.equal(plan.body.planUpdatedAt,0);
      assert.ok(plan.body.csrfToken);
      user.csrfToken=plan.body.csrfToken;
      user.plan=plan.body.plan;
      user.revision=0;
      const catalog=await request(user,"/exercises.json",{metric:"catalog.read"});
      assert.ok(Array.isArray(catalog.body)&&catalog.body.length>=100);
      assert.equal(catalog.headers["content-encoding"],"gzip","Catalog transfer must exercise the compressed response path.");
      user.exerciseIds=catalog.body.map((exercise)=>exercise.id);
    }));
    assert.equal(new Set(users.map((user)=>user.csrfToken)).size,USERS);

    await phase("100 concurrent private planning workflows",()=>allUsers(users,async(user)=>{
      for(let round=0;round<ROUNDS;round+=1) {
        const current=await request(user,`/api/plan?userId=${encodeURIComponent(user.otherId)}`,{metric:"plan.read"});
        checkedPlan(user,current);
        const plan=fixturePlan(user,round);
        const saved=await save(user,plan,user.revision);
        assert.deepEqual(saved.body.plan,plan);
        assert.ok(Number.isSafeInteger(saved.body.planUpdatedAt)&&saved.body.planUpdatedAt>user.revision);
        user.plan=plan;
        user.revision=saved.body.planUpdatedAt;
        checkedPlan(user,await request(user,"/api/plan",{metric:"plan.read"}));
      }
    }));
    assert.equal(phases.at(-1).peakInFlight,USERS,"The main workload must actually overlap 100 requests.");

    await phase("100 pairs of competing tab saves",()=>allUsers(users,async(user)=>{
      const revision=user.revision,left=fixturePlan(user,ROUNDS,1),right=fixturePlan(user,ROUNDS,2);
      const responses=await Promise.all([
        save(user,left,revision,{metric:"plan.race",expected:[200,409]}),
        save(user,right,revision,{metric:"plan.race",expected:[200,409]})
      ]);
      assert.deepEqual(responses.map((result)=>result.status).sort(),[200,409],"Exactly one competing write must succeed.");
      const winner=responses.find((result)=>result.status===200),loser=responses.find((result)=>result.status===409);
      assert.equal(loser.body.code,"PLAN_CHANGED");
      assert.deepEqual(loser.body.plan,winner.body.plan);
      assert.equal(loser.body.planUpdatedAt,winner.body.planUpdatedAt);
      assert.ok(winner.body.planUpdatedAt>revision);
      user.plan=winner.body.plan;
      user.revision=winner.body.planUpdatedAt;
      const retry=await save(user,user.plan,revision,{metric:"plan.retry"});
      assert.equal(retry.body.reused,true);
      assert.equal(retry.body.planUpdatedAt,user.revision,"A duplicate save cannot advance the revision.");
    }));

    // Strata+ has no free trial, so every virtual member gets access the way the owner grants it.
    for(const user of users)grantStrataPlus(directory,user.id);

    await phase("100 concurrent workout starts and safe retries",()=>allUsers(users,async(user)=>{
      user.createdWorkout=fixtureWorkout(user);
      const created=await request(user,"/api/workouts",{method:"POST",metric:"workout.create",expected:[201],body:{workout:user.createdWorkout,userId:user.otherId}});
      assert.equal(created.body.workout.revision,1);
      user.workout=created.body.workout;
      const retry=await request(user,"/api/workouts",{method:"POST",metric:"workout.createRetry",body:{workout:user.createdWorkout}});
      checkedWorkout(user,retry);
    }));

    await phase("100 concurrent interrupted workout logging workflows",()=>allUsers(users,async(user)=>{
      for(let round=0;round<ROUNDS;round+=1) {
        checkedWorkout(user,await request(user,`/api/workouts/${user.workout.id}`,{metric:"workout.resume"}));
        const workout=structuredClone(user.workout);
        Object.assign(workout.entries[0].sets[round%3],{reps:8+round,weight:20+user.index,seconds:null,completed:true});
        Object.assign(workout.entries[1].sets[0],{reps:10+user.index,weight:null,seconds:null,completed:true});
        Object.assign(workout.entries[2].sets[0],{reps:null,weight:null,seconds:30+user.index,completed:true});
        Object.assign(workout.entries[3].sets[0],{reps:6,weight:15,seconds:null,completed:true});
        workout.elapsedSeconds=(round+1)*60;workout.restEndsAt=Date.now()+60000;
        const saved=await saveWorkout(user,workout,user.workout.revision);
        assert.equal(saved.body.workout.revision,user.workout.revision+1);
        assert.deepEqual(saved.body.workout.entries,workout.entries);
        user.workout=saved.body.workout;
      }
    }));
    assert.equal(phases.at(-1).peakInFlight,USERS,"Workout logging must actually overlap 100 requests.");

    await phase("100 pairs of competing workout saves",()=>allUsers(users,async(user)=>{
      const revision=user.workout.revision,left=structuredClone(user.workout),right=structuredClone(user.workout);
      left.title=`Left tab workout ${user.index}`;right.title=`Right tab workout ${user.index}`;
      const responses=await Promise.all([
        saveWorkout(user,left,revision,{metric:"workout.race",expected:[200,409]}),
        saveWorkout(user,right,revision,{metric:"workout.race",expected:[200,409]})
      ]);
      assert.deepEqual(responses.map((result)=>result.status).sort(),[200,409],"Exactly one workout tab must save its change.");
      const winner=responses.find((result)=>result.status===200),loser=responses.find((result)=>result.status===409);
      assert.equal(loser.body.code,"WORKOUT_CONFLICT");
      assert.deepEqual(loser.body.workout,winner.body.workout);
      user.workout=winner.body.workout;
      checkedWorkout(user,await request(user,`/api/workouts/${user.workout.id}`,{metric:"workout.afterConflict"}));
    }));

    await phase("100 reliable completions and accurate private histories",()=>allUsers(users,async(user)=>{
      const workout=structuredClone(user.workout);
      // Even STRATA_LOAD_ROUNDS=1 logs the remaining sets before completion.
      for(const set of workout.entries[0].sets)if(!set.completed)Object.assign(set,{reps:8,weight:20+user.index,completed:true});
      workout.status="completed";workout.completedAt=Date.now();workout.restEndsAt=null;
      const saved=await saveWorkout(user,workout,user.workout.revision,{metric:"workout.complete"});
      assert.equal(saved.body.workout.revision,user.workout.revision+1);
      user.workout=saved.body.workout;
      checkedWorkoutHistory(user,await request(user,`/api/workouts?limit=20&offset=0&userId=${encodeURIComponent(user.otherId)}`,{metric:"workout.history"}));
      const retry=await request(user,"/api/workouts",{method:"POST",metric:"workout.lateCreateRetry",body:{workout:user.createdWorkout}});
      checkedWorkout(user,retry);
      assert.equal(retry.body.workout.status,"completed","A late create retry must not erase logged progress.");
    }));

    await phase("CSRF and private account isolation",()=>allUsers(users,async(user)=>{
      const other=users[(user.index+1)%USERS];
      const denied=await save(user,fixturePlan(user,99),user.revision,{metric:"security.csrf",expected:[403],headers:{"X-CSRF-Token":other.csrfToken}});
      assert.equal(denied.body.code,"INVALID_CSRF");
      checkedPlan(user,await request(user,`/api/plan?userId=${encodeURIComponent(other.id)}`,{metric:"plan.isolation"}));
      const otherWorkout={...user.workout,id:other.workout.id};
      for(const method of ["GET","PUT","DELETE"]) {
        const response=await request(user,`/api/workouts/${other.workout.id}`,{method,metric:`workout.isolation.${method.toLowerCase()}`,expected:[404],
          ...(method==="GET"?{}:{body:{workout:otherWorkout,expectedRevision:other.workout.revision}})});
        assert.equal(response.body.code,"WORKOUT_NOT_FOUND","Another account's workout must not be exposed or changed.");
      }
      const blocked=await saveWorkout(user,user.workout,user.workout.revision,{metric:"workout.csrf",expected:[403],headers:{"X-CSRF-Token":other.csrfToken}});
      assert.equal(blocked.body.code,"INVALID_CSRF");
      checkedWorkout(user,await request(user,`/api/workouts/${user.workout.id}`,{metric:"workout.afterIsolation"}));
    }));
    await request({...users[0],cookie:"",csrfToken:""},"/api/plan",{metric:"security.anonymous",expected:[401]});
    await request({...users[0],cookie:"",csrfToken:""},"/api/workouts",{metric:"security.anonymousWorkout",expected:[401]});

    await phase("Malformed JSON value rejection",async()=>{
      for(const path of ["/api/signup","/api/login","/api/plan","/api/workouts"]) {
        for(const body of [null,[]]) {
          const rejected=await request(users[0],path,{
            method:path==="/api/plan"?"PUT":"POST",metric:"security.malformedBody",body,expected:[400]
          });
          assert.equal(rejected.body.error,"Invalid JSON.");
        }
      }
      checkedPlan(users[0],await request(users[0],"/api/plan",{metric:"plan.afterMalformedInput"}));
    });

    await phase("Identity auth limit persists across source changes",async()=>{
      const user=users[0];
      // Two earlier auth attempts plus eight failures consume this identity's
      // ten-attempt bucket, leaving the larger network bucket available.
      // Changing forwarded values or the real source must not reset it.
      for(let attempt=0;attempt<9;attempt+=1) {
        const result=await request(user,"/api/login",{
          method:"POST",metric:"auth.rateGuard",expected:[attempt<8?401:429],
          headers:{"X-Forwarded-For":`198.51.100.${attempt+1}`},body:{email:user.email,password:"deliberately-incorrect-password"}
        });
        if(attempt===8)assert.equal(result.headers["retry-after"],"900");
      }
      const alternateAgent=newAgent(220,false);
      try {
        const denied=await request({...user,agent:alternateAgent},"/api/login",{
          method:"POST",metric:"auth.rateGuardCrossIp",expected:[429],
          headers:{"X-Forwarded-For":"203.0.113.99"},body:{email:user.email,password:user.password}
        });
        assert.equal(denied.headers["retry-after"],"900");
      } finally { alternateAgent.destroy(); }
      const other=users[1];
      // Keep the throttled user's source address to prove that locking one
      // identity does not prevent an unrelated member on that IP signing in.
      const allowed=await request({...other,agent:user.agent},"/api/login",{
        method:"POST",metric:"auth.unrelatedIdentity",body:{email:other.email,password:other.password}
      });
      checkedIdentity(other,allowed.body);
    });

    for(const user of users)user.agent.destroy();
    server.stopMonitoring();
    await stopServer(server.child);
    server=await startServer(directory);
    baseUrl=server.url;
    for(const user of users)user.agent=newAgent(user.index);
    await phase("Restart durability across all 100 accounts",()=>allUsers(users,async(user)=>{
      checkedPlan(user,await request(user,"/api/plan",{metric:"plan.afterRestart"}));
      checkedWorkout(user,await request(user,`/api/workouts/${user.workout.id}`,{metric:"workout.afterRestart"}));
      checkedWorkoutHistory(user,await request(user,"/api/workouts?limit=20&offset=0",{metric:"workout.historyAfterRestart"}));
    }));
    await phase("100 stale deletion guards and intentional deletions",()=>allUsers(users,async(user)=>{
      const path=`/api/workouts/${user.workout.id}`;
      const stale=await request(user,path,{method:"DELETE",metric:"workout.staleDelete",expected:[409],body:{expectedRevision:user.workout.revision-1}});
      assert.equal(stale.body.code,"WORKOUT_CONFLICT");checkedWorkout(user,stale);
      await request(user,path,{method:"DELETE",metric:"workout.delete",body:{expectedRevision:user.workout.revision}});
      await request(user,path,{metric:"workout.afterDelete",expected:[404]});
      const history=await request(user,"/api/workouts?limit=20&offset=0",{metric:"workout.emptyHistory"});
      assert.deepEqual(history.body.workouts,[]);assert.equal(history.body.hasMore,false);
    }));
    await phase("Logout revokes all 100 tested sessions",()=>allUsers(users,async(user)=>{
      await request(user,"/api/logout",{method:"POST",metric:"auth.logout",body:{}});
      await request(user,"/api/plan",{metric:"security.revokedSession",expected:[401]});
      await request(user,"/api/workouts",{metric:"security.revokedWorkoutSession",expected:[401]});
    }));

    server.stopMonitoring();workloadCompleted=true;
    const evidence=report();
    if(process.argv.includes("--json"))console.log(JSON.stringify(evidence,null,2));
    else {
      console.table(evidence.phases);
      console.table(evidence.results);
      console.log(`${USERS} users (${evidence.sourceMode}), ${ROUNDS} rounds, ${evidence.requestCount} requests, ${evidence.expectedConflictResponses} correctly rejected conflicts.`);
      console.log(evidence.limitations.join("\n"));
    }
    reportPrinted=true;
    assert.ok(evidence.results.every((result)=>result.passed),"Local p95 capacity-regression budget exceeded; inspect the output before release.");
  } finally {
    for(const user of users)user.agent.destroy();
    server?.stopMonitoring();
    await stopServer(server?.child);
    rmSync(directory,{recursive:true,force:true});
  }
}

if(require.main===module)main().catch((error)=>{
  if(process.argv.includes("--json")&&!reportPrinted)console.log(JSON.stringify(report(),null,2));
  console.error(error.message);process.exitCode=1;
});

module.exports={USERS,ROUNDS,SHARED_IP,fixturePlan,fixtureWorkout,AUTH_P95_BUDGET_MS,OTHER_P95_BUDGET_MS};
