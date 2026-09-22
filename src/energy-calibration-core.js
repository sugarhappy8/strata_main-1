// @ts-check
"use strict";

const {createHash}=require("node:crypto");
const MODEL_VERSION="energy-planning-v5",CALIBRATION_DAYS=42,MIN_COMPLETE_DAYS=14,MIN_WEIGHT_DAYS=8,MIN_WEIGHT_SPAN_DAYS=14;
// Every window, gate, density, quality weight, and bound below is an engineering heuristic.
// They are not clinically validated thresholds or statistical confidence criteria.
const POLICY=Object.freeze({pairDays:7,recentIntervalDays:7,maxWeightGapDays:7,weightDensity:7700,densityLow:5500,densityHigh:9500,outlierKg:1.5,outlierMad:4,maxOutlierFraction:.2,maxNoiseKg:.5,maxPairSpreadKcal:400,maxSegmentGapKcal:300,maxTrendFraction:.015,maxSignalGap:.5,maxPriorDeviation:.25,weeklyStepKcal:150,staleDays:42,anchorDays:7,anchorCount:3,anchorSpan:2,anchorFreshDays:3,anchorSpreadKg:1.5,anchorProfileGap:.1,anchorBodyFatGap:.02});
// Supported v4 input corners peak below 15,000 kcal/day only when maximum body size,
// manual work, 21 hours of vigorous extra activity, and six long sessions coincide.
// These defensive provenance limits cover that declared form space plus the 25% target
// bound. They are separate from the stricter 1,000–6,000 raw-inference gate below.
const MAX_BASELINE_KCAL=20000,MAX_PLANNED_KCAL=MAX_BASELINE_KCAL*(1+POLICY.maxPriorDeviation);
const DAY=86400000;
/** @param {number} x @param {number} lo @param {number} hi */
const clamp=(x,lo,hi)=>Math.min(hi,Math.max(lo,x));
/** @param {number} x @param {number} [step] */
const round=(x,step=1)=>Math.round(x/step)*step;
/** @param {number[]} values */
function median(values){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;return n%2?Number(sorted[(n-1)/2]):(Number(sorted[n/2-1])+Number(sorted[n/2]))/2;}
/** @param {number[]} values */
const mean=values=>values.reduce((sum,x)=>sum+x,0)/values.length;
/** @param {unknown} value */
function date(value){if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;const stamp=Date.parse(`${value}T00:00:00Z`);return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===value?value:null;}
/** @param {string} value @param {number} offset */
const addDays=(value,offset)=>new Date(Date.parse(`${value}T00:00:00Z`)+offset*DAY).toISOString().slice(0,10);
/** @param {string} a @param {string} b */
const daysBetween=(a,b)=>Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/DAY);
/** @param {any[]} points */
const spanOf=points=>points.length>1?daysBetween(points[0].date,points.at(-1).date):0;
/** @param {unknown} value @param {number} lo @param {number} hi */
const finite=(value,lo,hi)=>typeof value==="number"&&Number.isFinite(value)&&value>=lo&&value<=hi;

