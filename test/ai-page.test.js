"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const logic=require("../public/scripts/ai-logic");
const store=require("../public/scripts/ai-state");
const {createClient}=require("../public/scripts/ai-api");

const week={title:"Three full-body days",focus:"hypertrophy",sessionMinutes:45,trainingDays:["Monday","Wednesday","Friday"],restDays:["Tuesday","Thursday","Saturday","Sunday"],workingSets:27,
  days:[{day:"Monday",name:"Full body A",exercises:[{name:"Hack Squat",sets:3,reps:"6–12"},{name:"Flat Dumbbell Press",sets:3,reps:"8–12"}]}]};
const assistant=(id,result)=>({id,role:"assistant",result:{reply:"Here you go.",...result}});

function memoryStorage(){
  const data=new Map();
  return {get length(){return data.size;},key:(index)=>[...data.keys()][index]??null,getItem:(key)=>data.has(key)?data.get(key):null,setItem:(key,value)=>data.set(key,String(value)),removeItem:(key)=>data.delete(key)};
}

test("messages are checked before they are sent",()=>{
  assert.match(logic.messageError("   "),/Write what you would like/);
  assert.match(logic.messageError("x".repeat(1201)),/under 1,200 characters/);
  assert.equal(logic.messageError("Plan my week"),"");
});

test("history sent to the server alternates turns and describes proposed weeks by name",()=>{
  const history=logic.historyFor([
    assistant("a0",{}),{id:"u1",role:"user",text:"Plan a week"},assistant("a1",{week}),{id:"e1",role:"error",error:{message:"x"}},
    {id:"u2",role:"user",text:"first try"},{id:"u3",role:"user",text:"Make Monday shorter"},assistant("a2",{reply:"Done."}),{id:"u4",role:"user",text:"pending question"}
  ]);
  assert.deepEqual(history.map((turn)=>turn.role),["user","assistant","user","assistant"]);
  assert.match(history[1].content,/^Here you go\. Proposed week "Three full-body days" \(45 min\)\. Monday Full body A: Hack Squat 3x6–12, Flat Dumbbell Press 3x8–12\. Rest: Tuesday, Thursday, Saturday, Sunday\.$/);
  assert.equal(history[2].content,"Make Monday shorter","the latest of consecutive member turns is kept");
  const many=Array.from({length:20},(_,index)=>index%2?assistant(`a${index}`,{reply:"x".repeat(2000)}):{id:`u${index}`,role:"user",text:"y".repeat(2000)});
  const trimmed=logic.historyFor(many);
  assert.equal(trimmed.length,12);assert.ok(trimmed.every((turn)=>turn.content.length<=1200));
  assert.deepEqual(logic.historyFor(null),[]);assert.equal(logic.describeWeek(null),"");
});

test("proposals are described in plain words",()=>{
  assert.equal(logic.weekStats(week),"3 training days · about 45 min each · 27 working sets");
  assert.equal(logic.weekStats({trainingDays:["Monday"],sessionMinutes:30,workingSets:1}),"1 training day · about 30 min each · 1 working set");
  assert.equal(logic.focusLabel("hypertrophy"),"Muscle growth");assert.equal(logic.focusLabel("unknown"),"Balanced");
  assert.deepEqual(logic.nutritionLines({goal:"fat_loss",goalPace:"gentle",caloriePattern:"zigzag",macroPreference:"higher_protein"}),["Fat loss, gentle pace","Higher on training days","Higher protein"]);
  assert.deepEqual(logic.nutritionLines({goal:"maintenance",caloriePattern:"flexible_day",flexibleDay:"Sunday",macroPreference:null}),["Maintenance","One flexible day (Sunday)","Calories only"]);
  assert.deepEqual(logic.nutritionLines(null),[]);assert.equal(logic.patternLabel({}),"Same target every day");
  assert.equal(logic.alignmentText({alignment:{workoutDays:["Tuesday","Thursday","Saturday"],sessionMinutes:45},basedOn:"proposed"}),"Your personal setup will change to Tue, Thu and Sat with 45-minute sessions, so the targets match this week.");
  assert.match(logic.alignmentText({alignment:{workoutDays:["Monday"],sessionMinutes:30}}),/to Mon with 30-minute sessions, so the targets match your saved plan\./);
  assert.equal(logic.alignmentText({alignment:null}),"");
  assert.deepEqual(logic.dailyTargets({dailyTargets:[{day:"Monday",calories:2350.4,kind:"higher_training_day",macros:{proteinG:160}},{day:"Tuesday",calories:2100,kind:"lower_rest_day",macros:null}]}),[{day:"Mon",calories:"2,350",protein:"160 g protein",training:true},{day:"Tue",calories:"2,100",protein:"",training:false}]);
  assert.deepEqual(logic.dailyTargets(undefined),[]);
});

