"use strict";

const {createAdminUserActions}=require("./admin-user-actions");
const {adminGrantState}=require("./access-controls");
const {appleSubscriptionSummary}=require("./apple-billing");
const {randomUUID}=require("node:crypto");
const {cleanText,defaultPlan,sanitizePlan,planStats}=require("./plans");

/**
 * Typed dependency-injection boundary for privileged account operations.
 * @param {import("./domain-types").AdminServiceDependencies} dependencies
 * @returns {import("./domain-types").AdminService}
 */
function createAdminService({
  store,
  adminEmail,
  auth,
  emailConfig,
  paymentConfig,
  enforcePaddleIps=false,
  trustedAuthOrigin,
  rateAllowed,
  http,
  reconcileCheckoutCreationBeforeDeletion,
  reconcileUnsettledPurchases,
  serviceStatus=()=>({appStore:false,signInProviders:[]}),
  environment=process.env
}){
  if(!store||!auth||typeof auth.accountEmailHash!=="function"||!emailConfig||!paymentConfig||typeof trustedAuthOrigin!=="function"||typeof rateAllowed!=="function"||!http||typeof reconcileCheckoutCreationBeforeDeletion!=="function"||typeof reconcileUnsettledPurchases!=="function"){
    throw new TypeError("Admin service requires store, auth, service configuration, request guards, and HTTP helpers.");
  }
  const {json,bodyJson}=http;

  function adminPrincipalMatches(principal){
    return Boolean(
      adminEmail&&principal&&
      auth.normalizeEmail(principal.configured_email)===adminEmail&&
      auth.normalizeEmail(principal.email)===adminEmail&&
      Number(principal.email_verified_at)&&
      !principal.suspended_at
    );
  }

  async function adminIdentity(session,{allowBootstrap=false}={}){
    if(!adminEmail||!session||!Number(session.email_verified_at)||session.suspended_at)return {active:false,boundNow:false,principal:null};
    let principal=await store.adminPrincipal(),boundNow=false;
    if(!principal&&allowBootstrap&&auth.normalizeEmail(session.email)===adminEmail){
      const claimed=await store.claimAdminPrincipal(session.id,adminEmail,Date.now());
      principal=claimed.principal;
      boundNow=claimed.boundNow;
    }
    return {active:adminPrincipalMatches(principal)&&principal.user_id===session.id,boundNow,principal};
  }

  async function maybeClaimAdminForLogin(user){
    if(!adminEmail||!user||auth.normalizeEmail(user.email)!==adminEmail||!Number(user.email_verified_at)||user.suspended_at)return user;
    const {boundNow}=await store.claimAdminPrincipal(user.id,adminEmail,Date.now());
    // Keep the verified credential snapshot; only our own first claim may advance it.
    // Session insertion rejects any additional reset or revocation via its version check.
    return boundNow?{...user,auth_version:Number(user.auth_version)+1}:user;
  }

  async function requireAdmin(req,res,{allowBootstrap=false}={}){
    const session=await auth.requireSession(req,res);
    if(!session)return null;
    const identity=await adminIdentity(session,{allowBootstrap});
    if(identity.boundNow){
      json(res,409,{error:"Admin ownership is secured. Sign in again to continue.",code:"ADMIN_RELOGIN_REQUIRED"},{"Set-Cookie":auth.sessionCookie("",0)});
      return null;
    }
    if(!identity.active){json(res,403,{error:"Administrator access required.",code:"ADMIN_REQUIRED"});return null;}
    return session;
  }

  function requireAdminMutation(req,res,session){
    if(!trustedAuthOrigin(req)){json(res,403,{error:"Admin security check failed. Refresh and try again.",code:"ADMIN_ORIGIN_REQUIRED"});return false;}
    if(!auth.validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return false;}
    if(!String(req.headers["content-type"]||"").toLowerCase().startsWith("application/json")){
      json(res,415,{error:"Admin requests must use JSON.",code:"JSON_REQUIRED"});return false;
    }
    return true;
  }

  function sensitiveAdminText(value){
    const text=String(value||"");
    return /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(text)
      || /\b(?:password|passcode|secret|token|api[\s_-]*key)\s*[:=]\s*\S{6,}/i.test(text)
      || /\b(?:verification|security|recovery)\s+code\s*[:=]?\s*\d{6}\b/i.test(text)
      || /\b(?:re_|pdl_(?:live|sdbx|ntfset)_|live_)[A-Za-z0-9_-]{12,}/i.test(text)
      || /(?:[#?&](?:token|code)=)[A-Za-z0-9_-]{6,}/i.test(text);
  }
  const ADMIN_ACTION_REASONS=Object.freeze({
    "send-password-reset":"Owner initiated a password-reset email from Admin.",
    "send-delete-link":"Owner initiated an account-deletion email from Admin.",
    "cancel-deletion":"Owner canceled a pending account deletion from Admin.",
    "revoke-sessions":"Owner revoked account sessions from Admin.",
    suspend:"Owner paused an account from Admin.",
    restore:"Owner restored an account from Admin.",
    "delete-account":"Owner permanently deleted an account from Admin.",
    "grant-plus":"Owner granted complimentary Strata+ access from Admin.",
    "revoke-plus":"Owner revoked complimentary Strata+ access from Admin.",
    "close-checkouts":"Owner blocked new checkout sessions from Admin.",
    "enable-checkouts":"Owner enabled new checkout sessions from Admin."
  });
  function adminActionReason(action){return ADMIN_ACTION_REASONS[action]||"Owner initiated an account action from Admin.";}
  function cleanAdminTarget(value){const id=cleanText(value,100);return /^[A-Za-z0-9_-]{8,100}$/.test(id)?id:"";}
  function adminAuditEvent(actorUserId,targetUserId,action,reason,result="success"){
    return {id:randomUUID(),actorUserId,targetUserId,action,reason,result,createdAt:Date.now()};
  }
  async function recordAdminAudit(actorUserId,targetUserId,action,reason,result="success"){
    await store.recordAdminAudit(adminAuditEvent(actorUserId,targetUserId,action,reason,result));
  }

  function numericAdminRow(row){
    const output={...row};
    for(const key of ["created_at","email_verified_at","suspended_at","active_session_count","active_purchase_count","pending_purchase_count","purchase_count","rating_count","latest_purchase_at","active_apple_count","apple_expires_at","deletion_expires_at","updated_at","last_response_at","bound_at"]){
      if(output[key]!=null)output[key]=Number(output[key]);
    }
    return output;
  }
  function adminUserPayload(row,{detail=false}={}){
    if(!row)return null;
    const output=numericAdminRow(row);
    const grant=adminGrantState(output);
    const result={
      controlsRevision:Number(output.controls_revision||0),checkoutBlocked:Boolean(output.checkout_blocked_at),
      id:output.id,name:output.name,email:output.email,createdAt:output.created_at,verifiedAt:output.email_verified_at??null,suspendedAt:output.suspended_at??null,
      activeSessions:Number(output.active_session_count||0),
      discovery:{active:!output.suspended_at&&(Number(output.active_purchase_count||0)>0||Number(output.active_apple_count||0)>0||grant.active),adminGrant:grant,activePurchaseCount:Number(output.active_purchase_count||0),pendingPurchaseCount:Number(output.pending_purchase_count||0),purchaseCount:Number(output.purchase_count||0),latestPurchaseAt:output.latest_purchase_at??null,transactionId:output.transaction_id||null,transactionStatus:output.transaction_status||null,
        apple:{activeCount:Number(output.active_apple_count||0),expiresAt:output.apple_expires_at??null}},
      accountDeletion:{pending:Boolean(output.deletion_expires_at),expiresAt:output.deletion_expires_at??null}
    };
    if(detail){
      let plan=defaultPlan();
      try{if(output.plan_json)plan=sanitizePlan(JSON.parse(output.plan_json),{repair:true});}catch{/* Return safe default plan stats. */}
      Object.assign(result,planStats(plan),{ratingCount:Number(output.rating_count||0)});
    }
    return result;
  }
  function adminOverviewPayload(row){
    const value=(key)=>Number(row?.[key]||0);
    return {
      accounts:{total:value("total_users"),verified:value("verified_users"),suspended:value("suspended_users"),activeSessions:value("active_sessions")},
      discovery:{activeUsers:value("discovery_users"),pendingPayments:value("pending_payments")},
      activation:{firstWorkoutAccounts:value("first_workout_users"),secondWorkoutAccounts:value("second_workout_users"),dayEightReturnAccounts:value("day_eight_return_users"),paidAccounts:value("paid_users"),renewedSubscriptions:value("renewed_subscriptions")},
      support:{open:value("open_support"),pendingDeletions:value("pending_deletions")},
      // Setup flags live here, behind the owner's session, instead of in the public /api/status.
      services:{storage:store.kind,persistent:store.kind==="turso"||environment.NODE_ENV!=="production",email:emailConfig.enabled,emailConfigured:Boolean(emailConfig.configured),checkout:paymentConfig.enabled,paymentsConfigured:Boolean(paymentConfig.configured),webhookProtection:enforcePaddleIps,adminConfigured:Boolean(adminEmail),...serviceStatus()}
    };
  }

  const {performAdminUserAction}=createAdminUserActions({store,auth,adminActionReason,adminAuditEvent,recordAdminAudit,adminUserPayload,reconcileCheckoutCreationBeforeDeletion,reconcileUnsettledPurchases});

  async function handleApi(req,res,url){
    if(!url.pathname.startsWith("/api/admin/")||url.pathname.startsWith("/api/admin/support"))return false;
    if(url.pathname==="/api/admin/session"&&req.method==="GET"){
      const session=await requireAdmin(req,res,{allowBootstrap:true});if(!session)return true;
      json(res,200,{admin:true,elevated:true,elevatedUntil:null});return true;
    }
    if(url.pathname==="/api/admin/overview"&&req.method==="GET"){
      const session=await requireAdmin(req,res);if(!session)return true;
      json(res,200,{overview:adminOverviewPayload(await store.adminOverview(Date.now()))});return true;
    }
    if(url.pathname==="/api/admin/users"&&req.method==="GET"){
      const session=await requireAdmin(req,res);if(!session)return true;
      const query=cleanText(url.searchParams.get("q"),100),limit=Math.max(1,Math.min(50,Math.floor(Number(url.searchParams.get("limit"))||20))),offset=Math.max(0,Math.min(10000,Math.floor(Number(url.searchParams.get("offset"))||0)));
      const result=await store.adminUsers(query,limit,offset,Date.now());
      json(res,200,{users:result.users.map((user)=>adminUserPayload(user)),total:result.total,limit,offset});return true;
    }
    const userDetailMatch=url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if(userDetailMatch&&req.method==="GET"){
      const session=await requireAdmin(req,res);if(!session)return true;
      const targetId=cleanAdminTarget(userDetailMatch[1]),user=targetId?await store.adminUserById(targetId,Date.now()):null;
      if(!user)json(res,404,{error:"Account not found.",code:"ADMIN_TARGET_NOT_FOUND"});
      else{
        // The detail view also carries the member's Apple subscription state beside the Paddle purchase state.
        const payload=adminUserPayload(user,{detail:true});
        payload.discovery.apple={...payload.discovery.apple,subscription:appleSubscriptionSummary(await store.appleSubscriptionsForUser(user.id),Date.now())};
        json(res,200,{user:payload});
      }
      return true;
    }
    const actionMatch=url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/actions$/);
    if(actionMatch&&req.method==="POST"){
      const session=await requireAdmin(req,res);if(!session)return true;
      if(!requireAdminMutation(req,res,session))return true;
      if(!await rateAllowed(req,`admin-user-action:${session.id}`,30,15*60*1000)){json(res,429,{error:"Too many admin actions. Wait and try again.",code:"ADMIN_RATE_LIMIT"});return true;}
      const targetId=cleanAdminTarget(actionMatch[1]);
      if(!targetId){json(res,404,{error:"Account not found.",code:"ADMIN_TARGET_NOT_FOUND"});return true;}
      try{json(res,200,await performAdminUserAction(session,targetId,await bodyJson(req)));}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"ADMIN_ACTION_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/admin/audit"&&req.method==="GET"){
      const session=await requireAdmin(req,res);if(!session)return true;
      const limit=Math.max(1,Math.min(100,Math.floor(Number(url.searchParams.get("limit"))||40)));
      const events=(await store.adminAudit(limit)).map((event)=>({id:event.id,action:event.action,reason:event.reason,result:event.result,createdAt:Number(event.created_at),actor:{id:event.actor_id,name:event.actor_name,email:event.actor_email},target:event.target_id||event.target_user_id?{id:event.target_id||event.target_user_id,name:event.target_name||null,email:event.target_email||null}:null}));
      json(res,200,{events,limit});return true;
    }
    return false;
  }

  async function bootstrap(){
    if(!adminEmail)return;
    const configuredUser=await store.userByEmail(adminEmail);
    if(configuredUser&&Number(configuredUser.email_verified_at)&&!configuredUser.suspended_at){
      await store.claimAdminPrincipal(configuredUser.id,adminEmail,Date.now());
    }
  }

  return Object.freeze({
    handleApi,bootstrap,adminIdentity,maybeClaimAdminForLogin,requireAdmin,requireAdminMutation,
    sensitiveAdminText,cleanAdminTarget,adminAuditEvent,recordAdminAudit,adminUserPayload
  });
}

module.exports={createAdminService};
