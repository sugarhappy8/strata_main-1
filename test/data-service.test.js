"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {createEventBus}=require("../src/events");
const {createDataService}=require("../src/data-service");

const NOW=Date.parse("2026-10-01T12:00:00Z");
function summary(id,date,status,exercises){return {summary_json:JSON.stringify({id,date,status,exerciseSummaries:exercises})};}
function fakeStore(overrides={}){
  const calls=[];
  return {calls,
    preferences:async()=>({preferences_json:JSON.stringify({version:1,goal:"strength",level:"Intermediate"})}),
    ratingsForUser:async()=>[{exercise_id:"barbell-back-squat",overall:5,updated_at:7}],
    workouts:async()=>[
      summary("w3","2026-09-30","completed",[{exerciseId:"barbell-back-squat",completedSets:4},{exerciseId:"flat-dumbbell-press",completedSets:0}]),
      summary("w2","2026-09-23","completed",[{exerciseId:"barbell-back-squat",completedSets:3},{exerciseId:"barbell-bent-over-row",completedSets:3}]),
      summary("w1","2026-07-01","completed",[{exerciseId:"pec-deck-fly",completedSets:3}]),
      summary("w0","2026-09-29","active",[{exerciseId:"pec-deck-fly",completedSets:2}]),
      {summary_json:"{"}
    ],
    insertPlanChange:async(...args)=>{calls.push(["insertPlanChange",...args]);},
    deleteTrainingLinksForProvider:async(...args)=>{calls.push(["deleteTrainingLinksForProvider",...args]);},
    deleteUserDailySnapshots:async(...args)=>{calls.push(["deleteUserDailySnapshots",...args]);},
    planChanges:async()=>[],
    ...overrides};
}
function service(store,events=createEventBus()){return createDataService({store,events,getPlan:async()=>null,coachingProfile:async()=>null,requireSession:async()=>null,requireFeature:()=>async()=>null,http:{json(){}},now:()=>NOW});}

test("Rankings Signals report the lens, ratings, and exercises actually trained in the last eight weeks",async()=>{
  const signals=await service(fakeStore()).rankingsSignals("member");
  assert.equal(signals.lens.goal,"strength");assert.deepEqual(signals.ratings,[{exerciseId:"barbell-back-squat",overall:5,updatedAt:7}]);
  assert.deepEqual(signals.trained,[
    {exerciseId:"barbell-back-squat",sessions:2,completedSets:7,lastDate:"2026-09-30"},
    {exerciseId:"barbell-bent-over-row",sessions:1,completedSets:3,lastDate:"2026-09-23"}
  ],"old, unfinished, unreadable, and zero-set work is left out");
  assert.equal(signals.windowDays,56);
});

test("plan saves record their source, and Polar deletion removes derived rows",async()=>{
  const store=fakeStore(),events=createEventBus();service(store,events);
  await events.emit("plan.updated",{userId:"member",updatedAt:42,source:"ai",detail:"ai-proposal"});
  await events.emit("plan.updated",{userId:"member",updatedAt:43,source:"hacked",detail:"x".repeat(80)});
  await events.emit("plan.updated",{userId:"member",updatedAt:0,source:"manual"});
  await events.emit("polar.data_deleted",{userId:"member",provider:"polar"});
  assert.deepEqual(store.calls,[
    ["insertPlanChange","member",{planUpdatedAt:42,source:"ai",detail:"ai-proposal",createdAt:NOW}],
    ["insertPlanChange","member",{planUpdatedAt:43,source:"manual",detail:"x".repeat(40),createdAt:NOW}],
    ["deleteTrainingLinksForProvider","member","polar"],
    ["deleteUserDailySnapshots","member"]
  ]);
});
