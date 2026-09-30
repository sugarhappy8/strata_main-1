/* global module */
(function(root,factory){
  "use strict";
  const context=factory();
  if(typeof module==="object"&&module.exports)module.exports=context;
  else root.StrataWorkoutContext=context;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function activeWorkout(state){
    return state.workout?.status==="active"?state.workout:state.recoveries.find((record)=>record.dirty&&record.workout.status==="active")?.workout||state.history.find((item)=>item.status==="active")||null;
  }

  function create({$,state,workout:W,view,esc,openDetail,recover}){
    function render(){
      const items=state.plan?.days?.[state.day]||[],hasWeek=W.DAYS.some((day)=>(state.plan?.days?.[day]||[]).length),active=activeWorkout(state);
      const currentIndex=Math.max(0,W.DAYS.indexOf(state.day)),scheduledDay=[...W.DAYS.slice(currentIndex+1),...W.DAYS.slice(0,currentIndex)].find((day)=>(state.plan?.days?.[day]||[]).length);
      const start=$("startWorkout"),resume=$("resumeWorkout"),choose=$("chooseScheduledDay"),build=$("openPlannerFromEmpty"),edit=$("editWorkoutWeek"),brief=$("planBrief"),preview=$("planPreviewDetails"),waiting=state.historyBusy||!state.historyLoaded;
      $("planDay").innerHTML=W.DAYS.map((day)=>`<option value="${day}"${day===state.day?" selected":""}>${day}${day===W.today()?" · today":""}</option>`).join("");
      $("todayLabel").textContent=active?"Workout in progress":state.day===W.today()?`Today · ${W.displayDate(W.localDate())}`:"Selected plan day";
      $("planDayField").hidden=!hasWeek||!!active;edit.hidden=!hasWeek||!!active;
      start.hidden=true;resume.hidden=!active;choose.hidden=true;build.hidden=true;$("differentWorkout").hidden=true;
      start.disabled=state.blocked||waiting||!!state.historyLoadError;resume.disabled=state.blocked||state.detailBusy||state.historyBusy;
      $("trainHistoryNotice").hidden=!state.historyLoadError||!items.length||!!active;$("trainHistoryMessage").textContent=state.historyLoadError?"Workout history could not be loaded. Retry before starting another workout.":"";
      preview.hidden=true;preview.open=false;brief.hidden=true;brief.innerHTML="";$("planPreview").innerHTML="";$("startHint").textContent="";

      if(active){
        const counts=Array.isArray(active.entries)?W.progress(active):{completed:Number(active.completedSets)||0,total:Number(active.totalSets)||0};
        $("startTitle").textContent=active.title;$("planStatus").textContent=`${W.displayDate(active.date)} · ${counts.completed} of ${counts.total} sets logged.`;
        $("startHint").textContent=state.recoveries.some((record)=>record.dirty&&record.workout.id===active.id)?"Resume to review your device changes and the latest saved workout.":"Continue your existing workout before starting another.";
        return;
      }
      if(!hasWeek){
        $("todayLabel").textContent="Your weekly plan";$("startTitle").textContent="Build your first week.";$("planStatus").textContent="You have not built a weekly plan yet.";build.hidden=false;return;
      }

      $("startTitle").textContent=state.day===W.today()?"Today’s workout":`${state.day} workout`;
      if(!items.length){
        $("startTitle").textContent="Recovery day.";$("planStatus").textContent="Nothing is scheduled for this day.";$("startHint").textContent=scheduledDay?`${scheduledDay} is the next day with a planned workout.`:"Choose another day or edit your weekly plan.";
        if(scheduledDay){choose.hidden=false;choose.dataset.day=scheduledDay;choose.innerHTML=`Go to ${scheduledDay} <span aria-hidden="true">→</span>`;}else delete choose.dataset.day;
        return;
      }

      const summary=W.planDaySummary(state.plan,state.day);
      $("planStatus").textContent="Scheduled in your weekly plan.";start.hidden=false;start.innerHTML='Start workout <span aria-hidden="true">↗</span>';$("differentWorkout").hidden=false;
      preview.hidden=false;brief.hidden=false;brief.innerHTML=`<div><span>Exercises</span><strong>${summary.movements}</strong></div><div><span>Working sets</span><strong>${summary.workingSets}</strong></div><div><span>Plan day</span><strong>${esc(summary.day)}</strong></div>`;
      $("planPreview").innerHTML=view.planPreview(items);$("startHint").textContent=state.historyLoadError?"":waiting?"Checking for a workout in progress…":"Review the summary, then start when you are ready.";
    }

    async function resume(){
      if(state.blocked||state.detailBusy||state.historyBusy)return;
      const active=activeWorkout(state);if(!active)return;
      const recoveryIndex=state.recoveries.findIndex((record)=>record.dirty&&record.workout.id===active.id);
      if(recoveryIndex>=0)await recover(recoveryIndex);else await openDetail(active.id);
    }

    function focusPrimary(){
      ["resumeWorkout","startWorkout","chooseScheduledDay","openPlannerFromEmpty","planDay"].map($).find((element)=>element&&!element.hidden&&!element.disabled)?.focus();
    }

    return{render,resume,focusPrimary};
  }

  return{activeWorkout,create};
});
