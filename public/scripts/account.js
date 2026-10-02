/* global StrataAccountApi, StrataAccountDeleteDialog, StrataAccountDevices, StrataAccountEvents, StrataAccountLogic, StrataAccountRender, StrataAccountState, StrataDevicesCore */
"use strict";

const logic=StrataAccountLogic;
const params=new URLSearchParams(location.search);
const requestedMode=params.get("mode"),mode=requestedMode==="login"?"login":"signup";
const next=logic.safeNext(params.get("next"),params.get("add"));
const renderer=StrataAccountRender.createRenderer();
const el=renderer.el;
const state=StrataAccountState.createState({pendingQueryError:logic.safeQueryError(params.get("error"))});
const api=StrataAccountApi.createClient({fetchImpl:(...args)=>{
  if(typeof globalThis.fetch!=="function")throw new TypeError("Fetch is unavailable.");
  return globalThis.fetch(...args);
},getCsrfToken:state.getCsrfToken});
const devices=StrataAccountDevices.createController({element:el,api,core:StrataDevicesCore,onAccountChanged:()=>showChangedAccount()});
const authForms={signup:el("signupForm"),login:el("loginForm")};
const authButtons={signup:el("signupSubmit"),login:el("loginSubmit")};
const preferredPanel=el(mode==="login"?"loginPanel":"signupPanel");
let foregroundRecheck=null,signedInUser=null;

preferredPanel.classList.add("active");
if(mode==="login")document.querySelector(".auth-grid").prepend(preferredPanel);
for(const id of ["signupNext","loginNext","socialSignupNext","socialLoginNext"])if(el(id))el(id).value=next;