/** Normalize dates once. Conflicting duplicate days are excluded, never averaged. @param {any} evidence @param {string} weekStart */
function observations(evidence,weekStart){
  if(!date(weekStart))throw new TypeError("A valid coaching week date is required.");
  const windowStart=addDays(weekStart,-CALIBRATION_DAYS),windowEnd=addDays(weekStart,-1),byDate=new Map(),conflicts=new Set();
  for(const row of Array.isArray(evidence?.dailyLogs)?evidence.dailyLogs:[]){
    const key=date(row?.date);if(!key||key<windowStart||key>windowEnd||conflicts.has(key))continue;
    const validCalories=Number.isSafeInteger(row?.calories)&&finite(row.calories,0,20000),value={date:key,calories:validCalories?row.calories:null,complete:row?.complete===true&&validCalories,weightKg:finite(row?.morningWeightKg,35,300)?row.morningWeightKg:null};
    if(byDate.has(key)&&JSON.stringify(byDate.get(key))!==JSON.stringify(value)){byDate.delete(key);conflicts.add(key);}else byDate.set(key,value);
  }
  const rows=[...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date)),conflictingDates=[...conflicts].sort();
  return {windowStart,windowEnd,rows,conflictingDates,weights:rows.filter(row=>row.weightKg!=null).map(row=>({date:row.date,weightKg:row.weightKg}))};
}
/** @param {any[]} points */
function weightFit(points){
  const slopes=[];for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){const a=points[i],b=points[j],span=daysBetween(a.date,b.date);if(span>0)slopes.push((b.weightKg-a.weightKg)/span);}
  const slope=median(slopes),origin=points[0]?.date||"2000-01-01",intercept=median(points.map(p=>p.weightKg-slope*daysBetween(origin,p.date))),residuals=points.map(p=>Math.abs(p.weightKg-intercept-slope*daysBetween(origin,p.date)));
  return {slope,residuals,mad:median(residuals)};
}
/** Independent recent-weight context; never mutates the profile or estimates new body fat. @param {any} profile @param {string} weekStart @param {any} evidence */
function deriveWeightAnchor(profile,weekStart,evidence){
  const observed=observations(evidence,weekStart),fallback={weightKg:profile.weightKg,source:"saved_profile",date:null,quality:"unavailable",changed:false,requiresReview:false,recentUnderweight:false,bodyFatCompatible:true,diagnostics:{weightDays:0,spanDays:0,excludedOutliers:0,conflictingDays:observed.conflictingDates.length}};
  if(profile.version<3)return {...fallback,quality:"legacy"};
  const recent=observed.weights.filter(point=>point.date>=addDays(weekStart,-POLICY.anchorDays));if(!recent.length)return fallback;
  const fit=weightFit(recent),limit=Math.max(POLICY.outlierKg,fit.mad*POLICY.outlierMad),usable=recent.filter((_,index)=>Number(fit.residuals[index])<=limit),span=spanOf(usable),latest=usable.at(-1)?.date||null;
  const diagnostics={weightDays:usable.length,spanDays:span,excludedOutliers:recent.length-usable.length,conflictingDays:observed.conflictingDates.length};
  if((recent.length-usable.length)/recent.length>POLICY.maxOutlierFraction)return {...fallback,diagnostics,quality:"inconsistent",requiresReview:true};
  if(usable.length<POLICY.anchorCount||span<POLICY.anchorSpan||!latest||daysBetween(latest,weekStart)>POLICY.anchorFreshDays)return {...fallback,diagnostics,quality:"insufficient"};
  const weight=median(usable.map(p=>p.weightKg)),spread=Math.max(...usable.map(p=>p.weightKg))-Math.min(...usable.map(p=>p.weightKg)),consistent=spread<=Math.max(POLICY.anchorSpreadKg,weight*.02),recentUnderweight=weight/(profile.heightCm/100)**2<18.5;
  if(!consistent)return {...fallback,diagnostics,quality:"inconsistent",requiresReview:true};
  const relativeGap=Math.abs(weight-profile.weightKg)/profile.weightKg,disagreement=relativeGap>POLICY.anchorProfileGap,changed=Math.abs(weight-profile.weightKg)>=.05,bodyFatCompatible=relativeGap<=POLICY.anchorBodyFatGap;
  if(disagreement)return {...fallback,diagnostics,quality:"review_required",requiresReview:true,recentUnderweight,observedWeightKg:round(weight,.1),observedDate:latest};
  return {...fallback,weightKg:round(weight,.1),source:"recent_morning_weights",date:latest,quality:"consistent",changed,requiresReview:recentUnderweight,recentUnderweight,bodyFatCompatible,diagnostics};
}

