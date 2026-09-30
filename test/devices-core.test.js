"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {randomBytes}=require("node:crypto");
const {POLAR_DEFAULTS,devicesSettings,keyId,tokenKey}=require("../src/devices-config");
const {open,randomId,sameSecret,seal,sha256}=require("../src/devices-crypto");
const {dateKey,dayFromHeartRate,daysFromHeartRate,isoDurationSeconds,nightsFromPolar,numberIn,sportLabel,workoutFromExercise,workoutsFromExercises}=require("../src/polar-mapping");
const {LEARNING_NIGHTS,addDays,chargeLabel,daysBetween,lighterSessionAdvice,recoveryLabel,stressSignals,todaySummary,trendSummary,usualRange}=require("../src/wellness-core");

const KEY=randomBytes(32).toString("base64"),OLD_KEY=randomBytes(32).toString("base64url");
const configured={POLAR_CLIENT_ID:"client",POLAR_CLIENT_SECRET:"secret",DEVICE_TOKEN_KEY:KEY};

test("connected devices stay off until Polar credentials and a 32-byte token key exist",()=>{
  const empty=devicesSettings({});
  assert.equal(empty.configured,false);assert.equal(empty.problems.length,2);assert.deepEqual(empty.keys,[]);
  assert.equal(empty.polar.authorizeUrl,POLAR_DEFAULTS.authorizeUrl);assert.equal(empty.polar.tokenUrl,POLAR_DEFAULTS.tokenUrl);assert.equal(empty.polar.apiBase,POLAR_DEFAULTS.apiBase);
  assert.equal(empty.polar.redirectUri,"");assert.equal(empty.secureCookies,false);assert.equal(empty.syncIntervalMs,60000);

  const ready=devicesSettings({...configured,APP_BASE_URL:"https://strata.example/"});
  assert.equal(ready.configured,true);assert.deepEqual(ready.problems,[]);assert.equal(ready.keys.length,1);assert.equal(ready.keys[0].id,keyId(tokenKey(KEY)));
  assert.equal(ready.polar.redirectUri,"https://strata.example/api/devices/polar/callback");assert.equal("webhookSecret" in ready.polar,false);

  const rotated=devicesSettings({...configured,DEVICE_TOKEN_KEY_PREVIOUS:OLD_KEY,POLAR_REDIRECT_URI:"https://strata.example/custom"});
  assert.equal(rotated.keys.length,2);assert.notEqual(rotated.keys[0].id,rotated.keys[1].id);assert.equal(rotated.polar.redirectUri,"https://strata.example/custom");

  assert.equal(devicesSettings({...configured,DEVICE_TOKEN_KEY:"too-short"}).configured,false);
  assert.equal(tokenKey("A".repeat(43)).length,32);assert.equal(tokenKey("A".repeat(44)),null);assert.match(keyId(tokenKey(KEY)),/^[0-9a-f]{8}$/);
});

test("Polar addresses must use https, and plain http only reaches this machine outside production",()=>{
  const local=devicesSettings({...configured,POLAR_AUTH_URL:"http://127.0.0.1:9000/authorize",POLAR_TOKEN_URL:"http://localhost:9000/token",POLAR_API_URL:"http://127.0.0.1:9000/"});
  assert.equal(local.configured,true);assert.equal(local.polar.apiBase,"http://127.0.0.1:9000");
  const remote=devicesSettings({...configured,POLAR_API_URL:"http://polar.example"});
  assert.equal(remote.configured,false);assert.match(remote.problems.join(" "),/https/);
  const production=devicesSettings({...configured,NODE_ENV:"production",POLAR_API_URL:"http://127.0.0.1:9000",APP_BASE_URL:"http://strata.example"});
  assert.equal(production.configured,false);assert.equal(production.problems.length,2);assert.equal(production.secureCookies,true);
  const secure=devicesSettings({...configured,NODE_ENV:"production",APP_BASE_URL:"https://strata.example"});
  assert.equal(secure.configured,true);
  assert.equal(devicesSettings({SECURE_COOKIES:"true"}).secureCookies,true);
  assert.equal(devicesSettings({DEVICE_SYNC_INTERVAL_MS:"5"}).syncIntervalMs,200);assert.equal(devicesSettings({DEVICE_SYNC_INTERVAL_MS:"99999999"}).syncIntervalMs,3600000);
});

