/* global module, require */
(function(root,factory){
  const progress=typeof module==="object"&&module.exports?require("./discover-progress"):root.StrataDiscoverProgress;
  const api=factory(progress);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(Progress){
  "use strict";

  const weekLabel=(date)=>new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(date);
  function createProgressRenderer({element,escapeHtml,exerciseName,readableDate,days}){
    function setHidden(id,hidden){const node=element(id);if(node)node.hidden=hidden;}
    function clearMetrics(){for(const id of ["progressAdherence","progressVolume","progressConsistency","progressSessions"]){const node=element(id);if(node)node.textContent="";}}
    // An HTML column chart keeps week labels readable at every width; each column also names its own value for assistive technology.
    function renderWeeks(weeks,hasMore){
      const node=element("progressWeeks");if(!node)return;
      const top=Math.max(2,...weeks.map((week)=>week.workouts)),note=element("progressWeeksNote");
      node.innerHTML=weeks.map((week)=>{
        const label=week.current?"This week":`Week of ${weekLabel(week.start)}`,summary=`${label}: ${week.workouts} workout${week.workouts===1?"":"s"}${week.volume?` · ${week.volume}`:""}`;
        return `<li class="progress-week${week.current?" is-current":""}${week.workouts?"":" is-empty"}" tabindex="0" aria-label="${escapeHtml(summary)}" title="${escapeHtml(summary)}"><span class="progress-week-track" aria-hidden="true"><span class="progress-week-bar" style="--value:${(week.workouts/top).toFixed(3)}"><b>${week.workouts}</b></span></span><small aria-hidden="true">${escapeHtml(weekLabel(week.start))}</small></li>`;
      }).join("");
      const axis=element("progressWeeksMax");if(axis)axis.textContent=String(top);
      if(note)note.textContent=hasMore?"Based on your 100 most recent sessions.":"Completed workouts per calendar week.";
    }
    function renderRecords(records,hasMore){
      const node=element("progressRecordList");if(!node)return;
      if(!records.length){node.innerHTML=`<p class="progress-empty">${hasMore?"No comparable exercise result appears in the 100 most recent sessions. Open full history for older records.":"Complete a workout with a recorded load, reps, or time to start your exercise records."}</p>`;return;}
      node.innerHTML=records.map((record)=>{
        const change=record.change,best=`${escapeHtml(record.best.metric.formatted)}${record.newBest?" <em>New best</em>":""}`;
        return `<article class="progress-record${record.newBest?" is-new-best":""}"><div class="progress-record-name"><strong>${escapeHtml(exerciseName(record.exerciseId))}</strong><small>${escapeHtml(record.latest.metric.label)} · ${escapeHtml(readableDate(record.latest.workout.date))}</small></div><dl><div><dt>Latest</dt><dd>${escapeHtml(record.latest.metric.formatted)}</dd></div><div class="progress-change is-${change.direction}"><dt>vs last time</dt><dd><span aria-hidden="true">${change.direction==="up"?"↑":change.direction==="down"?"↓":change.direction==="same"?"=":"•"}</span> ${escapeHtml(change.text)}</dd></div><div><dt>Best</dt><dd>${best}</dd></div></dl></article>`;
      }).join("");
    }
    function render({workouts,weeklyPlan,historyAvailable,historyStatus,historyError="",hasMore,now=new Date()}){
      const requestedStatus=["loading","ready","error"].includes(historyStatus)?historyStatus:(historyAvailable?"ready":"error");
      const status=requestedStatus==="ready"&&!historyAvailable?"error":requestedStatus;
      setHidden("progressLoadingState",status!=="loading");setHidden("progressLoadError",status!=="error");setHidden("progressFirstWorkout",true);setHidden("progressHistoryContent",true);
      const retry=element("progressRetry");if(retry)retry.disabled=status==="loading";
      if(status==="loading"){
        const message=element("progressLoadingMessage");if(message)message.textContent="Loading your completed workouts…";
        clearMetrics();return{status};
      }
      if(status==="error"){
        const message=element("progressLoadErrorMessage");if(message)message.textContent=historyError||"We couldn't load workout history. Your saved Plan was not changed.";
        clearMetrics();return{status};
      }
      if(!element("progressAdherence"))return{status};
      const scope=element("progressRecordScope");if(scope)scope.textContent=hasMore?"Within your 100 most recent sessions":"Latest comparable result per exercise";
      const data=Progress.snapshot({workouts,weeklyPlan,days,now,hasMore});
      if(!data.completed.length){setHidden("progressFirstWorkout",false);clearMetrics();return{status,empty:true};}
      setHidden("progressHistoryContent",false);
      element("progressAdherence").textContent=data.adherence;element("progressAdherenceDetail").textContent=data.adherenceDetail;element("progressVolume").textContent=data.volume;element("progressVolumeDetail").textContent=data.volumeDetail;element("progressConsistency").textContent=data.consistency;element("progressConsistencyDetail").textContent=data.consistencyDetail;element("progressSessions").textContent=data.sessions;element("progressSessionsDetail").textContent=data.sessionsDetail;
      renderWeeks(data.weeks,hasMore);renderRecords(data.records,hasMore);
      return{status,empty:false};
    }
    return{render,renderRecords,renderWeeks};
  }

  return{createProgressRenderer};
});