/** Complete daily intake runs are bounded by actual morning measurements. @param {ReturnType<typeof observations>} observed @param {string} weekStart */
function intervals(observed,weekStart){
  const runs=[];let run=[];
  for(let key=observed.windowStart;key<=observed.windowEnd;key=addDays(key,1)){
    const row=observed.rows.find(item=>item.date===key);
    if(row?.complete){run.push(row);}else if(run.length){runs.push(run);run=[];}
  }
  if(run.length)runs.push(run);
  return runs.map(rows=>{
    const weights=observed.weights.filter(p=>p.date>=rows[0].date&&p.date<=addDays(rows.at(-1).date,1)),start=weights[0]?.date,end=weights.at(-1)?.date;
    if(!start||!end)return null;
    const intake=rows.filter(row=>row.date>=start&&row.date<end),days=daysBetween(start,end);let cumulative=0;
    const cumulativeByDate=new Map([[start,0]]);for(const row of intake){cumulative+=row.calories;cumulativeByDate.set(addDays(row.date,1),cumulative);}
    return {start,end,days,intake,points:weights.map(point=>({...point,elapsed:daysBetween(start,point.date),cumulative:cumulativeByDate.get(point.date)})),fresh:daysBetween(end,weekStart)<=POLICY.recentIntervalDays};
  }).filter(item=>item!==null).filter(item=>item.days>=MIN_COMPLETE_DAYS&&item.points.length>=MIN_WEIGHT_DAYS&&item.fresh).sort((a,b)=>b.days-a.days||b.end.localeCompare(a.end));
}
/** @param {any[]} points @param {number} [density] */
function energyFit(points,density=POLICY.weightDensity){
  const estimates=[];for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){const a=points[i],b=points[j],span=b.elapsed-a.elapsed;if(span>=POLICY.pairDays)estimates.push((b.cumulative-a.cumulative-density*(b.weightKg-a.weightKg))/span);}
  if(!estimates.length)return null;
  const maintenance=median(estimates),intercept=median(points.map(p=>density*p.weightKg-p.cumulative+maintenance*p.elapsed)),residuals=points.map(p=>Math.abs(density*p.weightKg-p.cumulative+maintenance*p.elapsed-intercept)/density);
  return {maintenance,pairCount:estimates.length,pairSpread:median(estimates.map(x=>Math.abs(x-maintenance))),residuals,mad:median(residuals)};
}
/** The service authenticates owner/profile identity; this leaf checks the saved model and numeric provenance.
 * @param {any} evidence @param {string} weekStart @param {string[]} acceptedModelVersions */
function previousTarget(evidence,weekStart,acceptedModelVersions){
  const previous=evidence?.previousWeek,maintenance=previous?.nutrition?.maintenance,calibration=maintenance?.calibration,previousDate=date(previous?.weekStart),target=maintenance?.targetKcal,storedBaseline=maintenance?.baselineKcal??calibration?.baselineKcal;
  const previousModel=String(previous?.energyModelVersion||"");
  if(!previousDate||previousDate>=weekStart||!acceptedModelVersions.includes(previousModel)||!finite(target,1000,MAX_PLANNED_KCAL)||!finite(storedBaseline,1000,MAX_BASELINE_KCAL))return null;
  if((calibration?.modelVersion!=null&&calibration.modelVersion!==previousModel)||(calibration?.targetKcal!=null&&calibration.targetKcal!==target)||(calibration?.baselineKcal!=null&&calibration.baselineKcal!==storedBaseline))return null;
  const outsideStoredBound=Math.abs(target-storedBaseline)>storedBaseline*POLICY.maxPriorDeviation,transition=calibration?.boundReconciliation,validationBaseline=outsideStoredBound&&transition?.required===true?transition.validationBaselineKcal:storedBaseline;
  if(!finite(validationBaseline,1000,MAX_BASELINE_KCAL)||target<Math.min(storedBaseline,validationBaseline)*(1-POLICY.maxPriorDeviation)||target>Math.max(storedBaseline,validationBaseline)*(1+POLICY.maxPriorDeviation))return null;
  const accepted=date(calibration?.lastAcceptedEvidenceEnd)||(calibration?.status==="trend_informed"?date(calibration?.interval?.end)||date(calibration?.windowEnd):null);
  if(accepted&&accepted>=previousDate)return null;
  return {weekStart:previousDate,targetKcal:target,baselineKcal:storedBaseline,validationBaselineKcal:validationBaseline,lastAcceptedEvidenceEnd:accepted,ageDays:daysBetween(previousDate,weekStart)};
}
/** Bound before and after rounding so rounding never exceeds the declared limits. @param {number} requested @param {number} baseline @param {ReturnType<typeof previousTarget>} previous */
function limitedTarget(requested,baseline,previous){
  const lower=Math.ceil(baseline*(1-POLICY.maxPriorDeviation)/25)*25,upper=Math.floor(baseline*(1+POLICY.maxPriorDeviation)/25)*25,prior=previous&&previous.ageDays<=POLICY.staleDays?previous.targetKcal:baseline;
  const stepLower=Math.ceil((prior-POLICY.weeklyStepKcal)/25)*25,stepUpper=Math.floor((prior+POLICY.weeklyStepKcal)/25)*25;
  // A changed equation can make the limits disjoint. Restore its bound gradually, preserving the weekly limit.
  if(stepLower>upper)return stepLower;if(stepUpper<lower)return stepUpper;
  return clamp(round(clamp(requested,Math.max(lower,stepLower),Math.min(upper,stepUpper)),25),Math.max(lower,stepLower),Math.min(upper,stepUpper));
}
/** @param {number} target @param {number} baseline @param {ReturnType<typeof previousTarget>} previous */
function targetDiagnostics(target,baseline,previous){
  const required=Math.abs(target-baseline)>baseline*POLICY.maxPriorDeviation,prior=previous&&previous.ageDays<=POLICY.staleDays?previous:null;
  return {weeklyChangeKcal:target-(prior?.targetKcal??baseline),boundReconciliation:{required,validationBaselineKcal:required?prior?.validationBaselineKcal??baseline:baseline,baselineRangeKcal:[Math.ceil(baseline*.75/25)*25,Math.floor(baseline*1.25/25)*25],basis:required?"The equation baseline changed. Its 25% bound is being restored gradually within the 150 kcal/day weekly limit.":"The target is within the current equation baseline bound."}};
}

