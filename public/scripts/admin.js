/* global StrataAdminApi, StrataAdminEvents, StrataAdminLogic, StrataAdminRender, StrataAdminSession, StrataAdminState */
(function(){
  "use strict";

  const {PRODUCT_SIGNAL_LABELS,SECTION_NAMES,SUPPORT_LIMIT,SUPPORT_STATES,USER_LIMIT,createState}=StrataAdminState;
  const {
    ACTION_DETAILS,cleanString,firstValue,friendlyError,numberValue,
    supportId,supportState,userEmail,userId,userName,userSuspended
  }=StrataAdminLogic;
  const state=createState();
  const client=StrataAdminApi.createClient({fetchImpl:window.fetch.bind(window),getCsrfToken:()=>state.csrfToken});
  const renderer=StrataAdminRender.createRenderer({
    document,state,logic:StrataAdminLogic,productSignalLabels:PRODUCT_SIGNAL_LABELS,supportStates:SUPPORT_STATES,requestFrame:requestAnimationFrame
  });
  const {clearPrivateData,closeDialog,el,renderAudit,renderOverview,renderProductSignals,renderSupport,renderUserDetails,renderUsers,setActionAvailability,setBusy,setLastUpdated,setSectionStatus,showGlobal,syncDialogLock,updateGrantFields,updateSupportSubmitLabel}=renderer;
  function clearAdminData(){
    state.invalidatePrivateOperations();
    state.loaded.clear();
    state.users.items=[];state.users.total=0;state.users.offset=0;
    state.support.items=[];state.support.total=0;state.support.offset=0;
    state.selectedUser=null;state.selectedTicket=null;state.pendingAction=null;
    state.actionTrigger=null;state.userDialogTrigger=null;state.supportDialogTrigger=null;
    for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close();
    syncDialogLock();clearPrivateData();
    el("grantFields").hidden=true;updateGrantFields();
    for(const id of ["refreshOverview","userSearchButton","refreshSupport","refreshAudit","submitAction","saveSupportUpdate"])el(id).disabled=false;
    for(const id of ["totalUsersStat","verifiedUsersStat","discoveryUsersStat","openSupportStat","suspendedUsersStat","activeSessionsStat","pendingPaymentsStat","pendingDeletionsStat","firstWorkoutAccountsStat","secondWorkoutAccountsStat","dayEightReturnAccountsStat","trialAccountsStat","paidAccountsStat","renewedSubscriptionsStat"])el(id).textContent="—";
  }

  function lockPrivateView(message){
    clearAdminData();state.admin=null;state.csrfToken="";state.authorized=false;document.body.classList.remove("admin-ready");
    el("dashboard").hidden=true;el("accessPanel").hidden=false;el("accessActions").hidden=true;
    el("adminIdentity").textContent="Revalidating administrator";el("lastUpdated").textContent="Private data is locked.";el("accessTitle").textContent="Checking admin access.";
    el("accessMessage").textContent=message;el("adminMain").setAttribute("aria-busy","true");
  }

  function setIdentity(user){el("adminIdentity").textContent=`${userName(user)} · ${userEmail(user)}`;}

  function privateOperationIsCurrent(operation){return state.isCurrentPrivateOperation(operation);}

  function showAccess(message,{signedOut=false,focus=false}={}){
    clearAdminData();state.admin=null;state.csrfToken="";state.authorized=false;document.body.classList.remove("admin-ready");
    el("dashboard").hidden=true;el("accessPanel").hidden=false;
    el("adminIdentity").textContent=signedOut?"No administrator session":"Access unavailable";el("lastUpdated").textContent="Private data is locked.";
    el("accessTitle").textContent=signedOut?"Sign in required.":"Admin access required.";el("accessMessage").textContent=message;el("accessActions").hidden=false;el("adminMain").setAttribute("aria-busy","false");
    if(focus)requestAnimationFrame(()=>el("accessTitle").focus({preventScroll:false}));
  }

  function handleAuthorizationFailure(error){
    const code=String(error?.code||"").toUpperCase();
    if(code==="ADMIN_RELOGIN_REQUIRED"||code==="ADMIN_SESSION_CHANGED"){showAccess("Administrator ownership was secured or your session changed. Sign in again to continue.",{signedOut:true,focus:true});return true;}
    if(error?.status===401){showAccess("Your private session ended. Sign in with the verified administrator account to continue.",{signedOut:true,focus:true});return true;}
    if(error?.status===403){showAccess("This account is signed in, but it is not an approved STRATA administrator.",{focus:true});return true;}
    return false;
  }

  async function loadProductSignals(){
    if(!state.authorized)return;const operation=state.capturePrivateOperation(),request=++state.productSignalRequest;
    const rows=el("productSignalRows");setBusy(rows,true);setSectionStatus("productSignalStatus","Loading aggregate action counts…");
    try{
      const days=Math.max(1,Math.min(90,Number(el("productSignalDays").value)||30)),data=await client.productSignals(days);
      if(privateOperationIsCurrent(operation)&&request===state.productSignalRequest&&state.authorized)renderProductSignals(data);
    }catch(error){if(privateOperationIsCurrent(operation)&&request===state.productSignalRequest&&!handleAuthorizationFailure(error))setSectionStatus("productSignalStatus",friendlyError(error),{error:true});}
    finally{if(privateOperationIsCurrent(operation)&&request===state.productSignalRequest)setBusy(rows,false);}
  }

  async function loadOverview(){
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    const button=el("refreshOverview");button.disabled=true;setSectionStatus("overviewStatus","Loading current account and service totals…");
    try{
      const data=await client.overview();if(!privateOperationIsCurrent(operation)||!state.authorized)return;renderOverview(data);await loadProductSignals();if(!privateOperationIsCurrent(operation)||!state.authorized)return;
      state.loaded.add("overview");setLastUpdated();setSectionStatus("overviewStatus","Overview is current.");
    }catch(error){if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error))setSectionStatus("overviewStatus",friendlyError(error),{error:true});}
    finally{if(privateOperationIsCurrent(operation))button.disabled=false;}
  }

  async function loadUsers(){
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    const request=++state.users.request,params=new URLSearchParams({limit:String(USER_LIMIT),offset:String(state.users.offset)});if(state.users.query)params.set("q",state.users.query);
    setBusy(el("userResults"),true);setSectionStatus("usersStatus","Loading accounts…");el("userSearchButton").disabled=true;
    try{
      const data=await client.users(params);if(!privateOperationIsCurrent(operation)||request!==state.users.request||!state.authorized)return;
      const items=Array.isArray(data.users)?data.users:Array.isArray(data.items)?data.items:[],total=numberValue(firstValue(data,["total","totalUsers","count"],items.length),items.length);
      state.users.items=items;state.users.total=Math.max(total,state.users.offset+items.length);renderUsers(items,state.users.total,openUserDialog);state.loaded.add("people");setLastUpdated();setSectionStatus("usersStatus",items.length?"Select an account to inspect it and open audited controls.":"");
    }catch(error){if(privateOperationIsCurrent(operation)&&request===state.users.request&&!handleAuthorizationFailure(error))setSectionStatus("usersStatus",friendlyError(error),{error:true});}
    finally{if(privateOperationIsCurrent(operation)&&request===state.users.request){setBusy(el("userResults"),false);el("userSearchButton").disabled=false;}}
  }

  async function openUserDialog(user,trigger){
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    state.userDialogTrigger=trigger;renderUserDetails(user,{actionsReady:false});el("userDetailStatus").textContent="Loading full account details…";el("userDetailStatus").classList.remove("error");
    const dialog=el("userDialog");setBusy(dialog,true);dialog.showModal();syncDialogLock();requestAnimationFrame(()=>el("userDialogTitle").focus?.({preventScroll:true}));
    const targetId=userId(user);
    try{
      const result=await client.user(targetId);if(!privateOperationIsCurrent(operation)||!state.authorized||!dialog.open||userId(state.selectedUser)!==targetId)return;if(!result.user)throw new Error("Full account details were not returned.");
      renderUserDetails(result.user,{actionsReady:true});el("userDetailStatus").textContent="Account details are current.";el("userDetailStatus").classList.remove("error");
    }catch(error){
      if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error)&&dialog.open){setActionAvailability(state.selectedUser||user,{actionsReady:false});el("userDetailStatus").textContent=`Account actions remain locked. ${friendlyError(error)}`;el("userDetailStatus").classList.add("error");}
    }finally{if(privateOperationIsCurrent(operation))setBusy(dialog,false);}
  }

  function openActionConfirmation(action,trigger){
    renderer.openActionConfirmation(action,trigger,ACTION_DETAILS[action]);
  }

  async function submitUserAction(event){
    event.preventDefault();const user=state.selectedUser,action=state.pendingAction,details=ACTION_DETAILS[action];if(!user||!details)return;
    if(!state.authorized)return;const operation=state.capturePrivateOperation(),message=el("confirmMessage");
    const payload={action,expectedControlsRevision:Number(user.controlsRevision||0)};
    if(action==="grant-plus"){
      const unit=el("grantUnit").value,amount=Number(el("grantAmount").value),date=new Date(el("grantUntil").value);
      if(unit==="until"&&(!Number.isFinite(date.getTime())||date.getTime()<=Date.now())||!["until","indefinite"].includes(unit)&&(!Number.isSafeInteger(amount)||amount<1)){message.textContent="Choose a positive whole duration or a future expiry date.";message.hidden=false;message.focus();return;}
      payload.grant=unit==="until"?{unit,expiresAt:date.toISOString()}:{unit,amount};
    }
    const button=el("submitAction");button.disabled=true;message.textContent="Applying the audited account action…";message.className="dialog-message";message.hidden=false;
    try{
      const result=await client.userAction(userId(user),payload);if(!privateOperationIsCurrent(operation)||!state.authorized)return;closeDialog(el("confirmDialog"));closeDialog(el("userDialog"));showGlobal(cleanString(result.message,"The account action was completed and recorded."),{focus:true});
      state.selectedUser=null;state.pendingAction=null;state.actionTrigger=null;state.loaded.delete("overview");state.loaded.delete("activity");await Promise.all([loadUsers(),loadOverview()]);
    }catch(error){
      if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error)){
        try{const refreshed=await client.user(userId(user));if(privateOperationIsCurrent(operation)&&state.authorized&&refreshed.user)renderUserDetails(refreshed.user);}catch{/* Preserve the action error. */}
        if(!privateOperationIsCurrent(operation)||!state.authorized)return;
        message.textContent=friendlyError(error)+(action==="delete-account"&&userSuspended(state.selectedUser)?" The account remains paused. To restore access, cancel this review and choose Restore account; otherwise retry deletion after the payment state changes.":"");message.className="dialog-message error";message.hidden=false;message.focus();
      }
    }finally{if(privateOperationIsCurrent(operation))button.disabled=false;}
  }

  async function loadSupport(){
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    const request=++state.support.request,params=new URLSearchParams({limit:String(SUPPORT_LIMIT),offset:String(state.support.offset)});if(state.support.status)params.set("status",state.support.status);
    setBusy(el("supportResults"),true);setSectionStatus("supportStatus","Loading the help queue…");el("refreshSupport").disabled=true;
    try{
      const data=await client.support(params);if(!privateOperationIsCurrent(operation)||request!==state.support.request||!state.authorized)return;
      const items=Array.isArray(data.tickets)?data.tickets:Array.isArray(data.items)?data.items:[],total=numberValue(firstValue(data,["total","totalTickets","count"],items.length),items.length);
      state.support.items=items;state.support.total=Math.max(total,state.support.offset+items.length);renderSupport(items,state.support.total,openSupportDialog);state.loaded.add("support");setLastUpdated();setSectionStatus("supportStatus",items.length?"Select a request to update its workflow.":"");
    }catch(error){if(privateOperationIsCurrent(operation)&&request===state.support.request&&!handleAuthorizationFailure(error))setSectionStatus("supportStatus",friendlyError(error),{error:true});}
    finally{if(privateOperationIsCurrent(operation)&&request===state.support.request){setBusy(el("supportResults"),false);el("refreshSupport").disabled=false;}}
  }

  function openSupportDialog(ticket,trigger){renderer.openSupportDialog(ticket,trigger);}

  async function submitSupportUpdate(event){
    event.preventDefault();const ticket=state.selectedTicket;if(!ticket)return;
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    const status=el("ticketStatus").value,note=el("ticketNote").value.trim(),response=el("ticketResponse").value.trim(),message=el("supportUpdateMessage");
    if(!SUPPORT_STATES.has(status)){message.textContent="Choose a valid request status.";message.className="dialog-message error";message.hidden=false;message.focus();return;}
    const existingNote=cleanString(firstValue(ticket,["note","adminNote","admin_note"],""),"");
    if(status===supportState(ticket,SUPPORT_STATES)&&note===existingNote&&!response){message.textContent="Change the status, edit the private note, or write an email response before saving.";message.className="dialog-message error";message.hidden=false;message.focus();return;}
    const button=el("saveSupportUpdate");button.disabled=true;message.textContent=response?"Saving the workflow and sending the response…":"Saving the help-request workflow…";message.className="dialog-message";message.hidden=false;
    try{
      const expectedUpdatedAt=numberValue(firstValue(ticket,["updatedAt","updated_at"]),0),result=await client.updateSupport(supportId(ticket),{status,note,response,expectedUpdatedAt});if(!privateOperationIsCurrent(operation)||!state.authorized)return;
      closeDialog(el("supportDialog"));showGlobal(cleanString(result.message,response?"The update was saved and the response was sent.":"The help request was updated."),{focus:true});state.loaded.delete("overview");state.loaded.delete("activity");await Promise.all([loadSupport(),loadOverview()]);
    }catch(error){if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error)){message.textContent=friendlyError(error);message.className="dialog-message error";message.hidden=false;message.focus();}}
    finally{if(privateOperationIsCurrent(operation))button.disabled=false;}
  }

  async function loadAudit(){
    if(!state.authorized)return;const operation=state.capturePrivateOperation();
    const button=el("refreshAudit");button.disabled=true;setBusy(el("auditResults"),true);setSectionStatus("auditStatus","Loading the audit trail…");
    try{
      const data=await client.audit();if(!privateOperationIsCurrent(operation)||!state.authorized)return;const entries=Array.isArray(data.events)?data.events:Array.isArray(data.audit)?data.audit:Array.isArray(data.entries)?data.entries:Array.isArray(data.items)?data.items:[];
      renderAudit(entries);state.loaded.add("activity");setLastUpdated();setSectionStatus("auditStatus",entries.length?`Showing the ${entries.length} most recent recorded actions.`:"");
    }catch(error){if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error))setSectionStatus("auditStatus",friendlyError(error),{error:true});}
    finally{if(privateOperationIsCurrent(operation)){setBusy(el("auditResults"),false);button.disabled=false;}}
  }

  function loadSection(name,{force=false}={}){
    if(!force&&state.loaded.has(name))return Promise.resolve();
    return name==="overview"?loadOverview():name==="people"?loadUsers():name==="support"?loadSupport():name==="activity"?loadAudit():Promise.resolve();
  }
  function activateSection(name,{focus=false,replaceHash=true}={}){
    if(!SECTION_NAMES.has(name))name="overview";state.activeSection=name;
    for(const button of document.querySelectorAll("[data-section]")){const active=button.dataset.section===name;button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;}
    for(const panel of document.querySelectorAll("[data-panel]"))panel.hidden=panel.dataset.panel!==name;
    if(replaceHash)history.replaceState({},"",`#${name}`);if(focus)requestAnimationFrame(()=>el(`${name}Title`)?.focus?.());void loadSection(name);
  }

  function openDashboard({focus=false}={}){
    state.authorized=true;document.body.classList.add("admin-ready");el("accessPanel").hidden=true;el("dashboard").hidden=false;el("adminMain").setAttribute("aria-busy","false");
    el("lastUpdated").textContent="Administrator access confirmed.";
    const requested=location.hash.slice(1),section=SECTION_NAMES.has(requested)?requested:"overview";activateSection(section,{replaceHash:!SECTION_NAMES.has(requested)});if(focus)requestAnimationFrame(()=>el(`${section}Tab`).focus({preventScroll:false}));
  }

  async function initialize(){
    const operation=state.capturePrivateOperation();
    try{
      const result=await client.identity();if(!privateOperationIsCurrent(operation))return;if(!result.user){showAccess("Sign in with the verified administrator account to continue.",{signedOut:true});return;}
      if(result.user.isAdmin!==true&&result.user.admin!==true){showAccess("This account is signed in, but it is not an approved STRATA administrator.");return;}
      state.admin=result.user;state.csrfToken=cleanString(result.csrfToken,"");setIdentity(result.user);
      const adminSession=await client.adminSession();if(!privateOperationIsCurrent(operation))return;if(adminSession.admin!==true){showAccess("This account is signed in, but it is not an approved STRATA administrator.");return;}openDashboard();
    }catch(error){if(privateOperationIsCurrent(operation)&&!handleAuthorizationFailure(error)){el("accessTitle").textContent="Admin service unavailable.";el("accessMessage").textContent=friendlyError(error);el("accessActions").hidden=false;el("adminMain").setAttribute("aria-busy","false");}}
  }

  const {handlePageShow,handleVisibilityChange}=StrataAdminSession.createSessionCoordinator({
    client,state,document,location,userId,cleanString,lockPrivateView,setIdentity,showAccess,openDashboard,handleAuthorizationFailure
  });

  StrataAdminEvents.bindEvents({document,window,state,userLimit:USER_LIMIT,supportLimit:SUPPORT_LIMIT,handlers:{
    activateSection,closeDialog,handlePageShow,handleVisibilityChange,
    loadAudit,loadOverview,loadProductSignals,loadSupport,loadUsers,openActionConfirmation,submitSupportUpdate,submitUserAction,syncDialogLock,updateGrantFields,updateSupportSubmitLabel
  }});
  void initialize();
})();