test("device tokens are sealed with AES-256-GCM, bound to their key, and survive key rotation",()=>{
  const current={id:keyId(tokenKey(KEY)),key:tokenKey(KEY)},previous={id:keyId(tokenKey(OLD_KEY)),key:tokenKey(OLD_KEY)};
  const sealed=seal([current],"polar-token"),again=seal([current],"polar-token");
  assert.match(sealed,new RegExp(`^v1\\.${current.id}\\.`));assert.notEqual(sealed,again,"every seal uses a fresh nonce");assert.equal(sealed.includes("polar-token"),false);
  assert.equal(open([current],sealed),"polar-token");
  const legacy=seal([previous],"older-token");
  assert.equal(open([current,previous],legacy),"older-token","a rotated key still opens tokens it sealed");
  assert.throws(()=>open([current],legacy),(error)=>error.code==="DEVICE_KEY_MISSING");
  const parts=sealed.split("."),body=Buffer.from(parts[3],"base64url");body[0]^=1;
  assert.throws(()=>open([current],[...parts.slice(0,3),body.toString("base64url"),parts[4]].join(".")),(error)=>error.code==="DEVICE_TOKEN_UNREADABLE");
  assert.throws(()=>open([current],[...parts.slice(0,4),parts[4].slice(0,6)].join(".")),(error)=>error.code==="DEVICE_TOKEN_UNREADABLE","a shortened tag is refused");
  assert.throws(()=>open([{...current,id:previous.id}],sealed.replace(current.id,previous.id)),(error)=>error.code==="DEVICE_TOKEN_UNREADABLE","the key id is authenticated");
  for(const malformed of ["","v2.a.b.c.d","v1.a.b.c","v1.a.b.c.d.e"])assert.throws(()=>open([current],malformed),(error)=>error.code==="DEVICE_TOKEN_UNREADABLE");
  assert.throws(()=>seal([],"token"),(error)=>error.code==="DEVICE_KEY_MISSING");
  assert.equal(sameSecret("abc","abc"),true);assert.equal(sameSecret("abc","abd"),false);assert.equal(sameSecret("abc","abcd"),false);
  assert.match(randomId(),/^[A-Za-z0-9_-]{43}$/);assert.equal(randomId(16).length,22);assert.match(sha256("x"),/^[0-9a-f]{64}$/);
});

test("Polar sleep and Nightly Recharge merge into one night per date with every value range-checked",()=>{
  const nights=nightsFromPolar({nights:[
    {date:"2026-09-28",light_sleep:14400,deep_sleep:3600,rem_sleep:5400,unrecognized_sleep_stage:600,sleep_score:82.34,sleep_charge:4,sleep_start_time:"2026-09-27T23:10:00+03:00",sleep_end_time:"2026-09-28T06:40:00+03:00",total_interruption_duration:1200},
    {date:"2026-02-30",light_sleep:1000},{date:"2026-09-26",sleep_score:140,sleep_start_time:"x".repeat(50)}
  ]},{recharges:[
    {date:"2026-09-28",nightly_recharge_status:5,ans_charge:3.44,ans_charge_status:4,heart_rate_avg:52,heart_rate_variability_avg:61,breathing_rate_avg:14.2},
    {date:"2026-09-27",nightly_recharge_status:9,ans_charge:-12,heart_rate_avg:"55.26",heart_rate_variability_avg:0,breathing_rate_avg:null}
  ]},1234);
  assert.deepEqual(nights.map((night)=>night.nightDate),["2026-09-26","2026-09-27","2026-09-28"]);
  const [ignored,partial,full]=nights;
  assert.equal(ignored.sleepScore,null);assert.equal(ignored.sleepStart,null);assert.equal(ignored.asleepSeconds,null);
  assert.equal(partial.recoveryStatus,null);assert.equal(partial.ansCharge,null);assert.equal(partial.heartRateAvg,55.3);assert.equal(partial.hrvAvg,null);assert.equal(partial.sleepScore,null);
  assert.deepEqual({...full},{nightDate:"2026-09-28",recoveryStatus:5,ansCharge:3.4,ansChargeStatus:4,sleepCharge:4,heartRateAvg:52,hrvAvg:61,breathingRateAvg:14.2,sleepScore:82.3,
    sleepStart:"2026-09-27T23:10:00+03:00",sleepEnd:"2026-09-28T06:40:00+03:00",asleepSeconds:24000,lightSeconds:14400,deepSeconds:3600,remSeconds:5400,interruptionSeconds:1200,updatedAt:1234});
  assert.equal(nightsFromPolar([{date:"2026-09-01",deep_sleep:60}],null,1)[0].asleepSeconds,60,"a bare array is read as the list");
  assert.deepEqual(nightsFromPolar(null,{recharges:"nope"},1),[]);
  assert.equal(dateKey("2026-09-31"),null);assert.equal(dateKey("2026-09-30"),"2026-09-30");assert.equal(numberIn("",0,1),null);assert.equal(numberIn(1.26,0,2),1.3);
});

