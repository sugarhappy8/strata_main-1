"use strict";

const Core=globalThis.StrataDiscovery;
if(!Core)throw new Error("The Strata+ engine did not load.");
const Monthly=globalThis.StrataMonthlyPlan;
if(!Monthly)throw new Error("The Strata+ monthly-plan engine did not load.");
const BlockCore=globalThis.StrataTrainingBlock;
if(!BlockCore)throw new Error("The Strata+ training-block engine did not load.");
const StateCore=globalThis.StrataDiscoverState;
if(!StateCore)throw new Error("The Strata+ state module did not load.");
const ApiCore=globalThis.StrataDiscoverApi;
if(!ApiCore)throw new Error("The Strata+ API module did not load.");
const NavigationCore=globalThis.StrataDiscoverNavigation;
if(!NavigationCore)throw new Error("The Strata+ navigation module did not load.");
const ProgressCore=globalThis.StrataDiscoverProgress;
if(!ProgressCore)throw new Error("The Strata+ progress module did not load.");
const RenderCore=globalThis.StrataDiscoverRender;if(!RenderCore)throw new Error("The Strata+ rendering module did not load.");
const EventsCore=globalThis.StrataDiscoverEvents;if(!EventsCore)throw new Error("The Strata+ event module did not load.");
const CatalogCore=globalThis.StrataDiscoverCatalog;if(!CatalogCore)throw new Error("The Strata+ catalog module did not load.");
const DetailCore=globalThis.StrataDiscoverDetail;if(!DetailCore)throw new Error("The Strata+ detail module did not load.");
const CommunityCore=globalThis.StrataDiscoverCommunity;if(!CommunityCore)throw new Error("The Strata+ community module did not load.");
const SessionCore=globalThis.StrataDiscoverSession;if(!SessionCore)throw new Error("The Strata+ session module did not load.");
const SharingCore=globalThis.StrataDiscoverSharing;if(!SharingCore)throw new Error("The Strata+ sharing module did not load.");
const CoachingDiaryUi=globalThis.StrataPersonalTrainingDiaryUi;if(!CoachingDiaryUi)throw new Error("The personal-training diary module did not load.");
const CoachingUi=globalThis.StrataPersonalTrainingUi;if(!CoachingUi)throw new Error("The Strata+ personal-training input module did not load.");
const CoachingMealsUi=globalThis.StrataPersonalTrainingMealsUi;if(!CoachingMealsUi)throw new Error("The Strata+ food-preference input module did not load.");
const CoachingRender=globalThis.StrataDiscoverCoachingRender;if(!CoachingRender)throw new Error("The Strata+ coaching renderer did not load.");
const CoachingMealsCore=globalThis.StrataDiscoverCoachingMeals;if(!CoachingMealsCore)throw new Error("The Strata+ food-options controller did not load.");
const CoachingCore=globalThis.StrataDiscoverCoaching;if(!CoachingCore)throw new Error("The Strata+ coaching controller did not load.");
const {FEATURE_CONFIG,FEATURE_DEFAULT,GROUP_LABELS,LIMITATION_OPTIONS,MOVEMENT_BOARD_STORAGE_PREFIX,PREFERENCE_OPTIONS}=StateCore;
const EXPLORER_DESKTOP_PAGE_SIZE=StateCore.LIMITS.explorerDesktopPageSize;
const EXPLORER_MOBILE_PAGE_SIZE=StateCore.LIMITS.explorerMobilePageSize;
const SEARCH_DEBOUNCE_MS=StateCore.LIMITS.searchDebounceMs;
const RATINGS_REFRESH_MIN_INTERVAL_MS=StateCore.LIMITS.ratingsRefreshMinIntervalMs;
const COMMUNITY_PAGE_SIZE=StateCore.LIMITS.communityPageSize;
const MOVEMENT_BOARD_LIMIT=StateCore.LIMITS.movementBoard;
const state=StateCore.createState();
let workspaceGeneration=0,workspaceReady=false,workspaceRevalidating=false;
const el=(id)=>document.getElementById(id);
const api=ApiCore.createClient({fetchImpl:fetch,getCsrfToken:()=>state.csrfToken,getGeneration:()=>workspaceGeneration,redirect:(path)=>window.location.replace(path)});
const saveRetryMessage=ApiCore.saveRetryMessage;
function redirectedOrChangedAccount(error){
  if(error?.redirecting){clearPrivateWorkspace();return true;}
  if(["ACCOUNT_CHANGED","TRAINING_ACCOUNT_CHANGED","COACHING_ACCOUNT_CHANGED"].includes(error?.code)){dashboardAccountChanged();return true;}
  return false;
}

function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));}
function exerciseById(id){return state.exercises.find((exercise)=>exercise.id===id);}
function titleCase(value){return String(value).replace(/(^|[- /])\w/g,(match)=>match.toUpperCase());}
function movementBoardStorageKey(){return `${MOVEMENT_BOARD_STORAGE_PREFIX}:${String(state.user?.id||"member")}`;}
function loadMovementBoard(){
  try{state.shortlist=Core.normalizeShortlist(JSON.parse(globalThis.localStorage?.getItem(movementBoardStorageKey())||"[]"),state.exercises,MOVEMENT_BOARD_LIMIT);}
  catch{state.shortlist=[];}
}
function saveMovementBoard(){
  try{globalThis.localStorage?.setItem(movementBoardStorageKey(),JSON.stringify(state.shortlist));return true;}
  catch{return false;}
}
const toastController=NavigationCore.createToastController(el("toast"));
function showToast(message){toastController.show(message);}
function hideToast(){toastController.hide();}
const coachingMeals=CoachingMealsCore.createController({document,element:el,api,state,ui:CoachingMealsUi,assertAccountResponse:ApiCore.assertAccountResponse,onAccountError:redirectedOrChangedAccount});
const coaching=CoachingCore.createController({document,element:el,api,state,ui:CoachingUi,diaryUi:CoachingDiaryUi,meals:coachingMeals,assertAccountResponse:ApiCore.assertAccountResponse,renderFactory:CoachingRender.createRenderer,saveRetryMessage,showToast,onAccountError:redirectedOrChangedAccount,navigate:(name,options)=>activateFeature(name,options)});
const featureNavigation=NavigationCore.createFeatureNavigation({
  config:FEATURE_CONFIG,defaultFeature:FEATURE_DEFAULT,state,document,window,
  onDestinationChange:(name,previous)=>{hideToast();if(name==="coaching")coaching.setReturnFeature(previous);},
  onActivate:(name)=>{
    const scoreGuide=el("scoreGuide"),showScoreGuide=["explore","recommendations","library","battle"].includes(name);if(scoreGuide)scoreGuide.hidden=!showScoreGuide;if(!showScoreGuide&&el("scoreGuideDetails"))el("scoreGuideDetails").open=false;
    if(state.user&&["recommendations","library","battle"].includes(name))void refreshCommunityRatings().catch(()=>{});
    if(state.user&&name==="community"&&!state.communityLoaded&&!state.communityLoading)void loadCommunityPlans({reset:true});
    if(state.user&&["coaching","plan","nutrition"].includes(name))void coaching.ensureLoaded();
  }
});
function featureName(value){return featureNavigation.featureName(value);}
function activateFeature(value,options={}){return featureNavigation.activate(value,options);}
function initializeFeatureNavigation(){return featureNavigation.initialize();}
const round=Core.round;
function aggregateFor(id){return state.aggregate.get(id)||null;}
const setupLabel=Core.setupLabel;
const resistanceProfile=Core.resistanceProfile;
const practicality=Core.practicality;
function factorWeights(){return Core.factorWeights(state.methodology);}
function weightedBaseline(exercise){return Core.weightedBaseline(exercise,state.methodology);}
function scoreAdjustment(exercise){return Core.scoreAdjustment(exercise,state.methodology);}
function personalResult(exercise){return Core.personalResult(exercise,state.preferences);}
function alternativesFor(exercise){return Core.alternativesFor(exercise,state.exercises,state.preferences,4);}

const catalog=CatalogCore.createCatalog({
  state,core:Core,labels:GROUP_LABELS,preferenceOptions:PREFERENCE_OPTIONS,limitationOptions:LIMITATION_OPTIONS,movementBoardLimit:MOVEMENT_BOARD_LIMIT,
  desktopPageSize:EXPLORER_DESKTOP_PAGE_SIZE,mobilePageSize:EXPLORER_MOBILE_PAGE_SIZE,ratingsRefreshInterval:RATINGS_REFRESH_MIN_INTERVAL_MS,
  document,window,element:el,escapeHtml,exerciseById,titleCase,personalResult,aggregateFor,api,getGeneration:()=>workspaceGeneration,saveMovementBoard,showToast,
  openDetail:(...args)=>openDetail(...args),openComparison:(...args)=>openComparison(...args)
});
const {communityLabel,communitySummary,explorerPageSize,movementBoardButton,personalLabel,profileReason,populateFilters,ratingAverage,readBattleBuilder,refreshCommunityRatings,renderCommunityViews,renderCompareTray,renderExplorer,renderMovementBoard,renderProfile,renderRecommendations,resetExplorerWindow,toggleCompare,toggleMovementBoard}=catalog;

const detail=DetailCore.createDetail({
  state,core:Core,labels:GROUP_LABELS,element:el,escapeHtml,exerciseById,titleCase,round,factorWeights,weightedBaseline,scoreAdjustment,personalResult,alternativesFor,
  profileReason,personalLabel,movementBoardButton,aggregateFor,communitySummary,communityLabel,ratingAverage,setupLabel,resistanceProfile,practicality,
  openDialog:(...args)=>openDialog(...args),showToast
});
const {comparisonWinner,openComparison,openDetail}=detail;

