/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAccountLogic=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const WEEKDAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const KNOWN_AUTH_ERRORS=new Set([
    "Cross-origin request rejected.","Too many attempts. Try again later.",
    "Use a valid name, email, and password of 10–128 characters.",
    "An account with that email already exists.","Email or password is incorrect.",
    "This account is temporarily paused. Contact STRATA support for help.",
    "Admin ownership is secured. Sign in again to continue.","Administrator access required.",
    "Unable to complete the account request.","Account storage is temporarily unavailable. Please try again.",
    "Email verification is temporarily unavailable. Please try again later."
  ]);

  function safeNext(raw,exerciseId){
    const addIsSafe=Boolean(exerciseId&&/^[a-z0-9-]{2,80}$/.test(exerciseId));
    if(raw==="planner"||raw==="/planner.html")return addIsSafe?`/planner.html?add=${encodeURIComponent(exerciseId)}`:"/planner.html";
    if(/^\/planner\.html\?add=[a-z0-9-]{2,80}$/.test(raw||""))return raw;
    if(raw==="pricing"||raw==="/pricing"||raw==="/pricing.html")return "/pricing";
    if(raw==="discover"||raw==="/discover.html")return "/discover.html";
    if(raw==="admin"||raw==="/admin"||raw==="/admin.html")return "/admin";
    if(/^\/workout\.html\?day=(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(raw||""))return raw;
    if(raw==="workout"||raw==="/workout.html")return "/workout.html";
    if(raw==="onboarding"||raw==="/onboarding.html")return "/onboarding.html";
    if(raw==="ai"||raw==="/ai"||raw==="/ai.html")return "/ai";
    return "/planner.html";
  }

  function verificationLocation(destination,{deliveryState="",purpose="signup"}={}){
    const query=new URLSearchParams();
    if(destination==="/pricing")query.set("next","pricing");
    else if(destination==="/discover.html")query.set("next","discover");
    else if(destination==="/admin")query.set("next","admin");
    else if(destination.startsWith("/workout.html"))query.set("next",destination==="/workout.html"?"workout":destination);
    else if(destination==="/onboarding.html")query.set("next","onboarding");
    else if(destination==="/ai")query.set("next","ai");
    else{
      query.set("next","planner");
      const add=new URL(destination,"https://strata.local").searchParams.get("add");
      if(add&&/^[a-z0-9-]{2,80}$/.test(add))query.set("add",add);
    }
    query.set("purpose",purpose==="login"?"login":"signup");
    if(deliveryState==="failed")query.set("delivery","failed");
    return `/verify-email.html?${query}`;
  }

  function safeQueryError(value){
    if(!value)return "";
    return KNOWN_AUTH_ERRORS.has(value)?value:"Unable to complete the account request. Please try again.";
  }

  function friendlyAuthError(error,authMode){
    if(KNOWN_AUTH_ERRORS.has(error?.message))return error.message;
    const code=String(error?.code||"").toUpperCase();
    if(code==="EMAIL_VERIFICATION_UNAVAILABLE")return "Email verification is temporarily unavailable. Please try again later.";
    if(code.includes("EMAIL")&&(code.includes("PROVIDER")||code.includes("DELIVERY")||code.includes("SEND")||code.includes("VERIFICATION")))return "We could not send your verification email right now. Please try again in a moment.";
    if(error?.status===404)return "The account service is unavailable. Deploy STRATA as a Node Web Service and try again.";
    if(error?.code==="invalid-response")return "The account service is unavailable on this deployment. Please try again after the server is connected.";
    if(error?.code==="network")return "Could not reach the account service. Check your connection and try again.";
    if(Number(error?.status)>=500)return "Account storage is temporarily unavailable. Please try again.";
    return authMode==="signup"?"Could not create the account. Check the details and try again.":"Could not sign in. Check the details and try again.";
  }

  function escapeHtml(value){
    return String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);
  }

  function localDateKey(date){
    const year=date.getFullYear(),month=String(date.getMonth()+1).padStart(2,"0"),day=String(date.getDate()).padStart(2,"0");
    return `${year}-${month}-${day}`;
  }

  function localNoon(date,offset=0){return new Date(date.getFullYear(),date.getMonth(),date.getDate()+offset,12);}

  function weekContext(now=new Date()){
    const today=localNoon(now),todayIndex=(today.getDay()+6)%7,monday=localNoon(today,-todayIndex);
    const dates=WEEKDAYS.map((day,index)=>({day,date:localNoon(monday,index)}));
    return{today,todayIndex,monday,dates,dateKeys:new Set(dates.map(({date})=>localDateKey(date)))};
  }

  function readableDate(value){
    if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return "Saved session";
    const date=new Date(`${value}T12:00:00`);
    return Number.isNaN(date.getTime())?"Saved session":new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(date);
  }

  function validPlan(value){
    if(!value||typeof value!=="object"||!value.days||typeof value.days!=="object")return null;
    return WEEKDAYS.every((day)=>Array.isArray(value.days[day]))?value:null;
  }

  function planSummary(plan){
    const scheduled=WEEKDAYS.filter((day)=>plan.days[day].length>0);
    return{scheduled,movements:scheduled.reduce((total,day)=>total+plan.days[day].length,0)};
  }

  function completedThisWeek(workouts,week){return workouts.filter((workout)=>workout?.status==="completed"&&week.dateKeys.has(String(workout.date||"")));}

  function nextPlannedDay(plan,completedDays,week){
    for(let offset=0;offset<14;offset+=1){
      const index=(week.todayIndex+offset)%WEEKDAYS.length,day=WEEKDAYS[index],items=plan.days[day];
      if(items.length&&(offset>=7||!completedDays.has(day)))return{day,items,offset,date:localNoon(week.today,offset)};
    }
    return null;
  }

  function subscriptionFor(user){
    const subscription=user?.discovery?.subscription;
    return subscription&&typeof subscription==="object"&&subscription.id?subscription:null;
  }

  function grandfatheredAccess(user){
    const discovery=user?.discovery||{},accessType=String(discovery.accessType||"");
    return discovery.active===true&&!subscriptionFor(user)&&accessType==="paid";
  }

  function billingDate(value){
    const timestamp=Number(value),date=new Date(timestamp);
    return Number.isFinite(timestamp)&&timestamp>0&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat(undefined,{dateStyle:"medium"}).format(date):"the date Paddle shows";
  }

  function accountAccessSummary(user,pending=false){
    const discovery=user?.discovery||{},subscription=subscriptionFor(user),status=String(subscription?.status||"");
    if(discovery.adminGrant?.active===true){
      const grant=discovery.adminGrant;
      const coexistence=subscription?"Your existing monthly subscription remains separate and is not canceled by this grant; review its billing state below.":grandfatheredAccess(user)?"Your grandfathered lifetime access remains separate and does not renew.":"It did not create a paid subscription.";
      return{state:"Complimentary",detail:grant.expiresAt==null?"Until revoked":`Until ${billingDate(grant.expiresAt)}`,message:`An administrator granted you free Strata+ access. This grant never renews or charges you. ${coexistence}`};
    }
    if(subscription){
      if(status==="paused")return{state:"Paused",detail:"Paid access inactive",message:"Your monthly subscription is paused and Strata+ paid access is inactive. Manage it in Paddle to review the available next steps."};
      if(status==="canceled")return{state:"Canceled",detail:"No future renewals",message:"Your monthly subscription is canceled and will not renew. Your free Rankings and weekly Plan remain available."};
      if(subscription.active!==true)return{state:"Inactive",detail:"Paid access inactive",message:"The last verified billing period or scheduled access window has ended. Open Paddle to review the subscription state."};
      if(subscription.scheduledChange?.action==="cancel")return{state:"Canceling",detail:`Access through ${billingDate(subscription.scheduledChange.effectiveAt)}`,message:`Your monthly subscription is scheduled to cancel on ${billingDate(subscription.scheduledChange.effectiveAt)}. Access remains active until then and will not renew afterward.`};
      if(subscription.scheduledChange?.action==="pause")return{state:"Pausing",detail:`Access through ${billingDate(subscription.scheduledChange.effectiveAt)}`,message:`Your monthly subscription is scheduled to pause on ${billingDate(subscription.scheduledChange.effectiveAt)}. Access remains active until then and stops when the pause takes effect.`};
      if(subscription.pastDue===true||status==="past_due")return{state:"Past due",detail:"Update payment method",message:"Your monthly payment is past due. Strata+ remains available for now; update payment in Paddle to avoid interruption."};
      if(subscription.active===true)return{state:"Active",detail:`Monthly · renews ${billingDate(subscription.currentPeriodEndsAt)}`,message:`Your monthly subscription is active and renews on ${billingDate(subscription.currentPeriodEndsAt)} unless canceled.`};
      return{state:"Inactive",detail:"Review billing status",message:"Your monthly subscription is not providing paid access. Open Paddle to review its current state."};
    }
    if(grandfatheredAccess(user))return{state:"Lifetime",detail:"Grandfathered · no renewal",message:"Your prior lifetime Strata+ purchase is grandfathered. It stays active without a monthly subscription or recurring charge."};
    if(pending)return{state:"Pending",detail:"Checkout needs attention",message:"A Strata+ subscription checkout is pending. Open Pricing to finish checkout or check confirmation."};
    return{state:"Free",detail:"Rankings and Plan included",message:"The exercise index and weekly planner are free. Strata+ is available as a $2.99 USD monthly subscription."};
  }

  function accountBoundaryChanged(error){return error?.status===401||error?.status===403||error?.code==="account-changed";}

  function sessionDate(value){
    const date=new Date(Number(value));
    return Number.isFinite(Number(value))&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(date):"Unknown time";
  }

  function securityError(error){
    if(error?.code==="network")return "Could not reach STRATA. Check your connection and try again.";
    if(error?.status===409)return error.message||"Finish the pending checkout before deleting this account.";
    if(error?.status===429)return "Too many account emails were requested. Please wait and try again.";
    if(error?.status===401)return "Your session expired. Sign in again before changing account security.";
    if(error?.status===403)return "The security check expired. Refresh this page and try again.";
    return Number(error?.status)>=500?"Account email is temporarily unavailable. Please try again in a moment.":error?.message||"The account request could not be completed.";
  }

  function selfServiceError(error,action){
    if(error?.code==="network")return "Could not reach STRATA. Check your connection and try again.";
    if(error?.status===401)return "Your session expired. Sign in again before continuing.";
    if(error?.status===403)return "The security check expired. Refresh this page and try again.";
    if(error?.status===429)return `Too many ${action} requests were made. Wait a moment and try again.`;
    return error?.message||`The ${action} request could not be completed.`;
  }

  function safePortalUrl(value){
    try{
      const url=new URL(String(value||""));
      return url.protocol==="https:"&&url.hostname==="customer-portal.paddle.com"&&url.pathname.startsWith("/cpl_")&&!url.username&&!url.password?url.href:"";
    }catch{return "";}
  }

  function billingError(error){
    if(error?.code==="network")return "Could not reach STRATA. Check your connection and try again.";
    if(error?.code==="SUBSCRIPTION_NOT_FOUND"||error?.status===404)return "No monthly subscription was found for this account. Refresh to check the latest billing state.";
    if(error?.status===429)return "Too many billing requests were made. Wait a moment and try again.";
    if(error?.status===401)return "Your session expired. Sign in again before managing billing.";
    if(error?.status===403)return "The security check expired. Refresh this page before managing billing.";
    return error?.message||"Subscription management is temporarily unavailable. Please try again.";
  }

  return{
    WEEKDAYS,KNOWN_AUTH_ERRORS,safeNext,verificationLocation,safeQueryError,friendlyAuthError,escapeHtml,localDateKey,localNoon,weekContext,
    readableDate,validPlan,planSummary,completedThisWeek,nextPlannedDay,
    subscriptionFor,grandfatheredAccess,billingDate,accountAccessSummary,accountBoundaryChanged,sessionDate,securityError,selfServiceError,safePortalUrl,billingError
  };
});
