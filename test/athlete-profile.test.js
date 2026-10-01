"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EQUIPMENT,defaultPreferences}=require("../src/plans");
const {composeAthleteProfile,createAthleteProfileSync,preferencesFromCoaching,trainingFromPreferences}=require("../src/athlete-profile");
const {createEventBus}=require("../src/events");

function coachingProfile(overrides={}){
  return {version:4,measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male",goal:"maintenance",goalPace:"moderate",trainingGoal:"strength",experience:"advanced",dailyMovement:"mostly_seated",additionalActivityMinutesPerWeek:0,additionalActivityIntensity:"moderate",workoutDays:["Monday","Wednesday","Friday"],sessionMinutes:60,usualExercises:[],availableEquipment:["Dumbbells"],movementLimitations:["no-overhead"],caloriePattern:"steady",flexibleDay:null,macroPreference:"balanced",mealPreferences:null,timeZone:"UTC",sessionsPerWeek:3,...overrides};
}

test("the two training vocabularies map onto each other without inventing facts",()=>{
  assert.deepEqual(trainingFromPreferences({goal:"time-efficient",level:"Beginner",equipment:["Bodyweight","Dumbbells"],limitations:["no-floor"]}),{trainingGoal:"balanced",experience:"beginner",availableEquipment:EQUIPMENT.filter((item)=>["Bodyweight","Dumbbells"].includes(item)),movementLimitations:["no-floor"]});
  const current={...defaultPreferences(),goal:"time-efficient",preferences:["compound"]};
  const mirrored=preferencesFromCoaching(coachingProfile({trainingGoal:"balanced"}),current);
  assert.equal(mirrored.goal,"time-efficient","a balanced coaching goal keeps the member's finer time-efficient lens");
  assert.equal(mirrored.level,"Advanced");assert.equal(mirrored.days,3);
  assert.deepEqual(mirrored.equipment,["Dumbbells"]);assert.deepEqual(mirrored.limitations,["no-overhead"]);
  assert.deepEqual(mirrored.preferences,["compound"],"exercise preferences belong to the ranking lens only");
  assert.equal(preferencesFromCoaching(coachingProfile({trainingGoal:"hypertrophy"}),current).goal,"hypertrophy");
  assert.deepEqual(preferencesFromCoaching(coachingProfile({availableEquipment:[]}),current).equipment,[...EQUIPMENT],"no coaching equipment restriction means every equipment type");
});

test("the Athlete Profile read model answers from preferences alone or from the coaching profile",()=>{
  const free=composeAthleteProfile({preferences:defaultPreferences(),coachingProfile:null});
  assert.equal(free.training.source,"preferences");assert.equal(free.training.goal,"hypertrophy");assert.equal(free.training.experience,"intermediate");
  assert.equal(free.training.daysPerWeek,4);assert.equal(free.training.workoutDays,null);assert.equal(free.body,null);assert.equal(free.food,null);
  const plus=composeAthleteProfile({preferences:{...defaultPreferences(),preferences:["isolation"]},coachingProfile:{...coachingProfile(),revision:4}});
  assert.equal(plus.training.source,"coaching");assert.equal(plus.training.goal,"strength");assert.deepEqual(plus.training.workoutDays,["Monday","Wednesday","Friday"]);
  assert.equal(plus.training.sessionMinutes,60);assert.deepEqual(plus.training.equipment,["Dumbbells"]);assert.deepEqual(plus.training.exercisePreferences,["isolation"]);
  assert.deepEqual(plus.body,{measurementSystem:"metric",preferredLoadUnit:"kg",age:30,heightCm:180,weightKg:80,bodyFatPercent:null,sexForEquation:"male"});
  assert.equal(plus.energy.goal,"maintenance");assert.equal(plus.coachingRevision,4);assert.equal(plus.timeZone,"UTC");
});

test("saving either record keeps the other in step through the event bus",async()=>{
  const rows={preferences:null,coaching:null},writes=[];
  const store={
    async preferences(){return rows.preferences;},
    async upsertPreferences(userId,json,updatedAt){writes.push(["preferences",userId,updatedAt]);rows.preferences={preferences_json:json,updated_at:updatedAt};return true;},
    async coachingProfile(){return rows.coaching;},
    async upsertCoachingProfile(userId,json,updatedAt,expectedRevision){writes.push(["coaching",userId,expectedRevision]);if(Number(rows.coaching?.revision||0)!==expectedRevision)return null;rows.coaching={profile_json:json,revision:expectedRevision+1,updated_at:updatedAt};return rows.coaching;}
  };
  const bus=createEventBus(),sync=createAthleteProfileSync({store,now:()=>1000});sync.subscribe(bus);
  // No coaching profile yet: a preferences save has nothing to mirror.
  assert.deepEqual(await sync.afterPreferencesSaved({userId:"u1",preferences:defaultPreferences()}),{updated:false,reason:"no-coaching-profile"});
  // The coaching profile arrives: the preferences row is created from it.
  await bus.emit("coaching.profile_saved",{userId:"u1",profile:coachingProfile()});
  const mirrored=JSON.parse(rows.preferences.preferences_json);
  assert.equal(mirrored.level,"Advanced");assert.equal(mirrored.days,3);assert.deepEqual(mirrored.equipment,["Dumbbells"]);assert.deepEqual(mirrored.limitations,["no-overhead"]);
  assert.deepEqual(await sync.afterCoachingProfileSaved({userId:"u1",profile:coachingProfile()}),{updated:false,reason:"unchanged"},"a repeat save writes nothing");
  // The member changes the ranking lens: the coaching profile follows, keeping its own fields.
  rows.coaching={profile_json:JSON.stringify(coachingProfile()),revision:2,updated_at:5};
  await bus.emit("preferences.saved",{userId:"u1",preferences:{...mirrored,goal:"hypertrophy",level:"Beginner",equipment:["Bodyweight"],limitations:[]}});
  const coaching=JSON.parse(rows.coaching.profile_json);
  assert.equal(coaching.trainingGoal,"hypertrophy");assert.equal(coaching.experience,"beginner");assert.deepEqual(coaching.availableEquipment,["Bodyweight"]);assert.deepEqual(coaching.movementLimitations,[]);
  assert.equal(coaching.sessionMinutes,60);assert.equal(coaching.sessionsPerWeek,3);assert.equal(rows.coaching.revision,3,"the mirrored write is a normal revision bump, so stale clients see a conflict instead of a silent overwrite");
  assert.deepEqual(writes.at(-1),["coaching","u1",2]);
  assert.deepEqual(await sync.afterPreferencesSaved({userId:"u1",preferences:{...mirrored,goal:"hypertrophy",level:"Beginner",equipment:["Bodyweight"],limitations:[]}}),{updated:false,reason:"unchanged"});
  const profile=await sync.read("u1",{...coaching,revision:3});
  assert.equal(profile.training.source,"coaching");assert.equal(profile.training.experience,"beginner");assert.deepEqual(profile.training.equipment,["Bodyweight"]);
});
