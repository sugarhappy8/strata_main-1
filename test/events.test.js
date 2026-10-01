"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EVENT_NAMES,createEventBus}=require("../src/events");

test("the event bus awaits handlers in order, isolates failures, and rejects unknown names",async()=>{
  const logged=[],bus=createEventBus({logger:{error:(name,detail)=>logged.push([name,detail.event])}});
  const seen=[];
  bus.on("plan.updated",async(payload)=>{await new Promise((resolve)=>setTimeout(resolve,5));seen.push(["first",payload.userId,payload.event]);});
  bus.on("plan.updated",()=>{throw new Error("boom");});
  const off=bus.on("plan.updated",(payload)=>seen.push(["third",payload.userId]));
  assert.equal(await bus.emit("plan.updated",{userId:"u1"}),2,"two handlers delivered, one failed");
  assert.deepEqual(seen,[["first","u1","plan.updated"],["third","u1"]]);
  assert.deepEqual(logged,[["event.handler_failed","plan.updated"]]);
  off();
  assert.equal(await bus.emit("plan.updated",{userId:"u2"}),1);
  assert.equal(await bus.emit("workout.saved",{}),0,"an event nobody listens to is still fine");
  assert.throws(()=>bus.on("made.up",()=>{}),/Unknown event/);
  await assert.rejects(()=>bus.emit("made.up"),/Unknown event/);
  assert.throws(()=>bus.on("plan.updated","nope"),TypeError);
  assert.deepEqual([...EVENT_NAMES],["plan.updated","workout.saved","workout.completed","preferences.saved","coaching.profile_saved","coaching.log_saved","polar.sync.finished","polar.data_deleted","snapshot.ready"]);
  assert.ok(Object.isFrozen(bus));
});
