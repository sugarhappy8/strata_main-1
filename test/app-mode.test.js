"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const ROOT=path.join(__dirname,"..");
const read=(file)=>fs.readFileSync(path.join(ROOT,file),"utf8");
const SOURCE=read("public/scripts/app-mode.js");
const CSS=read("public/styles/app-mode.css");

function jsonResponse(status,data){return {ok:status>=200&&status<300,status,json:async()=>data};}
function memoryStorage(){const values=new Map();return {getItem:(key)=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:(key)=>values.delete(key),values};}

// A page realm with only what app-mode.js touches: enough DOM to watch the chrome appear and react.
function fakeNode(name){
  const node={name,dataset:{},attributes:{},listeners:{},html:[],children:[],textContent:"",
    addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);},
    setAttribute(key,value){this.attributes[key]=String(value);},getAttribute(key){return this.attributes[key]??null;},
    insertAdjacentHTML(position,html){this.html.push({position,html});},
    append(child){this.children.push(child);},
    querySelector(selector){return (this.nodes||={})[selector]||null;},
    querySelectorAll(){return [];}
  };
  return node;
}

function realm({pathname="/",hash="",search="",signedIn=false,plugin=null,readyState="loading",referrer="",historyLength=1,navigationType="navigate",storage=memoryStorage()}={}){
  const listeners={},documentListeners={},observers=[],replaced=[],scrolled=[],calls=[];
  const html={dataset:{}},head=fakeNode("head"),main=fakeNode("main");
  const document={
    readyState,documentElement:html,body:null,head,referrer,
    addEventListener(type,handler){(documentListeners[type]||=[]).push(handler);},
    getElementById(id){return id==="accountButton"?{classList:{contains:(name)=>name==="signed-in"&&signedIn}}:null;},
    querySelector(selector){return selector==="main"?main:null;},
    createElement(tag){return fakeNode(tag);}
  };
  class MutationObserver{constructor(callback){this.callback=callback;observers.push(this);}observe(target,options){this.target=target;this.options=options;}disconnect(){this.disconnected=true;}}
  const location={pathname,hash,search,origin:"https://stratafitness.online",replace:(url)=>replaced.push(url)};
  const window={
    document,location,MutationObserver,URL,URLSearchParams,sessionStorage:storage,
    StrataApp:Object.freeze({platform:"ios",shellVersion:1}),
    history:{length:historyLength,back:()=>calls.push(["history.back"])},
    navigation:{activation:{navigationType:navigationType==="back_forward"?"traverse":"push"}},
    performance:{getEntriesByType:()=>[{type:navigationType}]},
    matchMedia:()=>({matches:false}),
    scrollTo:(options)=>scrolled.push(options),
    setTimeout:()=>{calls.push(["setTimeout"]);return 0;},
    addEventListener(type,handler){(listeners[type]||=[]).push(handler);},
    dispatchEvent(){},CustomEvent:class{},
    fetch:async()=>jsonResponse(401,{}),
    Capacitor:plugin?{Plugins:{StrataNative:plugin},addListener:(name,event,callback)=>{calls.push(["addListener",name,event]);window.transactionUpdated=callback;return {remove(){}};}}:undefined
  };
  window.globalThis=window;
  vm.createContext(window);
  vm.runInContext(SOURCE,window,{filename:"app-mode.js"});
  return {
    window,document,html,main,observers,replaced,scrolled,calls,listeners,storage,
    insertBody(){
      const body=fakeNode("body");
      body.tabBar=fakeNode("tabbar");body.title=fakeNode("title");body.back=fakeNode("back");
      const nodes={".app-tabbar":body.tabBar,"[data-app-title]":body.title,"[data-app-status]":fakeNode("status")};
      // Like the real DOM, Back only exists when the drawn top bar has one.
      body.querySelector=(selector)=>selector==="[data-app-back]"?(body.html.some((entry)=>entry.html.includes("data-app-back"))?body.back:null):nodes[selector]||null;
      document.body=body;
      for(const observer of observers)if(!observer.disconnected)observer.callback([]);
      return {body,chrome:body.html.map((entry)=>entry.html).join("")};
    },
    ready(){document.readyState="interactive";for(const handler of documentListeners.DOMContentLoaded||[])handler();},
    emit(type,event){for(const handler of listeners[type]||[])handler(event);}
  };
}

