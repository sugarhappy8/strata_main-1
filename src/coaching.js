// @ts-check
"use strict";

const {ENERGY_MODEL_VERSION,GENERATION_VERSION,addDays,currentWeekStart,localDate,generateCoachingWeek,sanitizeCoachingProfile,sanitizeDailyLog,validDate,weekStartForDate}=require("./coaching-core");
const {compatibleWeek,readCoachingDiary,readCoachingEvidence,storedWeek,targetsForWeek}=require("./coaching-evidence");
const {CALIBRATION_DAYS}=require("./energy-calibration-core");
const {generateRemainingDayFoodOptions}=require("./meal-planning-core");

/** @param {string} message @param {number} [status] @param {string} [code] */
function coachingError(message,status=400,code="INVALID_COACHING_REQUEST"){return Object.assign(new Error(message),{status,code});}
/** @param {unknown} value @param {string} label @returns {Record<string,any>} */
function object(value,label){if(!value||typeof value!=="object"||Array.isArray(value))throw coachingError(`${label} must be an object.`);return value;}
/** @param {Record<string,any>} value @param {string[]} allowed @param {string} label */
function exactKeys(value,allowed,label){const extra=Object.keys(value).filter((key)=>!allowed.includes(key));if(extra.length)throw coachingError(`${label} contains unsupported fields: ${extra.join(", ")}.`);}
/** @param {unknown} value @param {string} label */
function revision(value,label){if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw coachingError(`${label} is missing or invalid. Refresh and try again.`);return value;}
/** @param {any} row */
function profilePayload(row){
  if(!row)return null;
  try{
    const stored=object(JSON.parse(String(row.profile_json)),"Stored coaching profile"),storedSessions=stored.sessionsPerWeek;
    delete stored.sessionsPerWeek;
    const profile=sanitizeCoachingProfile(stored,{allowLegacyProfile:true});
    if(storedSessions!==profile.sessionsPerWeek)throw new Error("Stored session count does not match workout days.");
    return {...profile,revision:Number(row.revision),updatedAt:Number(row.updated_at)};
  }catch{return null;}
}
/** @param {any} row */
function weekPayload(row){
  if(!row)return null;
  try{
    const week=object(JSON.parse(String(row.snapshot_json)),"Stored coaching week");
    if(week.weekStart!==row.week_start||week.planKey!==row.plan_key||week.profileRevision!==Number(row.profile_revision))return null;
    return week;
  }catch{return null;}
}
/** @param {any} row @param {any} target */
function logPayload(row,target=null){
  if(!row)return null;
  const calories=Number(row.calories),targetCalories=target?.calories==null?null:Number(target.calories);
  return {date:String(row.log_date),calories,proteinG:row.protein_g==null?null:Number(row.protein_g),carbsG:row.carbs_g==null?null:Number(row.carbs_g),fatG:row.fat_g==null?null:Number(row.fat_g),morningWeightKg:row.morning_weight_kg==null?null:Number(row.morning_weight_kg),complete:row.intake_complete==null?null:Number(row.intake_complete)===1,revision:Number(row.revision),updatedAt:Number(row.updated_at),targetCalories,remainingCalories:targetCalories==null?null:Math.max(0,targetCalories-calories),overCalories:targetCalories==null?null:Math.max(0,calories-targetCalories)};
}

/**
 * @param {import("./domain-types").CoachingServiceDependencies} dependencies
 * @returns {import("./domain-types").CoachingService}
 */
