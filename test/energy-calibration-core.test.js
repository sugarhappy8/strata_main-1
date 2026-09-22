"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {CALIBRATION_DAYS,MODEL_VERSION,MIN_COMPLETE_DAYS,MIN_WEIGHT_DAYS,MIN_WEIGHT_SPAN_DAYS,calibrateMaintenance,deriveWeightAnchor}=require("../src/energy-calibration-core");
const WEEK="2026-09-14",DAY=86400000;
const add=(date,days)=>new Date(Date.parse(`${date}T00:00:00Z`)+days*DAY).toISOString().slice(0,10);
const profile=(extra={})=>({version:3,age:30,heightCm:175,weightKg:75,sexForEquation:"male",bodyFatPercent:20,...extra});
const baseline=(extra={})=>({targetKcal:2625,energySemantics:"nasem_2023_whole_day_eer",...extra});
function evidence({maintenance=2625,intake=2625,days=42,week=WEEK,weight=75,noise=()=>0}={}){
  let cumulative=0;return {dailyLogs:Array.from({length:days},(_,index)=>{const calories=typeof intake==="function"?intake(index):intake,morningWeightKg=weight+(cumulative-maintenance*index)/7700+noise(index),row={date:add(week,index-days),calories,complete:true,morningWeightKg};cumulative+=calories;return row;})};
}
const calculate=(data,options={})=>calibrateMaintenance(profile(options.profile),options.week||WEEK,data,baseline(options.baseline));
function previous(result,{week=add(WEEK,-7),model=MODEL_VERSION}={}){return {weekStart:week,energyModelVersion:model,nutrition:{maintenance:{targetKcal:result.targetKcal,calibration:result}}};}

