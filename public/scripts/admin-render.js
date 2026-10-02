/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAdminRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createRenderer({document,state,logic,productSignalLabels,supportStates,requestFrame=(callback)=>callback()}){
    if(!document||!state||!logic)throw new TypeError("Admin rendering requires document, state, and logic dependencies.");
    const {
      appleFacts,booleanValue,cleanString,deletionPending,discoveryActive,firstValue,formatCount,formatDate,
      normalizedOverview,numberValue,overviewNumber,planSummary,supportReference,supportState,
      supportStateLabel,userEmail,userId,userName,userSuspended,userVerified
    }=logic;
    const el=(id)=>document.getElementById(id);
    let globalMessageTimer;

    function create(tag,className="",text=""){
      const node=document.createElement(tag);
      if(className)node.className=className;
      if(text!=="")node.textContent=String(text);
      return node;
    }
    function setBusy(node,busy){node?.setAttribute("aria-busy",busy?"true":"false");}
    function setSectionStatus(id,message,{error=false}={}){
      const node=el(id);node.textContent=message;node.classList.toggle("error",error);
    }
    function showGlobal(message,{error=false,warn=false,focus=false,persist=false}={}){
      const node=el("globalMessage");clearTimeout(globalMessageTimer);
      node.textContent=message;node.classList.toggle("error",error);node.classList.toggle("warn",warn&&!error);node.hidden=!message;
      if(message&&focus)requestFrame(()=>node.focus({preventScroll:false}));
      if(message&&!persist&&!error&&!focus)globalMessageTimer=setTimeout(()=>{node.hidden=true;},7000);
    }
    function setLastUpdated(){
      el("lastUpdated").textContent=`Last refreshed ${new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit",second:"2-digit"}).format(new Date())}`;
    }
    function setService(nodeId,message,stateName="warn"){
      const node=el(nodeId);node.textContent=message;
      const row=node.closest("li");row.classList.remove("good","warn","bad");row.classList.add(stateName);
    }
    function renderSystemStatus(data){
      const stats=normalizedOverview(data),system=data?.system||data?.health||data?.status||stats?.services||stats?.system||{};
      const storage=firstValue(system,["storage","storageKind"],firstValue(data,["storage"],"unknown"));
      const persistent=booleanValue(system,["persistent","storagePersistent"])??booleanValue(data,["persistent"]);
      if(persistent===true)setService("storageStatus",`${cleanString(storage,"Persistent")} · persistent`,"good");
      else if(persistent===false)setService("storageStatus",`${cleanString(storage,"Storage")} · not persistent`,"bad");
      else setService("storageStatus",cleanString(storage,"Status unavailable"),"warn");
      const email=booleanValue(system,["email","emailConfigured","emailVerificationConfigured","emailReady"])??booleanValue(data,["emailConfigured","emailVerificationConfigured"]);
      setService("emailStatus",email===true?"Configured":email===false?"Not configured":"Status unavailable",email===true?"good":email===false?"bad":"warn");
      const payments=booleanValue(system,["checkout","paymentsConfigured","checkoutEnabled","paymentsReady"])??booleanValue(data,["paymentsConfigured","checkoutEnabled"]);
      setService("paymentStatus",payments===true?"Live checkout configured":payments===false?"Checkout unavailable":"Status unavailable",payments===true?"good":payments===false?"bad":"warn");
      const webhook=booleanValue(system,["webhookProtection","webhookIpAllowlist","webhookProtected"])??booleanValue(data,["webhookIpAllowlist"]);
      setService("webhookStatus",webhook===true?"Source allowlist enabled":webhook===false?"IP allowlist disabled":"Status unavailable",webhook===true?"good":"warn");
      const appStore=booleanValue(system,["appStore"]),providers=Array.isArray(system.signInProviders)?system.signInProviders:null;
      setService("appStoreStatus",appStore===true?"Purchases verified":appStore===false?"Not configured":"Status unavailable",appStore===true?"good":"warn");
      setService("signInStatus",providers===null?"Status unavailable":providers.includes("google")?"On":"Off",providers?.includes("google")?"good":"warn");
    }
    // Signed-in counts lead because product decisions use them; anonymous counts sit beside them.
    function renderProductSignals(data){
      const object=(value)=>value&&typeof value==="object"?value:{},totals=object(data?.totals),anonymous=object(data?.anonymousTotals),fragment=document.createDocumentFragment();
      let total=0,anonymousTotal=0;
      for(const [name,label] of Object.entries(productSignalLabels)){
        const count=numberValue(totals[name],0),guests=numberValue(anonymous[name],0);total+=count;anonymousTotal+=guests;
        const row=create("div");row.append(create("dt","",label),create("dd","",`${formatCount(count)} signed in · ${formatCount(guests)} anonymous`));fragment.append(row);
      }
      el("productSignalRows").replaceChildren(fragment);
      const scope=data?.scope||{},since=cleanString(scope.sinceDay,"the selected start"),through=cleanString(scope.throughDay,"today");
      setSectionStatus("productSignalStatus",`${formatCount(total)} signed-in and ${formatCount(anonymousTotal)} anonymous action ${total+anonymousTotal===1?"count":"counts"} from ${since} through ${through}. Each action counts once per account or network per day; decide from the signed-in counts. Counts expire within ${formatCount(scope.retentionDays||90)} days.`);
    }
    // Today's Strata AI requests and tokens against the organization's daily budget; dashes when unavailable.
    function renderAiUsage(usage){
      const kind=(name)=>usage?.totals?.find((row)=>row?.kind===name)||{requests:0,tokens:0},chat=kind("chat"),brief=kind("brief"),show=(id,value)=>{el(id).textContent=usage?formatCount(value):"—";};
      show("aiChatRequestsStat",chat.requests);show("aiBriefRequestsStat",brief.requests);show("aiTokensStat",Number(chat.tokens)+Number(brief.tokens));show("aiRemainingStat",Math.max(0,Number(usage?.dailyRequests)-Number(chat.requests)-Number(brief.requests))||0);
    }
    function renderOverview(data){
      const stats=normalizedOverview(data),accounts=stats.accounts||stats,discovery=stats.discovery||stats,activation=stats.activation||stats,support=stats.support||stats;
      const values={
        totalUsersStat:[accounts,["total","totalUsers","total_users","users"]],verifiedUsersStat:[accounts,["verified","verifiedUsers","verified_users"]],
        discoveryUsersStat:[discovery,["activeUsers","active_users","discoveryUsers","discovery_users","activeDiscoveryUsers","discoveryActive"]],openSupportStat:[support,["open","openSupport","open_support","openTickets","supportOpen"]],
        suspendedUsersStat:[accounts,["suspended","suspendedUsers","suspended_users"]],activeSessionsStat:[accounts,["activeSessions","active_sessions"]],
        pendingPaymentsStat:[discovery,["pendingPayments","pending_payments"]],pendingDeletionsStat:[support,["pendingDeletions","pending_deletions"]],
        firstWorkoutAccountsStat:[activation,["firstWorkoutAccounts","first_workout_users"]],secondWorkoutAccountsStat:[activation,["secondWorkoutAccounts","second_workout_users"]],
        dayEightReturnAccountsStat:[activation,["dayEightReturnAccounts","day_eight_return_users"]],
        paidAccountsStat:[activation,["paidAccounts","paid_users"]],renewedSubscriptionsStat:[activation,["renewedSubscriptions","renewed_subscriptions"]]
      };
      for(const [id,[source,keys]] of Object.entries(values))el(id).textContent=overviewNumber(source,keys);
      const total=numberValue(firstValue(accounts,["total","totalUsers","total_users","users"],0)),verified=numberValue(firstValue(accounts,["verified","verifiedUsers","verified_users"],0));
      el("verifiedUsersNote").textContent=total>0?`${Math.round((verified/total)*100)}% of registered accounts`:"Confirmed accounts";
      renderSystemStatus(data);
    }
    function appendBadge(parent,label,tone=""){
      parent.append(create("span",`badge${tone?` ${tone}`:""}`,label));
    }
    function renderUsers(items,total,onOpen){
      const list=el("userResults");list.replaceChildren();
      for(const user of items){
        const item=create("li","record-card"),button=create("button");button.type="button";button.setAttribute("aria-label",`Open ${userName(user)}, ${userEmail(user)}`);
        const primary=create("div","record-primary");primary.append(create("span","",userId(user)||"Account"),create("strong","",userName(user)),create("p","",userEmail(user)));
        const meta=create("div","record-meta");appendBadge(meta,userVerified(user)?"Verified":"Unverified",userVerified(user)?"good":"warn");appendBadge(meta,discoveryActive(user)?"Strata+":"Free",discoveryActive(user)?"good":"");
        if(deletionPending(user))appendBadge(meta,"Deletion pending","bad");if(userSuspended(user))appendBadge(meta,"Suspended","bad");
        primary.append(meta);button.append(primary,create("span","record-arrow","→"));button.addEventListener("click",()=>onOpen(user,button));item.append(button);list.append(item);
      }
      const start=items.length?state.users.offset+1:0,end=state.users.offset+items.length;
      el("userResultCount").textContent=total?`Showing ${start}–${end} of ${total} accounts.`:"No matching accounts.";el("userEmpty").hidden=items.length!==0;
      el("previousUsers").disabled=state.users.offset===0;el("nextUsers").disabled=end>=total||items.length===0;
    }
    function addFact(container,label,value){
      const wrapper=create("div");wrapper.append(create("dt","",label),create("dd","",cleanString(value)));container.append(wrapper);
    }
    function setActionAvailability(user,{actionsReady=true}={}){
      const suspended=userSuspended(user),isSelf=userId(user)&&userId(user)===userId(state.admin||{});
      for(const button of document.querySelectorAll("[data-user-action]")){
        const action=button.dataset.userAction;let disabled=false,title="";
        if(action==="cancel-deletion"&&!deletionPending(user)){disabled=true;title="There is no active deletion request.";}
        if(action==="suspend"&&suspended){disabled=true;title="This account is already suspended.";}
        if(action==="restore"&&!suspended){disabled=true;title="This account is not suspended.";}
        if(action==="revoke-plus"&&!user?.discovery?.adminGrant?.active){disabled=true;title="No active complimentary grant.";}
        if(action==="enable-checkouts"&&!user?.checkoutBlocked){disabled=true;title="New payment sessions are already allowed.";}
        if(isSelf&&!["grant-plus","revoke-plus","close-checkouts","enable-checkouts"].includes(action)){disabled=true;title="Use Account Security for the sole administrator account.";}
        if(!actionsReady){disabled=true;title="Full account details are still loading.";}
        button.disabled=disabled;button.title=title;
      }
    }
    function renderUserDetails(user,{actionsReady=true}={}){
      state.selectedUser=user;el("userDialogTitle").textContent=userName(user);el("userDialogEmail").textContent=userEmail(user);
      const facts=el("userFacts");facts.replaceChildren();
      addFact(facts,"User ID",userId(user));addFact(facts,"Joined",formatDate(firstValue(user,["createdAt","created_at","joinedAt"])));addFact(facts,"Email status",userVerified(user)?"Verified":"Unverified");addFact(facts,"Account status",userSuspended(user)?"Suspended":"Active");addFact(facts,"Strata+",discoveryActive(user)?"Unlocked":"Not unlocked");
      const grant=user?.discovery?.adminGrant;
      addFact(facts,"Complimentary Strata+",grant?.active?(grant.expiresAt==null?"Until revoked":`Until ${formatDate(grant.expiresAt)}`):grant?.revokedAt?"Revoked":grant?.startedAt?"Expired":"None");
      addFact(facts,"New payment sessions",user.checkoutBlocked?"Blocked by admin":"Allowed");addFact(facts,"Purchase records",`${formatCount(firstValue(user?.discovery||{},["purchaseCount","purchase_count"],0))} total · ${formatCount(firstValue(user?.discovery||{},["pendingPurchaseCount","pending_purchase_count"],0))} pending`);
      addFact(facts,"Latest purchase activity",formatDate(firstValue(user?.discovery||{},["latestPurchaseAt","latest_purchase_at"],null)));for(const [label,value] of appleFacts(user))addFact(facts,label,value);addFact(facts,"Weekly plan",planSummary(user));addFact(facts,"Ratings",formatCount(firstValue(user,["ratingCount","rating_count","ratings"],0)));addFact(facts,"Active sessions",formatCount(firstValue(user,["activeSessions","activeSessionCount","active_session_count","sessions"],0)));addFact(facts,"Deletion request",deletionPending(user)?"Pending confirmation":"None");
      setActionAvailability(user,{actionsReady});
    }
    function renderSupport(items,total,onOpen){
      const list=el("supportResults");list.replaceChildren();
      for(const ticket of items){
        const item=create("li","record-card"),button=create("button");button.type="button";
        const reference=supportReference(ticket),subject=cleanString(firstValue(ticket,["subject","title"],""),"Support request"),email=cleanString(firstValue(ticket,["email","replyEmail","reply_email"],""),"Email unavailable");
        button.setAttribute("aria-label",`Open ${reference}: ${subject}`);
        const primary=create("div","record-primary");primary.append(create("span","",`${reference} · ${cleanString(firstValue(ticket,["category","type"],"General"))}`),create("strong","",subject),create("p","",`${email} · ${formatDate(firstValue(ticket,["updatedAt","updated_at","createdAt","created_at"]))}`));
        const meta=create("div","record-meta"),status=supportState(ticket,supportStates);appendBadge(meta,supportStateLabel(status),status==="resolved"?"good":status==="new"?"bad":"warn");if(firstValue(ticket,["userId","user_id"],null))appendBadge(meta,"Linked account","good");
        primary.append(meta);button.append(primary,create("span","record-arrow","→"));button.addEventListener("click",()=>onOpen(ticket,button));item.append(button);list.append(item);
      }
      const start=items.length?state.support.offset+1:0,end=state.support.offset+items.length;
      el("supportResultCount").textContent=total?`Showing ${start}–${end} of ${total} help requests.`:"No matching help requests.";el("supportEmpty").hidden=items.length!==0;
      el("previousSupport").disabled=state.support.offset===0;el("nextSupport").disabled=end>=total||items.length===0;
    }
    function renderAudit(entries){
      const list=el("auditResults");list.replaceChildren();
      for(const entry of entries){
        const item=create("li","audit-item"),header=create("div","audit-item-header");header.append(create("strong","",cleanString(firstValue(entry,["action","event","type"],"Admin action"))));
        const dateValue=firstValue(entry,["createdAt","created_at","timestamp","at"],null),time=create("time","",formatDate(dateValue));if(dateValue){const parsed=new Date(dateValue);if(!Number.isNaN(parsed.getTime()))time.dateTime=parsed.toISOString();}header.append(time);
        const actor=cleanString(firstValue(entry,["adminEmail","admin_email","actorEmail","actor_email"],firstValue(entry?.actor||{},["email","name","id"],"Administrator"))),target=cleanString(firstValue(entry,["targetEmail","target_email","targetId","target_id"],firstValue(entry?.target||{},["email","name","id"],"No target"))),result=cleanString(firstValue(entry,["result","outcome","status"],"Recorded"));
        item.append(header,create("p","",`${actor} → ${target}`));const reason=firstValue(entry,["reason","note"],"");if(reason)item.append(create("p","",cleanString(reason)));
        item.append(create("small","",`${result}${firstValue(entry,["requestId","request_id"],null)?` · ${cleanString(firstValue(entry,["requestId","request_id"]))}`:""}`));list.append(item);
      }
      el("auditEmpty").hidden=entries.length!==0;
    }
    function syncDialogLock(){document.body.classList.toggle("dialog-open",Boolean(document.querySelector("dialog[open]")));}
    function closeDialog(dialog,returnFocus){
      if(dialog.open)dialog.close();syncDialogLock();if(returnFocus&&document.contains(returnFocus))requestFrame(()=>returnFocus.focus());
    }
    function clearPrivateData(){
      const textIds=["userDialogTitle","userDialogEmail","userDetailStatus","userResultCount","usersStatus","supportDialogTitle","supportDialogIdentity","ticketMessage","supportUpdateMessage","supportResultCount","supportStatus","auditStatus","overviewStatus","productSignalStatus","confirmTitle","confirmDescription","confirmMessage","globalMessage"];
      const valueIds=["userQuery","ticketNote","ticketResponse"];
      const containerIds=["userResults","supportResults","auditResults","productSignalRows","userFacts","supportFacts"];
      clearTimeout(globalMessageTimer);globalMessageTimer=undefined;
      for(const id of textIds)el(id).textContent="";
      for(const id of valueIds)el(id).value="";
      for(const id of containerIds)el(id).replaceChildren();
      el("userDetailStatus").className="section-status";el("supportUpdateMessage").className="dialog-message";el("confirmMessage").className="dialog-message";
      el("supportUpdateMessage").hidden=true;el("confirmMessage").hidden=true;el("globalMessage").hidden=true;renderAiUsage(null);
    }
    function updateGrantFields(){
      const active=state.pendingAction==="grant-plus",unit=el("grantUnit").value,dated=unit==="until",unlimited=unit==="indefinite";
      el("grantAmountField").hidden=dated||unlimited;el("grantUntilField").hidden=!dated;el("grantAmount").required=active&&!dated&&!unlimited;el("grantUntil").required=active&&dated;
    }
    function openActionConfirmation(action,trigger,details){
      if(!details||!state.selectedUser)return;
      state.pendingAction=action;state.actionTrigger=trigger;el("confirmTitle").textContent=details.title;el("confirmDescription").textContent=`${details.description} Target: ${userEmail(state.selectedUser)}.`;
      el("submitAction").textContent=`${details.button||"Confirm action"} →`;el("grantFields").hidden=action!=="grant-plus";updateGrantFields();
      el("confirmMessage").hidden=true;el("confirmMessage").textContent="";el("confirmDialog").showModal();syncDialogLock();requestFrame(()=>el("cancelAction").focus());
    }
    function updateSupportSubmitLabel(){el("saveSupportUpdate").textContent=el("ticketResponse").value.trim().length>0?"Save and send response →":"Save update →";}
    function openSupportDialog(ticket,trigger){
      state.selectedTicket=ticket;state.supportDialogTrigger=trigger;el("supportDialogTitle").textContent=supportReference(ticket);
      el("supportDialogIdentity").textContent=`${cleanString(firstValue(ticket,["subject","title"],"Support request"))} · ${cleanString(firstValue(ticket,["email","replyEmail","reply_email"],"Email unavailable"))}`;
      const facts=el("supportFacts");facts.replaceChildren();addFact(facts,"Category",firstValue(ticket,["category","type"],"General"));addFact(facts,"Status",supportStateLabel(supportState(ticket,supportStates)));addFact(facts,"Created",formatDate(firstValue(ticket,["createdAt","created_at"])));addFact(facts,"Last updated",formatDate(firstValue(ticket,["updatedAt","updated_at"])));addFact(facts,"Linked user",firstValue(ticket,["userId","user_id"],"Not linked"));addFact(facts,"Paddle / reference",firstValue(ticket,["customerReference","transactionId","transaction_id","orderReference","order_reference","referenceId","reference_id"],"Not provided"));
      el("ticketMessage").textContent=cleanString(firstValue(ticket,["message","body"],""),"No message was provided.");el("ticketStatus").value=supportState(ticket,supportStates);el("ticketNote").value=cleanString(firstValue(ticket,["note","adminNote","admin_note"],""),"");el("ticketResponse").value="";updateSupportSubmitLabel();el("supportUpdateMessage").hidden=true;el("supportUpdateMessage").textContent="";
      el("supportDialog").showModal();syncDialogLock();requestFrame(()=>el("supportDialogTitle").focus({preventScroll:true}));
    }

    return{addFact,clearPrivateData,closeDialog,create,el,openActionConfirmation,openSupportDialog,renderAiUsage,renderAudit,renderOverview,renderProductSignals,renderSupport,renderUserDetails,renderUsers,setActionAvailability,setBusy,setLastUpdated,setSectionStatus,showGlobal,syncDialogLock,updateGrantFields,updateSupportSubmitLabel};
  }

  return{createRenderer};
});