if(params.has("error")){
  const cleanUrl=new URL(location.href);cleanUrl.searchParams.delete("error");
  history.replaceState({},"",`${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}

function rememberVerification(value,purpose="signup"){
  try{
    const masked=String(value||"").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,254);
    if(masked)globalThis.sessionStorage?.setItem("strata.verification.maskedEmail",masked);
    else globalThis.sessionStorage?.removeItem("strata.verification.maskedEmail");
    globalThis.sessionStorage?.setItem("strata.verification.purpose",purpose==="login"?"login":"signup");
  }catch{/* Verification still works without optional session storage. */}
}

function clearPrivateView(){state.invalidatePrivateRequests();renderer.clearPrivateData();devices.reset();}

function showAccess(sessionError=""){
  state.invalidatePrivateRequests();
  renderer.showAccess({message:state.takePendingError()||sessionError,mode,requestedMode,preferredPanel});
}

function showChangedAccount(){state.invalidatePrivateRequests();devices.reset();renderer.showChangedAccount();}
function handlePageShow(event){if(event.persisted){clearPrivateView();renderer.showInitialLoading();location.reload();}}

async function handleForeground(){
  if(document.hidden)return;
  if(foregroundRecheck)return foregroundRecheck;
  const previous=state.beginPrivateOperation();clearPrivateView();renderer.showInitialLoading();const request=state.beginIdentity();
  const task=(async()=>{
    try{
      const result=await api.identity({cache:"no-store"});if(!state.isCurrentIdentity(request))return;
      if(previous.userId&&String(result.user?.id||"")!==previous.userId){showChangedAccount();return;}
      showSignedIn(result.user,result.csrfToken);
    }catch(error){
      if(!state.isCurrentIdentity(request))return;
      if(error.status===401){showAccess();return;}showChangedAccount();
    }
  })();
  foregroundRecheck=task;
  try{return await task;}finally{if(foregroundRecheck===task)foregroundRecheck=null;}
}

async function confirmPrivateOperation(operation){
  if(!state.isCurrentPrivateOperation(operation))return false;
  const identity=await api.identity({cache:"no-store"});
  if(!state.isCurrentPrivateOperation(operation))return false;
  if(String(identity.user?.id||"")!==operation.userId)throw Object.assign(new Error("The signed-in account changed."),{code:"account-changed"});
  state.setCsrfToken(identity.csrfToken||state.getCsrfToken());return true;
}

async function loadAccountSessions(user){
  const request=state.beginSessionList();renderer.showSessionLoading();
  try{
    const result=await api.sessions();
    if(!state.isCurrentSessionList(request))return;
    if(String(result.userId||"")!==String(user?.id||"")||!Array.isArray(result.sessions))throw Object.assign(new Error("The signed-in account changed."),{code:"account-changed"});
    renderer.renderAccountSessions(result.sessions);renderer.showAccountControlStatus("accountSessionStatus","");
  }catch(error){
    if(!state.isCurrentSessionList(request))return;
    if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}
    renderer.showSessionError();
  }
}

function showSignedIn(user,csrfToken=""){
  signedInUser=user||null;state.setPrivateUser(user?.id);state.setCsrfToken(csrfToken);renderer.showSignedIn(user);
  void loadAccountSessions(user);void devices.load(user);
}

async function initialize(){
  renderer.showInitialLoading();const request=state.beginIdentity();
  try{const result=await api.identity();if(!state.isCurrentIdentity(request))return;showSignedIn(result.user,result.csrfToken);}
  catch(error){if(!state.isCurrentIdentity(request))return;if(error.status===401){showAccess();return;}showAccess("We could not verify your current session. You can still try an account request.");}
}

function payloadFor(authMode,form){
  const data=new FormData(form),payload={email:String(data.get("email")||""),password:String(data.get("password")||"")};
  if(authMode==="signup")payload.name=String(data.get("name")||"");
  return payload;
}

function enhanceForm(authMode){
  const form=authForms[authMode],button=authButtons[authMode];form.addEventListener("input",renderer.clearAllFormErrors);
  form.addEventListener("submit",async(event)=>{
    event.preventDefault();
    if(state.isNavigating()||form.dataset.submitting==="true")return;
    renderer.clearFormError(authMode);form.dataset.submitting="true";form.setAttribute("aria-busy","true");button.disabled=true;
    renderer.setButtonBusy(button,true,authMode==="signup"?"Creating account, please wait":"Signing in, please wait");
    try{
      const result=await api.authenticate(authMode,payloadFor(authMode,form));
      if(result.verificationRequired===true){
        const purpose=result.purpose==="login"?"login":authMode;rememberVerification(result.maskedEmail,purpose);state.setNavigating();location.assign(logic.verificationLocation(next,{purpose}));return;
      }
      if(!result.user?.id)throw Object.assign(new Error("The account service returned an unexpected response."),{code:"invalid-response",status:502});
      state.setNavigating();location.assign(next);
    }catch(error){
      if(error.verificationRequired===true){
        const purpose=error.purpose==="login"?"login":authMode;rememberVerification(error.maskedEmail,purpose);
        const deliveryFailed=error.deliveryState==="failed"||["EMAIL_DELIVERY_UNAVAILABLE","EMAIL_DELIVERY_FAILED"].includes(String(error.code||"").toUpperCase());
        state.setNavigating();location.assign(logic.verificationLocation(next,{deliveryState:deliveryFailed?"failed":"",purpose}));return;
      }
      renderer.showFormError(authMode,logic.friendlyAuthError(error,authMode),{status:error.status,focus:true});
    }finally{
      if(!state.isNavigating()){delete form.dataset.submitting;form.removeAttribute("aria-busy");button.disabled=false;renderer.setButtonBusy(button,false);}
    }
  });
}

async function revokeSession(sessionId,button){return revokeSessions("one",sessionId,button);}
async function revokeOtherSessions(button){return revokeSessions("others","",button);}

async function revokeSessions(kind,sessionId,button){
  if(button.disabled)return;
  const operation=state.beginPrivateOperation();
  button.disabled=true;renderer.setButtonBusy(button,true,"Signing out sessions, please wait");renderer.showAccountControlStatus("accountSessionStatus","Updating active sessions…");
  try{
    const result=kind==="others"?await api.revokeOtherSessions():await api.revokeSession(sessionId);
    if(!await confirmPrivateOperation(operation))return;
    if(!Array.isArray(result.sessions))throw Object.assign(new Error("The session response was incomplete."),{code:"invalid-response"});
    renderer.renderAccountSessions(result.sessions);const count=Math.max(0,Number(result.revoked)||0);
    renderer.showAccountControlStatus("accountSessionStatus",kind==="others"?`${count} other ${count===1?"session was":"sessions were"} signed out.`:"The selected session was signed out.");
  }catch(error){
    if(!state.isCurrentPrivateOperation(operation))return;
    if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}
    renderer.showAccountControlStatus("accountSessionStatus",logic.selfServiceError(error,"session"),{error:true,focus:true});
  }finally{if(state.isCurrentPrivateOperation(operation)){button.disabled=button===el("accountRevokeOtherSessions")?button.hidden:false;renderer.setButtonBusy(button,false);}}
}

async function downloadExport(event){
  const button=event.currentTarget;if(button.disabled)return;
  const operation=state.beginPrivateOperation();
  button.disabled=true;renderer.setButtonBusy(button,true,"Preparing your account export, please wait");renderer.showAccountControlStatus("accountExportStatus","Collecting your account data…");
  try{
    const result=await api.exportAccount();if(!await confirmPrivateOperation(operation))return;
    const href=URL.createObjectURL(result.blob),link=document.createElement("a");
    const filename=result.contentDisposition.match(/filename="(strata-account-export-\d{4}-\d{2}-\d{2}\.json)"/)?.[1]||"strata-account-export-download.json";
    link.href=href;link.download=filename;link.hidden=true;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),60_000);renderer.showAccountControlStatus("accountExportStatus",globalThis.StrataApp?"Your JSON export is ready. Choose where to save it.":"Your JSON export was downloaded.");
  }catch(error){
    if(!state.isCurrentPrivateOperation(operation))return;
    if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}
    renderer.showAccountControlStatus("accountExportStatus",logic.selfServiceError(error,"export"),{error:true,focus:true});
  }finally{if(state.isCurrentPrivateOperation(operation)){button.disabled=false;renderer.setButtonBusy(button,false);}}
}

async function openBillingPortal(kind,event){
  const buttons=[el("accountManageSubscription"),el("accountUpdatePayment"),el("accountCancelSubscription")],button=event.currentTarget,status=el("accountBillingStatus");
  if(button.disabled)return;
  const operation=state.beginPrivateOperation();
  if(!state.getCsrfToken()){status.textContent="Your session needs refreshing before billing can be opened.";status.classList.add("bad");status.focus({preventScroll:false});return;}
  buttons.forEach((control)=>{control.disabled=true;});status.classList.remove("bad");status.textContent=kind==="cancel"?"Preparing Paddle’s secure cancellation page…":kind==="payment"?"Preparing Paddle’s secure payment page…":"Preparing Paddle’s secure subscription portal…";
  try{
    const result=await api.billingPortal();if(!await confirmPrivateOperation(operation))return;
    const field=kind==="cancel"?"cancelUrl":kind==="payment"?"updatePaymentMethodUrl":"overviewUrl",destination=logic.safePortalUrl(result[field]);
    if(!destination)throw Object.assign(new Error("Paddle returned an invalid subscription-management link."),{code:"invalid-response"});
    status.textContent="Opening Paddle’s secure portal…";location.assign(destination);
  }catch(error){if(!state.isCurrentPrivateOperation(operation))return;if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}status.textContent=logic.billingError(error);status.classList.add("bad");status.focus({preventScroll:false});}
  finally{if(state.isCurrentPrivateOperation(operation))buttons.forEach((control)=>{control.disabled=false;});}
}

// Inside the iOS app an App Store subscription is managed on Apple's own sheet; an app build without it, or a sheet
// that fails to open, goes to Apple's subscriptions page instead. On the website the link opens that page itself.
async function manageAppleSubscription(event,href=logic.APPLE_MANAGE_URL){
  if(!globalThis.StrataApp)return;
  event?.preventDefault?.();
  const status=el("accountBillingStatus");status.textContent="";status.classList.remove("bad");
  try{const native=globalThis.StrataAppMode?.plugin?.();if(typeof native?.manageSubscriptions!=="function")throw new Error("unavailable");await native.manageSubscriptions();}
  catch{location.assign(logic.safeAppleManageUrl(href));}
}

async function requestSecurityEmail(kind,event){
  const button=event.currentTarget;if(button.disabled)return;
  const operation=state.beginPrivateOperation();
  button.disabled=true;renderer.setButtonBusy(button,true,kind==="delete"?"Sending deletion link, please wait":"Sending password reset link, please wait");
  renderer.showSecurityStatus(kind==="delete"?"Preparing the deletion confirmation email…":"Preparing your password-reset email…");
  try{
    const result=kind==="delete"?await api.requestDeletion():await api.requestPasswordReset();
    if(!await confirmPrivateOperation(operation))return;
    const apple=kind==="delete"?logic.appleDeletionNotice(result):null;
    renderer.showSecurityStatus(kind==="delete"?`A deletion confirmation link was sent to ${result.maskedEmail||"your registered email"}. Nothing is deleted until you open it and type DELETE. ${apple?`Deletion does not cancel a subscription or refund a charge. ${apple.message}`:globalThis.StrataApp?"Deletion does not cancel a subscription or refund a charge; an App Store subscription keeps billing until you cancel it in Settings › Apple Account › Subscriptions.":"Deletion does not cancel a Paddle subscription or refund a charge."}`:`A password-reset link was sent to ${result.maskedEmail||"your registered email"}. The link expires after 30 minutes.`,{appleLink:apple?.manageUrl||""});
    if(kind==="delete")el("accountDeleteCancel").hidden=false;
  }catch(error){if(!state.isCurrentPrivateOperation(operation))return;if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}renderer.showSecurityStatus(logic.securityError(error),{error:true});}
  finally{if(state.isCurrentPrivateOperation(operation)){button.disabled=false;renderer.setButtonBusy(button,false);}}
}

async function cancelDeletion(event){
  const button=event.currentTarget,operation=state.beginPrivateOperation();button.disabled=true;renderer.setButtonBusy(button,true,"Canceling deletion request, please wait");
  try{await api.cancelDeletion();if(!await confirmPrivateOperation(operation))return;button.hidden=true;renderer.showSecurityStatus("The pending deletion request was canceled. Any link from that email can no longer be used.");}
  catch(error){if(!state.isCurrentPrivateOperation(operation))return;if(logic.accountBoundaryChanged(error)){showChangedAccount();return;}renderer.showSecurityStatus(logic.securityError(error),{error:true});}
  finally{if(state.isCurrentPrivateOperation(operation)){button.disabled=false;renderer.setButtonBusy(button,false);}}
}

async function logout(event){
  const button=event.currentTarget,operation=state.beginPrivateOperation();button.disabled=true;renderer.setButtonBusy(button,true,"Signing out, please wait");el("signedInMessage").hidden=true;
  try{await api.logout();if(!state.isCurrentPrivateOperation(operation))return;clearPrivateView();location.replace("/");}
  catch(error){
    if(!state.isCurrentPrivateOperation(operation))return;
    if(error.status===401){clearPrivateView();location.replace("/");return;}
    button.disabled=false;renderer.setButtonBusy(button,false);el("signedInMessage").textContent="Could not sign out. Check your connection and try again.";el("signedInMessage").hidden=false;
  }
}

// In the iOS app, Delete account opens the in-app deletion dialog; browsers (and an app web view without <dialog>)
// keep the emailed deletion link, which the dialog also offers.
const deleteDialog=StrataAccountDeleteDialog.createController({
  element:el,api,logic,getUser:()=>signedInUser,
  emailInstead:()=>requestSecurityEmail("delete",{currentTarget:el("accountDeleteRequest")}),
  manageApple:(event,href)=>void manageAppleSubscription(event,href),
  onDeleted:()=>{state.setNavigating();clearPrivateView();}
});
function requestSecurityAction(kind,event){
  if(kind==="delete"&&deleteDialog.open(event?.currentTarget||null))return;
  return requestSecurityEmail(kind,event);
}

StrataAccountEvents.bind({
  nodes:{
    passwordReset:el("accountPasswordReset"),deleteRequest:el("accountDeleteRequest"),manageSubscription:el("accountManageSubscription"),updatePayment:el("accountUpdatePayment"),cancelSubscription:el("accountCancelSubscription"),
    sessionList:el("accountSessionList"),revokeOtherSessions:el("accountRevokeOtherSessions"),exportData:el("accountExportData"),deleteCancel:el("accountDeleteCancel"),reload:el("accountReload"),logout:el("accountLogout"),
    signupPassword:el("signupPassword"),signupPasswordToggle:el("signupPasswordToggle"),loginPassword:el("loginPassword"),loginPasswordToggle:el("loginPasswordToggle")
  },
  actions:{requestSecurityEmail:requestSecurityAction,openBillingPortal,revokeSession,revokeOtherSessions,downloadExport,cancelDeletion,reload:()=>location.reload(),logout,enhanceForm,handleForeground,handlePageShow},
  enhanceAuth:typeof globalThis.fetch==="function"&&typeof globalThis.FormData==="function"
});

el("accountManageApple").addEventListener("click",(event)=>void manageAppleSubscription(event));
el("accountSecurityAppleLink").addEventListener("click",(event)=>void manageAppleSubscription(event,el("accountSecurityAppleLink").href));
initialize();
