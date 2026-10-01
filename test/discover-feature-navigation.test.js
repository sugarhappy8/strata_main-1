"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");

const PROJECT_ROOT=join(__dirname,"..");
const read=(...parts)=>readFileSync(join(PROJECT_ROOT,"public",...parts),"utf8");
const discoverModules=["personal-training-energy-ui-core.js","personal-training-ui-core.js","personal-training-diary-ui.js","personal-training-meals-ui-core.js","discover-state.js","discover-api.js","discover-navigation.js","discover-progress.js","discover-render.js","discover-coaching-render.js","discover-coaching-trend.js","discover-catalog.js","discover-detail.js","discover-session.js","discover-events.js","discover-coaching-meals.js","discover-coaching.js","discover-program.js","discover-recovery.js","discover-brief.js","discover.js"];
const discoverScript=()=>discoverModules.map(name=>read("scripts",name)).join("\n");

test("Strata+ progressively enhances four primary destinations and focused supporting tools",()=>{
  const html=read("pages","discover.html");
  const script=discoverScript();
  const panels=[...html.matchAll(/<section\b([^>]*\bdata-feature-panel="([^"]+)"[^>]*)>/g)];
  const blocks=[...html.matchAll(/<a\b[^>]*\bclass="[^"]*feature-block[^"]*"[^>]*\bdata-feature-target="([^"]+)"[^>]*>/g)];

  assert.deepEqual(panels.map((match)=>match[2]).sort(),["battle","coaching","library","monthly","nutrition","plan","profile","progress","recommendations","recovery","session","today"]);
  assert.equal(blocks.length,3,"Recommendations, Compare, and Preferences are tools inside the Library");
  for(const label of ["Recommendations","Compare","Preferences"])assert.match(html,new RegExp(`<span>${label}</span>`));
  const destinationNav=html.match(/<nav class="destination-nav"[\s\S]*?<\/nav>/)?.[0]||"";
  assert.deepEqual([...destinationNav.matchAll(/data-feature-target="([^"]+)"/g)].map((match)=>match[1]),["today","recovery","progress","library"]);
  assert.equal((destinationNav.match(/class="destination-link"/g)||[]).length,4,"Plan, Train, and Nutrition moved into Overview");
  for(const destination of ["today","progress","library","recovery"])assert.match(destinationNav,new RegExp(`class="destination-link"[^>]*data-feature-target="${destination}"[^>]*aria-controls="[^"]+"[^>]*aria-expanded="false"`));
  for(const [tag] of panels)assert.doesNotMatch(tag,/\bhidden\b/,"feature panels must remain visible when JavaScript is unavailable");
  for(const [tag] of blocks){
    assert.match(tag,/\baria-controls="[^"]+"/);
    assert.match(tag,/\baria-expanded="false"/);
  }
  assert.doesNotMatch(html,/class="studio-account"/,"Profile in the site navigation replaces the separate Account link");
  assert.match(html,/aria-label="Primary navigation"><a href="#exerciseExplorer" data-section="rankings">Rankings<\/a><a class="active" href="#todayWorkspace" data-section="week" aria-current="page">My Week<\/a><a href="\/workout\.html" data-section="train">Train<\/a><a href="#recoveryWorkspace" data-section="recovery">Recovery<\/a><a href="\/account\.html" data-section="profile">Profile<\/a>/);
  assert.match(script,/account\.html\?mode=login&next=discover/);
  assert.doesNotMatch(html,/id="exploreWorkspace"/,"the Exercises hub is gone; the destination opens the Library");
  const libraryTools=html.match(/<nav class="feature-grid explore-tool-grid library-tools"[\s\S]*?<\/nav>/)?.[0]||"";
  assert.equal((libraryTools.match(/class="feature-block"/g)||[]).length,3,"the Library carries its three tools");
  assert.doesNotMatch(html,/<details class="explore-advanced-tools"/);
  const overview=html.match(/<section class="studio-hero feature-panel" id="todayWorkspace"[\s\S]*?<\/section>\n\n {6}<section class="plan-workspace/)?.[0]||"";
  const tools=overview.match(/<nav class="overview-tool-grid"[\s\S]*?<\/nav>/)?.[0]||"";
  assert.match(tools,/class="overview-tool" href="#planWorkspace" data-feature-target="plan" aria-controls="planWorkspace" aria-expanded="false"><span class="overview-tool-label">Plan<\/span>/);
  assert.match(tools,/class="overview-tool" href="\/workout\.html"><span class="overview-tool-label">Train<\/span>/,"Train opens its own page");
  assert.match(tools,/class="overview-tool" href="#nutritionWorkspace" data-feature-target="nutrition" aria-controls="nutritionWorkspace" aria-expanded="false"><span class="overview-tool-label">Nutrition<\/span>/);
  assert.match(overview,/id="plusAskAi" href="\/ai">Ask Strata AI to plan/,"Overview keeps its Strata AI action");
  for(const panel of ["planWorkspace","nutritionWorkspace"]){
    const section=html.match(new RegExp(`<section[^>]*id="${panel}"[\\s\\S]*?<div class="studio-container">\\s*<a class="tool-menu-link[^"]*" href="#todayWorkspace" data-feature-target="today">Back to Overview`));
    assert.ok(section,`${panel} offers a way back to Overview`);
  }
  assert.match(html,/<details class="plan-tool-disclosure" id="workoutBuilderDetails">/);
  assert.doesNotMatch(html,/<details class="(?:explore-advanced-tools|plan-tool-disclosure)"[^>]*\bopen\b/,"secondary tools should start collapsed");
});

test("the Strata AI chat launcher glows on every Strata+ view, names itself on hover or focus, and opens a chat panel",()=>{
  const html=read("pages","discover.html"),css=read("styles","ai-chat.css"),discoverCss=read("styles","discover.css");
  const launcher=html.match(/<button class="ai-launcher"[\s\S]*?<\/button>/)?.[0]||"";
  const panel=html.match(/<section class="ai-panel"[\s\S]*?<\/section>/)?.[0]||"";
  assert.match(launcher,/id="aiChatLauncher" type="button" aria-label="Strata AI chat" aria-controls="aiChatPanel" aria-expanded="false"/);
  assert.match(launcher,/<span class="ai-launcher-tip" aria-hidden="true">Strata AI chat<\/span>/);
  assert.match(panel,/id="aiChatPanel" role="dialog" aria-labelledby="aiChatTitle" tabindex="-1" hidden/);
  for(const id of ["aiChatTitle","aiChatStatus","aiChatStatusTitle","aiChatStatusDetail","aiChatReset","aiChatClose","aiChatScroll","aiChatEmpty","aiChatStarters","aiChatConversation","aiChatForm","aiChatSuggest","aiChatMessage","aiChatSend","aiChatSendLabel","aiChatError","aiChatCount","aiChatAnnounce"])assert.match(panel,new RegExp(`\\bid="${id}"`),id);
  assert.match(panel,/<label class="sr-only" for="aiChatMessage">Message to Strata AI<\/label>/);
  assert.match(panel,/href="\/ai" aria-label="Open Strata AI full screen"/);
  assert.match(html,/<dialog class="ai-dialog" id="aiChatConfirm"/);
  assert.ok(html.indexOf(launcher)>html.indexOf("</main>")&&html.indexOf(panel)>html.indexOf("</main>"),"the chat sits outside every feature panel so it never hides with one");
  assert.match(html,/data-ai-chat-open id="plusAskAi" href="\/ai"/,"Ask Strata AI to plan opens the chat and still links to the full page without JavaScript");
  assert.doesNotMatch(html+discoverCss,/ai-bubble/,"the old speech bubble is gone");
  assert.match(css,/\.ai-launcher::before \{[^}]*animation:ai-launcher-glow 2\.8s ease-in-out infinite;/);
  assert.match(css,/\.ai-launcher::after \{[^}]*animation:ai-launcher-ring 2\.8s [^;]*infinite;/);
  assert.match(css,/@media \(hover:hover\) and \(pointer:fine\) \{[\s\S]*?\.ai-launcher:hover \.ai-launcher-tip \{ opacity:1; visibility:visible;/,"hover shows the label only where a pointer can hover, so a tap opens the chat");
  assert.match(css,/\.ai-launcher:focus-visible \.ai-launcher-tip \{ opacity:1; visibility:visible;/);
  assert.match(css,/@media \(prefers-reduced-motion:reduce\) \{\s*\.ai-launcher::before,\.ai-launcher::after,/);
  assert.match(css,/\.ai-panel\[hidden\] \{ display:none; \}/);
  assert.match(css,/@media print \{ \.ai-launcher,\.ai-panel \{ display:none !important; \} \}/);
  const order=["ai-logic.js","ai-state.js","ai-api.js","ai-render.js","ai-events.js","ai-conversation.js","ai-widget.js","discover.js"].map((name)=>html.indexOf(`${name}?v=`));
  assert.ok(order.every((index,position)=>index>0&&(position===0||index>order[position-1])),"the chat modules load in dependency order before the Strata+ shell mounts them");
  assert.match(read("scripts","discover.js"),/globalThis\.StrataAiWidget\?\.mount\(\{onApplied:/);
});

test("coaching profile setup presents four navigable cards and labels every capability input",()=>{
  const html=read("pages","discover.html"),script=read("scripts","discover-coaching.js"),render=read("scripts","discover-coaching-render.js"),css=read("styles","discover.css");
  const setup=html.match(/<section class="coaching-onboarding"[\s\S]*?<section class="coaching-dashboard"/)?.[0]||"";
  assert.match(setup,/class="coaching-setup-map" aria-label="Coaching profile sections"/);
  for(const [id,label] of [["coachingBodyInputs","Body and energy inputs"],["coachingTrainingInputs","Training experience and week"],["coachingCapabilityInputs","Workouts you know"],["coachingNutritionInputs","Calorie pattern and optional macros"]]){
    assert.match(setup,new RegExp(`href="#${id}"`),`${label} needs a setup-map link`);
    assert.match(setup,new RegExp(`id="${id}"`),`${label} needs a stable section target`);
  }
  assert.equal((setup.match(/class="coaching-form-section/g)||[]).length,4);
  assert.match(setup,/class="coaching-capability-empty"/);
  for(const label of ["Exercise","Sets","Reps","Weight","Unit"])assert.match(script,new RegExp(`<span>${label}<\\/span>`),`${label} must remain visible beside generated capability inputs`);
  assert.match(html,/id="coachingDailyMovement"[^>]*>[\s\S]*?<option value="">Review and choose<\/option>/,"non-workout movement must require an explicit choice");
  for(const movement of ["mostly_seated","lightly_moving","on_feet","physically_demanding"])assert.match(html,new RegExp(`<option value="${movement}"`));
  assert.match(html,/id="coachingAdditionalActivityMinutes"[^>]*min="0"[^>]*max="1260"/);
  assert.match(html,/id="coachingAdditionalActivityIntensity"[^>]*disabled>[\s\S]*?<option value="moderate" selected>/);
  assert.match(html,/Include normal work, chores, errands, and usual commuting\.[\s\S]*Exclude every STRATA session and any sport, cardio, or active-travel minutes you enter separately below\./);
  assert.match(html,/Add sport, cardio, or active travel only when those minutes are not already represented by your normal-day answer and are not part of the STRATA workout plan\./);
  assert.match(script,/Number\(data\.profile\.version\)<4[\s\S]*?renderer\.show\("setup"\)/,"profiles from earlier energy models must open setup for explicit review");
  assert.match(script,/coachingDiscardProfile[\s\S]*?renderer\.renderDashboard/,"discarding the required review must keep an existing dashboard available");
  assert.match(render,/previous activity answer remains in this saved week until you review daily movement and any activity outside STRATA/,"the dashboard must visibly disclose preserved legacy semantics");
  assert.match(css,/\.coaching-form-section > legend \{ float:left; width:100%/);
  assert.match(css,/\.coaching-capability-row > label > span \{ display:none/);
  assert.match(css,/@media\(max-width:800px\)[\s\S]*\.coaching-capability-row > label > span \{ display:block/);
});

test("Strata+ keeps the weekly Plan primary and explains secondary planning tools literally",()=>{
  const html=read("pages","discover.html");
  const plan=html.match(/<section class="plan-workspace feature-panel"[\s\S]*?<section class="progress-workspace feature-panel"/)?.[0]||"";
  assert.match(plan,/id="planWorkspaceTitle"[^>]*>Make room for <em>progress\.<\/em>/);
  assert.match(plan,/Review your weekly plan, create one workout, or organize the same week over a longer period\./);
  assert.match(plan,/class="plan-summary-card plan-primary-card"[^>]*aria-labelledby="planSummaryTitle"/);
  assert.match(plan,/id="planSummaryTitle">Your weekly plan<\/h3>/);
  assert.match(plan,/See the exercises assigned to each day\. Edit days, sets, and repetitions in Plan\./);
  for(const label of ["Training days","Exercises","Working sets"])assert.match(plan,new RegExp(`<dt>${label}<\\/dt>`));
  assert.match(plan,/id="planWorkspaceAction"[^>]*href="\/planner\.html"[^>]*>Edit weekly plan/);

  for(const [id,title] of [["workoutBuilderDetails","Workout builder"],["planAheadDetails","Plan ahead"],["reuseWeekDetails","Reuse a week"]]){
    assert.match(plan,new RegExp(`<details class="plan-tool-disclosure" id="${id}"`),id);
    assert.match(plan,new RegExp(`<strong[^>]*>${title}<\\/strong>`),title);
  }
  assert.doesNotMatch(plan,/<details class="plan-tool-disclosure"[^>]*\bopen\b/,"secondary planning tools should start progressively disclosed");
  assert.match(plan,/Create one workout when your available time, equipment, or target muscles are different today\./);
  assert.match(plan,/>Create a workout(?:\s|<)/);
  assert.match(plan,/Repeat and review your weekly plan over four to eight weeks\./);
  assert.match(plan,/Place workouts on actual dates for the next 31 days\./);
  assert.match(plan,/Save a weekly plan as a template or move it between devices\./);
  for(const label of ["Templates","Import/export"])assert.match(plan,new RegExp(label));
  assert.equal((plan.match(/id="planSummaryTitle">Your weekly plan<\/h3>/g)||[]).length,1,"Strata+ must not grow a second weekly-plan editor");
});

test("Strata+ explains its three score types once beside the relevant tools",()=>{
  const html=read("pages","discover.html"),guide=html.match(/<aside class="score-guide" id="scoreGuide"[\s\S]*?<\/aside>/)?.[0]||"";
  assert.equal((html.match(/id="scoreGuide"/g)||[]).length,1,"There should be one compact score guide, not repeated explanation panels");
  assert.match(guide,/id="scoreGuideDetails"/);
  assert.match(guide,/FitScore[\s\S]*STRATA’s fixed exercise score\. It does not change based on your profile\./);
  assert.match(guide,/Match for you[\s\S]*How well the exercise fits your goals, equipment, experience, and saved limitations\./);
  assert.match(guide,/Community rating[\s\S]*The average rating submitted by STRATA members\./);
  assert.match(guide,/href="\/policies#methodology"/,"the guide stays short and hands off to the one public method page");
  assert.match(html,/Completed workouts, weekly volume, consistency, and how each exercise is moving\./);
});

test("Strata+ loads bounded state, API, navigation, feature controllers, rendering, events, and shell files in dependency order",()=>{
  const html=read("pages","discover.html"),names=discoverModules;
  let previous=-1;
  for(const name of names){const index=html.indexOf(`src="${name}?v=`);assert.ok(index>previous,`${name} must load after its dependencies`);previous=index;}
  const reviewedBudgets=new Map([["personal-training-energy-ui-core.js",110],["personal-training-ui-core.js",220],["personal-training-meals-ui-core.js",140]]);
  for(const name of names.slice(0,-1))assert.ok(read("scripts",name).split("\n").length<=(reviewedBudgets.get(name)||120),`${name} should remain a small boundary module`);
  assert.ok(read("scripts","discover.js").split("\n").length<=725,"the incremental shell should stay below the state-repair module budget");
});

test("session builder waits for an explicit build and adds the result with plan concurrency protection",()=>{
  const html=read("pages","discover.html"),script=discoverScript();
  for(const id of ["sessionBuilder","sessionBuilderForm","sessionGroup","sessionLength","sessionGenerate","sessionDay","sessionResults","sessionResultsTitle","sessionStatus","sessionAddAll","sessionOpenPlan"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  for(const focus of ["full","upper","lower","push","pull","core"])assert.match(html,new RegExp(`<option value="${focus}"`),focus);
  for(const minutes of [20,35,50])assert.match(html,new RegExp(`<option value="${minutes}"`),String(minutes));
  assert.match(html,/id="sessionResults"[^>]*aria-labelledby="sessionResultsTitle"/);
  assert.match(script,/core\.buildSession\(\{exercises:state\.exercises,preferences:state\.preferences/);
  assert.match(script,/core\.mergeSessionIntoPlan\(state\.weeklyPlan,day,state\.session\)/);
  assert.match(script,/expectedPlanUpdatedAt:state\.weeklyPlanUpdatedAt/);
  assert.match(script,/error\.status===409\|\|error\.code==="PLAN_CHANGED"/);
  assert.match(script,/latest plan is loaded; review the selected day, then add the session again/i);
  assert.match(script,/Time is an estimate; actual duration changes with setup, rest, and training pace/);
  assert.match(html,/id="sessionResultsTitle">Your session will appear here\./);
  assert.match(script,/sessionBuilderForm"\)\?\.addEventListener\("submit",[^\n]+generateSession\(\{announce:true\}\)/);
  assert.doesNotMatch(script,/sessionGroup"\)\?\.addEventListener\("change",[^\n]+generateSession/);
  assert.doesNotMatch(script,/sessionLength"\)\?\.addEventListener\("change",[^\n]+generateSession/);
  assert.doesNotMatch(script,/function initialize\(\)[^\n]+generate/);
  assert.match(script,/preferredDay\(state\.sessionDayInitialized\?select\.value:""\)/,"The initial builder day must come from the saved week or today, not the first static Monday option");
  assert.ok((script.match(/id="sessionResultsTitle"/g)||[]).length>=2,"success and error rendering must retain the results label target");
});

test("Today distinguishes completed planned days from plan coverage and preserves the next action",()=>{
  const html=read("pages","discover.html"),script=discoverScript();
  for(const id of ["weeklyPulse","weeklyPulseEyebrow","weeklyPulseTitle","weeklyPulseDetail","weeklyPulseBar","weeklyPulseAction"])assert.match(html,new RegExp(`\\bid="${id}"`),id);
  assert.match(script,/Core\.weeklyPulse\(state\.weeklyPlan,\{profileDays:state\.preferences\.days\}\)/);
  assert.match(html,/planned days completed this week/);
  assert.match(script,/History unavailable/);
  assert.match(html,/id="plusStartWorkout"[^>]*>Start working out <span aria-hidden="true">↗<\/span>/);
  assert.match(script,/start\.href=`\/workout\.html\?day=\$\{encodeURIComponent\(next\.day\)\}`;start\.innerHTML='Start workout <span aria-hidden="true">↗<\/span>'/);
  assert.match(script,/start\.href=`\/workout\.html#resume=\$\{encodeURIComponent\(active\.id\)\}`;start\.innerHTML='Resume workout <span aria-hidden="true">↗<\/span>'/);
  assert.match(script,/start\.href="\/planner\.html";start\.innerHTML='Build your first week <span aria-hidden="true">→<\/span>'/);
  assert.match(script,/historyStatus==="loading"[\s\S]*start\.hidden=true/);
  assert.match(script,/historyStatus==="error"[\s\S]*start\.hidden=true/);
  assert.doesNotMatch(html,/id="plusRoutineAction"/);
  assert.match(script,/planAction\.href="#planWorkspace"/);
  assert.match(script,/planAction\.innerHTML='Review plan <span aria-hidden="true">→<\/span>'/);
  assert.doesNotMatch(script,/weeklyPulse[^\n]*(?:recovered|readiness)/i);
});

test("monthly workspace exposes private import, multi-muscle schedule, PDF, and sharing controls",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),worker=read("service-worker.js"),css=read("styles","discover.css");
  for(const id of ["monthlyPlanForm","monthlySourceAccount","monthlySourceGuest","monthlyFileInput","monthlySchedule","generateMonthlyPlan","monthlyResults","monthlyPdfButton","monthlyShareButton"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  assert.match(html,/accept="\.json,application\/json"/);
  assert.match(html,/exactly 31 dated days/i);
  assert.match(script,/Monthly\.generateMonthPlan/);
  assert.match(script,/\/api\/monthly-plan/);
  assert.match(script,/navigator\.share/);
  assert.match(script,/print-monthly-plan/);
  assert.match(css,/body\.print-monthly-plan > \.skip-link,[\s\S]*?display: none !important;/,"The exported plan must not print the keyboard skip link");
  assert.match(worker,/monthly-plan-core\.js\?v=/);
});

test("Strata+ feature navigation owns visibility, URL state, focus, and reduced motion",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),css=read("styles","discover.css");

  assert.match(script,/const FEATURE_DEFAULT="today"/);
  assert.match(script,/candidatePanel\.hidden=candidate!==name/);
  assert.match(script,/historyMode:"push"/);
  assert.match(script,/function initialize\(\{scroll=true\}=\{\}\)\{\s*const requested=featureFromLocation\(\);\s*activate\(requested\|\|defaultFeature,\{scroll:scroll&&Boolean\(requested\),historyMode:"none"\}\);\s*\}/);
  assert.match(script,/featureNavigation\.initialize\(\{scroll:false\}\)/,"a deep link must not scroll the loading layout");
  assert.match(script,/revealPrivateWorkspace\(\);[^\n]*\n\s*activateFeature\(state\.activeFeature\|\|FEATURE_DEFAULT,\{scroll:!deepLinkPlaced&&Boolean\(featureNavigation\.featureFromLocation\(\)\)\}\);deepLinkPlaced=true;/,"a deep link is placed once, after the workspace is revealed");
  assert.match(script,/"popstate",restore/);
  assert.match(script,/"hashchange",restore/);
  assert.match(script,/if\(rawHash&&!requested\)return/);
  assert.match(html,/id="activeWorkspaceSkip"[^>]*href="#todayTitle"/);
  assert.match(script,/skip\.setAttribute\?\.\("href",`#\$\{item\.headingId\}`\)/);
  assert.match(script,/skip\.textContent=`Skip to \$\{item\.label\}`/);
  assert.match(script,/focus:\s*true,scroll:\s*true,smooth:\s*true/);
  assert.match(script,/event\.preventDefault\(\);actions\.hideToast\(\);actions\.activateFeature/,"destination navigation should clear a transient saved toast");
  assert.match(script,/activateFeature\("battle"[^\n]+openComparison\(\)/);
  assert.match(script,/initializeFeatureNavigation\(\);[\s\S]{0,160}init\(\);/);
  assert.doesNotMatch(script,/finally\{initializeFeatureNavigation\(\);\}/);
  assert.match(css,/\.feature-panel\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css,/\*,\*::before,\*::after\s*\{\s*animation:none\s*!important;\s*transition:none\s*!important/);
  assert.match(css,/\.session-result-card:hover[^}]*\{\s*transform:none/);
});

test("Today presents one primary action with an honest, comparable training brief",()=>{
  const html=read("pages","discover.html"),script=discoverScript();
  for(const id of ["todayWorkspace","todayTitle","plusStartWorkout","todayDurationLabel","todayDuration","todayEquipmentLabel","todayEquipment","todayPreviousLabel","todayPreviousValue","todayPreviousDetail"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  const today=html.match(/<section class="studio-hero feature-panel"[\s\S]*?<\/section>\s*<section class="plan-workspace/)?.[0]||"";
  assert.equal((today.match(/id="plusStartWorkout"/g)||[]).length,1);
  assert.match(script,/function previousComparable\(items\)/);
  assert.match(script,/same format and unit/);
  assert.match(script,/estimatedSessionMinutes\(items\)/);
  assert.match(script,/The time is an estimate based on movements and working sets/);
  assert.match(script,/todayDurationLabel"\)\.textContent="Elapsed"/);
  assert.match(script,/equipment\.length>2\?`\$\{equipment\.slice\(0,2\)\.join\(" \+ "\)\} \+\$\{equipment\.length-2\} more`/);
});

test("Progress reports bounded log-derived measures without pretending to assess recovery",()=>{
  const html=read("pages","discover.html"),script=discoverScript();
  for(const id of ["progressWorkspace","progressAdherence","progressVolume","progressConsistency","progressSessions","progressWeeks","progressRecordList"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  assert.match(html,/They are training records, not a health assessment/);
  assert.match(html,/volume is load × reps from completed sets/);
  assert.equal((html.match(/class="progress-list"/g)||[]).length,1,"each exercise result is listed once, not as both an improvement and a best");
  assert.match(script,/\/api\/workouts\?limit=100&offset=0/);
  assert.match(script,/summaryKey\(summary,metric\)/);
  assert.match(html,/Calendar weeks with at least one completed workout/);
  assert.match(script,/summary\.loadType!=="external"/,"assistance and bodyweight must not be added to external load volume");
  const assistedMetricLine=script.split("\n").find((line)=>line.includes('summary.loadType==="assisted"'))||"";
  assert.match(assistedMetricLine,/summary\.minAssistance/,"assisted records must use the stored minimum assistance");
  assert.doesNotMatch(assistedMetricLine,/summary\.maxWeight/,"null external-load records must not become zero-assistance records");
  assert.match(script,/Nothing comparable in the 100 most recent sessions/);
  assert.match(script,/Within your 100 most recent sessions/);
  assert.match(script,/Rounding \(not flooring\) keeps a daylight-saving shift/);
  assert.match(html,/id="progressFirstWorkout"[^>]*hidden/);
  assert.match(html,/Your first workout starts the story/);
  assert.match(html,/id="progressHistoryContent"/);
  assert.match(script,/progressFirstWorkout/);
  for(const id of ["progressLoadingState","progressLoadingMessage","progressLoadError","progressLoadErrorMessage","progressRetry","progressEmptyAction","progressHistoryAction"])assert.match(html,new RegExp(`\\bid="${id}"`),id);
  assert.match(script,/status==="loading"/);
  assert.match(script,/status==="error"/);
});

test("training blocks and adaptations require explicit, concurrency-aware approval",()=>{
  const html=read("pages","discover.html"),script=discoverScript();
  for(const id of ["trainingBlockForm","trainingBlockWeeks","trainingBlockStartDate","trainingBlockCurrentWeek","trainingBlockState","trainingBlockLighterWeek","trainingBlockSave","trainingBlockReview","trainingBlockWorkoutCount","trainingBlockSetCount","trainingBlockMuscles","trainingBlockEvidence","trainingBlockNextDecision","trainingBlockCarry","trainingBlockLighter","trainingBlockFinish","trainingBlockActionDialog","trainingBlockActionConfirm","progressionCard","progressionAccept","progressionDismiss","progressionStatus"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  for(const weeks of [4,5,6,7,8])assert.match(html,new RegExp(`<option value="${weeks}"`));
  assert.match(html,/saved weekly Plan is never changed automatically/);
  assert.match(script,/Accepting changes \$\{name\} from \$\{from\} to \$\{to\} sets on \$\{day\} in your saved weekly Plan/);
  assert.match(script,/It remains there until you edit Plan again/);
  assert.doesNotMatch(`${html}\n${script}`,/next-session|next comparable session/i);
  assert.match(html,/Calculated from the start date/);
  assert.match(html,/This is a reminder only\. It never changes sets in your weekly Plan/);
  assert.match(html,/Skipped and replaced counts appear only when a saved workout explicitly records them/);
  assert.match(html,/Nothing is saved until you confirm/);
  assert.match(script,/api\("\/api\/training"\)/);
  assert.match(script,/body:JSON\.stringify\(\{block:blockInput,expectedRevision:state\.trainingBlockRevision,expectedUserId\}\)/);
  assert.match(script,/decision:"accept",expectedPlanUpdatedAt:suggestion\.expectedPlanUpdatedAt/);
  assert.match(script,/decision:"dismiss"/);
  assert.match(script,/await confirmDashboardIdentity\(expectedUserId,expectedCsrf\)/);
  assert.match(script,/adaptationChangeLabel\(raw\.change\)/);
  assert.doesNotMatch(script,/change:String\(raw\.change/);
  assert.match(script,/TRAINING_BLOCK_CHANGED/);
  assert.match(script,/el\("trainingBlockStartDate"\)\.value=localIsoDate\(\)/);
  assert.match(script,/block\.status==="completed"\?`Saved\. Completed/);
  assert.match(script,/BlockCore\.deriveWeek\(\{weeks,startDate\}\)/);
  assert.match(script,/currentWeek=status==="completed"\?weeks:timeline\.week/);
  assert.match(script,/BlockCore\.actionProposal\(state\.trainingBlock,action\)/);
  assert.match(script,/Your weekly Plan is unchanged/);
  assert.match(script,/Workout history is unavailable, so Strata\+ is not making progress, skip, or replacement claims/);
  assert.equal((script.match(/select\.innerHTML=core\.WEEKDAYS/g)||[]).length,1,"session-day options must be rendered once");
  assert.equal((script.match(/if\(previewError\)element\("sessionStatus"\)/g)||[]).length,1,"session preview conflicts must be announced once");
});

test("Strata+ clears private state before focus and visibility account revalidation",()=>{
  const script=discoverScript();

  assert.match(script,/function clearPrivateWorkspace\(\)\{[\s\S]*?workspaceGeneration\+=1;workspaceReady=false;[\s\S]*?state\.user=null;state\.csrfToken="";[\s\S]*?main\.hidden=true;main\.inert=true/);
  assert.match(script,/requestGeneration!==getGeneration\(\)[\s\S]*?STALE_WORKSPACE_RESPONSE/);
  assert.match(script,/String\(data\.user\?\.id\|\|""\)!==String\(identity\.user\?\.id\|\|""\)/);
  assert.match(script,/identity\.user\?\.discovery\?\.active!==true/);
  assert.match(script,/async function revalidateMemberWorkspaceWhenVisible\(\)\{[\s\S]*?clearPrivateWorkspace\(\);[\s\S]*?await init\(\)/);
  assert.match(script,/main\.inert=true;main\.style\.visibility="hidden"/,"the private view is hidden, not cleared, while the session is re-checked");
  assert.match(script,/String\(identity\.csrfToken\|\|""\)===state\.csrfToken&&globalThis\.StrataEntitlements\.can\(identity\.user,"plus\.studio"\)\)\{[^}]*revealPrivateWorkspace\(\)/,"only the same session with active access gets its view back");
  assert.match(script,/loadMemberDashboard\(generation,\{keepForms:true\}\)/);
  assert.match(script,/if\(training&&!keepForms\)/,"a background refresh never rewrites the training-block form");
  assert.match(script,/Unsaved changes stay in this tab until STRATA confirms your account\./);
  assert.match(script,/window\.addEventListener\?\.\("focus"/);
  assert.match(script,/document\.addEventListener\("visibilitychange"/);
});

test("Strata+ copy and visual polish remain resilient across content and breakpoints",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),css=read("styles","discover.css");

  assert.match(html,/id="todayTitle"[^>]*>Your next step\.<br \/><em>Ready when you are\.<\/em>/);
  assert.match(html,/id="recommendationTitle"[^>]*>Best exercises <em>for you\.<\/em>/);
  assert.doesNotMatch(script,/recommendationTitle"\)\.innerHTML/,"A display name must not be interpolated into the recommendation heading");
  assert.match(html,/>Find your strongest fits<\/strong>/);
  assert.match(html,/<span>Overview<\/span><small>Plan, train &amp; eat<\/small>/,"the Overview tab tells members where Plan, Train, and Nutrition live");
  assert.doesNotMatch(html,/feature-block-session/);
  assert.doesNotMatch(css,/feature-block-session/);
  assert.match(css,/\.plus-studio \.profile-section,\.plus-studio \.recommendation-section\s*\{[^}]*color:var\(--ink\);[^}]*background:var\(--paper\)/);
  assert.match(css,/\.plus-studio \.profile-card,[^\n]*\.plus-studio \.recommend-card,[^\n]*\.plus-studio \.session-builder/);
  assert.doesNotMatch(css,/\.recommendation-card|\.session-brief|\.choice span/);
  assert.match(css,/@media\(max-width:800px\)[\s\S]*?\.plus-studio \.studio-header\s*\{[^}]*grid-template-columns:auto minmax\(0,1fr\);[^}]*grid-template-rows:auto auto/);
  assert.match(css,/\.section-heading h2,\.studio-hero \.studio-hero-title,\.weekly-pulse h2\{[^}]*overflow-wrap:normal;word-break:normal/);
});

test("Strata+ initial loading offers a normalized, retryable error without replacing auth redirects",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),css=read("styles","discover.css");
  for(const id of ["discoveryLoadError","discoveryLoadErrorTitle","discoveryLoadErrorMessage","discoveryRetry"])assert.match(html,new RegExp(`\\bid="${id}"`));
  assert.match(html,/id="discoveryRetry"[^>]*>Try again/);
  assert.match(script,/code:"NETWORK_ERROR"/);
  assert.match(script,/error\.redirecting=true;redirect\("\/account\.html\?mode=login&next=discover"\)/);
  assert.match(script,/redirect:\(path\)=>window\.location\.replace\(path\)/);
  assert.match(script,/if\(!error\?\.redirecting&&!error\?\.stale\)showInitialLoadError\(error\)/);
  assert.match(script,/const retryLoad=\(\)=>\{void\(state\.user\?actions\.revalidateMemberWorkspaceWhenVisible\(\):actions\.init\(\)\);\};/,"a signed-in view retries its account check; a failed first load reloads");
  assert.match(script,/"discoveryRetry"\)\.addEventListener\("click",retryLoad\)/);
  assert.match(script,/addEventListener\?\.\("online",\(\)=>\{if\(!el\("discoveryLoadError"\)\.hidden\)retryLoad\(\);\}\)/);
  assert.match(css,/\.discovery-load-error\[hidden\]\s*\{\s*display:none/);
  assert.match(script,/class="loading-card load-error-card"/,"Failed requests should not keep showing the loading animation");
  assert.match(css,/\.load-error-card::before\s*\{[^}]*content:"!"/,"Failed workspaces should show an unmistakable error state");
});

test("open rating drafts survive aggregate-driven detail re-renders",()=>{
  const script=discoverScript();
  assert.match(script,/function openRatingDraft\(id\)/);
  assert.match(script,/const ratingDraft=openRatingDraft\(id\);state\.activeExercise=id/);
  assert.match(script,/ratingFormMarkup\(exercise,ratingDraft\)/);
});

test("Strata+ polish keeps filters legible and comparison details accessible",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),css=read("styles","discover.css");

  assert.equal((html.match(/class="filter-label"/g)||[]).length,6);
  assert.match(html,/id="clearFilters"[^>]*>Clear all</);
  assert.match(script,/data-scroll-alternatives/);
  assert.doesNotMatch(script,/href="#alternativeSection"/);
  assert.match(script,/<thead><tr><th scope="col">Measure<\/th>/);
  assert.match(script,/Best in this comparison/);
  assert.match(script,/match-pill \$\{personal\.eligible\?"":"is-excluded"\}/);
  assert.match(css,/\.match-pill\.is-excluded/);
  assert.match(css,/\.small-button \{ min-height: 44px/);
  assert.match(css,/body:has\(\.compare-tray:not\(\[hidden\]\)\) \{ padding-bottom: 112px/);
  assert.match(css,/@media \(max-width: 520px\)\s*\{\s*\.feature-grid \{ grid-template-columns: 1fr/);
  assert.match(css,/@media \(max-width: 680px\)[\s\S]*?\.studio-header \{[^}]*backdrop-filter:none/,
    "Mobile navigation must escape the sticky header's backdrop-filter containing block");
});

test("Strata+ keeps saved movements as a private, bounded Library collection without changing server contracts",()=>{
  const html=read("pages","discover.html"),script=discoverScript(),core=read("scripts","discovery-core.js");
  for(const id of ["savedActions","movementBoardStatus","clearMovementBoard","compareMovementBoard","savedCollectionLabel"]){
    assert.match(html,new RegExp(`\\bid="${id}"`),id);
  }
  assert.doesNotMatch(html,/movementBoardList|movementBoardCapacity|decision board/i,"the separate decision board is folded into the Library's Saved collection");
  assert.match(html,/data-collection="saved"/);
  assert.match(script,/movementBoard:4/);
  assert.match(script,/MOVEMENT_BOARD_LIMIT=StateCore\.LIMITS\.movementBoard/);
  assert.match(script,/localStorage\?\.getItem\(movementBoardStorageKey\(\)\)/);
  assert.match(script,/localStorage\?\.setItem\(movementBoardStorageKey\(\),JSON\.stringify\(state\.shortlist\)\)/);
  assert.match(script,/core\.normalizeShortlist\(state\.shortlist,state\.exercises,movementBoardLimit\)/);
  assert.match(script,/data-toggle-shortlist/);
  assert.match(script,/savedActions"\)\.hidden=state\.collection!=="saved"/,"saved actions show only inside the Saved collection");
  assert.match(core,/function normalizeShortlist/);
  assert.doesNotMatch(script,/\/api\/(?:shortlist|board|decision)/,"saving stays on the device");

});


test("each daily tool and plan approval has one canonical workspace",()=>{
  const html=read("pages","discover.html"),workout=read("pages","workout.html");
  const progress=html.slice(html.indexOf('id="progressWorkspace"'),html.indexOf('id="coachingWorkspace" data-feature-panel'));
  const plan=html.slice(html.indexOf('id="planWorkspace" data-feature-panel'),html.indexOf('id="progressWorkspace" data-feature-panel'));
  const nutrition=html.slice(html.indexOf('id="nutritionWorkspace" data-feature-panel'),html.indexOf('id="profile" data-feature-panel'));
  assert.doesNotMatch(progress,/<form\b/);assert.match(progress,/data-feature-target="nutrition"/);
  assert.match(plan,/id="programApply"/);assert.match(plan,/id="progressionAccept"/);assert.match(plan,/id="coachingWeekGrid"/);
  assert.match(nutrition,/id="coachingLogForm"/);assert.match(nutrition,/id="coachingFoodOptions"/);assert.doesNotMatch(nutrition,/id="coachingWeekGrid"/);
  for(const id of ["coachingProfileForm","coachingLogForm","coachingFoodOptions","programApply","progressionAccept"])assert.equal((html.match(new RegExp(`id="${id}"`,"g"))||[]).length,1,id);
  assert.doesNotMatch(workout,/id="acceptAdaptation"/);assert.match(workout,/id="reviewAdaptation" href="\/discover\.html#planWorkspace"/);
});