test("screens map every page to its tab, title, and Back target",()=>{
  const {window}=realm();const {resolveScreen}=window.StrataAppMode;
  const pick=(location)=>{const screen=resolveScreen(location);return [screen.id,screen.tab,screen.title,screen.parent,screen.chrome];};
  assert.deepEqual(pick({pathname:"/dashboard"}),["dashboard","dashboard","Dashboard","","tabs"]);
  assert.deepEqual(pick({pathname:"/workout.html"}),["train","train","Train","","tabs"]);
  assert.deepEqual(pick({pathname:"/account.html"}),["profile","profile","Profile","","tabs"]);
  assert.deepEqual(pick({pathname:"/planner.html/"}),["planner","dashboard","Weekly plan","","tabs"]);
  assert.deepEqual(pick({pathname:"/terms"}),["terms","profile","Terms","/policies","tabs"]);
  assert.deepEqual(pick({pathname:"/pricing",search:"?reason=recovery"}),["pricing","recovery","Strata+","","tabs"],"the Recovery tab's paywall is that tab's root");
  assert.deepEqual(pick({pathname:"/pricing",search:"?reason=ai"}),["pricing","dashboard","Strata+","/discover.html","tabs"]);
  assert.deepEqual(pick({pathname:"/pricing"}),["pricing","profile","Strata+","/account.html","tabs"]);
  assert.deepEqual(pick({pathname:"/discover.html",hash:"#recoveryWorkspace"}),["studio","recovery","Recovery","","tabs"]);
  assert.deepEqual(pick({pathname:"/discover.html",hash:"#exerciseExplorer"}),["studio","rankings","Rankings","","tabs"]);
  assert.deepEqual(pick({pathname:"/discover.html",hash:"#progressWorkspace"}),["studio","dashboard","Strata+","","tabs"]);
  assert.equal(resolveScreen({pathname:"/",hash:"#rankings"}).view,"rankings");
  assert.equal(resolveScreen({pathname:"/",hash:"#preview"}).view,"preview");
  assert.equal(resolveScreen({pathname:"/",hash:"#top"}).view,"start");
  for(const pathname of ["/offline.html","/workout-offline.html","/admin"])assert.equal(resolveScreen({pathname}).chrome,"none",pathname);
});

test("the tab bar marks the current section, keeps studio panels in place, and has five labelled targets",()=>{
  const {window}=realm();const {resolveScreen,tabBarHtml,topBarHtml}=window.StrataAppMode;
  const train=tabBarHtml(resolveScreen({pathname:"/workout.html"}));
  assert.equal((train.match(/class="app-tab"/g)||[]).length,5);
  assert.deepEqual([...train.matchAll(/data-app-tab="(\w+)"/g)].map((match)=>match[1]),["rankings","dashboard","train","recovery","profile"]);
  assert.deepEqual([...train.matchAll(/data-app-tab="(\w+)"[^>]*aria-current="page"/g)].map((match)=>match[1]),["train"]);
  assert.match(train,/href="\/rankings"[\s\S]*href="\/dashboard"[\s\S]*href="\/workout\.html"[\s\S]*href="\/recovery"[\s\S]*href="\/account\.html"/);
  assert.match(train,/<svg[^>]*aria-hidden="true"/);assert.doesNotMatch(train,/data-section/);
  const studio=tabBarHtml(resolveScreen({pathname:"/discover.html",hash:"#recoveryWorkspace"}));
  assert.match(studio,/href="#exerciseExplorer" data-app-tab="rankings" data-section="rankings"/);
  assert.match(studio,/href="#recoveryWorkspace" data-app-tab="recovery" data-section="recovery" aria-current="page"/);
  assert.match(studio,/data-app-tab="dashboard" data-section="week"/);
  assert.match(topBarHtml(resolveScreen({pathname:"/privacy"})),/<a class="app-back" href="\/policies" data-app-back>[\s\S]*Back<\/span><\/a><p class="app-title" data-app-title>Privacy<\/p>/);
  assert.doesNotMatch(topBarHtml(resolveScreen({pathname:"/dashboard"})),/app-back/);
  // 44pt+ targets, safe areas, no live blur, and the bars stay put through view transitions.
  assert.match(CSS,/\.app-tab \{[^}]*min-width:44px;[^}]*min-height:var\(--app-tabbar-h\)/);
  assert.match(CSS,/--app-tabbar-h:56px;/);
  assert.match(CSS,/\.app-back \{[^}]*min-width:44px; min-height:44px;/);
  assert.match(CSS,/\.app-tabbar \{[^}]*padding:0 max\(4px,env\(safe-area-inset-right\)\) env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(CSS.match(/\.app-tabbar \{[^}]*\}/)[0],/backdrop-filter/);
  assert.match(CSS,/:root\[data-app="ios"\] \.app-tabbar \{ view-transition-name:app-tabbar; \}/);
  assert.match(CSS,/::view-transition-old\(app-tabbar\) \{ display:none; \}/);
});

