// @ts-check
"use strict";

// Strata AI routes. Requests wait in a small queue (the ai_jobs table) because the provider's capacity is limited:
// the page submits a request, receives an id, and polls for the result, so no HTTP request is held open while the
// model works. The queue survives a restart; a request a restart interrupted runs again. Proposals are returned for
// review; nothing else is saved here.

const {randomUUID}=require("node:crypto");const {aiResponseFormat}=require("./ai-response-schema");
const {LIMITS,aiError,directAnswerOnly,interpretReply,memberContext,planItems,previewNutrition,promptMessages,requestText,sanitizeHistory,searchTerms}=require("./ai-core");
const {candidateExercises,readRequest,searchCatalog}=require("./ai-catalog");
const {planEditContext,planEditContract,planEditIssue,planEditReply,planExerciseIds,sanitizeDraftPlan}=require("./ai-plan-edits");
const {fallbackPlanResponse}=require("./ai-plan-fallback");
const {addDays,currentWeekStart,localDate}=require("./coaching-core");
const {compatibleWeek,readCoachingEvidence}=require("./coaching-evidence");
const {profilePayload}=require("./coaching");
const {workoutPayload}=require("./workouts");
const {buildDataContext}=require("./ai-context");
const {settingsPayload}=require("./ai-settings");

const DAY_MS=24*60*60*1000;
// How long a running request may go before another start treats it as interrupted.
const JOB_LEASE_MS=10*60*1000;
const SWEEP_MS=60*1000;
// Failures that happen before the model does any work do not count against the member's daily requests.
const REFUNDED=new Set(["AI_OFFLINE","AI_AUTH","AI_UNAVAILABLE","AI_NOT_CONFIGURED"]);
const SHORTER="Your previous answer was cut off. Keep the reply under 40 words and use at most 7 exercises per day.";const JSON_REPAIR='Return one JSON object with the named fields "reply", "week", "nutrition", "suggestions", and "search". Never put positional null or arrays after the week.';
/** @param {number} time @param {unknown} zone */
function weekdayName(time,zone){try{return new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:String(zone||"UTC")}).format(time);}catch{return new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:"UTC"}).format(time);}}

/**
 * @param {{store:any,auth:any,requireAccess:(req:any,res:any)=>Promise<any>,trustedOrigin:(req:any)=>boolean,rateAllowed:(req:any,key:string,max:number,windowMs:number)=>boolean|Promise<boolean>,
 *   http:{json:Function,bodyJson:Function},provider:{configured:boolean,model:string,complete:Function,health:Function},getPlanSnapshot:(userId:string)=>Promise<{plan:any,updatedAt:number}>,
 *   quota:ReturnType<typeof import("./ai-quota").createAiQuota>,dataService?:any,logger?:{info:Function,warn:Function}|null,now?:()=>number,config?:{maxConcurrent?:number,maxQueue?:number,resultTtlMs?:number,healthTtlMs?:number},
 *   isUniqueViolation?:(error:unknown)=>boolean}} dependencies
 */