test("quick replies follow only the latest proposed week",()=>{
  const message=assistant("a1",{week});
  assert.deepEqual(logic.followUps(message,{latest:true}).map((item)=>item.label),["Add matching calorie targets","Make sessions shorter"]);
  assert.deepEqual(logic.followUps(message),[]);
  assert.deepEqual(logic.followUps(assistant("a2",{week,nutrition:{changes:{}}}),{latest:true}).map((item)=>item.index),[1],"a week that already has targets does not offer them again");
  assert.deepEqual(logic.followUps(assistant("a3",{}),{latest:true}),[]);
  assert.match(logic.FOLLOW_UPS[0].message,/calorie targets/);
});

test("a swap replaces exactly one planned exercise, or nothing when the plan has changed",()=>{
  const plan={version:1,restDay:"Sunday",restDays:["Sunday"],days:{Monday:[{instanceId:"i1",exerciseId:"flat-dumbbell-press",sets:4,reps:"8–12"},{instanceId:"i2",exerciseId:"hack-squat",sets:3,reps:"6–12"}],Tuesday:[]}};
  const action={type:"swap",day:"Monday",instanceId:"i1",fromExerciseId:"flat-dumbbell-press",toExerciseId:"incline-machine-chest-press",toReps:"6–12"};
  const swapped=logic.swapPlan(plan,action);
  assert.deepEqual(swapped.days.Monday[0],{instanceId:"i1",exerciseId:"incline-machine-chest-press",sets:4,reps:"6–12"});
  assert.equal(swapped.days.Monday[1],plan.days.Monday[1]);assert.equal(plan.days.Monday[0].exerciseId,"flat-dumbbell-press","the saved copy is not mutated");
  assert.equal(logic.swapPlan(plan,{...action,instanceId:"gone"}),null);
  assert.equal(logic.swapPlan(plan,{...action,fromExerciseId:"hack-squat"}),null);
  assert.equal(logic.swapPlan(plan,{...action,toExerciseId:"hack-squat"}),null,"never duplicates an exercise on a day");
  assert.equal(logic.swapPlan(plan,{...action,day:"Funday"}),null);assert.equal(logic.swapPlan(null,action),null);
  assert.equal(logic.swapPlan(plan,{...action,toReps:""}).days.Monday[0].reps,"8–12");
  assert.equal(logic.planExerciseCount(plan),2);assert.equal(logic.planExerciseCount(null),0);
});

test("status, waiting, and error states read clearly",()=>{
  assert.equal(logic.statusView(null).tone,"checking");
  assert.deepEqual(logic.statusView({configured:false}),{tone:"offline",title:"Strata AI isn’t switched on yet",detail:"Your plan and nutrition tools work as usual. Check back soon.",canAsk:false});
  assert.equal(logic.statusView({configured:true,online:true,remainingToday:0,dailyLimit:30}).canAsk,false);
  assert.deepEqual(logic.statusView({configured:true,online:true,remainingToday:27,dailyLimit:30}),{tone:"online",title:"Strata AI is ready",detail:"27 of 30 requests left today",canAsk:true});
  const offline=logic.statusView({configured:true,online:false,remainingToday:5,dailyLimit:30});assert.equal(offline.tone,"offline");assert.equal(offline.canAsk,true);
  assert.equal(logic.pendingText({status:"queued",position:1}),"You’re next in line…");assert.equal(logic.pendingText({status:"queued",position:3}),"You’re number 3 in line…");
  assert.equal(logic.pendingText({status:"running"},1000),"Strata AI is planning…");assert.match(logic.pendingText({status:"running"},60000),/Still working/);
  assert.deepEqual(logic.errorView({code:"AI_OFFLINE",message:"Offline."}),{code:"AI_OFFLINE",message:"Offline.",retry:true});
  assert.equal(logic.errorView({code:"AI_DAILY_LIMIT",message:"Limit."}).retry,false);assert.match(logic.errorView(null).message,/could not finish/);
  assert.deepEqual([0,19999,20000,59999,60000].map(logic.pollDelay),[1500,1500,2500,2500,4000]);
  assert.match(logic.newId(),/^m[a-z0-9]+$/);assert.equal(logic.STARTERS.length,4);
});

test("a saved conversation is checked before it is restored",()=>{
  assert.deepEqual(logic.restoreConversation(null),{messages:[],pending:null});
  assert.deepEqual(logic.restoreConversation({messages:"nope"}),{messages:[],pending:null});
  const id="0f8fad5b-d9cb-469f-a165-70867728950e";
  const restored=logic.restoreConversation({messages:[{id:"u1",role:"user",text:"hi"},{id:"x",role:"system"},{role:"user"},null,...Array.from({length:45},(_,index)=>({id:`m${index}`,role:"assistant",result:{reply:"r"}}))],pending:{id,kind:"chat",startedAt:5,retry:{kind:"chat",message:"hi"}}});
  assert.equal(restored.messages.length,40);assert.equal(restored.messages.at(-1).id,"m44");
  assert.deepEqual(restored.pending,{id,kind:"chat",startedAt:5,retry:{kind:"chat",message:"hi"}});
  assert.equal(logic.restoreConversation({messages:[],pending:{id:"bad",kind:"chat"}}).pending,null);
  assert.equal(logic.restoreConversation({messages:[],pending:{id,kind:"chat",retry:{message:""}}}).pending.retry,null);
  assert.equal(logic.restoreConversation({messages:[],pending:{id,kind:"suggestions",retry:{message:""}}}).pending.retry.kind,"suggestions");
});

