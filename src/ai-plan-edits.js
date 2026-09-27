// @ts-check
"use strict";

const {DAYS,EXERCISES,sanitizePlan}=require("./plans");

const SESSION_MINUTES=Object.freeze([30,45,60,75,90]);
const EXERCISE_BY_ID=new Map(EXERCISES.map((/** @type {any} */ item)=>[String(item.id),item]));

/** @param {string} message */
function invalid(message){return Object.assign(new Error(message),{code:"AI_INVALID_REQUEST",status:400});}
/** @param {number} value */
function bucket(value){return SESSION_MINUTES.reduce((best,item)=>Math.abs(item-value)<Math.abs(best-value)?item:best,45);}
/** @param {number} sets */
function minutes(sets){return sets>0?Math.round(sets*2.5+5):0;}
/** @param {any} plan */
function trainingDays(plan){return DAYS.filter((day)=>Array.isArray(plan?.days?.[day])&&plan.days[day].length>0);}
/** @param {any} plan @param {string} day */
function daySets(plan,day){return (Array.isArray(plan?.days?.[day])?plan.days[day]:[]).reduce((sum,entry)=>sum+Number(entry?.sets||0),0);}
/** @param {any} plan */
function scheduleBucket(plan){const days=trainingDays(plan);return days.length?bucket(minutes(days.reduce((sum,day)=>sum+daySets(plan,day),0)/days.length)):null;}

/** Validate an untrusted client-side proposed plan before using it as model context. @param {unknown} value */
function sanitizeDraftPlan(value){
  if(value==null)return null;
  let plan;
  try{plan=sanitizePlan(value);}catch{throw invalid("The draft weekly plan is invalid.");}
  const active=trainingDays(plan);
  if(active.length<1||active.length>6)throw invalid("A draft plan needs 1 to 6 training days.");
  for(const day of active){
    const items=plan.days[day]??[];
    if(items.length<2||items.length>8)throw invalid(`${day} needs 2 to 8 exercises.`);
    if(items.some((/** @type {any} */ item)=>item.sets<1||item.sets>6)||daySets(plan,day)>36)throw invalid(`${day} has too many working sets.`);
  }
  plan.restDays=DAYS.filter((day)=>!active.includes(day));plan.restDay=plan.restDays[0]??null;
  return plan;
}

/** Exercise IDs required to describe a complete draft. @param {any} plan */
function planExerciseIds(plan){return new Set(trainingDays(plan).flatMap((day)=>plan.days[day].map((/** @type {any} */ item)=>String(item.exerciseId))));}
/** @param {string} message */
function numbered(message){const words={one:"1",two:"2",three:"3",four:"4",five:"5",six:"6"};return message.toLowerCase().replace(/\b(one|two|three|four|five|six)\b/g,(word)=>words[/** @type {keyof typeof words} */(word)]);}
/** @param {string} text @param {"training"|"rest"} kind */
function dayDelta(text,kind){
  const noun=kind==="training"?"(?:training|workout)":"rest";
  const more=new RegExp(`\\b(?:(?:add|give me|want|need)\\s+)?(?:a|an|([1-6]))?\\s*(?:more|extra|additional)\\s+${noun}\\s+days?\\b|\\badd\\s+(?:a|an|([1-6]))?\\s*${noun}\\s+days?\\b`);
  const fewer=new RegExp(`\\b(?:(?:remove|drop|cut|want|need)\\s+)?(?:a|an|([1-6]))?\\s*(?:fewer|less)\\s+${noun}\\s+days?\\b|\\b(?:remove|drop|cut)\\s+(?:a|an|([1-6]))?\\s*${noun}\\s+days?\\b`);
  let match=more.exec(text);if(match)return Number(match[1]||match[2]||1);
  match=fewer.exec(text);return match?-Number(match[1]||match[2]||1):0;
}
/** @param {string} text */
function genericDayDelta(text){const match=/\b(add|remove|drop|cut)\s+(?:a|an|([1-6]))?\s*(?:more\s+)?days?\b/.exec(text);return match?(match[1]==="add"?1:-1)*Number(match[2]||1):0;}
/** @param {number} value */
function nextBucket(value){const index=SESSION_MINUTES.indexOf(value);return SESSION_MINUTES[Math.min(index+1,SESSION_MINUTES.length-1)];}
/** @param {number} value */
function previousBucket(value){const index=SESSION_MINUTES.indexOf(value);return SESSION_MINUTES[Math.max(index-1,0)];}

