/* global module, require */
(function(root,factory){
  const api=factory(typeof module==="object"&&module.exports?require("./home-logic"):root.StrataHomeLogic);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataHomeRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(logic){
  "use strict";

  function previewResultMarkup(item){
    const exercise=item.exercise,escape=logic.escapeHtml;
    return `<li class="preview-result"><span class="preview-rank" aria-label="Rank ${item.rank}">${String(item.rank).padStart(2,"0")}</span><div class="preview-result-copy"><div class="preview-result-title"><h3>${escape(exercise.name)}</h3><span>${escape(exercise.sub)} · ${escape(exercise.equipment)}</span></div><p>${escape(exercise.why)}</p><ul class="preview-reasons" aria-label="Why this moved up">${item.reasons.map(reason=>`<li>${escape(reason)}</li>`).join("")}</ul><p class="preview-tradeoff"><strong>Trade-off:</strong> ${escape(item.tradeoffText)}.</p></div><div class="preview-scores" aria-label="${item.match} percent personal match and ${item.officialScore} official FitScore"><span><b>${item.match}%</b><small>Personal match</small></span><span><b>${item.officialScore}</b><small>FitScore</small></span></div></li>`;
  }

  function createRenderer({document,window,state,readPreviewProfile,guestPlanCount}){
    if(!document||!state)throw new TypeError("Homepage renderer requires document and state.");
    const el=id=>document.getElementById(id),groups=logic.GROUPS,groupOrder=logic.GROUP_ORDER;
    const groupTabs=el("groupTabs"),musclePanel=el("musclePanel"),submuscleFilters=el("submuscleFilters"),exerciseList=el("exerciseList");
    const detailDialog=el("detailDialog"),compareDialog=el("compareDialog"),dialogReturnFocus=new WeakMap();
    const frame=callback=>(globalThis.requestAnimationFrame||setTimeout)(callback);
    let toastTimer,activeDetailId=null;

    function renderTabs(){
      groupTabs.innerHTML=groupOrder.map(key=>{const selected=state.group===key;return`<button class="group-tab" id="group-tab-${key}" type="button" role="tab" aria-selected="${selected}" aria-controls="rankingsPanel" tabindex="${selected?"0":"-1"}" data-group="${key}">${groups[key].name}</button>`;}).join("");
      el("rankingsPanel").setAttribute("aria-labelledby",`group-tab-${state.group}`);
    }
    function renderPanel(){
      const group=groups[state.group],count=state.catalogStatus==="ready"?state.exercises.filter(exercise=>exercise.group===state.group).length:"—",index=String(groupOrder.indexOf(state.group)+1).padStart(2,"0");
      musclePanel.innerHTML=`<div class="panel-index"><span>Region ${index}</span><span>Target layers</span></div><div class="panel-number">${index}</div><h3>${group.name}</h3><p>${group.description}</p><div class="target-matrix">${group.subs.map((sub,itemIndex)=>`<span><i>${String(itemIndex+1).padStart(2,"0")}</i>${sub}</span>`).join("")}</div><div class="panel-stat"><span>Targets <b>${group.subs.length}</b></span><span>Movements <b>${count}</b></span></div>`;
    }
    function renderSubfilters(){
      submuscleFilters.innerHTML=["all",...groups[state.group].subs].map(sub=>{const active=state.sub===sub;return`<button type="button" class="filter-chip ${active?"active":""}" aria-pressed="${active}" data-sub="${sub}">${sub==="all"?"All targets":sub}</button>`;}).join("");
    }
    function updateEquipmentOptions(){
      const select=el("equipmentFilter"),values=logic.equipmentOptions(state.exercises,state.group);
      if(state.equipment!=="all"&&!values.includes(state.equipment))state.equipment="all";
      select.innerHTML=`<option value="all">All equipment</option>${values.map(value=>`<option value="${logic.escapeHtml(value)}">${logic.escapeHtml(value)}</option>`).join("")}`;
      select.value=state.equipment;
    }
    function setEmptyStateCopy(title,message,buttonLabel,buttonHidden){
      const heading=el("emptyState").querySelector("h3"),description=el("emptyState").querySelector("p"),button=el("clearFilters");
      if(heading)heading.textContent=title;if(description)description.textContent=message;button.textContent=buttonLabel;button.hidden=buttonHidden;
    }
    const TOP_ROWS=10;
    function renderExercises(){
      if(state.catalogStatus!=="ready"){
        const failed=state.catalogStatus==="error";
        el("resultCount").textContent="0";el("resultNoun").textContent="exercises";el("activeTarget").textContent=`${groups[state.group].name} · ${failed?"Library unavailable":"Loading library"}`;
        el("resetActiveFilters").hidden=true;exerciseList.innerHTML="";el("emptyState").hidden=false;
        setEmptyStateCopy(failed?"Exercise library unavailable.":"Loading exercise library…",failed?"Check your connection, then try loading the library again.":"Preparing the latest rankings and exercise details.",failed?"Try again":"Reset filters",!failed);
        return;
      }
      setEmptyStateCopy("No movement found.","Clear a filter or search another exercise.","Reset filters",false);
      const rows=logic.filterExercises(state.exercises,state),comparisonAllowed=logic.comparisonAccessIsFresh(state),activeFilters=[state.sub!=="all"?`Target: ${state.sub}`:"",state.equipment!=="all"?`Equipment: ${state.equipment}`:"",state.level!=="all"?`Experience: ${state.level}`:"",state.query.trim()?`Search: “${state.query.trim()}”`:""].filter(Boolean);
      el("resultCount").textContent=rows.length;el("resultNoun").textContent=rows.length===1?"exercise":"exercises";el("activeTarget").textContent=`${groups[state.group].name} · ${activeFilters.length?activeFilters.join(" · "):"All targets"}`;
      el("resetActiveFilters").hidden=activeFilters.length===0;el("emptyState").hidden=rows.length!==0;
      // The ten best matches lead; the rest of the ranking is one click away.
      const visible=state.showAll?rows:rows.slice(0,TOP_ROWS);if(el("exerciseListMore")){el("exerciseListMore").hidden=visible.length===rows.length;el("showAllExercises").textContent=`Show all ${rows.length} exercises`;}
      exerciseList.innerHTML=visible.map((exercise,index)=>{
        const compared=state.compare.includes(exercise.id),escape=logic.escapeHtml,id=escape(exercise.id),name=escape(exercise.name);
        const compareAction=comparisonAllowed?`<button class="action-icon ${compared?"active":""}" data-compare="${id}" type="button" title="${compared?"Remove from comparison":"Add to comparison"}" aria-pressed="${compared}" aria-label="${compared?"Remove":"Add"} ${name} ${compared?"from":"to"} comparison"><span aria-hidden="true">⇄</span></button>`:"";
        return `<div class="exercise-row" role="listitem"><div class="rank-number"><span aria-hidden="true">${String(index+1).padStart(2,"0")}</span><span class="sr-only">Rank ${index+1}</span></div><div class="exercise-title"><button type="button" data-detail="${id}"><h3>${name}</h3><p>${escape(exercise.pattern)} · ${escape(exercise.level)}</p><p class="mobile-exercise-meta">${escape(exercise.sub)} · ${escape(exercise.equipment)}</p><span class="details-cue">View details <span aria-hidden="true">↘</span></span></button></div><div><span class="target-pill">${escape(exercise.sub)}</span></div><div class="exercise-cell"><small>Equipment</small><strong>${escape(exercise.equipment)}</strong></div><div class="score-badge ${exercise.score>=94?"top":""}" role="img" aria-label="FitScore ${exercise.score} out of 100" style="--score:${exercise.score}%"><strong>${exercise.score}</strong><span aria-hidden="true">/100</span></div><div class="row-actions"><a class="action-icon youtube-action" href="${escape(exercise.youtube)}" target="_blank" rel="noreferrer" title="Watch tutorials" aria-label="Find ${name} tutorials on YouTube"><span aria-hidden="true">▶</span></a>${compareAction}<button class="action-icon" data-add-planner="${id}" type="button" title="Add to planner" aria-label="Add ${name} to weekly planner"><span aria-hidden="true">+</span></button></div></div>`;
      }).join("");
    }

    function previewPlaceholder(message){
      el("quickPreviewSummary").textContent="Ready when you are";
      el("quickPreviewResults").innerHTML=["Recommendation","Recommendation","Recommendation"].map((label,index)=>`<li class="preview-placeholder"><span>${String(index+1).padStart(2,"0")}</span><div><strong>${label}</strong><p>${logic.escapeHtml(message)}</p></div></li>`).join("");
      if(window.StrataHomeActivation?.hide)window.StrataHomeActivation.hide();else el("quickWeekPreview").hidden=true;
      el("quickPreviewActions").hidden=true;
    }
    function updatePreviewEquipmentOptions({announce=false}={}){
      const select=el("quickPreviewEquipment"),submit=el("quickPreviewSubmit");
      for(const button of document.querySelectorAll("[data-preview-starter]"))button.disabled=state.catalogStatus!=="ready";
      if(state.catalogStatus!=="ready"){
        select.disabled=true;submit.disabled=true;select.innerHTML=`<option>${state.catalogStatus==="error"?"Library unavailable":"Loading equipment…"}</option>`;return;
      }
      const sample=readPreviewProfile(),group=sample.group,allOptions=logic.equipmentOptions(state.exercises,group),home=window.StrataHomeActivation;
      el("quickPreviewGroup").value=group;
      const options=typeof home?.canBuild==="function"?allOptions.filter(equipment=>home.canBuild({exercises:state.exercises,sample:{...sample,equipment}})):allOptions;
      const previous=select.value,preferred=options.includes(previous)?previous:options.includes("Dumbbells")?"Dumbbells":options.includes("Bodyweight")?"Bodyweight":options[0];
      select.innerHTML=options.map(value=>`<option value="${logic.escapeHtml(value)}">${logic.escapeHtml(value)}</option>`).join("");select.value=preferred||"";select.disabled=options.length===0;submit.disabled=options.length===0;
      el("quickPreviewOutput").setAttribute("aria-busy","false");
      el("quickPreviewStatus").textContent=options.length?(announce?`${groups[group].name} selected. Choose your equipment, then show your shortlist.`:"Ready. Change any choice or generate this starting point."):`No equipment options are available for ${groups[group].name}.`;
    }

    function guestCount(){return typeof guestPlanCount==="function"?guestPlanCount():0;}
    function updateAccountUI(){
      if(state.accountStatus==="loading"||state.accountStatus==="unavailable")return;
      const button=el("accountButton"),signup=el("signupButton"),discoveryButton=el("discoverButton"),discoveryActive=logic.hasPlus(state.user);
      button.textContent=state.user?`${state.user.name.split(/\s+/)[0]} profile`:"Log in";button.href=state.user?"/account.html":"/account.html?mode=login";button.classList.toggle("signed-in",Boolean(state.user));signup.hidden=Boolean(state.user);
      discoveryButton.hidden=!state.user;discoveryButton.href=discoveryActive?"/discover.html":"/pricing";discoveryButton.textContent=discoveryActive?"Strata+":"Unlock Strata+";
      const previewLogin=el("quickPreviewLogin"),previewContinue=el("quickPreviewContinue");previewLogin.hidden=Boolean(state.user);previewContinue.href=state.user?"/planner.html":"/account.html?mode=signup&next=planner";
      if(state.user)previewContinue.innerHTML="<strong>Compare with my account</strong><span>Choose which week to keep →</span>";
      else previewContinue.innerHTML="<strong>Keep this exact week</strong><span>Create an account, then choose what to save →</span>";
      const planCount=state.user?(Number(state.user.planCount)||0):guestCount();el("planCount").textContent=planCount;el("planButton").href="/planner.html";el("planButton").setAttribute("aria-label",`Open weekly planner, ${planCount} ${planCount===1?"exercise":"exercises"}`);
    }
    function updateCompareDock(){
      const allowed=logic.comparisonAccessIsFresh(state),visible=allowed&&state.compare.length>0;
      el("compareDock").hidden=!visible;document.body?.classList.toggle("compare-open",visible);el("compareCount").textContent=`${state.compare.length}/2`;el("openCompare").disabled=!allowed||state.compare.length!==2;
      el("compareNames").textContent=state.compare.length?state.compare.map(id=>state.exercises.find(exercise=>exercise.id===id)?.name).join(" vs "):"Choose two exercises";
    }
    function renderAll(){renderTabs();renderPanel();renderSubfilters();updateEquipmentOptions();renderExercises();updateCompareDock();updateAccountUI();}
    function focusRenderedControl(container,attribute,value){frame(()=>[...container.querySelectorAll(`[${attribute}]`)].find(item=>item.getAttribute(attribute)===value)?.focus());}
    function metricMarkup(exercise){return Object.entries(exercise.metrics).map(([key,value])=>`<div class="metric"><div class="metric-head"><span>${logic.METRIC_LABELS[key]}</span><b>${value}</b></div><div class="metric-track" aria-hidden="true"><i style="width:${value}%"></i></div></div>`).join("");}
    function syncDialogState(){document.body.classList.toggle("dialog-open",detailDialog.open||compareDialog.open);}
    function restoreModalFocus(dialog){const control=dialogReturnFocus.get(dialog);dialogReturnFocus.delete(dialog);if(control&&control.isConnected!==false&&!control.hidden&&!control.disabled)frame(()=>control.focus());}
    function openModal(dialog){
      if(!dialog.open){const active=document.activeElement;if(active&&active!==document.body&&typeof active.focus==="function"&&!dialog.contains?.(active))dialogReturnFocus.set(dialog,active);dialog.showModal();}
      syncDialogState();frame(()=>dialog.querySelector?.("[data-close-dialog],button,[href],input,select,textarea")?.focus());
    }
    function closeModal(dialog){if(dialog?.open)dialog.close();syncDialogState();if(dialog)restoreModalFocus(dialog);}
    function detailFocusToken(){
      const active=document.activeElement;if(!detailDialog.open||!active||typeof detailDialog.contains!=="function"||!detailDialog.contains(active))return null;
      for(const attribute of ["data-close-dialog","data-detail","data-add-planner","data-compare","href"]){const value=active.getAttribute?.(attribute);if(value!==null&&value!==undefined)return{attribute,value};}
      return{attribute:null,value:null};
    }
    function restoreDetailFocus(token){
      if(!token)return;frame(()=>{
        const candidates=token.attribute?[...detailDialog.querySelectorAll?.(`[${token.attribute}]`)||[]]:[];
        const matching=candidates.find(control=>control.getAttribute?.(token.attribute)===token.value);
        (matching||detailDialog.querySelector?.("[data-close-dialog]")||detailDialog).focus?.({preventScroll:true});
      });
    }
    function openDetail(id,{focus=true}={}){
      const exercise=state.exercises.find(item=>item.id===id);if(!exercise)return;
      activeDetailId=id;
      const compared=state.compare.includes(id),comparisonAllowed=logic.comparisonAccessIsFresh(state),guidance=window.StrataDiscovery.exerciseGuidance(exercise,state.exercises),escape=logic.escapeHtml;
      const alternatives=guidance.alternatives.map(({exercise:alternative,reason})=>`<li><button type="button" data-detail="${escape(alternative.id)}"><strong>${escape(alternative.name)}</strong><span>${escape(alternative.equipment)}</span></button><small>${escape(reason)}</small></li>`).join("");
      const compareAction=comparisonAllowed?`<button class="button" style="border-color:var(--ink)" data-compare="${escape(exercise.id)}" type="button" aria-pressed="${compared}">${compared?"Remove comparison":"Compare exercise"}<span aria-hidden="true">⇄</span></button>`:"";
      el("detailContent").innerHTML=`<div class="detail-hero"><button class="icon-button detail-close" data-close-dialog="detailDialog" type="button" aria-label="Close details">×</button><div class="detail-hero-copy"><p class="kicker">${groups[exercise.group].name} / ${escape(exercise.sub)}</p><h2 id="detailTitle">${escape(exercise.name)}</h2><p>${escape(exercise.why)}</p></div><div class="detail-score" role="img" aria-label="FitScore ${exercise.score} out of 100"><span>FitScore</span><strong>${exercise.score}</strong><span>out of 100</span></div></div><div class="detail-body"><div class="detail-meta"><div><span>Sets</span><strong>${escape(exercise.sets)}</strong></div><div><span>Reps</span><strong>${escape(exercise.reps)}</strong></div><div><span>Rest</span><strong>${escape(exercise.rest)}</strong></div><div><span>Level</span><strong>${escape(exercise.level)}</strong></div></div><div class="metric-grid">${metricMarkup(exercise)}</div><p class="detail-score-build"><strong>Score build</strong><span>Weighted baseline ${exercise.weightedBaseline}</span><span>Editorial adjustment ${logic.adjustmentLabel(exercise.editorialAdjustment)}</span></p><div class="detail-columns exercise-guidance"><div><h3>Set up</h3><p class="detail-rationale">${escape(guidance.setup)}</p><h3>Technique cues</h3><ul>${guidance.cues.map(cue=>`<li>${escape(cue)}</li>`).join("")}</ul></div><div><h3>Purpose &amp; working range</h3><p class="detail-rationale">${escape(guidance.purpose)}</p><p class="guidance-prescription"><strong>General catalog range</strong><span>${escape(guidance.prescription)}</span></p><p class="detail-note"><strong>Caution / Common mistake:</strong> ${escape(guidance.mistake)}</p></div></div><section class="guidance-alternatives" aria-labelledby="guidanceAlternativesTitle"><div><h3 id="guidanceAlternativesTitle">Same target, different equipment</h3><p>Equivalent purpose does not mean identical feel. Review the setup and choose the option that matches your available equipment.</p></div><ul>${alternatives}</ul></section><div class="detail-footer"><button class="button button-dark" data-add-planner="${escape(exercise.id)}" type="button">Add to weekly planner<span aria-hidden="true">+</span></button><a class="button detail-youtube" href="${escape(exercise.youtube)}" target="_blank" rel="noreferrer">YouTube tutorials <span aria-hidden="true">▶</span></a>${compareAction}</div></div>`;
      if(focus)openModal(detailDialog);else syncDialogState();
    }
    function openComparison(){
      if(!logic.comparisonAccessIsFresh(state)){syncComparisonAccess();return false;}
      const [left,right]=state.compare.map(id=>state.exercises.find(exercise=>exercise.id===id));if(!left||!right)return;
      const escape=logic.escapeHtml,row=(label,a,b,className="")=>`<tr><th scope="row">${label}</th><td class="${className}">${a}</td><td class="${className}">${b}</td></tr>`;
      el("compareContent").innerHTML=`<div class="compare-table-wrap" role="region" aria-label="${escape(left.name)} and ${escape(right.name)} comparison table" tabindex="0"><table class="compare-table"><caption class="sr-only">Comparison of ${escape(left.name)} and ${escape(right.name)}</caption><thead><tr><th scope="col">Measure</th><th scope="col" class="compare-name">${escape(left.name)}</th><th scope="col" class="compare-name">${escape(right.name)}</th></tr></thead><tbody>${row("FitScore",left.score,right.score,"compare-score")}${row("Weighted baseline",left.weightedBaseline,right.weightedBaseline)}${row("Editorial adjustment",logic.adjustmentLabel(left.editorialAdjustment),logic.adjustmentLabel(right.editorialAdjustment))}${row("Target",escape(left.sub),escape(right.sub))}${row("Equipment",escape(left.equipment),escape(right.equipment))}${row("Level",escape(left.level),escape(right.level))}${row("Stimulus",`${left.metrics.stimulus}/100`,`${right.metrics.stimulus}/100`)}${row("Stability",`${left.metrics.stability}/100`,`${right.metrics.stability}/100`)}${row("Useful range",`${left.metrics.range}/100`,`${right.metrics.range}/100`)}${row("Progression",`${left.metrics.progression}/100`,`${right.metrics.progression}/100`)}${row("Low fatigue",`${left.metrics.fatigue}/100`,`${right.metrics.fatigue}/100`)}</tbody></table></div>`;
      openModal(compareDialog);return true;
    }
    function syncComparisonAccess(){
      const allowed=logic.comparisonAccessIsFresh(state),comparisonWasOpen=compareDialog.open;
      const focusToken=detailFocusToken();
      if(!allowed){el("compareContent").innerHTML="";dialogReturnFocus.delete(compareDialog);if(compareDialog.open)compareDialog.close();}
      renderExercises();updateCompareDock();
      if(detailDialog.open&&activeDetailId){openDetail(activeDetailId,{focus:false});restoreDetailFocus(focusToken);}
      syncDialogState();if(comparisonWasOpen&&!allowed)frame(()=>el("searchInput")?.focus({preventScroll:true}));
    }
    function showToast(message){const toast=el("toast");toast.textContent=message;toast.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove("show"),3000);}

    return{
      closeModal,compareDialog,detailDialog,focusRenderedControl,openComparison,openDetail,previewPlaceholder,previewResultMarkup,
      renderAll,renderExercises,renderSubfilters,renderTabs,restoreModalFocus,showToast,syncComparisonAccess,syncDialogState,updateAccountUI,updateCompareDock,updateEquipmentOptions,updatePreviewEquipmentOptions
    };
  }

  return{createRenderer,previewResultMarkup};
});
