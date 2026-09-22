"use strict";

const LOGIC=globalThis.StrataHomeLogic;
const STATE=globalThis.StrataHomeState;
const API=globalThis.StrataHomeApi;
const RENDER=globalThis.StrataHomeRender;
const EVENTS=globalThis.StrataHomeEvents;
if(!LOGIC||!STATE||!API||!RENDER||!EVENTS)throw new Error("Homepage modules are unavailable. Reload STRATA to try again.");

const state=STATE.createState();
const el=id=>document.getElementById(id);
const groupTabs=el("groupTabs");
const submuscleFilters=el("submuscleFilters");
const exerciseList=el("exerciseList");
const apiClient=API.createClient({fetchImpl:(...args)=>fetch(...args)});

async function api(path,options={}){return apiClient.request(path,options);}
function previewGroup(){return LOGIC.validPreviewGroup(el("quickPreviewGroup").value);}
function quickPreviewProfile(){
  return LOGIC.previewProfile({
    goal:el("quickPreviewGoal").value,group:el("quickPreviewGroup").value,equipment:el("quickPreviewEquipment").value,
    level:el("quickPreviewLevel").value,days:el("quickPreviewDays").value,minutes:el("quickPreviewMinutes").value
  });
}
function guestPlanCount(){
  let raw=null;
  try{raw=localStorage.getItem(LOGIC.GUEST_PLAN_KEY);}catch{/* Device storage is optional. */}
  return LOGIC.guestPlanCount(raw,state.catalogStatus==="ready"?state.exercises:null);
}

const renderer=RENDER.createRenderer({document,window,state,readPreviewProfile:quickPreviewProfile,guestPlanCount});
function renderSubfilters(){renderer.renderSubfilters();}
function renderExercises(){renderer.renderExercises();}
function updateCompareDock(){renderer.updateCompareDock();}
function updateAccountUI(){renderer.updateAccountUI();}
function renderAll(){renderer.renderAll();}
function previewPlaceholder(message){renderer.previewPlaceholder(message);}
function updatePreviewEquipmentOptions(options){renderer.updatePreviewEquipmentOptions(options);}
function previewResultMarkup(item){return RENDER.previewResultMarkup(item);}
function openDetail(id){renderer.openDetail(id);}
function comparisonAllowed(){return LOGIC.comparisonAccessIsFresh(state);}
function rejectComparison(){if(state.accountStatus!=="rechecking")STATE.clearComparison(state);renderer.syncComparisonAccess();return false;}
function retryComparison(action){
  if(state.accountStatus!=="authenticated"||state.user?.discovery?.active!==true)return rejectComparison();
  return recheckAccount({preserveAccountChrome:true}).then(()=>comparisonAllowed()?action():rejectComparison());
}
function openComparison(){return comparisonAllowed()?renderer.openComparison():retryComparison(()=>renderer.openComparison());}
function closeModal(dialog){renderer.closeModal(dialog);}
function showToast(message){renderer.showToast(message);}

function applyPreviewStarter(name){
  const preset=LOGIC.previewStarter(name);if(!preset||state.catalogStatus!=="ready")return;
  el("quickPreviewGoal").value=preset.goal;el("quickPreviewGroup").value="chest";el("quickPreviewLevel").value=preset.level;el("quickPreviewDays").value="3";el("quickPreviewMinutes").value=String(preset.minutes);
  updatePreviewEquipmentOptions();
  if(![...el("quickPreviewEquipment").options].some(option=>option.value===preset.equipment)){
    previewPlaceholder("This starting point is unavailable. Choose your equipment below.");el("quickPreviewStatus").textContent="Choose available equipment, then build your week.";return;
  }
  el("quickPreviewEquipment").value=preset.equipment;generateQuickPreview();
}

function applyActivationProfile(profile){
  el("quickPreviewGoal").value=profile.goal;el("quickPreviewGroup").value=profile.focusGroup&&LOGIC.GROUPS[profile.focusGroup]?profile.focusGroup:"chest";el("quickPreviewLevel").value=profile.level;
  el("quickPreviewDays").value=String(profile.availability.length);el("quickPreviewMinutes").value=String(profile.minutes);updatePreviewEquipmentOptions();
  const options=[...el("quickPreviewEquipment").options],selected=profile.equipment.find(value=>options.some(option=>option.value===value));if(selected)el("quickPreviewEquipment").value=selected;
}

function generateQuickPreview(){
  const output=el("quickPreviewOutput"),submit=el("quickPreviewSubmit");output.setAttribute("aria-busy","true");submit.disabled=true;el("quickPreviewStatus").textContent="Building all seven days…";
  try{
    const sample=quickPreviewProfile(),home=window.StrataHomeActivation;
    if(!home?.generate){
      const fallback=window.StrataPreview.buildPreview({exercises:state.exercises,profile:sample,discovery:window.StrataDiscovery,limit:3});
      el("quickPreviewSummary").textContent=fallback.summary;el("quickPreviewResults").innerHTML=fallback.items.map(previewResultMarkup).join("");el("quickPreviewActions").hidden=false;el("quickPreviewStatus").textContent="Shortlist ready. Reload before continuing if the complete-week preview does not appear.";return;
    }
    const result=home.generate({exercises:state.exercises,sample,previewResultMarkup});
    if(!result.stored)el("quickPreviewStatus").textContent="Your complete week is visible, but this browser blocked the private device draft. Keep this page open while you create or sign in to an account.";
    el("quickPreviewSummary").focus({preventScroll:false});
    try{window.dispatchEvent?.(new CustomEvent("strata:milestone",{detail:{name:"preview_generated"}}));}catch{/* Product signals are best effort. */}
  }catch(error){
    previewPlaceholder(error.message||"This preview could not be generated. Adjust a choice and try again.");el("quickPreviewStatus").textContent=error.message||"This preview could not be generated. Adjust a choice and try again.";
  }finally{output.setAttribute("aria-busy","false");submit.disabled=state.catalogStatus!=="ready";}
}

