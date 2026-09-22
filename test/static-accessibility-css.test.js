"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const PROJECT_ROOT=path.join(__dirname,"..");
const read=(name)=>fs.readFileSync(path.join(PROJECT_ROOT,name),"utf8");
const homeClient=()=>["home-logic.js","home-state.js","home-api.js","home-render.js","home-events.js","app.js"].map(name=>read(`public/scripts/${name}`)).join("\n");
const discoverClient=()=>["discover-api.js","discover-navigation.js","discover-progress.js","discover-render.js","discover-catalog.js","discover-detail.js","discover-community.js","discover-session.js","discover-sharing.js","discover-events.js","discover.js"].map(name=>read(`public/scripts/${name}`)).join("\n");
const workoutClient=()=>["workout-state.js","workout-api.js","workout-calendar.js","workout-render.js","workout-context.js","workout-guidance.js","workout-history.js","workout-events.js","workout.js"].map(name=>read(`public/scripts/${name}`)).join("\n");

test("homepage styles keep live comparison UI and omit retired modal families",()=>{
  const css=read("public/styles/styles.css");
  for(const selector of [".compare-dock",".compare-dialog",".dialog-header","#compareContent",".compare-table-wrap",".compare-table"]){
    assert.ok(css.includes(selector),`${selector} must remain styled`);
  }
  assert.doesNotMatch(css,/\.(?:plan-(?:dialog|content|layout|sidebar|sidebar-label|editor|title-fields|field|list-head|item|video|empty|summary)|workout-tabs?|remove-item|auth-[a-z-]+|account-(?:card|avatar|stats|actions))\b/);
});

test("homepage navigation and exercise controls expose 44px touch targets",()=>{
  const css=read("public/styles/styles.css");
  assert.match(css,/\.brand\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(css,/\.action-icon\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
  assert.doesNotMatch(css,/\.exercise-row \.action-icon\s*\{[^}]*\b(?:width|height):\s*(?:3\d|4[0-3])px/);
});

test("the focusable horizontal comparison region has a visible focus treatment",()=>{
  const css=read("public/styles/styles.css");
  const app=homeClient();
  assert.match(app,/class="compare-table-wrap" role="region"[^>]*tabindex="0"/);
  assert.match(css,/\.compare-table-wrap:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--orange-text\);[^}]*box-shadow:/);
});

test("compact mobile navigation keeps account actions and every muscle group easy to reach",()=>{
  const home=read("public/pages/index.html");
  const account=read("public/pages/account.html");
  const homeCss=read("public/styles/styles.css");
  const accountCss=read("public/styles/account.css");
  assert.match(home,/class="group-tabs-hint"[^>]*>Swipe to explore all 8 muscle groups/);
  assert.match(homeCss,/\.group-tabs\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;[^}]*scroll-snap-type:\s*x proximity;/);
  assert.match(account,/class="account-choice-nav"[^>]*>[\s\S]*href="#signupPanel"[\s\S]*href="#loginPanel"/);
  assert.match(accountCss,/\.account-choice-nav\{display:grid;grid-template-columns:1fr 1fr;/);
  assert.match(accountCss,/\.signed-actions \[hidden\],\.security-actions \[hidden\]\{display:none\}/,"Account CSS must not expose privileged or inactive hidden actions");
});

test("the support honeypot stays outside the accessibility tree",()=>{
  const contact=read("public/pages/contact.html");
  assert.match(contact,/<div class="support-honeypot" aria-hidden="true">[\s\S]*?<input[^>]*tabindex="-1"/);
});

test("Discover defines the compact hero gap only once",()=>{
  const css=read("public/styles/discover.css");
  assert.equal(css.match(/\.hero-layout\s*\{\s*gap:\s*34px;\s*\}/g)?.length,1);
});

test("every native dialog has an accessible name and restores its trigger",()=>{
  for(const page of ["public/pages/index.html","public/pages/admin.html","public/pages/discover.html"]){
    const html=read(page),dialogs=[...html.matchAll(/<dialog\b([^>]*)>/g)];
    assert.ok(dialogs.length,`${page} should contain a dialog`);
    for(const [,attributes] of dialogs)assert.match(attributes,/\baria-(?:label|labelledby)="[^"]+"/,`${page} dialog needs an accessible name`);
  }
  assert.match(homeClient(),/dialogReturnFocus/);
  assert.match(read("public/scripts/discover.js"),/dialogReturnFocus/);
});

