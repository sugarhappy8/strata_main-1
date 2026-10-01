/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPricingRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createRenderer({state,nodes,logic,navigatorImpl=globalThis.navigator,locationImpl=globalThis.location,frame=globalThis.requestAnimationFrame}){
    const{panel,statusNode,signupLink,loginLink,buyButton,openLink,manageLink,checkButton}=nodes;
    const pageReason=new URLSearchParams(locationImpl.search).get("reason");
    // Members sent here from Strata AI return to it after signing up, signing in, or subscribing.
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
      const subscription=logic.subscriptionFor(state.user),subscriptionStatus=String(subscription?.status||"");
      // The free trial is retired; a trial started before then still runs to its recorded end and may subscribe early.
      const legacyTrial=active&&state.user?.discovery?.accessType==="trial"?state.user.discovery.trial:null;
      const grandfathered=active&&!subscription&&["lifetime","paid"].includes(String(state.user?.discovery?.accessType||""));
      const online=navigatorImpl.onLine!==false;
      const checkoutReady=Boolean(state.config&&!state.configError&&state.paddleReady&&online);
      const paused=subscriptionStatus==="paused",canceled=subscriptionStatus==="canceled";
      const canSubscribe=signedIn&&(!active||Boolean(legacyTrial))&&!paused;
      const checkoutBlocked=state.user?.discovery?.checkoutBlocked===true;
      const checkoutAccountChanged=Boolean(state.currentCheckoutUserId)&&String(state.user?.id||"")!==state.currentCheckoutUserId;

      signupLink.hidden=signedIn;
      loginLink.hidden=signedIn;
      buyButton.hidden=!canSubscribe;
      openLink.hidden=!signedIn||!active;
      manageLink.hidden=!signedIn||!subscription;
      checkButton.hidden=!signedIn||logic.paidAccessReady(state.user)||!state.awaitingAccess;
      buyButton.disabled=state.busy||state.awaitingAccess||state.checkoutOpen||!checkoutReady||checkoutBlocked;
      checkButton.disabled=state.busy;
      buyButton.textContent=canceled?"Restart Strata+ →":"Subscribe to Strata+ →";
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
              :"It did not create a paid subscription.";
          setStatus(`You have complimentary Strata+ ${grant?.expiresAt==null?"until an administrator revokes it":`until ${new Date(grant.expiresAt).toLocaleString([], {dateStyle:"medium",timeStyle:"short"})}`}. This grant never charges you. ${coexistence}`,"good");return;
        }
        if(legacyTrial&&!subscription){
          const expiry=new Date(legacyTrial.expiresAt).toLocaleString([], {dateStyle:"medium",timeStyle:"short"});
          setStatus(`Your Strata+ trial ends ${expiry} and never charges you. Subscribe any time to keep Strata+ after it ends.${state.configError?` ${state.configError}`:""}`,state.configError?"warn":"good");
        }else if(grandfathered)setStatus("Your prior lifetime Strata+ purchase is grandfathered. It stays active with no monthly renewal or recurring charge.","good");
        else if(subscription?.scheduledChange?.action==="cancel")setStatus(`Your monthly subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its cancellation takes effect. It will not renew after that date.`,"warn");
        else if(subscription?.scheduledChange?.action==="pause")setStatus(`Your monthly subscription remains active until ${logic.billingDate(subscription.scheduledChange.effectiveAt)}, when its scheduled pause takes effect and paid access stops.`,"warn");
        else if(subscription?.pastDue||subscriptionStatus==="past_due")setStatus("Your monthly subscription is past due. Strata+ remains available for now; update your payment method from Account to avoid interruption.","warn");
        else if(subscription)setStatus(`Your monthly subscription is active and renews on ${logic.billingDate(subscription.currentPeriodEndsAt)} unless canceled.`,"good");
        else setStatus("Strata+ access is active on this account.","good");
        return;
      }
      if(!signedIn){
        const message=pageReason==="ai"
          ?"Strata AI is included with Strata+. Create an account or sign in, then subscribe to use it."
          :pageReason==="access"||pageReason==="discovery-required"
            ?"That page is part of Strata+. Sign in or create an account, then subscribe to continue."
            :"Create an account or sign in to subscribe, so access follows you across devices.";
        setStatus(message);return;
      }
      if(paused){setStatus("Your monthly subscription is paused and paid access is inactive. Open Account to manage it in Paddle.","warn");return;}
      if(canceled){setStatus("Your previous monthly subscription is canceled and will not renew. You can explicitly start a new subscription whenever you choose.","warn");return;}
      if(!online){setStatus("You are offline. Reconnect before opening secure checkout.","warn");return;}
      if(checkoutBlocked){setStatus("New payment sessions are disabled for this account. Contact STRATA for help.","warn");return;}
      // Why the member arrived stays visible even when checkout cannot open right now.
      const reasonNote=pageReason==="ai"?"Strata AI is included with Strata+.":pageReason==="access"||pageReason==="discovery-required"?"That page is part of Strata+.":"";
      if(state.configError){setStatus(`${reasonNote?`${reasonNote} `:""}${state.configError}`,"warn");return;}
      if(pageReason==="access-revoked"){setStatus("Strata+ access is no longer active, usually because a subscription ended or a charge was refunded or reversed. You may subscribe again or contact STRATA if this is unexpected.","warn");return;}
      if(reasonNote){setStatus(`${reasonNote} Subscribe to ${pageReason==="ai"?"use it":"continue"}.`);return;}
      setStatus("Signed in and ready for secure Paddle checkout.");
    }

    return{renderPurchaseState,setStatus};
  }

  return{createRenderer};
});
