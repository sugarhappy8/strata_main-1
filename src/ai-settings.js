// @ts-check
"use strict";

// Strata AI consent, the Daily Brief choice, deleting stored AI notes, and the owner's usage view. Consent
// and deletion work for every signed-in member, Strata+ or not, so a member can always withdraw or clean up.

const CONSENT_VERSION=1;

/** @param {any} row */
function settingsPayload(row){
  return {consent:row?.consent_at!=null,consentedAt:row?.consent_at==null?null:Number(row.consent_at),dailyBrief:row?Number(row.daily_brief)===1:true,version:CONSENT_VERSION};
}

/**
 * @param {{store:any,auth:{requireSession:Function,validCsrf:Function},trustedOrigin:(req:any)=>boolean,rateAllowed:(req:any,key:string,max:number,windowMs:number)=>boolean|Promise<boolean>,
 *   http:{json:Function,bodyJson:Function},quota:{adminSummary:(limit?:number)=>Promise<any>},admin:{requireAdmin:Function},now?:()=>number}} dependencies
 */
function createAiSettingsService({store,auth,trustedOrigin,rateAllowed,http,quota,admin,now=Date.now}){
  const {json,bodyJson}=http,routes=new Map([["/api/ai/settings",["GET","PUT"]],["/api/ai/notes",["DELETE"]],["/api/ai/usage",["GET"]]]),noStore={"Cache-Control":"private, no-store"};
  /** @param {string} code @param {string} message @param {number} status */
  const failure=(code,message,status)=>Object.assign(new Error(message),{code,status});
  /** @param {any} req @param {any} session */
  function validMutation(req,session){
    if(!trustedOrigin(req))throw failure("AI_ORIGIN_REQUIRED","Security check failed. Refresh and try again.",403);
    if(!auth.validCsrf(req,session))throw failure("INVALID_CSRF","Security check failed. Refresh and try again.",403);
    if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"]||"")))throw failure("JSON_REQUIRED","Strata AI settings must use JSON.",415);
  }
  /** @param {any} req @param {any} res @param {URL} url */
  async function handleApi(req,res,url){
    const allowed=routes.get(url.pathname);if(!allowed)return false;
    const method=String(req.method);
    if(!allowed.includes(method)){json(res,405,{error:"Method not allowed."},{Allow:allowed.join(", ")});return true;}
    // The owner's view of today's requests and tokens, in total and for the heaviest members.
    if(url.pathname==="/api/ai/usage"){const session=await admin.requireAdmin(req,res);if(!session)return true;json(res,200,{usage:await quota.adminSummary(10)},noStore);return true;}
    const session=await auth.requireSession(req,res);if(!session)return true;
    try{
      if(method==="GET"){json(res,200,{settings:settingsPayload(await store.aiSettings(String(session.id))),csrfToken:session.csrf_token},noStore);return true;}
      validMutation(req,session);
      if(!await rateAllowed(req,`identity:ai:settings:${session.id}`,30,60000))throw failure("AI_RATE_LIMIT","Too many changes. Wait a moment.",429);
      if(method==="DELETE"){await store.deleteDailyBriefs(String(session.id),now());json(res,200,{deleted:true,csrfToken:session.csrf_token},noStore);return true;}
      const input=await bodyJson(req),extra=Object.keys(input&&typeof input==="object"?input:{}).filter((key)=>!["consent","dailyBrief"].includes(key));
      if(extra.length||typeof input?.consent!=="boolean"||(input.dailyBrief!==undefined&&typeof input.dailyBrief!=="boolean"))throw failure("AI_INVALID_REQUEST","Choose whether Strata AI may use your training data.",400);
      const current=await store.aiSettings(String(session.id)),time=now();
      const saved=await store.upsertAiSettings(String(session.id),{consentAt:input.consent?Number(current?.consent_at)||time:null,consentVersion:CONSENT_VERSION,dailyBrief:input.dailyBrief??(current?Number(current.daily_brief)===1:true),updatedAt:time});
      if(!saved)throw failure("AI_ACCOUNT_CHANGED","Your account changed. Reload and try again.",409);
      json(res,200,{settings:settingsPayload(saved),csrfToken:session.csrf_token},noStore);
    }catch(error){
      const known=/** @type {any} */(error);if(!known?.status)throw error;
      json(res,known.status,{error:known.message,code:known.code||"AI_SETTINGS_FAILED"});
    }
    return true;
  }
  return {handleApi};
}

module.exports={CONSENT_VERSION,createAiSettingsService,settingsPayload};
