/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPlannerEvents=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function bindPlannerEvents({document,window,location,el,state,searchDebounceMs,actions}){
    let librarySearchTimer=null;
    const frame=callback=>(globalThis.requestAnimationFrame||setTimeout)(callback);

    document.addEventListener("dragstart",event=>{
      if(event.target.closest("button,a,input,select")){event.preventDefault();return;}
      const library=event.target.closest("[data-library-id]"),scheduled=event.target.closest("[data-instance-id]");
      if(library){state.drag={type:"library",exerciseId:library.dataset.libraryId};event.dataTransfer.effectAllowed="copy";}
      else if(scheduled){const day=scheduled.closest("[data-day]").dataset.day;state.drag={type:"schedule",day,instanceId:scheduled.dataset.instanceId};event.dataTransfer.effectAllowed="move";}
      else return;
      event.dataTransfer?.setData("text/plain",JSON.stringify(state.drag));
    });
    document.addEventListener("dragover",event=>{const zone=event.target.closest("[data-drop-day]");if(!zone||!state.ready)return;event.preventDefault();zone.closest(".day-column").classList.add("drag-over");});
    document.addEventListener("dragleave",event=>{const column=event.target.closest(".day-column");if(column&&!column.contains(event.relatedTarget))column.classList.remove("drag-over");});
    document.addEventListener("drop",event=>{
      const zone=event.target.closest("[data-drop-day]");
      if(!zone||!state.drag||!state.ready)return;
      event.preventDefault();document.querySelectorAll(".drag-over").forEach(node=>node.classList.remove("drag-over"));
      const day=zone.dataset.dropDay,previousTarget=state.selectedDay;state.selectedDay=day;
      const moved=state.drag.type==="library"?actions.addExercise(state.drag.exerciseId,day):actions.moveItem(state.drag.day,day,state.drag.instanceId,{focus:false});
      if(!moved)state.selectedDay=previousTarget;
      else{actions.persistSelectedDay();actions.renderLibrary();}
      state.drag=null;
    });
    document.addEventListener("dragend",()=>{state.drag=null;document.querySelectorAll(".drag-over").forEach(node=>node.classList.remove("drag-over"));});

    document.addEventListener("click",event=>{
      if(event.target.closest("[data-open-guest]")){void actions.init({guestOnly:true});return;}
      const guide=event.target.closest("[data-guide-exercise]"),replace=event.target.closest("[data-replace-item]"),filter=event.target.closest("[data-library-group]"),quick=event.target.closest("[data-quick-add]"),select=event.target.closest("[data-select-day]"),remove=event.target.closest("[data-remove-item]"),rest=event.target.closest("[data-set-rest]"),move=event.target.closest("[data-move-item]"),loadMore=event.target.closest("[data-load-more-library]"),retry=event.target.closest("[data-retry-init]");
      if(guide)actions.openExerciseGuide(guide.dataset.guideExercise,guide);
      else if(filter){state.group=filter.dataset.libraryGroup;actions.resetLibraryWindow();actions.renderFilters(state.group);actions.renderLibrary();}
      else if(quick)actions.addExercise(quick.dataset.quickAdd,state.selectedDay);
      else if(select){
        state.selectedDay=select.dataset.selectDay;actions.persistSelectedDay();
        const focusSelector=select.dataset.dayChip!==undefined?actions.instanceSelector("data-day-chip",state.selectedDay):`#weekBoard ${actions.instanceSelector("data-select-day",state.selectedDay)}`;
        actions.renderWeek(focusSelector);actions.renderLibrary();actions.showToast(`New exercises will be added to ${state.selectedDay}.`);
      }
      else if(replace)actions.openReplacement(replace.closest("[data-day]").dataset.day,replace.dataset.replaceItem);
      else if(remove)actions.removeItem(remove.closest("[data-day]").dataset.day,remove.dataset.removeItem);
      else if(rest)actions.setRestDay(rest.dataset.setRest);
      else if(move){const day=move.closest("[data-day]").dataset.day;actions.moveWithinDay(day,move.dataset.moveItem,Number(move.dataset.moveDirection));}
      else if(loadMore){const firstNewIndex=state.libraryLimit;state.libraryLimit+=actions.libraryPageSize();actions.renderLibrary();frame(()=>el("libraryList").querySelector(`[data-library-index="${firstNewIndex}"] [data-quick-add]`)?.focus());}
      else if(retry)void actions.init();
    });

    // Input is captured before blur so pagehide saves include the newest value.
    document.addEventListener("input",event=>{actions.updatePrescriptionInput(event);});
    document.addEventListener("change",event=>{
      const column=event.target.closest("[data-day]");
      if(!column||!state.ready)return;
      if(event.target.dataset.itemDay){
        const sourceDay=column.dataset.day,targetDay=event.target.value,instanceId=event.target.dataset.itemDay;
        if(sourceDay!==targetDay&&!actions.moveItem(sourceDay,targetDay,instanceId))event.target.value=sourceDay;
        return;
      }
      actions.updatePrescriptionInput(event,{normalize:true});
    });

    el("plannerSearch").addEventListener("input",event=>{const query=event.target.value;clearTimeout(librarySearchTimer);librarySearchTimer=setTimeout(()=>{state.query=query;actions.resetLibraryWindow();actions.renderLibrary();},searchDebounceMs);});
    el("exportAccountDraft").addEventListener("click",actions.downloadWeeklyPlan);
    el("reloadPlannerAccount").addEventListener("click",()=>window.location.reload());
    el("undoPlanRemoval").addEventListener("click",actions.undoLastRemoval);
    el("resetWeeklyPlan").addEventListener("click",event=>actions.openResetWeek(event.currentTarget));
    el("closeResetWeek").addEventListener("click",actions.closeResetWeek);
    el("confirmResetWeek").addEventListener("click",actions.confirmResetWeek);
    el("resetWeekDialog").addEventListener("close",()=>{const trigger=state.resetWeekTrigger;state.resetWeekSnapshot=null;state.resetWeekTrigger=null;frame(()=>trigger?.focus?.());});
    el("manageWeekTemplates").addEventListener("click",actions.openTemplates);
    el("saveWeekTemplate").addEventListener("click",actions.saveWeekTemplate);
    el("weekTemplateSelect").addEventListener("change",()=>{el("previewWeekTemplate").disabled=!el("weekTemplateSelect").value;});
    el("previewWeekTemplate").addEventListener("click",()=>{const entry=actions.weekTemplates().find(item=>item.key===el("weekTemplateSelect").value);if(entry)actions.previewTemplate(entry.data.plan,entry.data.name,entry.key);});
    el("templateFile").addEventListener("change",event=>void actions.importWeekTemplate(event.target.files?.[0]));
    el("confirmUseTemplate").addEventListener("change",()=>{el("applyWeekTemplate").disabled=!el("confirmUseTemplate").checked;});
    el("applyWeekTemplate").addEventListener("click",actions.useWeekTemplate);
    el("deleteWeekTemplate").addEventListener("click",actions.deleteWeekTemplate);
    el("closeWeekTemplates").addEventListener("click",()=>el("weekTemplatesDialog").close());
    el("copySourceDay").addEventListener("change",actions.syncCopyDayOptions);
    el("previewCopyDay").addEventListener("click",event=>actions.openCopyDayPreview(event.currentTarget));
    el("confirmCopyDay").addEventListener("change",event=>{el("applyCopyDay").disabled=!event.target.checked||!state.copyPreview?.changed;el("copyDayStatus").textContent=event.target.checked?"Ready to apply this reviewed copy. Nothing changes until you choose Apply reviewed copy.":"No changes applied.";});
    el("applyCopyDay").addEventListener("click",actions.applyCopyDayPreview);
    el("closeCopyDay").addEventListener("click",actions.closeCopyDayPreview);
    el("copyDayDialog").addEventListener("close",()=>{const trigger=state.copyTrigger;state.copyPreview=null;state.copyTrigger=null;frame(()=>trigger?.focus?.());});
    el("replaceExerciseSearch").addEventListener("input",actions.renderReplacementOptions);
    el("replaceExerciseSelect").addEventListener("change",()=>{el("confirmReplaceExercise").disabled=!el("replaceExerciseSelect").value;});
    el("confirmReplaceExercise").addEventListener("click",actions.confirmReplacement);
    el("closeReplaceExercise").addEventListener("click",()=>el("replaceExerciseDialog").close());
    el("closeExerciseGuide").addEventListener("click",()=>el("exerciseGuideDialog").close());
    el("exerciseGuideDialog").addEventListener("close",actions.restoreExerciseGuideFocus);
    el("draftRecoverySelect").addEventListener("change",event=>actions.selectRecoveredDraft(event.target.value));
    el("exportWeeklyPlan").addEventListener("click",actions.downloadWeeklyPlan);
    el("retryPlanSave").addEventListener("click",async event=>{
      const button=event.currentTarget;
      if(state.conflictDraft){actions.reviewConflictDraft();return;}
      button.disabled=true;actions.setSaveStatus("Saving…");
      try{await actions.flushSave({confirmConflict:state.conflictReview});}finally{button.disabled=false;}
    });
    el("reviewLocalPlan").addEventListener("click",actions.reviewConflictDraft);
    el("keepLatestPlan").addEventListener("click",actions.keepLatestPlan);
    el("devicePlanSource").addEventListener("change",event=>{state.activationCandidateId=event.target.value;actions.renderActivationCandidate();});
    el("compareDevicePlan").addEventListener("click",actions.toggleActivationComparison);
    el("devicePlanConfirm").addEventListener("change",event=>{el("claimDevicePlan").disabled=!event.target.checked||state.activationBusy;actions.setActivationStatus(event.target.checked?"Ready to replace the account week. The write will check for newer account changes first.":"No decision has been made. Both copies remain unchanged.");});
    el("keepAccountPlan").addEventListener("click",actions.keepAccountActivationPlan);
    el("claimDevicePlan").addEventListener("click",()=>void actions.claimActivationPlan());
    el("logoutButton").addEventListener("click",async event=>{
      const button=event.currentTarget;button.disabled=true;
      const saved=await actions.flushSave();
      if(!saved){button.disabled=false;actions.showToast("Your plan is still unsaved. Retry saving before signing out.");return;}
      try{await actions.api("/api/logout",{method:"POST"});window.location.replace("/");}
      catch(error){if(error.status===401)window.location.replace("/");else{button.disabled=false;actions.showToast("Could not sign out. Check your connection and try again.");}}
    });

    document.addEventListener("click",event=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
      const link=event.target.closest("a[href]");
      if(!link||link.target||link.hasAttribute("download"))return;
      const destination=new URL(link.href,location.href);
      if(destination.origin!==location.origin)return;
      if(state.navigating){event.preventDefault();return;}
      if(!state.ready||state.savedRevision>=state.revision)return;
      event.preventDefault();state.navigating=true;
      void (async()=>{const saved=await actions.flushSave();if(saved)location.assign(destination.href);else{state.navigating=false;actions.showToast("Your plan is still unsaved. Retry before leaving this page.");}})();
    });
    const refreshEntitlement=()=>{if(!document.visibilityState||document.visibilityState==="visible")void actions.refreshEntitlement();};
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")actions.sendKeepaliveSave();else refreshEntitlement();});
    window.addEventListener("focus",refreshEntitlement);
    window.addEventListener("pageshow",event=>{if(event.persisted)refreshEntitlement();});
    window.addEventListener("pagehide",actions.sendKeepaliveSave);
    window.addEventListener("beforeunload",event=>{if(state.ready&&state.savedRevision<state.revision){actions.sendKeepaliveSave();event.preventDefault();event.returnValue="";}});
  }

  return{bindPlannerEvents};
});
