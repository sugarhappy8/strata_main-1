// @ts-check
"use strict";

const {createHash,timingSafeEqual}=require("node:crypto");
const {exportPayload,exportWorkout,streamExport}=require("./account-export");
const ROUTES=new Set(["/api/account/sessions","/api/account/sessions/revoke","/api/account/sessions/revoke-others","/api/account/export"]);
const PUBLIC_SESSION_ID=/^[A-Za-z0-9_-]{43}$/;
/** @param {string} tokenHash */
function publicSessionId(tokenHash){return createHash("sha256").update("strata-account-session:v1\0").update(tokenHash).digest("base64url");}
/** @param {unknown} left @param {unknown} right */
function safeEqual(left,right){const a=Buffer.from(String(left??"")),b=Buffer.from(String(right??""));return a.length===b.length&&a.length>0&&timingSafeEqual(a,b);}

/** @param {any} row @param {string} currentTokenHash */
function sessionPayload(row,currentTokenHash){
  return {id:publicSessionId(String(row.token_hash)),current:safeEqual(row.token_hash,currentTokenHash),createdAt:Number(row.created_at),expiresAt:Number(row.expires_at)};
}

/**
 * @param {import("./domain-types").AccountSelfServiceDependencies} dependencies
 * @returns {import("./domain-types").AccountSelfService}
 */
function createAccountSelfService({store,http,requireSession,validCsrf,rateAllowed,logger=console,now=Date.now}){
  const {json,bodyJson,securityHeaders}=http;
  /** @param {import("./domain-types").SessionRow} session */
  async function sessionsFor(session){
    const sessions=await store.accountSessions(session.id,session.token_hash,now());
    return sessions.map((row)=>sessionPayload(row,session.token_hash));
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function mutationSession(req,res){
    const session=await requireSession(req,res);if(!session)return null;
    if(!validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return null;}
    return session;
  }
  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function handleApi(req,res,url){
    if(!ROUTES.has(url.pathname))return false;
    try{
      if(url.pathname==="/api/account/sessions"&&req.method==="GET"){
        const session=await requireSession(req,res);if(!session)return true;
        const sessions=await sessionsFor(session);
        json(res,200,{userId:session.id,sessions,otherCount:sessions.filter((item)=>!item.current).length});return true;
      }
      if(url.pathname==="/api/account/sessions/revoke"&&req.method==="POST"){
        const session=await mutationSession(req,res);if(!session)return true;
        const input=/** @type {Record<string,unknown>} */(await bodyJson(req)),sessionId=String(input.sessionId||"");
        if(!PUBLIC_SESSION_ID.test(sessionId)){json(res,400,{error:"Choose a valid signed-in session.",code:"INVALID_SESSION"});return true;}
        const owned=await store.accountSessions(session.id,session.token_hash,now());
        const target=owned.find((row)=>safeEqual(publicSessionId(String(row.token_hash)),sessionId));
        if(!target){json(res,404,{error:"That signed-in session is no longer active.",code:"SESSION_NOT_FOUND"});return true;}
        if(safeEqual(target.token_hash,session.token_hash)){json(res,409,{error:"The current session cannot be revoked here. Use Sign out instead.",code:"CURRENT_SESSION_PROTECTED"});return true;}
        if(!await rateAllowed(req,`identity:account-session-revoke:${session.id}`,30)){json(res,429,{error:"Too many session changes. Wait a moment and try again.",code:"SESSION_RATE_LIMIT"});return true;}
        const revoked=await store.revokeAccountSession(session.id,String(target.token_hash),session.token_hash,now());
        if(!revoked){json(res,404,{error:"That signed-in session is no longer active.",code:"SESSION_NOT_FOUND"});return true;}
        const sessions=await sessionsFor(session);json(res,200,{ok:true,revoked:1,sessions,otherCount:sessions.filter((item)=>!item.current).length});return true;
      }
      if(url.pathname==="/api/account/sessions/revoke-others"&&req.method==="POST"){
        const session=await mutationSession(req,res);if(!session)return true;
        await bodyJson(req);
        if(!await rateAllowed(req,`identity:account-session-revoke:${session.id}`,30)){json(res,429,{error:"Too many session changes. Wait a moment and try again.",code:"SESSION_RATE_LIMIT"});return true;}
        const revoked=await store.revokeOtherAccountSessions(session.id,session.token_hash,now());
        const sessions=await sessionsFor(session);json(res,200,{ok:true,revoked,sessions,otherCount:sessions.filter((item)=>!item.current).length});return true;
      }
      if(url.pathname==="/api/account/export"&&req.method==="POST"){
        const session=await mutationSession(req,res);if(!session)return true;
        await bodyJson(req);
        if(!await rateAllowed(req,`identity:account-export:${session.id}`,5)){json(res,429,{error:"Too many exports were requested. Wait a moment and try again.",code:"ACCOUNT_EXPORT_RATE_LIMIT"});return true;}
        const exportedAt=now(),rows=await store.accountExport(session.id);
        if(!rows){json(res,409,{error:"The signed-in account changed. Refresh and try again.",code:"ACCOUNT_CHANGED"});return true;}
        await streamExport(res,store,session.id,rows,exportedAt,securityHeaders());return true;
      }
      json(res,405,{error:"Method not allowed."},{Allow:url.pathname==="/api/account/sessions"?"GET":"POST"});return true;
    }catch(error){
      const failure=/** @type {{status?:unknown,message?:unknown}} */(error),status=Number(failure?.status);
      if(Number.isInteger(status)&&status>=400&&status<500){json(res,status,{error:String(failure.message||"Invalid account request."),code:"INVALID_ACCOUNT_REQUEST"});return true;}
      logger.error("Account self-service request failed:",error);
      if(res.headersSent){if(!res.writableEnded)res.destroy();return true;}
      json(res,503,{error:"Account self-service is temporarily unavailable. Please try again.",code:"ACCOUNT_SELF_SERVICE_UNAVAILABLE"});return true;
    }
  }
  return Object.freeze({handleApi});
}

module.exports={createAccountSelfService,exportPayload,exportWorkout,publicSessionId,streamExport};
