/* global module */
(function(root,factory){
  "use strict";
  const history=factory();
  if(typeof module==="object"&&module.exports)module.exports=history;
  else root.StrataWorkoutHistory=history;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function create({$,state,workout:W,view,esc,number,exercise,formatLabel,accountRead,saveError,blockSession,renderPlan,mergeMemory,memoryReadyFor,renderSession,loadWorkoutMemory,fetchWorkout,selectWorkout,toast,recover,resetProgression=()=>{},locationLike=globalThis.location,historyLike=globalThis.history}){
    function chartEntries(){
      const result=new Map();
      for(const workout of state.history.filter((item)=>item.status==="completed"))for(const entry of workout.exerciseSummaries||[]){
        if(entry.completedSets>0)result.set(W.formatKey(entry),entry);
      }
      return [...result.entries()].sort((a,b)=>exercise(a[1].exerciseId).name.localeCompare(exercise(b[1].exerciseId).name));
    }

    function renderChartControls(){
      const current=$("chartExercise").value,entries=chartEntries();
      $("chartEmpty").hidden=!!entries.length;$("chartControls").hidden=!entries.length;
      $("chartExercise").innerHTML=entries.map(([key,entry])=>`<option value="${esc(key)}">${esc(exercise(entry.exerciseId).name)} · ${esc(formatLabel(entry))}</option>`).join("");
      if(entries.some(([key])=>key===current))$("chartExercise").value=current;
      renderMetricOptions();
    }

    function renderMetricOptions(){
      const entry=chartEntries().find(([key])=>key===$("chartExercise").value)?.[1],current=$("chartMetric").value;
      $("chartMetric").innerHTML=entry?W.metrics(entry).map((metric)=>`<option value="${metric.key}">${esc(metric.label)} (${esc(metric.unit)})</option>`).join(""):"";
      if(entry&&W.metrics(entry).some((metric)=>metric.key===current))$("chartMetric").value=current;
      renderChart();
    }

    function renderChart(){
      const entry=chartEntries().find(([key])=>key===$("chartExercise").value)?.[1];
      if(!entry){$("performanceChart").innerHTML="";return;}
      const metric=W.metrics(entry).find((item)=>item.key===$("chartMetric").value);
      const points=W.series(state.history,$("chartExercise").value,metric.key),best=W.bestInWindow(points);
      if(!points.length){$("performanceChart").innerHTML="<p class='chart-no-data'>No completed sets in this logging format yet.</p>";return;}
      const top=Math.max(1,best),left=45,right=355,bottom=159,height=125;
      const coords=points.map((point,index)=>({x:points.length===1?200:left+index/(points.length-1)*(right-left),y:bottom-point.value/top*height}));
      const table=points.map((point)=>`<tr><td>${esc(W.displayDate(point.date))}</td><td>${number(point.value)} ${esc(metric.unit)}</td></tr>`).join("");
      $("performanceChart").innerHTML=`<div class="chart-best"><strong>${number(best)} <small>${esc(metric.unit)}</small></strong><span>Best in loaded history</span></div><svg class="chart-svg" viewBox="0 0 375 196" role="img" aria-label="${esc(metric.label)} across ${points.length} completed session${points.length===1?"":"s"}. Best in loaded history: ${number(best)} ${esc(metric.unit)}. Exact values in the table below."><line class="chart-grid" x1="${left}" x2="${right}" y1="34" y2="34"/><line class="chart-grid" x1="${left}" x2="${right}" y1="96.5" y2="96.5"/><line class="chart-baseline" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/><text class="chart-label" x="0" y="38">${number(top)}</text><text class="chart-label" x="0" y="101">${number(top/2)}</text><text class="chart-label" x="0" y="163">0</text>${points.length>1?`<polyline class="chart-line" points="${coords.map((point)=>`${point.x},${point.y}`).join(" ")}"/>`:""}${coords.map((point,index)=>`<circle class="chart-dot" cx="${point.x}" cy="${point.y}" r="5"><title>${esc(W.displayDate(points[index].date))}: ${number(points[index].value)} ${esc(metric.unit)}</title></circle>`).join("")}<text class="chart-label" x="${left}" y="186">${esc(W.displayDate(points[0].date,{weekday:false}))}</text>${points.length>1?`<text class="chart-label" x="${right}" y="186" text-anchor="end">${esc(W.displayDate(points.at(-1).date,{weekday:false}))}</text>`:""}</svg>${points.length===1?"<p class='single-point-note'>Your first data point. Another completed session makes a comparison possible.</p>":"<p class='single-point-note'>Sessions are spaced equally in chronological order.</p>"}<details class="chart-data"><summary>View exact session values</summary><table class="chart-table"><thead><tr><th scope="col">Session date</th><th scope="col">${esc(metric.label)}</th></tr></thead><tbody>${table}</tbody></table></details>`;
      $("chartScope").textContent=`Based on ${points.length} matching completed session${points.length===1?"":"s"} in ${state.history.length} loaded sessions${state.hasMore?"; load more to extend the window":""}. Formats and units are compared separately. ${entry.loadType==="assisted"?"Assistance is excluded from load records; rep comparisons do not account for differing assistance.":entry.loadType==="bodyweight"?"Bodyweight is excluded from external load and volume records.":entry.measurement==="timed"?"Timed sets are measured in seconds and do not generate weight-volume records.":"Volume uses only completed sets with recorded external loads."}`;
    }

    function render(){
      const completed=state.history.filter((item)=>item.status==="completed"),sets=completed.reduce((total,item)=>total+item.completedSets,0),active=state.history.filter((item)=>item.status==="active").length;
      const recoveryIds=new Set(state.recoveries.filter((record)=>record.dirty).map((record)=>record.workout.id));
      const visibleHistory=state.history.filter((item)=>item.status!=="active"||!recoveryIds.has(item.id));
      $("historyStats").hidden=!completed.length;
      $("historyStats").innerHTML=`<div><strong>${completed.length}</strong><span>Completed · loaded history</span></div><div><strong>${sets}</strong><span>Sets in completed sessions</span></div><div><strong>${active}</strong><span>Open · loaded history</span></div>`;
      $("historyList").innerHTML=visibleHistory.length?visibleHistory.map((item)=>`<article class="history-row"><div><span class="status-chip${item.status==="active"?" active":""}">${item.status==="active"?"In progress":"Completed"}</span><h4>${esc(item.title)}</h4><p>${esc(W.displayDate(item.date))} · ${item.completedSets}/${item.totalSets} sets · ${W.duration(item.elapsedSeconds)}</p></div><button type="button" class="button secondary compact" data-history="${esc(item.id)}">${item.status==="active"?"Resume":"View"}</button></article>`).join(""):recoveryIds.size?"<div class='empty-state'><strong>Review your device draft above.</strong>The saved session stays separate until you choose which work to keep.</div>":state.historyLoadError?"<div class='empty-state'><strong>Workout history is unavailable.</strong>Retry before starting another workout.</div>":!state.historyLoaded?"<div class='empty-state'><strong>Loading workout history…</strong>Checking saved workouts before you start.</div>":"<div class='empty-state'><strong>Your story starts with one workout.</strong>Your progress appears after your first completed workout.</div>";
      $("loadMore").hidden=!state.hasMore;$("loadMore").disabled=state.historyBusy;renderChartControls();
    }

    async function load({more=false}={}){
      if(state.historyBusy||state.blocked)return;
      state.historyBusy=true;state.historyLoadError="";renderPlan();render();$("refreshHistory").disabled=true;$("loadMore").disabled=true;$("historyError").hidden=true;
      try{
        const result=await accountRead(`/api/workouts?limit=20&offset=${more?state.offset:0}&memory=1`);
        if(!Array.isArray(result.workouts)||typeof result.hasMore!=="boolean")throw new Error("Workout history returned an incomplete response. Try again.");
        state.historyLoaded=true;
        state.offset=(more?state.offset:0)+result.workouts.length;
        const combined=more?[...state.history,...result.workouts]:result.workouts;
        state.history=[...new Map(combined.map((item)=>[item.id,item])).values()].sort((a,b)=>b.startedAt-a.startedAt);
        if(more)mergeMemory(result.workouts);else{state.memoryHistory=result.workouts;state.memoryExhausted=!result.hasMore;state.memoryError="";resetProgression();}
        state.hasMore=result.hasMore;renderPlan();render();
        if(state.workout){state.memoryReady=memoryReadyFor(state.workout);renderSession();if(!state.memoryReady)void loadWorkoutMemory(state.workout.id);}
      }catch(error){
        if(error.status===401)blockSession();
        state.historyLoadError=error.code==="NETWORK_ERROR"?"Check your connection and retry loading workout history.":saveError(error);
        $("historyError").hidden=false;$("historyError").textContent=state.historyLoadError;render();
      }finally{state.historyBusy=false;$("refreshHistory").disabled=false;$("loadMore").disabled=false;renderPlan();}
    }

    async function openDetail(id){
      if(state.detailBusy||state.blocked)return;
      state.detailBusy=true;
      try{
        const workout=await fetchWorkout(id);if(!workout)throw new Error("This session is no longer in saved history. Refresh the history list.");
        if(workout.status==="active"){
          if(state.workout?.status==="active"&&state.workout.id!==workout.id){toast("Choose Save & close for your current session before switching. You can resume it later.");return;}
          if(state.dirty){toast("Review and save your current device changes before resuming a saved session.");return;}
          selectWorkout(workout);$("sessionPanel").scrollIntoView({block:"start"});return;
        }
        $("detailTitle").textContent=workout.title;$("detailBody").innerHTML=view.detailMarkup(workout);$("detailDialog").showModal();
      }catch(error){toast(saveError(error));}
      finally{state.detailBusy=false;}
    }

    async function openRequested(){
      const prefix="#resume=";
      if(!locationLike.hash.startsWith(prefix))return false;
      let requested="";try{requested=decodeURIComponent(locationLike.hash.slice(prefix.length));}catch{return false;}
      const recoveryIndex=state.recoveries.findIndex((record)=>record.dirty&&record.workout.id===requested);
      const clearRequest=()=>{const url=new URL(locationLike.href);url.hash="";historyLike.replaceState(null,"",url);};
      if(recoveryIndex>=0){await recover(recoveryIndex);clearRequest();return true;}
      const active=state.history.find((item)=>item.id===requested&&item.status==="active");
      if(!active)return false;
      await openDetail(active.id);clearRequest();return true;
    }

    function upsert(summary){
      state.history=[summary,...state.history.filter((item)=>item.id!==summary.id)].sort((a,b)=>b.startedAt-a.startedAt);
      mergeMemory([summary]);render();
    }

    return{chartEntries,renderChartControls,renderMetricOptions,renderChart,render,load,openDetail,openRequested,upsert};
  }

  return{create};
});
