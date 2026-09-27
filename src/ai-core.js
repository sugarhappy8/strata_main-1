// @ts-check
"use strict";

// Strata AI's rules: what the model is told, and how its JSON is checked before anything reaches
// the page. Nothing here saves data; the page applies proposals through the existing plan and
// personal-setup APIs, which validate everything again.

const {DAYS,EXERCISES,sanitizePlan}=require("./plans");
const {currentWeekStart,generateCoachingWeek,sanitizeCoachingProfile}=require("./coaching-core");
const {allowedByLimits,exerciseByName}=require("./ai-catalog");

const LIMITS=Object.freeze({messageChars:1200,historyTurns:6,replyChars:900,suggestions:3,textChars:240,minExercises:2,maxExercises:8,maxSets:6,maxDaySets:30,promptChars:10500,searchTerms:6});
const SESSION_MINUTES=Object.freeze([30,45,60,75,90]);
const CHOICES=Object.freeze({focus:["balanced","strength","hypertrophy"],goal:["fat_loss","maintenance","muscle_gain"],pace:["gentle","moderate"],pattern:["steady","zigzag","flexible_day"],macros:["balanced","higher_protein"]});
/** @type {Map<string,any>} */
const EXERCISE_BY_ID=new Map(EXERCISES.map((/** @type {any} */ exercise)=>[exercise.id,exercise]));