const dialogReturnFocus=new WeakMap();
function syncDialogState(){document.body.classList.toggle("dialog-open",[...document.querySelectorAll("dialog")].some((dialog)=>dialog.open));}
function queueDialogFocus(control){if(!control?.focus)return;if(typeof globalThis.requestAnimationFrame==="function")globalThis.requestAnimationFrame(()=>control.focus());else control.focus();}
function rememberDialogFocus(dialog){
  const active=document.activeElement;
  if(active&&active!==document.body&&typeof active.focus==="function"&&!dialog.contains?.(active))dialogReturnFocus.set(dialog,active);
}
function restoreDialogFocus(dialog){
  if(!dialog)return;
  const control=dialogReturnFocus.get(dialog);dialogReturnFocus.delete(dialog);
  if(control&&control.isConnected!==false&&!control.hidden&&!control.disabled)queueDialogFocus(control);
}
function openDialog(dialog,initialFocus){
  if(!dialog?.open){rememberDialogFocus(dialog);dialog.showModal?.();}
  syncDialogState();queueDialogFocus(initialFocus||dialog.querySelector?.("[data-close-dialog],button,[href],input,select,textarea"));
}
function closeDialog(id){const dialog=el(id);if(dialog?.open)dialog.close();syncDialogState();restoreDialogFocus(dialog);}

const community=CommunityCore.createCommunity({
  state,monthly:Monthly,element:el,document,escapeHtml,exerciseById,titleCase,api,getGeneration:()=>workspaceGeneration,pageSize:COMMUNITY_PAGE_SIZE,
  weeklyPlanCount,openDialog,closeDialog,syncSessionPlanViews:(...args)=>syncSessionPlanViews(...args),saveRetryMessage,showToast
});
const program=globalThis.StrataDiscoverProgram.createController({element:el,api,state,getWeek:()=>coaching.state.week,getGeneration:()=>workspaceGeneration,monthly:Monthly,openDialog,closeDialog,syncPlanViews:(options)=>syncSessionPlanViews(options),onAccountError:redirectedOrChangedAccount});
const {applyCommunityPlan,loadCommunityPlans,openCommunityApplyDialog,renderCommunityPlans}=community;

