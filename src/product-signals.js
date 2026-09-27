// @ts-check
"use strict";

const {createHmac,randomBytes}=require("node:crypto");

const RETENTION_DAYS=90;
const DAY_MS=24*60*60*1000;
const RATE_WINDOW_MS=15*60*1000;
/** @type {readonly import("./domain-types").ProductSignalEvent[]} */
const EVENTS=Object.freeze([
  "preview_generated",
  "onboarding_previewed",
  "onboarding_saved",
  "plan_saved",
  "workout_started",
  "workout_completed",
  "upgrade_viewed",
  "trial_started",
  "checkout_opened",
  "upgrade_activated",
  "recommendation_feedback_useful",
  "recommendation_feedback_not_relevant",
  "recommendation_feedback_not_clear"
]);
const EVENT_SET=/** @type {ReadonlySet<string>} */(new Set(EVENTS));

/** @param {number} [timestamp] */
function utcDay(timestamp=Date.now()){
  const value=Number(timestamp),date=new Date(Number.isFinite(value)?value:Date.now());
  return date.toISOString().slice(0,10);
}

/** @param {number} timestamp @param {number} days */
function dayBefore(timestamp,days){return utcDay(Number(timestamp)-Math.max(0,days)*DAY_MS);}

/**
 * Typed boundary for anonymous aggregate activity counts and the elevated readout.
 * @param {import("./domain-types").ProductSignalsServiceDependencies} dependencies
 * @returns {import("./domain-types").ProductSignalsService}
 */
function createProductSignalsService({store,admin,trustedOrigin,requestAddress,rateKeyAllowed,http,now=Date.now}){
  if(!store||!admin||typeof trustedOrigin!=="function"||typeof requestAddress!=="function"||typeof rateKeyAllowed!=="function"||!http?.json||!http?.bodyJson){
    throw new TypeError("Product-signal service dependencies are incomplete.");
  }
  const rateSalt=randomBytes(32);
  const clock=typeof now==="function"?now:Date.now;

  /** @param {import("./domain-types").HttpRequest} req */
  function anonymousRateKey(req){
    return createHmac("sha256",rateSalt).update(String(requestAddress(req)||"unknown")).digest("hex");
  }

  /** @param {import("./domain-types").HttpRequest} req */
  function validJsonRequest(req){
    return String(req.headers["content-type"]||"").toLowerCase().startsWith("application/json");
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function accept(req,res){
    if(req.method!=="POST"){
      http.json(res,405,{error:"Method not allowed.",code:"PRODUCT_SIGNAL_METHOD"},{Allow:"POST"});
      return;
    }
    if(!trustedOrigin(req)){
      http.json(res,403,{error:"Product activity sharing requires a same-origin request.",code:"PRODUCT_SIGNAL_ORIGIN_REQUIRED"});
      return;
    }
    if(!validJsonRequest(req)){
      http.json(res,415,{error:"Product activity requests must use JSON.",code:"JSON_REQUIRED"});
      return;
    }
    const rateKey=anonymousRateKey(req);
    if(!rateKeyAllowed(`product-signals:network:${rateKey}`,60,RATE_WINDOW_MS)||!rateKeyAllowed("product-signals:global",5000,RATE_WINDOW_MS)){
      http.json(res,429,{error:"Too many product activity updates. Wait and try again.",code:"PRODUCT_SIGNAL_RATE_LIMIT"});
      return;
    }
    const input=/** @type {Record<string,unknown>} */(await http.bodyJson(req)),keys=Object.keys(input);
    if(keys.length!==1||keys[0]!=="event"||typeof input.event!=="string"||!EVENT_SET.has(input.event)){
      http.json(res,400,{error:"Unknown product activity event.",code:"PRODUCT_SIGNAL_INVALID"});
      return;
    }
    await store.incrementProductSignal(utcDay(clock()),/** @type {import("./domain-types").ProductSignalEvent} */(input.event));
    http.json(res,202,{accepted:true});
  }

  /**
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function readAggregate(req,res,url){
    if(req.method!=="GET"){
      http.json(res,405,{error:"Method not allowed.",code:"PRODUCT_SIGNAL_ADMIN_METHOD"},{Allow:"GET"});
      return;
    }
    const session=await admin.requireAdmin(req,res);
    if(!session)return;
    // Number(null) and Number("") are 0, so a missing or blank range must be
    // recognized before conversion to keep the intended 30-day default.
    const rawDays=url.searchParams.get("days")?.trim()||"",requested=rawDays?Number(rawDays):Number.NaN;
    const days=Number.isSafeInteger(requested)?Math.max(1,Math.min(RETENTION_DAYS,requested)):30;
    const timestamp=Number(clock()),throughDay=utcDay(timestamp),sinceDay=dayBefore(timestamp,days-1);
    const rows=await store.productSignalCounts(sinceDay,throughDay);
    const counts=rows
      .map((row)=>({day:String(row.event_day),name:String(row.event_name),count:Math.max(0,Number(row.event_count)||0)}))
      .filter((entry)=>EVENT_SET.has(entry.name));
    const totals=/** @type {Record<string,number>} */(Object.fromEntries(EVENTS.map((name)=>[name,0])));
    for(const entry of counts)if(EVENT_SET.has(entry.name))totals[entry.name]=(totals[entry.name]||0)+entry.count;
    http.json(res,200,{
      scope:{
        days,sinceDay,throughDay,retentionDays:RETENTION_DAYS,
        measure:"aggregate_action_counts",uniquePeople:false,repeatedActionsIncrement:true
      },
      totals,counts
    });
  }

  /**
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function handleApi(req,res,url){
    if(url.pathname==="/api/product-signals"){await accept(req,res);return true;}
    if(url.pathname==="/api/admin/product-signals"){await readAggregate(req,res,url);return true;}
    return false;
  }

  /** @param {number} [timestamp] */
  async function cleanup(timestamp=clock()){
    return store.deleteOldProductSignals(dayBefore(Number(timestamp),RETENTION_DAYS-1));
  }

  return Object.freeze({handleApi,cleanup});
}

module.exports={EVENTS,RETENTION_DAYS,utcDay,createProductSignalsService};