test("the app hides website chrome, blur, and reveals, and moves with transform and opacity only",()=>{
  assert.match(CSS,/@view-transition \{ navigation:auto; \}/);
  assert.match(CSS,/:root\[data-app-chrome="tabs"\] body > header:not\(\.app-topbar\),\n:root\[data-app-chrome="tabs"\] body > nav\.mobile-public-nav,\n:root\[data-app="ios"\] body > footer,\n:root\[data-app="ios"\] \.skip-link,\n:root\[data-app="ios"\] \.strata-scroll-progress \{ display:none !important; \}/);
  assert.match(CSS,/backdrop-filter:none !important;/);
  assert.match(CSS,/-webkit-tap-highlight-color:transparent;/);
  assert.match(CSS,/:root\[data-app="ios"\] :is\(a,img\) \{ -webkit-touch-callout:none; \}/);
  assert.match(CSS,/@media \(prefers-reduced-motion: reduce\) \{\n {2}::view-transition-group\(\*\),::view-transition-old\(\*\),::view-transition-new\(\*\) \{ animation:none !important; \}/);
  for(const frames of CSS.matchAll(/@keyframes [\w-]+ \{([^\n]*)\}/g))assert.doesNotMatch(frames[1].replace(/transform:[^;]*;|opacity:[^;]*;/g,""),/:/,`keyframes animate only transform and opacity: ${frames[0]}`);
  // Text and form fields stay selectable; only controls and chrome opt out.
  const unselectable=CSS.match(/:root\[data-app="ios"\] :is\(([^)]*(?:\([^)]*\))?[^)]*)\) \{ -webkit-user-select:none; user-select:none; \}/)[1];
  assert.doesNotMatch(unselectable,/\b(?:input|textarea|select|p|main|body)\b/);
  assert.match(read("public/scripts/motion.js"),/if \(window\.StrataApp \|\| !window\.matchMedia/,"no scroll reveals or scroll progress in the app");
});

test("in the app the chrome is drawn the moment <body> exists, with the current tab and title",()=>{
  const page=realm({pathname:"/workout.html"});
  assert.equal(page.html.dataset.appChrome,"tabs");assert.equal(page.html.dataset.appScreen,"train");
  assert.equal(page.observers.length,1,"waits for the body before drawing");
  const {body,chrome}=page.insertBody();
  assert.equal(page.observers[0].disconnected,true);
  assert.match(chrome,/^<header class="app-topbar">[\s\S]*Train[\s\S]*<\/header><nav class="app-tabbar" aria-label="Primary navigation">/);
  assert.match(chrome,/data-app-tab="train"[^>]*aria-current="page"/);
  page.ready();
  assert.deepEqual(body.children,[body.tabBar],"the tab bar moves after the content for screen readers");
  assert.equal(page.observers.length,1);
  const plain=realm({pathname:"/offline.html"});
  assert.equal(plain.html.dataset.appChrome,"none");assert.equal(plain.observers.length,0);
});

test("tab taps give a selection haptic, mark the transition, and scroll the current tab to the top",()=>{
  const haptics=[];
  const page=realm({pathname:"/workout.html",plugin:{haptic:async(options)=>{haptics.push(options.style);}}});
  const {body}=page.insertBody();
  const tab=(id,current)=>({dataset:{appTab:id},getAttribute:(name)=>name==="aria-current"?(current?"page":null):name==="href"?`/${id}`:null});
  const click=(target)=>{let prevented=false;for(const handler of body.tabBar.listeners.click)handler({target:{closest:()=>target},preventDefault:()=>{prevented=true;}});return prevented;};
  assert.equal(click(tab("train",true)),true);
  assert.deepEqual(JSON.parse(JSON.stringify(page.scrolled)),[{top:0,behavior:"smooth"}]);
  assert.equal(page.storage.values.get(page.window.StrataAppMode.NAV_KEY),undefined);
  assert.equal(click(tab("dashboard",false)),false);
  assert.equal(page.storage.values.get(page.window.StrataAppMode.NAV_KEY),"tab");
  assert.deepEqual(haptics,["selection","selection"]);
  // The next page reads the mark once: tab switches cross-fade, swipe-back is left to the web view.
  page.emit("pagereveal",{viewTransition:{skipTransition:()=>assert.fail("a tab switch keeps its transition")}});
  assert.equal(page.html.dataset.appNav,"tab");
  let skipped=false;
  const back=realm({pathname:"/account.html",navigationType:"back_forward"});
  back.emit("pagereveal",{viewTransition:{skipTransition:()=>{skipped=true;}}});
  assert.equal(skipped,true);assert.equal(back.html.dataset.appNav,"push");
});