function blankMonthlySchedule(){
  const training={Monday:["chest","triceps"],Wednesday:["back","biceps"],Friday:["legs","glutes"],Saturday:["shoulders","core"]};
  return Object.fromEntries(Monthly.DAYS.map((day)=>[day,{rest:!training[day],targets:training[day]||[],sourceItems:[]}]))
}
function copyMonthlyValue(value){return JSON.parse(JSON.stringify(value));}
function weeklyPlanCount(plan){return Monthly.DAYS.reduce((total,day)=>total+(Array.isArray(plan?.days?.[day])?plan.days[day].length:0),0);}
function localDateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
function localNoon(date,offset=0){return new Date(date.getFullYear(),date.getMonth(),date.getDate()+offset,12);}
function weekContext(now=new Date()){
  const today=localNoon(now),todayIndex=(today.getDay()+6)%7,monday=localNoon(today,-todayIndex),dates=Monthly.DAYS.map((day,index)=>({day,date:localNoon(monday,index)}));
  return{today,todayIndex,monday,dates,dateKeys:new Set(dates.map(({date})=>localDateKey(date)))};
}
function safeWorkoutList(value){return ProgressCore.safeWorkoutList(value);}
function completedWorkouts(){return ProgressCore.completedWorkouts(state.workouts);}
function completedThisWeek(week=weekContext()){return completedWorkouts().filter((workout)=>week.dateKeys.has(String(workout.date||"")));}
function scheduledDays(){return ProgressCore.scheduledDays(state.weeklyPlan,Monthly.DAYS);}
function nextPlannedDay(week=weekContext()){
  const completeDays=new Set(completedThisWeek(week).map((workout)=>String(workout.planDay||"")));
  for(let offset=0;offset<14;offset+=1){
    const day=Monthly.DAYS[(week.todayIndex+offset)%7],items=Array.isArray(state.weeklyPlan?.days?.[day])?state.weeklyPlan.days[day]:[];
    if(items.length&&(offset>=7||!completeDays.has(day)))return{day,items,offset,date:localNoon(week.today,offset)};
  }
  return null;
}
function formatDuration(seconds){return ProgressCore.formatDuration(seconds);}
function summaryMetric(summary){return ProgressCore.summaryMetric(summary);}
function exerciseName(id){return exerciseById(id)?.name||titleCase(String(id||"movement").replace(/_/g,"-"));}
function readableDate(value){
  if(typeof value!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value))return "saved session";
  const date=new Date(`${value}T12:00:00`);return Number.isNaN(date.getTime())?"saved session":new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric"}).format(date);
}
function estimatedSessionMinutes(items){
  const sets=items.reduce((total,item)=>total+Math.max(0,Math.min(10,Math.round(Number(item?.sets)||0))),0);
  return Math.max(15,Math.min(90,Math.round((sets*2.5+items.length*2)/5)*5));
}
function equipmentSummary(values){const equipment=[...new Set(values.filter(Boolean))];return equipment.length>2?`${equipment.slice(0,2).join(" + ")} +${equipment.length-2} more`:equipment.join(" + ");}
function previousComparable(items){
  const ids=new Set(items.map((item)=>String(item?.exerciseId||"")));
  for(const workout of completedWorkouts())for(const summary of workout.exerciseSummaries){
    if(!ids.has(String(summary.exerciseId||"")))continue;
    const metric=summaryMetric(summary);if(metric)return{workout,summary,metric};
  }
  return null;
}
function renderPreviousComparable(items){
  const previous=previousComparable(items),partial=state.workoutHistoryHasMore;el("todayPreviousLabel").textContent=partial?"Previous comparable · 100 most recent":"Previous comparable performance";
  if(previous){el("todayPreviousValue").textContent=`${exerciseName(previous.summary.exerciseId)} · ${previous.metric.formatted}`;el("todayPreviousDetail").textContent=`${previous.metric.label} in ${previous.workout.title||"a workout"} on ${readableDate(previous.workout.date)}. ${partial?"Found in the 100 most recent sessions; ":""}compare the same format and unit.`;return;}
  el("todayPreviousValue").textContent=partial?"Nothing comparable in the 100 most recent sessions":"Nothing comparable logged yet";el("todayPreviousDetail").textContent=partial?"Older sessions are not included here. Complete one of these movements or open full history for more context.":"Complete one of these movements to establish a like-for-like baseline.";
}
function renderPlanOverview(pulse){
  if(!el("planWorkspaceDays"))return;
  const days=pulse.scheduledDays,exercises=weeklyPlanCount(state.weeklyPlan),sets=Monthly.DAYS.flatMap((day)=>state.weeklyPlan?.days?.[day]||[]).reduce((total,item)=>total+Math.max(0,Number(item?.sets)||0),0),hasWeek=days>0;
  el("planWorkspaceDays").textContent=String(days);el("planWorkspaceMovements").textContent=String(exercises);el("planWorkspaceSets").textContent=String(sets);
  el("planWorkspaceSummary").textContent=hasWeek?`${days} training day${days===1?"":"s"}, ${exercises} exercise${exercises===1?"":"s"}, and ${sets} working set${sets===1?"":"s"} are assigned in your saved week.`:"You have not built a weekly plan yet.";
  const action=el("planWorkspaceAction");if(action){action.href="/planner.html";action.innerHTML=hasWeek?'Edit weekly plan <span aria-hidden="true">→</span>':'Build your first week <span aria-hidden="true">→</span>';}
}
function workoutHistoryStatus(){const status=["loading","ready","error"].includes(state.workoutHistoryStatus)?state.workoutHistoryStatus:(state.workoutHistoryAvailable?"ready":"error");return status==="ready"&&!state.workoutHistoryAvailable?"error":status;}
function showTodayAlternative(show){const panel=el("todayAlternativeWorkout"),action=el("todayAlternativeAction");if(panel)panel.hidden=!show;if(action){action.innerHTML='Create a different workout <span aria-hidden="true">→</span>';action.href="#sessionBuilder";}}
function renderWeeklyPulse(){
  const pulseNodes=["weeklyPulse","weeklyPulseEyebrow","weeklyPulseTitle","weeklyPulseDetail","weeklyPulseBar","weeklyPulseAction","weeklyPulseMovements","weeklyPulseDays","todayDurationLabel","todayDuration","todayEquipment","todayPreviousLabel","todayPreviousValue","todayPreviousDetail","todayIntro"].map(el),pulseRoot=pulseNodes[0];
  if(pulseNodes.some((node)=>!node)||!state.preferences)return;
  const pulse=Core.weeklyPulse(state.weeklyPlan,{profileDays:state.preferences.days});
  const historyStatus=workoutHistoryStatus(),historyReady=historyStatus==="ready",active=historyReady?state.workouts.find((workout)=>workout.status==="active"):null,week=weekContext(),next=nextPlannedDay(week),items=next?.items||[],start=el("plusStartWorkout");
  const planned=scheduledDays(),hasWeek=planned.length>0,done=new Set(historyReady?completedThisWeek(week).map(workout=>workout.planDay).filter(day=>planned.includes(day)):[]),progress=historyReady&&planned.length?Math.round(done.size/planned.length*100):0;
  const metrics=el("weeklyPulseMovements")?.closest("dl"),previous=el("todayPrevious"),footer=el("weeklyPulseFooter"),planAction=el("weeklyPulseAction");
  el("weeklyPulseBar").setAttribute("style",`width:${progress}%`);el("weeklyPulseBar").parentElement.hidden=!historyReady||!hasWeek;
  el("weeklyPulseDays").textContent=historyReady?`${state.workoutHistoryHasMore?"At least ":""}${done.size} / ${planned.length}`:historyStatus==="loading"?"Checking history ·":"History unavailable ·";renderPlanOverview(pulse);
  if(planAction){planAction.hidden=!hasWeek;planAction.href="#planWorkspace";planAction.innerHTML='Review plan <span aria-hidden="true">→</span>';}
  if(footer)footer.hidden=!hasWeek;if(metrics)metrics.hidden=false;if(previous)previous.hidden=false;start.hidden=false;showTodayAlternative(false);
  if(active){
    el("weeklyPulseEyebrow").textContent="Workout in progress";el("weeklyPulseTitle").textContent=String(active.title||"Open workout").toUpperCase();
    el("weeklyPulseDetail").textContent=`${Math.max(0,Number(active.completedSets)||0)} of ${Math.max(0,Number(active.totalSets)||0)} sets completed. Continue where you left off.`;
    const summaries=Array.isArray(active.exerciseSummaries)?active.exerciseSummaries:[];el("weeklyPulseMovements").textContent=String(Math.max(0,Number(active.exerciseCount)||summaries.length));el("todayDurationLabel").textContent="Elapsed";el("todayDuration").textContent=formatDuration(active.elapsedSeconds);
    el("todayEquipment").textContent=equipmentSummary(summaries.map((item)=>exerciseById(item.exerciseId)?.equipment))||"See workout";renderPreviousComparable(summaries);
    start.href=`/workout.html#resume=${encodeURIComponent(active.id)}`;start.innerHTML='Resume workout <span aria-hidden="true">↗</span>';el("todayIntro").textContent="Your open workout is the only action that matters right now.";pulseRoot.dataset.sessionDay=active.planDay||"active";
  }else if(!hasWeek){
    el("weeklyPulseEyebrow").textContent="Start with your week";el("weeklyPulseTitle").textContent="BUILD YOUR FIRST WEEK.";el("weeklyPulseDetail").textContent="You have not built a weekly plan yet.";el("weeklyPulseMovements").textContent="0";el("todayDurationLabel").textContent="Estimated time";el("todayDuration").textContent="—";el("todayEquipment").textContent="—";el("todayPreviousLabel").textContent="Previous comparable performance";el("todayPreviousValue").textContent="";el("todayPreviousDetail").textContent="";start.href="/planner.html";start.innerHTML='Build your first week <span aria-hidden="true">→</span>';el("todayIntro").textContent="You have not built a weekly plan yet.";pulseRoot.dataset.sessionDay="empty";if(metrics)metrics.hidden=true;if(previous)previous.hidden=true;if(footer)footer.hidden=true;if(planAction)planAction.hidden=true;
  }else if(historyStatus==="loading"){
    el("weeklyPulseEyebrow").textContent="Checking your training week";el("weeklyPulseTitle").textContent="FINDING YOUR NEXT ACTION.";el("weeklyPulseDetail").textContent="Checking for an active workout before showing what comes next.";el("todayIntro").textContent="Your saved week is ready. Strata+ is checking your workout history.";start.hidden=true;if(metrics)metrics.hidden=true;if(previous)previous.hidden=true;pulseRoot.dataset.sessionDay="loading";
  }else if(historyStatus==="error"){
    el("weeklyPulseEyebrow").textContent="Workout status unavailable";el("weeklyPulseTitle").textContent="YOUR PLAN IS STILL SAFE.";el("weeklyPulseDetail").textContent=state.workoutHistoryError||"We couldn't verify workout history, so no start action is shown yet.";el("todayIntro").textContent="Review your weekly plan while workout history reconnects.";start.hidden=true;if(metrics)metrics.hidden=true;if(previous)previous.hidden=true;pulseRoot.dataset.sessionDay="unavailable";
  }else if(next){
    const when=next.offset===0?"Today":next.offset===1?"Tomorrow":next.offset>=7?`Next ${next.day}`:next.day,equipment=[...new Set(items.map((item)=>exerciseById(item.exerciseId)?.equipment).filter(Boolean))];
    el("weeklyPulseEyebrow").textContent=`${when} in your week`;el("weeklyPulseTitle").textContent=`${next.day.toUpperCase()} WORKOUT`;
    el("weeklyPulseDetail").textContent=`${items.length} planned movement${items.length===1?"":"s"}. Review the session, then record only what you complete.`;
    el("weeklyPulseMovements").textContent=String(items.length);el("todayDurationLabel").textContent="Estimated time";el("todayDuration").textContent=`~${estimatedSessionMinutes(items)} min`;el("todayEquipment").textContent=equipmentSummary(equipment)||(items.length?"No equipment":"—");renderPreviousComparable(items);
    start.href=`/workout.html?day=${encodeURIComponent(next.day)}`;start.innerHTML='Start workout <span aria-hidden="true">↗</span>';el("todayIntro").textContent=`Your next planned action is ${next.day}'s workout. The time is an estimate based on movements and working sets.`;pulseRoot.dataset.sessionDay=next.day;showTodayAlternative(true);
  }
}
const progressRenderer=RenderCore.createProgressRenderer({element:el,escapeHtml,exerciseName,readableDate,days:Monthly.DAYS});
function renderProgress(){return progressRenderer.render({workouts:state.workouts,weeklyPlan:state.weeklyPlan,historyAvailable:state.workoutHistoryAvailable,historyStatus:state.workoutHistoryStatus,historyError:state.workoutHistoryError,hasMore:state.workoutHistoryHasMore});}
function normalizeTrainingBlock(data){
  const raw=data?.trainingBlock||data?.block||null;if(!raw||typeof raw!=="object")return null;
  const weeks=Math.round(Number(raw.weeks??raw.durationWeeks));if(weeks<4||weeks>8)return null;
  const lightWeek=Number.isInteger(Number(raw.lightWeek))&&Number(raw.lightWeek)>=2&&Number(raw.lightWeek)<=weeks?Number(raw.lightWeek):null;
  return{version:Number(raw.version)||1,title:String(raw.title||"My training block"),goal:String(raw.goal||state.preferences?.goal||"balanced"),weeks,currentWeek:Math.max(1,Math.min(weeks,Math.round(Number(raw.currentWeek)||1))),lightWeek,startDate:String(raw.startDate||localIsoDate()),status:["active","completed"].includes(raw.status)?raw.status:"active",progressionRule:["reps-then-load","reps-only","time"].includes(raw.progressionRule)?raw.progressionRule:"reps-then-load",milestones:Array.isArray(raw.milestones)?raw.milestones:[],revision:Math.max(0,Math.round(Number(raw.revision)||0)),updatedAt:Number(raw.updatedAt??data?.updatedAt)||0};
}
function trainingBlockPhase(block,timeline){
  if(block.status==="completed")return"Completed";
  if(timeline.beforeStart)return"Starts soon";
  if(timeline.afterEnd)return"Review due";
  if(block.lightWeek===timeline.week)return"Lighter-week reminder";
  return"Active";
}
function renderTrainingBlockEvidence(review){
  const node=el("trainingBlockEvidence"),records=review.performance.records.map((item)=>({...item,type:"Logged high"})),recordKeys=new Set(records.map((item)=>`${item.exerciseId}:${item.date}:${item.after}`)),improvements=review.performance.improvements.filter((item)=>!recordKeys.has(`${item.exerciseId}:${item.date}:${item.after}`)).map((item)=>({...item,type:"Repeat improvement"})),items=[...records,...improvements].slice(0,4);
  node.innerHTML=items.length?items.map((item)=>`<article><strong>${escapeHtml(item.type)} · ${escapeHtml(exerciseName(item.exerciseId))}</strong><p>${escapeHtml(item.before)} → ${escapeHtml(item.after)} · ${escapeHtml(readableDate(item.date))}</p></article>`).join(""):`<p class="training-block-empty">No comparable improvement or new logged high is supported by the loaded workouts for this block week.</p>`;
  const signals=el("trainingBlockSignals"),parts=[];
  if(review.skipped.available)parts.push(`<span>${review.skipped.count} explicitly skipped</span>`);
  if(review.replaced.available)parts.push(`<span>${review.replaced.count} explicitly replaced</span>`);
  signals.innerHTML=parts.join("");signals.hidden=!parts.length;
  el("trainingBlockSignalNote").textContent=parts.length?"Counts come only from explicit fields in saved workout records.":"Skipped and replaced counts appear only when a saved workout explicitly records them.";
}
function renderTrainingBlockReview(){
  const root=el("trainingBlockReview"),block=state.trainingBlock;if(!root)return;
  root.hidden=!block;if(!block)return;
  const review=BlockCore.weekReview({block,weeklyPlan:state.weeklyPlan,workouts:state.workouts,exercises:state.exercises}),timeline=review.timeline,historyReady=state.workoutHistoryAvailable;
  el("trainingBlockReviewRange").textContent=timeline.valid?`${BlockCore.formatDate(timeline.weekStart)}–${BlockCore.formatDate(timeline.weekEnd)} · calendar-derived`:"Check the saved start date";
  el("trainingBlockReviewTitle").textContent=`WEEK ${timeline.week} REVIEW`;el("trainingBlockReviewPhase").textContent=trainingBlockPhase(block,timeline);
  el("trainingBlockWorkoutCount").textContent=historyReady?`${review.completedWorkouts} / ${review.plannedWorkouts}`:`— / ${review.plannedWorkouts}`;
  el("trainingBlockSetCount").textContent=historyReady?`${review.completedSets} / ${review.plannedSets}`:`— / ${review.plannedSets}`;el("trainingBlockWeekCount").textContent=`${timeline.week} / ${timeline.weeks}`;
  el("trainingBlockMuscles").innerHTML=review.muscles.length?review.muscles.map((muscle)=>`<div class="training-block-muscle"><strong>${escapeHtml(muscle.label)}</strong><span>${muscle.planned}<small>planned</small></span><span>${historyReady?muscle.completed:"—"}<small>logged</small></span></div>`).join(""):'<p class="training-block-empty">No working sets are in the saved weekly Plan yet.</p>';
  if(historyReady)renderTrainingBlockEvidence(review);else{el("trainingBlockEvidence").innerHTML='<p class="training-block-empty">Workout history is unavailable, so Strata+ is not making progress, skip, or replacement claims.</p>';el("trainingBlockSignals").hidden=true;el("trainingBlockSignalNote").textContent="Reconnect to review only verified saved workout evidence.";}
  el("trainingBlockNextDecision").textContent=historyReady?review.nextDecision:"Reconnect before deciding from this week’s workout history.";
  el("trainingBlockCarry").disabled=!review.actions.carry||!historyReady;el("trainingBlockLighter").disabled=!review.actions.lighter;el("trainingBlockFinish").disabled=!review.actions.finish;
  if(block.status==="completed")el("trainingBlockReviewStatus").textContent="Saved. This block is complete; the weekly Plan and workout history are unchanged.";
  else if(state.workoutHistoryHasMore)el("trainingBlockReviewStatus").textContent="Reviewing the 100 most recent sessions. Nothing changes until you confirm an action.";
  else el("trainingBlockReviewStatus").textContent="Nothing changes until you review and confirm an action.";
}
function renderTrainingBlock(){
  const block=state.trainingBlock,status=el("trainingBlockStatus"),planAhead=el("planAheadDetails");if(planAhead)planAhead.open=Boolean(block);if(!status)return;
  el("trainingBlockCurrentWeek").disabled=true;el("trainingBlockState").disabled=true;
  if(!block){el("trainingBlockWeeks").value="6";el("trainingBlockStartDate").value=localIsoDate();el("trainingBlockState").value="active";renderTrainingBlockWeekOptions(1,"");status.textContent="Review the suggested start date. Nothing changes until you save.";renderTrainingBlockReview();return;}
  const timeline=BlockCore.deriveWeek(block);el("trainingBlockWeeks").value=String(block.weeks);el("trainingBlockStartDate").value=block.startDate;el("trainingBlockState").value=block.status;renderTrainingBlockWeekOptions(timeline.week,block.lightWeek);
  status.textContent=block.status==="completed"?`Saved. Completed · ${block.weeks}-week block${block.lightWeek?` · week ${block.lightWeek} marked lighter`:""}.`:`Saved. Active · date-derived week ${timeline.week} of ${block.weeks}${block.lightWeek?` · week ${block.lightWeek} marked lighter`:" · no lighter week selected"}.`;
  renderTrainingBlockReview();
}
function renderTrainingBlockWeekOptions(selected=1,selectedLight=el("trainingBlockLighterWeek")?.value){
  const weeks=Math.max(4,Math.min(8,Math.round(Number(el("trainingBlockWeeks")?.value)||6))),select=el("trainingBlockCurrentWeek"),lighter=el("trainingBlockLighterWeek");if(!select||!lighter)return;
  const current=Math.max(1,Math.min(weeks,Math.round(Number(selected)||1))),light=Number(selectedLight);
  select.innerHTML=Array.from({length:weeks},(_,index)=>`<option value="${index+1}">Week ${index+1}</option>`).join("");select.value=String(current);
  lighter.innerHTML='<option value="">No lighter week</option>'+Array.from({length:Math.max(0,weeks-1)},(_,index)=>`<option value="${index+2}">Week ${index+2}</option>`).join("");lighter.value=Number.isInteger(light)&&light>=2&&light<=weeks?String(light):"";
  const start=el("trainingBlockStartDate").value,timeline=BlockCore.deriveWeek({weeks,startDate:start});
  if(timeline.valid){select.value=String(timeline.week);el("trainingBlockWeekHelp").textContent=timeline.beforeStart?`Starts ${BlockCore.formatDate(timeline.startDate)}`:`${BlockCore.formatDate(timeline.weekStart)}–${BlockCore.formatDate(timeline.weekEnd)}`;}
}
function adaptationChangeLabel(change){
  if(typeof change==="string"&&change.trim())return change.trim();
  if(!change||typeof change!=="object")return "Review the proposed plan change.";
  const from=Math.max(0,Math.round(Number(change.fromSets)||0)),to=Math.max(0,Math.round(Number(change.toSets)||0)),day=Monthly.DAYS.includes(change.day)?change.day:"Next session",name=exerciseName(change.exerciseId);
  return from&&to?`${day} · ${name} · ${from} → ${to} sets`:`${day} · ${name}`;
}
function adaptationPersistenceCopy(change){
  if(change&&typeof change==="object"){
    const from=Math.max(0,Math.round(Number(change.fromSets)||0)),to=Math.max(0,Math.round(Number(change.toSets)||0)),day=Monthly.DAYS.includes(change.day)?change.day:"the planned day",name=exerciseName(change.exerciseId);
    if(from&&to)return `Accepting changes ${name} from ${from} to ${to} sets on ${day} in your saved weekly Plan. It remains there until you edit Plan again.`;
  }
  return "Accepting edits your saved weekly Plan. The edit remains there until you change Plan again.";
}
function normalizeProgression(data,workoutId=""){
  const raw=data?.adaptation||data?.suggestion||null;if(!raw||typeof raw!=="object"||raw.status&&raw.status!=="pending")return null;
  const id=String(raw.id||raw.adaptationId||"");if(!id||raw.requiresApproval===false)return null;
  const progressionItems=Array.isArray(data?.progression?.suggestions)?data.progression.suggestions:[],evidence=progressionItems[0]?.explanation;
  const reduceSets=raw.kind==="reduce_sets";
  return{id,workoutId:String(raw.sourceWorkoutId||workoutId),title:String(raw.title||"Review a saved-Plan adjustment"),explanation:String(raw.explanation||"This suggestion uses comparable work you chose to log."),change:adaptationChangeLabel(raw.change),tradeoff:reduceSets?adaptationPersistenceCopy(raw.change):"Accepting edits your saved weekly Plan, and that edit remains until you change Plan again. Keeping the current Plan is always an option.",evidence:String(evidence||"Based only on comparable saved workout entries and optional check-ins."),expectedPlanUpdatedAt:Number(raw.expectedPlanUpdatedAt)||0,applied:false};
}
function renderProgression(){
  const card=el("progressionCard"),suggestion=state.progressionSuggestion;if(!card)return;
  card.hidden=!suggestion;if(!suggestion)return;
  el("progressionTitle").textContent=suggestion.title.toUpperCase();el("progressionExplanation").textContent=suggestion.explanation;el("progressionChange").textContent=suggestion.change;el("progressionTradeoff").textContent=suggestion.tradeoff;el("progressionEvidence").textContent=suggestion.evidence;
  el("progressionAccept").disabled=suggestion.applied;el("progressionAccept").textContent=suggestion.applied?"Change accepted":"Accept change";el("progressionDismiss").hidden=suggestion.applied;el("progressionStatus").textContent=suggestion.applied?"Saved. Your weekly Plan was updated; this edit remains until you change Plan again.":"Nothing changes unless you accept.";
}
function clearPrivateWorkspace(){
  workspaceGeneration+=1;workspaceReady=false;coaching.reset();program.reset();
  state.exercises=[];state.methodology=null;state.sources=[];state.limited=new Set();state.preferences=null;state.user=null;state.csrfToken="";state.aggregate=new Map();state.userRatings=new Map();state.ratingsRefreshedAt=0;state.ratingsRefreshPromise=null;state.ratingSaving=new Set();state.compare=[];state.shortlist=[];state.collection="all";state.query="";state.group="all";state.equipment="all";state.pattern="all";state.level="all";state.sort="personal";state.recommendations=[];state.activeExercise=null;state.explorerLimit=EXPLORER_DESKTOP_PAGE_SIZE;
  state.weeklyPlan=null;state.weeklyPlanUpdatedAt=0;state.workouts=[];state.workoutHistoryAvailable=false;state.workoutHistoryHasMore=false;state.workoutHistoryStatus="loading";state.workoutHistoryError="";state.trainingBlock=null;state.trainingBlockRevision=0;state.trainingBlockAction=null;state.progressionSuggestion=null;state.session=null;state.sessionSaving=false;state.sessionDayInitialized=false;state.monthlyPlan=null;state.monthlyPlanUpdatedAt=0;state.monthlySchedule=null;state.monthlySource="muscle-schedule";state.communityPlans=[];state.communityLoaded=false;state.communityLoading=false;state.communityError="";state.communityNextOffset=0;state.communityQuery="";state.communityPendingId=null;state.communityAppliedId=null;state.communityAppliedUpdatedAt=0;
  const main=document.querySelector("main");if(main){main.hidden=true;main.inert=true;main.setAttribute("aria-busy","true");}
  el("userName").textContent="Checking account…";el("compareTray").hidden=true;el("compareNames").textContent="Choose 2–4 exercises";el("toast").textContent="";el("featureStatus").textContent="";
  el("progressionCard").hidden=true;el("trainingBlockReview").hidden=true;el("battleResults").hidden=true;el("battleResults").innerHTML="";el("communityPlanGrid").innerHTML="";el("sessionResults").innerHTML="";
  if(el("detailContent"))el("detailContent").innerHTML="";if(el("communityApplySummary"))el("communityApplySummary").innerHTML="";
  document.querySelectorAll("dialog").forEach((dialog)=>{if(dialog.open)dialog.close();});document.body.classList.remove("dialog-open");
}
function revealPrivateWorkspace(){
  const main=document.querySelector("main");if(main){main.hidden=false;main.inert=false;main.setAttribute("aria-busy","false");}
  workspaceReady=true;
}
function dashboardUnavailable(message="Workout history could not be loaded. Your plan is still ready."){
  state.workouts=[];state.workoutHistoryAvailable=false;state.workoutHistoryHasMore=false;state.workoutHistoryStatus="error";state.workoutHistoryError=message;renderWeeklyPulse();renderProgress();renderTrainingBlockReview();
  if(el("todayPreviousValue"))el("todayPreviousValue").textContent="History unavailable";
  if(el("todayPreviousDetail"))el("todayPreviousDetail").textContent=message;
}
function dashboardAccountChanged(){
  clearPrivateWorkspace();
  el("discoveryLoadErrorMessage").textContent="The signed-in account changed in another tab. Reloading Strata+ to keep private training data separate.";el("discoveryLoadError").hidden=false;document.querySelector("main")?.setAttribute("aria-busy","true");window.location.replace("/discover.html");
}
async function confirmDashboardIdentity(expectedUserId,expectedCsrf){
  const identity=await api("/api/me"),sameUser=String(identity.user?.id||"")===String(expectedUserId||""),sameCsrf=Boolean(identity.csrfToken)&&String(identity.csrfToken)===String(expectedCsrf||"");
  if(!sameUser||!sameCsrf)throw Object.assign(new Error("The signed-in account changed."),{code:"ACCOUNT_CHANGED"});
  return identity;
}
function resolvedAdaptation(result,suggestion,status,{requirePlan=false}={}){
  const adaptation=result?.adaptation,valid=adaptation&&String(adaptation.id||"")===suggestion.id&&adaptation.status===status;
  if(!valid||requirePlan&&(!result.plan||!Number.isSafeInteger(Number(result.planUpdatedAt))||Number(result.planUpdatedAt)<=0)||!requirePlan&&result?.planUpdatedAt!==null)throw Object.assign(new Error("STRATA returned an incomplete training update. Reload before trying again."),{code:"INVALID_RESPONSE"});
  return adaptation;
}
async function refreshTrainingSnapshot({includePlan=false}={}){
  const expectedUserId=String(state.user?.id||""),expectedCsrf=state.csrfToken,[training,planResult]=await Promise.all([api("/api/training"),includePlan?api("/api/plan"):Promise.resolve(null)]);
  const identity=await confirmDashboardIdentity(expectedUserId,expectedCsrf),identityCsrf=String(identity.csrfToken||"");
  if(String(training.csrfToken||"")!==identityCsrf||planResult&&(String(planResult.csrfToken||"")!==identityCsrf||String(planResult.user?.id||"")!==expectedUserId))throw Object.assign(new Error("The signed-in account changed."),{code:"ACCOUNT_CHANGED"});
  const nextPlan=planResult?Monthly.normalizeWeeklyPlan(planResult.plan,state.exercises):null;
  state.progressionSuggestion=normalizeProgression(training,completedWorkouts()[0]?.id||"");state.trainingBlock=normalizeTrainingBlock(training);state.trainingBlockRevision=state.trainingBlock?.revision||0;
  if(nextPlan){state.weeklyPlan=nextPlan;state.weeklyPlanUpdatedAt=Number(planResult.planUpdatedAt)||0;syncSessionPlanViews({invalidateSession:true});}
  renderProgression();renderTrainingBlock();
}
async function reconcileAdaptationError(error,{accepting=false}={}){
  const refreshCodes=["ADAPTATION_RESOLVED","ADAPTATION_CHANGED","ADAPTATION_NOT_FOUND","ADAPTATION_UNAVAILABLE","CHECK_IN_CHANGED","PLAN_CHANGED"];
  if(!refreshCodes.includes(error?.code))return false;
  try{await refreshTrainingSnapshot({includePlan:["PLAN_CHANGED","ADAPTATION_CHANGED"].includes(error.code)});}
  catch(refreshError){if(redirectedOrChangedAccount(refreshError))return true;el("progressionStatus").textContent="Couldn't reload the latest suggestion. Refresh this page before trying again.";return true;}
  if(!state.progressionSuggestion){el("featureStatus").textContent="The earlier suggestion was already resolved. Current training state loaded.";showToast("Current training state loaded. The earlier suggestion is no longer pending.");return true;}
  const cannotAccept=accepting&&["PLAN_CHANGED","CHECK_IN_CHANGED","ADAPTATION_UNAVAILABLE"].includes(error.code);
  el("progressionAccept").disabled=cannotAccept;el("progressionDismiss").disabled=false;
  el("progressionStatus").textContent=cannotAccept?`${error.message} Dismiss this old suggestion to keep the current plan.`:`${error.message} The latest suggestion is loaded.`;
  return true;
}
let memberDashboardLoadingGeneration=null;
async function loadMemberDashboard(generation=workspaceGeneration){
  if(memberDashboardLoadingGeneration===generation)return;
  memberDashboardLoadingGeneration=generation;state.workoutHistoryStatus="loading";state.workoutHistoryError="";state.workoutHistoryAvailable=false;renderWeeklyPulse();renderProgress();
  try{
    const [historyResult,trainingResult]=await Promise.allSettled([api("/api/workouts?limit=100&offset=0"),api("/api/training")]);
    if(generation!==workspaceGeneration)return;
    let identity;
    try{identity=await api("/api/me");}
    catch(error){if(!error?.redirecting)dashboardUnavailable();return;}
    if(generation!==workspaceGeneration)return;
    const sameUser=String(identity.user?.id||"")===String(state.user?.id||""),identityCsrf=String(identity.csrfToken||"");
    const history=historyResult.status==="fulfilled"?historyResult.value:null,historyCsrf=String(history?.csrfToken||"");
    const training=trainingResult.status==="fulfilled"?trainingResult.value:null,trainingCsrf=String(training?.csrfToken||"");
    if(!sameUser||(history&&(!historyCsrf||historyCsrf!==identityCsrf))||(training&&(!trainingCsrf||trainingCsrf!==identityCsrf))){dashboardAccountChanged();return;}
    state.csrfToken=identityCsrf||state.csrfToken;
    if(history&&Array.isArray(history.workouts)&&typeof history.hasMore==="boolean"){
      state.workouts=safeWorkoutList(history.workouts);state.workoutHistoryAvailable=true;state.workoutHistoryHasMore=history.hasMore===true;state.workoutHistoryStatus="ready";state.workoutHistoryError="";renderWeeklyPulse();renderProgress();renderTrainingBlockReview();
    }else dashboardUnavailable();
    state.progressionSuggestion=normalizeProgression(training,completedWorkouts()[0]?.id||"");renderProgression();
    if(training){
      state.trainingBlock=normalizeTrainingBlock(training);state.trainingBlockRevision=state.trainingBlock?.revision||0;renderTrainingBlock();
    }
  }finally{if(memberDashboardLoadingGeneration===generation){memberDashboardLoadingGeneration=null;const retry=el("progressRetry");if(retry)retry.disabled=false;}}
}
async function persistTrainingBlock(blockInput){
  const expectedUserId=String(state.user?.id||""),expectedCsrf=state.csrfToken;
  const result=await api("/api/training-block",{method:"PUT",body:JSON.stringify({block:blockInput,expectedRevision:state.trainingBlockRevision,expectedUserId})}),block=normalizeTrainingBlock(result);
  if(!block)throw Object.assign(new Error("The saved training block response was incomplete."),{code:"INVALID_RESPONSE"});await confirmDashboardIdentity(expectedUserId,expectedCsrf);
  state.trainingBlock=block;state.trainingBlockRevision=block.revision;renderTrainingBlock();return block;
}
function reconcileTrainingBlockSave(error,target="trainingBlockStatus"){
  if(redirectedOrChangedAccount(error))return true;
  if(error.code==="TRAINING_BLOCK_CHANGED"&&error.payload?.block){state.trainingBlock=normalizeTrainingBlock(error.payload);state.trainingBlockRevision=state.trainingBlock?.revision||0;renderTrainingBlock();el(target).textContent="Couldn't save — Retry. This block changed elsewhere; the latest saved version is loaded.";return true;}
  el(target).textContent=saveRetryMessage(error);return false;
}
async function saveTrainingBlock(event){
  event.preventDefault();const form=event.currentTarget;if(form.dataset.saving==="true")return;
  const weeks=Number(el("trainingBlockWeeks").value),lightWeek=Number(el("trainingBlockLighterWeek").value)||null,startDate=el("trainingBlockStartDate").value,status=el("trainingBlockState").value,button=el("trainingBlockSave"),timeline=BlockCore.deriveWeek({weeks,startDate});
  if(!timeline.valid){el("trainingBlockStatus").textContent="Choose a valid date for this block before saving.";el("trainingBlockStartDate").focus();return;}
  form.dataset.saving="true";form.setAttribute("aria-busy","true");button.disabled=true;button.textContent="Saving…";el("trainingBlockStatus").textContent="Saving…";
  try{
    const current=state.trainingBlock,milestones=current?.weeks===weeks?(current.milestones||[]):[],currentWeek=status==="completed"?weeks:timeline.week,blockInput={title:current?.title||`My ${weeks}-week block`,goal:current?.goal||state.preferences?.goal||"balanced",weeks,currentWeek,lightWeek,startDate,status,progressionRule:current?.progressionRule||"reps-then-load",...(milestones.length?{milestones}:{})};
    await persistTrainingBlock(blockInput);showToast("Saved. Training block updated.");
  }catch(error){reconcileTrainingBlockSave(error);}
  finally{form.dataset.saving="false";form.setAttribute("aria-busy","false");button.disabled=false;button.textContent="Save training block";}
}
function openTrainingBlockAction(action){
  try{
    const proposal=BlockCore.actionProposal(state.trainingBlock,action);state.trainingBlockAction=proposal;
    el("trainingBlockActionTitle").textContent=proposal.title.toUpperCase();el("trainingBlockActionDescription").textContent=proposal.description;el("trainingBlockActionConfirm").textContent=proposal.confirmLabel;el("trainingBlockActionError").hidden=true;el("trainingBlockActionError").textContent="";openDialog(el("trainingBlockActionDialog"),el("trainingBlockActionCancel"));
  }catch(error){el("trainingBlockReviewStatus").textContent=error.message;}
}
async function confirmTrainingBlockAction(){
  const proposal=state.trainingBlockAction,dialog=el("trainingBlockActionDialog"),button=el("trainingBlockActionConfirm");if(!proposal||dialog.dataset.busy==="true")return;
  const controls=[...dialog.querySelectorAll("button")];dialog.dataset.busy="true";dialog.setAttribute("aria-busy","true");controls.forEach((control)=>{control.disabled=true;});button.textContent="Saving…";el("trainingBlockActionError").hidden=true;
  try{
    await persistTrainingBlock(proposal.block);closeDialog("trainingBlockActionDialog");el("trainingBlockStatus").textContent=`Saved. ${proposal.confirmLabel}.`;el("trainingBlockReviewStatus").textContent=`Saved. ${proposal.confirmLabel}. Your weekly Plan is unchanged.`;showToast(`Saved. ${proposal.confirmLabel}.`);
  }catch(error){
    const reconciled=reconcileTrainingBlockSave(error,"trainingBlockReviewStatus");if(reconciled){state.trainingBlockAction=null;if(dialog.open)closeDialog("trainingBlockActionDialog");}else{el("trainingBlockActionError").textContent=saveRetryMessage(error);el("trainingBlockActionError").hidden=false;}
  }finally{dialog.dataset.busy="false";dialog.setAttribute("aria-busy","false");controls.forEach((control)=>{control.disabled=false;});button.textContent=state.trainingBlockAction?.confirmLabel||"Confirm action";}
}
async function acceptProgression(){
  const suggestion=state.progressionSuggestion,button=el("progressionAccept");if(!suggestion||button.disabled)return;
  const expectedUserId=String(state.user?.id||""),expectedCsrf=state.csrfToken;
  button.disabled=true;el("progressionDismiss").disabled=true;button.textContent="Saving…";el("progressionStatus").textContent="Saving…";
  try{
    const result=await api(`/api/training/adaptations/${encodeURIComponent(suggestion.id)}`,{method:"POST",body:JSON.stringify({decision:"accept",expectedPlanUpdatedAt:suggestion.expectedPlanUpdatedAt})});resolvedAdaptation(result,suggestion,"accepted",{requirePlan:true});const nextPlan=Monthly.normalizeWeeklyPlan(result.plan,state.exercises);await confirmDashboardIdentity(expectedUserId,expectedCsrf);
    state.weeklyPlan=nextPlan;state.weeklyPlanUpdatedAt=Number(result.planUpdatedAt);renderWeeklyPulse();renderTrainingBlockReview();
    state.progressionSuggestion={...suggestion,applied:true};renderProgression();showToast("Saved. Your weekly Plan was updated.");
  }catch(error){if(redirectedOrChangedAccount(error))return;if(await reconcileAdaptationError(error,{accepting:true}))return;button.disabled=false;el("progressionDismiss").disabled=false;button.textContent="Accept change";el("progressionStatus").textContent=saveRetryMessage(error);}
}
async function dismissProgression(){
  const suggestion=state.progressionSuggestion,button=el("progressionDismiss");if(!suggestion||button.disabled)return;
  const expectedUserId=String(state.user?.id||""),expectedCsrf=state.csrfToken;
  button.disabled=true;el("progressionAccept").disabled=true;button.textContent="Saving…";el("progressionStatus").textContent="Saving…";
  try{const result=await api(`/api/training/adaptations/${encodeURIComponent(suggestion.id)}`,{method:"POST",body:JSON.stringify({decision:"dismiss"})});resolvedAdaptation(result,suggestion,"dismissed");await confirmDashboardIdentity(expectedUserId,expectedCsrf);state.progressionSuggestion=null;renderProgression();el("featureStatus").textContent="Suggestion dismissed. No training change was applied.";showToast("Suggestion dismissed. Your plan is unchanged.");}
  catch(error){if(redirectedOrChangedAccount(error))return;if(await reconcileAdaptationError(error))return;button.disabled=false;el("progressionAccept").disabled=false;button.textContent="Dismiss";el("progressionStatus").textContent=saveRetryMessage(error);}
}
const session=SessionCore.createSession({
  state,core:Core,monthly:Monthly,labels:GROUP_LABELS,element:el,window,escapeHtml,titleCase,api,saveRetryMessage,showToast,
  renderWeeklyPulse,renderTrainingBlockReview,updateMonthlySourceButtons
});
const {addToWeek:addSessionToWeek,generate:generateSession,initialize:initializeSessionBuilder,resetPreview:resetSessionPreview,syncPlanViews:syncSessionPlanViews,updateAddButton:updateSessionAddButton}=session;
function localIsoDate(){const date=new Date(),part=(value)=>String(value).padStart(2,"0");return `${date.getFullYear()}-${part(date.getMonth()+1)}-${part(date.getDate())}`;}
function friendlyMonthlyDate(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value||"")))return "";
  const date=new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime())?"":new Intl.DateTimeFormat(undefined,{weekday:"short",month:"short",day:"numeric",year:"numeric"}).format(date);
}
function updateMonthlyDateRange(){
  const start=el("monthlyStartDate")?.value;
  try{const end=Monthly.addUtcDays(start,30);el("monthlyEndDate").value=end;el("monthlyDateHelp").textContent=`31 consecutive days: ${friendlyMonthlyDate(start)} – ${friendlyMonthlyDate(end)}.`;}
  catch{el("monthlyEndDate").value="";el("monthlyDateHelp").textContent="Choose a valid starting date.";}
}
function setMonthlyValidation(message=""){const node=el("monthlyValidation");node.textContent=message;node.hidden=!message;}
function monthlyTargetMarkup(day,target,selected,disabled){
  const id=`monthly-${day.toLowerCase()}-${target.key}`;
  return `<label class="monthly-target-chip" for="${id}"><input id="${id}" type="checkbox" value="${escapeHtml(target.key)}" data-monthly-target ${selected?"checked":""} ${disabled?"disabled":""}/><span>${escapeHtml(target.label)}</span></label>`;
}
function renderMonthlySchedule(schedule=state.monthlySchedule){
  state.monthlySchedule=copyMonthlyValue(schedule||blankMonthlySchedule());
  el("monthlySchedule").innerHTML=Monthly.DAYS.map((day,index)=>{
    const config=state.monthlySchedule[day]||{rest:true,targets:[],sourceItems:[]},rest=Boolean(config.rest),sourceCount=Array.isArray(config.sourceItems)?config.sourceItems.length:0;
    return `<fieldset class="monthly-weekday-card ${rest?"is-rest":""}" data-monthly-day="${day}"><legend class="sr-only">${day} schedule</legend><div class="monthly-weekday-head"><h3>${String(index+1).padStart(2,"0")} / ${day}</h3><label class="monthly-rest-toggle"><input type="checkbox" data-monthly-rest ${rest?"checked":""}/><span>${rest?"Rest day":"Training day"}</span></label></div><div class="monthly-target-grid" aria-label="Muscle groups for ${day}">${Monthly.TARGETS.map((target)=>monthlyTargetMarkup(day,target,config.targets.includes(target.key),rest)).join("")}</div><p class="monthly-day-note">${sourceCount?`${sourceCount} exercise${sourceCount===1?"":"s"} copied from your week. Editing this day lets Strata+ choose new exercises.`:rest?"Recovery day · no exercises will be scheduled.":"Choose up to four muscle groups."}</p></fieldset>`;
  }).join("");
}
function readMonthlySchedule(){
  const schedule={};
  for(const day of Monthly.DAYS){
    const card=document.querySelector(`[data-monthly-day="${day}"]`),rest=Boolean(card?.querySelector("[data-monthly-rest]")?.checked);
    const targets=rest?[]:[...card.querySelectorAll("[data-monthly-target]:checked")].map((input)=>input.value);
    if(!rest&&!targets.length)throw new Error(`${day} needs at least one muscle group or must be marked as rest.`);
    if(targets.length>4)throw new Error(`${day} can use at most four muscle groups.`);
    schedule[day]={rest,targets,sourceItems:rest?[]:copyMonthlyValue(state.monthlySchedule?.[day]?.sourceItems||[])};
  }
  if(!Monthly.DAYS.some((day)=>!schedule[day].rest))throw new Error("Choose at least one training day.");
  return Monthly.normalizeSchedule(schedule,state.exercises);
}
function setMonthlySource(plan,label,source="weekly"){
  if(el("monthlyPlanForm").dataset.saving==="true"){showToast("Wait for the current plan to finish saving before importing another week.");return;}
  try{
    const normalized=Monthly.normalizeWeeklyPlan(plan,state.exercises),count=weeklyPlanCount(normalized);
    if(!count)throw new Error("That weekly plan is empty. Add exercises first or build the split manually.");
    state.monthlySource=source;state.monthlySchedule=Monthly.scheduleFromWeeklyPlan(normalized,state.exercises);renderMonthlySchedule();
    document.querySelectorAll(".monthly-source-actions button").forEach((button)=>{const active=(label.includes("account")&&button.id==="monthlySourceAccount")||(label.includes("device")&&button.id==="monthlySourceGuest")||(label.includes("file")&&button.id==="monthlyFileButton");button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));});
    setMonthlyValidation();el("monthlyPlanStatus").textContent=`${label} copied as a private snapshot · ${count} exercises.`;
    showToast(`${label} loaded.`);
  }catch(error){setMonthlyValidation(error.message);showToast(error.message);}
}
function deviceGuestPlan(){
  try{const raw=localStorage.getItem("strata_guest_plan_v1");return raw?Monthly.normalizeWeeklyPlan(JSON.parse(raw),state.exercises):null;}
  catch{return null;}
}
function updateMonthlySourceButtons(){
  const accountCount=weeklyPlanCount(state.weeklyPlan),guest=deviceGuestPlan(),guestCount=weeklyPlanCount(guest);
  const accountButton=el("monthlySourceAccount"),guestButton=el("monthlySourceGuest");
  if(accountButton){accountButton.disabled=!accountCount;accountButton.textContent=accountCount?`Use saved weekly plan (${accountCount})`:"Saved weekly plan is empty";accountButton.title=accountCount?`Copy ${accountCount} saved exercises`:"Add exercises in the free weekly planner first";}
  if(guestButton){guestButton.hidden=!guestCount;guestButton.disabled=!guestCount;guestButton.textContent=`Use this device’s plan (${guestCount})`;guestButton.title=guestCount?`Copy ${guestCount} exercises saved on this device`:"";}
}
function monthlyExerciseMarkup(item){
  const exercise=exerciseById(item.exerciseId);
  if(!exercise)return"";
  const target=Monthly.inferTarget(exercise),label=Monthly.TARGET_LABELS[target]||GROUP_LABELS[exercise.group]||titleCase(exercise.group);
  return `<li><strong>${escapeHtml(exercise.name)}<small>${escapeHtml(label)} · ${escapeHtml(exercise.equipment)}</small></strong><span>${escapeHtml(item.sets)} sets × ${escapeHtml(item.reps)}<small>${escapeHtml(exercise.rest)} rest</small></span></li>`;
}
function renderMonthlyPlan(plan,{announce=false}={}){
  state.monthlyPlan=plan||null;
  if(plan)state.monthlyPlanUpdatedAt=Number(plan.updatedAt)||state.monthlyPlanUpdatedAt;
  if(!plan){el("monthlyResults").hidden=true;return;}
  const workoutDays=plan.days.filter((day)=>!day.rest).length,restDays=plan.days.length-workoutDays,totalExercises=plan.days.reduce((sum,day)=>sum+day.exercises.length,0);
  el("monthlyResultsTitle").textContent=plan.title;
  el("monthlySummary").innerHTML=`<div><span>Plan</span><strong>31 days</strong></div><div><span>Training</span><strong>${workoutDays}</strong></div><div><span>Rest</span><strong>${restDays}</strong></div><div><span>Exercises</span><strong>${totalExercises}</strong></div>`;
  el("monthlyDays").innerHTML=plan.days.map((day)=>`<article class="monthly-day-card ${day.rest?"is-rest":""}" data-rest="${day.rest}"><header class="monthly-day-head"><span class="monthly-day-number">Day ${String(day.dayNumber).padStart(2,"0")}</span><time datetime="${escapeHtml(day.date)}">${escapeHtml(friendlyMonthlyDate(day.date))}</time></header><h4>${escapeHtml(day.weekday)}</h4>${day.rest?'<p class="monthly-rest-copy"><strong>REST / RECOVERY</strong><br />Keep the day clear or use gentle movement.</p>':`<p class="monthly-day-targets">${day.targets.map((target)=>escapeHtml(Monthly.TARGET_LABELS[target]||titleCase(target))).join(" + ")}</p><ol class="monthly-exercise-list">${day.exercises.map(monthlyExerciseMarkup).join("")}</ol>`}</article>`).join("");
  el("monthlyResults").hidden=false;
  if(announce){el("monthlyPlanStatus").textContent=`Saved. 31-day plan ready with ${workoutDays} training days and ${restDays} rest days.`;el("monthlyResults").scrollIntoView?.({behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches?"auto":"smooth",block:"start"});}
}
function populateMonthlyBuilder(plan=null){
  el("monthlyTitle").value=plan?.title||"My 31-day Strata plan";
  el("monthlyStartDate").value=plan?.startDate||localIsoDate();
  el("monthlyExercisesPerTarget").value=String(plan?.exercisesPerTarget||2);
  state.monthlySource=plan?.source||"muscle-schedule";
  renderMonthlySchedule(plan?.schedule||blankMonthlySchedule());updateMonthlyDateRange();updateMonthlySourceButtons();renderMonthlyPlan(plan);
  el("monthlyPlanStatus").textContent=plan?"Saved. Your 31-day plan is ready on this account.":"Choose your split, start date, and rest days.";
}
function downloadTextFile(text,filename,type="text/plain"){
  const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=filename;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function shareMonthlyPlan(){
  if(!state.monthlyPlan)return;
  const text=Monthly.shareText(state.monthlyPlan,state.exercises),title=state.monthlyPlan.title||"My STRATA 31-day plan";
  try{
    if(typeof File==="function"&&navigator.share){
      const file=new File([text],"strata-31-day-plan.txt",{type:"text/plain"});
      if(navigator.canShare?.({files:[file]})){await navigator.share({title,text:"My private STRATA workout plan",files:[file]});showToast("Plan shared.");return;}
      await navigator.share({title,text});showToast("Plan shared.");return;
    }
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);showToast("Plan copied to your clipboard.");return;}
    downloadTextFile(text,"strata-31-day-plan.txt");showToast("Share file downloaded.");
  }catch(error){if(error?.name!=="AbortError"){downloadTextFile(text,"strata-31-day-plan.txt");showToast("Sharing was unavailable, so a plan file was downloaded.");}}
}
function printMonthlyPlan(){
  if(!state.monthlyPlan)return;
  document.body.classList.add("print-monthly-plan");
  const finish=()=>document.body.classList.remove("print-monthly-plan");
  window.addEventListener?.("afterprint",finish,{once:true});window.print?.();setTimeout(finish,750);
}

