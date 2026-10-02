/* global module, require */
(function(root,factory){
  const entitlements=typeof module==="object"&&module.exports?require("./entitlements"):root.StrataEntitlements;
  const api=factory(entitlements);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAccountLogic=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(entitlements){
  "use strict";

  function hasPlus(user){return entitlements.can(user,"plus.studio");}

  const WEEKDAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const KNOWN_AUTH_ERRORS=new Set([
    "Cross-origin request rejected.","Too many attempts. Try again later.",
    "Use a valid name, email, and password of 10–128 characters.",
    "An account with that email already exists.","Email or password is incorrect.",
    "This account is temporarily paused. Contact STRATA support for help.",
    "Admin ownership is secured. Sign in again to continue.","Administrator access required.",
    "Unable to complete the account request.","Account storage is temporarily unavailable. Please try again.",
    "Email verification is temporarily unavailable. Please try again later.",
    // Google or Apple sign-in (src/social-auth-messages.js).
    "Sign-in was canceled. Choose an option to try again.","That sign-in expired or was started in another browser. Please try again.",
    "That sign-in option is not available right now. Use your email and password or try again later.","The sign-in could not be completed. Please try again.",
    "Your Google or Apple account did not share a verified email address. Create an account with your email instead.",
    "An account with that email already exists. Sign in with your password to continue.","This STRATA account is already linked to a different account from that provider."
  ]);
  const SIGN_IN_PROVIDERS={apple:"Apple",google:"Google"};

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

  // The App Store subscription STRATA verified for this account (bought in the iOS app), or null.
  function appleSubscriptionFor(user){
    const apple=user?.discovery?.apple;
    return apple&&typeof apple==="object"?apple:null;
  }

  // Inside the iOS app, Paddle billing is read-only: it is named as billed on the website, never linked or managed.
  const APPLE_SETTINGS="Settings › Apple Account › Subscriptions",APPLE_MANAGE_URL="https://apps.apple.com/account/subscriptions";
  // Apple's subscription page from a server notice, or Apple's standard one; never another site or scheme.
  function safeAppleManageUrl(value){
    try{const url=new URL(String(value||""));return url.protocol==="https:"&&url.hostname==="apps.apple.com"&&!url.username&&!url.password?url.href:APPLE_MANAGE_URL;}
    catch{return APPLE_MANAGE_URL;}
  }
  // The account-deletion notice the server sends while an App Store subscription is live or set to renew.
  function appleDeletionNotice(result){
    const notice=result?.appleBilling,message=typeof notice?.message==="string"?notice.message.trim():"";
    return message?{message,manageUrl:safeAppleManageUrl(notice.manageUrl)}:null;
  }
  function appleAccessSummary(apple,app){
    const date=billingDate(apple.expiresAt),known=Number(apple.expiresAt)>0;
    if(apple.active!==true)return apple.revoked===true
      ?{state:"Inactive",detail:"Refunded or revoked",message:"Your App Store subscription was refunded or revoked, so Strata+ is off. Your free Rankings and weekly Plan remain available."}
      :{state:"Ended",detail:"App Store · no renewal",message:"Your App Store subscription has ended. Your free Rankings and weekly Plan remain available."};
    if(apple.inGracePeriod===true)return{state:"Billing issue",detail:"Update payment in Settings",message:`The App Store could not collect the latest payment. Update your Apple Account’s payment method in ${APPLE_SETTINGS} to keep Strata+.`};
    if(apple.autoRenew===false&&known)return{state:"Canceling",detail:`Access through ${date}`,message:`Your App Store subscription is cancelled and ends on ${date}. Strata+ stays active until then.`};
    return{state:"Active",detail:known?`App Store · renews ${date}`:"App Store subscription",message:`Your Strata+ subscription is billed to your Apple Account${known?` and renews on ${date}`:""}. Manage or cancel it in ${APPLE_SETTINGS}${app?"":" on your iPhone"}.`};
  }

  function accountAccessSummary(user,pending=false,{app=false}={}){
    const discovery=user?.discovery||{},subscription=subscriptionFor(user),status=String(subscription?.status||""),apple=appleSubscriptionFor(user);
    if(discovery.adminGrant?.active===true){
      const grant=discovery.adminGrant;
      const coexistence=subscription?"Your existing monthly subscription remains separate and is not canceled by this grant; review its billing state below.":apple?.active===true?`Your App Store subscription remains separate and is not cancelled by this grant; manage it in ${APPLE_SETTINGS}.`:grandfatheredAccess(user)?"Your grandfathered lifetime access remains separate and does not renew.":"It did not create a paid subscription.";
      return{state:"Complimentary",detail:grant.expiresAt==null?"Until revoked":`Until ${billingDate(grant.expiresAt)}`,message:`An administrator granted you free Strata+ access. This grant never renews or charges you. ${coexistence}`};
    }
    if(apple?.active===true&&subscription?.active!==true)return appleAccessSummary(apple,app);
    if(subscription){
      const web="It is billed on stratafitness.online.";
      if(status==="paused")return{state:"Paused",detail:"Paid access inactive",message:`Your monthly subscription is paused and Strata+ paid access is inactive. ${app?web:"Manage it in Paddle to review the available next steps."}`};
      if(status==="canceled")return{state:"Canceled",detail:"No future renewals",message:"Your monthly subscription is canceled and will not renew. Your free Rankings and weekly Plan remain available."};
      if(subscription.active!==true)return{state:"Inactive",detail:"Paid access inactive",message:`The last verified billing period or scheduled access window has ended. ${app?web:"Open Paddle to review the subscription state."}`};
      if(subscription.scheduledChange?.action==="cancel")return{state:"Canceling",detail:`Access through ${billingDate(subscription.scheduledChange.effectiveAt)}`,message:`Your monthly subscription is scheduled to cancel on ${billingDate(subscription.scheduledChange.effectiveAt)}. Access remains active until then and will not renew afterward.`};
      if(subscription.scheduledChange?.action==="pause")return{state:"Pausing",detail:`Access through ${billingDate(subscription.scheduledChange.effectiveAt)}`,message:`Your monthly subscription is scheduled to pause on ${billingDate(subscription.scheduledChange.effectiveAt)}. Access remains active until then and stops when the pause takes effect.`};
      if(subscription.pastDue===true||status==="past_due")return{state:"Past due",detail:app?"Billed on the website":"Update payment method",message:`Your monthly payment is past due. Strata+ remains available for now; ${app?"this subscription is billed on stratafitness.online.":"update payment in Paddle to avoid interruption."}`};
      if(subscription.active===true)return{state:"Active",detail:`Monthly · renews ${billingDate(subscription.currentPeriodEndsAt)}`,message:`Your monthly subscription is active and renews on ${billingDate(subscription.currentPeriodEndsAt)} unless canceled.`};
      return{state:"Inactive",detail:"Review billing status",message:`Your monthly subscription is not providing paid access. ${app?web:"Open Paddle to review its current state."}`};
    }
    if(apple)return appleAccessSummary(apple,app);
    if(grandfatheredAccess(user))return{state:"Lifetime",detail:"Grandfathered · no renewal",message:"Your prior lifetime Strata+ purchase is grandfathered. It stays active without a monthly subscription or recurring charge."};
    if(pending)return app
      ?{state:"Pending",detail:"Started on the website",message:"A Strata+ checkout started on stratafitness.online is still being confirmed."}
      :{state:"Pending",detail:"Checkout needs attention",message:"A Strata+ subscription checkout is pending. Open Pricing to finish checkout or check confirmation."};
    // The app shows the App Store's price for the viewer's storefront on the paywall, never a fixed USD amount.
    return{state:"Free",detail:"Rankings and Plan included",message:app?"The exercise index and weekly planner are free. Strata+ is available as a monthly subscription.":"The exercise index and weekly planner are free. Strata+ is available as a $2.99 USD monthly subscription."};
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

  // In-app deletion: whether Apple may still bill this member (the server's own notice follows the same rule), and the
  // inline message for a refused attempt. Every refusal means nothing was deleted.
  function appleMayBill(user){
    const discovery=user?.discovery||{},apple=appleSubscriptionFor(user);
    return discovery.accessType==="apple"||apple?.active===true||apple?.autoRenew===true;
  }
  /** How this account signs in, e.g. "Signs in with a password and Google", or "" when it is password-only. */
  function signInMethodsText(user){
    const names=(Array.isArray(user?.signIn?.providers)?user.signIn.providers:[]).map((id)=>SIGN_IN_PROVIDERS[id]).filter(Boolean);
    if(!names.length)return "";
    return `Signs in with ${user.signIn.hasPassword===false?"":"a password and "}${names.join(" and ")}.`;
  }
  function hasPassword(user){return user?.signIn?.hasPassword!==false;}

  function deleteNowError(error){
    const code=String(error?.code||"");
    if(code==="network")return "Could not reach STRATA. Check your connection and try again. Nothing was deleted.";
    if(code==="PASSWORD_INCORRECT")return "That password is incorrect.";
    if(code==="DELETE_CONFIRMATION_REQUIRED")return "Type DELETE exactly to confirm.";
    if(code==="RECENT_SIGN_IN_REQUIRED")return "For your security, sign out and sign in again with Apple or Google, then delete your account within 15 minutes. Nothing was deleted.";
    if(error?.status===429)return "Too many deletion attempts. Wait 15 minutes and try again.";
    if(error?.status===409)return error.message||"Your account could not be deleted right now. Nothing was deleted.";
    if(error?.status===401)return "Your session expired. Sign in again before deleting your account.";
    if(error?.status===403)return "The security check expired. Close this, refresh the page, and try again.";
    if(Number(error?.status)>=500)return "STRATA is temporarily unavailable. Nothing was deleted; please try again.";
    return error?.message||"Your account could not be deleted. Please try again.";
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

  return{hasPlus,
    WEEKDAYS,KNOWN_AUTH_ERRORS,safeNext,verificationLocation,safeQueryError,friendlyAuthError,escapeHtml,localDateKey,localNoon,
    subscriptionFor,appleSubscriptionFor,APPLE_MANAGE_URL,safeAppleManageUrl,appleDeletionNotice,grandfatheredAccess,billingDate,accountAccessSummary,accountBoundaryChanged,sessionDate,securityError,appleMayBill,deleteNowError,signInMethodsText,hasPassword,selfServiceError,safePortalUrl,billingError
  };
});