/** Convert plain-language schedule edits into requirements that can be checked after generation. @param {unknown} message @param {any} basePlan */
function planEditContract(message,basePlan){
  const text=numbered(String(message??"")),baseDays=trainingDays(basePlan),baseCount=baseDays.length;
  const trainingDelta=dayDelta(text,"training"),restDelta=dayDelta(text,"rest"),genericDelta=genericDayDelta(text);
  let requestedDays=null,scheduleRequested=false;
  if(baseCount&&(trainingDelta||restDelta||genericDelta)){requestedDays=Math.max(1,Math.min(6,baseCount+trainingDelta-restDelta+genericDelta));scheduleRequested=true;}
  if(requestedDays==null){
    const rest=/(?:\b(?:only|exactly|want|need|have)\s+)?([1-6])\s+(?:rest|recovery|off)\s+days?\b|\b([1-6])\s+days?\s+off\b/.exec(text);
    const active=/(?:\b(?:train|work\s*out)\s+(?:on\s+)?([1-6])\s+days?\b)|(?:\b([1-6])\s+(?:training|workout)\s+days?\b)|(?:\b([1-6])\s+days?\s+(?:a|per)\s+week\b)|(?:\b([1-6])\s*[- ]\s*day\b(?=[^.]{0,50}\b(?:plan|week|split|routine)\b))|(?:\b([1-6])\s+workouts?\s+(?:a|per)\s+week\b)/.exec(text);
    if(rest){requestedDays=7-Number(rest[1]||rest[2]);scheduleRequested=true;}else if(active){requestedDays=Number(active.slice(1).find(Boolean));scheduleRequested=true;}
  }
  const longer=/\b(?:longer|lengthen|increase|extend)\b/.test(text)&&/\b(?:sessions?|workouts?|duration|minutes?)\b/.test(text);
  const shorter=/\b(?:shorter|shorten|decrease|reduce|cut)\b/.test(text)&&/\b(?:sessions?|workouts?|duration|minutes?)\b/.test(text);
  const current=baseCount?scheduleBucket(basePlan):null;let requestedMinutes=null,durationRequested=false;
  if(current&&(longer||shorter)){requestedMinutes=longer?nextBucket(current):previousBucket(current);durationRequested=true;}
  else{const explicit=/\b([1-9][0-9]{1,2})\s*(?:-|\s)?(?:minutes?|mins?)\b/.exec(text),nutrition=/\b(?:calories?|macros?|nutrition|meals?|food)\b/.test(text),scope=scheduleRequested||!nutrition&&(/\b(?:sessions?|workouts?|training|plan|week|split|routine)\b/.test(text)||baseCount>0&&/\b(?:make|change|set|want|need|have|each|every|about)\b/.test(text));if(explicit&&scope){requestedMinutes=bucket(Number(explicit[1]));durationRequested=true;}}
  if(!scheduleRequested&&!durationRequested)return null;
  const preserveDays=durationRequested&&!scheduleRequested&&baseCount>0,requireBaseDays=requestedDays!=null&&requestedDays>baseCount&&baseCount>0;
  return {trainingDays:requestedDays,sessionMinutes:requestedMinutes,preserveDays,requireBaseDays,baseTrainingDays:baseDays,direction:scheduleRequested&&durationRequested?"mixed":scheduleRequested?"schedule":"duration"};
}

/** Complete base-plan context plus requirements for the model. @param {{basePlan:any,source?:unknown,candidates?:any[],contract:any}} input */
function planEditContext({basePlan,source,candidates=[],contract}){
  const codes=new Map(candidates.map((item)=>[String(item.id),String(item.code)]));
  const rows=DAYS.map((day)=>{const items=basePlan?.days?.[day]||[];return `${day}: ${items.length?items.map((/** @type {any} */ item)=>`${codes.get(String(item.exerciseId))||EXERCISE_BY_ID.get(String(item.exerciseId))?.name||item.exerciseId} ${item.sets}x${item.reps}`).join("; "):"REST"}`;});
  if(!contract)return `Proposed week under discussion (reference only):\nBase source: ${String(source||"current plan")}\nBase schedule:\n${rows.join("\n")}\nUse this week as context. Return a complete replacement week only when the current message asks to change it; otherwise answer normally.`;
  const requirements=["Return a complete replacement week. Preserve details the member did not ask to change."];
  if(contract?.trainingDays!=null)requirements.push(`Return exactly ${contract.trainingDays} training days and ${7-contract.trainingDays} rest days.`);
  if(contract?.requireBaseDays)requirements.push(`Keep every existing training day: ${contract.baseTrainingDays.join(", ")}.`);
  if(contract?.preserveDays)requirements.push(`Use exactly these training days: ${contract.baseTrainingDays.join(", ")}.`);
  if(contract?.sessionMinutes!=null)requirements.push(`Every training day must estimate to the ${contract.sessionMinutes}-minute bucket.`);
  return `Plan edit contract (follow every requirement):\nBase source: ${String(source||"current plan")}\nBase schedule:\n${rows.join("\n")}\nRequirements:\n- ${requirements.join("\n- ")}\nEstimate a day as 2.5 minutes per working set plus 5 minutes, then use the nearest of 30, 45, 60, 75, or 90 minutes.`;
}

/** Explain the first contract mismatch, or return null. @param {any} contract @param {any} week */
function planEditIssue(contract,week){
  if(!contract)return null;if(!week)return "No weekly plan was returned for the requested edit.";
  const days=Array.isArray(week.trainingDays)?week.trainingDays:DAYS.filter((day)=>week?.plan?.days?.[day]?.length||week?.days?.some((/** @type {any} */ entry)=>entry.day===day));
  if(contract.trainingDays!=null&&days.length!==contract.trainingDays)return `The edit needs exactly ${contract.trainingDays} training days; the proposal has ${days.length}.`;
  if(contract.requireBaseDays){const missing=contract.baseTrainingDays.find((/** @type {string} */ day)=>!days.includes(day));if(missing)return `The edit must keep ${missing} while adding training days.`;}
  if(contract.preserveDays&&(days.length!==contract.baseTrainingDays.length||days.some((/** @type {string} */ day)=>!contract.baseTrainingDays.includes(day))))return "A session-length edit must keep the same training days.";
  if(contract.sessionMinutes!=null)for(const day of days){const summary=week?.days?.find((/** @type {any} */ entry)=>entry.day===day),sets=Number(summary?.workingSets)||daySets(week?.plan,day);if(bucket(minutes(sets))!==contract.sessionMinutes)return `${day} must estimate to the ${contract.sessionMinutes}-minute bucket.`;}
  return null;
}

module.exports={sanitizeDraftPlan,planExerciseIds,planEditContract,planEditContext,planEditIssue};