const sharing=SharingCore.createSharing({
  state,document,navigator,urlApi:URL,fileCtor:globalThis.File,labels:GROUP_LABELS,exerciseById,titleCase,personalResult,personalLabel,comparisonWinner,showToast
});
const {shareCard}=sharing;

function setCollectionState(value){document.querySelectorAll("[data-collection]").forEach((button)=>{const active=button.dataset.collection===value;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));});}
function resetFilters(){clearTimeout(state.explorerSearchTimer);state.explorerSearchTimer=null;state.collection="all";state.query="";state.group="all";state.equipment="all";state.pattern="all";state.level="all";state.sort="personal";el("searchInput").value="";el("groupFilter").value="all";el("equipmentFilter").value="all";el("patternFilter").value="all";el("levelFilter").value="all";el("sortSelect").value="personal";setCollectionState("all");resetExplorerWindow();renderExplorer();}

const profileForm=el("profileForm");
function markProfileDirty(){if(profileForm.dataset.saving!=="true")el("profileStatus").textContent="Unsaved changes";}
profileForm.addEventListener("input",markProfileDirty);
profileForm.addEventListener("change",markProfileDirty);
profileForm.addEventListener("submit",async(event)=>{
  event.preventDefault();if(profileForm.dataset.saving==="true")return;
  const formElement=event.currentTarget,form=new FormData(formElement),preferences={goal:form.get("goal"),level:form.get("level"),days:Number(form.get("days")),equipment:form.getAll("equipment"),preferences:form.getAll("preferences"),limitations:form.getAll("limitations")};
  const controls=[...formElement.elements];profileForm.dataset.saving="true";controls.forEach((control)=>{control.disabled=true;});
  el("profileStatus").textContent="Saving…";
  try{const result=await api("/api/preferences",{method:"PUT",body:JSON.stringify({preferences})});state.preferences=result.preferences;renderProfile();renderMovementBoard();renderRecommendations();resetExplorerWindow();renderExplorer();renderWeeklyPulse();resetSessionPreview("Preferences saved. Build a new session when you're ready.");showToast("Saved. Your recommendations are updated.");}
  catch(error){const message=saveRetryMessage(error);el("profileStatus").textContent=message;showToast(message);}
  finally{profileForm.dataset.saving="false";controls.forEach((control)=>{control.disabled=false;});}
});

