"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const Core=require("../public/scripts/devices-core");
const AccountDevices=require("../public/scripts/account-devices");
const DiscoverRecovery=require("../public/scripts/discover-recovery");
const WorkoutRecovery=require("../public/scripts/workout-recovery");

const NOW=Date.parse("2026-09-28T09:00:00Z");

class FakeElement{
  constructor(id){this.id=id;this.hidden=false;this.disabled=false;this.checked=false;this.textContent="";this.innerHTML="";this.href="";this.dataset={};this.listeners={};this.focused=0;this.scrolled=0;this.returnValue="";this.opened=0;this.clicks=0;
    const classes=new Set();this.classList={toggle:(name,force)=>{if(force)classes.add(name);else classes.delete(name);},contains:(name)=>classes.has(name)};
    this.firstElementChild={textContent:""};this.firstChild={textContent:""};}
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  async emit(type,extra={}){for(const handler of this.listeners[type]||[])await handler({currentTarget:this,target:this,...extra});}
  focus(){this.focused+=1;}
  scrollIntoView(){this.scrolled+=1;}
  showModal(){this.opened+=1;}
  click(){this.clicks+=1;return this.onclick?.();}
  querySelectorAll(){return this.children||[];}
}
function page(ids){const elements=new Map(ids.map((id)=>[id,new FakeElement(id)]));return {elements,element:(id)=>elements.get(id)||null};}
const ACCOUNT_IDS=["connectedDevices","devicesTitle","devicesBadge","devicesDetail","devicesWarning","devicesFacts","devicesConnectedAt","devicesLastSync","devicesSyncedThrough","devicesSuggestionsField","devicesSuggestions","devicesConsent","devicesConsentTitle","devicesConsentCheck","devicesContinue","devicesConsentCancel","devicesConnect","devicesUpgrade","devicesRecovery","devicesSync","devicesDisconnect","devicesStatus","devicesDisconnectDialog"];
const flush=async()=>{for(let index=0;index<6;index+=1)await new Promise(setImmediate);};

