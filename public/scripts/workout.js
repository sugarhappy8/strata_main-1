(function(){
  "use strict";
  const W=globalThis.StrataWorkout;
  const G=globalThis.StrataDiscovery;
  const S=globalThis.StrataWorkoutState;
  const A=globalThis.StrataWorkoutApi;
  const R=globalThis.StrataWorkoutRender;
  const T=globalThis.StrataWorkoutContext;
  const E=globalThis.StrataWorkoutEvents;
  const C=globalThis.StrataWorkoutCalendar;
  const H=globalThis.StrataWorkoutHistory;
  const Q=globalThis.StrataWorkoutGuidance,P=globalThis.StrataWorkoutProgression;
  const $=(id)=>document.getElementById(id);
  const signal=name=>globalThis.StrataSignals?.record?.(name);
  const state=S.create(W,location);
  const view=R.create({state,workout:W,discovery:G,nextTarget:entry=>progression.targetFor(entry)});
  const {esc,number,exercise,formatLabel,hasActuals,memoryFor}=view;
  const saveError=S.saveError;
  function toast(message){
    $("workoutToast").textContent=message;$("workoutToast").classList.add("is-visible");
    clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>$("workoutToast").classList.remove("is-visible"),5000);
  }
  function status(message,kind=""){ $("saveStatus").textContent=message;$("saveStatus").dataset.state=kind; }
  function errorMessage(message){$("sessionError").textContent=message;$("sessionError").hidden=!message;}
  function owner(){return `account:${state.user.id}`;}
  function authorizeOffline(discovery){state.offlineAccessUntil=W.offlineAccessUntil(discovery);}
  function writeOfflineContext(draftKey=state.draftKey){
    if(state.mode!=="account"||state.blocked||!state.ownerId||!draftKey||state.offlineAccessUntil<=Date.now())return;
    try{localStorage.setItem(S.OFFLINE_CONTEXT_KEY,JSON.stringify({version:1,userId:String(state.user.id),ownerId:state.ownerId,contextId:state.contextId,draftKey,authorizedAt:Date.now(),authorizedUntil:state.offlineAccessUntil}));}
    catch{/* The normal account save still works when offline continuation storage is unavailable. */}
  }
  function clearOfflineContext(draftKey=state.draftKey){
    try{const current=JSON.parse(localStorage.getItem(S.OFFLINE_CONTEXT_KEY)||"null");if(!draftKey||current?.draftKey===draftKey)localStorage.removeItem(S.OFFLINE_CONTEXT_KEY);}
    catch{/* A malformed or blocked context cannot authorize the offline shell. */}
  }
  function restorePreferences(){
    try{
      const saved=S.readPreferences(localStorage.getItem(S.PREFERENCE_KEY));
      if(typeof saved.autoRest==="boolean")$("autoRest").checked=saved.autoRest;
      if(saved.restDuration)$("restDuration").value=String(saved.restDuration);
    }catch{/* Keep the visible defaults when browser preferences are unavailable. */}
  }
  function rememberPreferences(){
    try{localStorage.setItem(S.PREFERENCE_KEY,S.writePreferences($("autoRest").checked,$("restDuration").value));}
    catch{/* Preferences are optional; workout recovery uses a separate guarded path. */}
  }
  async function api(path,options={}){
    return client.request(path,options);
  }
  function blockSession(){
    state.blocked=true;progression.reset();clearTimeout(state.saveTimer);persistDraft();
    document.body.classList.remove("has-workout-access");
    clearOfflineContext();
    $("trainingRoom").hidden=true;$("historySection").hidden=true;$("recoveryPanel").hidden=true;$("conflictPanel").hidden=true;
    $("modeNotice").textContent="Your account session changed. Your draft belongs to the original account and has been kept on this device where storage is available.";
    $("loadError").hidden=false;$("loadErrorMessage").textContent="Reload the workout room to use the current account. Sign in to the original account to recover its draft. Account sessions never switch into guest mode automatically.";
    $("retryLoad").textContent="Reload workout room";
    if($("detailDialog").open)$("detailDialog").close();
    if($("finishDialog").open)$("finishDialog").close();
    if($("swapDialog").open)$("swapDialog").close();
  }
  function blockAccess(){
    state.blocked=true;progression.reset();clearTimeout(state.saveTimer);persistDraft();
    document.body.classList.remove("has-workout-access");
    clearOfflineContext();
    $("trainingRoom").hidden=true;$("historySection").hidden=true;$("recoveryPanel").hidden=true;$("conflictPanel").hidden=true;$("accessPanel").hidden=false;
    $("modeNotice").textContent="Strata+ access ended. Saved sessions and device drafts are kept; your free Plan is unchanged.";
    if($("detailDialog").open)$("detailDialog").close();if($("finishDialog").open)$("finishDialog").close();if($("swapDialog").open)$("swapDialog").close();
  }
  const client=A.create({state,onSessionBlocked:blockSession,onAccessBlocked:blockAccess,onIdentity:(current)=>{authorizeOffline(current.user.discovery);writeOfflineContext();}});
  async function assertIdentity(){
    return client.assertIdentity();
  }
  async function accountRead(path){
    return client.accountRead(path);
  }
  function persistDraft(){
    if(!state.workout||!state.ownerId)return true;
    if(state.workout.status==="completed"&&!state.dirty){removeDraft();return true;}
    if(!state.draftKey)state.draftKey=`${W.draftPrefix(state.ownerId)}${state.contextId}:${state.workout.id}`;
    const record={ownerId:state.ownerId,contextId:state.contextId,workout:state.workout,dirty:state.dirty,pausedSeconds:state.pausedSeconds,savedAt:Date.now()};
    try{localStorage.setItem(state.draftKey,JSON.stringify(record));writeOfflineContext(state.draftKey);return true;}
    catch{return false;}
  }
  function removeDraft(key=state.draftKey){try{if(key)localStorage.removeItem(key);clearOfflineContext(key);}catch{/* Keep the in-memory session when storage is unavailable. */}}
  function scanDrafts(){
    const items=[],staleKeys=[];
    try{
      const prefix=W.draftPrefix(state.ownerId);
      for(let index=0;index<localStorage.length;index++){
        const key=localStorage.key(index);
        if(!key?.startsWith(prefix))continue;
        const record=W.readDraft(localStorage.getItem(key),state.ownerId);
        if(record?.dirty)items.push({...record,key});
        else if(record?.workout?.status==="completed")staleKeys.push(key);
      }
      staleKeys.forEach((key)=>localStorage.removeItem(key));
    }catch{toast("Device draft recovery is unavailable in this browser. Keep this tab open until your session is saved.");}
    state.recoveries=items.sort((a,b)=>b.savedAt-a.savedAt);
    renderRecovery();renderPlan();historyView.render();
  }
  function renderRecovery(){
    $("recoveryPanel").hidden=!state.recoveries.length||!!state.workout||state.blocked;
    $("recoveryList").innerHTML=state.recoveries.map((record,index)=>{
      const counts=W.progress(record.workout);
      return `<div class="recovery-item"><div><strong>${esc(record.workout.title)}</strong><small>${esc(record.workout.date)} · ${counts.completed}/${counts.total} sets · ${record.dirty?"Unsaved device changes":"Previously saved session"}</small></div><div class="actions"><button class="button secondary compact" data-recover="${index}" type="button">Review &amp; recover</button><button class="button quiet compact" data-discard="${index}" type="button">Remove device draft</button></div></div>`;
    }).join("");
  }
  function selectWorkout(workout,{dirty=false,pausedSeconds=null}={}){
    progression.reset();state.workout=W.normalizeWorkout(workout);state.dirty=dirty;state.sequence++;state.conflict=null;
    state.memoryError="";state.memoryReady=memoryReadyFor(state.workout);
    state.pausedSeconds=Number.isFinite(pausedSeconds)&&pausedSeconds>0?Math.min(3600,pausedSeconds):null;
    state.draftKey=`${W.draftPrefix(state.ownerId)}${state.contextId}:${workout.id}`;
    state.timerAnnounced=false;
    $("conflictPanel").hidden=true;$("celebration").hidden=true;$("recoveryPanel").hidden=true;
    $("startPanel").hidden=true;$("sessionPanel").hidden=false;
    errorMessage("");renderSession();persistDraft();
    status(dirty?"Sync pending":"Synced",dirty?"error":"saved");
    $("sessionTitle").focus();
    if(!state.memoryReady)void loadWorkoutMemory(state.workout.id);
  }
  async function fetchWorkout(id){
    return client.fetchWorkout(id);
  }
  async function recover(index){
    const record=state.recoveries[index];if(!record||state.saving||state.workout)return;
    const buttons=[...$("recoveryList").querySelectorAll("button")];buttons.forEach((button)=>button.disabled=true);
    try{
      const latest=await fetchWorkout(record.workout.id);
      if(state.blocked)return;
      if(!record.dirty&&latest){
        if(latest.status==="completed"){removeDraft(record.key);scanDrafts();await historyView.openDetail(latest.id);return;}
        selectWorkout(latest,{pausedSeconds:latest.revision===record.workout.revision?record.pausedSeconds:null});
      }else{
        selectWorkout(record.workout,{dirty:!!record.dirty,pausedSeconds:record.pausedSeconds});
        if(latest&&latest.revision!==record.workout.revision)showConflict(latest);
        else if(!latest&&record.workout.revision)showConflict(null,"This session was removed from saved history. Keep your draft by explicitly saving it as a new session.");
        else if(latest&&W.matches(latest,record.workout)){state.workout.revision=latest.revision;state.dirty=false;status("Synced","saved");persistDraft();}
      }
      if(persistDraft()&&record.key!==state.draftKey)removeDraft(record.key);
    }catch(error){toast(saveError(error));}
    finally{buttons.forEach((button)=>button.disabled=false);}
  }
  function renderPlan(){contextView.render();}
  function memoryReadyFor(workout){return !workout||state.memoryExhausted||workout.entries.every((entry)=>memoryFor(entry));}
  function mergeMemory(items){state.memoryHistory=[...new Map([...state.memoryHistory,...items].map((item)=>[item.id,item])).values()].sort((a,b)=>b.startedAt-a.startedAt);}
  async function loadWorkoutMemory(workoutId){
    if(state.memoryBusy||state.blocked||state.workout?.id!==workoutId||memoryReadyFor(state.workout))return;
    state.memoryBusy=true;state.memoryError="";state.memoryReady=false;renderSession();
    let offset=0,hasMore=true;
    try{
      while(hasMore&&state.workout?.id===workoutId&&!memoryReadyFor(state.workout)){
        const result=await accountRead(`/api/workouts?limit=100&offset=${offset}&memory=1`);
        if(!Array.isArray(result.workouts)||typeof result.hasMore!=="boolean"||!result.workouts.length&&result.hasMore)throw new Error("Workout Memory received an incomplete history page.");
        mergeMemory(result.workouts);offset+=result.workouts.length;hasMore=result.hasMore;
        if(!hasMore)state.memoryExhausted=true;
      }
      if(state.workout?.id===workoutId)state.memoryReady=memoryReadyFor(state.workout);
    }catch(error){
      if(state.workout?.id===workoutId){state.memoryReady=false;state.memoryError=saveError(error);}
    }finally{
      state.memoryBusy=false;
      if(state.workout?.id===workoutId)renderSession();
      else if(state.workout&&!memoryReadyFor(state.workout))void loadWorkoutMemory(state.workout.id);
    }
  }
  function renderSession(){
    const workout=state.workout;if(!workout)return;state.memoryReady=memoryReadyFor(workout);
    $("sessionTitle").textContent=workout.title;$("sessionDate").textContent=`${workout.date} · ${workout.planDay||"Training"}${workout.status==="completed"?" · awaiting save":""}`;
    $("sessionEntries").innerHTML=workout.entries.map(view.renderEntry).join("");
    updateSessionMeta();tick();if(workout.status==="active"){if(state.memoryReady)void progression.load(workout.id);else if(!state.memoryBusy&&!state.memoryError)void loadWorkoutMemory(workout.id);}
  }
  function updateSessionMeta(){
    if(!state.workout)return;
    const counts=W.progress(state.workout);
    $("progressCount").textContent=`${counts.completed} / ${counts.total} sets`;
    const next=W.nextIncompleteSet(state.workout),nextEntry=next?state.workout.entries[next.entryIndex]:null;
    $("progressLabel").textContent=counts.percent===100?"Every planned set is logged.":next?`Next: ${exercise(nextEntry.exerciseId).name} · set ${next.setIndex+1} of ${nextEntry.sets.length}.`:"Take it one set at a time.";
    $("sessionProgress").value=counts.percent;$("progressRing").setAttribute("aria-label",`${counts.percent} percent complete`);
    $("ringValue").style.strokeDashoffset=String(100-counts.percent);
    $("finishHint").textContent=counts.total===counts.completed?"All planned sets are logged. Finish when you’re ready.":`${counts.total-counts.completed} sets remain. You can finish early; only checked sets count.`;
    $("finishWorkout").disabled=!counts.completed||state.workout.status==="completed"||!!state.conflict||state.blocked;
    $("saveNow").disabled=!!state.saving||!!state.conflict||state.blocked;
    $("closeSession").disabled=!!state.saving||!!state.conflict||state.blocked||state.workout.status!=="active";
    $("timerToggle").disabled=state.workout.status!=="active"||state.blocked;
    $("timerReset").disabled=state.workout.status!=="active"||state.blocked;
    $("nextSet").disabled=!next||state.workout.status!=="active"||state.blocked;
    $("nextSet").setAttribute("aria-label",next?`Go to ${exercise(nextEntry.exerciseId).name}, set ${next.setIndex+1}`:"All planned sets are logged");
  }
  function focusNextSet(){
    const next=W.nextIncompleteSet(state.workout);if(!next)return;
    const card=$("sessionEntries").querySelector(`[data-entry="${CSS.escape(next.entryId)}"]`),row=card?.querySelector(`[data-set="${next.setIndex}"]`);
    row?.scrollIntoView({behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches?"auto":"smooth",block:"center"});
    (row?.querySelector("input:not(:disabled)")||row?.querySelector("button:not(:disabled)"))?.focus();
  }
  function entryFor(node){return state.workout?.entries.find((item)=>item.id===node.closest("[data-entry]")?.dataset.entry);}
  function alternativesFor(entry){
    const current=exercise(entry.exerciseId),guided=G?.exerciseGuidance?.(current,state.catalog,8)?.alternatives?.map((item)=>item.exercise)||[];
    const fallback=state.catalog.filter((candidate)=>candidate.id!==current.id&&W.swapComparison(current,candidate).compatible).sort((a,b)=>(b.sub===current.sub)-(a.sub===current.sub)||Number(b.score)-Number(a.score));
    return [...new Map([...guided,...fallback].map((item)=>[item.id,item])).values()].slice(0,8);
  }
  function renderSwapComparison(){
    const entry=state.workout?.entries.find((item)=>item.id===state.swapEntryId),candidate=exercise(state.swapCandidateId);if(!entry||!candidate.id)return;
    const current=exercise(entry.exerciseId),comparison=W.swapComparison(current,candidate);
    $("swapComparison").innerHTML=`<div><span>Current</span><strong>${esc(current.name)}</strong><small>${esc(current.sub||current.group)} · ${esc(current.equipment)} · FitScore ${Number(current.score)} · Stability ${Number(current.metrics?.stability||0)}</small></div><span class="swap-arrow" aria-hidden="true">→</span><div><span>Alternative</span><strong>${esc(candidate.name)}</strong><small>${esc(candidate.sub||candidate.group)} · ${esc(candidate.equipment)} · FitScore ${Number(candidate.score)} · Stability ${Number(candidate.metrics?.stability||0)}</small></div><p>${esc(comparison.explanation)}</p>`;
    $("planSwapReview").hidden=true;state.swapProposal=null;$("swapError").hidden=true;
  }
  function openSwap(button){
    const entry=entryFor(button);if(!entry||hasActuals(entry)||state.workout.status!=="active")return;
    const choices=alternativesFor(entry);if(!choices.length){toast("No comparable catalog alternative is available for this movement.");return;}
    state.swapEntryId=entry.id;state.swapCandidateId=choices[0].id;state.swapProposal=null;state.swapTrigger=button;
    $("swapExercise").innerHTML=choices.map((candidate)=>`<option value="${esc(candidate.id)}">${esc(candidate.name)} · ${esc(candidate.equipment)} · FitScore ${Number(candidate.score)}</option>`).join("");
    $("swapExercise").value=state.swapCandidateId;$("swapTitle").textContent=`Replace ${exercise(entry.exerciseId).name}`;renderSwapComparison();$("swapDialog").showModal();$("swapTitle").focus();
  }
  function closeSwap(){if($("swapDialog").open)$("swapDialog").close();}
  function applyWorkoutSwap(entry,candidate){
    if(!entry||!candidate||hasActuals(entry)||state.workout.status!=="active")throw new Error("Clear logged values before replacing this exercise.");
    const before=entry.exerciseId,unit=entry.unit,format=W.inferFormat(candidate,entry.prescribedReps);
    if(!entry.replacedFromExerciseId)entry.replacedFromExerciseId=before;
    entry.exerciseId=candidate.id;entry.measurement=format.measurement;entry.loadType=format.loadType;entry.unit=format.loadType==="bodyweight"?"kg":unit;
    entry.sets=entry.sets.map(W.blankSet);markDirty();renderSession();
  }
  function reviewPlanSwap(){
    const entry=state.workout?.entries.find((item)=>item.id===state.swapEntryId);if(!entry)return;
    try{
      state.swapProposal=W.planSwapProposal(state.plan,state.workout.planDay,entry,state.swapCandidateId);
      $("planSwapSummary").textContent=`${state.workout.planDay}: ${exercise(state.swapProposal.before).name} → ${exercise(state.swapProposal.after).name}. Your current Plan version is ${state.planUpdatedAt}.`;
      $("planSwapReview").hidden=false;$("planSwapReview").scrollIntoView({block:"nearest"});$("approvePlanSwap").focus();
    }catch(error){$("swapError").textContent=error.message;$("swapError").hidden=false;}
  }
  async function approvePlanSwap(){
    const proposal=state.swapProposal,entryId=state.swapEntryId,candidateId=state.swapCandidateId;if(!proposal||state.swapBusy)return;
    state.swapBusy=true;for(const id of ["swapWorkoutOnly","reviewPlanSwap","approvePlanSwap","cancelPlanSwap"])$(id).disabled=true;$("swapError").hidden=true;
    try{
      await assertIdentity();
      const result=await api("/api/plan",{method:"PUT",body:JSON.stringify({plan:proposal.plan,expectedPlanUpdatedAt:state.planUpdatedAt,expectedUserId:String(state.user.id)})});
      await assertIdentity();
      const entry=state.workout?.entries.find((item)=>item.id===entryId),candidate=exercise(candidateId);if(!entry||!candidate.id)throw new Error("This active workout changed before the Plan update could be shown. Reload to review both saved versions.");
      state.plan=result.plan;state.planUpdatedAt=Number(result.planUpdatedAt)||state.planUpdatedAt;applyWorkoutSwap(entry,candidate);closeSwap();toast("Approved: Plan and this workout now use the replacement exercise.");
    }catch(error){$("swapError").textContent=error.status===409?"Your Plan changed elsewhere. Nothing in this workout was replaced; close this dialog and review the latest Plan.":`Couldn't save the Plan change — ${saveError(error)}`;$("swapError").hidden=false;}
    finally{state.swapBusy=false;for(const id of ["swapWorkoutOnly","reviewPlanSwap","approvePlanSwap","cancelPlanSwap"])$(id).disabled=false;}
  }
  function applyRemembered(entry,kind){
    try{
      const memory=memoryFor(entry),proposal=kind==="last"?null:progression.targetFor(entry);
      if(proposal&&!["ready","baseline"].includes(proposal.status))throw new Error(proposal.explanation);
      const values=kind==="last"?memory?.sets:proposal?.status==="ready"?proposal.sets:W.suggestedTargets(entry,memory).sets;
      if(!values?.length)throw new Error("No comparable set values are available yet.");W.applyTargets(entry,values);markDirty();renderSession();toast(kind==="last"?"Previous values applied. Review them before each set.":"Suggested target applied. Review it before training.");
    }catch(error){errorMessage(error.message);}
  }
  function toggleSuperset(entry){
    const index=state.workout.entries.indexOf(entry);if(index<0)return;
    if(entry.supersetGroup){const group=entry.supersetGroup;state.workout.entries.forEach((item)=>{if(item.supersetGroup===group)item.supersetGroup="";});}
    else{
      const next=state.workout.entries[index+1];if(!next){toast("Choose an exercise above another movement to make a pair.");return;}
      if(next.supersetGroup){const old=next.supersetGroup;state.workout.entries.forEach((item)=>{if(item.supersetGroup===old)item.supersetGroup="";});}
      const group=`superset-${W.id().replace(/^workout-/,"").slice(0,80)}`;entry.supersetGroup=group;next.supersetGroup=group;
    }
    markDirty();renderSession();
  }
  function markDirty({save=true}={}){
    if(!state.workout||state.blocked)return;
    state.dirty=true;state.sequence++;
    if(state.workout.status==="active")state.workout.elapsedSeconds=Math.min(604800,Math.max(0,Math.floor((Date.now()-state.workout.startedAt)/1000)));
    const stored=persistDraft();
    status(stored?"Sync pending":"Couldn't save — Retry",stored?"":"error");
    clearTimeout(state.saveTimer);
    if(save&&!state.conflict)state.saveTimer=setTimeout(()=>void flushSave(),900);
  }
  function showConflict(latest,message=""){
    clearTimeout(state.saveTimer);state.conflict={latest};state.dirty=true;persistDraft();
    $("conflictPanel").hidden=false;
    if(message)$("conflictMessage").textContent=message;
    else $("conflictMessage").textContent="This session changed in another tab or device. Choose the latest saved version, or explicitly save your changes as a separate session. Neither version has been overwritten.";
    const mine=W.progress(state.workout),saved=latest?W.progress(latest):null;
    $("conflictComparison").innerHTML=`<div><strong>Latest saved version</strong><span>${latest?`${esc(latest.title)} · ${saved.completed}/${saved.total} sets · revision ${Number(latest.revision)}`:"This session is no longer in saved history."}</span></div><div><strong>Your device draft</strong><span>${esc(state.workout.title)} · ${mine.completed}/${mine.total} sets · ${esc(state.workout.status)}</span></div>`;
    $("useLatest").disabled=!latest;status("Conflict — Review","error");updateSessionMeta();$("conflictTitle").focus();
  }
  async function flushSave(){
    clearTimeout(state.saveTimer);
    if(!state.workout||!state.dirty||state.blocked||state.conflict)return false;
    if(state.saving){await state.saving;return state.dirty&&!state.conflict&&!state.blocked?flushSave():!state.dirty;}
    const snapshot=W.copy(state.workout),sequence=state.sequence;
    status("Saving…");
    const save=(async()=>{
      try{
        let saved;
        {
          await assertIdentity();
          const body=snapshot.revision?{workout:W.payload(snapshot),expectedRevision:snapshot.revision}:{workout:W.payload(snapshot)};
          const result=await api(snapshot.revision?`/api/workouts/${encodeURIComponent(snapshot.id)}`:"/api/workouts",{method:snapshot.revision?"PUT":"POST",body:JSON.stringify(body)});
          saved=result.workout;
          await assertIdentity();
        }
        if(!saved||!Number.isInteger(saved.revision))throw new Error("The save response was incomplete. Your draft is still available; retry before leaving.");
        if(!W.matches(saved,snapshot)){showConflict(saved,"The saved session differs from this request. Review the latest saved version before choosing what to keep.");return false;}
        state.workout.revision=saved.revision;state.workout.updatedAt=saved.updatedAt;
        state.dirty=state.sequence!==sequence;
        historyView.upsert(W.summary(saved));
        if(!state.dirty){
          status("Synced","saved");if(!$("sessionEntries").querySelector("input[aria-invalid=true]"))errorMessage("");
          if(saved.status==="completed"){removeDraft();showCompleted(saved);}else persistDraft();
        }else{persistDraft();state.saveTimer=setTimeout(()=>void flushSave(),300);}
        return true;
      }catch(error){
        if(error.status===409&&error.code==="ACTIVE_WORKOUT_EXISTS"&&error.data?.workout){
          resumeExistingActive(error.data.workout,sequence);return false;
        }
        if(error.status===409&&(!error.code||error.code==="WORKOUT_CONFLICT")){
          const latest=error.data?.workout||null;showConflict(latest);return false;
        }
        if(error.status===404&&snapshot.revision){showConflict(null,"This session was removed from saved history. Keep your draft by explicitly saving it as a new session.");return false;}
        if(error.status===401||error.code==="IDENTITY_CHANGED")blockSession();
        const detail=saveError(error);status("Couldn't save — Retry","error");errorMessage(detail);persistDraft();return false;
      }
    })();
    state.saving=save;updateSessionMeta();
    try{return await save;}finally{state.saving=null;updateSessionMeta();}
  }
  function resumeExistingActive(workout,snapshotSequence){
    const rejectedDraftKey=state.draftKey,changedWhileSaving=state.sequence!==snapshotSequence;
    if(changedWhileSaving)persistDraft();else removeDraft(rejectedDraftKey);
    selectWorkout(workout);historyView.upsert(W.summary(workout));
    $("sessionPanel").scrollIntoView({block:"start"});
    toast(changedWhileSaving?"Your existing workout was resumed. Changes made in this tab are kept as a separate device recovery draft.":"You already had a workout in progress, so STRATA resumed it instead of starting another.");
  }
  function showCompleted(workout){
    $("sessionPanel").hidden=true;$("celebration").hidden=false;$("conflictPanel").hidden=true;
    const counts=W.progress(workout);
    $("celebrationMessage").textContent=`${counts.completed} completed set${counts.completed===1?"":"s"} · ${workout.entries.length} planned movements · ${W.duration(workout.elapsedSeconds)} since start. ${state.mode==="account"?"Saved to your account.":"Saved on this device only."}`;
    guidance.reset();void guidance.load(workout.id);
    updateCalendarLink();
    toast("Workout complete. Your history is updated.");
    $("celebration").scrollIntoView({block:"center"});
  }
  function updateCalendarLink(){
    const event=C.event(C.nextPlannedSession(state.plan,W.DAYS,new Date()));
    $("calendarNext").hidden=!event;
    if(!event)return;
    $("calendarNextTitle").textContent=`Schedule ${event.day}’s workout.`;
    $("calendarNextSummary").textContent=`${event.date} · ${event.movements} movement${event.movements===1?"":"s"} · ${event.workingSets} working set${event.workingSets===1?"":"s"}`;
    $("calendarLink").href=event.href;$("calendarLink").download=event.filename;
  }
  function returnToPlan(){
    progression.reset();state.workout=null;state.draftKey="";state.pausedSeconds=null;guidance.reset();$("calendarNext").hidden=true;$("celebration").hidden=true;$("sessionPanel").hidden=true;$("startPanel").hidden=false;scanDrafts();contextView.focusPrimary();
  }
  function exportDraft(){
    if(!state.workout)return;
    const blob=new Blob([JSON.stringify({format:"strata-workout-draft",version:1,workout:state.workout,unsaved:state.dirty,pausedRestSeconds:state.pausedSeconds},null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`strata-workout-${state.workout.date}-${state.workout.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function tick(){
    const workout=state.workout;if(!workout||state.blocked)return;
    $("sessionElapsed").textContent=W.duration(workout.status==="completed"?workout.elapsedSeconds:Math.min(604800,Math.max(0,Math.floor((Date.now()-workout.startedAt)/1000))));
    const remaining=workout.restEndsAt?W.remainingSeconds(workout.restEndsAt):state.pausedSeconds??Number($("restDuration").value);
    $("restClock").textContent=W.duration(remaining);
    $("timerToggle").textContent=workout.restEndsAt&&remaining>0?"Pause":state.pausedSeconds?"Resume":"Start rest";
    if(workout.restEndsAt&&remaining===0&&!state.timerAnnounced){state.timerAnnounced=true;toast("Rest timer finished. Continue when you’re ready.");}
  }
  function startRest(seconds=Number($("restDuration").value)){
    if(!state.workout||state.workout.status!=="active"||state.blocked)return;
    state.workout.restEndsAt=Date.now()+seconds*1000;state.pausedSeconds=null;state.timerAnnounced=false;markDirty();tick();
  }
  const progression=P.create({state,workout:W,memoryFor,accountRead,renderSession:()=>view.refreshTargets($("sessionEntries"))});
  const guidance=Q.create({$,state,accountRead,api,assertIdentity,saveError,exercise,esc,number});
  const historyView=H.create({$,state,workout:W,view,esc,number,exercise,formatLabel,accountRead,saveError,blockSession,renderPlan,mergeMemory,memoryReadyFor,renderSession,loadWorkoutMemory,fetchWorkout,selectWorkout,toast,recover,resetProgression:progression.reset,locationLike:location,historyLike:history});
  const contextView=T.create({$,state,workout:W,view,esc,openDetail:historyView.openDetail,recover});
  async function initialize(){
    if(state.loading)return;
    if(state.blocked){location.reload();return;}
    state.loading=true;$("loadError").hidden=true;$("accessPanel").hidden=true;restorePreferences();
    try{
      const identity=await api("/api/me");
      if(!identity.user?.id)throw new Error("Sign in to Strata+ to open your workout room.");
      if(identity.user.discovery?.active!==true){$("accessPanel").hidden=false;$("modeNotice").textContent="Guided workouts, set logging, and history are Strata+ features. Your free Plan is unchanged.";return;}
      state.mode="account";state.user=identity.user;state.csrfToken=String(identity.csrfToken||"");state.ownerId=owner();authorizeOffline(identity.user.discovery);
      const catalog=await fetch("/exercises.json",{credentials:"same-origin"});
      if(!catalog.ok)throw new Error("The exercise library could not be loaded.");
      state.catalog=await catalog.json();if(!Array.isArray(state.catalog))throw new Error("The exercise library response was incomplete.");
      const planResult=await accountRead("/api/plan");
      if(String(planResult.user?.id)!==String(state.user.id)){blockSession();return;}
      state.plan=planResult.plan;state.planUpdatedAt=Number(planResult.planUpdatedAt)||0;
      if(!state.plan?.days)throw new Error("Your account plan could not be loaded. Retry to continue.");
      document.body.classList.add("has-workout-access");
      $("modeNotice").innerHTML=`<strong>${esc(state.user.name||"Your account")} · Strata+ active.</strong> Workouts sync securely and can recover on this device. <a href='/account.html'>Account</a>`;
      $("trainingRoom").hidden=false;$("historySection").hidden=false;scanDrafts();await historyView.load();
      const resumed=!state.blocked&&await historyView.openRequested();
      if(!resumed&&location.hash==="#historySection"&&!state.blocked){$("historySection").scrollIntoView({block:"start"});$("historyTitle").focus();}
    }catch(error){
      $("loadError").hidden=false;$("loadErrorMessage").textContent=saveError(error);
      $("modeNotice").textContent="The workout room could not load. Your saved sessions and device drafts have been kept.";
    }finally{state.loading=false;}
  }
  E.bind({$,state,workout:W,number,signal,actions:{initialize,renderPlan,resumeWorkout:contextView.resume,toast,selectWorkout,markDirty,errorMessage,entryFor,hasActuals,exercise,openSwap,toggleSuperset,applyRemembered,renderSession,startRest,tick,rememberPreferences,focusNextSet,flushSave,persistDraft,returnToPlan,exportDraft,recover,removeDraft,scanDrafts,showCompleted,upsertHistory:historyView.upsert,openDetail:historyView.openDetail,loadHistory:historyView.load,renderMetricOptions:historyView.renderMetricOptions,renderChart:historyView.renderChart,closeSwap,renderSwapComparison,applyWorkoutSwap,reviewPlanSwap,approvePlanSwap,assertIdentity,status,saveError,saveCheckIn:guidance.save}});
  setInterval(tick,1000);
  void initialize();
})();