test("plan-saving surfaces use consistent announced states and actionable errors",()=>{
  const plannerHtml=read("public/pages/planner.html"),planner=read("public/scripts/planner.js"),discover=discoverClient();
  assert.match(plannerHtml,/id="saveStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  for(const state of ["Saving…","Saved","Couldn't save — Retry"])assert.ok(planner.includes(state),`planner must expose ${state}`);
  for(const state of ["Saving…","Saved","Couldn't save — Retry"])assert.ok(discover.includes(state),`Strata+ must expose ${state}`);
  assert.match(discover,/data-rating-status role="status" aria-live="polite"/);
  assert.match(planner,/PLAN_CHANGED/);
  assert.match(discover,/latest plan is loaded; review the selected day/i);
});

test("planner and workout share clear Plan and Train navigation at mobile widths",()=>{
  const plannerHtml=read("public/pages/planner.html"),workoutHtml=read("public/pages/workout.html"),discoverHtml=read("public/pages/discover.html");
  const plannerCss=read("public/styles/planner.css"),workoutCss=read("public/styles/workout.css");
  const destinations=/Exercises<\/a><a[^>]*>Strata\+<\/a><a[^>]*>Plan<\/a><a[^>]*>Train<\/a>/;
  assert.match(plannerHtml,destinations);assert.match(workoutHtml,destinations);assert.match(discoverHtml,destinations);
  assert.match(plannerHtml,/href="\/planner\.html" aria-current="page">Plan<\/a>/);
  assert.match(workoutHtml,/href="\/workout\.html" aria-current="page">Train<\/a>/);
  for(const [name,html,desktop,user,mobile] of [
    ["Planner",plannerHtml,'class="planner-primary-nav planner-primary-nav-desktop"','class="user-menu"','class="planner-primary-nav planner-primary-nav-mobile"'],
    ["Workout",workoutHtml,'class="workout-nav workout-nav-desktop"','class="header-account"','class="workout-nav workout-nav-mobile"'],
    ["Strata+",discoverHtml,'class="studio-nav studio-nav-desktop"','class="studio-user"','class="studio-nav studio-nav-mobile"']
  ]){
    assert.ok(html.indexOf(desktop)<html.indexOf(user),`${name} desktop navigation must precede account controls in keyboard order`);
    assert.ok(html.indexOf(user)<html.indexOf(mobile),`${name} mobile account controls must precede the bottom navigation in keyboard order`);
  }
  assert.match(plannerCss,/\.planner-primary-nav-mobile\{display:none\}/);
  assert.match(plannerCss,/@media\(max-width:760px\)\{[\s\S]*?\.planner-primary-nav-desktop\{display:none\}[\s\S]*?\.planner-primary-nav-mobile\{display:grid\}/);
  assert.match(workoutCss,/\.site-header \.workout-nav-mobile\{display:none\}/);
  assert.match(workoutCss,/@media\(max-width:760px\)\{[\s\S]*?\.site-header \.workout-nav-desktop\{display:none\}[\s\S]*?\.site-header \.workout-nav-mobile\{display:grid\}/);
  const discoverCss=read("public/styles/discover.css");
  assert.match(discoverCss,/\.studio-nav-mobile \{ display:none; \}/);
  assert.match(discoverCss,/@media\(max-width:800px\)[\s\S]*?\.plus-studio \.studio-nav-desktop \{ display:none; \}[\s\S]*?\.plus-studio \.studio-nav-mobile \{ display:flex; \}/);
  assert.match(plannerCss,/\.planner-primary-nav\{position:fixed;[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(plannerCss,/\.planner-primary-nav a\{[^}]*font-size:11px/);
  assert.match(plannerCss,/@media\(max-width:760px\)\{[\s\S]*?\.planner-header\{background:var\(--ink\);backdrop-filter:none\}/);
  assert.match(workoutCss,/@media\(max-width:760px\)\{[\s\S]*?\.site-header nav\{position:fixed/);
  assert.match(discoverCss,/@media\(max-width:760px\)\s*\{[\s\S]*?\.plus-studio \.studio-nav\s*\{[^}]*position:fixed/);
  assert.match(workoutCss,/\.site-header nav\{position:fixed;[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(workoutCss,/@media\(max-width:760px\)\{[\s\S]*?\.workout-page \.site-header\{[^}]*background:var\(--bg\);backdrop-filter:none\}/);
});

test("workout empty days and planner mobile hand-offs expose useful 44px actions",()=>{
  const plannerHtml=read("public/pages/planner.html"),plannerCss=read("public/styles/planner.css");
  const workoutHtml=read("public/pages/workout.html"),workout=workoutClient(),context=read("public/scripts/workout-context.js"),workoutCss=read("public/styles/workout.css");
  assert.match(workoutHtml,/id="chooseScheduledDay" hidden/);assert.match(workoutHtml,/id="openPlannerFromEmpty"[^>]*hidden/);
  assert.match(context,/You have not built a weekly plan yet/);assert.match(context,/Nothing is scheduled for this day/);assert.match(context,/Scheduled in your weekly plan/);
  assert.match(context,/start\.hidden=true;resume\.hidden=!active;choose\.hidden=true;build\.hidden=true;\$\("differentWorkout"\)\.hidden=true/);
  assert.match(context,/if\(active\)[\s\S]*return;/);assert.match(context,/if\(!hasWeek\)[\s\S]*build\.hidden=false;return;/);assert.match(context,/if\(!items\.length\)[\s\S]*choose\.hidden=false/);
  assert.match(workoutCss,/\.button\{[^}]*min-height:48px/);
  assert.match(workout,/record\?\.dirty\)items\.push/);assert.match(workout,/status!=="active"\|\|!recoveryIds\.has/);assert.match(workout,/recoveryIndex>=0/);
  assert.match(workoutCss,/\.mode-notice a,\.text-link,footer a\{[^}]*min-width:44px;min-height:44px/);
  assert.match(workoutHtml,/id="anotherSession">Choose another workout<\/button>/);
  assert.doesNotMatch(workoutHtml,/Back to my plan/);
  assert.match(plannerHtml,/class="planner-mobile-switcher"[^>]*>[\s\S]*Exercise library[\s\S]*My week/);
  assert.match(plannerHtml,/id="libraryPanel"[^>]*tabindex="-1"/);
  assert.match(plannerCss,/\.planner-mobile-switcher\{position:sticky;[^}]*display:grid/);
  assert.match(plannerCss,/\.planner-jump-link\{[^}]*min-height:44px/);
  assert.match(plannerCss,/\.planner-mode-notice a \{[^}]*min-height:44px/);
  assert.match(plannerCss,/\.build-footer a\{min-width:44px;color:inherit/);
  assert.match(workoutCss,/\.skip-link\{[^}]*z-index:100;/,"The focused workout skip link must paint above its sticky header");
  assert.match(workoutCss,/@media\(max-width:760px\)\{\s*html\{scroll-padding-bottom:calc\(76px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(workoutHtml,/id="historyError"[^>]*role="alert"/);
  assert.match(workoutHtml,/href="\/pricing">Review Strata\+ access<\/a>/);
  assert.match(workoutHtml,/href="\/planner\.html">Return to free Plan<\/a>/);
  assert.match(workoutHtml,/id="openPlannerFromEmpty"[^>]*>Build your first week/);
  assert.match(workoutHtml,/id="editWorkoutWeek"[^>]*>Edit weekly plan/);
  assert.match(workoutHtml,/id="chooseScheduledDay"[^>]*>Choose another day/);
  assert.match(workoutHtml,/id="checkInForm"[^>]*aria-labelledby="checkInTitle"/);
  for(const id of ["checkInDifficulty","checkInEnergy","checkInComfort","checkInEnjoyment"])assert.match(workoutHtml,new RegExp(`id="${id}" required`));
  assert.match(workoutHtml,/STRATA does not detect recovery, fatigue, pain, or injury/);
  assert.match(workout,/\/api\/workouts\/\$\{encodeURIComponent\(workoutId\)\}\/check-in/);
  assert.match(workout,/checkIn:\{difficulty:values\[0\],energy:values\[1\],comfort:values\[2\],enjoyment:values\[3\]\}/);
  assert.match(workoutHtml,/No change happens unless you approve it/);
  assert.match(workoutHtml,/id="reviewAdaptation" href="\/discover\.html#planWorkspace"/);
  assert.doesNotMatch(workoutHtml,/id="(?:acceptAdaptation|dismissAdaptation)"/);
  assert.match(read("public/scripts/discover.js"),/decision:"accept",expectedPlanUpdatedAt:suggestion\.expectedPlanUpdatedAt/);
  assert.match(workoutCss,/\.exercise-guide>summary\{[^}]*min-height:46px/);
  assert.match(workoutCss,/\.check-in-grid\{display:grid/);
});

test("planner keeps evidence collapsed and shows plan guidance only to active Strata+ accounts",()=>{
  const plannerHtml=read("public/pages/planner.html"),planner=read("public/scripts/planner.js"),plannerRender=read("public/scripts/planner-render.js");
  assert.match(plannerHtml,/<details class="plan-insights" id="planInsights">/);
  assert.doesNotMatch(plannerHtml,/<details class="plan-insights" id="planInsights"[^>]*\sopen(?:\s|>)/);
  assert.match(planner,/plusActive=STATE\.hasConfirmedPlusAccess\(state\)/);
  assert.match(planner,/else if\(plusActive&&!total\)readiness=/);
  assert.match(planner,/\$\{readiness\?`<section class="week-readiness/);
  assert.match(planner,/href:`\/workout\.html\?day=/);
  assert.match(plannerRender,/Free device plan/);
  assert.match(plannerRender,/Free synced plan/);
});

test("fixed mobile navigation reserves scroll space for keyboard focus",()=>{
  const css=read("public/styles/experience.css");
  assert.match(css,/@media \(max-width: 800px\)\s*\{\s*html \{ scroll-padding-bottom: calc\(76px \+ env\(safe-area-inset-bottom\)\); \}\s*\}/);
});

test("global motion progress tracks scroll and stays hidden for reduced motion and print",()=>{
  const motion=read("public/scripts/motion.js"),listeners={},frames=new Map();
  const rootClasses=new Set(),preference={matches:false,listener:null,addEventListener(type,handler){if(type==="change")this.listener=handler;}};
  let progress=null,nextFrame=0,disconnects=0;
  class FakeIntersectionObserver{
    disconnect(){disconnects+=1;}
    observe(){}
    unobserve(){}
  }
  const documentElement={
    scrollHeight:2200,
    classList:{add:(name)=>rootClasses.add(name),remove:(name)=>rootClasses.delete(name),contains:(name)=>rootClasses.has(name)}
  };
  const document={
    readyState:"complete",documentElement,
    body:{append(node){progress=node;}},
    querySelectorAll(){return[];},
    createElement(){
      return{className:"",dataset:{},style:{},attributes:{},setAttribute(name,value){this.attributes[name]=String(value);},getAttribute(name){return this.attributes[name]??null;}};
    }
  };
  const window={
    innerHeight:1000,scrollY:0,IntersectionObserver:FakeIntersectionObserver,
    matchMedia:()=>preference,
    addEventListener(type,handler){(listeners[type]||=[]).push(handler);}
  };
  const context={
    window,document,IntersectionObserver:FakeIntersectionObserver,
    requestAnimationFrame(handler){const id=++nextFrame;frames.set(id,handler);return id;},
    cancelAnimationFrame(id){frames.delete(id);}
  };
  vm.createContext(context);
  vm.runInContext(motion,context,{filename:"motion.js"});

  assert.ok(progress,"motion.js must append the progress element");
  assert.equal(progress.className,"strata-scroll-progress");
  assert.equal(progress.getAttribute("aria-hidden"),"true");
  assert.equal(progress.dataset.active,"true");
  assert.equal(progress.style.transform,"scaleX(0)");
  assert.equal(rootClasses.has("motion-ready"),true);

  window.scrollY=600;
  for(const handler of listeners.scroll||[])handler();
  assert.equal(frames.size,1,"scroll updates should be coalesced into one frame");
  const [[frameId,frame]]=frames.entries();frames.delete(frameId);frame();
  assert.equal(progress.style.transform,"scaleX(0.5)");

  documentElement.scrollHeight=900;
  for(const handler of listeners.resize||[])handler();
  const [[resizeFrameId,resizeFrame]]=frames.entries();frames.delete(resizeFrameId);resizeFrame();
  assert.equal(progress.dataset.active,"false");
  assert.equal(progress.style.transform,"scaleX(0)");

  preference.matches=true;preference.listener();
  assert.equal(rootClasses.has("motion-ready"),false,"reduced motion must disable reveal animation state");
  assert.ok(disconnects>0,"reduced motion must disconnect reveal observers");

  for(const file of ["public/styles/experience.css","public/styles/workout.css"]){
    const css=read(file);
    assert.match(css,/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.strata-scroll-progress\s*\{[^}]*display:\s*none/i,`${file} reduced-motion progress`);
    assert.match(css,/@media\s+print\s*\{[\s\S]*?\.strata-scroll-progress\s*\{[^}]*display:\s*none/i,`${file} print progress`);
  }
});
