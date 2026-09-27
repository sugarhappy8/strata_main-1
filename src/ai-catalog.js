// @ts-check
"use strict";

// Strata AI's view of the full 320-exercise library. A small local model cannot read every exercise
// in one request, so each request gets a shortlist: the best options per muscle group, plus every
// exercise, muscle, or piece of equipment the member names. The model may also ask for a search.

const {EXERCISES}=require("./plans");

/** @type {ReadonlyArray<readonly [string,string]>} */
const GROUPS=Object.freeze([["chest","CH"],["back","BK"],["shoulders","SH"],["arms","AR"],["legs","LG"],["glutes","GL"],["calves","CV"],["core","CR"]]);
/** @type {Record<string,number>} */
const LEVEL={beginner:1,intermediate:2,advanced:3,Beginner:1,Intermediate:2,Advanced:3};
const SHORTLIST=Object.freeze({perGroup:6,focusGroup:10,otherGroup:4,named:24,searched:16});

// Plain-language words members use, mapped to the library's groups, sub-muscles, and equipment.
/** @type {Array<[RegExp,{group?:string,sub?:string}]>} */
const MUSCLE_WORDS=[
  [/\bupper (?:chest|pecs?)\b/,{group:"chest",sub:"Upper chest"}],[/\b(?:chest|pecs?|pectorals?)\b/,{group:"chest"}],[/\bserratus\b/,{group:"chest",sub:"Serratus anterior"}],
  [/\blats?\b|\blatissimus\b|\bwidth\b/,{group:"back",sub:"Latissimus dorsi"}],[/\b(?:upper back|traps?|trapezius|rhomboids?)\b/,{group:"back",sub:"Upper back"}],[/\b(?:lower back|erectors?)\b/,{group:"back",sub:"Spinal erectors"}],[/\bback\b/,{group:"back"}],
  [/\b(?:side|lateral) delts?\b/,{group:"shoulders",sub:"Side delts"}],[/\b(?:front|anterior) delts?\b/,{group:"shoulders",sub:"Front delts"}],[/\b(?:rear|posterior) delts?\b/,{group:"shoulders",sub:"Rear delts"}],[/\brotator cuff\b/,{group:"shoulders",sub:"Rotator cuff"}],[/\b(?:shoulders?|delts?|deltoids?)\b/,{group:"shoulders"}],
  [/\b(?:biceps?|bis)\b/,{group:"arms",sub:"Biceps"}],[/\bbrachialis\b/,{group:"arms",sub:"Brachialis"}],[/\b(?:triceps?|tris)\b/,{group:"arms"}],[/\b(?:forearms?|grip|wrists?)\b/,{group:"arms",sub:"Forearms"}],[/\barms?\b/,{group:"arms"}],
  [/\b(?:quads?|quadriceps)\b/,{group:"legs",sub:"Quadriceps"}],[/\b(?:hamstrings?|hams)\b/,{group:"legs",sub:"Hamstrings"}],[/\b(?:adductors?|inner thighs?)\b/,{group:"legs",sub:"Adductors"}],[/\b(?:legs?|thighs?|lower body)\b/,{group:"legs"}],
  [/\bglute (?:med|medius|min)\b|\bhip abduct/,{group:"glutes",sub:"Glute med / min"}],[/\b(?:glutes?|butt|booty|hips?)\b/,{group:"glutes"}],
  [/\b(?:tibialis|shins?)\b/,{group:"calves",sub:"Tibialis anterior"}],[/\bsoleus\b/,{group:"calves",sub:"Soleus"}],[/\b(?:calf|calves)\b/,{group:"calves"}],
  [/\bobliques?\b/,{group:"core",sub:"Obliques"}],[/\b(?:abs|abdominals?|six pack|core|midsection)\b/,{group:"core"}]
];
/** @type {Array<[RegExp,string]>} */
const EQUIPMENT_WORDS=[[/\b(?:dumbbells?|dbs?)\b/,"Dumbbells"],[/\b(?:barbells?|smith|ez ?bar)\b/,"Barbell / Smith"],[/\bmachines?\b/,"Machine"],[/\bcables?\b/,"Cables"],[/\b(?:bodyweight|body weight|calisthenics|no equipment)\b/,"Bodyweight"],[/\b(?:bands?|resistance bands?)\b/,"Resistance band"],[/\bbench\b/,"Bench"]];
// Named splits describe the whole week, so their muscle words must not narrow the shortlist.
const SPLIT=/\b(?:push\W*pull(?:\W*legs?)?|ppl|upper\W*lower|full\W*body|total\W*body|bro\W*split)\b/;
const RESTRICT=/\b(?:only|just|nothing but|no gym|at home|home workout|home gym|hotel|travel(?:ling|ing)?)\b/;
const GENERIC=new Set(["with","and","the","a","to","on","of","one","single","arm","leg","seated","standing","lying","machine","cable","dumbbell","barbell","band","resistance","smith","ez","bar","bench","bodyweight","assisted","alternating","incline","decline","flat","press","raise","row","curl","extension","fly","squat"]);