test("Polar V4 sleep and Nightly Recharge fields map to STRATA night metrics",()=>{
  const nights=nightsFromPolar({nightSleeps:[{
    sleepDate:"2026-09-28",
    sleepResult:{hypnogram:{sleepStart:"2026-09-27T23:10:00+03:00",sleepEnd:"2026-09-28T06:40:00+03:00"}},
    sleepScore:{sleepScore:82.34,scoreRate:4},
    sleepEvaluation:{asleepDuration:"24000.4s",interruptions:{totalDuration:"1200s"},phaseDurations:{light:"14400s",deep:"3600s",rem:"5400s",unknown:"600s"}}
  }]},{nightlyRechargeResults:{nightlyRechargeResults:[{
    sleepResultDate:"2026-09-28",recoveryIndicator:5,ansStatus:13.44,ansRate:4,
    meanNightlyRecoveryRri:1154,meanNightlyRecoveryRmssd:61,meanNightlyRecoveryRespirationInterval:4286
  }]}},1234);
  assert.deepEqual(nights,[{nightDate:"2026-09-28",recoveryStatus:5,ansCharge:13.4,ansChargeStatus:4,sleepCharge:4,heartRateAvg:52,hrvAvg:61,breathingRateAvg:14,sleepScore:82.3,
    sleepStart:"2026-09-27T23:10:00+03:00",sleepEnd:"2026-09-28T06:40:00+03:00",asleepSeconds:24000,lightSeconds:14400,deepSeconds:3600,remSeconds:5400,interruptionSeconds:1200,updatedAt:1234}]);
  const invalid=nightsFromPolar({nightSleeps:[{sleepDate:"2026-09-29",sleepEvaluation:{asleepDuration:"one hour",phaseDurations:{light:"86401s"}}}]},
    {nightlyRechargeResults:{nightlyRechargeResults:[{sleepResultDate:"2026-09-29",meanNightlyRecoveryRri:0,meanNightlyRecoveryRespirationInterval:-1}]}},1)[0];
  assert.equal(invalid.asleepSeconds,null);assert.equal(invalid.lightSeconds,null);assert.equal(invalid.heartRateAvg,null);assert.equal(invalid.breathingRateAvg,null);
});

test("24/7 heart rate becomes a daily range, half-hour averages, and a settled resting estimate",()=>{
  const day=dayFromHeartRate("2026-09-28",{heart_rate_samples:[
    {heart_rate:50,sample_time:"03:00:00"},{heart_rate:52,sample_time:"03:10:00"},{heart_rate:54,sample_time:"03:20"},
    {heart_rate:120,sample_time:"12:00:00"},{heart_rate:300,sample_time:"13:00:00"},{heart_rate:60,sample_time:"25:00:00"},{heart_rate:60,sample_time:"noon"}
  ]},99);
  assert.equal(day.restingHr,52);assert.equal(day.minHr,50);assert.equal(day.maxHr,120);assert.equal(day.avgHr,69);assert.equal(day.samples,4);assert.equal(day.updatedAt,99);
  const buckets=JSON.parse(day.bucketsJson);assert.equal(buckets.length,48);assert.equal(buckets[6],52);assert.equal(buckets[24],120);assert.equal(buckets[0],null);
  assert.equal(dayFromHeartRate("2026-09-28",{heart_rate_samples:[{heart_rate:120,sample_time:"12:00"}]},1).restingHr,null,"one sample is not a resting estimate");
  assert.equal(dayFromHeartRate("2026-09-28",{heart_rate_samples:[]},1),null);assert.equal(dayFromHeartRate("not-a-date",{heart_rate_samples:[{heart_rate:60,sample_time:"01:00"}]},1),null);
  assert.equal(dayFromHeartRate("2026-09-28",null,1),null);
});

