(function(){
  "use strict";
  const W=globalThis.StrataWorkout,$=(id)=>document.getElementById(id),CONTEXT_KEY="strata_workout_offline_context_v1";
  const STORAGE_FAILED="This browser could not keep the latest device changes. Keep this page open and download a draft before leaving.";
  // saveError stays set until a device write succeeds, so no later render or message can report a failed save as saved.
  const state={context:null,record:null,catalog:new Map(),locked:false,saveError:""};
  const esc=(value)=>String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  // Inside the iOS app the screen stays awake while an unfinished workout is open here; browsers have no StrataAppMode.
  const appBridge=globalThis.StrataAppMode?.createWorkoutBridge?.()||null;let leaving=false;
  function syncApp(){appBridge?.sync({keepAwake:!leaving&&!state.locked&&state.record?.workout.status==="active"&&document.visibilityState!=="hidden"});}
  function unavailable(message){state.locked=true;syncApp();$("offlineSession").hidden=true;$("offlineUnavailable").hidden=false;$("offlineUnavailableMessage").textContent=message;$("offlineTitle").focus();}
  function error(message=""){const text=[state.saveError,message].filter(Boolean).join(" ");$("offlineError").textContent=text;$("offlineError").hidden=!text;}
  function setStates(sync="Sync pending",kind=""){$("deviceSaveState").textContent=state.saveError?"Couldn't save — Retry":"Saved on device";$("syncState").textContent=sync;$("syncState").className=kind;}
  function timestamp(value){const numeric=Number(value);if(Number.isFinite(numeric))return numeric;const parsed=Date.parse(String(value||""));return Number.isFinite(parsed)?parsed:0;}
  function readContext(){
    try{
      const context=JSON.parse(localStorage.getItem(CONTEXT_KEY)||"null");
      if(!context||context.version!==1||!/^account:[A-Za-z0-9_-]{1,160}$/.test(String(context.ownerId||"")))return null;
      if(String(context.userId||"")!==String(context.ownerId).slice(8)||!String(context.draftKey||"").startsWith(`${W.draftPrefix(context.ownerId)}`))return null;
      if(timestamp(context.authorizedUntil)<=Date.now())return null;
      let record=W.readDraft(localStorage.getItem(context.draftKey),context.ownerId),repairs=[];
      // A draft saved by an older build may hold one invalid value; reopen it with that value cleared instead of hiding the whole workout.
      if(!record)({record,repairs}=W.repairDraft(localStorage.getItem(context.draftKey),context.ownerId)||{record:null,repairs:[]});
      if(!record||record.contextId!==context.contextId||record.workout.status==="completed"&&!record.dirty)return null;
      return{context:{...context,authorizedUntil:timestamp(context.authorizedUntil)},record:{...record,key:context.draftKey},repairs};
    }catch{return null;}
  }
  function exercise(id){return state.catalog.get(id)||{name:String(id||"Movement")};}
  const LIMITS={weight:'min="0" max="1000" step="0.01" inputmode="decimal"',reps:'min="1" max="1000" step="1" inputmode="numeric"',seconds:'min="1" max="3600" step="1" inputmode="numeric"'};
  function input(entry,set,field,label,locked){return `<label>${esc(label)}<input type="number" ${LIMITS[field]||`min="${entry.effortType==="rpe"?1:0}" max="10" step="0.5" inputmode="decimal"`} data-value="${field}" value="${esc(set[field]??"")}"${locked?" disabled":""} /></label>`;}
  function render(){
    const workout=state.record.workout,counts=W.progress(workout),active=workout.status==="active";
    $("offlineSessionTitle").textContent=workout.title;$("offlineSessionMeta").textContent=`${W.displayDate(workout.date)} · ${counts.completed}/${counts.total} sets · authorized on this device`;
    $("offlineEntries").innerHTML=workout.entries.map((entry)=>{
      const movement=exercise(entry.exerciseId),timed=entry.measurement==="timed",weighted=entry.loadType!=="bodyweight",effort=["rir","rpe"].includes(entry.effortType);
      // Completed sets and finished workouts are read-only; uncheck a set to reopen it for editing.
      return `<article class="offline-entry" data-entry="${esc(entry.id)}"><h3>${esc(movement.name)}</h3><p>${esc(entry.prescribedReps)} planned · ${timed?"time":"reps"}${weighted?` · ${esc(entry.loadType)} load in ${esc(entry.unit)}`:" · bodyweight"}</p><div class="offline-sets">${entry.sets.map((set,index)=>{const locked=set.completed||!active;return `<div class="offline-set${set.completed?" is-complete":""}" data-set="${index}"><span>Set ${index+1}</span>${weighted?input(entry,set,"weight",entry.loadType==="assisted"?`Assist (${entry.unit})`:`Load (${entry.unit})`,locked):""}${timed?input(entry,set,"seconds","Seconds",locked):input(entry,set,"reps","Reps",locked)}${effort?input(entry,set,"effort",entry.effortType.toUpperCase(),locked):""}<label class="offline-complete"><input type="checkbox" data-complete ${set.completed?"checked":""}${active?"":" disabled"} /> Completed</label></div>`;}).join("")}</div><label class="offline-note">Private note<textarea maxlength="500" data-note${active?"":" disabled"}>${esc(entry.note||"")}</textarea></label></article>`;
    }).join("");
    $("finishOffline").disabled=!active;setStates();syncApp();
  }
  function entryFor(node){return state.record?.workout.entries.find((entry)=>entry.id===node.closest("[data-entry]")?.dataset.entry);}
  function persist(){
    if(state.locked||!state.record)return false;
    const savedAt=Date.now(),serialized=JSON.stringify({ownerId:state.record.ownerId,contextId:state.record.contextId,workout:state.record.workout,dirty:true,pausedSeconds:state.record.pausedSeconds??null,savedAt});
    // Never replace the last readable device copy with one that could not be opened again.
    if(!W.readDraft(serialized,state.record.ownerId)){state.saveError="This change was not stored because the workout would no longer open on this device.";setStates();error();return false;}
    try{localStorage.setItem(state.record.key,serialized);state.record.dirty=true;state.record.savedAt=savedAt;state.saveError="";setStates();error("");return true;}
    catch{state.saveError=STORAGE_FAILED;setStates();error();return false;}
  }
  function validateAccess(){if(!state.context||state.context.authorizedUntil<=Date.now()){unavailable("This device’s offline authorization expired. Your draft remains stored, but STRATA must confirm the original account and active access online before it can be opened again.");return false;}return true;}
  function invalidField(message){const invalid=$("offlineEntries").querySelector("[aria-invalid=true]");if(invalid){invalid.focus();error(message);}return Boolean(invalid);}
  async function sync(){
    if(state.locked||!state.record||!validateAccess())return;
    if(!navigator.onLine){setStates();error("You are still offline. Your workout remains on this device.");return;}
    if(invalidField("Correct or clear the highlighted value before syncing."))return;
    // Syncing continues on the workout page from the device copy, so unsaved changes would be lost.
    if(!persist()){error("Nothing was synced because the latest changes are not stored on this device. Choose Save on device to retry, or download a draft.");return;}
    $("syncWorkout").disabled=true;setStates("Checking account…");error("");
    try{
      const identityResponse=await fetch("/api/me",{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}}),identity=await identityResponse.json().catch(()=>({}));
      if(!identityResponse.ok||String(identity.user?.id)!==String(state.context.userId))throw new Error("Sign in to the original account before syncing this device draft.");
      if(identity.user?.discovery?.active!==true)throw new Error("Strata+ access is not active. The device draft is preserved but cannot sync until access is confirmed.");
      const latestResponse=await fetch(`/api/workouts/${encodeURIComponent(state.record.workout.id)}`,{credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}}),latestData=await latestResponse.json().catch(()=>({}));
      if(latestResponse.status===401||latestResponse.status===402)throw new Error("The original account or Strata+ access could not be confirmed.");
      const latest=latestResponse.ok?latestData.workout:null;
      if(latest&&Number(latest.revision)!==Number(state.record.workout.revision)){setStates("Conflict — Review");error("A newer server version exists. STRATA will show both versions; it will not overwrite either one automatically.");}
      else setStates();
      const destination=new URL("/workout.html",location.origin);destination.searchParams.set("from","offline");destination.hash=`resume=${encodeURIComponent(state.record.workout.id)}`;location.assign(destination.href);
    }catch(cause){setStates();error(cause.message||"STRATA could not verify this workout yet. Your device copy is preserved.");}
    finally{$("syncWorkout").disabled=false;}
  }
  function download(){
    if(!state.record)return;const blob=new Blob([JSON.stringify({format:"strata-workout-draft",version:1,workout:state.record.workout,unsaved:true,pausedRestSeconds:state.record.pausedSeconds??null},null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download=`strata-workout-${state.record.workout.date}-${state.record.workout.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);
  }
  function repairNotice(repairs){
    const labels={reps:"reps",seconds:"seconds",weight:"load",effort:"effort"};
    const items=repairs.map((item)=>`${exercise(item.exerciseId).name} set ${item.setIndex+1} ${item.field==="completed"?"completion":`${labels[item.field]} (${String(item.value).slice(0,24)})`}`);
    return `This device draft had values STRATA can’t save, so they were cleared to reopen the workout: ${items.join("; ")}. Check those sets before you sync.`;
  }
  function finishReady(){
    if(state.locked||!state.record||state.record.workout.status!=="active")return false;
    if(invalidField("Correct or clear the highlighted value before finishing."))return false;
    // The server refuses a finished workout without a completed set, so it could never sync.
    if(!W.progress(state.record.workout).completed){error("Complete at least one set before finishing a workout.");return false;}
    return true;
  }
  async function initialize(){
    const restored=readContext();if(!restored){unavailable("Reconnect, sign in to the original account, and open an active workout once before continuing it offline.");return;}
    state.context=restored.context;state.record=restored.record;
    try{const response=await fetch("/exercises.json?v=9.1.0");if(response.ok){const catalog=await response.json();state.catalog=new Map(catalog.map((item)=>[item.id,item]));}}catch{/* Exercise IDs remain usable if the public catalog is unavailable. */}
    const workout=state.record.workout,notices=restored.repairs.length?[repairNotice(restored.repairs)]:[];
    if(workout.status==="completed"&&!W.progress(workout).completed){workout.status="active";workout.completedAt=null;notices.push("This workout was finished on this device without a completed set, so it has been reopened. Complete at least one set before finishing it.");}
    $("offlineUnavailable").hidden=true;$("offlineSession").hidden=false;render();error(notices.join(" "));$("offlineSessionTitle").focus();
  }
  $("offlineEntries").addEventListener("input",(event)=>{
    if(state.locked)return;const entry=entryFor(event.target);if(!entry||state.record.workout.status!=="active")return;
    if(event.target.hasAttribute("data-note")){entry.note=W.cleanNote(event.target.value);persist();return;}
    if(!event.target.hasAttribute("data-value"))return;
    const index=Number(event.target.closest("[data-set]").dataset.set),set=entry.sets[index],field=event.target.dataset.value;if(!set||set.completed)return;
    const value=event.target.value===""?null:Number(event.target.value),message=event.target.validity.badInput?"Enter a number.":W.inputError(entry,field,value);
    // An invalid value stays in the field for correction but never replaces the last valid device copy.
    if(message){event.target.setAttribute("aria-invalid","true");error(`${exercise(entry.exerciseId).name}, set ${index+1}: ${message} This value is not saved.`);return;}
    event.target.removeAttribute("aria-invalid");set[field]=value;persist();
  });
  $("offlineEntries").addEventListener("change",(event)=>{
    if(!event.target.hasAttribute("data-complete")||state.locked)return;const entry=entryFor(event.target),row=event.target.closest("[data-set]"),index=Number(row?.dataset.set),set=entry?.sets[index];if(!set)return;
    if(state.record.workout.status!=="active"){event.target.checked=set.completed;return;}
    if(event.target.checked){
      const invalid=row.querySelector("[aria-invalid=true]");if(invalid){event.target.checked=false;invalid.focus();error("Correct this set’s highlighted value before completing it.");return;}
      const message=W.actualError(entry,set);if(message){event.target.checked=false;error(`${exercise(entry.exerciseId).name}: ${message}`);return;}
    }
    set.completed=event.target.checked;persist();render();if(set.completed)globalThis.StrataAppMode?.haptic("light");
    $("offlineEntries").querySelector(`[data-entry="${CSS.escape(entry.id)}"] [data-set="${index}"] [data-complete]`)?.focus();
  });
  $("saveOnDevice").addEventListener("click",()=>persist());$("syncWorkout").addEventListener("click",()=>void sync());$("downloadOfflineDraft").addEventListener("click",download);
  $("finishOffline").addEventListener("click",()=>{if(!finishReady())return;const counts=W.progress(state.record.workout),left=counts.total-counts.completed;$("finishOfflineCounts").textContent=`You’ve completed ${counts.completed} of ${counts.total} sets. ${left?`${left} ${left===1?"set":"sets"} will stay unfinished.`:"Every set is complete."}`;$("finishOfflineDialog").returnValue="cancel";$("finishOfflineDialog").showModal();});
  $("finishOfflineDialog").addEventListener("close",()=>{if($("finishOfflineDialog").returnValue!=="finish"||!finishReady())return;const workout=state.record.workout;workout.status="completed";workout.completedAt=Date.now();workout.elapsedSeconds=Math.min(604800,Math.max(0,Math.floor((workout.completedAt-workout.startedAt)/1000)));workout.restEndsAt=null;const stored=persist();render();globalThis.StrataAppMode?.haptic("success");error(stored?"Finished on this device. Reconnect and choose Review & sync to verify the original account and save it to history.":"Finished in this tab, but not stored on the device yet. Choose Save on device to retry.");});
  window.addEventListener("online",()=>{if(!state.locked){setStates();error("Connection restored. Choose Review & sync when you are ready.");}});
  // Warn before leaving when the latest changes exist only in this tab.
  window.addEventListener("beforeunload",(event)=>{if(!state.record)return;if(state.locked?state.saveError:!persist()){event.preventDefault();event.returnValue="";}});
  document.addEventListener("visibilitychange",syncApp);window.addEventListener("pagehide",()=>{leaving=true;syncApp();});window.addEventListener("pageshow",()=>{leaving=false;syncApp();});
  setInterval(()=>{validateAccess();syncApp();},5000);void initialize();
})();
