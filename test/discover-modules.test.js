"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const State=require("../public/scripts/discover-state");
const Api=require("../public/scripts/discover-api");
const Navigation=require("../public/scripts/discover-navigation");
const Progress=require("../public/scripts/discover-progress");
const Render=require("../public/scripts/discover-render");
const Catalog=require("../public/scripts/discover-catalog");
const Detail=require("../public/scripts/discover-detail");
const Community=require("../public/scripts/discover-community");
const Session=require("../public/scripts/discover-session");
const Sharing=require("../public/scripts/discover-sharing");

function classList(){const values=new Set();return{add:name=>values.add(name),remove:name=>values.delete(name),toggle:(name,force)=>force?values.add(name):values.delete(name),contains:name=>values.has(name)};}
function element(id){return{id,hidden:false,dataset:{},classList:classList(),attributes:{},setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},focus(){},scrollIntoView(){}};}

test("Discover state creates isolated mutable workspaces from immutable configuration",()=>{
  const first=State.createState(),second=State.createState();
  first.shortlist.push("one");first.aggregate.set("one",{overall:5});
  assert.deepEqual(second.shortlist,[]);assert.equal(second.aggregate.size,0);
  assert.equal(State.FEATURE_DEFAULT,"today");
  assert.deepEqual(Object.keys(State.FEATURE_CONFIG).slice(0,4),["today","plan","progress","explore"]);
  assert.equal(State.LIMITS.movementBoard,4);
});

test("Discover API attaches account CSRF state and rejects stale responses",async()=>{
  let generation=3,request;
  const client=Api.createClient({fetchImpl:async(path,options)=>{request={path,options};return{ok:true,json:async()=>({ok:true})};},getCsrfToken:()=>"csrf-token",getGeneration:()=>generation,redirect:()=>{}});
  assert.deepEqual(await client("/api/plan",{method:"PUT",body:"{}"}),{ok:true});
  assert.equal(request.options.credentials,"same-origin");assert.equal(request.options.headers["X-CSRF-Token"],"csrf-token");
  const accountResponse={csrfToken:"csrf-token"},account={userId:"user-a",csrfToken:"csrf-token"};
  assert.equal(Api.assertAccountResponse(accountResponse,account,account),accountResponse);
  assert.throws(()=>Api.assertAccountResponse(accountResponse,{...account,userId:"user-b"},account),error=>error.code==="ACCOUNT_CHANGED");
  assert.throws(()=>Api.assertAccountResponse({csrfToken:"other"},account,account),error=>error.code==="ACCOUNT_CHANGED");
  const stale=Api.createClient({fetchImpl:async()=>({ok:true,json:async()=>{generation+=1;return{ok:true};}}),getCsrfToken:()=>"",getGeneration:()=>generation,redirect:()=>{}});
  await assert.rejects(stale("/api/discovery"),error=>error.code==="STALE_WORKSPACE_RESPONSE"&&error.stale===true);
});

test("Discover navigation owns one visible destination and dismisses transient status",()=>{
  const panels=new Map(Object.values(State.FEATURE_CONFIG).map(({panelId})=>[panelId,element(panelId)])),links=[],state=State.createState();
  const document={body:element("body"),getElementById:id=>panels.get(id)||null,querySelectorAll:()=>links};
  let dismissed=0,activated="";
  const navigation=Navigation.createFeatureNavigation({config:State.FEATURE_CONFIG,defaultFeature:State.FEATURE_DEFAULT,state,document,window:{matchMedia:()=>({matches:true})},onDestinationChange:()=>dismissed+=1,onActivate:name=>{activated=name;}});
  assert.equal(navigation.activate("today"),true);assert.equal(activated,"today");
  assert.equal(navigation.activate("progress"),true);assert.equal(dismissed,1);assert.equal(state.activeFeature,"progress");
  assert.equal(panels.get("progressWorkspace").hidden,false);
  assert.equal([...panels.values()].filter(panel=>!panel.hidden).length,1);
});