function lockFormControls(form){
  const controls=[...form.querySelectorAll("button,input,select,textarea,fieldset")].map((control)=>({control,disabled:control.disabled}));
  controls.forEach(({control})=>{control.disabled=true;});
  return()=>controls.forEach(({control,disabled})=>{control.disabled=disabled;});
}

const monthlyPlanForm=el("monthlyPlanForm");
el("trainingBlockForm")?.addEventListener("submit",saveTrainingBlock);
function refreshTrainingBlockDraft({startsNew=false}={}){
  if(startsNew&&el("trainingBlockState").value==="completed")el("trainingBlockState").value="active";
  renderTrainingBlockWeekOptions(el("trainingBlockCurrentWeek").value,el("trainingBlockLighterWeek").value);el("trainingBlockStatus").textContent="Unsaved changes · review, then save";
}
el("trainingBlockWeeks")?.addEventListener("change",()=>refreshTrainingBlockDraft({startsNew:true}));
el("trainingBlockStartDate")?.addEventListener("input",()=>refreshTrainingBlockDraft({startsNew:true}));
el("trainingBlockLighterWeek")?.addEventListener("change",()=>{el("trainingBlockStatus").textContent="Unsaved changes · review, then save";});
el("trainingBlockCarry")?.addEventListener("click",()=>openTrainingBlockAction("carry"));
el("trainingBlockLighter")?.addEventListener("click",()=>openTrainingBlockAction("lighter"));
el("trainingBlockFinish")?.addEventListener("click",()=>openTrainingBlockAction("finish"));
el("trainingBlockActionConfirm")?.addEventListener("click",()=>{void confirmTrainingBlockAction();});
el("trainingBlockActionDialog")?.addEventListener("close",()=>{if(el("trainingBlockActionDialog").dataset.busy!=="true")state.trainingBlockAction=null;});
el("progressionAccept")?.addEventListener("click",()=>{void acceptProgression();});
el("progressionDismiss")?.addEventListener("click",()=>{void dismissProgression();});
el("sessionBuilderForm")?.addEventListener("submit",(event)=>{event.preventDefault();if(!state.sessionSaving)generateSession({announce:true});});
session.bindSelectionControls();
el("sessionLength")?.addEventListener("change",()=>{if(!state.sessionSaving)resetSessionPreview("Time changed. Build the session to see your updated picks.");});
el("sessionDay")?.addEventListener("change",()=>{if(!state.sessionSaving){const error=updateSessionAddButton();el("sessionStatus").textContent=error?`This session does not fit the selected day: ${error.message}`:state.session?`Session ready to add to ${el("sessionDay").value}.`:"Build a session first.";}});
el("sessionAddAll")?.addEventListener("click",()=>{void addSessionToWeek();});
monthlyPlanForm.addEventListener("submit",async(event)=>{
  event.preventDefault();if(monthlyPlanForm.dataset.saving==="true")return;
  let unlockControls=()=>{};setMonthlyValidation();
  try{
    const schedule=readMonthlySchedule(),generated={...Monthly.generateMonthPlan({title:el("monthlyTitle").value,startDate:el("monthlyStartDate").value,exercisesPerTarget:Number(el("monthlyExercisesPerTarget").value),schedule,exercises:state.exercises,preferences:state.preferences}),source:state.monthlySource};
    monthlyPlanForm.dataset.saving="true";monthlyPlanForm.setAttribute("aria-busy","true");unlockControls=lockFormControls(monthlyPlanForm);el("monthlyPlanStatus").textContent="Saving…";
    const result=await api("/api/monthly-plan",{method:"PUT",body:JSON.stringify({monthlyPlan:generated,expectedUpdatedAt:state.monthlyPlanUpdatedAt})});
    state.monthlySchedule=copyMonthlyValue(result.monthlyPlan.schedule);renderMonthlyPlan(result.monthlyPlan,{announce:true});showToast("Saved. Your 31-day plan is ready.");
  }catch(error){
    const message=error.status===409?"A newer monthly plan was saved on another tab. Your setup is unchanged. Reload to review the saved plan before generating again.":saveRetryMessage(error);
    setMonthlyValidation(message);el("monthlyPlanStatus").textContent=message;showToast(message);
  }
  finally{monthlyPlanForm.dataset.saving="false";monthlyPlanForm.setAttribute("aria-busy","false");unlockControls();}
});
el("monthlySchedule").addEventListener("change",(event)=>{
  const card=event.target.closest("[data-monthly-day]");if(!card)return;
  const day=card.dataset.monthlyDay,rest=card.querySelector("[data-monthly-rest]"),targets=[...card.querySelectorAll("[data-monthly-target]")];
  if(event.target.matches("[data-monthly-rest]")){
    targets.forEach((input)=>{input.disabled=rest.checked;if(rest.checked)input.checked=false;});
  }else if(event.target.matches("[data-monthly-target]")){
    const checked=targets.filter((input)=>input.checked);
    if(checked.length>4){event.target.checked=false;setMonthlyValidation(`${day} can use at most four muscle groups.`);return;}
    if(checked.length){rest.checked=false;targets.forEach((input)=>{input.disabled=false;});}
  }
  card.classList.toggle("is-rest",rest.checked);rest.nextElementSibling.textContent=rest.checked?"Rest day":"Training day";
  state.monthlySource="muscle-schedule";state.monthlySchedule[day].sourceItems=[];
  state.monthlySchedule[day].rest=rest.checked;state.monthlySchedule[day].targets=rest.checked?[]:targets.filter((input)=>input.checked).map((input)=>input.value);
  const note=card.querySelector(".monthly-day-note");if(note)note.textContent=rest.checked?"Recovery day · no exercises will be scheduled.":"Custom split · Strata+ will choose suitable exercises.";
  document.querySelectorAll(".monthly-source-actions button").forEach((button)=>{button.classList.remove("active");button.setAttribute("aria-pressed","false");});
  setMonthlyValidation();el("monthlyPlanStatus").textContent="Split changed · create the plan to save it.";
});
el("monthlyStartDate").addEventListener("input",updateMonthlyDateRange);
el("monthlySourceAccount").addEventListener("click",()=>setMonthlySource(state.weeklyPlan,"Saved account plan"));
el("monthlySourceGuest").addEventListener("click",()=>setMonthlySource(deviceGuestPlan(),"This device’s plan"));
el("monthlyFileButton").addEventListener("click",()=>el("monthlyFileInput").click());
el("monthlyFileInput").addEventListener("change",async(event)=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
    if(file.size>256*1024)throw new Error("Plan files must be 256 KB or smaller.");
    const plan=Monthly.parseWeeklyPlanFile(await file.text(),state.exercises);setMonthlySource(plan,"Uploaded plan file");
  }catch(error){setMonthlyValidation(error.message);showToast(error.message);}
  finally{event.target.value="";}
});
el("monthlyPdfButton").addEventListener("click",printMonthlyPlan);
el("monthlyShareButton").addEventListener("click",()=>void shareMonthlyPlan());
el("monthlyEditButton").addEventListener("click",()=>{monthlyPlanForm.scrollIntoView?.({behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches?"auto":"smooth",block:"start"});el("monthlyTitle").focus?.({preventScroll:true});});
el("communityPlanSearch").addEventListener("input",(event)=>{state.communityQuery=event.target.value;renderCommunityPlans();});
el("communityRefresh").addEventListener("click",()=>void loadCommunityPlans({reset:true}));
el("communityLoadMore").addEventListener("click",()=>void loadCommunityPlans());
el("communityPlanGrid").addEventListener("click",(event)=>{
  const apply=event.target.closest("[data-apply-community]"),retry=event.target.closest("[data-community-retry]");
  if(apply)openCommunityApplyDialog(apply.dataset.applyCommunity);else if(retry)void loadCommunityPlans({reset:true});
});
el("communityApplyConfirm").addEventListener("click",()=>void applyCommunityPlan());
el("communityApplyDialog").addEventListener("close",()=>{if(el("communityApplyDialog").dataset.busy!=="true")state.communityPendingId=null;});

