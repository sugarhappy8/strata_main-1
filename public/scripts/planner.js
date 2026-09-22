"use strict";

const INSIGHTS=globalThis.StrataPlanInsights;
const LOGIC=globalThis.StrataPlannerLogic;
const STATE=globalThis.StrataPlannerState;
const API=globalThis.StrataPlannerApi;
const RENDER=globalThis.StrataPlannerRender;
const EVENTS=globalThis.StrataPlannerEvents;
const CONFLICTS=globalThis.StrataPlannerConflicts;
const TEMPLATES=globalThis.StrataPlannerTemplates;
const SHARING=globalThis.StrataPlannerSharing;
const ACTIVATION=globalThis.StrataPlannerActivation;
if(!LOGIC||!STATE||!API||!RENDER||!EVENTS||!CONFLICTS||!TEMPLATES||!SHARING||!ACTIVATION)throw new Error("Planner modules are unavailable. Reload Plan to try again.");
const DAYS=LOGIC.DAYS;
const GROUPS=LOGIC.GROUPS;
const LIBRARY_DESKTOP_PAGE_SIZE=32;
const LIBRARY_MOBILE_PAGE_SIZE=16;
const SEARCH_DEBOUNCE_MS=180;
const GUEST_PLAN_KEY="strata_guest_plan_v1";
const MAX_DAY_ITEMS=LOGIC.MAX_DAY_ITEMS;
const MAX_WEEK_ITEMS=LOGIC.MAX_WEEK_ITEMS;
const state=STATE.createState({desktopPageSize:LIBRARY_DESKTOP_PAGE_SIZE});
const el=(id)=>document.getElementById(id);
const signal=name=>globalThis.StrataSignals?.record?.(name);
const apiClient=API.createClient({
  fetchImpl:(...args)=>fetch(...args),
  getSession:()=>({guest:state.guest,csrfToken:state.csrfToken,userId:state.user?.id}),
  verifyIdentity:()=>verifyPlannerIdentity(),
  onAccountChanged:()=>lockChangedAccount()
});

async function api(path,options={}){return apiClient.request(path,options);}

function lockChangedAccount(){
  persistAccountDraft();state.accountChanged=true;state.csrfToken="";state.entitlementStatus="unavailable";clearTimeout(state.saveTimer);clearTimeout(state.entitlementTimer);state.entitlementTimer=null;
  el("plannerShell").inert=true;el("accountChangedNotice").hidden=false;
  el("accountChangedDetails").textContent=state.draftStorageError?"Keep this page open and export your week. Reload to open the currently signed-in account.":"Your week is retained as a device draft for its original account. Export it if needed, then reload to open the currently signed-in account.";
  if(state.plan){renderSummary();renderPlannerModeNotice();}
}
async function verifyPlannerIdentity(){
  if(state.guest)return;
  if(state.accountChanged)throw Object.assign(new Error("The signed-in account changed. Reload before saving."),{status:409,code:"ACCOUNT_CHANGED"});
  const identity=await api("/api/me",{cache:"no-store"});
  if(!identity.user?.id||String(identity.user.id)!==String(state.user?.id)){lockChangedAccount();throw Object.assign(new Error("The signed-in account changed. Your previous account's week has not been sent."),{status:409,code:"ACCOUNT_CHANGED"});}
  state.csrfToken=String(identity.csrfToken||state.csrfToken||"");
}

function planSaveError(error){return LOGIC.saveErrorMessage(error);}