test("Discover navigation reveals an active destination inside the mobile rail",()=>{
  const panels=new Map(Object.values(State.FEATURE_CONFIG).map(({panelId})=>[panelId,element(panelId)])),nav={clientWidth:300,scrollWidth:720,scrollLeft:0,scrollTo(options){this.scrollLeft=options.left;this.behavior=options.behavior;}},state=State.createState();
  const links=["today","plan","progress","explore","coaching"].map((target,index)=>{const link=element(target);link.dataset.featureTarget=target;link.classList.add("destination-link");link.parentElement=nav;link.offsetLeft=index*145;link.offsetWidth=140;return link;});
  const document={body:element("body"),getElementById:id=>panels.get(id)||null,querySelectorAll:()=>links};
  const navigation=Navigation.createFeatureNavigation({config:State.FEATURE_CONFIG,defaultFeature:State.FEATURE_DEFAULT,state,document,window:{matchMedia:()=>({matches:true})}});
  assert.equal(navigation.activate("coaching",{smooth:true}),true);assert.equal(nav.scrollLeft,420);assert.equal(nav.behavior,"auto");
});

test("Discover toast can be cleared immediately when a destination changes",()=>{
  const toast=element("toast");toast.textContent="";let queued;
  const controller=Navigation.createToastController(toast,{setTimer:callback=>{queued=callback;return 1;},clearTimer:()=>{}});
  controller.show("Saved");assert.equal(toast.classList.contains("show"),true);
  controller.hide();assert.equal(toast.classList.contains("show"),false);
  controller.show("Saved again");queued();assert.equal(toast.classList.contains("show"),false);
});

