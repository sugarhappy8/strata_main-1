(function(){
  "use strict";
  const W=globalThis.StrataWorkout,$=(id)=>document.getElementById(id),CONTEXT_KEY="strata_workout_offline_context_v1";
  const state={context:null,record:null,catalog:new Map(),locked:false};
  const esc=(value)=>String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  function unavailable(message){state.locked=true;$("offlineSession").hidden=true;$("offlineUnavailable").hidden=false;$("offlineUnavailableMessage").textContent=message;$("offlineTitle").focus();}
  function error(message=""){$("offlineError").textContent=message;$("offlineError").hidden=!message;}
  function setStates(device="Saved on device",sync="Sync pending",kind=""){$("deviceSaveState").textContent=device;$("syncState").textContent=sync;$("syncState").className=kind;}
  function timestamp(value){const numeric=Number(value);if(Number.isFinite(numeric))return numeric;const parsed=Date.parse(String(value||""));return Number.isFinite(parsed)?parsed:0;}
  function readContext(){
    try{
      const context=JSON.parse(localStorage.getItem(CONTEXT_KEY)||"null");
      if(!context||context.version!==1||!/^account:[A-Za-z0-9_-]{1,160}$/.test(String(context.ownerId||"")))return null;
      if(String(context.userId||"")!==String(context.ownerId).slice(8)||!String(context.draftKey||"").startsWith(`${W.draftPrefix(context.ownerId)}`))return null;
      if(timestamp(context.authorizedUntil)<=Date.now())return null;
      const record=W.readDraft(localStorage.getItem(context.draftKey),context.ownerId);
      if(!record||record.contextId!==context.contextId||record.workout.status==="completed"&&!record.dirty)return null;
      return{context:{...context,authorizedUntil:timestamp(context.authorizedUntil)},record:{...record,key:context.draftKey}};
    }catch{return null;}
  }
  function exercise(id){return state.catalog.get(id)||{name:String(id||"Movement")};}
  function input(value,attribute,label){return `<label>${esc(label)}<input type="number" inputmode="decimal" min="0" max="1000" step="0.01" data-value="${attribute}" value="${value??""}" /></label>`;}
  function render(){
    const workout=state.record.workout,counts=W.progress(workout);
    $("offlineSessionTitle").textContent=workout.title;$("offlineSessionMeta").textContent=`${workout.date} · ${counts.completed}/${counts.total} sets · authorized on this device`;
    $("offlineEntries").innerHTML=workout.entries.map((entry)=>{
      const movement=exercise(entry.exerciseId),timed=entry.measurement==="timed",weighted=entry.loadType!=="bodyweight",effort=["rir","rpe"].includes(entry.effortType);
      return `<article class="offline-entry" data-entry="${esc(entry.id)}"><h3>${esc(movement.name)}</h3><p>${esc(entry.prescribedReps)} planned · ${timed?"time":"reps"}${weighted?` · ${esc(entry.loadType)} load in ${esc(entry.unit)}`:" · bodyweight"}</p><div class="offline-sets">${entry.sets.map((set,index)=>`<div class="offline-set" data-set="${index}"><span>Set ${index+1}</span>${weighted?input(set.weight,"weight",entry.loadType==="assisted"?`Assist (${entry.unit})`:`Load (${entry.unit})`):""}${timed?input(set.seconds,"seconds","Seconds"):input(set.reps,"reps","Reps")}${effort?input(set.effort,"effort",entry.effortType.toUpperCase()):""}<label class="offline-complete"><input type="checkbox" data-complete ${set.completed?"checked":""} /> Completed</label></div>`).join("")}</div><label class="offline-note">Private note<textarea maxlength="500" data-note>${esc(entry.note||"")}</textarea></label></article>`;
    }).join("");
    $("finishOffline").disabled=workout.status!=="active";setStates("Saved on device","Sync pending");
  }
  function entryFor(node){return state.record?.workout.entries.find((entry)=>entry.id===node.closest("[data-entry]")?.dataset.entry);}
  function persist(){
    if(state.locked||!state.record)return false;
    state.record.dirty=true;state.record.savedAt=Date.now();
    try{localStorage.setItem(state.record.key,JSON.stringify({ownerId:state.record.ownerId,contextId:state.record.contextId,workout:state.record.workout,dirty:true,pausedSeconds:state.record.pausedSeconds??null,savedAt:state.record.savedAt}));setStates("Saved on device","Sync pending");error("");return true;}
    catch{setStates("Couldn't save — Retry","Sync pending");error("This browser could not keep the latest device changes. Keep this page open and download a draft before leaving.");return false;}
  }
  function validateAccess(){if(!state.context||state.context.authorizedUntil<=Date.now()){unavailable("This device’s offline authorization expired. Your draft remains stored, but STRATA must confirm the original account and active access online before it can be opened again.");return false;}return true;}
  async function sync(){
    if(state.locked||!state.record||!validateAccess())return;
    if(!navigator.onLine){setStates("Saved on device","Sync pending");error("You are still offline. Your workout remains on this device.");return;}
    $("syncWorkout").disabled=true;setStates("Saved on device","Checking account…");error("");
    try{
      const identityResponse=await fetch("/api/me",{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}}),identity=await identityResponse.json().catch(()=>({}));
      if(!identityResponse.ok||String(identity.user?.id)!==String(state.context.userId))throw new Error("Sign in to the original account before syncing this device draft.");
      if(identity.user?.discovery?.active!==true)throw new Error("Strata+ access is not active. The device draft is preserved but cannot sync until access is confirmed.");
      const latestResponse=await fetch(`/api/workouts/${encodeURIComponent(state.record.workout.id)}`,{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}}),latestData=await latestResponse.json().catch(()=>({}));
      if(latestResponse.status===401||latestResponse.status===402)throw new Error("The original account or Strata+ access could not be confirmed.");
      const latest=latestResponse.ok?latestData.workout:null;
      if(latest&&Number(latest.revision)!==Number(state.record.workout.revision)){setStates("Saved on device","Conflict — Review");error("A newer server version exists. STRATA will show both versions; it will not overwrite either one automatically.");}
      else setStates("Saved on device","Sync pending");
      const destination=new URL("/workout.html",location.origin);destination.searchParams.set("from","offline");destination.hash=`resume=${encodeURIComponent(state.record.workout.id)}`;location.assign(destination.href);
    }catch(cause){setStates("Saved on device","Sync pending");error(cause.message||"STRATA could not verify this workout yet. Your device copy is preserved.");}
    finally{$("syncWorkout").disabled=false;}
  }
  function download(){
    if(!state.record)return;const blob=new Blob([JSON.stringify({format:"strata-workout-draft",version:1,workout:state.record.workout,unsaved:true,pausedRestSeconds:state.record.pausedSeconds??null},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download=`strata-workout-${state.record.workout.date}-${state.record.workout.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function initialize(){
    const restored=readContext();if(!restored){unavailable("Reconnect, sign in to the original account, and open an active workout once before continuing it offline.");return;}
    state.context=restored.context;state.record=restored.record;
    try{const response=await fetch("/exercises.json?v=8.5.0");if(response.ok){const catalog=await response.json();state.catalog=new Map(catalog.map((item)=>[item.id,item]));}}catch{/* Exercise IDs remain usable if the public catalog is unavailable. */}
    $("offlineUnavailable").hidden=true;$("offlineSession").hidden=false;render();$("offlineSessionTitle").focus();
  }
  $("offlineEntries").addEventListener("input",(event)=>{
    if(state.locked)return;const entry=entryFor(event.target);if(!entry)return;
    if(event.target.hasAttribute("data-note")){entry.note=event.target.value;persist();return;}
    if(!event.target.hasAttribute("data-value"))return;const set=entry.sets[Number(event.target.closest("[data-set]").dataset.set)],value=event.target.value===""?null:Number(event.target.value);set[event.target.dataset.value]=Number.isFinite(value)?value:null;event.target.toggleAttribute("aria-invalid",event.target.value!==""&&!Number.isFinite(value));persist();
  });
  $("offlineEntries").addEventListener("change",(event)=>{
    if(!event.target.hasAttribute("data-complete")||state.locked)return;const entry=entryFor(event.target),set=entry?.sets[Number(event.target.closest("[data-set]").dataset.set)];if(!set)return;
    if(event.target.checked){const message=W.actualError(entry,set);if(message){event.target.checked=false;error(`${exercise(entry.exerciseId).name}: ${message}`);return;}}
    set.completed=event.target.checked;persist();render();
  });
  $("saveOnDevice").addEventListener("click",persist);$("syncWorkout").addEventListener("click",()=>void sync());$("downloadOfflineDraft").addEventListener("click",download);
  $("finishOffline").addEventListener("click",()=>$("finishOfflineDialog").showModal());
  $("finishOfflineDialog").addEventListener("close",()=>{if($("finishOfflineDialog").returnValue!=="finish"||!state.record)return;const workout=state.record.workout;workout.status="completed";workout.completedAt=Date.now();workout.elapsedSeconds=Math.min(604800,Math.max(0,Math.floor((workout.completedAt-workout.startedAt)/1000)));workout.restEndsAt=null;persist();render();error("Finished on this device. Reconnect and choose Review & sync to verify the original account and save it to history.");});
  window.addEventListener("online",()=>{if(!state.locked){setStates("Saved on device","Sync pending");error("Connection restored. Choose Review & sync when you are ready.");}});window.addEventListener("beforeunload",persist);setInterval(validateAccess,5000);void initialize();
})();