/** Singular form for matching, so "presses", "squats", and "raises" match "press", "squat", and "raise". @param {string} word */
function singular(word){
  if(word.length<4||/(?:ss|us|is)$/.test(word))return word;
  if(/(?:ss|x|ch|sh)es$/.test(word))return word.slice(0,-2);
  return word.endsWith("s")?word.slice(0,-1):word;
}
/** @param {unknown} value */
function normalize(value){return String(value??"").toLowerCase().replace(/[’']/g,"").replace(/[^a-z0-9]+/g," ").trim().split(" ").map(singular).join(" ");}
/** @param {string} value */
function bigrams(value){const words=value.split(" ").filter(Boolean);return words.slice(1).map((word,index)=>`${words[index]} ${word}`);}

const INDEX=EXERCISES.map((/** @type {any} */ exercise)=>{const name=normalize(exercise.name);return {exercise,name,words:new Set(name.split(" ")),pairs:new Set(bigrams(name))};});
/** @type {Map<string,number>} */
const WORD_COUNT=new Map();
for(const entry of INDEX)for(const word of entry.words)WORD_COUNT.set(word,(WORD_COUNT.get(word)||0)+1);
/** @type {Map<string,any>} */
const BY_NAME=new Map(INDEX.map((entry)=>[entry.name,entry.exercise]));

/** The library exercise with this exact name, ignoring case, punctuation, and plurals. @param {unknown} value */
function exerciseByName(value){return BY_NAME.get(normalize(value))??null;}

/**
 * What a member's words ask for: muscle groups and sub-muscles, equipment (and whether it is the only
 * equipment available), and library exercises named in full or by a distinctive part of their name.
 * @param {unknown} value
 */
function readRequest(value){
  const raw=String(value??"").toLowerCase(),words=normalize(value),wordSet=new Set(words.split(" ")),pairSet=new Set(bigrams(words));
  /** @type {Set<string>} */ const groups=new Set();/** @type {Set<string>} */ const subs=new Set();/** @type {Set<string>} */ const equipment=new Set();
  const focusText=raw.replace(SPLIT," ");
  for(const [pattern,target] of MUSCLE_WORDS)if(pattern.test(focusText)){if(target.group)groups.add(target.group);if(target.sub)subs.add(target.sub);}
  for(const [pattern,name] of EQUIPMENT_WORDS)if(pattern.test(raw))equipment.add(name);
  const scored=[];
  for(const entry of INDEX){
    let score=0;
    if(entry.name.length>3&&` ${words} `.includes(` ${entry.name} `))score=100;
    else{
      const shared=[...entry.pairs].filter((pair)=>pairSet.has(pair)&&!pair.split(" ").every((word)=>GENERIC.has(word)));
      if(shared.length)score=40+shared.length*10;
      else if([...entry.words].some((word)=>word.length>=5&&!GENERIC.has(word)&&(WORD_COUNT.get(word)||0)<=3&&wordSet.has(word)))score=25;
    }
    if(score)scored.push({exercise:entry.exercise,score:score+Number(entry.exercise.score)/100});
  }
  scored.sort((a,b)=>b.score-a.score);
  const top=scored.slice(0,SHORTLIST.named);
  return {groups:[...groups],subs:[...subs],equipment:[...equipment],onlyEquipment:equipment.size>0&&RESTRICT.test(raw),named:top.map((item)=>String(item.exercise.id)),exact:top.filter((item)=>item.score>=100).map((item)=>String(item.exercise.id))};
}

/** @param {any} exercise @param {string[]} blocked */
function allowedByLimits(exercise,blocked){return !blocked.some((trait)=>Array.isArray(exercise.traits)&&exercise.traits.includes(trait));}

/**
 * The shortlist for one request, with short codes grouped by muscle. Movement limits always apply;
 * equipment and experience shape the default picks. Exercises the member names in full are always offered;
 * partial matches rank first when they suit the member's equipment and experience.
 * @param {{equipment?:string[],limitations?:string[],experience?:string,pinned?:string[],request?:string,extra?:string[],perGroup?:number}} [options]
 */
function candidateExercises({equipment=[],limitations=[],experience="intermediate",pinned=[],request="",extra=[],perGroup=SHORTLIST.perGroup}={}){
  const wants=readRequest(request),blocked=limitations.map((item)=>String(item).replace(/^no-/,"")),level=LEVEL[experience]??2;
  const allowedEquipment=new Set(wants.onlyEquipment?[...wants.equipment,"Bodyweight"]:equipment),preferred=new Set(wants.equipment);
  const focus=new Set([...wants.groups]),subs=new Set(wants.subs),always=new Set([...pinned,...wants.exact,...extra]),partial=new Set(wants.named);
  /** @type {Array<{code:string,id:string,name:string,group:string,sub:string,equipment:string,reps:string}>} */
  const list=[];
  for(const [group,prefix] of GROUPS){
    const limit=focus.size?(focus.has(group)?Math.max(perGroup,SHORTLIST.focusGroup):Math.min(perGroup,SHORTLIST.otherGroup)):perGroup;
    const rank=(/** @type {any} */ exercise)=>Number(exercise.score)+(partial.has(exercise.id)?60:0)+(subs.has(exercise.sub)?40:0)+(preferred.has(exercise.equipment)?20:0);
    const pool=EXERCISES.filter((/** @type {any} */ exercise)=>exercise.group===group&&allowedByLimits(exercise,blocked)).sort((/** @type {any} */ a,/** @type {any} */ b)=>rank(b)-rank(a)||a.name.localeCompare(b.name));
    /** @type {any[]} */
    const eligible=pool.filter((/** @type {any} */ exercise)=>(LEVEL[exercise.level]??3)<=level&&(!allowedEquipment.size||allowedEquipment.has(exercise.equipment)));
    // Named and pinned exercises never count against the group's share of default picks.
    /** @type {any[]} */
    const defaults=[];
    const named=pool.filter((/** @type {any} */ exercise)=>always.has(exercise.id)),types=new Set();
    for(const exercise of eligible){if(defaults.length>=Math.min(limit,4))break;if(!always.has(exercise.id)&&!types.has(exercise.equipment)){defaults.push(exercise);types.add(exercise.equipment);}}
    for(const exercise of eligible){if(defaults.length>=limit)break;if(!always.has(exercise.id)&&!defaults.includes(exercise))defaults.push(exercise);}
    const picked=[...named,...defaults];
    picked.forEach((exercise,index)=>list.push({code:`${prefix}${index+1}`,id:String(exercise.id),name:String(exercise.name),group,sub:String(exercise.sub),equipment:String(exercise.equipment),reps:String(exercise.reps)}));
  }
  return list;
}

/** Library exercises for the model's own search terms, never including ones the member's limits exclude. @param {unknown} terms @param {string[]} limitations */
function searchCatalog(terms,limitations=[]){
  const blocked=limitations.map((item)=>String(item).replace(/^no-/,"")),words=(Array.isArray(terms)?terms:[terms]).map((term)=>String(term??"").slice(0,60)).slice(0,6).join(" . ");
  const found=readRequest(words),ids=new Set(found.named);
  if(found.subs.length||found.groups.length){
    for(const exercise of EXERCISES.filter((/** @type {any} */ item)=>found.subs.length?found.subs.includes(item.sub):found.groups.includes(item.group)).sort((/** @type {any} */ a,/** @type {any} */ b)=>b.score-a.score)){if(ids.size>=SHORTLIST.searched)break;ids.add(String(exercise.id));}
  }
  return [...ids].filter((id)=>{const exercise=EXERCISES.find((/** @type {any} */ item)=>item.id===id);return exercise&&allowedByLimits(exercise,blocked);}).slice(0,SHORTLIST.searched);
}

module.exports={SHORTLIST,allowedByLimits,candidateExercises,exerciseByName,normalize,readRequest,searchCatalog};
