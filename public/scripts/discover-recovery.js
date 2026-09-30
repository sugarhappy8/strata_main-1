/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverRecovery=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  // The Overview recovery card and the Recovery destination. Everything shown comes from the member's own Polar
  // account through /api/wellness; nights are compared only with the member's usual nights.

  const FRESH_MS=5*60*1000,WEEKS=[4,8,12];

  function createController({element,api,state,core,getGeneration}){
    let today=null,todayAt=0,todayLoading=null,trends=new Map(),weeks=4,active="",failed=false;
    const esc=core.escapeHtml,date=()=>core.localDate();
    function stateMessage(result){
      const connection=result?.connection;
      if(!result)return {title:"Loading your recovery…",message:"Checking your Polar connection.",connect:false};
      if(!result.connected)return result.configured?{title:"Connect your Polar Loop",message:"See Polar’s Nightly Recharge, sleep, overnight stress signals, and heart rate here. Connect Polar in Account; it takes about a minute.",connect:true}:{title:"Recovery isn’t available yet",message:"Polar connections are not set up on this server yet.",connect:false};
      if(connection?.status==="reconnect")return {title:"Polar needs you to reconnect",message:core.syncErrorText(connection.lastError||"POLAR_AUTH"),connect:true,label:"Reconnect in Account"};
      if(connection?.importing)return {title:"Importing from Polar…",message:"STRATA is reading up to 28 days of your Polar history. This page updates when you come back to it.",connect:false};
      if(result.summary?.state==="no-data")return {title:"No nights from Polar yet",message:"Wear your Loop to sleep. Polar’s Nightly Recharge appears here the morning after, once Polar has synced.",connect:false};
      return null;
    }
    function metric(label,value,detail,tone="none"){return `<article class="recovery-metric" data-tone="${esc(tone)}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></article>`;}
    function usualText(usual,format){return usual?`Your usual ${format(usual.low)}–${format(usual.high)}`:"Your usual range appears after 7 nights";}
    function lighterLink(summary){
      const text=core.lighterText(summary.lighterSession);
      return text?`<p class="recovery-lighter${summary.lighterSession?.offer?"":" is-note"}">${esc(text)}${summary.lighterSession?.offer?' <a href="/workout.html">Open Train <span aria-hidden="true">↗</span></a>':""}</p>`:"";
    }
    function renderTodayCard(){
      const card=element("todayRecovery");if(!card)return;
      const result=today,summary=result?.summary,message=stateMessage(result),connect=element("todayRecoveryConnect");
      card.hidden=!result||!result.connected&&!result.configured;if(card.hidden)return;
      element("todayRecoveryAction").hidden=Boolean(message?.connect);connect.hidden=!message?.connect;
      if(message){
        element("todayRecoveryTitle").textContent=message.title;element("todayRecoveryDetail").textContent=message.message;element("todayRecoveryMetrics").innerHTML="";
        connect.firstChild.textContent=`${message.label||"Connect Polar"} `;return;
      }
      const stress=core.stressView(summary.stress);
      element("todayRecoveryTitle").textContent=summary.recovery?.label?`${summary.recovery.label} recovery`:"Nightly Recharge not ready";
      element("todayRecoveryDetail").textContent=summary.state==="stale"?`Latest night from Polar: ${core.dateLabel(summary.date)}. Sync Polar in Account if this looks old.`:core.lighterText(summary.lighterSession)||`Overnight stress signals: ${stress.label.toLowerCase()}.`;
      element("todayRecoveryMetrics").innerHTML=[["Sleep",core.durationText(summary.sleep?.asleepSeconds)],["HRV",core.numberText(summary.heart?.hrv,0,"ms")],["Resting HR",core.numberText(summary.heart?.today?.resting??summary.heart?.overnight,0,"bpm")]]
        .map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("");
    }
    function renderTodaySection(summary,connection){
      const recovery=summary.recovery||{},stress=core.stressView(summary.stress),sleep=summary.sleep||{},heart=summary.heart||{},total=(Number(sleep.deepSeconds)||0)+(Number(sleep.lightSeconds)||0)+(Number(sleep.remSeconds)||0);
      const stage=(key,label)=>total?`<i class="stage-${key}" style="width:${Math.round((Number(sleep[`${key}Seconds`])||0)/total*1000)/10}%" title="${label} ${core.durationText(sleep[`${key}Seconds`])}"></i>`:"";
      const heartDetail=heart.today?`Today: resting ${core.numberText(heart.today.resting,0,"bpm")}, range ${core.numberText(heart.today.min)}–${core.numberText(heart.today.max,0,"bpm")}`:"24/7 heart rate appears after Polar syncs today";
      element("recoveryToday").innerHTML=`<p class="recovery-date">Night ending ${esc(core.dateLabel(summary.date))}${summary.state==="stale"?` · ${esc(String(summary.ageDays))} days ago`:""} · synced ${esc(core.ago(connection?.lastSyncAt))}</p>
        <div class="recovery-metrics">${metric("Nightly Recharge",recovery.label||"Not ready",`ANS charge ${recovery.ansChargeLabel?recovery.ansChargeLabel.toLowerCase():"—"}${recovery.ansCharge!==null&&recovery.ansCharge!==undefined?` (${recovery.ansCharge>0?"+":""}${core.numberText(recovery.ansCharge,1)})`:""} · sleep charge ${recovery.sleepChargeLabel?recovery.sleepChargeLabel.toLowerCase():"—"}`,core.recoveryTone(recovery.status))}
        ${metric("Overnight stress signals",stress.label,stress.detail,stress.tone)}
        <article class="recovery-metric"><span>Sleep</span><strong>${esc(core.durationText(sleep.asleepSeconds))}</strong><small>${sleep.score!==null&&sleep.score!==undefined?`Sleep score ${esc(core.numberText(sleep.score))} · `:""}${esc(usualText(sleep.usual,core.durationText))}</small>${total?`<div class="recovery-stages" role="img" aria-label="Deep ${esc(core.durationText(sleep.deepSeconds))}, light ${esc(core.durationText(sleep.lightSeconds))}, REM ${esc(core.durationText(sleep.remSeconds))}">${stage("deep","Deep")}${stage("light","Light")}${stage("rem","REM")}</div>`:""}</article>
        ${metric("Overnight heart",`${core.numberText(heart.overnight,0,"bpm")} · HRV ${core.numberText(heart.hrv,0,"ms")}`,`Breathing ${core.numberText(heart.breathing,1,"/min")}. ${heartDetail}.`)}</div>${lighterLink(summary)}`;
    }
    function chart(title,series,key,usual,format,unit){
      const geometry=core.chartGeometry(series,key,{width:320,height:120,usual});
      if(geometry.empty)return `<figure class="recovery-chart"><figcaption>${esc(title)}</figcaption><p class="recovery-chart-empty">No ${esc(title.toLowerCase())} in this range yet.</p></figure>`;
      const last=geometry.points.at(-1),label=`${title}: ${geometry.points.length} nights, latest ${format(last.value)}${unit}. ${usual?`Your usual range is ${format(usual.low)} to ${format(usual.high)}${unit}.`:"Your usual range appears after 7 nights."}`;
      return `<figure class="recovery-chart"><figcaption>${esc(title)} <small>${esc(usual?`usual ${format(usual.low)}–${format(usual.high)}${unit}`:"")}</small></figcaption><svg viewBox="0 0 320 120" role="img" aria-label="${esc(label)}">${geometry.band?`<rect class="recovery-band" x="0" y="${geometry.band.y1}" width="320" height="${Math.max(1,geometry.band.y2-geometry.band.y1)}"/>`:""}${geometry.segments.map((segment)=>segment.length>1?`<polyline points="${segment.join(" ")}"/>`:"").join("")}${geometry.points.map((point)=>`<circle cx="${point.x}" cy="${point.y}" r="2.6"><title>${esc(core.dateLabel(point.date))}: ${esc(format(point.value))}${esc(unit)}</title></circle>`).join("")}</svg></figure>`;
    }
    function renderTrends(result){
      const data=result?.trends;if(!data)return;
      const series=data.series||[],usual=data.usual||{},hours=(seconds)=>core.durationText(seconds),round=(value)=>core.numberText(value);
      element("recoveryCharts").innerHTML=`<figure class="recovery-chart recovery-recharge"><figcaption>Nightly Recharge <small><i data-tone="good"></i>OK or better <i data-tone="mid"></i>Compromised <i data-tone="low"></i>Poor</small></figcaption><ol aria-label="Nightly Recharge by night">${series.map((point)=>`<li data-tone="${core.recoveryTone(point.recoveryStatus)}" title="${esc(`${core.dateLabel(point.date)}: ${core.recoveryName(point.recoveryStatus)}`)}"><span class="sr-only">${esc(core.dateLabel(point.date))}: ${point.recoveryStatus?esc(core.recoveryName(point.recoveryStatus)):"no result"}</span></li>`).join("")}</ol></figure>
        ${chart("Heart rate variability",series,"hrv",usual.hrv,round," ms")}${chart("Overnight heart rate",series,"heartRate",usual.heartRate,round," bpm")}${chart("Sleep",series,"asleepSeconds",usual.asleepSeconds,hours,"")}`;
      const training=new Map((data.training||[]).map((week)=>[week.start,week]));
      element("recoveryWeekly").innerHTML=`<table><caption class="sr-only">Weekly averages and training</caption><thead><tr><th scope="col">Week</th><th scope="col">Nights</th><th scope="col">Typical Recharge</th><th scope="col">Avg HRV</th><th scope="col">Avg sleep</th><th scope="col">STRATA workouts</th><th scope="col">Polar cardio load</th></tr></thead><tbody>${(data.weekly||[]).slice().reverse().map((week)=>`<tr><th scope="row">${esc(core.rangeLabel(week.start,week.end))}</th><td>${week.nights}</td><td>${esc(core.recoveryName(week.recoveryStatus))}</td><td>${esc(core.numberText(week.hrv,0,"ms"))}</td><td>${esc(core.durationText(week.asleepSeconds))}</td><td>${Number(training.get(week.start)?.strataWorkouts)||0}</td><td>${Number(training.get(week.start)?.cardioLoad)||0}</td></tr>`).join("")}</tbody></table>`;
      for(const button of element("recoveryRange").querySelectorAll("[data-recovery-weeks]"))button.setAttribute("aria-pressed",String(Number(button.dataset.recoveryWeeks)===weeks));
    }
    function renderPanel(){
      const message=failed?{title:"Recovery couldn’t load",message:"Check your connection, then try again.",connect:false,retry:true}:stateMessage(today),connect=element("recoveryConnect");
      element("recoveryState").hidden=!message;element("recoveryResults").hidden=Boolean(message);
      if(message){
        element("recoveryStateTitle").textContent=message.title;element("recoveryStateMessage").textContent=message.message;
        connect.hidden=!message.connect;connect.firstChild.textContent=`${message.label||"Connect Polar"} `;element("recoveryRetry").hidden=!message.retry;return;
      }
      renderTodaySection(today.summary,today.connection);renderTrends(trends.get(weeks));
    }
    async function loadToday({force=false}={}){
      if(!force&&today&&Date.now()-todayAt<FRESH_MS)return today;
      if(todayLoading)return todayLoading;
      const generation=getGeneration();
      todayLoading=(async()=>{
        try{const result=await api(`/api/wellness/today?date=${date()}`);if(generation!==getGeneration())return null;today=result;todayAt=Date.now();failed=false;return result;}
        finally{todayLoading=null;}
      })();
      return todayLoading;
    }
    async function loadTrends(){
      const range=weeks,generation=getGeneration();
      if(trends.has(range)&&Date.now()-todayAt<FRESH_MS)return;
      const result=await api(`/api/wellness/trends?weeks=${range}&date=${date()}`);
      if(generation===getGeneration())trends.set(range,result);
    }
    async function show(name,{force=false}={}){
      if(!state.user)return;
      try{
        await loadToday({force});if(active!==name)return;
        if(name==="recovery"&&today?.connected&&today.summary?.state!=="no-data")await loadTrends();
      }catch(error){if(error?.redirecting||error?.stale)return;failed=name==="recovery";}
      if(name==="today")renderTodayCard();else if(active==="recovery"){renderTodayCard();renderPanel();}
    }
    function activate(name){active=name;if(name==="today"||name==="recovery")void show(name);}
    function reset(){today=null;todayAt=0;todayLoading=null;trends=new Map();failed=false;weeks=4;const card=element("todayRecovery");if(card)card.hidden=true;}
    element("recoveryRetry")?.addEventListener("click",()=>{failed=false;void show("recovery",{force:true});});
    element("recoveryRange")?.addEventListener("click",(event)=>{
      const button=event.target.closest?.("[data-recovery-weeks]"),next=Number(button?.dataset.recoveryWeeks);
      if(!WEEKS.includes(next)||next===weeks)return;weeks=next;void show("recovery");
    });
    return{activate,reset};
  }
  return{createController};
});