/** @param {any} profile @param {string} weekStart @param {any} evidence @param {any} baseline */
function calibrateMaintenance(profile,weekStart,evidence,baseline){
  const observed=observations(evidence,weekStart),acceptedPriorModels=profile.version===3?[MODEL_VERSION,"energy-planning-v4","energy-planning-v3"]:[MODEL_VERSION,"energy-planning-v4"],previous=previousTarget(evidence,weekStart,acceptedPriorModels),canonical={rows:observed.rows,conflictingDates:observed.conflictingDates,windowStart:observed.windowStart,windowEnd:observed.windowEnd,previous},fingerprint=createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0,16);
  const evidenceCounts={completeCalorieDays:observed.rows.filter(row=>row.complete).length,morningWeightDays:observed.weights.length,rawMorningWeightDays:observed.weights.length,outlierWeightDays:0,weightObservationSpanDays:spanOf(observed.weights),requiredCompleteCalorieDays:MIN_COMPLETE_DAYS,requiredMorningWeightDays:MIN_WEIGHT_DAYS,requiredWeightObservationSpanDays:MIN_WEIGHT_SPAN_DAYS,conflictingDays:observed.conflictingDates.length,alignedIntakeDays:0};
  const common={modelVersion:MODEL_VERSION,windowDays:CALIBRATION_DAYS,windowStart:observed.windowStart,windowEnd:observed.windowEnd,evidenceFingerprint:fingerprint,evidence:evidenceCounts,thresholdBasis:"STRATA engineering heuristics; not validated clinical thresholds or statistical confidence criteria.",baselineKcal:baseline.targetKcal,observedMaintenanceKcal:null,trendKgPerWeek:null,appliedAdjustmentKcal:0,targetKcal:baseline.targetKcal,priorState:"none",lastAcceptedEvidenceEnd:null,interval:null,quality:{label:"insufficient",weight:0,basis:"Interval coverage and consistency; not a probability or confidence level."},sensitivity:null,limitations:["Self-reported intake may be systematically incomplete even when marked complete.","Water, glycogen, digestion, illness and measurement conditions can change scale weight.","The energy-density proxy, observation gates, sensitivity ranges and update bounds are unvalidated engineering heuristics.","A previous target limits the size of an update; it is never additional evidence."]};
  if(profile.version<3||baseline.energySemantics==="legacy_rmr_activity_multiplier")return {...common,status:"legacy_profile",quality:{...common.quality,label:"legacy"},explanation:"This legacy profile keeps its original resting-energy × activity estimate until the current activity questions are reviewed and saved."};
  /** @param {string} reason @param {any} [extra] */
  function hold(reason,extra={}){
    const age=previous?.lastAcceptedEvidenceEnd?daysBetween(previous.lastAcceptedEvidenceEnd,weekStart):Infinity,holding=Boolean(previous&&age<=POLICY.staleDays&&previous.ageDays<=POLICY.staleDays),expired=Boolean(previous?.lastAcceptedEvidenceEnd&&!holding),target=limitedTarget(holding?Number(previous?.targetKcal):baseline.targetKcal,baseline.targetKcal,previous),diagnostics=targetDiagnostics(target,baseline.targetKcal,previous),reconciled=holding&&target!==previous?.targetKcal;
    return {...common,...extra,...diagnostics,status:evidenceCounts.completeCalorieDays||evidenceCounts.rawMorningWeightDays?"calibrating":"starting",targetKcal:target,appliedAdjustmentKcal:target-baseline.targetKcal,priorState:holding?"held":expired?"expired":"none",lastAcceptedEvidenceEnd:previous?.lastAcceptedEvidenceEnd??null,explanation:`${reason}${holding?reconciled?" The equation baseline changed; the previous target moves toward its new bounds within the weekly change limit. Its original evidence still expires after 42 days.":" The previous evidence-informed target is held temporarily; its evidence expires after 42 days.":expired?" Previous calibration evidence has expired; the target moves back toward the equation starting point within the weekly change limit.":" The equation starting point is unchanged."}${diagnostics.boundReconciliation.required?` ${diagnostics.boundReconciliation.basis}`:""}`};
  }
  const interval=intervals(observed,weekStart)[0];
  if(!interval)return hold("Calibration needs a recent interval with at least 14 consecutive complete intake days, eight morning weights, and 14 days between the first and last morning weight.");
  const initial=energyFit(interval.points);if(!initial)return hold("The recorded morning weights do not span enough time for an aligned estimate.");
  const limit=Math.max(POLICY.outlierKg,initial.mad*POLICY.outlierMad),points=interval.points.filter((_,index)=>Number(initial.residuals[index])<=limit),fit=energyFit(points),outliers=interval.points.length-points.length;
  const usedSpan=spanOf(points),first=points[0],last=points.at(-1),counts={...evidenceCounts,morningWeightDays:points.length,outlierWeightDays:outliers,weightObservationSpanDays:usedSpan,alignedIntakeDays:interval.days},metadata={start:interval.start,end:interval.end,days:interval.days,lastIntakeDate:addDays(interval.end,-1),weightDays:points.length,pairDaysMinimum:POLICY.pairDays};
  if(outliers/interval.points.length>POLICY.maxOutlierFraction)return hold("Too many inconsistent weight observations would need to be excluded; this interval is not reliable enough to change targets.",{evidence:counts,interval:metadata,quality:{...common.quality,label:"inconsistent"}});
  if(!fit||!first||!last||points.length<MIN_WEIGHT_DAYS||usedSpan<MIN_WEIGHT_SPAN_DAYS)return hold("After excluding isolated weight outliers, too little aligned evidence remains.",{evidence:counts,interval:metadata});
  // Pair differences cancel any cumulative offset; report only the retained endpoint interval.
  const actualStart=first.date,actualEnd=last.date,actualIntake=interval.intake.filter(row=>row.date>=actualStart&&row.date<actualEnd),averageCalories=mean(actualIntake.map(row=>row.calories)),trend=weightFit(points),representativeWeight=median(points.map(p=>p.weightKg));
  metadata.start=actualStart;metadata.end=actualEnd;metadata.days=usedSpan;metadata.lastIntakeDate=addDays(actualEnd,-1);counts.alignedIntakeDays=usedSpan;
  const middle=(first.elapsed+last.elapsed)/2,early=energyFit(points.filter(p=>p.elapsed<=middle)),late=energyFit(points.filter(p=>p.elapsed>=middle)),segmentGap=early&&late?Math.max(Math.abs(early.maintenance-late.maintenance),Math.abs((early.maintenance+late.maintenance)/2-fit.maintenance)):null,maxWeightGapDays=Math.max(...points.slice(1).map((point,index)=>point.elapsed-Number(points[index]?.elapsed)));
  const signal={evidence:counts,interval:metadata,observedMaintenanceKcal:round(fit.maintenance),trendKgPerWeek:round(trend.slope*7,.001),averageCompleteCaloriesKcal:round(averageCalories),quality:{...common.quality,label:"inconsistent",pairCount:fit.pairCount,pairSpreadKcal:round(fit.pairSpread),residualWeightKg:round(fit.mad,.001),segmentGapKcal:segmentGap==null?null:round(segmentGap),maxWeightGapDays}};
  if(maxWeightGapDays>POLICY.maxWeightGapDays)return hold("Morning weights are too far apart inside this interval; continue regular measurements before changing targets.",signal);
  if(daysBetween(actualEnd,weekStart)>POLICY.recentIntervalDays)return hold("The last usable morning weight is too old for a current calibration.",signal);
  if(previous?.lastAcceptedEvidenceEnd&&actualEnd<=previous.lastAcceptedEvidenceEnd)return hold("No newer usable morning-weight endpoint has been recorded since the last accepted interval.",{...signal,quality:{...signal.quality,label:"insufficient"}});
  // Missing segment fits cannot establish consistency: a fluid step can otherwise
  // pass the full-interval fit simply because the midpoint weight was not recorded.
  if(segmentGap==null)return hold("Morning weights must span at least seven days in each half of the aligned interval before its consistency can be checked. Continue regular measurements; the minimum counts alone are not enough.",{...signal,quality:{...signal.quality,label:"insufficient"}});
  if(Math.abs(trend.slope*7)/representativeWeight>POLICY.maxTrendFraction)return hold("The weight trend exceeds the heuristic 1.5% per week boundary; it was not used to change targets.",signal);
  if(fit.mad>POLICY.maxNoiseKg||fit.pairSpread>POLICY.maxPairSpreadKcal||segmentGap>POLICY.maxSegmentGapKcal)return hold("The interval is inconsistent or contains a possible fluid shift. More consistent observations are needed before changing targets.",signal);
  if(!finite(fit.maintenance,1000,6000)||Math.abs(fit.maintenance-baseline.targetKcal)/baseline.targetKcal>POLICY.maxSignalGap)return hold("The intake-and-weight estimate falls outside the heuristic plausibility bounds. Review the logs and profile.",signal);
  const spanQuality=.25+.5*clamp((usedSpan-MIN_WEIGHT_SPAN_DAYS)/(CALIBRATION_DAYS-MIN_WEIGHT_SPAN_DAYS),0,1),coverage=Math.min(1,points.length/Math.ceil((usedSpan+1)/2)),qualityWeight=spanQuality*coverage/(1+(fit.pairSpread/250)**2),candidate=baseline.targetKcal+qualityWeight*(fit.maintenance-baseline.targetKcal),target=limitedTarget(candidate,baseline.targetKcal,previous);
  const densityEstimates=[POLICY.densityLow,POLICY.densityHigh].map(density=>energyFit(points,density)?.maintenance??fit.maintenance),margin=Math.max(150,averageCalories*.1,fit.pairSpread),sensitivity={rangeKcal:[round(Math.max(0,Math.min(fit.maintenance,...densityEstimates)-margin)),round(Math.max(fit.maintenance,...densityEstimates)+margin)],energyDensityRangeKcalPerKg:[POLICY.densityLow,POLICY.densityHigh],intakeVariationFraction:.1,statistical:false,basis:"Sensitivity to assumed tissue energy density and logged intake; not a confidence interval or total error bound."};
  const diagnostics=targetDiagnostics(target,baseline.targetKcal,previous);
  return {...common,...signal,...diagnostics,status:"trend_informed",targetKcal:target,appliedAdjustmentKcal:target-baseline.targetKcal,priorState:previous?"rate_limiter":"none",lastAcceptedEvidenceEnd:actualEnd,quality:{...signal.quality,label:"usable",weight:round(qualityWeight,.001)},sensitivity,candidateMaintenanceKcal:round(candidate,25),explanation:`Complete intake is aligned from the first morning weight up to, but excluding, the last morning. A robust cumulative-intake estimate informs ${round(qualityWeight*100)}% of the difference from the equation baseline. Updates move toward the 25% baseline bound with changes limited to 150 kcal/day per new week.${diagnostics.boundReconciliation.required?` ${diagnostics.boundReconciliation.basis}`:""} These are engineering safeguards, not measured expenditure.`};
}

module.exports={CALIBRATION_DAYS,MODEL_VERSION,MIN_COMPLETE_DAYS,MIN_WEIGHT_DAYS,MIN_WEIGHT_SPAN_DAYS,calibrateMaintenance,deriveWeightAnchor};