test("conversations are stored per account in this tab and forgotten on sign-out",()=>{
  const storage=memoryStorage();
  assert.deepEqual(store.createState().messages,[]);
  assert.equal(store.save(storage,"user-1",{messages:[{id:"a"}]}),true);store.save(storage,"user-2",{messages:[]});storage.setItem("other","keep");
  assert.deepEqual(store.load(storage,"user-1"),{messages:[{id:"a"}]});assert.equal(store.load(storage,"user-3"),null);
  store.clear(storage,"user-2");assert.equal(store.load(storage,"user-2"),null);
  store.save(storage,"user-2",{messages:[]});store.clearAll(storage,{except:"user-2"});
  assert.equal(store.load(storage,"user-1"),null,"another account's conversation is removed");assert.deepEqual(store.load(storage,"user-2"),{messages:[]});
  store.clearAll(storage);
  assert.equal(store.load(storage,"user-1"),null);assert.equal(store.load(storage,"user-2"),null);assert.equal(storage.getItem("other"),"keep");
  storage.setItem("strata-ai-conversation:broken","{");assert.equal(store.load(storage,"broken"),null);
  const failing={getItem(){throw new Error("blocked");},setItem(){throw new Error("full");},removeItem(){throw new Error("blocked");},get length(){throw new Error("blocked");}};
  assert.equal(store.load(failing,"u"),null);assert.equal(store.save(failing,"u",{}),false);assert.doesNotThrow(()=>store.clear(failing,"u"));assert.doesNotThrow(()=>store.clearAll(failing));
  assert.equal(store.load(null,"u"),null);
});

test("the page's requests carry the account and security token and report failures",async()=>{
  const calls=[];let reply={status:200,body:{ok:true}};
  const client=createClient({fetchImpl:async(url,init)=>{calls.push({url,init});if(reply instanceof Error)throw reply;return new Response(reply.body===undefined?"":JSON.stringify(reply.body),{status:reply.status});},getCsrfToken:()=>"csrf-1",getUserId:()=>"user-9"});
  await client.ask({kind:"chat",message:"Plan",history:[]});
  assert.equal(calls[0].url,"/api/ai/requests");assert.equal(calls[0].init.method,"POST");
  assert.equal(calls[0].init.headers["X-CSRF-Token"],"csrf-1");assert.equal(calls[0].init.headers["X-Strata-User"],"user-9");assert.equal(calls[0].init.credentials,"same-origin");
  assert.deepEqual(JSON.parse(calls[0].init.body),{kind:"chat",message:"Plan",history:[],expectedUserId:"user-9"});
  await client.ask({kind:"suggestions",message:"ignored",history:[]});assert.equal(JSON.parse(calls[1].init.body).message,undefined);
  await client.poll("abc/def");assert.equal(calls[2].url,"/api/ai/requests/abc%2Fdef");assert.equal(calls[2].init.headers["X-CSRF-Token"],undefined,"reads carry no token");
  await client.savePlan({plan:{days:{}},expectedPlanUpdatedAt:5});assert.deepEqual(JSON.parse(calls[3].init.body),{plan:{days:{}},expectedPlanUpdatedAt:5,expectedUserId:"user-9"});assert.equal(calls[3].init.method,"PUT");
  await client.saveProfile({profile:{goal:"fat_loss"},expectedRevision:2});assert.equal(calls[4].url,"/api/coaching/profile");
  for(const read of ["me","status","plan"])await client[read]();
  await client.logout();assert.equal(calls.at(-1).url,"/api/logout");assert.equal(calls.at(-1).init.method,"POST");
  reply={status:409,body:{error:"Plan changed.",code:"PLAN_CHANGED",plan:{}}};
  await assert.rejects(client.plan(),(error)=>error.status===409&&error.code==="PLAN_CHANGED"&&error.message==="Plan changed."&&Boolean(error.payload.plan));
  reply={status:502};await assert.rejects(client.status(),{code:"REQUEST_FAILED",status:502});
  reply={status:200};await assert.rejects(client.status(),{code:"INVALID_RESPONSE"});
  reply=new TypeError("offline");await assert.rejects(client.me(),{code:"NETWORK_ERROR"});
  assert.throws(()=>createClient({fetchImpl:null}),TypeError);
  const anonymous=createClient({fetchImpl:async(url,init)=>{calls.push({url,init});return new Response("{}",{status:200});}});
  await anonymous.logout();assert.equal(calls.at(-1).init.headers["X-Strata-User"],undefined);
});