/** @param {string} code @param {string} message @param {number} [status] */
function aiError(code,message,status=502){return Object.assign(new Error(message),{code,status});}
/** Plain single-line text: control, zero-width, and direction characters become spaces. @param {unknown} value @param {number} max */
function text(value,max){return String(value??"").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g," ").replace(/\s+/g," ").trim().slice(0,max);}
/** @template T @param {unknown} value @param {readonly T[]} allowed @returns {T|null} */
function pick(value,allowed){const found=allowed.find((item)=>item===value);return found===undefined?null:found;}
/** @param {unknown} value */
function dayName(value){const raw=String(value??"").trim().toLowerCase();return DAYS.find((day)=>day.toLowerCase()===raw||day.slice(0,3).toLowerCase()===raw)??null;}
/** @param {number} value */
function nearestSessionMinutes(value){return SESSION_MINUTES.reduce((best,option)=>Math.abs(option-value)<Math.abs(best-value)?option:best,45);}
/** About 2.5 minutes per working set including rest, plus a 5-minute warm-up. @param {number} sets */
function estimatedMinutes(sets){return sets>0?Math.round(sets*2.5+5):0;}
/** Normalizes rep targets such as "8-12", "8 to 12", "30-45 s", or "10-12 / side". @param {unknown} value @param {string} fallback */
function repsText(value,fallback){
  const match=/^(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s*(s|sec|secs|seconds)?\s*(\/\s*side|per side|each side)?$/i.exec(String(value??"").trim());
  if(!match)return fallback;
  const low=Number(match[1]),high=match[2]?Number(match[2]):null;
  if(low<1||low>100||(high!=null&&(high<low||high>100)))return fallback;
  return `${low}${high!=null?`–${high}`:""}${match[3]?" s":""}${match[4]?" / side":""}`;
}

/** Plan rows in day order, with names, for context and swaps. @param {any} plan */
function planItems(plan){
  /** @type {Array<{day:string,instanceId:string,exerciseId:string,name:string,sets:number,reps:string}>} */
  const rows=[];
  for(const day of DAYS)for(const item of Array.isArray(plan?.days?.[day])?plan.days[day]:[]){const exercise=EXERCISE_BY_ID.get(item.exerciseId);if(exercise)rows.push({day,instanceId:String(item.instanceId),exerciseId:exercise.id,name:exercise.name,sets:Number(item.sets),reps:String(item.reps)});}
  return rows;
}

/** The training days and typical session length of a saved plan, or null when it has none. @param {any} plan */
function planSchedule(plan){
  const days=DAYS.filter((day)=>Array.isArray(plan?.days?.[day])&&plan.days[day].length>0);
  if(days.length<1||days.length>6)return null;
  const sets=days.map((day)=>plan.days[day].reduce((/** @type {number} */ sum,/** @type {any} */ item)=>sum+(Number(item.sets)||0),0));
  return {workoutDays:days,sessionMinutes:nearestSessionMinutes(estimatedMinutes(sets.reduce((sum,value)=>sum+value,0)/days.length))};
}

/** @param {unknown} value */
function goalLabel(value){return value==="fat_loss"?"fat loss":value==="muscle_gain"?"muscle gain":"maintenance";}

/**
 * A compact, factual summary of the member for the model. Numbers come from STRATA, not the model,
 * and the summary never includes the member's name, email, or account id.
 * @param {{profile?:any,plan?:any,workouts?:any[],nutrition?:any,today?:string}} input
 */
function memberContext({profile=null,plan=null,workouts=[],nutrition=null,today=""}){
  const lines=[];
  if(today)lines.push(`Today is ${today}.`);
  if(profile){
    lines.push(`Personal setup: ${profile.experience} lifter; training focus ${profile.trainingGoal}; nutrition goal ${goalLabel(profile.goal)} (${profile.goalPace} pace); calorie pattern ${String(profile.caloriePattern).replace("_"," ")}; macros ${profile.macroPreference?String(profile.macroPreference).replace("_"," "):"not tracked"}.`);
    lines.push(`Schedule on file: ${profile.workoutDays.join(", ")}, ${profile.sessionMinutes} minutes each.`);
    lines.push(`Equipment: ${profile.availableEquipment?.length?profile.availableEquipment.join(", "):"any"}. Movement limits: ${profile.movementLimitations?.length?profile.movementLimitations.join(", "):"none"}.`);
  }else lines.push("No personal setup yet, so experience, equipment, and body data are unknown. Calorie targets need the personal setup first.");
  const items=planItems(plan);
  if(items.length){
    const days=DAYS.map((day)=>{const rows=items.filter((item)=>item.day===day);return rows.length?`${day}: ${rows.slice(0,8).map((item)=>`${item.name} ${item.sets}x${item.reps}`).join(", ")}`:"";}).filter(Boolean);
    lines.push(`Saved weekly plan. ${days.join(". ")}. Other days are rest.`);
  }else lines.push("Saved weekly plan: empty.");
  const done=workouts.filter((workout)=>workout?.status==="completed");
  lines.push(done.length?`Completed workouts in the last 28 days: ${done.length}.`:"No completed workouts in the last 28 days.");
  if(nutrition){
    const parts=[];
    if(nutrition.averageTarget)parts.push(`average target ${nutrition.averageTarget} kcal/day`);
    parts.push(`${nutrition.loggedDays} of the last 7 days logged${nutrition.averageIntake?`, averaging ${nutrition.averageIntake} kcal`:""}`);
    if(nutrition.weeklyWeightChangeKg!=null)parts.push(`morning weight changing ${nutrition.weeklyWeightChangeKg>0?"+":""}${nutrition.weeklyWeightChangeKg} kg per week`);
    lines.push(`Nutrition: ${parts.join("; ")}.`);
  }
  return lines.join("\n");
}

const RULES=`You are Strata AI, the planning assistant inside STRATA, a strength-training app. You help one member plan training and nutrition and give practical suggestions.
Safety: you are not a doctor or dietitian. Do not diagnose, treat pain or injury, or advise on pregnancy, medication, or eating disorders. Suggest a qualified professional instead and do not propose a plan in that case.
Answer with exactly one JSON object and nothing else: {"reply":"...","week":null,"nutrition":null,"suggestions":[],"search":[]}
reply: at most 90 words, warm and plain, no markdown.
week: only when the member asks for a new or changed weekly plan. Shape: {"title":"...","focus":"balanced|strength|hypertrophy","days":[{"day":"Monday","name":"Upper body","exercises":[{"code":"CH1","sets":3,"reps":"8-12"}]}]}
Exercises: STRATA's library has 320 exercises. The list below is a shortlist chosen for this request. Use its codes. For another STRATA exercise the member asks for by name, write {"name":"exact exercise name","sets":3,"reps":"8-12"} instead of a code.
Search: if the member wants exercises that are not in the shortlist, reply briefly, leave week empty, and put up to 6 short search words in "search" (for example ["landmine press","nordic curl"]). STRATA will send matching exercises.
Week rules: 1 to 6 training days; days you leave out are rest days. 3 to 7 exercises per training day, never the same exercise twice in a day. Match the member's time with working sets per day: 30 min about 10, 45 min about 16, 60 min about 22, 75 min about 28, 90 min about 34. Cover every major muscle group across the week unless the member asks for a focus. Respect the member's equipment and movement limits.
nutrition: only when the member asks about calories or eating, or accepts your offer. Shape: {"goal":"fat_loss|maintenance|muscle_gain","pace":"gentle|moderate","pattern":"steady|zigzag|flexible_day","flexibleDay":"Saturday" or null,"macros":"balanced|higher_protein" or null}. Never state calorie numbers; STRATA calculates them.
After proposing a week, end the reply by offering matching calorie targets, unless nutrition was already discussed.
suggestions: up to 3 short, specific tips based on the member's data, as {"text":"..."}. To replace an exercise in the saved plan add "swap":{"day":"Monday","from":"exact exercise name from the saved plan","to":"CODE or exact exercise name"}.`;

const SUGGESTION_REQUEST="Review my saved plan and my recent training and nutrition, then give me up to 3 specific suggestions.";

/** The member's recent words, used to choose the exercise shortlist. @param {{kind:string,message?:string,history?:Array<{role:string,content:string}>}} input */
function requestText({kind,message="",history=[]}){
  if(kind==="suggestions")return "";
  return [...history.filter((turn)=>turn.role==="user").slice(-2).map((turn)=>turn.content),message].join(" \n ");
}

/**
 * Builds the chat for the model, trimming history and then the default shortlist to fit a small context.
 * Exercises the member named, and exercises found by a search, are never trimmed.
 * @param {{kind:"chat"|"suggestions",message?:string,history?:Array<{role:string,content:string}>,context:string,candidates:Array<{code:string,id:string,name:string,sub:string,equipment:string,reps:string,group:string}>,keep?:Set<string>,note?:string,compact?:boolean}} input
 */
function promptMessages({kind,message="",history=[],context,candidates,keep=new Set(),note="",compact=false}){
  const exerciseLines=(/** @type {typeof candidates} */ list)=>list.map((item)=>`${item.code} ${item.name} (${item.sub}; ${item.equipment}; ${item.reps})`).join("\n");
  const question=kind==="suggestions"?SUGGESTION_REQUEST:text(message,LIMITS.messageChars);
  let turns=compact?[]:history.slice(-LIMITS.historyTurns),list=candidates;
  const build=()=>[{role:"system",content:`${RULES}\n\nMember data:\n${context}\n\nShortlist (code name (target; equipment; typical reps)):\n${exerciseLines(list)}${note?`\n\n${note}`:""}`},...turns,{role:"user",content:question}];
  const size=()=>build().reduce((sum,item)=>sum+item.content.length,0);
  while(size()>LIMITS.promptChars&&turns.length)turns=turns.slice(2);
  // Compact prompts, used after the model server reports a context overflow, go straight to the smallest shortlist.
  for(const share of compact?[2]:[4,3,2]){
    if(!compact&&size()<=LIMITS.promptChars)break;
    const counts=new Map();
    list=candidates.filter((item)=>{if(keep.has(item.id))return true;const count=counts.get(item.group)||0;counts.set(item.group,count+1);return count<share;});
  }
  return build();
}

/**
 * Checks conversation history sent by the page. Only alternating member and assistant text is kept,
 * and the model always sees the member speak first.
 * @param {unknown} value
 */
function sanitizeHistory(value){
  if(value==null)return [];
  const invalid=()=>aiError("AI_INVALID_REQUEST","The conversation history is invalid. Start a new conversation.",400);
  if(!Array.isArray(value)||value.length>LIMITS.historyTurns*2)throw invalid();
  /** @type {Array<{role:"user"|"assistant",content:string}>} */
  const turns=[];
  for(const entry of value){
    if(!entry||typeof entry!=="object"||Array.isArray(entry))throw invalid();
    const role=entry.role==="assistant"?"assistant":entry.role==="user"?"user":null,content=text(entry.content,LIMITS.messageChars);
    if(!role||!content)throw invalid();
    if(!turns.length&&role==="assistant")continue;
    if(turns.at(-1)?.role===role)continue;
    turns.push({role,content});
  }
  if(turns.at(-1)?.role==="user")turns.pop();
  return turns;
}

/**
 * Resolves one exercise reference from the model: a shortlist code, or the exact name of any library
 * exercise. Movement limits apply either way.
 * @param {any} raw @param {Map<string,any>} byCode @param {string[]} limitations
 */
function resolveExercise(raw,byCode,limitations){
  const byCodeMatch=byCode.get(String(raw?.code??"").trim().toUpperCase())??byCode.get(String(raw?.name??"").trim().toUpperCase());
  if(byCodeMatch)return byCodeMatch;
  const named=exerciseByName(raw?.name??raw?.code);
  if(!named||!allowedByLimits(named,limitations.map((item)=>String(item).replace(/^no-/,""))))return null;
  return {id:String(named.id),name:String(named.name),group:String(named.group),reps:String(named.reps)};
}

/** @param {any} value @param {Map<string,any>} byCode @param {string[]} limitations */
function interpretWeek(value,byCode,limitations){
  if(!value||typeof value!=="object"||!Array.isArray(value.days))return {issue:"Strata AI described a week STRATA could not read. Ask again."};
  /** @type {Record<string,any[]>} */
  const days={};
  /** @type {any[]} */
  const summary=[];const notes=new Set();
  for(const entry of value.days.slice(0,7)){
    const day=dayName(entry?.day);
    if(!day||days[day])continue;
    const seen=new Set(),exercises=[];
    for(const raw of Array.isArray(entry?.exercises)?entry.exercises.slice(0,LIMITS.maxExercises+4):[]){
      const candidate=resolveExercise(raw,byCode,limitations);
      if(!candidate){notes.add("Exercises STRATA does not list, or that your movement limits exclude, were left out.");continue;}
      if(seen.has(candidate.id))continue;seen.add(candidate.id);
      const requested=Math.round(Number(raw?.sets)),sets=Number.isFinite(requested)?Math.min(LIMITS.maxSets,Math.max(1,requested)):3;
      exercises.push({exerciseId:candidate.id,name:candidate.name,group:candidate.group,sets,reps:repsText(raw?.reps,candidate.reps)});
      if(exercises.length>=LIMITS.maxExercises)break;
    }
    const workingSets=exercises.reduce((sum,item)=>sum+item.sets,0);
    if(exercises.length<LIMITS.minExercises||workingSets>LIMITS.maxDaySets){notes.add("A day that did not meet STRATA's limits was left out.");continue;}
    days[day]=exercises;summary.push({day,name:text(entry?.name,40)||`${day} workout`,exercises,workingSets,minutes:estimatedMinutes(workingSets)});
  }
  const trainingDays=DAYS.filter((day)=>days[day]);
  if(trainingDays.length<1||trainingDays.length>6)return {issue:"Strata AI's week did not pass STRATA's checks. Ask again, perhaps with fewer or simpler requirements."};
  const restDays=DAYS.filter((day)=>!days[day]);
  const plan=sanitizePlan({version:1,restDay:restDays[0]??null,restDays,days:Object.fromEntries(DAYS.map((day)=>[day,(days[day]||[]).map((item)=>({exerciseId:item.exerciseId,sets:item.sets,reps:item.reps}))]))});
  // Session length always comes from STRATA's estimate, so the week, Plan, and nutrition targets agree.
  const averageMinutes=estimatedMinutes(summary.reduce((sum,day)=>sum+day.workingSets,0)/summary.length),sessionMinutes=nearestSessionMinutes(averageMinutes);
  return {title:text(value.title,60)||"Your Strata AI week",focus:pick(value.focus,CHOICES.focus)??"balanced",sessionMinutes,averageMinutes,plan,days:DAYS.map((day)=>summary.find((item)=>item.day===day)).filter(Boolean),restDays,trainingDays,workingSets:summary.reduce((sum,day)=>sum+day.workingSets,0),notes:[...notes]};
}

/** @param {any} value */
function interpretNutrition(value){
  if(!value||typeof value!=="object")return null;
  const goal=pick(value.goal,CHOICES.goal);if(!goal)return null;
  const pattern=pick(value.pattern,CHOICES.pattern)??"steady",flexibleDay=pattern==="flexible_day"?dayName(value.flexibleDay)??"Saturday":null;
  return {goal,goalPace:pick(value.pace,CHOICES.pace)??"moderate",caloriePattern:pattern,flexibleDay,macroPreference:pick(value.macros,CHOICES.macros)};
}

/** @param {unknown} value @param {{byCode:Map<string,any>,plan:any,limitations:string[]}} context */
function interpretSuggestions(value,{byCode,plan,limitations}){
  if(!Array.isArray(value))return [];
  const items=planItems(plan);
  return value.slice(0,LIMITS.suggestions).map((raw,index)=>{
    const tip=text(typeof raw==="string"?raw:raw?.text,LIMITS.textChars);if(!tip)return null;
    const swap=raw&&typeof raw==="object"?raw.swap:null;let action=null;
    if(swap&&typeof swap==="object"){
      const day=dayName(swap.day),from=exerciseByName(swap.from),to=resolveExercise({code:swap.to,name:swap.to},byCode,limitations);
      const current=from&&items.find((item)=>item.exerciseId===from.id&&(!day||item.day===day));
      if(current&&to&&to.id!==current.exerciseId&&!items.some((item)=>item.day===current.day&&item.exerciseId===to.id))action={type:"swap",day:current.day,instanceId:current.instanceId,fromExerciseId:current.exerciseId,fromName:current.name,toExerciseId:to.id,toName:to.name,toReps:text(to.reps,20)||current.reps};
    }
    return {id:`s${index+1}`,text:tip,action};
  }).filter(Boolean);
}

/** Search words the model asked for, if it asked instead of answering. @param {any} data */
function searchTerms(data){
  if(!data||typeof data!=="object"||data.week||!Array.isArray(data.search))return [];
  return data.search.map((/** @type {unknown} */ term)=>text(term,60)).filter(Boolean).slice(0,LIMITS.searchTerms);
}

/**
 * Turns the model's JSON into proposals the page can show. Anything outside STRATA's rules is
 * dropped or rejected here; the page never receives an exercise STRATA does not know.
 * @param {any} data @param {{candidates:Array<{code:string}>,plan:any,limitations?:string[]}} context
 */
function interpretReply(data,{candidates,plan,limitations=[]}){
  if(!data||typeof data!=="object"||Array.isArray(data))throw aiError("AI_BAD_OUTPUT","Strata AI's answer could not be read. Try asking again.");
  const reply=text(data.reply,LIMITS.replyChars);
  if(!reply)throw aiError("AI_BAD_OUTPUT","Strata AI's answer could not be read. Try asking again.");
  const byCode=new Map(candidates.map((item)=>[item.code.toUpperCase(),item]));
  const week=data.week?interpretWeek(data.week,byCode,limitations):null;
  return {reply,week:week&&!("issue" in week)?week:null,weekIssue:week&&"issue" in week?week.issue:null,nutrition:interpretNutrition(data.nutrition),suggestions:interpretSuggestions(data.suggestions,{byCode,plan,limitations})};
}

/**
 * Calculates what a nutrition proposal would mean with STRATA's own energy model, without saving.
 * The setup's training schedule follows the saved plan so the calorie targets match real training.
 * @param {{profile:any,changes:any,plan:any,evidence:any,timestamp:number}} input
 */
function previewNutrition({profile,changes,plan,evidence,timestamp}){
  /** @type {Record<string,any>} */
  const input={...profile,goal:changes.goal,goalPace:changes.goalPace,caloriePattern:changes.caloriePattern,flexibleDay:changes.flexibleDay,macroPreference:changes.macroPreference};
  delete input.revision;delete input.updatedAt;delete input.sessionsPerWeek;
  const schedule=planSchedule(plan),aligned=Boolean(schedule&&(schedule.workoutDays.join()!==profile.workoutDays.join()||schedule.sessionMinutes!==profile.sessionMinutes));
  if(schedule){input.workoutDays=schedule.workoutDays;input.sessionMinutes=schedule.sessionMinutes;}
  const sanitized=/** @type {Record<string,any>} */(sanitizeCoachingProfile(/** @type {any} */(input))),weekStart=currentWeekStart(timestamp,sanitized.timeZone);
  const week=generateCoachingWeek(/** @type {any} */(sanitized),Number(profile.revision)+1,weekStart,timestamp,evidence),nutrition=week.nutrition;
  const saved={...sanitized};delete saved.sessionsPerWeek;
  return {changes,alignment:aligned&&schedule?schedule:null,profile:saved,expectedRevision:Number(profile.revision),preview:{selectedGoal:nutrition.selectedGoal,maintenance:{targetKcal:nutrition.maintenance?.targetKcal??null},dailyTargets:nutrition.dailyTargets}};
}

module.exports={LIMITS,SESSION_MINUTES,aiError,estimatedMinutes,interpretReply,memberContext,planItems,planSchedule,previewNutrition,promptMessages,repsText,requestText,sanitizeHistory,searchTerms};