function selectGroup(group,restoreFocus=true){
  if(!STATE.selectGroup(state,group))return;renderAll();if(restoreFocus)renderer.focusRenderedControl(groupTabs,"data-group",group);
}
function selectSubfilter(sub,restoreFocus=true){
  if(!STATE.selectSubfilter(state,sub))return;renderSubfilters();renderExercises();if(restoreFocus)renderer.focusRenderedControl(submuscleFilters,"data-sub",sub);
}
function addToPlanner(id){window.location.assign(LOGIC.plannerUrl(id));}
function applyComparisonToggle(id){
  const detailWasOpen=renderer.detailDialog.open,result=LOGIC.toggleComparison(state.compare,id);
  if(result.full){showToast("Comparison tray is full");return;}
  state.compare=result.compare;updateCompareDock();renderExercises();
  if(detailWasOpen){renderer.detailDialog.close();requestAnimationFrame(()=>{openDetail(id);renderer.focusRenderedControl(renderer.detailDialog,"data-compare",id);});}
  else renderer.focusRenderedControl(exerciseList,"data-compare",id);
}
function toggleCompare(id){return comparisonAllowed()?applyComparisonToggle(id):retryComparison(()=>applyComparisonToggle(id));}

function resetFilters(){
  if(state.catalogStatus==="error"){void initializeCatalog();return;}
  STATE.resetFilters(state);el("searchInput").value="";el("levelFilter").value="all";renderAll();requestAnimationFrame(()=>el("searchInput").focus());
}
function clearCompare(){state.compare=[];updateCompareDock();renderExercises();requestAnimationFrame(()=>el("searchInput").focus());}

let accountRequestId=0,accountRecheck=null,comparisonAccessTimer=null;
function syncAccountBoundUI(){renderer.syncComparisonAccess();updateAccountUI();}
function scheduleComparisonAccessRecheck(){
  clearTimeout(comparisonAccessTimer);comparisonAccessTimer=null;if(!LOGIC.canCompareExercises(state))return;
  const delay=Math.max(0,LOGIC.COMPARISON_ACCESS_MAX_AGE_MS-(Date.now()-state.accountVerifiedAt)+25);
  comparisonAccessTimer=setTimeout(()=>{comparisonAccessTimer=null;if(!document.visibilityState||document.visibilityState==="visible")void recheckAccount({preserveAccountChrome:true});else{STATE.beginAccountRecheck(state);renderer.syncComparisonAccess();}},delay);
  comparisonAccessTimer?.unref?.();
}
async function initializeAccount({recheck=false,preserveAccountChrome=false}={}){
  const requestId=++accountRequestId;
  if(recheck){STATE.beginAccountRecheck(state);renderer.syncComparisonAccess();if(!preserveAccountChrome)updateAccountUI();}
  try{const result=await api("/api/me",{cache:"no-store"});if(requestId!==accountRequestId)return;STATE.setAccount(state,result.user);}
  catch(error){if(requestId!==accountRequestId)return;if(error.status===401)STATE.setAccount(state,null);else STATE.setAccountUnavailable(state);}
  syncAccountBoundUI();scheduleComparisonAccessRecheck();
  const requestedSignin=new URLSearchParams(location.search).get("signin")==="1";
  if(requestedSignin&&state.accountStatus!=="unavailable"){
    history.replaceState({},"","/");window.location.assign(state.user?"/planner.html":"/account.html?mode=login");
  }else if(requestedSignin)showToast("Could not confirm your account. Check your connection and try again.");
}
function recheckAccount(options={}){
  if(accountRecheck)return accountRecheck;
  accountRecheck=initializeAccount({recheck:true,...options}).finally(()=>{accountRecheck=null;});return accountRecheck;
}

async function initializeCatalog(){
  state.catalogStatus="loading";renderAll();
  try{STATE.setCatalog(state,await api("/exercises.json?v=8.5.0"));el("catalogTotal").textContent=state.exercises.length;}
  catch{STATE.failCatalog(state);}
  renderAll();updatePreviewEquipmentOptions();window.StrataHomeActivation?.restore?.({exercises:state.exercises,applyProfile:applyActivationProfile,readSample:quickPreviewProfile,previewResultMarkup});
}

EVENTS.bindHomeEvents({
  document,window,state,groupOrder:LOGIC.GROUP_ORDER,
  actions:{
    addToPlanner,applyPreviewStarter,clearCompare,closeModal,dialogs:[renderer.detailDialog,renderer.compareDialog],generateQuickPreview,openComparison,openDetail,previewGroup,previewPlaceholder,
    recheckAccount,renderExercises,resetFilters,restoreModalFocus:renderer.restoreModalFocus,selectGroup,selectSubfilter,syncDialogState:renderer.syncDialogState,toggleCompare,updatePreviewEquipmentOptions
  }
});

void initializeCatalog();
void initializeAccount();