document.addEventListener("submit",async(event)=>{
  const form=event.target.closest("[data-rating-form]");if(!form)return;event.preventDefault();
  const id=form.dataset.ratingForm;if(state.ratingSaving.has(id))return;
  const data=Object.fromEntries(new FormData(form)),rating=Object.fromEntries(Object.entries(data).map(([key,value])=>[key,Number(value)]));
  const button=form.querySelector("button"),status=form.querySelector("[data-rating-status]"),originalHtml=button.innerHTML;
  state.ratingSaving.add(id);form.setAttribute("aria-busy","true");const unlockControls=lockFormControls(form);let saved=false;
  button.textContent="Saving…";if(status)status.textContent="Saving…";
  try{
    const result=await api(`/api/ratings/${encodeURIComponent(id)}`,{method:"PUT",body:JSON.stringify({rating})});
    state.userRatings.set(id,result.rating);if(result.aggregate)state.aggregate.set(id,result.aggregate);else state.aggregate.delete(id);state.ratingsRefreshedAt=Date.now();saved=true;
  }catch(error){const message=saveRetryMessage(error);if(status)status.textContent=message;showToast(message);}
  finally{
    state.ratingSaving.delete(id);form.setAttribute("aria-busy","false");unlockControls();button.innerHTML=originalHtml;
    if(saved){
      renderCommunityViews();
      const activeForm=el("detailContent")?.querySelector?.("[data-rating-form]");
      if(activeForm?.dataset.ratingForm===id){const savedStatus=activeForm.querySelector("[data-rating-status]");if(savedStatus)savedStatus.textContent="Saved";}
      showToast("Saved. Your rating is on this account.");
    }
  }
});