test("Polar V4 continuous samples become sorted daily summaries from one range response",()=>{
  const payload={continuousSamples:{heartRateSamplesPerDay:[
    {date:"2026-09-29",samples:[{heartRate:60,offsetMillis:43200000}]},
    {date:"2026-09-28",samples:[{heartRate:50,offsetMillis:10800000},{heartRate:52,offsetMillis:11400000},{heartRate:54,offsetMillis:12000000},{heartRate:120,offsetMillis:43200000},{heartRate:300,offsetMillis:46800000},{heartRate:80,offsetMillis:86400000}]},
    {date:"not-a-date",samples:[{heartRate:70,offsetMillis:0}]}
  ]}};
  const days=daysFromHeartRate(payload,99);
  assert.deepEqual(days.map((day)=>day.dayDate),["2026-09-28","2026-09-29"]);
  assert.deepEqual({restingHr:days[0].restingHr,minHr:days[0].minHr,avgHr:days[0].avgHr,maxHr:days[0].maxHr,samples:days[0].samples,updatedAt:days[0].updatedAt},
    {restingHr:52,minHr:50,avgHr:69,maxHr:120,samples:4,updatedAt:99});
  assert.equal(JSON.parse(days[0].bucketsJson)[6],52);assert.equal(JSON.parse(days[0].bucketsJson)[24],120);
  assert.equal(days[1].restingHr,null);assert.equal(days[1].avgHr,60);
  assert.deepEqual(daysFromHeartRate({continuousSamples:{heartRateSamplesPerDay:[]}},1),[]);
});

test("Polar exercises become device workouts with UTC start times, durations, and readable sports",()=>{
  const local=workoutFromExercise({id:"abc123",start_time:"2026-09-28T07:30:00",start_time_utc_offset:180,duration:"PT45M",detailed_sport_info:"RUNNING",calories:420,heart_rate:{average:140,maximum:171},training_load:88.44},5);
  assert.deepEqual({...local},{externalId:"abc123",startedAt:Date.parse("2026-09-28T04:30:00Z"),localDate:"2026-09-28",durationSeconds:2700,sport:"Running",calories:420,hrAvg:140,hrMax:171,cardioLoad:88.4,updatedAt:5});
  const zoned=workoutFromExercise({id:"z1",start_time:"2026-09-28T07:30:00+03:00",duration:"PT1H2M3.5S",sport:"OTHER_INDOOR"},5);
  assert.equal(zoned.startedAt,Date.parse("2026-09-28T04:30:00Z"));assert.equal(zoned.durationSeconds,3724);assert.equal(zoned.sport,"Other indoor");assert.equal(zoned.calories,null);assert.equal(zoned.cardioLoad,null);
  assert.equal(workoutFromExercise({id:"far",start_time:"2026-09-28T07:30:00",start_time_utc_offset:9999,duration:"PT1M"},1).startedAt,Date.parse("2026-09-28T07:30:00Z"),"an impossible offset is ignored");
  for(const bad of [{id:"../x",start_time:"2026-09-28T07:30:00",duration:"PT1M"},{id:"a",start_time:"yesterday",duration:"PT1M"},{id:"a",start_time:"2026-09-28T07:30:00",duration:"P1D"},{id:"a",start_time:"2026-02-30T07:30:00",duration:"PT1M"},null])assert.equal(workoutFromExercise(bad,1),null);
  assert.equal(workoutsFromExercises([{id:"a",start_time:"2026-09-28T07:30:00Z",duration:"PT10S"},{id:"bad"}],1).length,1);assert.deepEqual(workoutsFromExercises({},1),[]);
  assert.equal(isoDurationSeconds("PT"),null);assert.equal(isoDurationSeconds("PT50H"),null);assert.equal(isoDurationSeconds("PT30S"),30);
  assert.equal(sportLabel(""),"Workout");assert.equal(sportLabel("STRENGTH_TRAINING"),"Strength training");
});