function escapeHtml(value){return RENDER.escapeHtml(value);}
function exerciseById(id){return state.exercises.find((exercise)=>exercise.id===id);}
function itemByInstance(day,instanceId){return state.plan?.days?.[day]?.find((item)=>item.instanceId===instanceId);}
function makeId(){return globalThis.crypto?.randomUUID?.()||`item-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
function restDays(plan=state.plan){return LOGIC.restDays(plan);}
function isRestDay(day,plan=state.plan){return LOGIC.isRestDay(plan,day);}
function updateRestDays(plan,days){return LOGIC.updateRestDays(plan,days);}
function emptyPlan(){return LOGIC.emptyPlan();}
function guestPlan(){
  let input=null;
  state.guestRaw=null;
  try{state.guestRaw=localStorage.getItem(GUEST_PLAN_KEY);input=JSON.parse(state.guestRaw||"null");}catch{/* Use a clean local plan if storage is malformed or unavailable. */}
  const plan=emptyPlan(),known=new Set(state.exercises.map((exercise)=>exercise.id)),seen=new Set();
  updateRestDays(plan,input?restDays(input):["Sunday"]);
  for(const day of DAYS){
    const items=Array.isArray(input?.days?.[day])?input.days[day]:[];
    // Keep earlier oversized drafts intact so people can remove/export items.
    plan.days[day]=items.flatMap((item)=>{
      if(!item||!known.has(String(item.exerciseId||"")))return[];
      let instanceId=String(item.instanceId||makeId()).replace(/[^a-zA-Z0-9_-]/g,"").slice(0,100)||makeId();
      if(seen.has(instanceId))instanceId=makeId();
      seen.add(instanceId);
      const sets=Math.max(1,Math.min(10,Math.round(Number(item.sets)||3)));
      const reps=String(item.reps||"8–12").trim().slice(0,20)||"8–12";
      return[{instanceId,exerciseId:String(item.exerciseId),sets,reps}];
    });
  }
  return plan;
}
async function saveGuestPlan(plan,expectedRaw){
  const raw=JSON.stringify(plan);
  const write=()=>{
    let current;
    try{current=localStorage.getItem(GUEST_PLAN_KEY);}catch{throw new Error("This browser blocked local storage, so the plan could not be saved.");}
    if(current!==expectedRaw)throw Object.assign(new Error("Your free device week changed in another tab."),{code:"GUEST_PLAN_CHANGED"});
    try{localStorage.setItem(GUEST_PLAN_KEY,raw);}catch{throw new Error("This browser blocked local storage, so the plan could not be saved.");}
    return raw;
  };
  // All cooperating guest-week writers use this lock. Without Web Locks the
  // raw comparison remains best effort; account plans retain server-side CAS.
  return globalThis.navigator?.locks?.request?await navigator.locks.request("strata-guest-week-save",write):write();
}
function copyPlan(plan){return LOGIC.copyPlan(plan);}
function validateWeekPlan(plan,{limits=true}={}){
  return LOGIC.validateWeekPlan(plan,new Set(state.exercises.map(exercise=>exercise.id)),{limits});
}
const conflictActions=CONFLICTS.createController({
  state,el,storage:localStorage,makeId,copyPlan,validateWeekPlan,planMovementCount,planConflictSummary,escapeHtml,
  readSelectedDay:STATE.readSelectedDay,persistSelectedDay,selectionContext:plannerSelectionContext,api,renderWeek,renderLibrary,renderUndo,setSaveStatus,showToast,focusSoon,
  offerDevicePlan:()=>activationActions.offerDevicePlan()
});
const{persistAccountDraft,clearSavedDraft,selectRecoveredDraft,offerRecoveredDraft,clearPlanConflict,recoverPlanConflict,reviewConflictDraft,keepLatestPlan}=conflictActions;
function renderUndo(){const button=el("undoPlanRemoval");button.disabled=!state.ready||!state.undoRemoval||Boolean(state.conflictDraft);}
function removeItem(day,instanceId){
  if(!state.ready||state.conflictDraft||!DAYS.includes(day))return false;
  const items=state.plan.days[day],index=items.findIndex((item)=>item.instanceId===instanceId);
  if(index<0)return false;
  const item=items[index],next=items[index+1]||items[index-1];
  state.undoRemoval={day,index,item:copyPlan(item)};items.splice(index,1);
  renderWeek(next?instanceSelector("data-item-day",next.instanceId):`#day-title-${DAYS.indexOf(day)}`);queueSave();renderUndo();
  showToast(`${exerciseById(item.exerciseId)?.name||"Exercise"} removed. Undo is available.`);return true;
}
function undoLastRemoval(){
  const removed=state.undoRemoval;
  if(!state.ready||!removed||state.conflictDraft)return false;
  const {day,index,item}=removed;
  if(DAYS.some((key)=>state.plan.days[key].some((entry)=>entry.instanceId===item.instanceId))){state.undoRemoval=null;renderUndo();showToast("This exercise is already in your week.");return false;}
  if(state.plan.days[day].length>=MAX_DAY_ITEMS||planMovementCount()>=MAX_WEEK_ITEMS){showToast("Make room in this day and week before restoring the exercise.");return false;}
  const removedRest=isRestDay(day);updateRestDays(state.plan,restDays().filter(name=>name!==day));
  state.plan.days[day].splice(Math.min(index,state.plan.days[day].length),0,copyPlan(item));state.undoRemoval=null;
  renderWeek(instanceSelector("data-item-day",item.instanceId));renderLibrary();queueSave();renderUndo();
  showToast(removedRest?`Exercise restored; ${day} is open for training.`:"Removed exercise restored.");return true;
}
function openReplacement(day,instanceId){
  const item=itemByInstance(day,instanceId);if(!state.ready||state.conflictDraft||!item)return false;
  state.replacement={day,instanceId,exerciseId:item.exerciseId,revision:state.revision};
  el("replaceExerciseSearch").value="";
  el("replaceExerciseDescription").textContent=`Replace ${exerciseById(item.exerciseId)?.name||"this exercise"} on ${day}. Keep ${item.sets} sets × ${item.reps}. Review the prescription for the new movement.`;
  renderReplacementOptions();el("replaceExerciseDialog").showModal();focusSoon("#replaceExerciseSearch");return true;
}
function renderReplacementOptions(){
  const query=el("replaceExerciseSearch").value.trim().toLowerCase(),current=el("replaceExerciseSelect").value;
  const exercises=state.exercises.filter((exercise)=>exercise.id!==state.replacement?.exerciseId&&(!query||`${exercise.name} ${exercise.sub} ${exercise.equipment}`.toLowerCase().includes(query)));
  el("replaceExerciseSelect").innerHTML='<option value="">Choose a replacement</option>'+exercises.map((exercise)=>`<option value="${escapeHtml(exercise.id)}">${escapeHtml(exercise.name)} · ${escapeHtml(exercise.equipment)}</option>`).join("");
  el("replaceExerciseSelect").value=exercises.some((exercise)=>exercise.id===current)?current:"";
  el("replaceExerciseStatus").textContent=`${exercises.length} matching movements. Your sets and reps will be retained.`;
  el("confirmReplaceExercise").disabled=!el("replaceExerciseSelect").value;
}
function confirmReplacement(){
  const pending=state.replacement,id=el("replaceExerciseSelect").value,item=pending&&itemByInstance(pending.day,pending.instanceId);
  if(!pending||!state.ready||state.conflictDraft||state.revision!==pending.revision||!item||item.exerciseId!==pending.exerciseId){el("replaceExerciseStatus").textContent="Your week changed while this dialog was open. Close it and choose the exercise again.";return false;}
  if(!exerciseById(id)||id===item.exerciseId)return false;
  item.exerciseId=id;state.replacement=null;el("replaceExerciseDialog").close();renderWeek(instanceSelector("data-replace-item",item.instanceId));queueSave();showToast("Exercise replaced. Sets and reps were retained; adjust them for this movement.");return true;
}
const templateActions=TEMPLATES.createController({
  state,el,storage:localStorage,days:DAYS,makeId,escapeHtml,validateWeekPlan,planConflictSummary,firstTrainingDay:STATE.firstTrainingDay,persistSelectedDay,renderWeek,renderLibrary,queueSave,renderUndo,showToast,focusSoon
});
const{weekTemplates,openTemplates,saveWeekTemplate,previewTemplate,importWeekTemplate,useWeekTemplate,deleteWeekTemplate}=templateActions;
function focusSoon(selector){if(!selector)return;requestAnimationFrame(()=>document.querySelector(selector)?.focus());}
function instanceSelector(attribute,instanceId){return `[${attribute}="${String(instanceId).replace(/[^a-zA-Z0-9_-]/g,"")}"]`;}

function setReady(ready){
  state.ready=ready;
  el("plannerSearch").disabled=!ready;
  el("exportWeeklyPlan").disabled=!ready;
  el("shareWeeklyPlan").disabled=!ready;
  el("retryPlanSave").disabled=!ready;
  if(!ready)el("retryPlanSave").hidden=true;
  el("manageWeekTemplates").disabled=!ready;
  renderUndo();
  renderResetWeek();
  el("plannerShell").setAttribute("aria-busy",String(!ready));
  el("libraryPanel").setAttribute("aria-busy",String(!ready));
  el("weekBoard").setAttribute("aria-busy",String(!ready));
}

