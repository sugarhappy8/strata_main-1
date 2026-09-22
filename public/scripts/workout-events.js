/* global module */
(function(root,factory){
  "use strict";
  const events=factory();
  if(typeof module==="object"&&module.exports)module.exports=events;
  else root.StrataWorkoutEvents=events;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  function bind({$,state,workout:W,number,signal,actions,windowLike=globalThis.window,documentLike=globalThis.document,locationLike=globalThis.location,historyLike=globalThis.history,confirmImpl=globalThis.confirm}){
    const {initialize,renderPlan,resumeWorkout,toast,selectWorkout,markDirty,errorMessage,entryFor,hasActuals,exercise,openSwap,toggleSuperset,applyRemembered,renderSession,startRest,tick,rememberPreferences,focusNextSet,flushSave,persistDraft,returnToPlan,exportDraft,recover,removeDraft,scanDrafts,showCompleted,upsertHistory,openDetail,loadHistory,renderMetricOptions,renderChart,closeSwap,renderSwapComparison,applyWorkoutSwap,reviewPlanSwap,approvePlanSwap,assertIdentity,status,saveError}=actions;
    $("retryLoad").addEventListener("click",()=>void initialize());
    $("resumeWorkout").addEventListener("click",()=>void resumeWorkout());
    $("retryWorkoutHistory").addEventListener("click",()=>void loadHistory());
    $("planDay").addEventListener("change",()=>{
      state.day=$("planDay").value;
      const url=new URL(locationLike.href);url.searchParams.set("day",state.day);historyLike.replaceState(null,"",url);
      renderPlan();
    });
    $("chooseScheduledDay").addEventListener("click",()=>{
      const day=$("chooseScheduledDay").dataset.day;if(!W.DAYS.includes(day))return;
      state.day=day;const url=new URL(locationLike.href);url.searchParams.set("day",state.day);historyLike.replaceState(null,"",url);
      renderPlan();$("startWorkout").focus();
    });
    $("startWorkout").addEventListener("click",()=>{
      if(state.workout?.status==="active"||state.blocked)return;
      if(state.historyBusy||!state.historyLoaded){toast("Checking your saved workouts. Try again in a moment.");return;}
      if(state.historyLoadError){toast("Retry workout history before starting another workout.");return;}
      const active=state.recoveries.find((record)=>record.dirty&&record.workout.status==="active")?.workout||state.history.find((item)=>item.status==="active");
      if(active){
        toast("You already have a workout in progress. Resume it before starting another.");
        const recoveryIndex=state.recoveries.findIndex((record)=>record.dirty&&record.workout.id===active.id);
        if(recoveryIndex>=0){$("recoveryPanel").scrollIntoView({block:"start"});$("recoveryList").querySelector(`[data-recover="${recoveryIndex}"]`)?.focus();}
        else{$("historySection").scrollIntoView({block:"start"});[...$("historyList").querySelectorAll("[data-history]")].find((button)=>button.dataset.history===active.id)?.focus();}
        return;
      }
      try{selectWorkout(W.createWorkout(state.plan,state.day,state.catalog),{dirty:true});markDirty();signal("workout_started");$("sessionPanel").scrollIntoView({block:"start"});}
      catch(error){toast(error.message);}
    });
    $("sessionEntries").addEventListener("input",(event)=>{
      const note=event.target.closest("[data-entry-note]");
      if(note&&!state.blocked){const entry=entryFor(note);if(entry&&state.workout.status==="active"){entry.note=note.value;markDirty();}return;}
      const input=event.target.closest("[data-actual]");if(!input||state.blocked)return;
      const entry=state.workout?.entries.find((item)=>item.id===input.closest("[data-entry]").dataset.entry),set=entry?.sets[Number(input.closest("[data-set]").dataset.set)];
      if(!set||set.completed||state.workout.status!=="active")return;
      const value=input.value===""?null:Number(input.value);
      if(!input.validity.valid||value!==null&&!Number.isFinite(value)){input.setAttribute("aria-invalid","true");errorMessage(input.dataset.actual==="effort"?"Use a whole or half-step value within the selected RIR or RPE range. This value has not been applied.":"Use the allowed range and whole reps or seconds; loads allow at most 2 decimal places. This value has not been applied.");return;}
      if(input.dataset.actual==="effort"){const effort=W.effortError(entry,{effort:value});if(effort){input.setAttribute("aria-invalid","true");errorMessage(effort);return;}}
      input.removeAttribute("aria-invalid");errorMessage("");set[input.dataset.actual]=value;markDirty();
      input.closest("[data-entry]").querySelectorAll("[data-format]").forEach((select)=>select.disabled=hasActuals(entry)||(select.dataset.format==="unit"&&entry.loadType==="bodyweight"));
    });
    $("sessionEntries").addEventListener("change",(event)=>{
      const select=event.target.closest("[data-format]");if(!select||state.blocked)return;
      const entry=entryFor(select);if(!entry||state.workout.status!=="active")return;
      if(select.dataset.format==="effortType"){if(entry.sets.some((set)=>set.effort!=null))return;entry.effortType=select.value;markDirty();renderSession();return;}
      if(hasActuals(entry))return;entry[select.dataset.format]=select.value;if(entry.loadType==="bodyweight")entry.unit="kg";markDirty();renderSession();
    });
    $("sessionEntries").addEventListener("click",(event)=>{
      const action=event.target.closest("button");if(!action||state.blocked||state.workout?.status!=="active")return;
      const entry=entryFor(action);if(!entry)return;
      if(action.hasAttribute("data-open-swap")){openSwap(action);return;}
      if(action.hasAttribute("data-toggle-superset")){toggleSuperset(entry);return;}
      if(action.hasAttribute("data-use-last")){applyRemembered(entry,"last");return;}
      if(action.hasAttribute("data-apply-target")){applyRemembered(entry,"target");return;}
      if(action.hasAttribute("data-add-set")){try{const index=W.addSet(entry);markDirty();renderSession();$("sessionEntries").querySelector(`[data-entry="${CSS.escape(entry.id)}"] [data-set="${index}"] input:not(:disabled)`)?.focus();}catch(error){errorMessage(error.message);}return;}
      if(action.hasAttribute("data-duplicate-set")){try{const index=W.duplicateSet(entry,Number(action.dataset.duplicateSet));markDirty();renderSession();$("sessionEntries").querySelector(`[data-entry="${CSS.escape(entry.id)}"] [data-set="${index}"] input:not(:disabled)`)?.focus();}catch(error){errorMessage(error.message);}return;}
      if(action.hasAttribute("data-remove-set")){try{W.removeSet(entry,Number(action.dataset.removeSet));markDirty();renderSession();$("sessionEntries").querySelector(`[data-entry="${CSS.escape(entry.id)}"] [data-add-set]`)?.focus();}catch(error){errorMessage(error.message);}return;}
      if(action.hasAttribute("data-calc-warmup")){const card=action.closest("[data-entry]"),sets=W.warmupSets(card.querySelector("[data-warmup-load]").value),result=card.querySelector("[data-warmup-result]");result.textContent=sets.length?sets.map((set)=>`${set.percent}% · ${number(set.load)} ${entry.unit} × ${set.reps}`).join("  →  "):"Enter a working load above 0 and no more than 1,000.";return;}
      if(action.hasAttribute("data-calc-plates")){const card=action.closest("[data-entry]"),breakdown=W.plateBreakdown(card.querySelector("[data-plate-target]").value,card.querySelector("[data-bar-weight]").value),result=card.querySelector("[data-plate-result]");result.textContent=breakdown.remainder===null?"Enter a target at least as heavy as the bar.":`${breakdown.pairs.length?breakdown.pairs.map((item)=>`${item.count} × ${number(item.plate)} ${entry.unit}`).join(" + "):"No plates"} per side${breakdown.achievable?".":` · ${number(breakdown.remainder)} ${entry.unit} per side cannot be made with common plates.`}`;return;}
      const button=action.closest("[data-complete]");if(!button)return;
      const index=Number(button.dataset.complete),set=entry.sets[index],invalid=button.closest("tr").querySelector("input[aria-invalid=true]");
      if(invalid){invalid.focus();errorMessage("Correct this set’s highlighted actual value before completing it.");return;}
      if(!set.completed){const error=W.actualError(entry,set);if(error){errorMessage(`${exercise(entry.exerciseId).name}, set ${index+1}: ${error}`);button.closest("tr").querySelector("input:not(:disabled)")?.focus();return;}}
      set.completed=!set.completed;errorMessage("");if(set.completed&&$("autoRest").checked)startRest();else markDirty();renderSession();
      $("sessionEntries").querySelector(`[data-entry="${CSS.escape(entry.id)}"] [data-complete="${index}"]`)?.focus();
    });
    $("timerToggle").addEventListener("click",()=>{if(!state.workout||state.workout.status!=="active")return;const remaining=W.remainingSeconds(state.workout.restEndsAt);if(state.workout.restEndsAt&&remaining>0){state.pausedSeconds=remaining;state.workout.restEndsAt=null;markDirty();tick();}else startRest(state.pausedSeconds||Number($("restDuration").value));});
    $("timerReset").addEventListener("click",()=>{if(!state.workout||state.workout.status!=="active")return;state.workout.restEndsAt=null;state.pausedSeconds=null;state.timerAnnounced=false;markDirty();tick();});
    $("restDuration").addEventListener("change",()=>{rememberPreferences();tick();});$("autoRest").addEventListener("change",rememberPreferences);$("nextSet").addEventListener("click",focusNextSet);$("saveNow").addEventListener("click",()=>void flushSave());
    $("closeSession").addEventListener("click",async()=>{if(!state.workout||state.workout.status!=="active"||state.conflict||state.blocked)return;const invalid=$("sessionEntries").querySelector("input[aria-invalid=true]");if(invalid){invalid.focus();errorMessage("Correct or clear the highlighted actual value before saving and closing.");return;}if(state.dirty)await flushSave();if(state.dirty||state.saving||state.conflict||state.blocked)return;persistDraft();returnToPlan();toast("Session saved. Resume it from your history whenever you’re ready.");});
    $("exportDraft").addEventListener("click",exportDraft);$("exportConflict").addEventListener("click",exportDraft);
    $("finishWorkout").addEventListener("click",()=>{if(!state.workout||state.conflict||state.blocked||state.workout.status!=="active")return;const invalid=$("sessionEntries").querySelector("input[aria-invalid=true]");if(invalid){invalid.focus();errorMessage("Correct or clear the highlighted actual value before finishing.");return;}const counts=W.progress(state.workout);if(!counts.completed)return;$("finishDialogMessage").textContent=`You’ve completed ${counts.completed} of ${counts.total} sets. ${counts.total-counts.completed} sets will remain unfinished.`;$("finishDialog").returnValue="cancel";$("finishDialog").showModal();});
    $("finishDialog").addEventListener("close",()=>{if($("finishDialog").returnValue!=="finish"||state.blocked||state.conflict||!state.workout)return;state.workout.status="completed";state.workout.completedAt=Date.now();state.workout.elapsedSeconds=Math.min(604800,Math.max(0,Math.floor((state.workout.completedAt-state.workout.startedAt)/1000)));state.workout.restEndsAt=null;state.pausedSeconds=null;markDirty({save:false});renderSession();signal("workout_completed");void flushSave();});
    $("checkInForm").addEventListener("submit",event=>{event.preventDefault();void actions.saveCheckIn();});
    $("anotherSession").addEventListener("click",()=>{if(state.dirty||state.saving||state.checkInBusy)return;returnToPlan();});
    $("recoveryList").addEventListener("click",(event)=>{const recoverButton=event.target.closest("[data-recover]");if(recoverButton){void recover(Number(recoverButton.dataset.recover));return;}const discardButton=event.target.closest("[data-discard]");if(!discardButton)return;const record=state.recoveries[Number(discardButton.dataset.discard)];if(!record)return;if(!confirmImpl("Remove this device recovery draft? Unsaved changes in this draft will be lost. Saved account history will remain."))return;removeDraft(record.key);scanDrafts();});
    $("useLatest").addEventListener("click",()=>{const latest=state.conflict?.latest;if(!latest)return;if(!confirmImpl("Use the latest saved version and discard this tab’s unsaved changes? Download your draft first if you want a separate copy."))return;removeDraft();selectWorkout(latest);if(latest.status==="completed"){removeDraft();showCompleted(latest);}upsertHistory(W.summary(latest));});
    $("saveCopy").addEventListener("click",()=>{if(!state.conflict||state.saving)return;const oldKey=state.draftKey,copy=W.copy(state.workout);copy.id=W.id();delete copy.revision;delete copy.updatedAt;copy.title=`${copy.title.replace(/ \(recovered copy\)$/u,"").slice(0,100)} (recovered copy)`;selectWorkout(copy,{dirty:true,pausedSeconds:state.pausedSeconds});if(persistDraft())removeDraft(oldKey);markDirty({save:false});void flushSave();});
    $("historyList").addEventListener("click",(event)=>{const button=event.target.closest("[data-history]");if(button)void openDetail(button.dataset.history);});$("refreshHistory").addEventListener("click",()=>void loadHistory());$("loadMore").addEventListener("click",()=>void loadHistory({more:true}));
    $("chartExercise").addEventListener("change",renderMetricOptions);$("chartMetric").addEventListener("change",renderChart);$("closeDetail").addEventListener("click",()=>$("detailDialog").close());
    $("swapExercise").addEventListener("change",()=>{state.swapCandidateId=$("swapExercise").value;renderSwapComparison();});
    $("swapWorkoutOnly").addEventListener("click",()=>{const entry=state.workout?.entries.find((item)=>item.id===state.swapEntryId),candidate=exercise(state.swapCandidateId);try{applyWorkoutSwap(entry,candidate);closeSwap();toast("Replacement applied to this workout only. Your Plan is unchanged.");}catch(error){$("swapError").textContent=error.message;$("swapError").hidden=false;}});
    $("reviewPlanSwap").addEventListener("click",reviewPlanSwap);$("approvePlanSwap").addEventListener("click",()=>void approvePlanSwap());$("cancelPlanSwap").addEventListener("click",()=>{$("planSwapReview").hidden=true;state.swapProposal=null;$("reviewPlanSwap").focus();});$("closeSwap").addEventListener("click",closeSwap);
    $("swapDialog").addEventListener("close",()=>{const trigger=state.swapTrigger,card=state.swapEntryId?$("sessionEntries").querySelector(`[data-entry="${CSS.escape(state.swapEntryId)}"]`):null,replacement=card?.querySelector(".exercise-more > summary"),target=trigger?.isConnected?trigger:replacement;state.swapEntryId="";state.swapCandidateId="";state.swapProposal=null;state.swapTrigger=null;setTimeout(()=>{if(target?.isConnected)target.focus();},0);});
    windowLike.addEventListener("beforeunload",(event)=>{persistDraft();if(state.dirty||state.checkInBusy||state.swapBusy){event.preventDefault();event.returnValue="";}});
    documentLike.addEventListener("visibilitychange",()=>{if(documentLike.visibilityState==="hidden")persistDraft();else if(state.mode==="account"&&!state.blocked)void assertIdentity().catch((error)=>{if(error.status!==401&&error.code!=="IDENTITY_CHANGED")status(saveError(error),"error");});tick();});
    windowLike.addEventListener("online",()=>{if(state.dirty&&!state.blocked&&!state.conflict)toast("Connection restored. Choose Save now to retry your pending account changes.");});
  }
  return{bind};
});
