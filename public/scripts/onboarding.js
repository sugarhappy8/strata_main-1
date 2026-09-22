"use strict";
(()=>{
  const core=window.StrataOnboarding,discovery=window.StrataDiscovery,$=id=>document.getElementById(id);
  let exercises=[],user=null,csrf="",revision=0,preferenceRevision=0,original=null,preview=null,ready=false,busy=false,profileKey="",previousDownload=null,savedPreferenceTags=[],activationIntent=null;
  const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const signal=name=>globalThis.StrataSignals?.record?.(name);
  function status(message,{tone="",focus=false}={}){
    const node=$("setupStatus");
    node.dataset.state=tone;
    node.setAttribute("role",tone==="error"?"alert":"status");
    node.textContent=message;
    if(message&&focus)node.focus({preventScroll:false});
  }
  async function request(path,options={}){
    let response;
    try{response=await fetch(path,{credentials:"same-origin",...options,headers:{Accept:"application/json",...(options.body?{"Content-Type":"application/json","X-CSRF-Token":csrf,"X-Strata-User":String(user?.id||"")} :{}),...options.headers}});}catch{throw new Error("Connection interrupted. Your preview is still here; reconnect and retry.");}
    const data=await response.json().catch(()=>({}));
    if(response.status===401){ready=false;$("setupFields").disabled=true;$("saveWeek").disabled=true;}
    if(!response.ok)throw Object.assign(new Error(data.error||"STRATA could not load your account. Retry in a moment."),{status:response.status,code:data.code});
    return data;
  }
  function hasItems(plan){return core.DAYS.some(day=>plan?.days?.[day]?.length);}
  function values(name){return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input=>input.value);}
  function profile(){return {version:1,goal:$("goal").value,level:$("level").value,minutes:Number($("minutes").value),equipment:values("equipment"),availability:values("days"),preferences:[...savedPreferenceTags],limitations:values("limitations")};}
  function renderSnapshot(){
    const snapshot=core.trainingSnapshot(profile());
    $("setupDaysMetric").textContent=snapshot.trainingDays?`${snapshot.trainingDays} day${snapshot.trainingDays===1?"":"s"}`:"—";
    $("setupRecoveryMetric").textContent=snapshot.trainingDays?`${snapshot.recoveryDays} day${snapshot.recoveryDays===1?"":"s"}`:"—";
    $("setupMinutesMetric").textContent=snapshot.minutes?`${snapshot.minutes} min`:"—";
    $("setupReadiness").textContent=snapshot.message;
  }
  function rememberProfile(){try{localStorage.setItem(profileKey,JSON.stringify({version:1,minutes:Number($("minutes").value)}));}catch{status("Browser storage is unavailable. Keep this page open until your week is saved.",{tone:"error"});}}
  function restoreSessionLength(){
    let saved;try{saved=JSON.parse(localStorage.getItem(profileKey)||"null");}catch{return;}
    if(!saved||saved.version!==1)return;
    if([...$("minutes").options].some(option=>option.value===String(saved.minutes)))$("minutes").value=String(saved.minutes);
  }
  function renderSavedProfile(preferences,plan){
    const fresh=preferenceRevision===0&&!hasItems(plan);let saved=fresh?core.starterProfile():core.profileFromSaved(preferences,plan);
    activationIntent=null;
    if(fresh&&globalThis.StrataActivation?.readIntent){
      try{
        const intent=globalThis.StrataActivation.readIntent(localStorage);
        const allowedEquipment=new Set(exercises.map(exercise=>exercise.equipment));
        if(intent?.profile&&intent.profile.equipment.some(value=>allowedEquipment.has(value))){
          activationIntent=intent;saved={...saved,...intent.profile,equipment:intent.profile.equipment.filter(value=>allowedEquipment.has(value)),recoveryAdjusted:false};
        }
      }catch{/* Setup still works when private browser storage is unavailable. */}
    }
    savedPreferenceTags=[...saved.preferences];
    if([...$("goal").options].some(option=>option.value===String(saved.goal)))$("goal").value=String(saved.goal);
    if([...$("level").options].some(option=>option.value===String(saved.level)))$("level").value=String(saved.level);
    $("equipmentChoices").innerHTML=[...new Set(exercises.map(e=>e.equipment))].sort().map(value=>`<label><input type="checkbox" name="equipment" value="${escape(value)}" ${saved.equipment.includes(value)?"checked":""} /> ${escape(value)}</label>`).join("");
    $("dayChoices").innerHTML=core.DAYS.map(day=>`<label><input type="checkbox" name="days" value="${day}" ${saved.availability.includes(day)?"checked":""} /> ${day.slice(0,3)}</label>`).join("");
    document.querySelectorAll('input[name="limitations"]').forEach(input=>{input.checked=saved.limitations.includes(input.value);});
    if(activationIntent&&[...$("minutes").options].some(option=>option.value===String(saved.minutes)))$("minutes").value=String(saved.minutes);
    $("starterPath").hidden=!fresh;
    return saved;
  }
  function allowEditing(preferences){
    profileKey=`strata_setup_v1:user:${user.id}`;const saved=renderSavedProfile(preferences,original);if(!activationIntent)restoreSessionLength();ready=true;$("setupFields").disabled=false;
    const replacing=hasItems(original);
    $("setupKicker").textContent=replacing?"01 / REBUILD YOUR WEEK":"01 / YOUR STARTING POINT";
    $("generateWeekLabel").textContent=replacing?"Preview a replacement week":"Preview my first week";
    $("accountMode").textContent=(replacing
      ?`Strata+ · ${user.name||"Your account"}. You already have a saved week. Previewing is safe; saving a new week replaces it only after you confirm.`
      :activationIntent
        ?`Strata+ · ${user.name||"Your account"}. Your homepage choices survived signup and are ready below. Previewing and editing are safe; nothing reaches your account until you choose Save.`
        :`Strata+ · ${user.name||"Your account"}. Your profile and first saved week will sync across devices.`)+(saved.recoveryAdjusted?" Your saved setup used all seven training days, so this setup leaves Sunday open for recovery; review the selected days before previewing.":"");
    $("retrySetup").hidden=true;renderSnapshot();status("");
  }
  function setPlannerAction({conflict=false,hidden=false}={}){
    const link=$("openPlanner");
    link.textContent=conflict?"Open planner in a new tab →":"Adjust my saved week";
    link.target=conflict?"_blank":"";
    link.rel=conflict?"noopener":"";
    link.hidden=hidden;
    $("savedActions").hidden=hidden;
    if(conflict)$("startFirstWorkout").hidden=true;
  }
  function requirePlus(account){
    if(!account?.user?.id)throw new Error("Sign in to use Strata+ weekly setup. Your free Plan remains available without an account.");
    if(account.user.discovery?.active!==true){ready=false;$("setupFields").disabled=true;$("saveWeek").disabled=true;throw new Error("Guided weekly setup is a Strata+ feature. Your free Plan is unchanged. Review Strata+ access to continue.");}
  }
  async function verifyAccess(){
    const me=await request("/api/me",{cache:"no-store"});requirePlus(me);
    if(String(me.user.id)!==String(user?.id)){ready=false;throw new Error("The signed-in account changed. Reload setup before continuing.");}
    csrf=me.csrfToken;
  }
  async function init(){
    ready=false;$("setupFields").disabled=true;$("retrySetup").hidden=true;$("previewSummary").hidden=true;status("Loading your starting point…");
    try{
      if(!exercises.length){
        const response=await fetch("/exercises.json?v=8.5.0");if(!response.ok)throw new Error("The exercise library is unavailable. Reconnect and retry.");exercises=await response.json();
      }
      const account=await request("/api/setup",{cache:"no-store"});requirePlus(account);
      if(!account.csrfToken)throw new Error("Your account could not be verified. Retry before editing.");
      user=account.user;csrf=account.csrfToken;revision=Number(account.planUpdatedAt);preferenceRevision=Number(account.preferencesUpdatedAt)||0;original=account.plan;allowEditing(account.preferences);
    }catch(error){status(error.message,{tone:"error",focus:true});$("accountMode").textContent="Setup is unavailable right now. Your existing plan has not changed.";$("retrySetup").hidden=false;}
  }
  function renderPreview(){
    $("previewTitle").textContent="Review your week.";
    const snapshot=core.trainingSnapshot(profile(),preview);
    $("previewSummary").innerHTML=`<div><strong>${snapshot.trainingDays}</strong><span>training day${snapshot.trainingDays===1?"":"s"}</span></div><div><strong>${snapshot.movementCount}</strong><span>movements</span></div><div><strong>${snapshot.workingSets}</strong><span>working sets</span></div>`;
    $("previewSummary").hidden=false;
    $("weekPreview").innerHTML=core.DAYS.map(day=>{const session=preview.sessions.find(item=>item.day===day);return `<section class="preview-day"><h3>${day} ${session?`<small> / ${escape(session.focusLabel)}</small>`:""}</h3>${session?`<small>${escape(session.summary)}</small><details><summary>Review ${session.items.length} movements</summary><ul>${session.items.map(item=>`<li>${escape(item.exercise.name)} · ${item.sets} × ${escape(item.reps)}<br /><small>${escape(item.roleLabel)} · ${escape(item.exercise.equipment)}</small></li>`).join("")}</ul></details>`:"<small>Recovery / no planned session</small>"}</section>`;}).join("");
    $("replaceNotice").textContent=hasItems(original)?"You already have a saved week. Saving this preview replaces it; download a copy of your current week first.":"Your first week is ready. Save it, then adjust any movement, sets, or reps in the planner.";
    const oldLink=document.getElementById("previousWeek");if(oldLink)oldLink.remove();
    if(hasItems(original)){
      if(previousDownload)URL.revokeObjectURL(previousDownload);
      previousDownload=URL.createObjectURL(new Blob([JSON.stringify({format:"strata-weekly-plan",version:1,exportedAt:new Date().toISOString(),plan:original},null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.id="previousWeek";link.href=previousDownload;link.download="strata-previous-week.json";link.textContent="Download my current week";$("replaceNotice").after(link);
    }
    $("replaceLabel").hidden=!hasItems(original);$("replaceWeek").checked=false;$("saveControls").hidden=false;setPlannerAction({hidden:true});$("saveWeek").disabled=false;$("previewTitle").focus();
  }
  $("setupForm").addEventListener("submit",async event=>{
    event.preventDefault();if(!ready||busy)return;
    busy=true;$("setupFields").disabled=true;$("generateWeekLabel").textContent="Building your preview…";
    try{await verifyAccess();preview=core.buildWeek(profile(),exercises,discovery,()=>globalThis.crypto?.randomUUID?.()||`setup-${Date.now()}-${Math.random().toString(16).slice(2)}`);rememberProfile();try{activationIntent=globalThis.StrataActivation?.writeIntent?.(localStorage,{source:"onboarding",profile:profile(),plan:preview.plan})||activationIntent;}catch{}renderPreview();status("Preview ready. Review this week, save it, then open Plan to adjust it or Train to begin.",{tone:"good"});signal("onboarding_previewed");}
    catch(error){preview=null;$("previewSummary").hidden=true;$("saveControls").hidden=true;status(error.message,{tone:"error",focus:true});}
    finally{busy=false;$("setupFields").disabled=!ready;$("generateWeekLabel").textContent=hasItems(original)?"Preview a replacement week":"Preview my first week";}
  });
  $("setupForm").addEventListener("change",()=>{if(!ready)return;preview=null;$("previewSummary").hidden=true;$("saveControls").hidden=true;setPlannerAction({hidden:true});rememberProfile();renderSnapshot();status("Choices updated. Preview again to see your revised week.");});
  $("saveWeek").addEventListener("click",async()=>{
    if(!preview||busy||!ready)return;
    if(hasItems(original)&&!$("replaceWeek").checked){status("Review the preview and confirm replacing your current week first.",{tone:"error"});$("replaceWeek").focus();return;}
    busy=true;$("saveWeek").disabled=true;$("saveWeek").textContent="Saving your week…";$("setupFields").disabled=true;setPlannerAction({hidden:true});status("Saving your week…");
    try{
      await verifyAccess();
      const activationCandidate=activationIntent?{source:"onboarding",profile:activationIntent.profile,plan:preview.plan}:null;
      if(activationCandidate&&globalThis.StrataActivation?.backup)globalThis.StrataActivation.backup(localStorage,{userId:user.id,accountRevision:revision,accountPlan:original,candidate:activationCandidate,reason:"claim"});
      const saved=await request("/api/setup",{method:"PUT",body:JSON.stringify({plan:preview.plan,preferences:preview.preferences,expectedPlanUpdatedAt:revision,expectedPreferencesUpdatedAt:preferenceRevision,expectedUserId:user.id})});
      revision=saved.planUpdatedAt;preferenceRevision=saved.preferencesUpdatedAt;original=saved.plan||preview.plan;savedPreferenceTags=[...(saved.preferences?.preferences||preview.preferences.preferences)];
      try{if(activationCandidate)globalThis.StrataActivation?.acknowledge?.(localStorage,{userId:user.id,accountRevision:revision,accountPlan:original,candidate:activationCandidate,decision:"claimed"});}catch{}
      const firstDay=core.DAYS.find(day=>saved.plan?.days?.[day]?.length)||core.DAYS.find(day=>preview.plan?.days?.[day]?.length);
      $("startFirstWorkout").href=`/workout.html?day=${encodeURIComponent(firstDay||"Monday")}`;$("startFirstWorkout").hidden=false;
      $("saveControls").hidden=true;setPlannerAction();status("Saved to your account. Your first workout is ready; start now or adjust the week first.",{tone:"good"});signal("onboarding_saved");$("startFirstWorkout").focus();
    }catch(error){
      if(error.status===409){setPlannerAction({conflict:true});status("Your saved week changed in another tab or device. Your preview is safe here. Open the planner in a new tab to compare both before replacing anything.",{tone:"error"});$("openPlanner").focus();}
      else status(error.message,{tone:"error",focus:true});
    }
    finally{busy=false;$("saveWeek").textContent="Save this week and profile";$("saveWeek").disabled=!ready;$("setupFields").disabled=!ready;}
  });
  $("retrySetup").addEventListener("click",init);
  $("equipmentPresetChoices").addEventListener("click",event=>{
    const button=event.target.closest("[data-equipment-preset]");if(!button||!ready)return;
    const all=[...new Set(exercises.map(item=>item.equipment))],preset=button.dataset.equipmentPreset;
    const selected=preset==="gym"?all:preset==="dumbbells"?["Dumbbells","Bodyweight"]:["Bodyweight"];
    document.querySelectorAll('input[name="equipment"]').forEach(input=>{input.checked=selected.includes(input.value);});
    $("equipmentPresetChoices").querySelectorAll("button").forEach(item=>item.setAttribute("aria-pressed",String(item===button)));
    preview=null;$("previewSummary").hidden=true;$("saveControls").hidden=true;setPlannerAction({hidden:true});renderSnapshot();
    status(`${button.textContent.trim()} selected. Preview now, or adjust any choice below.`,{tone:"good"});$("generateWeek").focus();
  });
  void init();
})();