test("Polar V4 training sessions become device workouts",()=>{
  const sessions={trainingSessions:[
    {identifier:{id:"ca78db47-1755-5555-5555-555555555555"},startTime:"2026-09-28T07:30:00",timezoneOffsetMinutes:180,durationMillis:2700500,name:"Morning Run",calories:420,hrAvg:140,hrMax:171,trainingLoad:88},
    {identifier:{id:"z1"},startTime:"2026-09-28T07:30:00+03:00",durationMillis:3723500,sport:{id:"22353647432"}},
    {identifier:{id:"bad"},startTime:"yesterday",durationMillis:1000},
    {identifier:{id:"too-long"},startTime:"2026-09-28T07:30:00Z",durationMillis:172800001}
  ]};
  const workouts=workoutsFromExercises(sessions,5);
  assert.deepEqual(workouts[0],{externalId:"ca78db47-1755-5555-5555-555555555555",startedAt:Date.parse("2026-09-28T04:30:00Z"),localDate:"2026-09-28",durationSeconds:2701,sport:"Morning run",calories:420,hrAvg:140,hrMax:171,cardioLoad:88,updatedAt:5});
  assert.equal(workouts[1].startedAt,Date.parse("2026-09-28T04:30:00Z"));assert.equal(workouts[1].durationSeconds,3724);assert.equal(workouts[1].sport,"Workout");assert.equal(workouts.length,2);
});

/** A night row as the store returns it. */
function night(date,overrides={}){return {night_date:date,recovery_status:4,ans_charge:0,ans_charge_status:3,sleep_charge:3,heart_rate_avg:50,hrv_avg:60,breathing_rate_avg:14,sleep_score:80,asleep_seconds:27000,deep_seconds:5400,light_seconds:14400,rem_seconds:7200,interruption_seconds:900,sleep_start:null,sleep_end:null,...overrides};}
/** Consecutive nights ending on `last`, oldest first. */
function nightsUntil(last,count,overrides=()=>({})){return Array.from({length:count},(_,index)=>{const date=addDays(last,index-count+1);return night(date,overrides(date,index));});}

test("usual ranges wait for a week of nights and use the member's own median and middle half",()=>{
  assert.equal(usualRange([1,2,3,4,5,6]),null);
  assert.deepEqual(usualRange([8,1,7,2,6,3,5,4,null,Number.NaN]),{median:4.5,low:2.8,high:6.3,nights:8});
  assert.equal(recoveryLabel(5),"Good");assert.equal(recoveryLabel(7),null);assert.equal(recoveryLabel(null),null);
  assert.equal(chargeLabel(1),"Much below usual");assert.equal(chargeLabel("3"),"Usual");assert.equal(chargeLabel(0),null);
  assert.equal(addDays("2026-02-28",1),"2026-03-01");assert.equal(daysBetween("2026-09-01","2026-09-30"),29);
});

test("overnight stress signals compare a night with the member's usual nights, never a population norm",()=>{
  const history=nightsUntil("2026-09-27",10);
  const learning=stressSignals(night("2026-09-28"),history.slice(-3));
  assert.equal(learning.level,"learning");assert.equal(learning.nights,3);assert.equal(learning.needed,LEARNING_NIGHTS);
  const usual=stressSignals(night("2026-09-28"),history);assert.equal(usual.level,"usual");assert.deepEqual(usual.signals,[]);assert.equal(usual.usual.hrv.median,60);
  const higher=stressSignals(night("2026-09-28",{hrv_avg:48,heart_rate_avg:58,breathing_rate_avg:14}),history);
  assert.equal(higher.level,"higher");assert.deepEqual(higher.signals,["hrv-low","heart-rate-high"]);
  const oneSignal=stressSignals(night("2026-09-28",{breathing_rate_avg:17}),history);assert.equal(oneSignal.level,"usual");assert.deepEqual(oneSignal.signals,["breathing-high"]);
  const ansLow=stressSignals(night("2026-09-28",{ans_charge_status:2}),history);assert.equal(ansLow.level,"higher");assert.deepEqual(ansLow.signals,["ans-low"]);
  const ansOnlyCharge=stressSignals(night("2026-09-28",{ans_charge_status:null,ans_charge:-4}),history);assert.equal(ansOnlyCharge.level,"higher");
  const lower=stressSignals(night("2026-09-28",{ans_charge_status:4}),history);assert.equal(lower.level,"lower");
  const lowerByCharge=stressSignals(night("2026-09-28",{ans_charge_status:null,ans_charge:4}),history);assert.equal(lowerByCharge.level,"lower");
});

