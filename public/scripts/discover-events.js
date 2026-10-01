/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverEvents=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function bind({document,window,el,state,core,movementBoardLimit,searchDebounceMs,featureNavigation,actions}){
    const frame=callback=>(globalThis.requestAnimationFrame||setTimeout)(callback);
    featureNavigation.bindHistory();
    document.addEventListener("click",event=>{
      const feature=event.target.closest("[data-feature-target]"),shortlist=event.target.closest("[data-toggle-shortlist]"),detail=event.target.closest("[data-open-detail]"),compare=event.target.closest("[data-toggle-compare]"),scrollAlternatives=event.target.closest("[data-scroll-alternatives]"),close=event.target.closest("[data-close-dialog]"),collection=event.target.closest("[data-collection]"),reset=event.target.closest("[data-reset-filters]"),loadMore=event.target.closest("[data-load-more-exercises]");
      if(feature&&actions.featureName(feature.dataset.featureTarget)){event.preventDefault();actions.hideToast();actions.activateFeature(feature.dataset.featureTarget,{focus:true,scroll:true,smooth:true,announce:true,historyMode:"push"});}
      else if(shortlist){
        const id=shortlist.dataset.toggleShortlist,containerId=shortlist.closest("#recommendationGrid,#exerciseGrid,#detailContent")?.id;
        if(actions.toggleMovementBoard(id)&&containerId)frame(()=>{
          const same=[...el(containerId).querySelectorAll("[data-toggle-shortlist]")].find(button=>button.dataset.toggleShortlist===id);
          (same||document.querySelector('[data-collection="saved"]'))?.focus?.({preventScroll:true});
        });
      }
      else if(detail)actions.openDetail(detail.dataset.openDetail);
      else if(compare){
        const id=compare.dataset.toggleCompare,containerId=compare.closest("#recommendationGrid,#exerciseGrid,#detailContent")?.id;
        actions.toggleCompare(id);if(el("detailDialog").open)actions.openDetail(id);
        if(containerId)frame(()=>[...el(containerId).querySelectorAll("[data-toggle-compare]")].find(button=>button.dataset.toggleCompare===id)?.focus({preventScroll:true}));
      }
      else if(scrollAlternatives){const section=el("alternativeSection"),heading=el("alternativeTitle"),reduceMotion=window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;section?.scrollIntoView?.({behavior:reduceMotion?"auto":"smooth",block:"start"});heading?.focus?.({preventScroll:true});}
      else if(close)actions.closeDialog(close.dataset.closeDialog);
      else if(collection){state.collection=collection.dataset.collection;if(state.collection==="community"){state.sort="community";el("sortSelect").value="community";}actions.setCollectionState(state.collection);actions.resetExplorerWindow();actions.renderExplorer();}
      else if(reset)actions.resetFilters();
      else if(loadMore){const firstNewIndex=state.explorerLimit;state.explorerLimit+=actions.explorerPageSize();actions.renderExplorer();frame(()=>el("exerciseGrid").querySelector(`[data-result-index="${firstNewIndex}"] [data-open-detail]`)?.focus());}
    });
    document.querySelectorAll("dialog").forEach(dialog=>{
      dialog.addEventListener("click",event=>{if(event.target===dialog&&dialog.dataset.busy!=="true")actions.closeDialog(dialog.id);});
      dialog.addEventListener("cancel",event=>{event.preventDefault();if(dialog.dataset.busy!=="true")actions.closeDialog(dialog.id);});
      dialog.addEventListener("close",()=>{actions.syncDialogState();actions.restoreDialogFocus(dialog);});
    });
    window.addEventListener?.("focus",()=>{void actions.revalidateMemberWorkspaceWhenVisible();});
    document.addEventListener("visibilitychange",()=>{void actions.revalidateMemberWorkspaceWhenVisible();});
    // A signed-in view whose account re-check failed retries that check, keeping unsaved input; a failed first load reloads.
    const retryLoad=()=>{void(state.user?actions.revalidateMemberWorkspaceWhenVisible():actions.init());};
    window.addEventListener?.("online",()=>{if(!el("discoveryLoadError").hidden)retryLoad();});
    el("searchInput").addEventListener("input",event=>{const query=event.target.value;clearTimeout(state.explorerSearchTimer);state.explorerSearchTimer=setTimeout(()=>{state.query=query;actions.resetExplorerWindow();actions.renderExplorer();},searchDebounceMs);});
    for(const [id,key] of [["groupFilter","group"],["equipmentFilter","equipment"],["patternFilter","pattern"],["levelFilter","level"],["sortSelect","sort"]])el(id).addEventListener("change",event=>{state[key]=event.target.value;actions.resetExplorerWindow();actions.renderExplorer();});
    el("clearFilters").addEventListener("click",actions.resetFilters);
    el("clearCompare").addEventListener("click",()=>{state.compare=[];el("battleResults").hidden=true;actions.renderCompareTray();actions.renderRecommendations();actions.renderExplorer();});
    el("openCompare").addEventListener("click",()=>{actions.activateFeature("battle",{focus:true,scroll:true,smooth:true,announce:true,historyMode:"push"});actions.openComparison();});
    el("battleSelects").addEventListener("change",()=>{actions.readBattleBuilder();el("battleResults").hidden=true;actions.renderRecommendations();actions.renderExplorer();});
    el("battleForm").addEventListener("submit",event=>{event.preventDefault();actions.readBattleBuilder();actions.renderCompareTray();actions.renderRecommendations();actions.renderExplorer();actions.openComparison();});
    el("battleReset").addEventListener("click",()=>{state.compare=[];el("battleResults").hidden=true;actions.renderCompareTray();actions.renderRecommendations();actions.renderExplorer();});
    el("compareMovementBoard").addEventListener("click",()=>{state.compare=core.normalizeShortlist(state.shortlist,state.exercises,movementBoardLimit);actions.renderCompareTray();actions.renderRecommendations();actions.renderExplorer();actions.activateFeature("battle",{focus:true,scroll:true,smooth:true,announce:true,historyMode:"push"});actions.openComparison();});
    el("clearMovementBoard").addEventListener("click",()=>{state.shortlist=[];actions.saveMovementBoard();actions.renderMovementBoard({message:"Saved movements cleared."});actions.renderRecommendations();actions.renderExplorer();document.querySelector('[data-collection="saved"]')?.focus?.({preventScroll:true});actions.showToast("Decision board cleared.");});
    el("logoutButton").addEventListener("click",async event=>{
      const button=event.currentTarget;if(button.disabled)return;button.disabled=true;
      try{await actions.api("/api/logout",{method:"POST"});window.location.replace("/");}
      catch(error){if(error.status===401){window.location.replace("/");return;}button.disabled=false;actions.showToast("Could not sign out. Check your connection and try again.");}
    });
    el("discoveryRetry").addEventListener("click",retryLoad);
  }

  return{bind};
});