test("calibration constants declare the bounded model and minimum evidence",()=>{
  assert.equal(CALIBRATION_DAYS,42);assert.equal(MODEL_VERSION,"energy-planning-v5");assert.equal(MIN_COMPLETE_DAYS,14);assert.equal(MIN_WEIGHT_DAYS,8);assert.equal(MIN_WEIGHT_SPAN_DAYS,14);
  assert.equal(calculate({}).windowDays,42);
});
test("aligned cumulative intake recovers known expenditure with constant or varying intake",()=>{
  for(const intake of [2625,index=>index%2?3100:2300,index=>index<20?2300:3000]){
    const result=calculate(evidence({intake}));assert.equal(result.status,"trend_informed");assert.equal(result.observedMaintenanceKcal,2625);assert.equal(result.targetKcal,2625);assert.equal(result.interval.days,41);assert.equal(result.evidence.alignedIntakeDays,41);assert.equal(result.interval.lastIntakeDate,add(WEEK,-2));assert.equal(result.sensitivity.statistical,false);
  }
});
test("calories after the last observed morning cannot manufacture a maintenance adjustment",()=>{
  const input=evidence({intake:2600,maintenance:2600,days:21});for(let i=15;i<21;i++)input.dailyLogs[i].morningWeightKg=null;
  const original=calculate(input);for(let i=14;i<21;i++)input.dailyLogs[i].calories=3600;
  const changed=calculate(input);assert.equal(changed.observedMaintenanceKcal,2600);assert.equal(changed.observedMaintenanceKcal,original.observedMaintenanceKcal);assert.equal(changed.targetKcal,original.targetKcal);assert.equal(changed.interval.days,14);assert.equal(changed.evidence.alignedIntakeDays,14);
});
test("missing intake breaks an interval; incomplete intake is never assumed to be zero",()=>{
  const input=evidence({days:28});input.dailyLogs[14].complete=false;
  const result=calculate(input);assert.equal(result.status,"calibrating");assert.equal(result.targetKcal,2625);assert.equal(result.interval,null);
  input.dailyLogs[14].complete=true;input.dailyLogs=input.dailyLogs.filter((_,index)=>index!==14);assert.equal(calculate(input).status,"calibrating");
});
test("the longest recent valid interval is selected rather than averaging across missing dates",()=>{
  const input=evidence();input.dailyLogs[10].complete=false;const result=calculate(input);
  assert.equal(result.status,"trend_informed");assert.equal(result.interval.start,input.dailyLogs[11].date);assert.equal(result.interval.end,input.dailyLogs[41].date);assert.equal(result.evidence.alignedIntakeDays,30);
});
test("eight weights clustered at interval edges cannot substitute for temporal coverage",()=>{
  const input=evidence();for(let index=4;index<38;index++)input.dailyLogs[index].morningWeightKg=null;
  const result=calculate(input);assert.equal(result.evidence.morningWeightDays,8);assert.equal(result.status,"calibrating");assert.equal(result.quality.maxWeightGapDays,35);assert.match(result.explanation,/too far apart/);
});
test("conflicting duplicate dates are excluded deterministically and exact duplicates carry no extra weight",()=>{
  const input=evidence(),duplicate=structuredClone(input.dailyLogs[20]),original=calculate(input);input.dailyLogs.push(duplicate);
  assert.deepEqual(calculate(input),original);input.dailyLogs.push({...duplicate,calories:3000});
  const a=calculate(input),b=calculate({dailyLogs:[...input.dailyLogs].reverse()});assert.deepEqual(a,b);assert.equal(a.evidence.conflictingDays,1);assert.equal(a.evidence.alignedIntakeDays,20);assert.notEqual(a.evidenceFingerprint,original.evidenceFingerprint);
});
test("isolated interior and endpoint weight errors are excluded with actual remaining interval dates",()=>{
  for(const index of [0,20,41]){
    const input=evidence();input.dailyLogs[index].morningWeightKg+=12;const result=calculate(input);
    assert.equal(result.status,"trend_informed");assert.equal(result.evidence.outlierWeightDays,1);assert.equal(result.observedMaintenanceKcal,2625);assert.equal(result.interval.days,index===20?41:40);
    assert.equal(result.interval.start,input.dailyLogs[index===0?1:0].date);assert.equal(result.interval.end,input.dailyLogs[index===41?40:41].date);
  }
});
test("a sustained scale step and noisy weights do not become confident expenditure changes",()=>{
  const step=evidence({noise:index=>index>=21?-2:0}),noisy=evidence({noise:index=>index%2?1.2:-1.2});
  for(const input of [step,noisy]){const result=calculate(input);assert.equal(result.status,"calibrating");assert.equal(result.targetKcal,2625);assert.equal(result.quality.label,"inconsistent");assert.match(result.explanation,/inconsistent|fluid shift/);}
  const modest=calculate(evidence({noise:index=>Math.sin(index)*.15}));assert.equal(modest.status,"trend_informed");assert.ok(Math.abs(modest.observedMaintenanceKcal-2625)<100);
});
test("missing early or late segment fits cannot turn an apparent fluid step into a maintenance reduction",()=>{
  for(const retained of [[0,2,4,6,8,10,12,14],[0,2,4,6,8,10,12,15]]){
    const input=evidence({days:retained.at(-1)+1,noise:index=>index>=7?.6:0});
    input.dailyLogs.forEach((row,index)=>{if(!retained.includes(index))row.morningWeightKg=null;});
    const result=calculate(input);
    assert.equal(result.evidence.morningWeightDays,8);assert.ok(result.interval.days>=14);assert.equal(result.quality.maxWeightGapDays,retained.at(-1)===14?2:3);
    assert.equal(result.status,"calibrating");assert.equal(result.targetKcal,2625);assert.equal(result.quality.label,"insufficient");assert.equal(result.quality.segmentGapKcal,null);assert.match(result.explanation,/seven days in each half/);
  }
});
test("regular alternate-day weights calibrate once both halves have seven-day coverage",()=>{
  const input=evidence({days:17,maintenance:2800,intake:2800});
  input.dailyLogs.forEach((row,index)=>{if(index%2)row.morningWeightKg=null;});
  const result=calculate(input);
  assert.equal(result.status,"trend_informed");assert.equal(result.observedMaintenanceKcal,2800);assert.equal(result.quality.segmentGapKcal,0);assert.equal(result.interval.days,16);assert.ok(result.targetKcal>2625);
});
test("gaining and losing synthetic tissue adjust maintenance with the correct sign",()=>{
  const gain=calculate(evidence({maintenance:2500,intake:2700})),loss=calculate(evidence({maintenance:2800,intake:2600}));
  assert.equal(gain.observedMaintenanceKcal,2500);assert.equal(loss.observedMaintenanceKcal,2800);assert.ok(gain.trendKgPerWeek>0);assert.ok(loss.trendKgPerWeek<0);assert.ok(gain.targetKcal<2625);assert.ok(loss.targetKcal>2625);
});
test("weekly rate limiting allows repeated evidence to move beyond the initial150 cap without posterior compounding",()=>{
  const first=calculate(evidence({maintenance:3400,intake:3400}));assert.equal(first.targetKcal,2775);
  const nextWeek=add(WEEK,7),secondInput=evidence({maintenance:3400,intake:3400,week:nextWeek});secondInput.previousWeek=previous(first,{week:WEEK});
  const second=calculate(secondInput,{week:nextWeek});assert.equal(second.targetKcal,2925);assert.equal(second.weeklyChangeKcal,150);assert.equal(second.quality.weight,first.quality.weight);assert.equal(second.candidateMaintenanceKcal,first.candidateMaintenanceKcal);
  const candidates=[];let prior=second;for(let i=2;i<9;i++){const week=add(WEEK,i*7),input=evidence({maintenance:3400,intake:3400,week});input.previousWeek=previous(prior,{week:add(week,-7)});prior=calculate(input,{week});candidates.push(prior.candidateMaintenanceKcal);}
  assert.ok(candidates.every(value=>value===first.candidateMaintenanceKcal));assert.equal(prior.targetKcal,first.candidateMaintenanceKcal);assert.ok(prior.targetKcal<=2625*1.25);
});
test("unchanged old windows do not ratchet the target in another week",()=>{
  const input=evidence({maintenance:3400,intake:3400}),first=calculate(input);input.previousWeek=previous(first,{week:WEEK});
  const second=calculate(input,{week:add(WEEK,7)});assert.equal(second.priorState,"held");assert.equal(second.targetKcal,first.targetKcal);assert.notEqual(second.status,"trend_informed");
});
test("an accepted endpoint cannot be replayed while it still meets the freshness cutoff",()=>{
  const input=evidence({maintenance:3400,intake:3400}),first=calculate(input);input.previousWeek=previous(first,{week:WEEK});
  for(const offset of [1,3,6]){
    const replay=calculate(input,{week:add(WEEK,offset)});
    assert.equal(replay.priorState,"held");assert.equal(replay.targetKcal,first.targetKcal);assert.equal(replay.lastAcceptedEvidenceEnd,first.lastAcceptedEvidenceEnd);assert.notEqual(replay.status,"trend_informed");assert.match(replay.explanation,/No newer usable morning-weight endpoint/);
  }
});
test("a version 3 profile preserves its immediately previous v3 calibration during model rollover",()=>{
  const accepted=calculate(evidence({maintenance:3400,intake:3400})),oldCalibration={...accepted,modelVersion:"energy-planning-v3"},oldSnapshot=previous(oldCalibration,{week:WEEK,model:"energy-planning-v3"}),nextWeek=add(WEEK,7);
  const held=calculate({previousWeek:oldSnapshot},{week:nextWeek});assert.equal(held.priorState,"held");assert.equal(held.targetKcal,accepted.targetKcal);assert.ok(Math.abs(held.weeklyChangeKcal)<=150);
  const rejectedForV4=calculate({previousWeek:oldSnapshot},{week:nextWeek,profile:{version:4},baseline:{energySemantics:"mifflin_structured_activity_v4"}});assert.equal(rejectedForV4.priorState,"none");assert.equal(rejectedForV4.targetKcal,2625);
});
test("version 3 and 4 profiles preserve v4 targets and weekly limits during model rollover",()=>{
  for(const version of [3,4]){
    const oldCalibration={modelVersion:"energy-planning-v4",baselineKcal:2625,targetKcal:3275,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-8)},saved=previous(oldCalibration,{model:"energy-planning-v4"});
    const held=calculate({previousWeek:saved},{profile:{version},baseline:{targetKcal:2600}});
    assert.equal(held.modelVersion,MODEL_VERSION);assert.equal(held.priorState,"held");assert.equal(held.targetKcal,3250);assert.equal(held.weeklyChangeKcal,-25);assert.equal(held.lastAcceptedEvidenceEnd,oldCalibration.lastAcceptedEvidenceEnd);
    const fresh=evidence({maintenance:2800,intake:2800});fresh.previousWeek=saved;
    const updated=calculate(fresh,{profile:{version}});
    assert.equal(updated.status,"trend_informed");assert.equal(updated.priorState,"rate_limiter");assert.equal(updated.targetKcal,3125);assert.equal(updated.weeklyChangeKcal,-150);
  }
});
test("stale accepted evidence is held for42days then explicitly expires",()=>{
  const first=calculate(evidence({maintenance:3400,intake:3400})),saved=previous(first,{week:WEEK});
  const held=calculate({previousWeek:saved},{week:add(WEEK,35)});assert.equal(held.priorState,"held");assert.equal(held.targetKcal,2775);assert.equal(held.lastAcceptedEvidenceEnd,add(WEEK,-1));
  const expired=calculate({previousWeek:saved},{week:add(WEEK,42)});assert.equal(expired.priorState,"expired");assert.equal(expired.targetKcal,2625);assert.match(expired.explanation,/expired/);
});
test("expiry moves a large held adjustment back toward baseline without exceeding the weekly step",()=>{
  const snapshot={weekStart:add(WEEK,-7),energyModelVersion:MODEL_VERSION,nutrition:{maintenance:{targetKcal:3200,calibration:{status:"starting",baselineKcal:2625,priorState:"held",lastAcceptedEvidenceEnd:add(WEEK,-43)}}}};
  const result=calculate({previousWeek:snapshot});assert.equal(result.priorState,"expired");assert.equal(result.targetKcal,3050);assert.equal(result.lastAcceptedEvidenceEnd,add(WEEK,-43));
});
test("a small baseline change preserves a valid prior target and reconciles the new bound gradually",()=>{
  const saved=previous({baselineKcal:2625,targetKcal:3275,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-8)});
  assert.equal(calculate({previousWeek:saved}).targetKcal,3275);
  const result=calculate({previousWeek:saved},{baseline:{targetKcal:2600}});
  assert.equal(result.priorState,"held");assert.equal(result.targetKcal,3250);assert.equal(result.weeklyChangeKcal,-25);assert.equal(result.boundReconciliation.required,false);assert.match(result.explanation,/baseline changed/);
});
test("disjoint baseline and weekly bounds restore gradually across successive snapshots in both directions",()=>{
  for(const [initialTarget,newBaseline,direction]of [[3275,2200,-1],[1975,3500,1]]){
    let saved=previous({baselineKcal:2625,targetKcal:initialTarget,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-8)}),priorTarget=initialTarget;
    for(let index=0;index<5;index++){
      const week=add(WEEK,index*7),result=calculate({previousWeek:saved},{week,baseline:{targetKcal:newBaseline}});
      assert.ok(Math.abs(result.targetKcal-priorTarget)<=150);assert.ok((result.targetKcal-priorTarget)*direction>=0);assert.equal(result.lastAcceptedEvidenceEnd,add(WEEK,-8));
      if(index===0){assert.equal(result.boundReconciliation.required,true);assert.equal(result.boundReconciliation.validationBaselineKcal,2625);assert.match(result.explanation,/restored gradually/);}
      priorTarget=result.targetKcal;saved=previous(result,{week});
    }
    assert.equal(saved.nutrition.maintenance.calibration.boundReconciliation.required,false);
  }
});
test("saved target provenance must match the stored baseline and model rather than the current baseline",()=>{
  const saved=previous({modelVersion:MODEL_VERSION,baselineKcal:2625,targetKcal:3275,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-8)});
  const variants=[{baselineKcal:undefined},{baselineKcal:2000},{modelVersion:"energy-planning-v3"},{targetKcal:3250}];
  for(const change of variants){const invalid=structuredClone(saved);Object.assign(invalid.nutrition.maintenance.calibration,change);assert.equal(calculate({previousWeek:invalid}).targetKcal,2625);}
  const contradictory=structuredClone(saved);contradictory.nutrition.maintenance.baselineKcal=2600;assert.equal(calculate({previousWeek:contradictory}).targetKcal,2625);
});
test("valid high EER targets remain rate limiters without relaxing the raw expenditure gate",()=>{
  // The published very-active male equation rounds to 6675 for 30 y, 200 cm, 230 kg.
  const options={profile:{weightKg:230,heightCm:200},baseline:{targetKcal:6675}},targets=[];let prior;
  for(let index=0;index<5;index++){
    const week=add(WEEK,index*7),input=evidence({week,weight:230,maintenance:5900,intake:5900});
    if(prior)input.previousWeek=previous(prior,{week:add(week,-7)});
    const result=calculate(input,{...options,week});targets.push(result.targetKcal);
    assert.equal(result.status,"trend_informed");assert.equal(result.observedMaintenanceKcal,5900);assert.ok(Math.abs(result.weeklyChangeKcal)<=150);assert.equal(result.priorState,index?"rate_limiter":"none");prior=result;
  }
  assert.ok(targets[1]<targets[0]);assert.ok(targets.at(-1)<6675-150);assert.equal(targets.at(-1),prior.candidateMaintenanceKcal);
  const rejected=calculate(evidence({weight:230,maintenance:6100,intake:6100}),options);
  assert.equal(rejected.status,"calibrating");assert.equal(rejected.targetKcal,6675);assert.match(rejected.explanation,/plausibility bounds/);
});
test("structured-activity provenance bounds cover the full declared input range",()=>{
  const oldCalibration={modelVersion:MODEL_VERSION,baselineKcal:15000,targetKcal:18000,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-8)},snapshot={weekStart:add(WEEK,-7),energyModelVersion:MODEL_VERSION,nutrition:{maintenance:{baselineKcal:15000,targetKcal:18000,calibration:oldCalibration}}};
  const result=calculate({previousWeek:snapshot},{profile:{version:4},baseline:{targetKcal:15000,energySemantics:"mifflin_structured_activity_v4"}});assert.equal(result.priorState,"held");assert.equal(result.targetKcal,18000);
});
test("future, current-week and incompatible-model prior snapshots cannot affect targets",()=>{
  const result={targetKcal:3100,status:"trend_informed",lastAcceptedEvidenceEnd:add(WEEK,-1)};
  for(const prior of [previous(result,{week:WEEK}),previous(result,{week:add(WEEK,7)}),previous(result,{model:"energy-planning-v3"}),previous({...result,lastAcceptedEvidenceEnd:WEEK})]){
    const input=evidence({maintenance:3400,intake:3400});input.previousWeek=prior;assert.equal(calculate(input).targetKcal,2775);
  }
});
test("cutoffs, invalid dates and numeric fields cannot inject future evidence",()=>{
  const input=evidence(),snapshot=structuredClone(input),first=calculate(input);input.dailyLogs.push({date:WEEK,calories:20000,complete:true,morningWeightKg:200},{date:add(WEEK,-43),calories:20000,complete:true,morningWeightKg:200},{date:"2026-02-30",calories:20000,complete:true,morningWeightKg:200});
  assert.deepEqual(calculate(input),first);assert.deepEqual(snapshot.dailyLogs,input.dailyLogs.slice(0,42));assert.throws(()=>calculate(input,{week:"bad"}),/valid coaching week/);
});
test("implausible weight rates and intake-derived expenditure are withheld",()=>{
  for(const input of [evidence({maintenance:3900,intake:2000}),evidence({maintenance:7000,intake:7000}),evidence({maintenance:1200,intake:1200})]){const result=calculate(input);assert.equal(result.status,"calibrating");assert.equal(result.targetKcal,2625);}
});
test("legacy profiles preserve exact baseline values and do not adopt recent weight",()=>{
  for(const version of [1,2]){const input=evidence({maintenance:3400,intake:3400});const result=calculate(input,{profile:{version},baseline:{targetKcal:2575,energySemantics:"legacy_rmr_activity_multiplier"}});assert.equal(result.status,"legacy_profile");assert.equal(result.targetKcal,2575);assert.equal(result.appliedAdjustmentKcal,0);assert.equal(deriveWeightAnchor(profile({version}),WEEK,input).source,"saved_profile");}
});
test("recent-weight anchor reports provenance and prevents stale body-fat coupling",()=>{
  const input=evidence({weight:72}),original=profile(),snapshot=structuredClone(input),anchor=deriveWeightAnchor(original,WEEK,input);
  assert.equal(anchor.weightKg,72);assert.equal(anchor.source,"recent_morning_weights");assert.equal(anchor.date,add(WEEK,-1));assert.equal(anchor.quality,"consistent");assert.equal(anchor.changed,true);assert.equal(anchor.bodyFatCompatible,false);assert.deepEqual(original,profile());assert.deepEqual(input,snapshot);
  assert.equal(deriveWeightAnchor(original,WEEK,evidence({weight:74.9})).bodyFatCompatible,true,"ordinary scale drift within 2% may retain the conservative composition screen");
});
test("sparse, stale, conflicting and noisy recent weights cannot silently replace profile weight",()=>{
  const sparse=evidence();sparse.dailyLogs=sparse.dailyLogs.slice(0,-5);const noisy=evidence({noise:index=>index%2?2:-2});
  for(const input of [sparse,noisy])assert.equal(deriveWeightAnchor(profile(),WEEK,input).source,"saved_profile");
  const conflict=evidence();for(const row of conflict.dailyLogs.slice(-7))conflict.dailyLogs.push({...row,morningWeightKg:80});assert.equal(deriveWeightAnchor(profile(),WEEK,conflict).source,"saved_profile");
});
test("credible underweight observations are flagged even when profile disagreement prevents adoption",()=>{
  const anchor=deriveWeightAnchor(profile({weightKg:90}),WEEK,evidence({weight:50}));assert.equal(anchor.source,"saved_profile");assert.equal(anchor.weightKg,90);assert.equal(anchor.observedWeightKg,50);assert.equal(anchor.recentUnderweight,true);assert.equal(anchor.requiresReview,true);assert.equal(anchor.quality,"review_required");
});