test("Back returns through history when the app came from STRATA, and to the parent screen otherwise",()=>{
  const inside=realm({pathname:"/terms",referrer:"https://stratafitness.online/policies",historyLength:3});
  const {body}=inside.insertBody();
  let prevented=false;
  for(const handler of body.back.listeners.click)handler({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(inside.calls.filter((call)=>call[0]==="history.back").length,1);
  assert.equal(inside.storage.values.get(inside.window.StrataAppMode.NAV_KEY),"back");
  const cold=realm({pathname:"/terms",referrer:"",historyLength:1});
  const coldBody=cold.insertBody().body;prevented=false;
  for(const handler of coldBody.back.listeners.click)handler({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,false,"the link's own href, the parent screen, is followed");
});

test("the app opens members on Dashboard and everyone else on a welcome screen, never the marketing homepage",()=>{
  const member=realm({pathname:"/",signedIn:true});member.insertBody();member.ready();
  assert.deepEqual(member.replaced,["/dashboard"]);assert.equal(member.storage.values.get(member.window.StrataAppMode.NAV_KEY),"tab");
  const visitor=realm({pathname:"/"});visitor.insertBody();visitor.ready();
  assert.deepEqual(visitor.replaced,[]);assert.equal(visitor.html.dataset.appHome,"welcome");
  assert.match(visitor.main.html[0].html,/class="app-welcome"[\s\S]*href="\/account\.html\?mode=signup"[\s\S]*href="\/account\.html\?mode=login"[\s\S]*href="\/#rankings"[\s\S]*href="\/#preview"/);
  visitor.window.location.hash="#rankings";visitor.emit("hashchange");
  assert.equal(visitor.html.dataset.appHome,"rankings");
  const rankings=realm({pathname:"/",hash:"#rankings",signedIn:true});rankings.insertBody();rankings.ready();
  assert.deepEqual(rankings.replaced,[],"a member's Rankings tab stays on the rankings");assert.equal(rankings.html.dataset.appHome,"rankings");
  assert.match(CSS,/:root\[data-app-screen="home"\] \.home-page main > section \{ display:none !important; \}/);
  assert.match(CSS,/:root\[data-app-home="rankings"\] \.home-page main > #rankings/);
  assert.match(CSS,/:root:is\(\[data-app-home="start"\],\[data-app-home="welcome"\]\) :is\(\.app-topbar,\.app-tabbar\) \{ display:none !important; \}/);
});

test("Profile keeps Strata+, support, and legal pages one tap away",()=>{
  const page=realm({pathname:"/account.html"});page.insertBody();
  const accountPage=fakeNode("accountPage");
  page.document.getElementById=(id)=>id==="accountPage"?accountPage:null;
  page.document.querySelector=(selector)=>selector==="body > footer > span"?{textContent:"About STRATA · Build 9.1.0"}:null;
  page.ready();
  const more=accountPage.html[0].html;
  for(const href of ["/pricing","/contact","/policies","/terms","/privacy"])assert.match(more,new RegExp(`href="${href}"`));
  assert.match(more,/About STRATA · Build 9\.1\.0/);
});

test("on /pricing the app loads its App Store paywall, and the website never loads Paddle there",()=>{
  const page=realm({pathname:"/pricing"});page.insertBody();page.ready();
  assert.equal(page.document.head.children.length,1);assert.equal(page.document.head.children[0].src,"/app-paywall.js?v=9.1.0");
  const pricing=read("public/scripts/pricing.js");
  assert.match(pricing,/\(\(\) => \{\n {2}\/\/ Inside the iOS app[^\n]*\n {2}if\(globalThis\.StrataApp\)return;/);
  assert.match(pricing,/function loadPaddle\(\)\{\n {4}if\(globalThis\.StrataApp\)return Promise\.reject/);
  assert.doesNotMatch(read("public/pages/pricing.html"),/cdn\.paddle\.com/);
});

test("printing in the app uses the native print sheet, and a missing plugin says so",async()=>{
  const printed=[];
  const page=realm({plugin:{print:async(options)=>{printed.push(options);return {};}}});
  assert.equal(await page.window.StrataAppMode.print({jobName:"Plan"}),true);assert.deepEqual(printed,[{jobName:"Plan"}]);
  assert.equal(await realm().window.StrataAppMode.print(),false);
  assert.doesNotThrow(()=>realm().window.StrataAppMode.haptic("success"),"haptics without the plugin do nothing");
  assert.match(read("public/scripts/discover.js"),/if\(globalThis\.StrataApp\)\{\n {4}try\{if\(!await globalThis\.StrataAppMode\?\.print\?\.\(/);
  assert.match(read("public/scripts/workout-events.js"),/if\(set\.completed\)globalThis\.StrataAppMode\?\.haptic\("light"\)/);
  assert.match(read("public/scripts/workout-events.js"),/signal\("workout_completed"\);globalThis\.StrataAppMode\?\.haptic\("success"\)/);
});

test("native extras forward to the app when its build has them and stay neutral when it does not",async()=>{
  const calls=[],record=(name,result)=>async(options)=>{calls.push([name,options]);if(result instanceof Error)throw result;return result;};
  const plugin={keepAwake:record("keepAwake",{}),scheduleRestAlert:record("scheduleRestAlert",{scheduled:true,permission:"authorized"}),cancelRestAlert:record("cancelRestAlert",undefined),addWeeklyToCalendar:record("addWeeklyToCalendar",{added:true}),info:record("info",{appVersion:"1.2",build:"34",iosVersion:"18.0",canMakePayments:true})};
  const app=realm({plugin}).window.StrataAppMode;
  assert.equal(app.has("keepAwake"),true);assert.equal(app.has("print"),false);assert.equal(app.has("toString"),false);
  assert.equal(await app.keepAwake(true),true);assert.equal(await app.keepAwake("yes"),true);
  assert.deepEqual(JSON.parse(JSON.stringify(await app.scheduleRestAlert({endsAt:"1800000090000",title:"Rest is over",body:"Time for your next set."}))),{scheduled:true,permission:"authorized"});
  assert.equal(await app.cancelRestAlert(),true,"a method that resolves with nothing still counts as done");
  const options={title:"STRATA workout",notes:"Planned days: Monday",weekdays:[2],hour:18,minute:0,durationMinutes:60,alarmMinutesBefore:null};
  assert.equal((await app.addWeeklyToCalendar(options)).added,true);
  assert.equal((await app.info()).appVersion,"1.2");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[["keepAwake",{enabled:true}],["keepAwake",{enabled:false}],["scheduleRestAlert",{endsAt:1800000090000,title:"Rest is over",body:"Time for your next set."}],["cancelRestAlert",{}],["addWeeklyToCalendar",options],["info",{}]]);

  // A native refusal: the niceties shrug it off, the calendar sheet reports it so the page can fall back to .ics.
  const refused=new Error("permission_denied"),failing=realm({plugin:{keepAwake:record("keepAwake",refused),scheduleRestAlert:record("scheduleRestAlert",refused),cancelRestAlert:()=>{throw refused;},info:record("info",refused),addWeeklyToCalendar:record("addWeeklyToCalendar",refused)}}).window.StrataAppMode;
  assert.equal(await failing.keepAwake(true),false);assert.equal(await failing.scheduleRestAlert({endsAt:1}),null);assert.equal(await failing.cancelRestAlert(),false);assert.equal(await failing.info(),null);
  await assert.rejects(failing.addWeeklyToCalendar(options),/permission_denied/);

  // An older app build (no such methods) and a page with no plugin at all resolve to neutral results.
  for(const older of [realm({plugin:{haptic:async()=>({})}}).window.StrataAppMode,realm().window.StrataAppMode]){
    assert.equal(older.has("addWeeklyToCalendar"),false);
    assert.equal(await older.keepAwake(true),false);assert.equal(await older.scheduleRestAlert({endsAt:Date.now()+60_000}),null);assert.equal(await older.cancelRestAlert(),false);
    assert.equal(await older.addWeeklyToCalendar(options),null);assert.equal(await older.info(),null);
  }
});

test("the workout bridge calls the app only when the wanted screen and rest-alert state changes",async()=>{
  const calls=[],plugin=Object.fromEntries(["keepAwake","scheduleRestAlert","cancelRestAlert"].map((name)=>[name,async(options)=>{calls.push([name,options]);return {};}]));
  const bridge=realm({plugin}).window.StrataAppMode.createWorkoutBridge({title:"Rest is over",body:"Time for your next set."});
  const now=1_800_000_000_000,step=(state)=>{bridge.sync({now,...state});return JSON.parse(JSON.stringify(calls.splice(0)));};
  assert.deepEqual(step({}),[],"nothing is asked for before a workout opens");
  assert.deepEqual(step({keepAwake:true}),[["keepAwake",{enabled:true}]]);
  assert.deepEqual(step({keepAwake:true}),[],"repeated reports change nothing");
  assert.deepEqual(step({keepAwake:true,restEndsAt:now+90_000}),[["scheduleRestAlert",{endsAt:now+90_000,title:"Rest is over",body:"Time for your next set."}]]);
  assert.deepEqual(step({keepAwake:true,restEndsAt:now+90_000}),[]);
  assert.deepEqual(step({keepAwake:true,restEndsAt:now+60_000}),[["scheduleRestAlert",{endsAt:now+60_000,title:"Rest is over",body:"Time for your next set."}]],"a new rest replaces the alert");
  assert.deepEqual(step({keepAwake:true,restEndsAt:null}),[["cancelRestAlert",{}]],"pausing or resetting cancels it");
  assert.deepEqual(step({keepAwake:true,restEndsAt:null}),[]);
  step({keepAwake:true,restEndsAt:now+1000});
  assert.deepEqual(step({keepAwake:true,restEndsAt:now+1000,now:now+1000}),[],"a rest that ran out keeps its alert, which fires (or was delivered) on its own");
  assert.deepEqual(step({keepAwake:true,restEndsAt:now-5000}),[]);
  step({keepAwake:true,restEndsAt:now+30_000});
  assert.deepEqual(step({keepAwake:false,restEndsAt:now+30_000}),[["keepAwake",{enabled:false}]],"a hidden page lets the screen sleep but keeps the alert for the background");
  assert.deepEqual(step({keepAwake:false,restEndsAt:0}),[["cancelRestAlert",{}]],"a finished workout cancels the alert");
  step({keepAwake:true,restEndsAt:now+30_000});
  assert.deepEqual(step({keepAwake:true,restEndsAt:now-1}),[["cancelRestAlert",{}]],"a different, already-past rest is a replaced rest");
  // The app lets the screen sleep in the background; the first report after the page was suspended asks again.
  bridge.sync({now,keepAwake:true});calls.splice(0);
  bridge.sync({now:now+1000,keepAwake:true});assert.deepEqual(calls.splice(0),[],"steady reports stay quiet");
  bridge.sync({now:now+61_000,keepAwake:true});assert.deepEqual(JSON.parse(JSON.stringify(calls.splice(0))),[["keepAwake",{enabled:true}]]);
  bridge.sync({now:now+200_000,keepAwake:false});bridge.sync({now:now+400_000,keepAwake:false});
  assert.deepEqual(JSON.parse(JSON.stringify(calls.splice(0))),[["keepAwake",{enabled:false}]],"a sleeping screen is never re-asked");
  assert.doesNotThrow(()=>realm().window.StrataAppMode.createWorkoutBridge().sync({keepAwake:true,restEndsAt:Date.now()+60_000}),"an app build without the plugin ignores the bridge");
});

test("Profile names the app build when the app can say",async()=>{
  const page=realm({pathname:"/account.html",plugin:{info:async()=>({appVersion:"1.2",build:"34",iosVersion:"18.0",canMakePayments:true})}});page.insertBody();
  const accountPage=fakeNode("accountPage"),line={textContent:"About STRATA · Build 9.1.0"};
  page.document.getElementById=(id)=>id==="accountPage"?accountPage:null;
  page.document.querySelector=(selector)=>selector==="body > footer > span"?{textContent:"About STRATA · Build 9.1.0"}:selector===".app-more-build"?line:null;
  page.ready();for(let index=0;index<5;index+=1)await new Promise(setImmediate);
  assert.equal(line.textContent,"About STRATA · Build 9.1.0 · App 1.2 (34)");
});

test("downloads keep their file for a minute, so the app's share sheet can still read it, and the app says where it goes",()=>{
  const files=["account.js","workout.js","workout-offline.js","discover.js","planner.js","onboarding.js"].map((file)=>[file,read(`public/scripts/${file}`)]);
  for(const [file,source] of files){
    const revokes=[...source.matchAll(/revokeObjectURL\(([^)]*)\)/g)];
    assert.ok(revokes.length>0,`${file} creates a download`);
    for(const match of revokes){
      const at=source.lastIndexOf("setTimeout(",match.index),delay=/^setTimeout\(\(\)=>URL\.revokeObjectURL\([^)]*\),(\d[\d_]*)\)/.exec(source.slice(at));
      assert.ok(delay&&Number(delay[1].replaceAll("_",""))>=60_000,`${file} revokes a download URL after at least a minute: ${source.slice(at,match.index+40)}`);
    }
  }
  const copy=Object.fromEntries(files);
  assert.match(copy["account.js"],/globalThis\.StrataApp\?"Your JSON export is ready\. Choose where to save it\.":"Your JSON export was downloaded\."/);
  assert.match(copy["planner.js"],/globalThis\.StrataApp\?"Weekly plan ready\. Choose where to save it\. Import it from Week templates or in Strata\+\.":"Weekly plan downloaded\./);
  assert.match(copy["discover.js"],/globalThis\.StrataApp\?"Plan file ready\. Choose where to save it\.":"Share file downloaded\."/);
  assert.match(copy["discover.js"],/globalThis\.StrataApp\?"Sharing was unavailable, so your plan is ready as a file\. Choose where to save it\.":"Sharing was unavailable, so a plan file was downloaded\."/);
  for(const [file,source] of files)for(const line of source.split("\n").filter((text)=>/was downloaded|[^"]downloaded\./.test(text)))assert.match(line,/globalThis\.StrataApp\?/,`${file}: "downloaded" copy has an app version`);
});

function billingRealm({routes,plugin={}}){
  const context={URL,URLSearchParams,Capacitor:{Plugins:{StrataNative:plugin}}};
  context.globalThis=context;vm.createContext(context);vm.runInContext(SOURCE,context,{filename:"app-mode.js"});
  const requests=[],events=[],storage=memoryStorage();
  const billing=context.StrataAppMode.createBilling({
    fetchImpl:async(url,options)=>{requests.push({url,options});const route=routes.shift();assert.ok(route,`unexpected ${url}`);return route(url,options);},
    dispatch:(name,detail)=>events.push([name,detail]),storage:()=>storage
  });
  return {billing,requests,events,storage,context};
}
const ME=(id="5f2d0c41-8d7e-4a3f-9b61-0a2b3c4d5e6f",csrf="csrf-1")=>async()=>jsonResponse(200,{user:{id},csrfToken:csrf});

test("signed transactions go to STRATA with the session's CSRF token, in batches the server accepts",async()=>{
  const signed=Array.from({length:23},(_,index)=>`jws-${index}`);
  const {billing,requests,events}=billingRealm({routes:[
    ME(),
    async(url,options)=>{assert.deepEqual(JSON.parse(options.body).signedTransactions,signed.slice(0,20));return jsonResponse(200,{discovery:{active:true,accessType:"apple"},accepted:["1","2"]});},
    async(url,options)=>{assert.deepEqual(JSON.parse(options.body).signedTransactions,signed.slice(20));return jsonResponse(200,{discovery:{active:true,accessType:"apple",apple:{active:true}},accepted:[3]});}
  ]});
  const result=await billing.submit([...signed,"jws-0","",null]);
  assert.deepEqual([...result.accepted],["1","2","3"]);assert.deepEqual(result.discovery,{active:true,accessType:"apple",apple:{active:true}});
  const post=requests[1];
  assert.equal(post.url,"/api/billing/apple/transactions");assert.equal(post.options.method,"POST");assert.equal(post.options.credentials,"same-origin");
  assert.equal(post.options.headers["X-CSRF-Token"],"csrf-1");assert.equal(post.options.headers["X-Strata-User"],"5f2d0c41-8d7e-4a3f-9b61-0a2b3c4d5e6f");assert.equal(post.options.headers["Content-Type"],"application/json");
  assert.equal(JSON.stringify(events),JSON.stringify([["strata:app-billing",{discovery:result.discovery}]]));
});

test("a stale CSRF token is refreshed once, and a signed-out page sends nothing",async()=>{
  const stale=billingRealm({routes:[ME("u","old"),async()=>jsonResponse(403,{error:"Security",code:"INVALID_CSRF"}),ME("u","new"),async(url,options)=>{assert.equal(options.headers["X-CSRF-Token"],"new");return jsonResponse(200,{discovery:null,accepted:["9"]});}]});
  assert.deepEqual([...(await stale.billing.submit(["jws"])).accepted],["9"]);
  const signedOut=billingRealm({routes:[async()=>jsonResponse(401,{error:"Not signed in."})]});
  await assert.rejects(signedOut.billing.submit(["jws"]),(error)=>error.code==="SIGN_IN_REQUIRED"&&error.status===401);
  assert.equal(signedOut.requests.length,1);
});

test("a StoreKit update is finished only after STRATA accepted it; anything else stays for StoreKit to redeliver",async()=>{
  const finished=[],plugin={finishTransaction:async({transactionId})=>{finished.push(transactionId);return {};}};
  const accepted=billingRealm({plugin,routes:[ME(),async()=>jsonResponse(200,{discovery:{active:true},accepted:["700"]})]});
  assert.equal(await accepted.billing.handleUpdate({transactionId:"700",signedTransaction:"jws-renewal"}),true);
  assert.deepEqual(finished,["700"]);
  for(const [name,route] of [
    ["mismatch",async()=>jsonResponse(403,{error:"Other account",code:"APPLE_ACCOUNT_MISMATCH"})],
    ["other account",async()=>jsonResponse(409,{error:"Linked elsewhere",code:"APPLE_PURCHASE_OTHER_ACCOUNT"})],
    ["invalid",async()=>jsonResponse(400,{error:"Invalid",code:"APPLE_SIGNATURE_INVALID"})],
    ["not listed",async()=>jsonResponse(200,{discovery:{active:true},accepted:["other"]})],
    ["offline",async()=>{throw new TypeError("Load failed");}]
  ]){
    const rejected=billingRealm({plugin,routes:[ME(),route]});
    assert.equal(await rejected.billing.handleUpdate({transactionId:"701",signedTransaction:"jws"}),false,name);
  }
  const signedOut=billingRealm({plugin,routes:[async()=>jsonResponse(401,{})]});
  assert.equal(await signedOut.billing.handleUpdate({transactionId:"702",signedTransaction:"jws"}),false);
  assert.equal(await signedOut.billing.handleUpdate({transactionId:"",signedTransaction:"jws"}),false);
  assert.deepEqual(finished,["700"]);
});

test("current entitlements sync once per launch for signed-in members",async()=>{
  let reads=0;const plugin={currentEntitlements:async()=>{reads+=1;return {signedTransactions:["jws-current"]};}};
  const realmOne=billingRealm({plugin,routes:[ME(),async(url,options)=>{assert.deepEqual(JSON.parse(options.body),{signedTransactions:["jws-current"]});return jsonResponse(200,{discovery:{active:true},accepted:["1"]});}]});
  assert.equal(await realmOne.billing.syncEntitlements(),"synced");
  assert.equal(await realmOne.billing.syncEntitlements(),"skipped","the launch flag stops a second sync");
  assert.equal(reads,1);assert.equal(realmOne.storage.values.get(realmOne.context.StrataAppMode.SYNC_KEY),"1");
  const signedOut=billingRealm({plugin,routes:[async()=>jsonResponse(401,{})]});
  assert.equal(await signedOut.billing.syncEntitlements(),"signed-out");assert.equal(signedOut.storage.values.size,0,"a later signed-in page still syncs");
  const offline=billingRealm({plugin,routes:[ME(),async()=>{throw new TypeError("offline");}]});
  assert.equal(await offline.billing.syncEntitlements(),"rejected");assert.equal(offline.storage.values.size,0,"a network failure retries on the next page");
  const empty=billingRealm({plugin:{currentEntitlements:async()=>({signedTransactions:[]})},routes:[ME()]});
  assert.equal(await empty.billing.syncEntitlements(),"empty");
  const oldBuild=billingRealm({plugin:{},routes:[]});
  assert.equal(await oldBuild.billing.syncEntitlements(),"skipped");
});

test("on every page in the app, transaction updates are posted and finished, and entitlements sync after load",async()=>{
  const finished=[];
  const page=realm({pathname:"/dashboard",readyState:"loading",plugin:{finishTransaction:async({transactionId})=>{finished.push(transactionId);return {};},currentEntitlements:async()=>({signedTransactions:[]})}});
  const posts=[];
  page.window.fetch=async(url,options)=>{if(url==="/api/me")return jsonResponse(200,{user:{id:"u-1"},csrfToken:"c"});posts.push(JSON.parse(options.body));return jsonResponse(200,{discovery:{active:true},accepted:["55"]});};
  page.insertBody();page.ready();
  assert.ok(page.calls.some((call)=>call[0]==="addListener"&&call[1]==="StrataNative"&&call[2]==="transactionUpdated"));
  page.emit("load");assert.ok(page.calls.some((call)=>call[0]==="setTimeout"));
  page.window.transactionUpdated({transactionId:"55",signedTransaction:"jws-55"});
  for(let index=0;index<10;index+=1)await new Promise(setImmediate);
  assert.deepEqual(posts,[{signedTransactions:["jws-55"]}]);assert.deepEqual(finished,["55"]);
});