function renderDayNav(){
  const nav=el("plannerDayNav");
  if(!state.plan){nav.innerHTML="";return;}
  el("quickAddDayValue").textContent=state.selectedDay;
  nav.innerHTML=RENDER.dayNavMarkup(DAYS,{selectedDay:state.selectedDay,restDays:restDays()});
  renderMobileHandoff();
}

function plannerSelectionContext(){return{guest:state.guest,userId:state.user?.id};}
function persistSelectedDay(){return STATE.writeSelectedDay(localStorage,plannerSelectionContext(),state.plan,state.selectedDay);}
function renderMobileHandoff(){
  if(!state.plan)return;
  const handoff=LOGIC.selectedDayHandoff(state.plan,state.selectedDay);
  el("mobileAddDestination").textContent=handoff.addLabel;
  el("mobileWeekLink").textContent=handoff.viewLabel;
  el("mobileWeekLink").href=`#day-title-${DAYS.indexOf(handoff.day)}`;
}

function downloadWeeklyPlan(){
  if(!state.ready||!state.plan)return;
  const exported={format:"strata-weekly-plan",version:1,exportedAt:new Date().toISOString(),plan:state.plan};
  const blob=new Blob([JSON.stringify(exported,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=`strata-weekly-plan-${new Date().toISOString().slice(0,10)}.json`;link.hidden=true;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast("Weekly plan downloaded. Import it from Week templates or in Strata+.");
}

function planMovementCount(plan=state.plan){
  return LOGIC.planMovementCount(plan);
}

function nextScheduledDay(plan=state.plan,now=new Date()){
  return LOGIC.nextScheduledDay(plan,now);
}

const shareActions=SHARING.createController({
  state,el,api,escapeHtml,planMovementCount,restDays,hasRestConflict,verifyIdentity:verifyPlannerIdentity,lockChangedAccount,flushSave,showToast,focusSoon,browserWindow:window
});
const{renderShareAccess,loadSharedPlans,openSharePanel,closeSharePanel,publishWeeklyPlan,unpublishSharedPlan}=shareActions;

function renderFilters(focusGroup=null){
  el("plannerFilters").innerHTML=RENDER.filterMarkup(GROUPS,state.group);
  if(focusGroup)focusSoon(`[data-library-group="${focusGroup}"]`);
}

function filteredExercises(){
  return LOGIC.filterExercises(state.exercises,{group:state.group,query:state.query});
}

function libraryPageSize(){return window.matchMedia?.("(max-width: 760px)")?.matches?LIBRARY_MOBILE_PAGE_SIZE:LIBRARY_DESKTOP_PAGE_SIZE;}
function resetLibraryWindow(){state.libraryLimit=libraryPageSize();}

function renderLibrary(){
  const items=filteredExercises(),visibleItems=items.slice(0,state.libraryLimit);
  el("libraryCount").textContent=items.length;
  el("libraryResultStatus").textContent=items.length?`Showing ${visibleItems.length} of ${items.length} matching movement${items.length===1?"":"s"}.`:`No matching movements.`;
  el("libraryList").innerHTML=RENDER.libraryMarkup(items,{selectedDay:state.selectedDay,visibleLimit:state.libraryLimit,pageSize:libraryPageSize()});
  renderMobileHandoff();
}

let exerciseGuideTrigger=null;
function openExerciseGuide(id,trigger=null){
  const exercise=exerciseById(id),guidance=globalThis.StrataDiscovery?.exerciseGuidance?.(exercise,state.exercises);
  if(!exercise||!guidance){showToast("This exercise guide is unavailable. Try reloading Plan.");return;}
  const dialog=el("exerciseGuideDialog");
  if(!dialog.open)exerciseGuideTrigger=trigger;
  el("exerciseGuideTitle").textContent=exercise.name;
  el("exerciseGuideBody").innerHTML=`<p class="guide-purpose">${escapeHtml(guidance.purpose)}</p><div class="guide-grid"><section><span>01 / Set up</span><p>${escapeHtml(guidance.setup)}</p></section><section><span>02 / Working range</span><p>${escapeHtml(guidance.prescription)}</p></section><section><span>03 / Technique cues</span><ul>${guidance.cues.map((cue)=>`<li>${escapeHtml(cue)}</li>`).join("")}</ul></section><section class="guide-caution"><span>04 / Caution / Common mistake</span><p>${escapeHtml(guidance.mistake)}</p></section></div><section class="guide-swaps"><h3>Same target, different equipment</h3><p>Choose a swap only when its setup fits your available equipment.</p><div>${guidance.alternatives.map(({exercise:alternative,reason})=>`<button type="button" data-guide-exercise="${escapeHtml(alternative.id)}"><strong>${escapeHtml(alternative.name)}</strong><span>${escapeHtml(alternative.equipment)} · ${escapeHtml(reason)}</span></button>`).join("")}</div></section>`;
  if(!dialog.open)dialog.showModal();requestAnimationFrame(()=>el("exerciseGuideTitle").focus());
}

function renderWeek(focusSelector=null){
  el("weekBoard").innerHTML=RENDER.weekBoardMarkup({plan:state.plan,days:DAYS,selectedDay:state.selectedDay,restDays:restDays(),exerciseById});
  renderDayNav();
  renderSummary();
  renderUndo();
  renderResetWeek();
  focusSoon(focusSelector);
}

function renderSummary(){
  const total=DAYS.reduce((sum,day)=>sum+state.plan.days[day].length,0);
  const trainingDays=DAYS.filter((day)=>state.plan.days[day].length).length;
  const totalSets=DAYS.reduce((sum,day)=>sum+state.plan.days[day].reduce((count,item)=>count+Number(item.sets||0),0),0);
  const restConflict=hasRestConflict();
  const peak=Math.max(1,...DAYS.map((day)=>state.plan.days[day].length));
  const distribution=DAYS.map((day)=>`${day}: ${state.plan.days[day].length} exercises`).join(", ");
  const next=nextScheduledDay();
  const plusActive=STATE.hasConfirmedPlusAccess(state);
  let readiness=null;
  if(plusActive&&restConflict)readiness={tone:"needs-attention",label:"Plan check",title:"Clear the recovery conflict.",detail:`Move exercises off ${restDays().filter((day)=>state.plan.days[day].length).join(", ")} before this week can save cleanly.`,action:"",href:""};
  else if(plusActive&&!total)readiness={tone:"getting-started",label:"Next move",title:"Build your first training day.",detail:"Choose a destination day, then add one movement from the library. Sets and reps remain editable.",action:"Choose a movement",href:"#libraryPanel"};
  else if(plusActive){
    const noRecovery=restDays().length===0;
    const nextDetail=`${next?.isToday?"Today":`Next scheduled: ${next?.day||"your plan"}`} · ${next?.movements||total} movement${(next?.movements||total)===1?"":"s"}.${noRecovery?" Consider marking an open day for recovery.":" Changes save automatically."}`;
    readiness={
      tone:noRecovery?"review-recovery":"ready",label:noRecovery?"Recovery check":"Train-ready",title:noRecovery?"Your week is built. Recovery is unmarked.":"Your week is ready to train.",
      detail:nextDetail,action:`Review ${next?.day||DAYS.find((day)=>state.plan.days[day].length)} workout`,href:`/workout.html?day=${encodeURIComponent(next?.day||DAYS.find((day)=>state.plan.days[day].length))}`
    };
  }
  el("weekSummary").innerHTML=`<div class="summary-stat"><span>Scheduled movements</span><strong>${total}</strong></div><div class="summary-stat"><span>Training days</span><strong>${trainingDays}</strong></div><div class="summary-stat"><span>Working sets</span><strong>${totalSets}</strong></div><div class="summary-stat ${restConflict?"summary-warning":""}"><span>Rest days</span><strong>${restDays().length}${restConflict?" · clear":""}</strong></div><div class="week-distribution" role="img" aria-label="Weekly exercise distribution. ${distribution}">${DAYS.map((day)=>`<div aria-hidden="true"><span>${state.plan.days[day].length}</span><div class="week-bar-track"><i style="height:${Math.max(3,state.plan.days[day].length/peak*100)}%" class="${isRestDay(day)?"is-rest":""}"></i></div><small>${day.slice(0,3)}</small></div>`).join("")}</div>${readiness?`<section class="week-readiness ${readiness.tone}" aria-label="Plan guidance"><div><span>${readiness.label}</span><strong>${readiness.title}</strong><p>${readiness.detail}</p></div>${readiness.href?`<a href="${readiness.href}">${readiness.action} <span aria-hidden="true">→</span></a>`:""}</section>`:""}`;
  renderInsights();
}

function renderPlannerModeNotice(){
  const notice=el("plannerModeNotice"),confirmed=STATE.hasConfirmedPlusAccess(state);
  const oversized=state.plan&&(DAYS.some(day=>state.plan.days[day].length>MAX_DAY_ITEMS)||planMovementCount()>MAX_WEEK_ITEMS);
  notice.hidden=false;notice.innerHTML=RENDER.modeNoticeMarkup({guest:state.guest,status:state.entitlementStatus,confirmed,oversized});
}
function scheduleEntitlementRefresh({retry=false}={}){
  clearTimeout(state.entitlementTimer);state.entitlementTimer=null;
  if(state.guest||state.accountChanged)return;
  const delay=retry?STATE.entitlementRetryDelay(++state.entitlementFailureCount):STATE.entitlementRefreshDelay(state.user);if(delay)state.entitlementTimer=setTimeout(()=>{state.entitlementTimer=null;void refreshEntitlement({force:true});},delay);
}

function refreshEntitlement({force=false}={}){
  if(!state.ready||state.guest||state.accountChanged||!state.user?.id)return Promise.resolve(false);
  if(state.entitlementRefreshPromise)return state.entitlementRefreshPromise;if(!force&&Date.now()-state.entitlementCheckedAt<1000)return Promise.resolve(true);
  const expectedUserId=String(state.user.id),requestId=++state.entitlementRequest;state.entitlementStatus="checking";renderSummary();renderPlannerModeNotice();
  const operation=(async()=>{try{
    const result=await api("/api/me",{cache:"no-store"});if(requestId!==state.entitlementRequest)return false;
    if(!result.user?.id||String(result.user.id)!==expectedUserId){lockChangedAccount();return false;}
    state.user=result.user;state.csrfToken=String(result.csrfToken||state.csrfToken||"");state.entitlementStatus="ready";state.entitlementCheckedAt=Date.now();state.entitlementFailureCount=0;scheduleEntitlementRefresh();renderSummary();renderPlannerModeNotice();return true;
  }catch(error){if(requestId!==state.entitlementRequest)return false;state.entitlementStatus="unavailable";state.entitlementCheckedAt=Date.now();renderSummary();renderPlannerModeNotice();if(error.status===401)lockChangedAccount();else scheduleEntitlementRefresh({retry:true});return false;}
  finally{if(state.entitlementRefreshPromise===operation)state.entitlementRefreshPromise=null;}})();
  state.entitlementRefreshPromise=operation;return operation;
}

function renderResetWeek(){el("resetWeeklyPlan").disabled=!state.ready||!state.plan||state.accountChanged||Boolean(state.conflictDraft)||Boolean(state.conflictReview)||LOGIC.isDefaultPlan(state.plan);}
function openResetWeek(trigger){
  if(el("resetWeeklyPlan").disabled)return;
  const movements=planMovementCount(),recovery=restDays();
  state.resetWeekSnapshot={revision:state.revision,plan:JSON.stringify(state.plan)};state.resetWeekTrigger=trigger;
  el("resetWeekImpact").textContent=`This will remove ${movements} scheduled movement${movements===1?"":"s"}${recovery.length?` and replace ${recovery.length} recovery marker${recovery.length===1?"":"s"}`:""}.`;
  el("resetWeekStatus").textContent="Nothing has changed.";el("confirmResetWeek").disabled=false;
  el("resetWeekDialog").showModal();focusSoon("#resetWeekDialogTitle");
}
function closeResetWeek(){if(el("resetWeekDialog").open)el("resetWeekDialog").close();}
function confirmResetWeek(){
  const snapshot=state.resetWeekSnapshot;
  if(!snapshot||!state.ready||state.accountChanged||state.conflictDraft||state.conflictReview)return false;
  if(snapshot.revision!==state.revision||snapshot.plan!==JSON.stringify(state.plan)){el("resetWeekStatus").textContent="Your week changed after this confirmation opened. Cancel and review it again.";el("confirmResetWeek").disabled=true;return false;}
  state.resetWeekSnapshot=null;state.resetWeekTrigger=null;state.plan=emptyPlan();state.selectedDay=STATE.firstTrainingDay(state.plan);state.undoRemoval=null;state.replacement=null;persistSelectedDay();
  el("resetWeekDialog").close();renderWeek("#weekTitle");renderLibrary();queueSave();showToast("Week reset. All scheduled movements were cleared; follow the save status for confirmation.");return true;
}

function insightRows(entries,emptyMessage){
  const rows=entries.slice(0,6),peak=Math.max(1,...rows.map((entry)=>Number(entry.sets)||0));
  return rows.length?rows.map((entry)=>`<div class="insight-row"><span>${escapeHtml(entry.label)}</span><div aria-hidden="true"><i style="width:${Math.max(3,(Number(entry.sets)||0)/peak*100)}%"></i></div><strong>${Number(entry.sets)||0} sets</strong></div>`).join(""):`<p class="insight-empty">${escapeHtml(emptyMessage)}</p>`;
}

function syncCopyDayOptions(){
  const source=el("copySourceDay"),target=el("copyTargetDay"),previousSource=source.value,previousTarget=target.value;
  const defaultSource=state.plan&&DAYS.find((day)=>state.plan.days[day].length)||"Monday";
  const sourceDay=DAYS.includes(previousSource)?previousSource:defaultSource;
  source.innerHTML=DAYS.map((day)=>`<option value="${day}"${day===sourceDay?" selected":""}>${day} · ${state.plan?.days?.[day]?.length||0} movements</option>`).join("");
  const targets=DAYS.filter((day)=>day!==sourceDay),nextDay=DAYS[(DAYS.indexOf(sourceDay)+1)%DAYS.length],targetDay=targets.includes(previousTarget)?previousTarget:nextDay;
  target.innerHTML=targets.map((day)=>`<option value="${day}"${day===targetDay?" selected":""}>${day} · ${state.plan?.days?.[day]?.length||0} movements${isRestDay(day)?" · recovery day":""}</option>`).join("");
  el("previewCopyDay").disabled=!state.ready||!state.plan?.days?.[sourceDay]?.length;
}

function renderInsights(){
  if(!INSIGHTS||!state.plan){el("planInsights").hidden=true;return;}
  el("planInsights").hidden=false;
  const analysis=INSIGHTS.analyzePlan(state.plan,state.exercises),largest=analysis.days.reduce((best,day)=>day.workingSets>best.workingSets?day:best,analysis.days[0]);
  el("insightMetrics").innerHTML=`<div><span>Planning estimate</span><strong>${analysis.metrics.estimatedMinutes} min</strong><small>sets + transitions</small></div><div><span>Largest day</span><strong>${largest.workingSets?escapeHtml(largest.day):"—"}</strong><small>${largest.workingSets} working sets</small></div><div><span>Primary areas</span><strong>${analysis.muscles.length}</strong><small>catalog groups</small></div><div><span>Equipment setups</span><strong>${analysis.equipment.length}</strong><small>across the week</small></div>`;
  el("insightMuscles").innerHTML=insightRows(analysis.muscles,"Add movements to see primary-muscle distribution.");
  el("insightPatterns").innerHTML=insightRows(analysis.patterns,"Add movements to see pattern distribution.");
  el("insightEquipment").innerHTML=insightRows(analysis.equipment,"Add movements to see equipment concentration.");
  el("insightAlerts").innerHTML=analysis.alerts.length?analysis.alerts.map((alert)=>`<article class="insight-alert ${escapeHtml(alert.tone)}"><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.detail)}</p><span>${escapeHtml(alert.action)}</span></article>`).join(""):'<article class="insight-alert clear"><strong>No obvious structure conflicts</strong><p>The current week has no observable density, duplicate, high-frequency, or recovery-marker flags.</p><span>Review, then train</span></article>';
  el("insightNextAction").textContent=analysis.nextAction;
  syncCopyDayOptions();
}

function openCopyDayPreview(trigger){
  if(!state.ready||!INSIGHTS||state.accountChanged||state.conflictDraft)return;
  const sourceDay=el("copySourceDay").value,targetDay=el("copyTargetDay").value,mode=el("copyDayMode").value;
  try{
    const preview=INSIGHTS.copyDayPreview(state.plan,sourceDay,targetDay,{mode});
    const skippedNames=preview.skipped.map((id)=>exerciseById(id)?.name||id),before=state.plan.days[targetDay].length,after=preview.plan.days[targetDay].length;
    state.copyPreview={...preview,baseRevision:state.revision,basePlan:JSON.stringify(state.plan)};state.copyTrigger=trigger;
    el("copyDayDialogDescription").textContent=`${sourceDay} → ${targetDay}. This is a preview; your editable week has not changed.`;
    el("copyDayPreview").innerHTML=`<div class="copy-preview-counts"><div><span>Destination now</span><strong>${before}</strong><small>movements</small></div><div><span>After approval</span><strong>${after}</strong><small>movements</small></div><div><span>New copies</span><strong>${preview.added}</strong><small>new identities</small></div></div><p><strong>${mode==="replace"?"Replace":"Add missing"}:</strong> ${mode==="replace"?`${preview.replaced} destination movement${preview.replaced===1?"":"s"} will be replaced by copies from ${escapeHtml(sourceDay)}.`:`Existing movements stay; matching exercise IDs are not duplicated.`}</p>${skippedNames.length?`<p><strong>Already present:</strong> ${skippedNames.map(escapeHtml).join(", ")}.</p>`:""}${isRestDay(targetDay)?`<p><strong>Recovery marker:</strong> ${escapeHtml(targetDay)} will become a training day.</p>`:""}`;
    el("confirmCopyDay").checked=false;el("applyCopyDay").disabled=true;el("copyDayStatus").textContent=preview.changed?"No changes applied. Confirm only after reviewing this preview.":"The destination already matches this copy.";
    el("confirmCopyDay").disabled=!preview.changed;
    el("copyDayDialog").showModal();requestAnimationFrame(()=>el("copyDayDialogTitle").focus());
  }catch(error){showToast(error.message||"This day copy could not be previewed.");}
}

function closeCopyDayPreview(){
  if(el("copyDayDialog").open)el("copyDayDialog").close();
}

function applyCopyDayPreview(){
  const preview=state.copyPreview;
  if(!preview||!el("confirmCopyDay").checked)return;
  if(preview.baseRevision!==state.revision||preview.basePlan!==JSON.stringify(state.plan)){
    el("copyDayStatus").textContent="Your week changed after this preview. Close it and review a fresh copy.";el("applyCopyDay").disabled=true;return;
  }
  const targetDay=preview.targetDay,added=preview.added;
  state.plan=copyPlan(preview.plan);state.undoRemoval=null;state.copyPreview=null;
  el("copyDayDialog").close();renderWeek();renderLibrary();queueSave();
  showToast(`${preview.sourceDay} copied to ${targetDay}. ${added} movement${added===1?"":"s"} added; follow the save status for confirmation.`);
  requestAnimationFrame(()=>el("previewCopyDay").focus());
}

function hasRestConflict(){return restDays().some(day=>state.plan?.days?.[day]?.length);}

function repairLegacyRestDay(){
  const before=restDays();updateRestDays(state.plan,before.filter(day=>!state.plan.days[day].length));
  return before.length!==restDays().length;
}

function setRestDay(day){
  if(!state.ready||!DAYS.includes(day))return false;
  const removing=isRestDay(day);
  if(!removing&&state.plan.days[day].length){showToast(`Move exercises off ${day} before making it a rest day.`);return false;}
  updateRestDays(state.plan,removing?restDays().filter(name=>name!==day):[...restDays(),day]);
  if(removing)state.selectedDay=day;
  else if(state.selectedDay===day)state.selectedDay=DAYS.find(name=>!isRestDay(name))||"Monday";
  persistSelectedDay();
  renderWeek(`[data-set-rest="${day}"]`);renderLibrary();queueSave();
  showToast(removing?`${day} is open for training.`:`${day} set as a rest day.`);
  return true;
}

function prepareRecoveryForTarget(day){
  if(!isRestDay(day))return{ok:true};
  showToast(`Remove the rest day on ${day} before adding exercises.`);
  return{ok:false};
}

function addExercise(exerciseId,day){
  if(!state.ready||!DAYS.includes(day))return false;
  const exercise=exerciseById(exerciseId);
  if(!exercise)return false;
  if(state.plan.days[day].length>=MAX_DAY_ITEMS){showToast(`${day} can hold up to ${MAX_DAY_ITEMS} exercises. Remove one before adding another.`);return false;}
  if(DAYS.reduce((total,key)=>total+state.plan.days[key].length,0)>=MAX_WEEK_ITEMS){showToast(`Your week can hold up to ${MAX_WEEK_ITEMS} exercises. Remove one before adding another.`);return false;}
  const recovery=prepareRecoveryForTarget(day);
  if(!recovery.ok)return false;
  const setMatch=String(exercise.sets||"").match(/\d+/);
  state.plan.days[day].push({instanceId:makeId(),exerciseId,sets:Number(setMatch?.[0]||3),reps:String(exercise.reps||"8–12")});
  renderWeek();
  queueSave();
  showToast(`${exercise.name} added to ${day}.`);
  return true;
}

function moveItem(sourceDay,targetDay,instanceId,{focus=true}={}){
  if(!state.ready||!DAYS.includes(sourceDay)||!DAYS.includes(targetDay))return false;
  if(sourceDay===targetDay)return false;
  if(state.plan.days[targetDay].length>=MAX_DAY_ITEMS){showToast(`${targetDay} can hold up to ${MAX_DAY_ITEMS} exercises. Remove one before moving this exercise.`);renderWeek(focus?instanceSelector("data-item-day",instanceId):null);return false;}
  const source=state.plan.days[sourceDay],index=source.findIndex((item)=>item.instanceId===instanceId);
  if(index<0)return false;
  const [item]=source.splice(index,1);
  const recovery=prepareRecoveryForTarget(targetDay);
  if(!recovery.ok){source.splice(index,0,item);return false;}
  state.plan.days[targetDay].push(item);
  if(isRestDay(state.selectedDay)){state.selectedDay=targetDay;persistSelectedDay();}
  renderWeek(focus?instanceSelector("data-item-day",instanceId):null);
  renderLibrary();
  queueSave();
  const exercise=exerciseById(item.exerciseId);
  showToast(`${exercise?.name||"Exercise"} moved to ${targetDay}.`);
  return true;
}

function moveWithinDay(day,instanceId,direction){
  const items=state.plan.days[day],index=items.findIndex((item)=>item.instanceId===instanceId),next=index+direction;
  if(index<0||next<0||next>=items.length)return false;
  [items[index],items[next]]=[items[next],items[index]];
  renderWeek(instanceSelector("data-item-day",instanceId));
  queueSave();
  return true;
}

function queueSave(){
  if(!state.ready)return;
  state.revision+=1;
  persistAccountDraft();
  clearTimeout(state.saveTimer);
  if(hasRestConflict()){setSaveStatus("Clear recovery day to save",true);return;}
  if(state.conflictReview){setSaveStatus("Review recovered changes · save when ready",true);return;}
  setSaveStatus("Saving…");
  state.saveTimer=setTimeout(()=>{void flushSave();},500);
}

function setSaveStatus(message,error=false){
  const status=el("saveStatus"),retry=el("retryPlanSave");
  status.textContent=message;
  status.parentElement.classList.toggle("error",error);
  retry.removeAttribute("title");
  if(state.conflictDraft){retry.textContent="Review my changes";retry.hidden=false;return;}
  if(state.conflictReview){retry.textContent="Save reviewed changes";retry.hidden=false;return;}
  retry.textContent="Retry";
  retry.hidden=!(error&&state.ready&&state.savedRevision<state.revision&&!hasRestConflict());
}

function planConflictSummary(plan){
  return RENDER.planConflictSummaryMarkup({plan,days:DAYS,restDays:restDays(plan),exerciseById,movementCount:planMovementCount(plan)});
}

const activationActions=ACTIVATION.createController({
  state,el,storage:localStorage,activation:globalThis.StrataActivation,logic:LOGIC,escapeHtml,planMovementCount,validateWeekPlan,planConflictSummary,
  renderActivationOverview:RENDER.activationOverviewMarkup,flushSave,api,readSelectedDay:STATE.readSelectedDay,selectionContext:plannerSelectionContext,persistSelectedDay,clearSavedDraft,
  renderWeek,renderLibrary,setSaveStatus,showToast,focusSoon,signal
});
const{setActivationStatus,renderActivationCandidate,hideActivationPanel,offerDevicePlan,toggleActivationComparison,keepAccountActivationPlan,claimActivationPlan}=activationActions;

async function performSave({keepalive=true,silent=false}={}){
  if(state.savePromise)return state.savePromise;
  if(!state.ready||state.savedRevision>=state.revision)return true;
  const revision=state.revision,guest=state.guest,expectedGuestRaw=state.guestRaw,snapshot=copyPlan(state.plan),payload=JSON.stringify({plan:snapshot,expectedPlanUpdatedAt:state.planUpdatedAt,expectedUserId:String(state.user?.id||"")});
  setSaveStatus("Saving…");
  const operation=(async()=>{
    // Defer both the account and guest branches until savePromise owns this
    // operation. Without the yield, a synchronous guest save can clear the
    // field before assignment and leave an already-resolved promise stuck in it.
    await Promise.resolve();
    try{
      let result;
      if(guest){
        const savedRaw=await saveGuestPlan(snapshot,expectedGuestRaw);
        state.guestRaw=savedRaw;
        result={plan:JSON.parse(savedRaw),planUpdatedAt:state.planUpdatedAt};
      }else result=await api("/api/plan",{method:"PUT",body:payload,keepalive});
      state.savedRevision=Math.max(state.savedRevision,revision);
      if(state.revision===revision)state.plan=result.plan;
      state.planUpdatedAt=Number(result.planUpdatedAt)||state.planUpdatedAt;state.lastSaveError=null;
      if(state.savedRevision===state.revision)clearSavedDraft();else persistAccountDraft();
      if(state.conflictReview&&state.savedRevision===state.revision)clearPlanConflict();
      setSaveStatus(state.savedRevision===state.revision?"Saved":"Saving…");
      signal("plan_saved");
      return true;
    }catch(error){
      let saveError=error;
      if(!state.guest&&error.status===409&&error.code==="PLAN_CHANGED"){
        try{await recoverPlanConflict(error,{silent});return false;}
        catch(recoveryError){saveError=recoveryError;}
      }
      persistAccountDraft();
      state.lastSaveError=saveError;
      const detail=planSaveError(saveError);
      if(saveError.code==="GUEST_PLAN_CHANGED"){
        // Keep the local week available to export; adopting the newer raw here
        // would let a later retry silently replace another tab's saved week.
        el("plannerModeNotice").innerHTML=`<strong>Guest save conflict.</strong> ${escapeHtml(detail)}`;
      }
      setSaveStatus("Couldn't save — Retry",true);
      el("retryPlanSave").title=detail;
      if(!silent)showToast(detail);
      return false;
    }finally{
      state.savePromise=null;
    }
  })();
  state.savePromise=operation;
  return operation;
}

async function flushSave(options={}){
  clearTimeout(state.saveTimer);
  if(state.conflictDraft){
    setSaveStatus("Plan changed elsewhere · latest copy loaded",true);
    if(!options.silent)showToast("Review your unsaved changes before saving over the newer account plan.");
    return false;
  }
  if(state.conflictReview&&!options.confirmConflict){
    setSaveStatus("Review recovered changes · save when ready",true);
    if(!options.silent)showToast("Review your recovered changes, then choose Save reviewed changes.");
    return false;
  }
  if(hasRestConflict()){
    setSaveStatus("Clear recovery day to save",true);
    if(!options.silent)showToast(`Move all exercises off ${restDays().join(", ")} before saving.`);
    return false;
  }
  while(state.ready&&state.savedRevision<state.revision){
    const saved=await performSave(options);
    if(!saved)return false;
  }
  return true;
}

function sendKeepaliveSave(){
  if(!state.ready||state.savedRevision>=state.revision||state.conflictDraft||state.conflictReview||hasRestConflict())return;
  clearTimeout(state.saveTimer);
  // Reuse the tracked save operation so beforeunload and pagehide cannot
  // launch two compare-and-swap writes with the same account revision. The
  // flush loop also follows an older in-flight save with any newer edit.
  void flushSave({keepalive:true,silent:true});
}

let toastTimer;
function showToast(message){
  const toast=el("plannerToast");
  toast.textContent=message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.classList.remove("show"),3200);
}

function handlePendingAdd(){
  const id=new URLSearchParams(location.search).get("add");
  if(!id||!exerciseById(id))return;
  const day=DAYS.includes(state.selectedDay)&&!isRestDay(state.selectedDay)?state.selectedDay:DAYS.find(name=>!isRestDay(name));
  if(!day){showToast("Remove a rest day to choose where this exercise should go.");return;}
  state.selectedDay=day;
  persistSelectedDay();
  if(!addExercise(id,day))return;
  history.replaceState({},"","/planner.html");
}

function renderLoadError(error){
  const message=escapeHtml(error.message||"Unable to load your plan.");
  el("libraryCount").textContent="0";
  el("plannerFilters").innerHTML="";
  el("libraryList").innerHTML=`<div class="loading">${message}</div>`;
  el("libraryResultStatus").textContent="Exercise library could not be loaded.";
  el("plannerDayNav").innerHTML="";
  el("quickAddDayValue").textContent="Unavailable";
  el("weekSummary").innerHTML="";
  const localOption=error.code==="NETWORK_ERROR"&&state.exercises.length?'<p>You can open the separate free plan stored in this browser while offline. Account plans need a connection.</p><button type="button" data-open-guest>Open free device plan</button>':"";
  el("weekBoard").innerHTML=`<div class="planner-load-state planner-error" role="alert"><strong>Plan unavailable</strong><p>${message}</p><button type="button" data-retry-init>Try again</button>${localOption}</div>`;
  el("weekBoard").setAttribute("aria-busy","false");
}

function updatePrescriptionInput(event,{normalize=false}={}){
  const column=event.target.closest("[data-day]");
  if(!column||!state.ready)return false;
  const day=column.dataset.day;
  let item,field,value;
  if(event.target.dataset.itemSets){
    item=itemByInstance(day,event.target.dataset.itemSets);field="sets";
    if(!item)return false;
    const raw=String(event.target.value).trim();
    if(!raw&&!normalize)return false;
    const numeric=Number(raw),normalized=Math.max(1,Math.min(10,Number.isFinite(numeric)&&raw?Math.round(numeric):1));
    value=normalized;
    if(normalize)event.target.value=String(normalized);
  }else if(event.target.dataset.itemReps){
    item=itemByInstance(day,event.target.dataset.itemReps);field="reps";
    if(!item)return false;
    value=String(event.target.value).trim().slice(0,20)||"8–12";
    if(normalize)event.target.value=value;
  }else return false;
  if(item[field]===value)return false;
  item[field]=value;
  renderSummary();queueSave();
  return true;
}

function restoreExerciseGuideFocus(){const trigger=exerciseGuideTrigger;exerciseGuideTrigger=null;requestAnimationFrame(()=>trigger?.focus?.());}

function bindPlannerUIEvents(){
  EVENTS.bindPlannerEvents({document,window,location,el,state,searchDebounceMs:SEARCH_DEBOUNCE_MS,actions:{
    api,init,addExercise,moveItem,persistSelectedDay,renderLibrary,renderFilters,resetLibraryWindow,openExerciseGuide,instanceSelector,renderWeek,showToast,openReplacement,removeItem,setRestDay,moveWithinDay,libraryPageSize,unpublishSharedPlan,updatePrescriptionInput,
    downloadWeeklyPlan,undoLastRemoval,openResetWeek,closeResetWeek,confirmResetWeek,openTemplates,saveWeekTemplate,weekTemplates,previewTemplate,importWeekTemplate,useWeekTemplate,deleteWeekTemplate,syncCopyDayOptions,openCopyDayPreview,applyCopyDayPreview,closeCopyDayPreview,renderReplacementOptions,confirmReplacement,restoreExerciseGuideFocus,selectRecoveredDraft,
    setSaveStatus,flushSave,reviewConflictDraft,keepLatestPlan,renderActivationCandidate,toggleActivationComparison,setActivationStatus,keepAccountActivationPlan,claimActivationPlan,openSharePanel,closeSharePanel,publishWeeklyPlan,loadSharedPlans,sendKeepaliveSave,refreshEntitlement
  }});
}

async function init({guestOnly=false}={}){
  state.entitlementRequest+=1;state.entitlementRefreshPromise=null;clearTimeout(state.entitlementTimer);state.entitlementTimer=null;state.entitlementStatus="unknown";state.entitlementFailureCount=0;
  setReady(false);
  if(el("copyDayDialog").open)el("copyDayDialog").close();
  if(el("resetWeekDialog").open)el("resetWeekDialog").close();
  state.resetWeekSnapshot=null;state.resetWeekTrigger=null;
  state.copyPreview=null;state.copyTrigger=null;
  hideActivationPanel();
  setSaveStatus("Loading plan…");
  el("libraryList").innerHTML='<div class="loading">Loading movements…</div>';
  el("weekSummary").innerHTML="";
  el("weekBoard").innerHTML='<div class="planner-load-state">Loading your weekly plan…</div>';
  try{
    const exercises=await api("/exercises.json?v=8.5.0");
    if(!Array.isArray(exercises))throw new Error("STRATA returned an incomplete exercise library.");
    state.exercises=exercises;
    let result;
    try{result=guestOnly?{plan:guestPlan(),user:null}:await api("/api/plan");}
    catch(error){if(error.status!==401)throw error;result={plan:guestPlan(),user:null};}
    if(!result.plan?.days)throw new Error("STRATA returned an incomplete plan.");
    state.plan=result.plan;state.user=result.user;state.guest=!result.user?.id;state.csrfToken=String(result.csrfToken||"");state.planUpdatedAt=Number(result.planUpdatedAt)||0;state.sharedPlans=[];state.sharedPlansLoaded=false;state.sharedPlansRequest=0;state.shareBusy=false;state.pendingUnpublish="";state.entitlementStatus=state.guest?"guest":"ready";state.entitlementCheckedAt=Date.now();
    clearPlanConflict();
    state.accountChanged=false;el("accountChangedNotice").hidden=true;el("draftStorageNotice").hidden=true;state.undoRemoval=null;state.draftKey="";state.draftValue="";state.recoverySource=null;state.recoveredDrafts=[];
    state.revision=0;state.savedRevision=0;state.savePromise=null;state.lastSaveError=null;
    const storedAccountPlan=copyPlan(state.plan);
    const repairedRest=repairLegacyRestDay();
    state.selectedDay=STATE.readSelectedDay(localStorage,plannerSelectionContext(),state.plan);
    el("userName").textContent="Account";
    if(!state.guest&&result.user.name)el("userName").setAttribute("aria-label",`${result.user.name} account`);
    else el("userName").removeAttribute("aria-label");
    el("userName").hidden=state.guest;
    el("logoutButton").hidden=state.guest;
    el("plannerSignIn").hidden=!state.guest;
    renderPlannerModeNotice();
    setReady(true);
    resetLibraryWindow();renderFilters();renderLibrary();renderWeek();renderShareAccess();setSaveStatus("Saved");scheduleEntitlementRefresh();
    if(!state.guest)void loadSharedPlans();
    if(!state.guest){const renderedPlan=state.plan;state.plan=storedAccountPlan;const recovered=offerRecoveredDraft();if(recovered){renderWeek();renderLibrary();return;}state.plan=renderedPlan;}
    if(repairedRest){queueSave();showToast("Scheduled exercises preserved. Conflicting rest markers removed.");}
    handlePendingAdd();
    if(!state.guest)offerDevicePlan();
  }catch(error){
    state.ready=false;state.entitlementStatus="unavailable";clearTimeout(state.entitlementTimer);state.entitlementTimer=null;
    el("plannerSearch").disabled=true;el("exportWeeklyPlan").disabled=true;el("shareWeeklyPlan").disabled=true;
    el("plannerShell").setAttribute("aria-busy","false");el("libraryPanel").setAttribute("aria-busy","false");
    setSaveStatus("Unable to load",true);renderLoadError(error);
  }
}

bindPlannerUIEvents();
init();