async function revalidateMemberWorkspaceWhenVisible(){
  if(document.visibilityState&&document.visibilityState!=="visible"||!workspaceReady||workspaceRevalidating||discoveryLoading)return;
  workspaceRevalidating=true;clearPrivateWorkspace();
  try{await init();}
  finally{workspaceRevalidating=false;}
}

let discoveryLoading=false;
function initialLoadMessage(error){
  if(error?.code==="NETWORK_ERROR")return error.message;
  if(Number(error?.status)>=500)return "Strata+ is temporarily unavailable. Please try again in a moment.";
  return "Strata+ could not load. Please try again.";
}
function showInitialLoadProgress(){
  el("discoveryLoadError").hidden=true;el("discoveryRetry").disabled=true;
  state.workoutHistoryStatus="loading";state.workoutHistoryError="";state.workoutHistoryAvailable=false;if(el("plusStartWorkout"))el("plusStartWorkout").hidden=true;showTodayAlternative(false);renderProgress();
  el("profileStatus").textContent="Loading profile…";el("battleStatus").textContent="Loading exercises…";el("monthlyPlanStatus").textContent="Loading planner…";el("communityPlanStatus").textContent="Loading shared plans…";if(el("sessionStatus"))el("sessionStatus").textContent="Loading your profile and weekly plan…";
  el("recommendationGrid").innerHTML='<div class="loading-card">Building your ranking…</div>';
  if(el("rankingLensItems"))el("rankingLensItems").innerHTML="<li>Loading preferences…</li>";
  if(el("movementBoardStatus"))el("movementBoardStatus").textContent="Loading your decision board…";
  if(el("trainingBlockStatus"))el("trainingBlockStatus").textContent="Loading your optional training block…";
  if(el("progressAdherenceDetail"))el("progressAdherenceDetail").textContent="Loading planned and completed days…";
  el("exerciseGrid").hidden=false;el("exerciseGrid").innerHTML='<div class="loading-card">Loading exercise intelligence…</div>';el("emptyState").hidden=true;
}
function showInitialLoadError(error){
  const message=initialLoadMessage(error);
  el("profileStatus").textContent="Unable to load";el("battleStatus").textContent=message;el("monthlyPlanStatus").textContent=message;el("communityPlanStatus").textContent=message;if(el("sessionStatus"))el("sessionStatus").textContent=message;
  el("recommendationGrid").innerHTML=`<div class="loading-card load-error-card">${escapeHtml(message)}</div>`;el("exerciseGrid").innerHTML=`<div class="loading-card load-error-card">${escapeHtml(message)}</div>`;
  if(el("movementBoardStatus"))el("movementBoardStatus").textContent="Decision board unavailable until Strata+ reconnects.";
  el("discoveryLoadErrorMessage").textContent=message;el("discoveryLoadError").hidden=false;showToast(message);
}
async function init(){
  if(discoveryLoading)return;
  const generation=workspaceGeneration;discoveryLoading=true;showInitialLoadProgress();
  try{
    const data=await api("/api/discovery"),identity=await api("/api/me");
    if(generation!==workspaceGeneration)return;
    if(String(data.user?.id||"")!==String(identity.user?.id||"")||!data.csrfToken||String(data.csrfToken)!==String(identity.csrfToken||"")){dashboardAccountChanged();return;}
    if(identity.user?.discovery?.active!==true){const error=Object.assign(new Error("Strata+ access changed while this page was open."),{redirecting:true});window.location.replace("/pricing?reason=access-revoked");throw error;}
    state.exercises=data.exercises;state.methodology=data.methodology;state.sources=data.sources;state.limited=new Set(data.limitedConfidenceExercises);state.preferences=data.preferences;state.user=data.user;state.weeklyPlan=data.weeklyPlan||null;state.weeklyPlanUpdatedAt=Number(data.weeklyPlanUpdatedAt)||0;state.monthlyPlanUpdatedAt=Number(data.monthlyPlanUpdatedAt)||0;state.monthlyPlan=data.monthlyPlan||null;loadMovementBoard();
    state.csrfToken=String(data.csrfToken||"");state.aggregate=new Map((data.ratings.aggregates||[]).map((item)=>[item.exercise_id,item]));state.userRatings=new Map((data.ratings.user||[]).map((item)=>[item.exercise_id,item]));state.ratingsRefreshedAt=Date.now();
    el("userName").textContent=data.user.name;el("catalogTotal").textContent=state.exercises.length;
    renderProfile();renderMovementBoard();populateFilters();renderRecommendations();resetExplorerWindow();renderExplorer();renderCompareTray();populateMonthlyBuilder(state.monthlyPlan);initializeSessionBuilder();renderTrainingBlock();renderProgress();renderProgression();revealPrivateWorkspace();void loadMemberDashboard(generation);
    activateFeature(state.activeFeature||FEATURE_DEFAULT);
  }catch(error){if(!error?.redirecting&&!error?.stale)showInitialLoadError(error);}
  finally{discoveryLoading=false;el("discoveryRetry").disabled=false;}
}

EventsCore.bind({
  document,window,el,state,core:Core,movementBoardLimit:MOVEMENT_BOARD_LIMIT,searchDebounceMs:SEARCH_DEBOUNCE_MS,featureNavigation,
  actions:{api,activateFeature,closeDialog,explorerPageSize,featureName,hideToast,init,openComparison,openDetail,readBattleBuilder,renderCompareTray,renderExplorer,renderMovementBoard,renderRecommendations,resetExplorerWindow,resetFilters,restoreDialogFocus,revalidateMemberWorkspaceWhenVisible,saveMovementBoard,setCollectionState,shareCard,showToast,syncDialogState,toggleCompare,toggleMovementBoard}
});
initializeFeatureNavigation();
el("progressRetry")?.addEventListener("click",()=>void loadMemberDashboard(workspaceGeneration));
init();