test("Progress derives truthful summaries and lets the renderer replace zero cards with one first-workout state",()=>{
  const days=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],now=new Date("2026-09-09T12:00:00"),weeklyPlan={days:Object.fromEntries(days.map(day=>[day,day==="Wednesday"?[{exerciseId:"press"}]:[]]))};
  const empty=Progress.snapshot({workouts:[],weeklyPlan,days,now});
  assert.equal(empty.completed.length,0);assert.equal(empty.adherence,"0 / 1");
  const workout={id:"w1",status:"completed",date:"2026-09-09",planDay:"Wednesday",startedAt:2,exerciseSummaries:[{exerciseId:"press",measurement:"reps",loadType:"external",unit:"kg",completedSets:3,maxWeight:20,maxReps:8,volume:480}]};
  const lastWeek={id:"w0",status:"completed",date:"2026-09-02",planDay:"Wednesday",startedAt:1,exerciseSummaries:[{exerciseId:"press",measurement:"reps",loadType:"external",unit:"kg",completedSets:3,maxWeight:17.5,maxReps:8,volume:400}]};
  const summary=Progress.snapshot({workouts:[workout,lastWeek],weeklyPlan,days,now});
  assert.equal(summary.adherence,"1 / 1");assert.equal(summary.volume,"480 kg");assert.match(summary.volumeDetail,/\+20% vs last week/);assert.equal(summary.sessions,"2");
  assert.equal(summary.records.length,1,"one comparable exercise produces one record instead of a duplicate improvement and best");
  assert.deepEqual(summary.records[0].change,{direction:"up",text:"+2.5 kg"});assert.equal(summary.records[0].newBest,true);
  assert.deepEqual(summary.weeks.slice(-2).map(week=>[week.workouts,week.current]),[[1,false],[1,true]]);
  const nodes=new Map(["progressAdherence","progressVolume","progressConsistency","progressSessions","progressAdherenceDetail","progressVolumeDetail","progressConsistencyDetail","progressSessionsDetail","progressRecordScope","progressRecordList","progressWeeks","progressWeeksMax","progressWeeksNote","progressFirstWorkout","progressHistoryContent"].map(id=>[id,{id,hidden:false,textContent:"",innerHTML:""}]));
  const renderer=Render.createProgressRenderer({element:id=>nodes.get(id),escapeHtml:value=>String(value),exerciseName:id=>id,readableDate:value=>value,days});
  renderer.render({workouts:[],weeklyPlan,historyAvailable:true,hasMore:false,now});
  assert.equal(nodes.get("progressFirstWorkout").hidden,false);assert.equal(nodes.get("progressHistoryContent").hidden,true);
  renderer.render({workouts:[workout],weeklyPlan,historyAvailable:true,hasMore:false,now});
  assert.equal(nodes.get("progressFirstWorkout").hidden,true);assert.equal(nodes.get("progressHistoryContent").hidden,false);assert.equal(nodes.get("progressSessions").textContent,"1");
  assert.equal((nodes.get("progressWeeks").innerHTML.match(/<li class="progress-week/g)||[]).length,8);assert.match(nodes.get("progressWeeks").innerHTML,/This week: 1 workout · 480 kg/);
  assert.equal((nodes.get("progressRecordList").innerHTML.match(/<article class="progress-record/g)||[]).length,1);assert.match(nodes.get("progressRecordList").innerHTML,/First log/);
  renderer.render({workouts:[workout],weeklyPlan,historyAvailable:true,hasMore:true,now});
  assert.equal(nodes.get("progressRecordScope").textContent,"Within your 100 most recent sessions");assert.equal(nodes.get("progressSessions").textContent,"1+");
});

test("Progress week boundaries survive a daylight-saving change",()=>{
  const previous=process.env.TZ;process.env.TZ="America/New_York";
  try{
    const days=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],now=new Date("2026-03-11T12:00:00");
    const workouts=[{id:"before-shift",status:"completed",date:"2026-03-02",startedAt:1,exerciseSummaries:[]},{id:"after-shift",status:"completed",date:"2026-03-10",startedAt:2,exerciseSummaries:[]}];
    assert.equal(Progress.fourWeekConsistency(workouts,days,now),2,"the week before the clock change must not collapse into the current week");
    assert.deepEqual(Progress.weeklyHistory(workouts,days,now).slice(-2).map(week=>week.workouts),[1,1]);
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});

test("Discover catalog keeps community and personal display rules outside the page shell",()=>{
  const state=State.createState();state.aggregate.set("press",{rating_count:2,overall:4.25});
  const catalog=Catalog.createCatalog({state,aggregateFor:id=>state.aggregate.get(id),personalResult:()=>({eligible:true,match:92,reasons:[]})});
  assert.deepEqual(catalog.communitySummary("press"),{count:2,hasRatings:true,score:"8.5",label:"8.5/10 · 2 ratings",attribution:"Rated by 2 Strata+ users"});
  assert.equal(catalog.personalLabel({eligible:true,match:92,reasons:[]}),"92% personal match");
  assert.equal(catalog.personalLabel({eligible:false,match:0,reasons:["equipment"]},{long:true}),"Profile mismatch — equipment");
});

test("Discover detail, community, session, and sharing factories expose focused responsibilities",()=>{
  const state=State.createState();state.preferences={goal:"balanced",level:"Intermediate",days:3};state.weeklyPlan={restDays:["Sunday"],days:{}};
  const detail=Detail.createDetail({state,core:{comparisonRecommendation:()=>({winner:{id:"press"},reason:"Best fit"})}});
  assert.deepEqual(detail.comparisonWinner([{id:"press"}]),{winner:{id:"press"},text:"Best fit"});
  const monthly={normalizeWeeklyPlan:plan=>plan,DAYS:["Monday"]},community=Community.createCommunity({state,monthly});
  assert.equal(community.normalizeCommunityPlan(null),null);
  assert.deepEqual(community.normalizeCommunityPlan({id:" plan ",title:" Week ",plan:{days:{Monday:[]}}}),{id:"plan",title:"Week",description:"",authorName:"STRATA member",createdAt:undefined,updatedAt:undefined,plan:{days:{Monday:[]}}});
  const session=Session.createSession({state,core:{WEEKDAYS:["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],weeklyPulse:()=>({day:"Tuesday"})}});
  assert.equal(session.preferredDay("Tuesday"),"Tuesday");
  state.recommendations=[{exercise:{name:"Press"},result:{match:91}}];
  const sharing=Sharing.createSharing({state,titleCase:value=>value});
  assert.deepEqual(sharing.cardLines("ranking"),{eyebrow:"PERSONALIZED SHORTLIST",title:"balanced selection",score:"91",scoreLabel:"TOP PERSONAL MATCH",lines:["1. Press — 91% match"],footer:"3 days · Intermediate · community ratings separate"});
});

test("share-card text fills its last line before truncating and marks only omitted words",()=>{
  const sharing=Sharing.createSharing({state:{},titleCase:value=>value}),draw=(text,maxLines=2,width=12)=>{const drawn=[],ctx={measureText:value=>({width:[...value].length}),fillText:(value,x,y)=>drawn.push([value,y])};return{end:sharing.wrapCanvasText(ctx,text,0,100,width,10,maxLines),drawn};};
  assert.deepEqual(draw("alpha beta gamma delta"),{end:120,drawn:[["alpha beta",100],["gamma delta",110]]});
  assert.deepEqual(draw("alpha beta gamma delta epsilon").drawn,[["alpha beta",100],["gamma delta…",110]]);
  assert.deepEqual(draw("Supercalifragilistic press").drawn,[["Supercalifr…",100],["press",110]]);
  assert.deepEqual(draw("  one   two  ",3),{end:110,drawn:[["one two",100]]});
  assert.deepEqual(draw(""),{end:110,drawn:[]});
});
