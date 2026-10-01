"use strict";
const {cleanText}=require("./plans");
const {adminGrantState,grantExpiry}=require("./access-controls");
function createAdminUserActions({store,auth,adminActionReason,adminAuditEvent,recordAdminAudit,adminUserPayload,reconcileCheckoutCreationBeforeDeletion,reconcileUnsettledPurchases}){
  const changed=()=>Object.assign(new Error("Account controls changed. Refresh the account and try again."),{status:409,code:"ADMIN_STATE_CHANGED"});
  async function performControlAction(session,target,input,action,reason){
    const existing=await store.adminControls(target.id),revision=input.expectedControlsRevision;
    if(!Number.isSafeInteger(revision)||revision<0||revision!==Number(existing?.revision||0))throw changed();
    const stamp=Date.now(),row={...existing};
    if(action==="grant-plus"){row.grant_starts_at=stamp;row.grant_expires_at=grantExpiry(input.grant,stamp);row.grant_revoked_at=null;}
    if(action==="revoke-plus"){if(!adminGrantState(existing,stamp).active)throw Object.assign(new Error("There is no active complimentary grant to revoke."),{status:409,code:"NO_ACTIVE_GRANT"});row.grant_revoked_at=stamp;}
    if(action==="close-checkouts")row.checkout_blocked_at=stamp;
    if(action==="enable-checkouts")row.checkout_blocked_at=null;
    const audit=adminAuditEvent(session.id,target.id,action,reason,action==="close-checkouts"?"requested":"success");
    const saved=await store.writeAdminControls(target.id,row,revision,session.token_hash,audit);
    if(!saved)throw changed();
    let message=action==="grant-plus"?`Complimentary Strata+ granted ${saved.grant_expires_at===null?"until revoked":`until ${new Date(saved.grant_expires_at).toISOString()}`}. Existing paid subscriptions are unchanged.`:action==="revoke-plus"?"Complimentary access revoked. Any separate paid access remains available.":"New payment sessions enabled. Canceled checkouts stay canceled.";
    if(action==="close-checkouts"){
      try{
        const originalClaim=await store.checkoutCreationForUser(target.id);
        const transactionIds=(await store.unsettledPurchasesForUser(target.id)).filter(p=>Number(p.created_at)<=stamp).map(p=>p.transaction_id);
        if(originalClaim&&Number(originalClaim.created_at)<=stamp)await reconcileCheckoutCreationBeforeDeletion(target.id,originalClaim.claim_id);
        await reconcileUnsettledPurchases(target.id,{includeFresh:true,checkSubscription:false,transactionIds});
        const unfinished=await store.unsettledPurchasesForUser(target.id),claim=await store.checkoutCreationForUser(target.id);
        const remaining=unfinished.length+(claim&&!unfinished.some(p=>p.transaction_id===claim.transaction_id)?1:0);
        const deletionBlocked=await store.pendingPurchasesForUser(target.id)>0;
        await recordAdminAudit(session.id,target.id,action,reason,remaining||deletionBlocked?"partial":"success");
        const held=(await store.adminControls(target.id))?.checkout_blocked_at!=null;
        const result=remaining?`${remaining} unfinished payment record(s) remain; Paddle may not allow their current state to be canceled. Retry closure after their state changes.`:deletionBlocked?"No unfinished checkout records remain, but a completed purchase or subscription still blocks account deletion.":"No unfinished checkout records remain. Account deletion will still run a fresh billing safety check.";
        message=`${held?"New payment sessions are blocked.":"Payment sessions were re-enabled by another admin action."} ${result} Existing subscriptions and charges are unchanged.`;
      }catch(error){
        await recordAdminAudit(session.id,target.id,action,reason,"failed");
        const held=(await store.adminControls(target.id))?.checkout_blocked_at!=null;
        throw Object.assign(new Error(`${held?"New payment sessions are blocked.":"Payment sessions have been re-enabled."} Closure could not be confirmed. Some checkouts may already be closed. Refresh and retry; do not assume an in-progress payment was stopped.`),{status:error.status||503,code:"CHECKOUT_CLOSE_INCOMPLETE"});
      }
    }
    return{ok:true,message,user:adminUserPayload(await store.adminUserById(target.id,Date.now()),{detail:true})};
  }
  async function performAdminUserAction(session,targetId,input){
    const target=await store.adminUserById(targetId,Date.now());
    if(!target)throw Object.assign(new Error("Account not found."),{status:404,code:"ADMIN_TARGET_NOT_FOUND"});
    const principal=await store.adminPrincipal(),action=cleanText(input?.action,40);
    if(principal?.user_id===target.id&&!["grant-plus","revoke-plus","close-checkouts","enable-checkouts"].includes(action))throw Object.assign(new Error("Use Account Security for the primary administrator account."),{status:409,code:"ADMIN_SELF_PROTECTED"});
    if(!["send-password-reset","send-delete-link","cancel-deletion","revoke-sessions","suspend","restore","delete-account","grant-plus","revoke-plus","close-checkouts","enable-checkouts"].includes(action))throw Object.assign(new Error("Unknown admin action."),{status:400,code:"UNKNOWN_ADMIN_ACTION"});
    const reason=adminActionReason(action);
    if(["grant-plus","revoke-plus","close-checkouts","enable-checkouts"].includes(action))return performControlAction(session,target,input,action,reason);
    if(action==="send-password-reset"||action==="send-delete-link"){
      const purpose=action==="send-password-reset"?"password_reset":"account_delete";
      await recordAdminAudit(session.id,target.id,action,reason,"requested");
      const delivery=await auth.requestSignedInAccountAction(target,purpose);
      const label=purpose==="password_reset"?"Password-reset":"Deletion-confirmation";
      return {ok:true,message:`${label} email sent to ${delivery.maskedEmail}.`,user:adminUserPayload(await store.adminUserById(target.id,Date.now()),{detail:true})};
    }
    let message="Action completed.";
    if(action==="cancel-deletion"){
      const canceled=await store.cancelAccountDeletionWithAudit(target.id,adminAuditEvent(session.id,target.id,action,reason));
      if(!canceled)throw Object.assign(new Error("This account has no pending deletion request."),{status:409,code:"NO_PENDING_DELETION"});
      message="Pending account deletion canceled.";
    }else if(action==="revoke-sessions"){
      const result=await store.revokeUserSessions(target.id,adminAuditEvent(session.id,target.id,action,reason));
      if(!result)throw Object.assign(new Error("Account not found."),{status:404,code:"ADMIN_TARGET_NOT_FOUND"});
      message=`Signed the account out on ${result.revoked} active ${result.revoked===1?"session":"sessions"}.`;
    }else if(action==="suspend"){
      if(target.suspended_at)throw Object.assign(new Error("This account is already paused."),{status:409,code:"ACCOUNT_ALREADY_SUSPENDED"});
      if(!await store.suspendUser(target.id,Date.now(),adminAuditEvent(session.id,target.id,action,reason)))throw Object.assign(new Error("The account state changed. Refresh and try again."),{status:409,code:"ADMIN_STATE_CHANGED"});
      message="Account paused and all sessions revoked.";
    }else if(action==="restore"){
      if(!target.suspended_at)throw Object.assign(new Error("This account is already active."),{status:409,code:"ACCOUNT_ALREADY_ACTIVE"});
      if(!await store.restoreUser(target.id,adminAuditEvent(session.id,target.id,action,reason)))throw Object.assign(new Error("The account state changed. Refresh and try again."),{status:409,code:"ADMIN_STATE_CHANGED"});
      message="Account restored. The user can sign in again.";
    }else if(action==="delete-account"){
      if(!target.suspended_at&&!await store.suspendUser(target.id,Date.now(),adminAuditEvent(session.id,target.id,"delete-account-pause",reason)))throw Object.assign(new Error("The account changed. Refresh and try again."),{status:409,code:"ADMIN_STATE_CHANGED"});
      if(await reconcileCheckoutCreationBeforeDeletion(target.id)>0)throw Object.assign(new Error("A Strata+ checkout is still being prepared. Nothing was deleted; try again later."),{status:409,code:"CHECKOUT_PREPARING"});
      try{if(await reconcileUnsettledPurchases(target.id,{includeFresh:true})>0)throw Object.assign(new Error("A Strata+ payment is still being processed. Nothing was deleted; try again later."),{status:409,code:"PURCHASE_PENDING"});}
      catch(error){if(error.code==="SUBSCRIPTION_ACTIVE")throw Object.assign(new Error("This account is paused but still has a live Paddle subscription. Nothing was deleted. Cancel the subscription in Paddle before retrying deletion, or restore the account."),{status:409,code:error.code});throw error;}
      const audit=adminAuditEvent(session.id,target.id,action,reason);
      const deletedAt=Date.now();
      const deleted=await store.deleteUserByAdmin(target.id,deletedAt,target.email,auth.accountEmailHash(target.email),session.token_hash,audit);
      if(!deleted)throw Object.assign(new Error("The account or billing state changed. Nothing was deleted; refresh and try again."),{status:409,code:"ADMIN_STATE_CHANGED"});
      return {ok:true,message:"Account permanently deleted from STRATA. No refund or live Paddle subscription was canceled; incomplete checkouts may have been closed during the safety check."};
    }
    return {ok:true,message,user:adminUserPayload(await store.adminUserById(target.id,Date.now()),{detail:true})};
  }

  return {performAdminUserAction};
}
module.exports={createAdminUserActions};
