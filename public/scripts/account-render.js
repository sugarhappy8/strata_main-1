/* global module, require */
(function(root,factory){
  const logic=typeof module==="object"&&module.exports?require("./account-logic"):root.StrataAccountLogic;
  const api=factory(logic);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAccountRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(logic){
  "use strict";

  function createRenderer({documentImpl=globalThis.document,frame=globalThis.requestAnimationFrame,now=()=>new Date() }={}){
    const el=(id)=>documentImpl.getElementById(id);

    function clearFormError(authMode){
      const message=el(`${authMode}Message`);
      message.hidden=true;message.textContent="";
      const fields=authMode==="signup"?[el("signupName"),el("signupEmail"),el("signupPassword")]:[el("loginEmail"),el("loginPassword")];
      fields.forEach((field)=>field.removeAttribute("aria-invalid"));
    }

    function clearAllFormErrors(){clearFormError("signup");clearFormError("login");}

    function setButtonBusy(button,busy,label=""){
      if(!button)return;
      if(busy){button.dataset.busy="true";if(label)button.setAttribute("aria-label",label);}
      else{delete button.dataset.busy;button.removeAttribute("aria-label");}
    }

    function showFormError(authMode,message,{status,focus=false}={}){
      const node=el(`${authMode}Message`);node.textContent=message;node.hidden=false;
      if(status===401&&authMode==="login")[el("loginEmail"),el("loginPassword")].forEach((field)=>field.setAttribute("aria-invalid","true"));
      if(status===409&&authMode==="signup")el("signupEmail").setAttribute("aria-invalid","true");
      if(focus)(frame||((callback)=>callback()))(()=>node.focus({preventScroll:false}));
    }

    function showRequestedPanel({requestedMode,preferredPanel}){
      if(requestedMode!=="login"&&requestedMode!=="signup")return;
      (frame||((callback)=>callback()))(()=>{preferredPanel.scrollIntoView?.({block:"start"});el(`${requestedMode}Title`).focus({preventScroll:true});});
    }

    function clearPrivateData(){
      const textIds=["accountGreeting","signedInIdentity","accountPrimaryLabel","accountNextEyebrow","accountNextTitle","accountNextDetail","accountNextMovements","accountNextSets","accountWeekScore","accountWeekDetail","accountWinsEmpty","accountAdaptationTitle","accountAdaptationDetail","accountPlanCount","accountWorkoutDays","accountAccessState","accountAccessDetail","accountMemberSince","accountDiscoveryStatus","accountBillingTitle","accountBillingBadge","accountBillingDetail","accountBillingStatus","accountSessionStatus","accountExportStatus","signedInMessage","accountDiscoveryAction","accountSecurityStatus"];
      for(const id of textIds)el(id).textContent="";
      for(const id of ["accountWeekDays","accountWinsList","accountSessionList"])el(id).innerHTML="";
      const progress=el("accountWeekProgress");progress.hidden=true;progress.value=0;progress.max=1;progress.textContent="";
      for(const id of ["signedInCard","accountNextMetrics","accountWinsList","accountWinsEmpty","accountBilling","signedInMessage","accountAdminAction","accountDeleteCancel","accountRevokeOtherSessions","accountManageSubscription","accountUpdatePayment","accountCancelSubscription"])el(id).hidden=true;
      for(const id of ["accountRevokeOtherSessions","accountManageSubscription","accountUpdatePayment","accountCancelSubscription","accountExportData","accountPasswordReset","accountDeleteRequest","accountDeleteCancel","accountLogout"]){const node=el(id);node.disabled=false;setButtonBusy(node,false);}
      el("accountRevokeOtherSessions").disabled=true;el("accountSessionList").setAttribute("aria-busy","false");el("signedInCard").setAttribute("aria-busy","false");
      for(const id of ["accountBillingStatus","accountSessionStatus","accountExportStatus","accountSecurityStatus"])el(id).classList.remove("bad");
      el("accountPrimaryAction").href="/planner.html";el("accountDiscoveryAction").href="/pricing";documentImpl.body?.classList.remove("account-signed-in");
    }

    function showAccess({message="",mode,requestedMode,preferredPanel}){
      clearPrivateData();el("accountLoading").hidden=true;el("accountAccess").hidden=false;el("accountPage").setAttribute("aria-busy","false");
      if(message)showFormError(mode,message,{focus:true});
      else showRequestedPanel({requestedMode,preferredPanel});
    }

    function renderWeekRail(plan,completedDays,week,{completionKnown}){
      el("accountWeekDays").innerHTML=logic.WEEKDAYS.map((day,index)=>{
        const scheduled=plan.days[day].length>0,complete=completionKnown&&scheduled&&completedDays.has(day),today=index===week.todayIndex;
        const state=complete?"complete":scheduled?"scheduled":"recovery",description=complete?"completed":scheduled?completionKnown?"planned":"scheduled":"recovery";
        return `<li class="${state}${today?" today":""}"${today?' aria-current="date"':""} aria-label="${day}, ${description}${today?", today":""}"><span>${day.slice(0,3)}</span><i aria-hidden="true">${complete?"✓":scheduled?"•":"—"}</i></li>`;
      }).join("");
    }

    function renderWins(workouts,hasMore){
      const completed=workouts.filter((workout)=>workout?.status==="completed"),latest=completed.slice().sort((a,b)=>Number(b.startedAt||0)-Number(a.startedAt||0))[0],records=logic.recentRecords(workouts,hasMore),wins=[];
      if(latest)wins.push({title:"Session complete",detail:`${String(latest.title||"Workout")} · ${logic.readableDate(latest.date)} · ${Math.max(0,Number(latest.completedSets)||0)} completed sets`});
      for(const record of records)wins.push({title:record.exercise,detail:`${record.scope} · ${record.label} ${record.value} · ${logic.readableDate(record.date)}`});
      const list=el("accountWinsList"),empty=el("accountWinsEmpty");
      if(!wins.length){list.hidden=true;list.innerHTML="";empty.hidden=false;empty.textContent="Complete a session to start a private, saved progress trail.";return records;}
      list.innerHTML=wins.map((win,index)=>`<li><span aria-hidden="true">${index===0?"✓":"↑"}</span><div><strong>${logic.escapeHtml(win.title)}</strong><small>${logic.escapeHtml(win.detail)}</small></div></li>`).join("");
      list.hidden=false;empty.hidden=true;return records;
    }

    function renderDashboard(plan,user,{workouts=null,hasMore=false,historyError=false}={}){
      const summary=logic.planSummary(plan),week=logic.weekContext(now()),historyAvailable=Array.isArray(workouts),weekWorkouts=historyAvailable?logic.completedThisWeek(workouts,week):[];
      const completedDays=new Set(weekWorkouts.map((workout)=>String(workout.planDay||"")).filter((day)=>summary.scheduled.includes(day))),active=historyAvailable?workouts.find((workout)=>workout?.status==="active"):null;
      const discoveryActive=user?.discovery?.active===true,historyLoading=discoveryActive&&!historyAvailable&&!historyError;
      el("accountPlanCount").textContent=String(summary.movements);el("accountWorkoutDays").textContent=String(summary.scheduled.length);
      renderWeekRail(plan,completedDays,week,{completionKnown:historyAvailable});

      const progress=el("accountWeekProgress"),weekSets=weekWorkouts.reduce((total,workout)=>total+Math.max(0,Number(workout.completedSets)||0),0);
      if(historyAvailable&&summary.scheduled.length){
        progress.hidden=false;progress.max=summary.scheduled.length;progress.value=Math.min(completedDays.size,summary.scheduled.length);progress.textContent=`${Math.round(progress.value/progress.max*100)}%`;
        el("accountWeekScore").textContent=`${progress.value}/${progress.max}`;
        el("accountWeekDetail").textContent=progress.value===progress.max?`Week complete: ${weekWorkouts.length} saved ${weekWorkouts.length===1?"session":"sessions"} and ${weekSets} completed ${weekSets===1?"set":"sets"}.`:`${weekWorkouts.length} saved ${weekWorkouts.length===1?"session":"sessions"} and ${weekSets} completed ${weekSets===1?"set":"sets"} this week.`;
      }else{
        progress.hidden=true;progress.value=0;progress.max=Math.max(1,summary.scheduled.length);
        el("accountWeekScore").textContent=summary.scheduled.length?`${summary.scheduled.length} ${summary.scheduled.length===1?"day":"days"}`:"No plan";
        el("accountWeekDetail").textContent=!summary.scheduled.length?"No training days are scheduled yet.":historyLoading?"Checking your saved completion history…":historyError?"Completion history could not be loaded. Your saved schedule is still shown.":"Your weekly structure is ready. Completion history is available in the Strata+ workout room.";
      }

      const primary=el("accountPrimaryAction"),primaryLabel=el("accountPrimaryLabel"),nextTitle=el("accountNextTitle"),nextDetail=el("accountNextDetail"),nextEyebrow=el("accountNextEyebrow"),nextMetrics=el("accountNextMetrics");nextMetrics.hidden=true;
      if(active){
        nextEyebrow.textContent="Workout in progress";nextTitle.textContent=String(active.title||"Open workout");nextDetail.textContent=`Started ${logic.readableDate(active.date)} · ${Math.max(0,Number(active.completedSets)||0)} of ${Math.max(0,Number(active.totalSets)||0)} sets completed.`;
        primary.href=`/workout.html#resume=${encodeURIComponent(active.id)}`;primaryLabel.textContent="Continue workout";
      }else if(!summary.scheduled.length){
        nextEyebrow.textContent="Start here";nextTitle.textContent="Build a week you can repeat.";nextDetail.textContent="Choose your training days and movements before tracking progress.";primary.href=discoveryActive?"/onboarding.html":"/planner.html";primaryLabel.textContent="Build your week";
      }else{
        const next=logic.nextPlannedDay(plan,completedDays,week),movements=next?.items.length||0,sets=(next?.items||[]).reduce((total,item)=>total+Math.max(0,Math.round(Number(item?.sets)||0)),0);
        const when=next?.offset===0?"Today":next?.offset===1?"Tomorrow":next?.offset>=7?`Next ${next.day}`:next?.day||"Next up";
        nextEyebrow.textContent=`${when} · ${next?new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(next.date):""}`;nextTitle.textContent=next?.day?`${next.day} workout`:"Next workout";
        nextDetail.textContent=historyLoading?"Your plan is ready while STRATA checks saved completion history.":historyError?"Your plan is ready. Completion history is temporarily unavailable.":`${movements} ${movements===1?"movement":"movements"} in your saved plan.`;
        el("accountNextMovements").textContent=String(movements);el("accountNextSets").textContent=String(sets);nextMetrics.hidden=false;
        primary.href=discoveryActive?`/workout.html?day=${encodeURIComponent(next.day)}`:"/planner.html";primaryLabel.textContent=discoveryActive?"Open next workout":"Open your week";
      }

      const winsEmpty=el("accountWinsEmpty"),winsList=el("accountWinsList");let records=[];
      if(historyAvailable)records=renderWins(workouts,hasMore)||[];
      else{winsList.hidden=true;winsList.innerHTML="";winsEmpty.hidden=false;winsEmpty.textContent=historyLoading?"Loading recent saved sessions…":historyError?"Recent session history could not be loaded. Nothing was changed.":"Workout history is not available in this account view. Your saved plan is still ready.";}

      const adaptationTitle=el("accountAdaptationTitle"),adaptationDetail=el("accountAdaptationDetail");
      if(!summary.scheduled.length){adaptationTitle.textContent="Start with a repeatable week.";adaptationDetail.textContent="A stable schedule makes future session comparisons meaningful. STRATA will not infer readiness from a plan alone.";}
      else if(historyLoading){adaptationTitle.textContent="Build a clean baseline.";adaptationDetail.textContent="STRATA is checking repeat movements in your saved sessions. Recovery and form are never guessed from set totals.";}
      else if(historyError||!discoveryActive){adaptationTitle.textContent="Your week has a shape.";adaptationDetail.textContent=`${summary.scheduled.length} planned ${summary.scheduled.length===1?"day gives":"days give"} you a repeatable structure. No training adaptation is claimed without comparable session data.`;}
      else if(active){adaptationTitle.textContent="Finish the open session.";adaptationDetail.textContent="An in-progress workout is the clearest next signal. Finish or close it before changing the week.";}
      else if(!weekWorkouts.length&&!workouts.some((workout)=>workout?.status==="completed")){adaptationTitle.textContent="Create the first data point.";adaptationDetail.textContent="Complete one saved workout. A repeat in the same movement format and unit will make progress comparable.";}
      else if(records.length){adaptationTitle.textContent="Progress is moving.";adaptationDetail.textContent=`${records.length} repeat ${records.length===1?"movement exceeded":"movements exceeded"} an earlier saved result. Keep the format and unit consistent; recovery and form are not measured here.`;}
      else if(summary.scheduled.length&&completedDays.size===summary.scheduled.length){adaptationTitle.textContent="Your schedule is complete.";adaptationDetail.textContent="Every planned day has a saved completion this week. Review recovery and notes before changing volume; this dashboard does not measure readiness.";}
      else{adaptationTitle.textContent="Keep the comparison clean.";adaptationDetail.textContent="Repeat key movements in the same format and unit. STRATA will surface a saved result only when it exceeds an earlier comparable session.";}
    }

    function renderDashboardUnavailable(){
      el("accountNextEyebrow").textContent="Saved week unavailable";el("accountNextTitle").textContent="Your account is still safe.";el("accountNextDetail").textContent="STRATA could not load your plan right now. Refresh or open My Plan to retry.";el("accountNextMetrics").hidden=true;
      el("accountWeekScore").textContent="—";el("accountWeekProgress").hidden=true;el("accountWeekDetail").textContent="Weekly progress could not be loaded.";el("accountWeekDays").innerHTML="";
      el("accountWinsList").hidden=true;el("accountWinsList").innerHTML="";el("accountWinsEmpty").hidden=false;el("accountWinsEmpty").textContent="Recent activity could not be loaded. Nothing was changed.";
      el("accountAdaptationTitle").textContent="Keep your current plan.";el("accountAdaptationDetail").textContent="There is not enough verified data to suggest a training change right now.";el("accountPrimaryAction").href="/planner.html";el("accountPrimaryLabel").textContent="Open My Plan";
    }

    function renderAccountBilling(user){
      const section=el("accountBilling"),subscription=logic.subscriptionFor(user),grandfathered=logic.grandfatheredAccess(user);section.hidden=!subscription&&!grandfathered;
      el("accountBillingStatus").textContent="";el("accountBillingStatus").classList.remove("bad");if(section.hidden)return;
      const manage=el("accountManageSubscription"),update=el("accountUpdatePayment"),cancel=el("accountCancelSubscription");manage.hidden=grandfathered;update.hidden=true;cancel.hidden=true;
      if(grandfathered){el("accountBillingTitle").textContent="Lifetime access";el("accountBillingBadge").textContent="Grandfathered";el("accountBillingDetail").textContent="Your prior lifetime purchase remains active under its original terms. It has no monthly renewal and does not need a subscription.";return;}
      const status=String(subscription.status||""),scheduled=subscription.scheduledChange;el("accountBillingTitle").textContent="Monthly subscription";
      el("accountBillingBadge").textContent=status==="paused"?"Paused":status==="canceled"?"Canceled":subscription.active!==true?"Inactive":scheduled?.action==="cancel"?"Canceling":scheduled?.action==="pause"?"Pausing":status==="past_due"?"Past due":status.charAt(0).toUpperCase()+status.slice(1);
      if(status==="paused")el("accountBillingDetail").textContent="Paid access is inactive while this subscription is paused. Open Paddle to review resumption or cancellation options.";
      else if(status==="canceled")el("accountBillingDetail").textContent="This subscription is canceled, paid access is inactive, and there are no future renewals. Your free Plan remains available.";
      else if(subscription.active!==true)el("accountBillingDetail").textContent="Paid access is inactive because the last verified billing period or scheduled access window has ended. Open Paddle to review its current state.";
      else if(scheduled?.action==="cancel")el("accountBillingDetail").textContent=`Cancellation takes effect ${logic.billingDate(scheduled.effectiveAt)}. Access remains available until then, with no renewal afterward.`;
      else if(scheduled?.action==="pause")el("accountBillingDetail").textContent=`The subscription pauses ${logic.billingDate(scheduled.effectiveAt)}. Access remains available until then and stops when the pause takes effect.`;
      else if(status==="past_due")el("accountBillingDetail").textContent="Paddle could not collect the latest monthly payment. Update the payment method to avoid losing Strata+ access.";
      else el("accountBillingDetail").textContent=`Your monthly subscription is active. The next renewal is ${logic.billingDate(subscription.currentPeriodEndsAt)} unless you cancel.`;
      update.hidden=status!=="past_due";cancel.hidden=status==="canceled"||scheduled?.action==="cancel";
    }

    function showSecurityStatus(message,{error=false}={}){const status=el("accountSecurityStatus");status.textContent=message;status.classList.remove("bad");if(error)status.classList.add("bad");}

    function showSignedIn(user){
      documentImpl.body?.classList.add("account-signed-in");el("accountLoading").hidden=true;el("accountAccess").hidden=true;el("signedInCard").hidden=false;el("signedInCard").setAttribute("aria-busy","true");el("signedInIdentity").textContent=`${user.name} · ${user.email}`;
      const firstName=String(user?.name||"").trim().split(/\s+/)[0]||"there",hour=now().getHours();el("accountGreeting").textContent=`Good ${hour<12?"morning":hour<18?"afternoon":"evening"}, ${firstName}`;
      const planCount=Math.max(0,Number(user?.planCount)||0),workoutDays=Math.max(0,Number(user?.workoutDays)||0);el("accountPlanCount").textContent=String(planCount);el("accountWorkoutDays").textContent=String(workoutDays);
      const createdAt=Number(user?.createdAt),createdDate=Number.isFinite(createdAt)&&createdAt>0?new Date(createdAt):null;el("accountMemberSince").textContent=createdDate&&!Number.isNaN(createdDate.getTime())?new Intl.DateTimeFormat(undefined,{month:"short",year:"numeric"}).format(createdDate):"Member";
      el("accountAdminAction").hidden=user?.isAdmin!==true;
      const discoveryActive=user?.discovery?.active===true,discoveryPending=Number(user?.discovery?.pendingPurchaseCount||0)>0,subscription=logic.subscriptionFor(user),access=logic.accountAccessSummary(user,discoveryPending);
      const discoveryAction=el("accountDiscoveryAction"),managedInactive=Boolean(subscription)&&!discoveryActive&&subscription?.status!=="canceled";
      discoveryAction.href=discoveryActive?"/discover.html":managedInactive?"#accountBilling":"/pricing";discoveryAction.textContent=discoveryActive?"Open Strata+ studio →":managedInactive?"Manage Strata+ billing →":subscription?.status==="canceled"?"Restart Strata+ →":discoveryPending?"Check Strata+ subscription →":"Unlock Strata+ →";
      el("accountDiscoveryStatus").textContent=access.message;el("accountAccessState").textContent=access.state;el("accountAccessDetail").textContent=access.detail;renderAccountBilling(user);
      el("accountPrimaryAction").href=planCount>0?(discoveryActive?"/workout.html":"/planner.html"):discoveryActive?"/onboarding.html":"/planner.html";el("accountPrimaryLabel").textContent=planCount>0?(discoveryActive?"Start training":"Open your week"):"Build your week";
      const deletionPending=user?.accountDeletion?.pending===true;el("accountDeleteCancel").hidden=!deletionPending;showSecurityStatus(deletionPending?"An account-deletion confirmation is pending. You can use the emailed link or cancel the request here.":"");el("accountPage").setAttribute("aria-busy","false");
    }

    function showChangedAccount(){
      clearPrivateData();el("accountAccess").hidden=true;el("accountLoading").hidden=false;el("accountLoadingTitle").textContent="Account access changed.";
      el("accountLoadingMessage").textContent="The signed-in account or its security boundary changed. Reload to open the current account without mixing private training data.";el("accountReload").hidden=false;el("accountPage").setAttribute("aria-busy","false");
    }

    function showAccountControlStatus(id,message,{error=false,focus=false}={}){const status=el(id);status.textContent=message;status.classList.remove("bad");if(error)status.classList.add("bad");if(focus)status.focus({preventScroll:false});}

    function renderAccountSessions(sessions){
      const list=el("accountSessionList"),others=sessions.filter((session)=>session?.current!==true);
      list.innerHTML=sessions.map((session)=>{const current=session?.current===true,id=logic.escapeHtml(session?.id||"");return `<li><div><strong>${current?"This session":"Other session"}</strong><small>Signed in ${logic.escapeHtml(logic.sessionDate(session?.createdAt))} · Expires ${logic.escapeHtml(logic.sessionDate(session?.expiresAt))}</small></div>${current?'<span class="account-current-session">Current</span>':`<button type="button" data-revoke-session="${id}" aria-label="Sign out session created ${logic.escapeHtml(logic.sessionDate(session?.createdAt))}">Sign out</button>`}</li>`;}).join("")||'<li class="account-session-loading">No active sessions were found. Refresh this page before making account changes.</li>';
      list.setAttribute("aria-busy","false");const revokeAll=el("accountRevokeOtherSessions");revokeAll.disabled=others.length===0;revokeAll.hidden=others.length===0;
    }

    function showSessionLoading(){const list=el("accountSessionList");list.setAttribute("aria-busy","true");list.innerHTML='<li class="account-session-loading">Checking active sessions…</li>';el("accountRevokeOtherSessions").disabled=true;}
    function showSessionError(){const list=el("accountSessionList");list.setAttribute("aria-busy","false");list.innerHTML='<li class="account-session-loading">Active sessions could not be loaded. Nothing was changed.</li>';showAccountControlStatus("accountSessionStatus","Could not load signed-in sessions. Refresh to try again.",{error:true});}
    function renderStorageState(node,state,message){node.classList.remove("good","warn","bad");node.classList.add(state);node.querySelector("span").textContent=message;}
    function showInitialLoading(){el("accountPage").setAttribute("aria-busy","true");el("accountAccess").hidden=true;el("signedInCard").hidden=true;el("accountLoading").hidden=false;el("accountLoadingTitle").textContent="CHECKING YOUR ACCOUNT…";el("accountLoadingMessage").textContent="Confirming whether you are already signed in.";el("accountReload").hidden=true;}

    return{el,clearFormError,clearAllFormErrors,clearPrivateData,setButtonBusy,showFormError,showAccess,renderDashboard,renderDashboardUnavailable,renderAccountBilling,showSecurityStatus,showSignedIn,showChangedAccount,showAccountControlStatus,renderAccountSessions,showSessionLoading,showSessionError,renderStorageState,showInitialLoading};
  }

  return{createRenderer};
});
