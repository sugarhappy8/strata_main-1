/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPricingRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createRenderer({state,nodes,logic,navigatorImpl=globalThis.navigator,locationImpl=globalThis.location,frame=globalThis.requestAnimationFrame}){
    const{panel,statusNode,signupLink,loginLink,trialButton,buyButton,openLink,manageLink,checkButton}=nodes;
    const pageReason=new URLSearchParams(locationImpl.search).get("reason");
    const trialRequested=new URLSearchParams(locationImpl.search).get("trial")==="1";
    // Members sent here from Strata AI return to it after signing up, signing in, or starting the trial.
    if(pageReason==="ai"){
      signupLink.href="/account.html?mode=signup&next=ai";loginLink.href="/account.html?mode=login&next=ai";openLink.href="/ai";
      if(openLink.firstChild?.nodeType===3)openLink.firstChild.textContent="Open Strata AI ";
    }

    function setStatus(message,tone="",{focus=false}={}){
      statusNode.setAttribute("role",tone==="error"?"alert":"status");
      statusNode.textContent=state.config?.environment==="sandbox"?`TEST MODE · ${message}`:message;
      statusNode.classList.toggle("purchase-status-good",tone==="good");
      statusNode.classList.toggle("purchase-status-warn",tone==="warn");
      statusNode.classList.toggle("purchase-status-error",tone==="error");
      if(focus)(frame||((callback)=>callback()))(()=>statusNode.focus({preventScroll:false}));
    }

    function renderPurchaseState(){
      const signedIn=Boolean(state.user?.id);
      const active=logic.discoveryIsActive(state.user);
      const trial=state.user?.discovery?.trial;
      const subscription=logic.subscriptionFor(state.user),subscriptionStatus=String(subscription?.status||"");
      const paid=logic.paidAccessType(state.user),trialAccess=active&&state.user?.discovery?.accessType==="trial";
      const grandfathered=active&&!subscription&&["lifetime","paid"].includes(String(state.user?.discovery?.accessType||""));
      const trialEligible=signedIn&&!active&&!subscription&&trial?.eligible===true;
      const online=navigatorImpl.onLine!==false;
      const checkoutReady=Boolean(state.config&&!state.configError&&state.paddleReady&&online);
      const paused=subscriptionStatus==="paused",canceled=subscriptionStatus==="canceled";
      const canSubscribe=signedIn&&(!active||trialAccess)&&!paused;
      const checkoutBlocked=state.user?.discovery?.checkoutBlocked===true;
      const checkoutAccountChanged=Boolean(state.currentCheckoutUserId)&&String(state.user?.id||"")!==state.currentCheckoutUserId;

      signupLink.hidden=signedIn;
      loginLink.hidden=signedIn;
      // An eligible member gets one obvious next step. Checkout appears after the
      // trial starts or once that one-time trial has already been used.
      buyButton.hidden=!canSubscribe||trialEligible;
      trialButton.hidden=!trialEligible;
      openLink.hidden=!signedIn||!active;
      manageLink.hidden=!signedIn||!subscription;
      checkButton.hidden=!signedIn||logic.paidAccessReady(state.user)||!state.awaitingAccess;
      buyButton.disabled=state.busy||state.awaitingAccess||state.checkoutOpen||!checkoutReady||checkoutBlocked;
      trialButton.disabled=state.busy||state.awaitingAccess||state.checkoutOpen||!online;
      checkButton.disabled=state.busy;
      buyButton.classList.toggle("button-dark",true);
      buyButton.classList.toggle("button-light",false);
      buyButton.textContent=trialAccess?"Subscribe now · $2.99 USD / month →":canceled?"Restart Strata+ · $2.99 USD / month →":"Subscribe · $2.99 USD / month →";
      panel.setAttribute("aria-busy",String(state.busy||state.awaitingAccess));

      if(state.busy&&state.awaitingAccess){setStatus("Your checkout completed. STRATA is securely confirming access…","warn");return;}
      if(state.busy){setStatus("Checking your account and secure checkout…");return;}
      if(state.accountStatus==="rechecking"){setStatus("Checking which account is signed in…");return;}
      if(state.accountStatus==="unavailable"){setStatus("STRATA could not recheck your account. Check your connection, then refresh this page.","warn");return;}
      if(checkoutAccountChanged&&(state.checkoutOpen||state.awaitingAccess||state.checkoutPrepared)){setStatus("This checkout belongs to another signed-in session. Sign back in to the account that started it to confirm Strata+ access.","warn");return;}
      if(state.checkoutPrepared){setStatus("Your secure checkout is ready for this account. Reload this page to open it safely.","warn");return;}
      if(state.awaitingAccess){setStatus("Your subscription checkout completed. Access is still being confirmed; check again before opening another checkout.","warn");return;}
      if(state.actionError){setStatus(state.actionError,"error");return;}
      if(state.checkoutOpen){setStatus("Secure checkout is open. Complete it with Paddle to unlock Strata+.");return;}
      if(active){
        if(state.user?.discovery?.adminGrant?.active===true){
          const grant=state.user.discovery.adminGrant;
          const coexistence=subscription
            ?"Your existing monthly subscription remains separate and is not canceled by this grant; manage it from Account."
            :grandfathered
              ?"Your grandfathered lifetime access remains separate and does not renew."
              :"It did not create a paid subscription or consume your trial.";
          setStatus(`You have complimentary Strata+ ${grant?.expiresAt==null?"until an administrator revokes it":`until ${new Date(grant.expiresAt).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}`}. This grant never charges you. ${coexistence}`,"good");return;
        }
        if(trial?.active&&!paid&&!subscription){
          const expiry=new Date(trial.expiresAt).toLocaleString([], {dateStyle:"medium",timeStyle:"short"});
          setStatus(`Your free Strata+ trial is active until ${expiry}. No card was charged, it will end automatically, and subscribing still requires your explicit approval.${state.configError?` ${state.configError} You can keep using your active trial.`:""}`,state.configError?"warn":"good");
        }else if(grandfathered)setStatus("Your prior lifetime Strata+ purchase is grandfathered. It stays active with no monthly renewal or recurring charge.","good");
        else if(subscription?.scheduledChange?.action==="cancel")setStatus(`Your monthly subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its cancellation takes effect. It will not renew after that date.`,"warn");
        else if(subscription?.scheduledChange?.action==="pause")setStatus(`Your monthly subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its scheduled pause takes effect and paid access stops.`,"warn");
        else if(subscription?.pastDue||subscriptionStatus==="past_due")setStatus("Your monthly subscription is past due. Strata+ remains available for now; update your payment method from Account to avoid interruption.","warn");
        else if(subscription)setStatus(`Your monthly subscription is active and renews on ${logic.billingDate(subscription.currentPeriodEndsAt)} unless canceled.`,"good");
        else setStatus("Strata+ access is active on this account.","good");
        return;
      }
      if(!signedIn){
        const message=trialRequested
          ?"Sign in or create an account to start your one free 7-day Strata+ trial. No card is required."
          :pageReason==="ai"
            ?"Strata AI is included with Strata+. Create an account or sign in, then start your free 7-day trial. No card required."
          :pageReason==="access"||pageReason==="discovery-required"
            ?"Sign in or create an account, then start the free trial or explicitly subscribe for $2.99 USD per month to continue."
            :"Create an account or sign in before starting the trial or subscribing, so access follows you across devices.";
        setStatus(message);return;
      }
      if(paused){setStatus("Your monthly subscription is paused and paid access is inactive. Open Account to manage it in Paddle.","warn");return;}
      if(canceled){setStatus("Your previous monthly subscription is canceled and will not renew. You can explicitly start a new subscription whenever you choose.","warn");return;}
      if(!online){setStatus("You are offline. Reconnect before starting a trial or opening secure checkout.","warn");return;}
      if(checkoutBlocked){setStatus("New payment sessions are disabled for this account. Contact STRATA for help.","warn");return;}
      if(trial?.eligible&&pageReason==="ai"){setStatus("Strata AI is included with Strata+. Start your free 7-day trial to use it. No card required and no automatic charge.");return;}
      if(state.configError){setStatus(`${state.configError}${trial?.eligible?" You can still start your free 7-day trial; no card required.":""}`,"warn");return;}
      if(trial?.eligible){setStatus("Your account is eligible for one free 7-day Strata+ trial. No card required and no automatic charge.");return;}
      if(pageReason==="access-revoked"){setStatus("Strata+ access is no longer active, usually because a subscription ended or a charge was refunded or reversed. You may subscribe again or contact STRATA if this is unexpected.","warn");return;}
      if(pageReason==="ai"){setStatus("Strata AI is included with Strata+ for $2.99 USD per month. It renews monthly until canceled.");return;}
      if(pageReason==="access"||pageReason==="discovery-required"){setStatus("Strata+ is $2.99 USD per month and renews monthly until canceled.");return;}
      if(trial&&trial.eligible===false)setStatus("This account has already used its free trial. Subscribe for $2.99 USD per month; it renews monthly until canceled.");
      else setStatus("Signed in and ready for secure Paddle checkout.");
    }

    return{renderPurchaseState,setStatus};
  }

  return{createRenderer};
});
