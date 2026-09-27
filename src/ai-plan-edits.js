// @ts-check
"use strict";

const {DAYS,EXERCISES,sanitizePlan}=require("./plans");
const {readRequest}=require("./ai-catalog");

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
/** Choose a balanced schedule while preserving the current days when adding, or only removing from them. @param {string[]} base @param {number} count */
function balancedDays(base,count){
  const required=new Set(base),adding=count>=base.length;/** @type {string[]|null} */ let best=null;/** @type {[number,number,number]|null} */ let bestScore=null;
  for(let mask=1;mask<128;mask++){
    const days=DAYS.filter((_,index)=>Boolean(mask&(1<<index)));
    if(days.length!==count||adding&&base.some((day)=>!days.includes(day))||!adding&&days.some((day)=>!required.has(day)))continue;
    const set=new Set(days);let run=0,longest=0;
    for(let index=0;index<14;index++){const day=DAYS[index%7];run=day&&set.has(day)?run+1:0;longest=Math.max(longest,run);}
    const rest=DAYS.map((_,index)=>index).filter((index)=>!(mask&(1<<index))),gaps=rest.map((index,position)=>((rest[(position+1)%rest.length]??index)+7-index)%7),imbalance=Math.max(...gaps)-Math.min(...gaps);
    /** @type {[number,number,number]} */ const score=[longest,imbalance,mask];
    if(!bestScore||score[0]<bestScore[0]||score[0]===bestScore[0]&&(score[1]<bestScore[1]||score[1]===bestScore[1]&&score[2]<bestScore[2])){best=days;bestScore=score;}
  }
  return best;
}

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
const FALLBACK_WORDS=new Set("i would like want need have only exactly just please can could will you give me make set it my the a an to do build train training work out workout workouts rest recovery off session sessions duration minute minutes min mins day days week plan split routine longer lengthen increase extend shorter shorten decrease reduce cut add remove drop more extra additional fewer less each every per about by and with".split(" "));
const VERIFIED_WORDS=new Set([...FALLBACK_WORDS,..."using at home hotel travel travelling traveling dumbbell dumbbells db dbs barbell barbells smith ez bar machine machines cable cables bodyweight weight calisthenics no equipment band bands resistance bench nothing but".split(" ")]);
/** Only allowlisted language may use server-owned deterministic behavior. @param {string} value @param {Set<string>} allowed */
function wordsOnly(value,allowed){return value.replace(/i['’]d/g,"i would").replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).every((word)=>/^\d+$/.test(word)||allowed.has(word));}

/** Convert plain-language schedule edits into requirements that can be checked after generation. @param {unknown} message @param {any} basePlan */
function planEditContract(message,basePlan){
  const text=numbered(String(message??"")),baseDays=trainingDays(basePlan),baseCount=baseDays.length;
  if(/\b(?:pain(?:ful)?|hurts?|injur(?:y|ies|ed)|pregnan(?:t|cy)|medicat(?:e|ed|ions?)|eating disorders?|diagnos(?:e|is)|medical conditions?)\b/.test(text))return null;
  const trainingDelta=dayDelta(text,"training"),restDelta=dayDelta(text,"rest"),genericDelta=genericDayDelta(text),deltas=[trainingDelta,restDelta?-restDelta:0,genericDelta].filter(Boolean);
  if(new Set(deltas).size>1)return null;
  let requestedDays=null,scheduleRequested=false;
  if(baseCount&&deltas.length){requestedDays=Math.max(1,Math.min(6,baseCount+(deltas[0]??0)));scheduleRequested=true;}
  if(requestedDays==null){
    const rest=/(?:\b(?:only|exactly|want|need|have)\s+)?([1-6])\s+(?:rest|recovery|off)\s+days?\b|\b([1-6])\s+days?\s+off\b/.exec(text);
    const active=/(?:\b(?:train|work\s*out)\s+(?:on\s+)?([1-6])\s+days?\b)|(?:\b([1-6])\s+(?:training|workout)\s+days?\b)|(?:\b([1-6])\s+days?\s+(?:a|per)\s+week\b)|(?:\b([1-6])\s*[- ]\s*day\b(?=[^.]{0,50}\b(?:plan|week|split|routine)\b))|(?:\b([1-6])\s+workouts?\s+(?:a|per)\s+week\b)/.exec(text);
    if(rest){requestedDays=7-Number(rest[1]||rest[2]);scheduleRequested=true;}else if(active){requestedDays=Number(active.slice(1).find(Boolean));scheduleRequested=true;}
  }
  const longer=/\b(?:longer|lengthen|increase|extend)\b/.test(text)&&/\b(?:sessions?|workouts?|duration|minutes?)\b/.test(text);
  const shorter=/\b(?:shorter|shorten|decrease|reduce|cut)\b/.test(text)&&/\b(?:sessions?|workouts?|duration|minutes?)\b/.test(text);
  const current=baseCount?scheduleBucket(basePlan):null;let requestedMinutes=null,durationRequested=false;
  const positiveDelta=/\b(?:increase|extend|lengthen)\b[^.]{0,40}?\bby\s+([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\b|\badd\s+([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\s+to\s+(?:each|every|the|my)?\s*(?:sessions?|workouts?)\b|\b([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\s+longer\b/.exec(text);
  const negativeDelta=/\b(?:decrease|reduce|shorten|cut)\b[^.]{0,40}?\bby\s+([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\b|\b(?:cut|remove)\s+([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\s+from\s+(?:each|every|the|my)?\s*(?:sessions?|workouts?)\b|\b([1-9][0-9]{0,2})\s*(?:minutes?|mins?)\s+shorter\b/.exec(text);
  const explicit=/\b([1-9][0-9]{1,2})\s*(?:-|\s)?(?:minutes?|mins?)\b/.exec(text),nutrition=/\b(?:calories?|macros?|nutrition|meals?|food)\b/.test(text),scope=scheduleRequested||!nutrition&&(/\b(?:sessions?|workouts?|training|plan|week|split|routine)\b/.test(text)||baseCount>0&&/\b(?:make|change|set|want|need|have|each|every|about)\b/.test(text));
  if(current&&(positiveDelta||negativeDelta)){const match=positiveDelta||negativeDelta,delta=Number(match?.slice(1).find(Boolean));requestedMinutes=bucket(current+(positiveDelta?delta:-delta));durationRequested=true;}
  else if(explicit&&scope){requestedMinutes=bucket(Number(explicit[1]));durationRequested=true;}
  else if(current&&(longer||shorter)){requestedMinutes=longer?nextBucket(current):previousBucket(current);durationRequested=true;}
  if(!scheduleRequested&&!durationRequested)return null;
  const preserveDays=durationRequested&&!scheduleRequested&&baseCount>0,requireBaseDays=requestedDays!=null&&requestedDays>baseCount&&baseCount>0,mentionsDay=DAYS.some((day)=>new RegExp(`\\b${day}\\b`,"i").test(text)),wants=readRequest(text),equipmentOnly=wants.onlyEquipment?[...new Set([...wants.equipment,"Bodyweight"])]:null;
  const targetTrainingDays=preserveDays?baseDays:requestedDays!=null&&!mentionsDay?balancedDays(baseDays,requestedDays):null;
  const fallbackSafe=wordsOnly(text,FALLBACK_WORDS),replySafe=fallbackSafe||Boolean(equipmentOnly?.length&&wordsOnly(text,VERIFIED_WORDS));
  return {trainingDays:requestedDays,sessionMinutes:requestedMinutes,preserveDays,requireBaseDays,baseTrainingDays:baseDays,targetTrainingDays,equipmentOnly,fallbackSafe,replySafe,direction:scheduleRequested&&durationRequested?"mixed":scheduleRequested?"schedule":"duration"};
}

/** Complete base-plan context plus requirements for the model. @param {{basePlan:any,source?:unknown,candidates?:any[],contract:any}} input */
function planEditContext({basePlan,source,candidates=[],contract}){
  const codes=new Map(candidates.map((item)=>[String(item.id),String(item.code)]));
  const rows=DAYS.map((day)=>{const items=basePlan?.days?.[day]||[];return `${day}: ${items.length?items.map((/** @type {any} */ item)=>`${codes.get(String(item.exerciseId))||EXERCISE_BY_ID.get(String(item.exerciseId))?.name||item.exerciseId} ${item.sets}x${item.reps}`).join("; "):"NO WORKOUT — omit from week.days"}`;});
  if(!contract)return `Proposed week under discussion (reference only):\nBase source: ${String(source||"current plan")}\nBase schedule:\n${rows.join("\n")}\nUse this week as context. Return a complete replacement week only when the current message asks to change it; otherwise answer normally.`;
  const requirements=["Return a complete replacement week. Preserve details the member did not ask to change."];
  if(contract?.trainingDays!=null)requirements.push(`Return exactly ${contract.trainingDays} training days and ${7-contract.trainingDays} rest days.`);
  if(contract?.targetTrainingDays?.length)requirements.push(`Use exactly these training days: ${contract.targetTrainingDays.join(", ")}. Omit ${DAYS.filter((day)=>!contract.targetTrainingDays.includes(day)).join(", ")} from week.days because omitted days are rest days.`);
  else if(contract?.requireBaseDays)requirements.push(`Keep every existing training day: ${contract.baseTrainingDays.join(", ")}.`);
  if(contract?.equipmentOnly?.length)requirements.push(`Use only this equipment: ${contract.equipmentOnly.join(", ")}.`);
  if(contract?.sessionMinutes!=null)requirements.push(`Every training day must estimate to the ${contract.sessionMinutes}-minute bucket.`);
  return `Plan edit contract (follow every requirement):\nBase source: ${String(source||"current plan")}\nBase schedule:\n${rows.join("\n")}\nRequirements:\n- ${requirements.join("\n- ")}\nEstimate a day as 2.5 minutes per working set plus 5 minutes, then use the nearest of 30, 45, 60, 75, or 90 minutes.`;
}

/** Explain the first contract mismatch, or return null. @param {any} contract @param {any} week */
function planEditIssue(contract,week){
  if(!contract)return null;if(!week)return "No weekly plan was returned for the requested edit.";
  const days=Array.isArray(week.trainingDays)?week.trainingDays:DAYS.filter((day)=>week?.plan?.days?.[day]?.length||week?.days?.some((/** @type {any} */ entry)=>entry.day===day));
  if(contract.trainingDays!=null&&days.length!==contract.trainingDays)return `The edit needs exactly ${contract.trainingDays} training days; the proposal has ${days.length}.`;
  if(contract.targetTrainingDays?.length&&(days.some((/** @type {string} */ day)=>!contract.targetTrainingDays.includes(day))||contract.targetTrainingDays.some((/** @type {string} */ day)=>!days.includes(day))))return `Use exactly these training days: ${contract.targetTrainingDays.join(", ")}.`;
  if(contract.requireBaseDays){const missing=contract.baseTrainingDays.find((/** @type {string} */ day)=>!days.includes(day));if(missing)return `The edit must keep ${missing} while adding training days.`;}
  if(contract.preserveDays&&(days.length!==contract.baseTrainingDays.length||days.some((/** @type {string} */ day)=>!contract.baseTrainingDays.includes(day))))return "A session-length edit must keep the same training days.";
  if(contract.equipmentOnly?.length)for(const day of days)for(const item of week?.plan?.days?.[day]||[]){const equipment=EXERCISE_BY_ID.get(String(item.exerciseId))?.equipment;if(!contract.equipmentOnly.includes(equipment))return `${day} must use only ${contract.equipmentOnly.join(" or ")}.`;}
  if(contract.sessionMinutes!=null)for(const day of days){const summary=week?.days?.find((/** @type {any} */ entry)=>entry.day===day),sets=Number(summary?.workingSets)||daySets(week?.plan,day);if(bucket(minutes(sets))!==contract.sessionMinutes)return `${day} must estimate to the ${contract.sessionMinutes}-minute bucket.`;}
  return null;
}

/** Server-owned wording cannot contradict a plan that passed the measurable edit contract. @param {any} contract @param {any} week */
function planEditReply(contract,week){const days=week?.trainingDays||[];if(contract?.trainingDays!=null&&contract?.sessionMinutes!=null)return `Updated to ${days.length} training days and about ${contract.sessionMinutes} minutes per session. Want matching calorie targets?`;if(contract?.trainingDays!=null)return `Updated to ${days.length} training days with ${7-days.length} rest days: ${days.join(", ")}. Want matching calorie targets?`;return `Updated your sessions to about ${contract.sessionMinutes} minutes on ${days.join(", ")}. Want matching calorie targets?`;}

module.exports={sanitizeDraftPlan,planExerciseIds,planEditContract,planEditContext,planEditIssue,planEditReply};
