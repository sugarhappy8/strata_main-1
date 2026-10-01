// @ts-check
"use strict";

// What Strata AI is told about the member's recent days, built from the shared data layer: Daily Snapshots,
// the Training Log, Rankings Signals, and plan history. Compact lines, never raw rows, and never the member's
// name, email, or any provider token. Care flags are computed here, deterministically, so the model is told
// when to suggest a professional rather than left to notice a trend by itself.

const {EXERCISES}=require("./plans");

const CONTEXT_CHARS=2400;
const SHORT_DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const EXERCISE_NAMES=new Map(EXERCISES.map((exercise)=>[String(exercise.id),String(exercise.name)]));

/** @param {unknown} value */
const num=(value)=>{if(value===null||value===undefined||value==="")return null;const number=Number(value);return Number.isFinite(number)?number:null;};
/** @param {number|null} seconds */
const hours=(seconds)=>seconds===null?"":`${Math.floor(seconds/3600)}h ${String(Math.round(seconds%3600/60)).padStart(2,"0")}m`;
/** @param {string} date */
const dayLabel=(date)=>`${SHORT_DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date.slice(5)}`;
/** @param {number[]} values */
const median=(values)=>{const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]??0:((sorted[middle-1]??0)+(sorted[middle]??0))/2;};

/** One day as a short line. @param {any} snapshot */
function dayLine(snapshot){
  const parts=[],sleep=snapshot.sleep,recovery=snapshot.recovery,heart=snapshot.heart,training=snapshot.training,nutrition=snapshot.nutrition;
  if(num(sleep?.asleepSeconds)!==null)parts.push(`slept ${hours(num(sleep.asleepSeconds))}${num(sleep.score)!==null?` (score ${num(sleep.score)})`:""}`);
  if(recovery?.label)parts.push(`recovery ${String(recovery.label).toLowerCase()}${recovery.stress==="higher"?", stress signals above usual":""}`);
  const heartParts=[num(heart?.hrv)!==null?`HRV ${num(heart.hrv)} ms`:"",num(heart?.resting)!==null?`resting HR ${num(heart.resting)}`:""].filter(Boolean);if(heartParts.length)parts.push(heartParts.join(", "));
  const done=Array.isArray(training?.done)?training.done:[];
  if(done.length)parts.push(`trained: ${done.map((/** @type {any} */ item)=>`${String(item.title||"session").slice(0,40)}${num(item.durationSeconds)?` ${Math.round(Number(item.durationSeconds)/60)} min`:""}${item.source==="polar"?" (Polar)":""}`).join(", ")}`);
  else if(training?.status==="planned")parts.push("planned session not done yet");
  else if(training?.status==="not_logged")parts.push("planned session not logged");
  else if(training?.status==="rest")parts.push("rest day");
  if(num(nutrition?.calories)!==null)parts.push(`${num(nutrition.calories)} kcal logged${num(nutrition.morningWeightKg)!==null?`, morning weight ${num(nutrition.morningWeightKg)} kg`:""}`);
  return parts.length?`${dayLabel(String(snapshot.date))}: ${parts.join("; ")}`:"";
}

/**
 * Trends worth a "consider seeing a professional" note. Each needs three days in a row, so one bad night never
 * triggers it, and resting heart rate is compared with the member's own earlier days, never a population norm.
 * @param {any[]} snapshots oldest first
 */
function careFlags(snapshots){
  const flags=[],last=snapshots.slice(-3);
  if(last.length===3){
    const earlier=snapshots.slice(0,-3).map((item)=>num(item.heart?.resting)).filter((value)=>value!==null).map(Number);
    const usual=earlier.length>=5?median(earlier):null;
    if(usual!==null&&last.every((item)=>{const value=num(item.heart?.resting);return value!==null&&value>usual+7;}))flags.push("Resting heart rate has been more than 7 bpm above the member's usual for 3 days.");
    if(last.every((item)=>item.recovery?.stress==="higher"))flags.push("Overnight stress signals have been above usual for 3 nights.");
    if(last.every((item)=>{const value=num(item.sleep?.asleepSeconds);return value!==null&&value<5*3600;}))flags.push("Sleep has been under 5 hours for 3 nights.");
  }
  return flags;
}

/**
 * @param {{snapshots?:any[],entries?:any[],signals?:any,planChanges?:any[],brief?:any}} input snapshots oldest first
 * @returns {{text:string,flags:string[]}}
 */
function buildDataContext({snapshots=[],entries=[],signals=null,planChanges=[],brief=null}){
  const flags=careFlags(snapshots),days=snapshots.slice(-7).map(dayLine).filter(Boolean);
  const done=entries.filter((entry)=>entry.kind!=="planned"&&entry.status==="completed").length,planned=entries.filter((entry)=>entry.kind==="planned");
  const week=entries.length?`This week: ${done} completed session${done===1?"":"s"}${planned.length?`, ${planned.filter((entry)=>entry.status==="planned").length} still planned, ${planned.filter((entry)=>entry.status==="not_logged").length} planned but not logged`:""}.`:"";
  const trained=(signals?.trained||[]).slice(0,5).map((/** @type {any} */ item)=>`${EXERCISE_NAMES.get(String(item.exerciseId))||String(item.exerciseId)} ×${Number(item.sessions)||0}`);
  const change=planChanges[0],source=change?({ai:"an accepted Strata AI proposal",system:"STRATA setup or an approved adjustment",manual:"the member's own edit"})[String(change.source)]||"the member's own edit":"";
  const care=flags.length?`Care notes (mention gently, suggest a health professional if it continues, never diagnose): ${flags.join(" ")}`:"";
  const rest=[
    week,
    trained.length?`Most-trained exercises in 8 weeks: ${trained.join(", ")}.`:"",
    source?`The saved week last changed through ${source}.`:"",
    brief?.recommendation?.title?`Today's Daily Brief recommended: ${String(brief.recommendation.title).slice(0,120)}.`:""
  ].filter(Boolean);
  // Oldest day lines go first when the summary is over budget; care notes are never dropped.
  const compose=(/** @type {number} */ keep)=>[keep?`Recent days (newest last):\n${days.slice(-keep).join("\n")}`:days.length?"":"No recent sleep, recovery, training, or diary data.",...rest].filter(Boolean).join("\n\n");
  let keep=days.length,body=compose(keep);
  while(body.length>CONTEXT_CHARS&&keep>1){keep-=1;body=compose(keep);}
  return {text:[body.slice(0,CONTEXT_CHARS),care].filter(Boolean).join("\n\n"),flags};
}

module.exports={CONTEXT_CHARS,buildDataContext,careFlags,dayLine};
