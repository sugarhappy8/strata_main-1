/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverProgram=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  function planFromWeek(week){
    const sessions=week?.training?.sessions;
    if(!Array.isArray(sessions)||!sessions.length)throw new Error("Build a personal training week first.");
    if(week.training.summary?.reviewNeeded)throw new Error("This suggested week has training gaps. Review your equipment and personal setup, or edit your weekly plan directly.");
    const days=Object.fromEntries(DAYS.map(day=>[day,[]]));
    for(const session of sessions){
      if(!DAYS.includes(session.day)||days[session.day].length||!Array.isArray(session.exercises)||!session.exercises.length||session.status==="partial"||session.status==="unavailable")throw new Error("This week needs review before it can become your saved plan.");
      days[session.day]=session.exercises.map((item,index)=>{
        if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(item.exerciseId||""))||!Number.isInteger(item.sets)||item.sets<1||item.sets>10||typeof item.reps!=="string"||!item.reps.trim()||item.reps.length>20)throw new Error("A suggested exercise needs review. Edit your weekly plan directly.");
        return {exerciseId:item.exerciseId,sets:item.sets,reps:item.reps,instanceId:`program-${session.day.toLowerCase()}-${index+1}-${item.exerciseId}`.slice(0,100)};
      });
    }
    const restDays=DAYS.filter(day=>!days[day].length);
    return {version:1,restDay:restDays[0]??null,restDays,days};
  }
  function createController({element,api,state,getWeek,getGeneration,monthly,openDialog,closeDialog,syncPlanViews,onAccountError=()=>false}){
    const el=element;let pending=null,busy=false;
    function reset(){pending=null;busy=false;if(el("programApplyDialog").open)closeDialog("programApplyDialog");el("programApplyStatus").textContent="";el("programTrainLink").hidden=true;el("programApplyError").textContent="";setBusy(false);}
    function setBusy(value){busy=value;el("programApplyDialog").dataset.busy=String(value);el("programApplyDialog").setAttribute("aria-busy",String(value));el("programApplyConfirm").disabled=value;el("programApplyCancel").disabled=value;el("programApplyConfirm").textContent=value?"Saving…":"Use this week";}
    function review(){
      if(busy)return;
      try{
        const week=getWeek(),plan=monthly.normalizeWeeklyPlan(planFromWeek(week),state.exercises);
        pending={plan,week,generation:getGeneration(),userId:state.user?.id,updatedAt:state.weeklyPlanUpdatedAt};
        el("programApplySummary").textContent=DAYS.map(day=>`${day}: ${plan.days[day].length?`${plan.days[day].length} exercises · ${plan.days[day].reduce((sum,item)=>sum+item.sets,0)} sets`:"rest"}`).join("\n");
        el("programApplyError").hidden=true;openDialog(el("programApplyDialog"),el("programApplyCancel"));
      }catch(error){el("programApplyStatus").textContent=error.message;}
    }
    async function save(){
      if(busy||!pending)return;const reviewed=pending;
      const current=()=>reviewed.generation===getGeneration()&&reviewed.userId===state.user?.id;
      if(!current()){reset();return;}
      if(reviewed.week!==getWeek()||reviewed.updatedAt!==state.weeklyPlanUpdatedAt){el("programApplyError").hidden=false;el("programApplyError").textContent="Your plan or profile changed. Close this review and review the suggested week again.";return;}
      setBusy(true);el("programApplyError").hidden=true;
      try{
        const result=await api("/api/plan",{method:"PUT",body:JSON.stringify({plan:reviewed.plan,expectedPlanUpdatedAt:reviewed.updatedAt})});
        if(!current())return;
        state.weeklyPlan=monthly.normalizeWeeklyPlan(result.plan,state.exercises);state.weeklyPlanUpdatedAt=Number(result.planUpdatedAt)||0;syncPlanViews({invalidateSession:true});
        closeDialog("programApplyDialog");pending=null;el("programApplyStatus").textContent="Saved. Open Train to start a workout from this week, or edit the week in the planner.";el("programTrainLink").hidden=false;
      }catch(error){
        if(!current()||onAccountError(error))return;
        if(error.code==="PLAN_CHANGED"&&error.payload?.plan){state.weeklyPlan=monthly.normalizeWeeklyPlan(error.payload.plan,state.exercises);state.weeklyPlanUpdatedAt=Number(error.payload.planUpdatedAt)||0;syncPlanViews({invalidateSession:true});}
        el("programApplyError").hidden=false;el("programApplyError").textContent=error.code==="PLAN_CHANGED"?"Your saved week changed elsewhere. Close this review and review the latest week before replacing it.":error.message||"Could not save. Your current week is unchanged. Try again.";
      }finally{if(current())setBusy(false);}
    }
    el("programApply").addEventListener("click",review);el("programApplyConfirm").addEventListener("click",()=>{void save();});
    el("programApplyDialog").addEventListener("cancel",event=>{if(busy)event.preventDefault();});
    return {reset,review,save};
  }
  return {createController,planFromWeek};
});