test("device wording, dates, and durations stay readable when values are missing",()=>{
  assert.equal(Core.escapeHtml(`<a href="x">'&`),"&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  assert.equal(Core.localDate(new Date(2026,8,5,23,30)),"2026-09-05");
  assert.equal(Core.durationText(25800),"7h 10m");assert.equal(Core.durationText(2700),"45m");assert.equal(Core.durationText(null),"—");assert.equal(Core.durationText(-1),"—");
  assert.equal(Core.numberText(61.26,1,"ms"),"61.3 ms");assert.equal(Core.numberText("",0),"—");assert.equal(Core.numberText(52),"52");
  assert.equal(Core.ago(NOW-20*1000,NOW),"just now");assert.equal(Core.ago(NOW-12*60*1000,NOW),"12 min ago");assert.equal(Core.ago(NOW-3*60*60*1000,NOW),"3 h ago");
  assert.equal(Core.ago(NOW-26*60*60*1000,NOW),"yesterday");assert.equal(Core.ago(NOW-4*24*60*60*1000,NOW),"4 days ago");assert.equal(Core.ago(null,NOW),"not yet");
  assert.equal(Core.dateLabel("2026-09-28"),"Mon, Sep 28");assert.equal(Core.dateLabel("nope"),"—");
  assert.equal(Core.nightAge("2026-09-25","2026-09-28"),3);
  assert.deepEqual(Core.returnOutcome("?devices=polar-return"),{code:"polar-return",complete:true,error:false,message:"Finishing your Polar connection…"});
  assert.equal(Core.returnOutcome("?devices=polar-declined").error,false);assert.equal(Core.returnOutcome("?devices=polar-failed").error,true);
  assert.equal(Core.returnOutcome("?devices=other"),null);assert.equal(Core.returnOutcome(""),null);assert.equal(Core.returnOutcome("?devices=toString"),null);
  assert.match(Core.syncErrorText("POLAR_AUTH"),/Reconnect Polar/);assert.match(Core.syncErrorText("SOMETHING"),/try again/);assert.equal(Core.syncErrorText(null),"");
  assert.equal(Core.recoveryTone(1),"low");assert.equal(Core.recoveryTone(3),"mid");assert.equal(Core.recoveryTone(6),"good");assert.equal(Core.recoveryTone(null),"none");
});

test("the Account card offers the right actions for each connection state",()=>{
  const connection=(overrides={})=>({provider:"polar",status:"active",connectedAt:NOW-86400000,lastSyncAt:NOW-3600000,syncedThrough:"2026-09-28",lastError:null,settings:{recoverySuggestions:true},revision:2,importing:false,...overrides});
  assert.equal(Core.connectionView(null).visible,false);assert.equal(Core.connectionView({configured:false,plus:true,connection:null}).state,"unavailable");
  const upsell=Core.connectionView({configured:true,plus:false,connection:null});assert.equal(upsell.state,"upsell");assert.equal(upsell.upgrade,true);assert.equal(upsell.connect,false);
  const disconnected=Core.connectionView({configured:true,plus:true,connection:null});assert.equal(disconnected.connect,true);assert.equal(disconnected.disconnect,false);
  const active=Core.connectionView({configured:true,plus:true,connection:connection()},NOW);
  assert.deepEqual([active.state,active.sync,active.recovery,active.disconnect,active.suggestions,active.facts,active.warning],["active",true,true,true,true,true,""]);assert.match(active.detail,/1 h ago/);
  assert.match(Core.connectionView({configured:true,plus:true,connection:connection({lastError:"POLAR_UNAVAILABLE"})},NOW).warning,/unavailable/);
  assert.equal(Core.connectionView({configured:true,plus:true,connection:connection({lastError:"PLUS_INACTIVE"})},NOW).warning,"","a renewed member is not told syncing is paused");
  const importing=Core.connectionView({configured:true,plus:true,connection:connection({importing:true,lastSyncAt:null})});assert.equal(importing.state,"importing");assert.equal(importing.sync,false);
  const reconnect=Core.connectionView({configured:true,plus:true,connection:connection({status:"reconnect",lastError:"POLAR_AUTH"})});
  assert.deepEqual([reconnect.state,reconnect.connect,reconnect.connectLabel,reconnect.disconnect,reconnect.upgrade],["reconnect",true,"Reconnect Polar",true,false]);
  const lapsedReconnect=Core.connectionView({configured:false,plus:false,connection:connection({status:"reconnect",lastError:null})});assert.equal(lapsedReconnect.connect,false);assert.equal(lapsedReconnect.upgrade,true);assert.match(lapsedReconnect.detail,/Reconnect Polar/);
  const paused=Core.connectionView({configured:true,plus:false,connection:connection()});assert.deepEqual([paused.state,paused.upgrade,paused.disconnect,paused.sync],["paused",true,true,false]);
});

test("stress signals, lighter-session wording, and the lighter workout follow the recovery rules",()=>{
  assert.deepEqual(Core.stressView(null),{label:"—",detail:"",tone:"none"});
  assert.match(Core.stressView({level:"learning",nights:3,needed:7}).detail,/^3 of 7 nights/);assert.match(Core.stressView({level:"learning"}).detail,/^0 of 7/);
  const higher=Core.stressView({level:"higher",signals:["ans-low","hrv-low","unknown"]});assert.equal(higher.tone,"low");assert.match(higher.detail,/ANS charge was below your usual\. Heart rate variability/);
  assert.equal(Core.stressView({level:"lower",signals:[]}).tone,"good");
  assert.match(Core.stressView({level:"usual",signals:["breathing-high"]}).detail,/Breathing rate .* but nothing else stood out/);assert.match(Core.stressView({level:"usual",signals:[]}).detail,/No overnight signal/);
  assert.match(Core.lighterText({offer:true,reason:"recovery"}),/Nightly Recharge was poor/);assert.match(Core.lighterText({offer:true,reason:"stress"}),/Two nights in a row/);
  assert.match(Core.lighterText({offer:false,note:"compromised"}),/compromised/);assert.equal(Core.lighterText(null),"");
  const original={id:"w",title:"Monday workout",entries:[{id:"a",sets:[{},{},{}]},{id:"b",sets:[{}]},{id:"c",sets:[{},{}]}]};
  const {workout,removedSets}=Core.lighterWorkout(original);
  assert.deepEqual(workout.entries.map((entry)=>entry.sets.length),[2,1,1]);assert.equal(removedSets,2);assert.equal(workout.adjustment,"recovery");
  assert.equal(original.entries[0].sets.length,3,"the planned workout object is not changed");assert.equal(original.adjustment,undefined);
});

test("a STRATA session is matched with the Polar workout recorded during it",()=>{
  const session={startedAt:NOW,completedAt:NOW+60*60*1000,elapsedSeconds:3600};
  const during={startedAt:NOW+5*60*1000,durationSeconds:3000,sport:"Strength training",hrAvg:118,calories:320};
  const earlier={startedAt:NOW-5*60*60*1000,durationSeconds:1800,sport:"Running"};
  const edge={startedAt:NOW+80*60*1000,durationSeconds:600,sport:"Walking"};
  assert.equal(Core.matchDeviceWorkout(session,[earlier,edge,during]),during);
  assert.equal(Core.matchDeviceWorkout(session,[earlier]),null);assert.equal(Core.matchDeviceWorkout(session,[edge]),edge,"30 minutes either side still counts");
  assert.equal(Core.matchDeviceWorkout({startedAt:NOW,completedAt:null,elapsedSeconds:600},[during]),during);assert.equal(Core.matchDeviceWorkout({},[during]),null);
  assert.equal(Core.deviceWorkoutText(during),"Polar · Strength training · 50m · avg 118 bpm · 320 kcal");
  assert.equal(Core.deviceWorkoutText({durationSeconds:null}),"Polar · Workout");assert.equal(Core.deviceWorkoutText(null),"");
});

test("chart geometry breaks lines at missing nights and places the usual band",()=>{
  const series=[{date:"a",hrv:50},{date:"b",hrv:null},{date:"c",hrv:60},{date:"d",hrv:55}];
  const geometry=Core.chartGeometry(series,"hrv",{width:320,height:120,pad:8,usual:{low:52,high:58}});
  assert.equal(geometry.empty,false);assert.equal(geometry.points.length,3);assert.equal(geometry.segments.length,2);assert.deepEqual(geometry.segments.map((segment)=>segment.length),[1,2]);
  assert.equal(geometry.points[0].x,8);assert.equal(geometry.points.at(-1).x,312);assert.ok(geometry.points[1].y<geometry.points[0].y,"a higher value sits higher");
  assert.ok(geometry.band.y1<geometry.band.y2);assert.equal(geometry.min<50&&geometry.max>60,true);
  const single=Core.chartGeometry([{date:"a",hrv:40}],"hrv");assert.equal(single.points[0].x,160);assert.equal(single.band,null);
  assert.equal(Core.chartGeometry([{date:"a",hrv:null}],"hrv").empty,true);
  const flat=Core.chartGeometry([{date:"a",v:5},{date:"b",v:5}],"v");assert.ok(Number.isFinite(flat.points[0].y));
});

function accountHarness({devices,requests=[],responses={},search="",hash=""}){
  const {elements,element}=page(ACCOUNT_IDS),calls=[],timers=[],assigned=[],replaced=[];let time=NOW;
  const api={
    devices:async()=>{calls.push(["devices"]);const next=typeof devices==="function"?devices(calls):devices;if(next instanceof Error)throw next;return structuredClone(next);},
    deviceRequest:async(path,method,body)=>{calls.push([path,method,body]);requests.push([path,method,body]);const answer=responses[`${method} ${path}`];if(answer instanceof Error)throw answer;return typeof answer==="function"?answer(body):answer;}
  };
  const locationLike={search,hash,href:`https://strata.test/account.html${search}${hash}`,assign:(url)=>assigned.push(url)};
  const historyLike={state:null,replaceState:(...args)=>replaced.push(args)};
  let changed=0;
  const controller=AccountDevices.createController({element,api,core:Core,locationLike,historyLike,now:()=>time,setTimer:(fn)=>{timers.push(fn);return timers.length;},clearTimer:()=>{},onAccountChanged:()=>{changed+=1;}});
  return {controller,elements,calls,timers,assigned,replaced,advance:(ms)=>{time+=ms;},changes:()=>changed,async runTimers(){while(timers.length){await timers.shift()();await flush();}}};
}
const activeConnection=(overrides={})=>({provider:"polar",status:"active",connectedAt:NOW-86400000,lastSyncAt:NOW-3600000,syncedThrough:"2026-09-28",lastError:null,settings:{recoverySuggestions:true},revision:2,importing:false,...overrides});

test("connecting asks for consent first and sends the member to Polar only after they agree",async()=>{
  const harness=accountHarness({devices:{configured:true,plus:true,connection:null},responses:{"POST /api/devices/polar/connect":{authorizeUrl:"https://flow.polar.com/oauth2/authorization?state=x"}}});
  await harness.controller.load({id:"member-1"});
  const el=(id)=>harness.elements.get(id);
  assert.equal(el("connectedDevices").hidden,false);assert.equal(el("connectedDevices").dataset.state,"disconnected");assert.equal(el("devicesConnect").hidden,false);
  await el("devicesConnect").emit("click");
  assert.equal(el("devicesConsent").hidden,false);assert.equal(el("devicesConnect").hidden,true);assert.equal(el("devicesContinue").disabled,true);assert.equal(el("devicesConsentTitle").focused,1);
  await el("devicesContinue").emit("click");assert.equal(harness.assigned.length,0,"nothing happens without consent");
  el("devicesConsentCheck").checked=true;await el("devicesConsentCheck").emit("change");assert.equal(el("devicesContinue").disabled,false);
  await el("devicesContinue").emit("click");await flush();
  assert.deepEqual(harness.calls.at(-1),["/api/devices/polar/connect","POST",{expectedUserId:"member-1"}]);
  assert.deepEqual(harness.assigned,["https://flow.polar.com/oauth2/authorization?state=x"]);
  await el("devicesConsentCancel").emit("click");assert.equal(el("devicesConsent").hidden,true);assert.equal(el("devicesConnect").focused,1);
});

test("returning from Polar finishes the connection, clears the address, and follows the import",async()=>{
  let reads=0;
  const harness=accountHarness({search:"?devices=polar-return",hash:"#connectedDevices",
    devices:()=>{reads+=1;return {configured:true,plus:true,connection:reads===1?null:reads===2?activeConnection({importing:true,lastSyncAt:null}):activeConnection()};},
    responses:{"POST /api/devices/polar/complete":{connection:activeConnection({importing:true,lastSyncAt:null})}}});
  await harness.controller.load({id:"member-1"});
  const el=(id)=>harness.elements.get(id);
  assert.equal(harness.replaced.length,1);assert.equal(harness.replaced[0][2],"/account.html#connectedDevices");
  assert.equal(el("connectedDevices").dataset.state,"importing");assert.match(el("devicesStatus").textContent,/Importing your recent history/);assert.equal(el("devicesStatus").focused,1);
  assert.equal(el("connectedDevices").scrolled,1);
  await harness.runTimers();
  assert.equal(el("connectedDevices").dataset.state,"active");assert.match(el("devicesStatus").textContent,/Polar synced/);
  assert.equal(el("devicesSuggestions").checked,true);assert.equal(el("devicesSyncedThrough").textContent,"Mon, Sep 28");
});

test("Polar return outcomes and request failures are explained without leaving the card",async()=>{
  const declined=accountHarness({search:"?devices=polar-declined",devices:{configured:true,plus:true,connection:null}});
  await declined.controller.load({id:"m"});
  assert.match(declined.elements.get("devicesStatus").textContent,/chose not to share/);assert.equal(declined.elements.get("devicesStatus").classList.contains("bad"),false);
  const expired=accountHarness({search:"?devices=polar-return",devices:{configured:true,plus:true,connection:null},responses:{"POST /api/devices/polar/complete":Object.assign(new Error("This Polar connection request expired or was started in another sign-in. Connect Polar again."),{status:409,code:"DEVICES_CONNECT_EXPIRED"})}});
  await expired.controller.load({id:"m"});
  assert.match(expired.elements.get("devicesStatus").textContent,/expired/);assert.equal(expired.elements.get("devicesStatus").classList.contains("bad"),true);
  const changed=accountHarness({search:"?devices=polar-return",devices:{configured:true,plus:true,connection:null},responses:{"POST /api/devices/polar/complete":Object.assign(new Error("changed"),{status:409,code:"DEVICES_ACCOUNT_CHANGED"})}});
  await changed.controller.load({id:"m"});assert.equal(changed.changes(),1);
  const signedOut=accountHarness({devices:Object.assign(new Error("Sign in required."),{status:401})});
  await signedOut.controller.load({id:"m"});assert.equal(signedOut.changes(),1);assert.equal(signedOut.elements.get("connectedDevices").hidden,true);
  const offline=accountHarness({devices:Object.assign(new Error("Could not reach STRATA."),{code:"network"})});
  await offline.controller.load({id:"m"});assert.equal(offline.changes(),0);assert.equal(offline.elements.get("connectedDevices").hidden,true);
  const unconfigured=accountHarness({devices:{configured:false,plus:true,connection:null}});
  await unconfigured.controller.load({id:"m"});assert.equal(unconfigured.elements.get("connectedDevices").hidden,true);
});

test("sync, the lighter-session switch, and disconnect keep the card in step with the server",async()=>{
  let reads=0;
  const harness=accountHarness({devices:()=>{reads+=1;return {configured:true,plus:true,connection:reads<3?activeConnection():activeConnection({lastSyncAt:NOW+1000})};},responses:{
    "POST /api/devices/polar/sync":{connection:activeConnection({importing:true})},
    "PUT /api/devices/settings":(body)=>body.expectedRevision===2?{connection:activeConnection({settings:{recoverySuggestions:false},revision:3})}:Promise.reject(Object.assign(new Error("Your connected-device settings changed in another tab. Reload and try again."),{status:409,code:"DEVICES_CHANGED"})),
    "DELETE /api/devices/polar":{disconnected:true}
  }});
  await harness.controller.load({id:"member-1"});
  const el=(id)=>harness.elements.get(id);
  assert.equal(el("connectedDevices").dataset.state,"active");assert.equal(el("devicesSync").hidden,false);assert.equal(el("devicesRecovery").hidden,false);
  await el("devicesSync").emit("click");await flush();
  assert.match(el("devicesStatus").textContent,/Syncing with Polar/);assert.equal(el("devicesSync").disabled,false);
  await harness.runTimers();assert.match(el("devicesStatus").textContent,/Polar synced/);

  el("devicesSuggestions").checked=false;await el("devicesSuggestions").emit("change");await flush();
  assert.deepEqual(harness.calls.find((call)=>call[0]==="/api/devices/settings")[2],{provider:"polar",settings:{recoverySuggestions:false},expectedRevision:2,expectedUserId:"member-1"});
  assert.equal(el("devicesSuggestions").checked,false);assert.match(el("devicesStatus").textContent,/won’t offer lighter sessions/);
  el("devicesSuggestions").checked=true;await el("devicesSuggestions").emit("change");await flush();

  await el("devicesDisconnect").emit("click");const dialog=el("devicesDisconnectDialog");assert.equal(dialog.opened,1);assert.equal(dialog.returnValue,"");
  dialog.returnValue="cancel";await dialog.emit("close");assert.equal(el("devicesDisconnect").focused,1);assert.equal(harness.calls.some((call)=>call[1]==="DELETE"),false);
  dialog.returnValue="disconnect";await dialog.emit("close");await flush();
  assert.deepEqual(harness.calls.find((call)=>call[1]==="DELETE"),["/api/devices/polar","DELETE",{expectedUserId:"member-1"}]);
  assert.equal(el("connectedDevices").dataset.state,"disconnected");assert.match(el("devicesStatus").textContent,/deleted the data it imported/);
  harness.controller.reset();assert.equal(el("connectedDevices").hidden,true);
});

test("sync failures and slow imports tell the member what happened",async()=>{
  const failing=accountHarness({devices:{configured:true,plus:true,connection:activeConnection()},responses:{"POST /api/devices/polar/sync":Object.assign(new Error("Polar was synced a moment ago. Try again in a few minutes."),{status:429,code:"DEVICES_SYNC_TOO_SOON"})}});
  await failing.controller.load({id:"m"});await failing.elements.get("devicesSync").emit("click");await flush();
  assert.match(failing.elements.get("devicesStatus").textContent,/a moment ago/);assert.equal(failing.elements.get("devicesStatus").classList.contains("bad"),true);
  const slow=accountHarness({devices:{configured:true,plus:true,connection:activeConnection({importing:true,lastSyncAt:null})}});
  await slow.controller.load({id:"m"});
  for(let step=0;step<40&&slow.timers.length;step+=1){slow.advance(3000);await slow.timers.shift()();await flush();}
  assert.match(slow.elements.get("devicesStatus").textContent,/still syncing/);
  const broken=accountHarness({devices:(calls)=>calls.length>1?{configured:true,plus:true,connection:activeConnection({status:"reconnect",lastError:"POLAR_AUTH"})}:{configured:true,plus:true,connection:activeConnection({importing:true,lastSyncAt:null})}});
  await broken.controller.load({id:"m"});await broken.runTimers();
  assert.equal(broken.elements.get("connectedDevices").dataset.state,"reconnect");assert.match(broken.elements.get("devicesStatus").textContent,/Reconnect Polar/);
});

function wellnessToday(overrides={}){
  return {configured:true,connected:true,connection:activeConnection(),today:"2026-09-28",summary:{state:"current",date:"2026-09-28",ageDays:0,
    recovery:{status:2,label:"Poor",ansCharge:-2.5,ansChargeLabel:"Below usual",sleepCharge:2,sleepChargeLabel:"Below usual"},
    stress:{level:"usual",nights:12,needed:7,signals:[],usual:null},sleep:{score:71,asleepSeconds:24000,deepSeconds:4000,lightSeconds:14000,remSeconds:6000,usual:{low:25000,high:27000,median:26000}},
    heart:{overnight:54,hrv:48,breathing:14.4,today:{resting:50,min:47,max:130}},lighterSession:{offer:true,reason:"recovery",note:null}},...overrides};
}

test("Train shows last night from Polar and starts a lighter session only when asked",async()=>{
  const {element,elements}=page(["deviceRecovery","startWorkout"]),state={mode:"account",history:[]},requests=[];
  const start=elements.get("startWorkout");let created=null;
  const view=WorkoutRecovery.create({$:element,state,core:Core,esc:Core.escapeHtml,request:async(path)=>{requests.push(path);return path.startsWith("/api/wellness/today")?wellnessToday():{workouts:[{startedAt:NOW,durationSeconds:2400,sport:"Strength training",hrAvg:120,calories:300}]};},renderHistory:()=>{state.historyRendered=true;}});
  start.onclick=()=>{created=view.prepare({entries:[{sets:[{},{}]}]});};
  await view.load();await view.load();
  assert.equal(requests.length,2,"loads once");assert.match(requests[0],/^\/api\/wellness\/today\?date=\d{4}-\d{2}-\d{2}$/);assert.equal(state.historyRendered,true);
  const box=elements.get("deviceRecovery");
  assert.equal(box.hidden,false);assert.equal(box.dataset.tone,"low");assert.match(box.innerHTML,/Polar recovery: Poor/);assert.match(box.innerHTML,/id="startLighterWorkout"/);assert.match(box.innerHTML,/slept 6h 40m/);
  await box.emit("click",{target:{closest:(selector)=>selector==="#startLighterWorkout"?{}:null}});
  assert.equal(start.clicks,1);assert.equal(created.adjustment,"recovery");assert.equal(created.entries[0].sets.length,1);
  assert.equal(view.prepare({entries:[{sets:[{},{}]}]}).adjustment,undefined,"the normal Start button is unchanged");
  await box.emit("click",{target:{closest:()=>null}});assert.equal(start.clicks,1);
  assert.equal(state.deviceNote({status:"completed",startedAt:NOW,completedAt:NOW+3000000}),"Polar · Strength training · 40m · avg 120 bpm · 300 kcal");
  assert.equal(state.deviceNote({status:"active",startedAt:NOW}),"");

  start.hidden=true;view.render();assert.doesNotMatch(box.innerHTML,/startLighterWorkout/,"no offer once a workout is running");
  view.reset();assert.equal(box.hidden,true);
});

test("Train hides the recovery line without a current Polar connection",async()=>{
  for(const answer of [{configured:true,connected:false,connection:null},wellnessToday({connection:activeConnection({status:"reconnect"})}),wellnessToday({summary:{state:"no-data"}}),new Error("offline")]){
    const {element,elements}=page(["deviceRecovery","startWorkout"]);
    const view=WorkoutRecovery.create({$:element,state:{mode:"account",history:[]},core:Core,esc:Core.escapeHtml,request:async()=>{if(answer instanceof Error)throw answer;return answer;}});
    await view.load();assert.equal(elements.get("deviceRecovery").hidden,true);
  }
  const {element,elements}=page(["deviceRecovery","startWorkout"]);
  const stale=WorkoutRecovery.create({$:element,state:{mode:"account",history:[]},core:Core,esc:Core.escapeHtml,request:async()=>wellnessToday({summary:{...wellnessToday().summary,state:"stale",ageDays:3,lighterSession:{offer:false,reason:null,note:null}}})});
  await stale.load();assert.match(elements.get("deviceRecovery").innerHTML,/Latest night from Polar/);assert.doesNotMatch(elements.get("deviceRecovery").innerHTML,/startLighterWorkout/);
  const guest=WorkoutRecovery.create({$:element,state:{mode:"guest",history:[]},core:Core,esc:Core.escapeHtml,request:async()=>{throw new Error("should not load");}});await guest.load();
});

const DISCOVER_IDS=["planReadiness","todayRecovery","todayRecoveryTitle","todayRecoveryDetail","todayRecoveryMetrics","todayRecoveryAction","todayRecoveryConnect","recoveryState","recoveryStateTitle","recoveryStateMessage","recoveryConnect","recoveryRetry","recoveryResults","recoveryToday","recoveryCharts","recoveryWeekly","recoveryRange"];
function trendsResponse(weeks=4){
  const series=Array.from({length:10},(_,index)=>({date:`2026-09-${String(19+index).padStart(2,"0")}`,recoveryStatus:index%6+1,hrv:50+index,heartRate:52-index%3,asleepSeconds:25000+index*100,sleepScore:80}));
  return {configured:true,connected:true,connection:activeConnection(),trends:{from:"2026-09-01",to:"2026-09-28",weeks,series,usual:{hrv:{low:52,high:57},heartRate:null,asleepSeconds:{low:25200,high:25800}},
    weekly:[{start:"2026-09-22",end:"2026-09-28",nights:7,recoveryStatus:3.4,hrv:56,asleepSeconds:25500}],training:[{start:"2026-09-22",end:"2026-09-28",strataWorkouts:3,cardioLoad:140}]}};
}

test("the Overview card and Recovery destination show today's night and the chosen trend range",async()=>{
  const {element,elements}=page(DISCOVER_IDS),requests=[],state={user:{id:"m"}};let generation=1;
  const buttons=[4,8,12].map((weeks)=>{const button=new FakeElement(`w${weeks}`);button.dataset.recoveryWeeks=String(weeks);button.attributes={};button.setAttribute=(name,value)=>{button.attributes[name]=value;};return button;});
  elements.get("recoveryRange").children=buttons;
  const api=async(path)=>{requests.push(path);return path.startsWith("/api/wellness/today")?wellnessToday():trendsResponse(Number(new URL(path,"https://x").searchParams.get("weeks")));};
  const controller=DiscoverRecovery.createController({element,api,state,core:Core,getGeneration:()=>generation});
  controller.activate("today");await flush();
  const card=elements.get("todayRecovery");
  assert.equal(card.hidden,false);assert.equal(elements.get("todayRecoveryTitle").textContent,"Poor recovery");assert.match(elements.get("todayRecoveryDetail").textContent,/lighter session/);
  assert.match(elements.get("todayRecoveryMetrics").innerHTML,/6h 40m[\s\S]*48 ms[\s\S]*50 bpm/);assert.equal(elements.get("todayRecoveryAction").hidden,false);assert.equal(elements.get("todayRecoveryConnect").hidden,true);
  controller.activate("recovery");await flush();
  assert.equal(requests.filter((path)=>path.startsWith("/api/wellness/today")).length,1,"today's night is reused while fresh");
  assert.equal(elements.get("recoveryState").hidden,true);assert.equal(elements.get("recoveryResults").hidden,false);
  const todayHtml=elements.get("recoveryToday").innerHTML;
  assert.match(todayHtml,/Nightly Recharge[\s\S]*Poor/);assert.match(todayHtml,/ANS charge below usual \(-2\.5\)/);assert.match(todayHtml,/Your usual 6h 57m–7h 30m/);assert.match(todayHtml,/Open Train/);assert.match(todayHtml,/recovery-stages/);
  const charts=elements.get("recoveryCharts").innerHTML;
  assert.equal((charts.match(/<figure/g)||[]).length,4);assert.match(charts,/recovery-band/);assert.match(charts,/Overnight heart rate: 10 nights[\s\S]*Your usual range appears after 7 nights/);
  assert.match(elements.get("recoveryWeekly").innerHTML,/<td>3<\/td><td>140<\/td>/);assert.equal(buttons[0].attributes["aria-pressed"],"true");
  await elements.get("recoveryRange").emit("click",{target:{closest:()=>buttons[1]}});await flush();
  assert.ok(requests.some((path)=>/\/api\/wellness\/trends\?weeks=8&date=/.test(path)));assert.equal(buttons[1].attributes["aria-pressed"],"true");
  await elements.get("recoveryRange").emit("click",{target:{closest:()=>null}});
  generation=2;controller.reset();assert.equal(card.hidden,true);
});

test("Recovery explains every state before data exists and retries after a failure",async()=>{
  const cases=[
    [{configured:true,connected:false,connection:null},/Connect your Polar Loop/,true],
    [{configured:false,connected:false,connection:null},/Polar connections are paused/,false],
    [wellnessToday({connection:activeConnection({status:"reconnect",lastError:"POLAR_AUTH"})}),/needs you to reconnect/,true],
    [wellnessToday({connection:activeConnection({importing:true,lastSyncAt:null})}),/Importing from Polar/,false],
    [wellnessToday({summary:{state:"no-data",lighterSession:{offer:false}}}),/No nights from Polar yet/,false]
  ];
  for(const [answer,title,connect] of cases){
    const {element,elements}=page(DISCOVER_IDS);
    const controller=DiscoverRecovery.createController({element,api:async()=>answer,state:{user:{id:"m"}},core:Core,getGeneration:()=>1});
    controller.activate("recovery");await flush();
    assert.match(elements.get("recoveryStateTitle").textContent,title);assert.equal(elements.get("recoveryConnect").hidden,!connect);assert.equal(elements.get("recoveryResults").hidden,true);
    controller.activate("today");await flush();
    assert.equal(elements.get("todayRecovery").hidden,!answer.configured);if(answer.configured)assert.equal(elements.get("todayRecoveryConnect").hidden,!connect);
  }
  let fail=true;const {element,elements}=page(DISCOVER_IDS);
  const controller=DiscoverRecovery.createController({element,api:async(path)=>{if(fail)throw new Error("offline");return path.includes("today")?wellnessToday():trendsResponse();},state:{user:{id:"m"}},core:Core,getGeneration:()=>1});
  controller.activate("recovery");await flush();
  assert.match(elements.get("recoveryStateTitle").textContent,/couldn’t load/);assert.equal(elements.get("recoveryRetry").hidden,false);
  fail=false;await elements.get("recoveryRetry").emit("click");await flush();
  assert.equal(elements.get("recoveryResults").hidden,false);
  const signedOut=DiscoverRecovery.createController({element,api:async()=>{throw new Error("unused");},state:{user:null},core:Core,getGeneration:()=>1});signedOut.activate("recovery");await flush();
  const redirecting=DiscoverRecovery.createController({element,api:async()=>{throw Object.assign(new Error("redirect"),{redirecting:true});},state:{user:{id:"m"}},core:Core,getGeneration:()=>1});redirecting.activate("today");await flush();
});

test("the Plan view shows last night's recovery as a badge, with Train's lighter session when it applies",async()=>{
  const {element,elements}=page(DISCOVER_IDS);let answer=wellnessToday();
  const controller=DiscoverRecovery.createController({element,api:async()=>answer,state:{user:{id:"m"}},core:Core,getGeneration:()=>1});
  controller.activate("plan");await flush();
  const badge=elements.get("planReadiness");
  assert.equal(badge.hidden,false);assert.equal(badge.dataset.tone,"low");assert.match(badge.innerHTML,/Poor recovery/);assert.match(badge.innerHTML,/Lighter session in Train/);assert.match(badge.innerHTML,/data-feature-target="recovery"/);
  controller.reset();assert.equal(badge.hidden,true,"an account switch hides the badge");
  answer={configured:true,connected:false,connection:null};controller.activate("plan");await flush();
  assert.equal(badge.hidden,true,"no badge without a Polar connection");
});