function createCoachingService({store,auth,requireAccess,trustedOrigin,rateAllowed,http,now=Date.now}){
  if(!store||!auth||typeof requireAccess!=="function"||typeof trustedOrigin!=="function"||typeof rateAllowed!=="function"||!http)throw new TypeError("Coaching service requires storage, access guards, rate limiting, and HTTP helpers.");
  const {json,bodyJson}=http;
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").SessionRow} session */
  function validMutation(req,session){
    if(!trustedOrigin(req))throw coachingError("Coaching security check failed. Refresh and try again.",403,"COACHING_ORIGIN_REQUIRED");
    if(!auth.validCsrf(req,session))throw coachingError("Security check failed. Refresh and try again.",403,"INVALID_CSRF");
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"]||"")))throw coachingError("Coaching updates must use JSON.",415,"JSON_REQUIRED");
  }
  /** @param {string} userId */
  async function readProfile(userId){
    const row=await store.coachingProfile(userId),profile=profilePayload(row);
    if(row&&!profile)throw coachingError("Your coaching profile could not be read safely. Contact support before replacing it.",500,"COACHING_PROFILE_UNREADABLE");
    return profile;
  }
  /** @param {string} userId @param {any} profile @param {number} timestamp @param {any} [prepared] */
  async function ensureWeek(userId,profile,timestamp,prepared=null){
    const weekStart=currentWeekStart(timestamp,profile.timeZone),existingRow=await store.coachingWeek(userId,weekStart),existing=compatibleWeek(existingRow,profile),expectedEnergySemantics=profile.version>=4?"mifflin_structured_activity_v4":profile.version===3?"nasem_2023_whole_day_eer":"legacy_rmr_activity_multiplier";
    if(existing&&existing.profileRevision===profile.revision&&existing.inputs?.version===profile.version&&existing.nutrition?.energySemantics===expectedEnergySemantics)return existing;
    const input={...profile};delete input.revision;delete input.updatedAt;
    const generated=prepared&&prepared.weekStart===weekStart?prepared:generateCoachingWeek(input,profile.revision,weekStart,timestamp,await readCoachingEvidence(store,userId,weekStart,profile));
    const record={userId,weekStart,planKey:generated.planKey,profileRevision:profile.revision,snapshotJson:JSON.stringify(generated),generatedAt:timestamp};
    const saved=await store.upsertCoachingWeek(record),current=compatibleWeek(saved||await store.coachingWeek(userId,weekStart),profile);
    if(!current||current.profileRevision!==profile.revision)throw coachingError("Your coaching profile changed while this week was generated. Refresh and try again.",409,"COACHING_PROFILE_CHANGED");
    return current;
  }
  /** @param {string} userId @param {any} profile @param {any} week @param {number} timestamp */
  async function diaryResponse(userId,profile,week,timestamp){
    const diary=await readCoachingDiary(store,userId,week,localDate(timestamp,profile.timeZone)),targets=new Map(diary.logTargets.map(target=>[target.date,target]));
    return {week:{...week,logTargets:diary.logTargets,diaryStartDate:diary.diaryStartDate,diaryEndDate:diary.diaryEndDate,modelUpdateAvailable:week.energyModelVersion!==ENERGY_MODEL_VERSION||week.generationVersion!==GENERATION_VERSION},logs:diary.rows.map(row=>logPayload(row,targets.get(row.log_date)))};
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function handleApi(req,res,url){
    const logMatch=url.pathname.match(/^\/api\/coaching\/logs\/(\d{4}-\d{2}-\d{2})$/),foodMatch=url.pathname.match(/^\/api\/coaching\/food-options\/(\d{4}-\d{2}-\d{2})$/),recognized=Boolean(logMatch||foodMatch||url.pathname==="/api/coaching/profile"||url.pathname==="/api/coaching/week");
    if(!recognized)return false;
    const session=await requireAccess(req,res);if(!session)return true;
    try{
      const allowed=logMatch?["GET","PUT"]:url.pathname==="/api/coaching/profile"?["GET","PUT"]:["GET"];
      if(!allowed.includes(String(req.method))){json(res,405,{error:"Method not allowed."},{Allow:allowed.join(", ")});return true;}
      const write=req.method!=="GET";
      if(!rateAllowed(req,`identity:coaching:${write?"write":"read"}:${session.id}`,write?60:180,60000))throw coachingError("Too many coaching requests. Wait a moment and retry.",429,"COACHING_RATE_LIMIT");
      if(write)validMutation(req,session);
      if(url.pathname==="/api/coaching/profile"){
        if(req.method==="GET"){json(res,200,{profile:await readProfile(session.id),csrfToken:session.csrf_token});return true;}
        const input=object(await bodyJson(req),"Request");exactKeys(input,["profile","expectedRevision","expectedUserId"],"Request");const expectedRevision=revision(input.expectedRevision,"Expected profile version");
        if(input.expectedUserId!==undefined&&String(input.expectedUserId)!==String(session.id))throw coachingError("Your account changed. Reload before saving this profile.",409,"COACHING_ACCOUNT_CHANGED");
        const profile=sanitizeCoachingProfile(input.profile),timestamp=now(),weekStart=currentWeekStart(timestamp,profile.timeZone),prepared=generateCoachingWeek(profile,expectedRevision+1,weekStart,timestamp,await readCoachingEvidence(store,session.id,weekStart,{...profile,revision:expectedRevision+1}));
        const saved=await store.upsertCoachingProfile(session.id,JSON.stringify(profile),timestamp,expectedRevision);
        if(!saved){json(res,409,{error:"This coaching profile changed elsewhere. Review the latest version before saving.",code:"COACHING_PROFILE_CHANGED",profile:await readProfile(session.id)});return true;}
        const output=profilePayload(saved);if(!output)throw coachingError("The coaching profile was saved but could not be read safely.",500,"COACHING_PROFILE_UNREADABLE");
        const week=await ensureWeek(session.id,output,timestamp,prepared);
        json(res,200,{ok:true,profile:output,...await diaryResponse(session.id,output,week,timestamp),csrfToken:session.csrf_token});return true;
      }
      const profile=await readProfile(session.id);
      if(!profile)throw coachingError("Complete your personal setup before opening a personalized week.",409,"COACHING_PROFILE_REQUIRED");
      const timestamp=now(),week=await ensureWeek(session.id,profile,timestamp);
      if(url.pathname==="/api/coaching/week"){json(res,200,{...await diaryResponse(session.id,profile,week,timestamp),csrfToken:session.csrf_token});return true;}
      if(!logMatch&&!foodMatch)throw coachingError("Coaching route not found.",404,"COACHING_ROUTE_NOT_FOUND");
      const logDate=validDate((logMatch||foodMatch)?.[1]);
      if(foodMatch&&weekStartForDate(logDate)!==week.weekStart)throw coachingError(`Daily entries are open for the current coaching week (${week.weekStart} to ${week.weekEnd}).`,400,"COACHING_LOG_OUTSIDE_CURRENT_WEEK");
      const today=localDate(timestamp,profile.timeZone);
      if(logMatch&&(logDate<addDays(today,-CALIBRATION_DAYS)||logDate>today))throw coachingError(`Record actual intake and morning weight from ${addDays(today,-CALIBRATION_DAYS)} through today (${today}). Future observations cannot be logged.`,400,"COACHING_LOG_OUTSIDE_DIARY_WINDOW");
      const targetWeek=weekStartForDate(logDate)===week.weekStart?week:storedWeek(await store.coachingWeek(session.id,weekStartForDate(logDate))),target=targetsForWeek(targetWeek,logDate,logDate).get(logDate)||null;
      if(foodMatch){
        if(!profile.mealPreferences)throw coachingError("Add your food preferences before asking STRATA for meal options.",409,"MEAL_PREFERENCES_REQUIRED");
        if(!target)throw coachingError("That day has no nutrition target in the current coaching week.",409,"COACHING_TARGET_REQUIRED");
        const row=await store.coachingDailyLog(session.id,logDate),log=logPayload(row,target),consumedCalories=log?.calories||0,remainingRatio=Math.max(0,target.calories-consumedCalories)/target.calories,mealsRemaining=Math.max(1,Math.min(profile.mealPreferences.mealsPerDay,Math.ceil(profile.mealPreferences.mealsPerDay*remainingRatio))),macrosKnown=!log||[log.proteinG,log.carbsG,log.fatG].every((value)=>Number.isFinite(value)),macros=macrosKnown?target.macros:null;
        const options=generateRemainingDayFoodOptions({mealPreferences:profile.mealPreferences,target:{calories:target.calories,proteinG:macros?.proteinG??null,carbsG:macros?.carbsG??null,fatG:macros?.fatG??null,costCents:0},consumed:{calories:consumedCalories,proteinG:macrosKnown?log?.proteinG??0:null,carbsG:macrosKnown?log?.carbsG??0:null,fatG:macrosKnown?log?.fatG??0:null,costCents:0},mealsRemaining,seed:`${week.weekStart}\0${logDate}\0${session.id}`});
        json(res,200,{date:logDate,day:target.day,target,log,mealsRemaining,...options,csrfToken:session.csrf_token});return true;
      }
      if(req.method==="GET"){json(res,200,{log:logPayload(await store.coachingDailyLog(session.id,logDate),target),csrfToken:session.csrf_token});return true;}
      const input=object(await bodyJson(req),"Request");exactKeys(input,["log","expectedRevision","expectedUserId"],"Request");const expectedRevision=revision(input.expectedRevision,"Expected log version"),logInput=object(input.log,"Calorie log");
      if(input.expectedUserId!==undefined&&String(input.expectedUserId)!==String(session.id))throw coachingError("Your account changed. Reload before saving this entry.",409,"COACHING_ACCOUNT_CHANGED");
      const sanitized=sanitizeDailyLog(logInput),has=(/** @type {string} */ key)=>Object.hasOwn(logInput,key),macroKeys=["proteinG","carbsG","fatG"],preserveMacros=macroKeys.every(key=>!has(key)),needsExisting=preserveMacros||!has("morningWeightKg")||!has("complete"),existingLog=needsExisting?await store.coachingDailyLog(session.id,logDate):null;
      const log={...sanitized,morningWeightKg:has("morningWeightKg")?sanitized.morningWeightKg:existingLog?.morning_weight_kg??null,complete:has("complete")?sanitized.complete:existingLog?.intake_complete==null?null:Number(existingLog.intake_complete)===1,...(preserveMacros?{proteinG:existingLog?.protein_g??null,carbsG:existingLog?.carbs_g??null,fatG:existingLog?.fat_g??null}:{})},saved=await store.upsertCoachingDailyLog({userId:session.id,logDate,...log,updatedAt:timestamp},expectedRevision);
      if(!saved){json(res,409,{error:"This daily entry changed elsewhere. Review the latest values before saving.",code:"COACHING_LOG_CHANGED",log:logPayload(await store.coachingDailyLog(session.id,logDate),target)});return true;}
      json(res,200,{ok:true,log:logPayload(saved,target),csrfToken:session.csrf_token});
    }catch(error){
      const failure=/** @type {Error&{status?:number,code?:string}} */(error);if(!failure.status)throw error;
      json(res,failure.status,{error:failure.message,code:failure.code||"INVALID_COACHING_REQUEST"});
    }
    return true;
  }
  return {handleApi};
}

module.exports={createCoachingService,logPayload,profilePayload,weekPayload};
