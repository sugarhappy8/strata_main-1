/* global module, require */
(function(root,factory){
  const node=typeof module==="object"&&module.exports;
  const api=factory(node?require("./planner-logic"):root.StrataPlannerLogic,node?require("./entitlements"):root.StrataEntitlements);
  if(node)module.exports=api;
  root.StrataPlannerState=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(logic,entitlements){
  "use strict";

  const SELECTED_DAY_PREFIX="strata_planner_selected_day_v1:";
  const ENTITLEMENT_RECHECK_MAX_DELAY=15*60*1000,ENTITLEMENT_RETRY_DELAYS=[15_000,60_000,5*60_000,15*60_000];

  function createState({desktopPageSize=32}={}){
    return{
      exercises:[],plan:null,user:null,query:"",group:"all",drag:null,selectedDay:"Monday",
      ready:false,guest:false,guestRaw:null,saveTimer:null,savePromise:null,lastSaveError:null,planUpdatedAt:0,revision:0,savedRevision:0,navigating:false,libraryLimit:desktopPageSize,
      accountChanged:false,undoRemoval:null,replacement:null,templatePreview:null,draftKey:"",draftValue:"",recoverySource:null,recoveredDrafts:[],draftStorageError:false,
      conflictDraft:null,conflictLatest:null,conflictReview:false,csrfToken:"",
      activationCandidates:[],activationCandidateId:"",activationBusy:false,activationDirectClaim:false,copyPreview:null,copyTrigger:null,resetWeekSnapshot:null,resetWeekTrigger:null,
      entitlementStatus:"unknown",entitlementCheckedAt:0,entitlementRequest:0,entitlementRefreshPromise:null,entitlementTimer:null,entitlementFailureCount:0
    };
  }

  function timestamp(value){const numeric=Number(value);return Number.isFinite(numeric)&&numeric>0?numeric:0;}
  function entitlementBoundary(user){
    const discovery=user?.discovery;if(discovery?.active!==true)return 0;
    if(discovery.accessType==="grant")return discovery.adminGrant?.expiresAt===null?0:timestamp(discovery.adminGrant?.expiresAt)||-1;
    // App Store access ends at its verified expiry; during Apple's billing grace period no end is known here, so rechecks decide.
    if(discovery.accessType==="apple"){const apple=discovery.apple;return apple?.active!==true||apple.revoked===true?-1:apple.inGracePeriod===true?0:timestamp(apple.expiresAt)||-1;}
    const subscription=discovery.subscription;if(!subscription||subscription.active===false)return 0;
    const periodEnd=timestamp(subscription.currentPeriodEndsAt);if(!periodEnd)return-1;
    const boundaries=[periodEnd],change=subscription.scheduledChange;
    if(["cancel","pause"].includes(String(change?.action||""))){const effectiveAt=timestamp(change?.effectiveAt);if(!effectiveAt)return-1;boundaries.push(effectiveAt);}
    return Math.min(...boundaries);
  }
  function hasConfirmedPlusAccess(state,now=Date.now()){
    if(state?.entitlementStatus!=="ready"||!entitlements.can(state.user,"plus.studio"))return false;
    const boundary=entitlementBoundary(state.user);return boundary===0||boundary>now;
  }
  function entitlementRefreshDelay(user,now=Date.now()){
    const boundary=entitlementBoundary(user);if(boundary<=0)return ENTITLEMENT_RECHECK_MAX_DELAY;
    const remaining=boundary-now;return remaining>0?Math.min(remaining+50,ENTITLEMENT_RECHECK_MAX_DELAY):30_000;
  }
  function entitlementRetryDelay(failureCount){const attempt=Math.max(1,Math.floor(Number(failureCount)||1));return ENTITLEMENT_RETRY_DELAYS[Math.min(attempt,ENTITLEMENT_RETRY_DELAYS.length)-1];}

  function selectionScope({guest,userId}){return guest?"guest":`user-${encodeURIComponent(String(userId||""))}`;}
  function selectionKey(context){return `${SELECTED_DAY_PREFIX}${selectionScope(context)}`;}
  function firstTrainingDay(plan){return logic.DAYS.find(day=>!logic.isRestDay(plan,day))||"Monday";}
  function readSelectedDay(storage,context,plan){
    let selected="";
    try{selected=String(storage.getItem(selectionKey(context))||"");}catch{/* Storage is optional. */}
    return logic.DAYS.includes(selected)&&!logic.isRestDay(plan,selected)?selected:firstTrainingDay(plan);
  }
  function writeSelectedDay(storage,context,plan,day){
    if(!logic.DAYS.includes(day)||logic.isRestDay(plan,day))return false;
    try{storage.setItem(selectionKey(context),day);return true;}catch{return false;}
  }

  return{SELECTED_DAY_PREFIX,ENTITLEMENT_RECHECK_MAX_DELAY,ENTITLEMENT_RETRY_DELAYS,createState,entitlementBoundary,hasConfirmedPlusAccess,entitlementRefreshDelay,entitlementRetryDelay,selectionScope,selectionKey,firstTrainingDay,readSelectedDay,writeSelectedDay};
});