test("a lighter session is offered only after a poor night or two nights with more stress signals",()=>{
  const higher={level:"higher"},usual={level:"usual"};
  assert.deepEqual(lighterSessionAdvice(null,null),{offer:false,reason:null,note:null});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:1},stress:usual},null),{offer:true,reason:"recovery",note:null});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:2},stress:usual},null),{offer:true,reason:"recovery",note:null});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:3},stress:usual},null),{offer:false,reason:null,note:"compromised"});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:4},stress:higher},{night:{},stress:higher}),{offer:true,reason:"stress",note:null});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:4},stress:higher},{night:{},stress:usual}),{offer:false,reason:null,note:null});
  assert.deepEqual(lighterSessionAdvice({night:{recovery_status:5},stress:higher},null),{offer:false,reason:null,note:null});
});

test("today's summary is current, stale, or empty, and only offers a lighter session for a recent night",()=>{
  assert.deepEqual(todaySummary({nights:[],days:[],today:"2026-09-28"}),{state:"no-data",lighterSession:{offer:false,reason:null,note:null}});
  const nights=nightsUntil("2026-09-28",12,(date)=>date==="2026-09-28"?{recovery_status:2}:{});
  const days=[{day_date:"2026-09-28",resting_hr:48,min_hr:46,avg_hr:71,max_hr:150}];
  const current=todaySummary({nights,days,today:"2026-09-28"});
  assert.equal(current.state,"current");assert.equal(current.ageDays,0);assert.equal(current.recovery.label,"Poor");assert.equal(current.recovery.ansChargeLabel,"Usual");
  assert.deepEqual(current.lighterSession,{offer:true,reason:"recovery",note:null});assert.equal(current.stress.level,"usual");
  assert.equal(current.sleep.asleepSeconds,27000);assert.equal(current.sleep.usual.median,27000);assert.deepEqual(current.heart.today,{resting:48,min:46,avg:71,max:150});
  const yesterday=todaySummary({nights,days:[],today:"2026-09-29"});assert.equal(yesterday.state,"current");assert.equal(yesterday.ageDays,1);assert.equal(yesterday.heart.today,null);
  const stale=todaySummary({nights,days:[],today:"2026-10-02"});assert.equal(stale.state,"stale");assert.equal(stale.ageDays,4);assert.deepEqual(stale.lighterSession,{offer:false,reason:null,note:null});
  const future=todaySummary({nights:[...nights,night("2026-09-29",{recovery_status:6})],days:[],today:"2026-09-28"});assert.equal(future.recovery.status,2,"a night after today is ignored");
  const stressed=nightsUntil("2026-09-28",12,(date)=>date>="2026-09-27"?{hrv_avg:40,heart_rate_avg:60}:{});
  assert.deepEqual(todaySummary({nights:stressed,days:[],today:"2026-09-28"}).lighterSession,{offer:true,reason:"stress",note:null});
  const gap=[...nightsUntil("2026-09-25",10),night("2026-09-28",{hrv_avg:40,heart_rate_avg:60})];
  assert.equal(todaySummary({nights:gap,days:[],today:"2026-09-28"}).lighterSession.offer,false,"stress nights must be consecutive");
});

test("trends give a nightly series, usual ranges, and weekly averages for the chosen weeks",()=>{
  const nights=nightsUntil("2026-09-28",40,(date,index)=>({hrv_avg:50+index%5,sleep_score:index%2?70:90,recovery_status:index%6+1}));
  const trends=trendSummary({nights,today:"2026-09-28",weeks:4});
  assert.equal(trends.from,"2026-09-01");assert.equal(trends.to,"2026-09-28");assert.equal(trends.series.length,28);assert.equal(trends.weekly.length,4);
  assert.deepEqual(trends.weekly.map((week)=>[week.start,week.end,week.nights]),[["2026-09-01","2026-09-07",7],["2026-09-08","2026-09-14",7],["2026-09-15","2026-09-21",7],["2026-09-22","2026-09-28",7]]);
  assert.equal(trends.usual.hrv.nights,28);assert.equal(typeof trends.weekly[0].hrv,"number");
  const sparse=trendSummary({nights:[night("2026-09-28",{hrv_avg:null})],today:"2026-09-28",weeks:8});
  assert.equal(sparse.weekly.length,8);assert.equal(sparse.weekly[0].nights,0);assert.equal(sparse.weekly[0].hrv,null);assert.equal(sparse.weekly[7].hrv,null);assert.equal(sparse.usual.hrv,null);
});