function createAiService({store,auth,requireAccess,trustedOrigin,rateAllowed,http,provider,getPlanSnapshot,quota,dataService=null,logger=null,now=Date.now,config={},isUniqueViolation=(error)=>/UNIQUE/i.test(String(/** @type {any} */(error)?.message||""))}){
  if(!store||!auth||typeof requireAccess!=="function"||typeof trustedOrigin!=="function"||typeof rateAllowed!=="function"||!http||!provider||typeof getPlanSnapshot!=="function"||!quota)throw new TypeError("Strata AI requires storage, access guards, rate limiting, HTTP helpers, a provider, and plan reads.");
  const {json,bodyJson}=http;
  const maxConcurrent=Math.max(1,Math.floor(config.maxConcurrent??3)),maxQueue=Math.max(1,Math.floor(config.maxQueue??20));
  const resultTtlMs=config.resultTtlMs??10*60*1000,healthTtlMs=config.healthTtlMs??30*1000;
  // Members whose new request is between its checks and joining the queue; marked before the first await.
  /** @type {Set<string>} */
  const inFlight=new Set();
  let running=0,pumping=false,pumpAgain=false,lastSweep=0;
  /** @type {{checkedAt:number,online:boolean,code:string|null}} */
  let health={checkedAt:0,online:false,code:null};

  /** Answers are kept for a few minutes; a request whose server stopped mid-run is queued again. */
  async function sweep(){
    const time=now();if(time-lastSweep<SWEEP_MS)return;lastSweep=time;
    await store.deleteFinishedAiJobs(time-resultTtlMs);await store.requeueStaleAiJobs(time);
  }
  /** @param {unknown} value */
  const parsed=(value)=>{try{return value==null?null:JSON.parse(String(value));}catch{return null;}};
  /** @param {import("./domain-types").AiJobRow} row */
  async function publicJob(row){
    const status=String(row.status),position=status==="queued"?await store.aiJobPosition(String(row.id)):0;
    return {id:row.id,kind:row.kind,status,position,...(status==="done"?{result:parsed(row.result_json)}:{}),...(status==="failed"?{error:parsed(row.error_json)}:{})};
  }

  /** What STRATA knows about the member, read fresh when the request starts. @param {string} userId */
  async function memberData(userId){
    const time=now();
    const [snapshot,profileRow,workoutRows]=await Promise.all([getPlanSnapshot(userId),store.coachingProfile(userId),store.workouts(userId,40,0)]);
    const profile=profilePayload(profileRow),cutoff=time-28*DAY_MS;
    const workouts=(workoutRows||[]).map((/** @type {any} */ row)=>{try{return workoutPayload(row,true);}catch{return null;}}).filter((/** @type {any} */ workout)=>workout&&Number(workout.completedAt||workout.startedAt||0)>=cutoff);
    let nutrition=null;
    if(profile){
      const todayDate=localDate(time,profile.timeZone),weekRow=await store.coachingWeek(userId,currentWeekStart(time,profile.timeZone)),week=compatibleWeek(weekRow,profile);
      const logs=(await store.coachingDailyLogs(userId,addDays(todayDate,-13),todayDate))||[],recent=logs.filter((/** @type {any} */ row)=>row.log_date>addDays(todayDate,-7)&&Number(row.calories)>0);
      const targets=Array.isArray(week?.nutrition?.dailyTargets)?week.nutrition.dailyTargets.map((/** @type {any} */ item)=>Number(item.calories)).filter((/** @type {number} */ value)=>value>0):[];
      const weights=logs.filter((/** @type {any} */ row)=>row.morning_weight_kg!=null).map((/** @type {any} */ row)=>({date:String(row.log_date),kg:Number(row.morning_weight_kg)})).sort((/** @type {any} */ a,/** @type {any} */ b)=>a.date.localeCompare(b.date));
      const first=weights[0],last=weights.at(-1),span=first&&last?(Date.parse(`${last.date}T00:00:00Z`)-Date.parse(`${first.date}T00:00:00Z`))/DAY_MS:0;
      nutrition={averageTarget:targets.length?Math.round(targets.reduce((/** @type {number} */ sum,/** @type {number} */ value)=>sum+value,0)/targets.length):null,loggedDays:recent.length,averageIntake:recent.length?Math.round(recent.reduce((/** @type {number} */ sum,/** @type {any} */ row)=>sum+Number(row.calories),0)/recent.length):null,weeklyWeightChangeKg:first&&last&&span>=7?Math.round((last.kg-first.kg)/span*7*10)/10:null};
    }
    return {plan:snapshot.plan,planUpdatedAt:snapshot.updatedAt,profile,workouts,nutrition,weekday:weekdayName(time,profile?.timeZone),dataContext:await recentDays(userId,profile,time)};
  }
  /** Recent days from the shared data layer (snapshots, Training Log, signals, plan history), compact and capped. @param {string} userId @param {any} profile @param {number} time */
  async function recentDays(userId,profile,time){
    if(!dataService)return "";
    const date=localDate(time,profile?.timeZone||"UTC"),[snapshots,entries,signals,changes]=await Promise.all([dataService.snapshots.read(userId,{from:addDays(date,-13),to:date,today:date}).catch(()=>[]),dataService.trainingLog.read(userId,{from:addDays(date,-6),to:date,today:date}).catch(()=>[]),dataService.rankingsSignals(userId).catch(()=>null),dataService.planChanges(userId,3).catch(()=>[])]);
    return buildDataContext({snapshots,entries,signals,planChanges:changes,brief:snapshots.at(-1)?.date===date?snapshots.at(-1).brief:null}).text;
  }

  /** One provider call for a job, with its tokens counted toward the day. @param {any} job @param {any} request */
  async function counted(job,request){const result=await provider.complete(request);job.tokens+=Number(result?.usage?.totalTokens)||0;return result;}
  /** @param {any} job */
  async function run(job){
    const started=now();
    try{
      const data=await memberData(job.userId),limitations=data.profile?.movementLimitations||[],request=requestText(job);
      const draftPlan=job.draftPlan&&Number(job.draftPlanUpdatedAt)===Number(data.planUpdatedAt)?job.draftPlan:null;
      const answerOnly=job.kind==="chat"&&directAnswerOnly(job.message),basePlan=draftPlan||data.plan,contract=answerOnly?null:planEditContract(job.message,basePlan);
      const pinned=[...new Set([...planItems(data.plan).map((item)=>item.exerciseId),...planExerciseIds(draftPlan)])].slice(0,48),named=readRequest(request).named;
      const shortlist=(/** @type {string[]} */ extra)=>candidateExercises({equipment:data.profile?.availableEquipment||[],limitations,experience:data.profile?.experience||"intermediate",pinned,request,extra});
      const member=[memberContext({profile:data.profile,plan:data.plan,workouts:data.workouts,nutrition:data.nutrition,today:data.weekday}),data.dataContext].filter(Boolean).join("\n\n");
      /** @type {string[]} */
      let extra=[],candidates=shortlist(extra);
      const context=()=>[member,job.kind==="chat"&&(draftPlan||contract)?planEditContext({basePlan,source:draftPlan?"latest proposed week":"saved weekly plan",candidates,contract}):""].filter(Boolean).join("\n\n");
      const complete=(/** @type {string} */ note,/** @type {boolean} */ compact,/** @type {number} */ temperature)=>counted(job,{messages:promptMessages({kind:job.kind,message:job.message,history:contract?[]:job.history,context:context(),candidates,keep:new Set([...pinned,...named,...extra]),note,compact}),maxTokens:1100,temperature,responseFormat:aiResponseFormat({codes:candidates.map((item)=>item.code),requireWeek:Boolean(contract),trainingDays:contract?.trainingDays??null,trainingDayNames:contract?.targetTrainingDays??[],answerOnly})});
      const ask=async(/** @type {string} */ note,forceCompact=false)=>{
        let compact=forceCompact,first;
        // A context overflow gets one compact retry without history and with a smaller shortlist.
        try{first=await complete(note,compact,0.3);}catch(error){if(/** @type {any} */(error)?.code!=="AI_TOO_LARGE")throw error;compact=true;first=await complete(note,true,0.3);}
        // A small local model occasionally breaks or overruns its JSON; one quieter retry usually fixes it.
        return first.data?first:complete([note,JSON_REPAIR,first.truncated?SHORTER:""].filter(Boolean).join("\n\n"),true,0.1);
      };
      let completion=await ask("");
      // The model may ask STRATA to search the full library once before it answers.
      const searched=searchTerms(completion.data);
      if(searched.length){
        extra=searchCatalog(searched,limitations);candidates=shortlist(extra);
        completion=await ask(extra.length?`STRATA searched its library for: ${searched.join(", ")}. The matches are now in the shortlist. Answer the member now and do not search again.`:`STRATA found no library exercises for: ${searched.join(", ")}. Answer with the shortlist, say what was not found, and do not search again.`);
      }
      // Content-free diagnostics help the owner tell a weak model from a broken tunnel; answers are never logged.
      if(!completion.data)logger?.warn?.("ai.unreadable_answer",{chars:String(completion.text||"").length,truncated:Boolean(completion.truncated),startsWithBrace:/^\s*\{/.test(String(completion.text||""))});
      const read=()=>{try{return /** @type {any} */(interpretReply(completion.data,{candidates,plan:data.plan,limitations,answerOnly}));}catch(error){if(!contract||/** @type {any} */(error)?.code!=="AI_BAD_OUTPUT")throw error;return null;}};
      let result=read(),mismatch=result?planEditIssue(contract,result.week):"The answer did not contain a readable structured week.";
      if(mismatch){completion=await ask(`Correction required: ${mismatch} Return the complete corrected week now, do not search, and keep every requirement in the plan edit contract.`,true);result=read();mismatch=result?planEditIssue(contract,result.week):"The corrected answer was not readable.";}
      if(mismatch){const fallback=fallbackPlanResponse({basePlan,contract,candidates});if(fallback){result=/** @type {any} */(interpretReply(fallback,{candidates,plan:data.plan,limitations,answerOnly}));mismatch=planEditIssue(contract,result.week);}}
      if(mismatch)throw aiError("AI_BAD_OUTPUT","Strata AI could not make a week that matched that change. Try naming the training days or exact session length.");
      if(contract?.replySafe)result.reply=planEditReply(contract,result.week);
      if(result.nutrition){
        if(!data.profile)result.nutrition={changes:result.nutrition,needsSetup:true,message:"Calorie targets come from your personal setup. Complete it once, then ask again."};
        else{
          // Targets proposed alongside a new week follow that week's training days, since both are applied together.
          try{result.nutrition={...previewNutrition({profile:data.profile,changes:result.nutrition,plan:result.week?.plan??data.plan,evidence:await readCoachingEvidence(store,job.userId,currentWeekStart(now(),data.profile.timeZone),data.profile),timestamp:now()}),basedOn:result.week?"proposed":"saved"};}
          catch(error){const failure=/** @type {any} */(error);if(!failure?.status)throw error;result.nutrition={changes:result.nutrition,needsSetup:true,message:failure.message};}
        }
      }
      job.result={...result,searched,planUpdatedAt:data.planUpdatedAt};job.status="done";
    }catch(error){
      const failure=/** @type {any} */(error);
      job.error={code:failure?.code||"AI_FAILED",message:failure?.status?failure.message:"Strata AI could not finish that request. Try again."};job.status="failed";
      if(REFUNDED.has(job.error.code)&&!job.tokens)void quota.refund("chat",job.userId,job.usageDate).catch(()=>{});
      if(!failure?.status)logger?.warn?.("ai.request_failed",{error});
    }finally{
      void quota.record("chat",job.userId,job.usageDate,job.tokens).catch(()=>{});
      // The member's message and history are dropped with the request; only the answer is kept, briefly.
      const finishedAt=now(),done=job.status==="done";
      await store.finishAiJob(job.id,{status:done?"done":"failed",tokens:job.tokens,resultJson:done?JSON.stringify(job.result):null,errorJson:done?null:JSON.stringify(job.error),finishedAt}).catch((/** @type {unknown} */ error)=>logger?.warn?.("ai.request_save_failed",{error}));
      logger?.info?.("ai.request",{kind:job.kind,status:job.status,code:job.error?.code||null,durationMs:finishedAt-started});
    }
  }
  /** A claimed row as the request run() works on. @param {import("./domain-types").AiJobRow} row */
  function jobFrom(row){
    const request=parsed(row.request_json)||{};
    return {id:String(row.id),userId:String(row.user_id),kind:String(row.kind),usageDate:String(row.usage_date),tokens:0,status:"running",result:null,error:null,
      message:request.message??"",history:request.history??[],draftPlan:request.draftPlan??null,draftPlanUpdatedAt:request.draftPlanUpdatedAt??null};
  }
  /** Starts queued requests, oldest first, up to the concurrency limit. A call while it is busy makes it look again. */
  async function pump(){
    if(pumping){pumpAgain=true;return;}
    pumping=true;
    try{
      do{
        pumpAgain=false;
        while(running<maxConcurrent){
          const row=await store.claimAiJob(now()+JOB_LEASE_MS);if(!row)break;
          running+=1;void run(jobFrom(row)).finally(()=>{running-=1;void pump();});
        }
      }while(pumpAgain);
    }catch(error){logger?.warn?.("ai.queue_failed",{error});}
    finally{pumping=false;}
  }

  async function checkHealth(){
    if(!provider.configured)return {online:false,code:"AI_NOT_CONFIGURED"};
    if(now()-health.checkedAt<healthTtlMs)return {online:health.online,code:health.code};
    try{await provider.health();health={checkedAt:now(),online:true,code:null};}
    catch(error){health={checkedAt:now(),online:false,code:/** @type {any} */(error)?.code||"AI_OFFLINE"};}
    return {online:health.online,code:health.code};
  }

  /** @param {any} req @param {any} session */
  function validMutation(req,session){
    if(!trustedOrigin(req))throw aiError("AI_ORIGIN_REQUIRED","Security check failed. Refresh and try again.",403);
    if(!auth.validCsrf(req,session))throw aiError("INVALID_CSRF","Security check failed. Refresh and try again.",403);
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"]||"")))throw aiError("JSON_REQUIRED","Strata AI requests must use JSON.",415);
  }

  /** @param {any} req @param {any} res @param {URL} url */
  async function handleApi(req,res,url){
    const jobMatch=url.pathname.match(/^\/api\/ai\/requests\/([a-f0-9-]{36})$/);
    if(url.pathname!=="/api/ai/status"&&url.pathname!=="/api/ai/requests"&&!jobMatch)return false;
    const session=await requireAccess(req,res);if(!session)return true;
    try{
      await sweep();
      const method=String(req.method),allowed=url.pathname==="/api/ai/requests"?"POST":"GET";
      if(method!==allowed){json(res,405,{error:"Method not allowed."},{Allow:allowed});return true;}
      if(method==="GET"&&!await rateAllowed(req,`identity:ai:read:${session.id}`,240,60000))throw aiError("AI_RATE_LIMIT","Too many Strata AI checks. Wait a moment.",429);
      if(url.pathname==="/api/ai/status"){
        const [state,member,settings]=await Promise.all([checkHealth(),quota.memberStatus(String(session.id)),store.aiSettings(String(session.id))]),choice=settingsPayload(settings);
        json(res,200,{configured:provider.configured,online:state.online,code:state.code,...member,consent:choice.consent,dailyBrief:choice.dailyBrief,hasProfile:Boolean(profilePayload(await store.coachingProfile(session.id))),csrfToken:session.csrf_token});return true;
      }
      if(jobMatch){
        const row=await store.aiJob(jobMatch[1]??"",String(session.id));
        if(!row)throw aiError("AI_REQUEST_NOT_FOUND","That Strata AI request has expired. Ask again.",404);
        if(row.status==="queued")void pump();
        json(res,200,{request:await publicJob(row),csrfToken:session.csrf_token});return true;
      }
      validMutation(req,session);
      if(!await rateAllowed(req,`identity:ai:write:${session.id}`,12,60000))throw aiError("AI_RATE_LIMIT","You are asking faster than Strata AI can answer. Wait a moment.",429);
      const userId=String(session.id);
      if(inFlight.has(userId))throw inProgress();
      inFlight.add(userId);
      try{await submit(req,res,session);}finally{inFlight.delete(userId);}
    }catch(error){
      const failure=/** @type {any} */(error);if(!failure?.status)throw error;
      json(res,failure.status,{error:failure.message,code:failure.code||"AI_FAILED"});
    }
    return true;
  }

  const inProgress=()=>aiError("AI_REQUEST_IN_PROGRESS","Strata AI is still working on your last request.",409);

  /** Reads, checks, and queues one new request while the member is marked in flight. @param {any} req @param {any} res @param {any} session */
  async function submit(req,res,session){
    if(await store.activeAiJob(String(session.id)))throw inProgress();
    const input=await bodyJson(req),extra=Object.keys(input).filter((key)=>!["kind","message","history","draftPlan","draftPlanUpdatedAt","expectedUserId"].includes(key));
    if(extra.length)throw aiError("AI_INVALID_REQUEST",`Request contains unsupported fields: ${extra.join(", ")}.`,400);
    if(input.expectedUserId!==undefined&&String(input.expectedUserId)!==String(session.id))throw aiError("AI_ACCOUNT_CHANGED","Your account changed. Reload before asking again.",409);
    const kind=input.kind==="suggestions"?"suggestions":input.kind==="chat"?"chat":null;
    if(!kind)throw aiError("AI_INVALID_REQUEST","Choose a chat message or suggestions.",400);
    if(kind!=="chat"&&(input.draftPlan!==undefined||input.draftPlanUpdatedAt!==undefined))throw aiError("AI_INVALID_REQUEST","Draft plans are only valid for chat requests.",400);
    const message=typeof input.message==="string"?input.message.trim():"";
    if(kind==="chat"&&(!message||message.length>LIMITS.messageChars))throw aiError("AI_INVALID_REQUEST",`Write a message of 1 to ${LIMITS.messageChars} characters.`,400);
    const history=sanitizeHistory(input.history),draftPlan=kind==="chat"?sanitizeDraftPlan(input.draftPlan):null,draftPlanUpdatedAt=draftPlan?Number(input.draftPlanUpdatedAt):null;
    if(draftPlan&&(typeof draftPlanUpdatedAt!=="number"||!Number.isSafeInteger(draftPlanUpdatedAt)||draftPlanUpdatedAt<0))throw aiError("AI_INVALID_REQUEST","A draft plan needs the saved-plan revision it was based on.",400);
    if(!draftPlan&&input.draftPlanUpdatedAt!==undefined)throw aiError("AI_INVALID_REQUEST","A draft-plan revision needs a draft plan.",400);
    if(!provider.configured)throw aiError("AI_NOT_CONFIGURED","Strata AI is not set up on this server yet.",503);
    if(await store.queuedAiJobs()>=maxQueue)throw aiError("AI_BUSY","Strata AI is busy with other members. Try again in a minute.",503);
    // Nothing reaches the provider without the member's consent; the shared daily budget is claimed last.
    if(!settingsPayload(await store.aiSettings(String(session.id))).consent)throw aiError("AI_CONSENT_REQUIRED","Allow Strata AI to share your training summary with Groq first.",409);
    const claim=await quota.reserve("chat",String(session.id));
    if(!claim.ok)throw claim.code==="AI_DAILY_LIMIT"?aiError("AI_DAILY_LIMIT",`You have used today's ${quota.limits.userDaily} Strata AI requests. They reset at midnight UTC.`,429):claim.code==="AI_RESTING"?aiError("AI_RESTING","Strata AI is resting for today and will be back tomorrow. Your Daily Brief is still on the Overview.",503):aiError("AI_BUSY","Strata AI is busy right now. Try again in a minute.",503);
    let row;
    try{row=await store.insertAiJob({id:randomUUID(),userId:String(session.id),kind,requestJson:JSON.stringify({message,history,draftPlan,draftPlanUpdatedAt}),usageDate:String(claim.date),createdAt:now()});}
    catch(error){
      // The database allows one unfinished request per member, whichever server took it.
      await quota.refund("chat",String(session.id),String(claim.date)).catch(()=>{});
      if(isUniqueViolation(error))throw inProgress();
      throw error;
    }
    if(!row)throw aiError("AI_FAILED","Strata AI could not queue that request. Try again.",503);
    const request=await publicJob(row);void pump();
    json(res,202,{request,csrfToken:session.csrf_token});
  }

  /** At startup, requests a stopped server left running are queued again, then the queue starts. Single-instance only. */
  async function start(){
    await store.requeueStaleAiJobs(Number.MAX_SAFE_INTEGER);
    await pump();
  }

  return {handleApi,start,cleanup:()=>{lastSweep=0;return sweep();},stats:()=>({running})};
}

module.exports={createAiService};
