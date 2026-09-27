(function(root,factory){
  const selection=typeof module==="object"&&module.exports?require("./session-selection-core"):root.StrataSessionSelection;
  const api=factory(selection);
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscovery=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(SessionSelection){
  "use strict";

  const FACTOR_KEYS=["stimulus","range","stability","progression","fatigue"];
  const TRAIT_KEYS=["compound","isolation","unilateral","overhead","deep-knee","unsupported-hinge","floor"];
  const ISOLATION=new Set(["cable-fly","cable-serratus-punch","cable-lateral-raise","reverse-pec-deck","leanaway-lateral","face-pull","external-rotation","incline-curl","preacher-curl","hammer-curl","overhead-triceps","pressdown","reverse-curl","seated-leg-curl","adductor-machine","cable-kickback","hip-abduction","standing-calf","seated-calf","legpress-calf","singleleg-calf","bent-knee-calf","tibialis-raise","cable-crunch","pallof-press"]);
  const UNILATERAL=new Set(["one-arm-cable-row","leanaway-lateral","bulgarian-split","long-stride-split","cable-kickback","lateral-stepup","singleleg-calf","side-plank"]);
  const OVERHEAD=new Set(["neutral-pulldown","pullup","machine-shoulder-press","overhead-triceps","hanging-knee","ab-wheel"]);
  const DEEP_KNEE=new Set(["hack-squat","leg-press","bulgarian-split","long-stride-split","lateral-stepup"]);
  const UNSUPPORTED_HINGE=new Set(["romanian-deadlift"]);
  const FLOOR=new Set(["deficit-pushup","cable-crunch","ab-wheel","side-plank","dead-bug"]);
  const LEGACY_TRAIT_SETS={isolation:ISOLATION,unilateral:UNILATERAL,overhead:OVERHEAD,"deep-knee":DEEP_KNEE,"unsupported-hinge":UNSUPPORTED_HINGE,floor:FLOOR};
  const GOAL_WEIGHTS={
    hypertrophy:{stimulus:.35,range:.25,stability:.15,progression:.15,fatigue:.10},
    strength:{stimulus:.20,range:.10,stability:.25,progression:.35,fatigue:.10},
    balanced:{stimulus:.30,range:.20,stability:.20,progression:.20,fatigue:.10},
    "time-efficient":{stimulus:.20,range:.10,stability:.20,progression:.10,fatigue:.20,setup:.20}
  };
  const WEEKDAYS=Object.freeze(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]);
  const SESSION_LENGTHS=Object.freeze({
    20:Object.freeze({minutes:20,count:3,label:"Quick"}),
    35:Object.freeze({minutes:35,count:4,label:"Standard"}),
    50:Object.freeze({minutes:50,count:6,label:"Extended"})
  });
  const SESSION_FOCUSES=Object.freeze({
    full:Object.freeze({label:"Full body",slots:Object.freeze([
      {key:"lower",label:"Lower-body foundation",groups:["legs","glutes"],preferClass:"compound"},
      {key:"push",label:"Upper-body push",groups:["chest","shoulders"],exclude:["rear delts","rotator cuff"],preferClass:"compound"},
      {key:"pull",label:"Upper-body pull",groups:["back"],preferClass:"compound"},
      {key:"posterior",label:"Posterior chain",groups:["legs","glutes"],include:["hamstrings","glute max"]},
      {key:"trunk",label:"Trunk control",groups:["core"]},
      {key:"arms",label:"Arm accessory",groups:["arms"]},
      {key:"calves",label:"Lower-leg accessory",groups:["calves"]}
    ])}),
    upper:Object.freeze({label:"Upper body",slots:Object.freeze([
      {key:"chest",label:"Chest press",groups:["chest"],preferClass:"compound"},
      {key:"back",label:"Back pull",groups:["back"],preferClass:"compound"},
      {key:"shoulders",label:"Shoulder work",groups:["shoulders"]},
      {key:"elbow-flexion",label:"Elbow flexion",groups:["arms"],include:["biceps","brachialis"]},
      {key:"elbow-extension",label:"Elbow extension",groups:["arms"],include:["triceps"]},
      {key:"upper-secondary",label:"Secondary upper-body compound",groups:["chest","back"],preferClass:"compound"},
      {key:"upper-accessory",label:"Upper-body accessory",groups:["shoulders","arms"],include:["rear delts","rotator cuff","forearms"]}
    ])}),
    lower:Object.freeze({label:"Lower body",slots:Object.freeze([
      {key:"quadriceps",label:"Knee-dominant strength",groups:["legs"],include:["quadriceps"],preferClass:"compound"},
      {key:"posterior",label:"Posterior-chain strength",groups:["legs","glutes"],include:["hamstrings","glute max"],preferClass:"compound"},
      {key:"glutes",label:"Glute work",groups:["glutes"]},
      {key:"calves",label:"Calf work",groups:["calves"]},
      {key:"core",label:"Trunk support",groups:["core"]},
      {key:"adductors",label:"Adductor work",groups:["legs"],include:["adductors"]},
      {key:"hip-stability",label:"Hip stability",groups:["glutes"],include:["glute med"]}
    ])}),
    push:Object.freeze({label:"Push",slots:Object.freeze([
      {key:"chest-primary",label:"Primary chest press",groups:["chest"],preferClass:"compound"},
      {key:"shoulder-primary",label:"Shoulder press or raise",groups:["shoulders"],include:["front delts","side delts"]},
      {key:"triceps-primary",label:"Triceps work",groups:["arms"],include:["triceps"]},
      {key:"chest-secondary",label:"Secondary chest work",groups:["chest"]},
      {key:"shoulder-secondary",label:"Secondary shoulder work",groups:["shoulders"],include:["front delts","side delts"]},
      {key:"triceps-secondary",label:"Secondary triceps work",groups:["arms"],include:["triceps"]},
      {key:"serratus",label:"Pressing support",groups:["chest"],include:["serratus"]}
    ])}),
    pull:Object.freeze({label:"Pull",slots:Object.freeze([
      {key:"back-primary",label:"Primary back pull",groups:["back"],preferClass:"compound"},
      {key:"upper-back",label:"Upper-back pull",groups:["back"],include:["upper back"]},
      {key:"biceps",label:"Elbow flexion",groups:["arms"],include:["biceps","brachialis"]},
      {key:"rear-delts",label:"Rear-shoulder support",groups:["shoulders"],include:["rear delts","rotator cuff"]},
      {key:"spinal-erectors",label:"Posterior-chain pull",groups:["back"],include:["spinal erectors"]},
      {key:"forearms",label:"Grip and forearm work",groups:["arms"],include:["forearms"]},
      {key:"back-secondary",label:"Secondary back pull",groups:["back"]}
    ])}),
    core:Object.freeze({label:"Core",slots:Object.freeze([
      {key:"rectus-primary",label:"Trunk flexion",groups:["core"],include:["rectus abdominis"]},
      {key:"deep-primary",label:"Deep-core control",groups:["core"],include:["deep core"]},
      {key:"oblique-primary",label:"Lateral or anti-rotation work",groups:["core"],include:["obliques"]},
      {key:"rectus-secondary",label:"Secondary trunk flexion",groups:["core"],include:["rectus abdominis"]},
      {key:"deep-secondary",label:"Secondary deep-core work",groups:["core"],include:["deep core"]},
      {key:"oblique-secondary",label:"Secondary lateral-core work",groups:["core"],include:["obliques"]},
      {key:"core-finish",label:"Core finisher",groups:["core"]}
    ])})
  });

  function round(value,digits=0){const scale=10**digits;return Math.round((Number(value)||0)*scale)/scale;}
  function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
  function levelNumber(level){return {Beginner:1,Intermediate:2,Advanced:3}[level]||2;}
  function averageMetric(exercise){return FACTOR_KEYS.reduce((sum,key)=>sum+Number(exercise.metrics[key]||0),0)/FACTOR_KEYS.length;}
  function hasTrait(exercise,trait){return Array.isArray(exercise?.traits)?exercise.traits.includes(trait):Boolean(LEGACY_TRAIT_SETS[trait]?.has(exercise?.id));}
  function movementClass(exercise){if(!Array.isArray(exercise?.traits))return ISOLATION.has(exercise?.id)?"isolation":"compound";return hasTrait(exercise,"isolation")?"isolation":hasTrait(exercise,"compound")?"compound":"accessory";}
  function setupScore(exercise){const base={Machine:94,Cables:82,Bodyweight:88,"Resistance band":90,Dumbbells:78,"Barbell / Smith":72,Bench:78}[exercise.equipment]||75;return clamp(base+(hasTrait(exercise,"unilateral")?-9:0)+(exercise.level==="Beginner"?4:exercise.level==="Advanced"?-4:0),55,98);}
  function setupLabel(exercise){const score=setupScore(exercise);return score>=90?"Very simple":score>=80?"Simple":score>=70?"Moderate":"More involved";}
  function resistanceProfile(exercise){if(exercise.equipment==="Cables")return "Cable-defined tension";if(exercise.equipment==="Machine")return "Machine-defined path";if(exercise.equipment==="Resistance band")return "Band tension curve";if(exercise.equipment==="Barbell / Smith")return exercise.name.includes("Smith")?"Guided gravity curve":"Free-weight gravity curve";if(exercise.equipment==="Dumbbells")return "Free-weight gravity curve";if(exercise.equipment==="Bodyweight")return "Bodyweight / leverage curve";if(exercise.equipment==="Bench")return "Bench-supported leverage";return "Equipment-defined resistance";}
  function practicality(exercise){return round(Number(exercise.metrics.fatigue||0)*.55+setupScore(exercise)*.45);}
  function factorWeights(methodology){return Object.fromEntries(methodology.factors.map((factor)=>[factor.key,Number(factor.weight)]));}
  function weightedBaseline(exercise,methodology){const weights=factorWeights(methodology);return FACTOR_KEYS.reduce((sum,key)=>sum+Number(exercise.metrics[key]||0)*(weights[key]||0)/100,0);}
  function scoreAdjustment(exercise,methodology){return round(Number(exercise.score)-weightedBaseline(exercise,methodology),1);}
  function excludedByLimitations(exercise,limitations=[]){return (limitations.includes("no-overhead")&&hasTrait(exercise,"overhead"))||(limitations.includes("no-deep-knee")&&hasTrait(exercise,"deep-knee"))||(limitations.includes("no-unsupported-hinge")&&hasTrait(exercise,"unsupported-hinge"))||(limitations.includes("no-floor")&&hasTrait(exercise,"floor"))||(limitations.includes("no-unilateral")&&hasTrait(exercise,"unilateral"));}

  function personalResult(exercise,preferences){
    const weights=GOAL_WEIGHTS[preferences.goal]||GOAL_WEIGHTS.hypertrophy;
    let raw=FACTOR_KEYS.reduce((sum,key)=>sum+Number(exercise.metrics[key]||0)*(weights[key]||0),0)+(weights.setup||0)*setupScore(exercise);
    const reasons=[],selected=Array.isArray(preferences.preferences)?preferences.preferences:[];
    if(selected.includes("stable")){raw+=(exercise.metrics.stability-75)*.08;if(exercise.metrics.stability>=90)reasons.push("highly stable setup");}
    if(selected.includes("long-range")){raw+=(exercise.metrics.range-75)*.08;if(exercise.metrics.range>=90)reasons.push("strong effective-range score");}
    if(selected.includes("simple-setup")){raw+=(setupScore(exercise)-75)*.09;if(setupScore(exercise)>=88)reasons.push("simple setup");}
    const classification=movementClass(exercise);
    if(selected.includes("compound")){raw+=classification==="compound"?5:classification==="isolation"?-5:0;if(classification==="compound")reasons.push("compound pattern preference");}
    if(selected.includes("isolation")){raw+=classification==="isolation"?5:classification==="compound"?-5:0;if(classification==="isolation")reasons.push("isolation preference");}
    const userLevel=levelNumber(preferences.level),exerciseLevel=levelNumber(exercise.level);
    if(exerciseLevel>userLevel){raw-=8*(exerciseLevel-userLevel);reasons.push("higher skill demand");}
    else if(exerciseLevel===userLevel)reasons.push("experience match");
    if(Number(preferences.days)<=3&&practicality(exercise)>=86){raw+=2;reasons.push("efficient for a shorter week");}
    const available=(preferences.equipment||[]).includes(exercise.equipment),constrained=excludedByLimitations(exercise,preferences.limitations||[]);
    if(!available)reasons.unshift(`${exercise.equipment.toLowerCase()} unavailable`);
    if(constrained)reasons.unshift("excluded by a saved movement constraint");
    return {match:round(clamp(raw,40,99)),eligible:available&&!constrained,reasons:[...new Set(reasons)].slice(0,3)};
  }

  function similarity(reference,candidate){
    let score=0;
    if(reference.group===candidate.group)score+=28;
    if(reference.sub===candidate.sub)score+=24;else if(reference.group===candidate.group)score+=7;
    if(reference.pattern===candidate.pattern)score+=13;
    if(resistanceProfile(reference)===resistanceProfile(candidate))score+=8;
    if(reference.equipment===candidate.equipment)score+=5;
    score+=Math.max(0,15-Math.abs(averageMetric(reference)-averageMetric(candidate))*.8);
    score+=Math.max(0,7-Math.abs(levelNumber(reference.level)-levelNumber(candidate.level))*3.5);
    return round(clamp(score,0,99));
  }

  function targetsCompatible(reference,candidate){
    return Boolean(reference&&candidate&&reference.group===candidate.group&&reference.sub===candidate.sub);
  }

  function alternativesFor(reference,exercises,preferences,limit=4){
    return exercises.filter((candidate)=>candidate.id!==reference.id&&targetsCompatible(reference,candidate)).map((exercise)=>({exercise,match:similarity(reference,exercise),personal:personalResult(exercise,preferences)})).filter((item)=>item.personal.eligible).sort((a,b)=>b.match-a.match||b.personal.match-a.personal.match||b.exercise.score-a.exercise.score).slice(0,limit);
  }

  function exerciseGuidance(exercise,exercises,limit=3){
    if(!exercise||typeof exercise!=="object")return null;
    const cues=(Array.isArray(exercise.cues)?exercise.cues:[]).map((cue)=>String(cue||"").trim()).filter(Boolean).slice(0,3);
    const alternatives=(Array.isArray(exercises)?exercises:[])
      .filter((candidate)=>candidate&&candidate.id!==exercise.id&&targetsCompatible(exercise,candidate)&&candidate.equipment!==exercise.equipment)
      .map((candidate)=>({
        exercise:candidate,
        match:similarity(exercise,candidate),
        reason:`Same ${String(exercise.sub||exercise.group||"training").toLowerCase()} target with ${String(candidate.equipment||"a different setup").toLowerCase()}.`
      }))
      .sort((a,b)=>Number(b.exercise.pattern===exercise.pattern)-Number(a.exercise.pattern===exercise.pattern)||b.match-a.match||Number(b.exercise.score||0)-Number(a.exercise.score||0)||String(a.exercise.name||"").localeCompare(String(b.exercise.name||"")))
      .slice(0,clamp(Math.round(Number(limit)||3),1,4));
    return {
      setup:`Use ${String(exercise.equipment||"the listed equipment").toLowerCase()}. ${cues[0]||"Set up in a stable position before the first working set."}`,
      cues:cues.slice(1),
      mistake:String(exercise.caution||"Keep the movement controlled and stop if the setup no longer feels comfortable."),
      prescription:`${String(exercise.sets||"Review your plan")} sets · ${String(exercise.reps||"use your planned range")} · ${String(exercise.rest||"rest as needed")}`,
      purpose:`${String(exercise.sub||exercise.group||"Training target")} · ${String(exercise.pattern||"movement")}. ${String(exercise.why||"")}`.trim(),
      alternatives
    };
  }

  function gainsAndLosses(reference,candidate,methodology){
    const labels=Object.fromEntries(methodology.factors.map((factor)=>[factor.key,factor.label]));
    const diffs=FACTOR_KEYS.map((key)=>({key,label:labels[key]||key,diff:Number(candidate.metrics[key])-Number(reference.metrics[key])})).sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
    const gain=diffs.find((item)=>item.diff>0),loss=diffs.find((item)=>item.diff<0);
    return {gain:gain?`+${gain.diff} ${gain.label.toLowerCase()}`:"similar factor profile",loss:loss?`${loss.diff} ${loss.label.toLowerCase()}`:"no major factor loss"};
  }

  function normalizeShortlist(value,exercises,limit=4){
    const catalogIds=new Set((Array.isArray(exercises)?exercises:[]).map((exercise)=>String(exercise?.id||"")).filter(Boolean));
    const maximum=clamp(Math.round(Number(limit)||4),1,12),normalized=[];
    for(const candidate of Array.isArray(value)?value:[]){
      const id=String(candidate||"");
      if(!catalogIds.has(id)||normalized.includes(id))continue;
      normalized.push(id);
      if(normalized.length===maximum)break;
    }
    return normalized;
  }

  function filterExercises(exercises,filters,preferences,aggregateFor){
    const query=String(filters.query||"").trim().toLowerCase();
    const savedIds=new Set(normalizeShortlist(filters.saved,exercises,12));
    const collection=(exercise)=>{
      if(filters.collection==="saved")return savedIds.has(exercise.id);
      if(filters.collection==="top-chest")return exercise.group==="chest"&&exercise.score>=90;
      if(filters.collection==="dumbbells")return exercise.equipment==="Dumbbells"&&exercise.score>=84;
      if(filters.collection==="bodyweight")return exercise.equipment==="Bodyweight";
      if(filters.collection==="beginner")return exercise.level==="Beginner";
      if(filters.collection==="community")return Number(aggregateFor(exercise.id)?.rating_count||0)>0;
      return true;
    };
    const items=exercises.filter(collection).filter((exercise)=>filters.group==="all"||exercise.group===filters.group).filter((exercise)=>filters.equipment==="all"||exercise.equipment===filters.equipment).filter((exercise)=>filters.pattern==="all"||exercise.pattern===filters.pattern).filter((exercise)=>filters.level==="all"||exercise.level===filters.level).filter((exercise)=>!query||`${exercise.name} ${exercise.group} ${exercise.sub} ${exercise.equipment} ${exercise.pattern} ${exercise.level} ${exercise.why}`.toLowerCase().includes(query));
    return items.sort((a,b)=>{
      if(filters.sort==="score")return b.score-a.score;
      if(filters.sort==="community")return Number(aggregateFor(b.id)?.overall||0)-Number(aggregateFor(a.id)?.overall||0)||Number(aggregateFor(b.id)?.rating_count||0)-Number(aggregateFor(a.id)?.rating_count||0)||b.score-a.score;
      if(filters.sort==="practicality")return practicality(b)-practicality(a)||b.score-a.score;
      if(filters.sort==="difficulty")return levelNumber(a.level)-levelNumber(b.level)||b.score-a.score;
      const aResult=personalResult(a,preferences),bResult=personalResult(b,preferences);return Number(bResult.eligible)-Number(aResult.eligible)||bResult.match-aResult.match||b.score-a.score;
    });
  }

  function comparisonRecommendation(exercises,preferences){
    if(!Array.isArray(exercises)||exercises.length<2||exercises.length>4)return {winner:null,error:"Choose between two and four exercises."};
    if(!exercises.every((exercise)=>targetsCompatible(exercise,exercises[0])))return {winner:null,reason:"These movements target different muscles or training roles, so there is no honest universal winner. Compare how each one fits into the week instead."};
    const eligible=exercises.filter((exercise)=>personalResult(exercise,preferences).eligible);
    if(!eligible.length)return {winner:null,reason:"None of these movements matches your saved equipment and movement constraints. Update the selection or your profile before choosing a winner."};
    const ranked=eligible.map((exercise)=>({exercise,value:personalResult(exercise,preferences).match*.55+exercise.score*.45})).sort((a,b)=>b.value-a.value);
    const goal={hypertrophy:"hypertrophy selection",strength:"strength skill",balanced:"balanced selection","time-efficient":"time-efficient selection"}[preferences.goal]||"saved selection";
    const winner=ranked[0].exercise,match=personalResult(winner,preferences).match;
    return {winner,reason:`${winner.name} is the best fit for your ${goal} rules among these choices. It combines a ${match}% personal match with a ${winner.score} official FitScore. The recommendation can change when your equipment, constraints, or goal changes.`};
  }

  function sessionError(message,code){return Object.assign(new Error(message),{code});}
  function sessionRoleMatches(exercise,role){
    if(!exercise||!role.groups.includes(exercise.group))return false;
    const target=String(exercise.sub||"").toLowerCase();
    if(role.include&&!role.include.some((value)=>target.includes(value)))return false;
    if(role.exclude?.some((value)=>target.includes(value)))return false;
    return true;
  }
  function sessionFocusMatches(exercise,focus){
    const config=SESSION_FOCUSES[focus];
    return Boolean(config&&config.slots.some((role)=>sessionRoleMatches(exercise,role)));
  }
  function scheduledExerciseIds(plan){
    const ids=new Set();
    for(const day of WEEKDAYS)for(const item of Array.isArray(plan?.days?.[day])?plan.days[day]:[])if(item?.exerciseId)ids.add(String(item.exerciseId));
    return ids;
  }
  function sessionSetMaximum(exercise){
    const values=String(exercise?.sets||"").match(/\d+/g)?.map(Number).filter(Number.isFinite)||[];
    return clamp(values.at(-1)||values[0]||3,1,10);
  }
  function sessionSetCount(exercise,minutes,index){
    const target=minutes===20?2:minutes===50&&index<2?4:3;
    return clamp(target,1,sessionSetMaximum(exercise));
  }
  function sessionCandidateScore(candidate,{role,usedGroups,usedSubs,weekIds}){
    const {exercise,personal}=candidate,classification=movementClass(exercise);
    let value=personal.match*.62+Number(exercise.score||0)*.25+practicality(exercise)*.13;
    if(role.preferClass===classification)value+=4;
    value-=(usedGroups.get(exercise.group)||0)*2;
    value-=(usedSubs.get(exercise.sub)||0)*9;
    if(weekIds.has(exercise.id))value-=12;
    return value;
  }
  function sessionRolesAreFeasible(candidates,roles,usedIds=new Set()){
    const assigned=new Map();
    function assign(roleIndex,visited){
      for(const {exercise} of candidates){
        if(usedIds.has(exercise.id)||visited.has(exercise.id)||!sessionRoleMatches(exercise,roles[roleIndex]))continue;
        visited.add(exercise.id);
        const priorRole=assigned.get(exercise.id);
        if(priorRole===undefined||assign(priorRole,visited)){assigned.set(exercise.id,roleIndex);return true;}
      }
      return false;
    }
    return roles.every((_,roleIndex)=>assign(roleIndex,new Set()));
  }
  function sessionMuscleTargets(exercises,focus="full",muscleGroup="all"){return SessionSelection.sessionMuscleTargets(exercises,focus,muscleGroup,sessionFocusMatches);}
  function buildSession(options={}){
    if(options.selectionMode!==undefined)return SessionSelection.buildSession(options,{WEEKDAYS,SESSION_FOCUSES,SESSION_LENGTHS,personalResult,sessionError,sessionRoleMatches,sessionFocusMatches,scheduledExerciseIds,sessionRolesAreFeasible,sessionSetCount,sessionCandidateScore});
    return buildLegacySession(options);
  }
  function buildLegacySession({exercises,preferences,focus="full",minutes=35,weeklyPlan=null}={}){
    const focusConfig=SESSION_FOCUSES[focus],lengthConfig=SESSION_LENGTHS[Number(minutes)];
    if(!focusConfig)throw sessionError("Choose a valid session focus.","INVALID_SESSION_FOCUS");
    if(!lengthConfig)throw sessionError("Choose 20, 35, or 50 minutes.","INVALID_SESSION_LENGTH");
    if(!preferences||typeof preferences!=="object")throw sessionError("Your saved training profile is unavailable.","INVALID_SESSION_PROFILE");
    const candidates=(Array.isArray(exercises)?exercises:[]).filter((exercise)=>sessionFocusMatches(exercise,focus)).map((exercise)=>({exercise,personal:personalResult(exercise,preferences)})).filter(({personal})=>personal.eligible);
    if(candidates.length<lengthConfig.count)throw sessionError(`Only ${candidates.length} eligible ${focusConfig.label.toLowerCase()} exercise${candidates.length===1?" matches":"s match"} your equipment and movement constraints. Choose a shorter session or update your profile.`,"SESSION_POOL_TOO_SMALL");
    const requiredRoles=focusConfig.slots.slice(0,lengthConfig.count),missingRole=requiredRoles.find((role)=>!candidates.some(({exercise})=>sessionRoleMatches(exercise,role)));
    if(missingRole)throw sessionError(`Your saved equipment and movement constraints do not provide an eligible ${missingRole.label.toLowerCase()} movement for this ${focusConfig.label.toLowerCase()} session. Choose a different focus or update your profile.`,"SESSION_ROLE_UNAVAILABLE");
    if(!sessionRolesAreFeasible(candidates,requiredRoles))throw sessionError(`Your saved equipment and movement constraints do not provide enough distinct movements to cover every role in this ${focusConfig.label.toLowerCase()} session. Choose a shorter session, a different focus, or update your profile.`,"SESSION_ROLE_UNAVAILABLE");
    const weekIds=scheduledExerciseIds(weeklyPlan),usedIds=new Set(),usedGroups=new Map(),usedSubs=new Map(),items=[];
    for(let index=0;index<lengthConfig.count;index++){
      const role=requiredRoles[index],roleMatches=candidates.filter(({exercise})=>!usedIds.has(exercise.id)&&sessionRoleMatches(exercise,role));
      const ranked=roleMatches.map((candidate)=>({...candidate,selectionScore:sessionCandidateScore(candidate,{role,usedGroups,usedSubs,weekIds})})).sort((a,b)=>b.selectionScore-a.selectionScore||b.personal.match-a.personal.match||Number(b.exercise.score)-Number(a.exercise.score)||String(a.exercise.id).localeCompare(String(b.exercise.id)));
      const remainingRoles=requiredRoles.slice(index+1),selected=ranked.find(({exercise})=>sessionRolesAreFeasible(candidates,remainingRoles,new Set([...usedIds,exercise.id])));
      if(!selected)throw sessionError(`STRATA could not cover every programmed role in this ${focusConfig.label.toLowerCase()} session with distinct eligible movements. Choose a shorter session, a different focus, or update your profile.`,"SESSION_ROLE_UNAVAILABLE");
      const {exercise,personal}=selected,roleLabel=role.label,sets=sessionSetCount(exercise,lengthConfig.minutes,index);
      const reasons=[roleLabel];
      if(personal.reasons?.length)reasons.push(personal.reasons[0]);
      else reasons.push(`${exercise.score} official FitScore`);
      if(weekIds.size)reasons.push(weekIds.has(exercise.id)?"was already in your saved week but remained the strongest fit":"was not yet in your saved week when this session was generated");
      items.push({exercise,exerciseId:exercise.id,role:role.key,roleLabel,sets,reps:String(exercise.reps||"8–12"),rest:String(exercise.rest||"60–90 s"),match:personal.match,reasons});
      usedIds.add(exercise.id);usedGroups.set(exercise.group,(usedGroups.get(exercise.group)||0)+1);usedSubs.set(exercise.sub,(usedSubs.get(exercise.sub)||0)+1);
    }
    const workingSets=items.reduce((sum,item)=>sum+item.sets,0);
    return {focus,focusLabel:focusConfig.label,minutes:lengthConfig.minutes,timeLabel:lengthConfig.label,estimatedMinutes:lengthConfig.minutes,workingSets,items,summary:`${items.length} movements · ${workingSets} working sets · about ${lengthConfig.minutes} minutes`};
  }

  function repeatSessionAnchors(session,anchors,limit=2){
    const sourceItems=Array.isArray(session?.items)?session.items:[],requested=Math.max(0,Math.min(2,Math.round(Number(limit)||0)));
    if(!sourceItems.length||!requested)return session;
    const items=sourceItems.map((item)=>({...item,reasons:Array.isArray(item.reasons)?[...item.reasons]:[]})),used=new Set(items.map((item)=>String(item.exerciseId||""))),seen=new Set(),repeated=[];
    for(const anchor of Array.isArray(anchors)?anchors:[]){
      const exerciseId=String(anchor?.exerciseId||anchor?.exercise?.id||"");
      if(!exerciseId||seen.has(exerciseId)||!anchor?.exercise||!anchor?.role)continue;
      seen.add(exerciseId);
      const existingIndex=items.findIndex((item)=>item.exerciseId===exerciseId&&item.role===anchor.role);
      if(existingIndex>=0){
        const existing=items[existingIndex];
        if(!existing.reasons.includes("repeated anchor for Training Memory"))existing.reasons.push("repeated anchor for Training Memory");
        repeated.push(exerciseId);
      }else{
        const targetIndex=items.findIndex((item)=>item.role===anchor.role&&!repeated.includes(item.exerciseId));
        if(targetIndex<0||used.has(exerciseId))continue;
        const target=items[targetIndex];used.delete(String(target.exerciseId||""));used.add(exerciseId);
        items[targetIndex]={...anchor,sets:target.sets,reasons:[...(Array.isArray(anchor.reasons)?anchor.reasons:[]).filter((reason)=>reason!=="repeated anchor for Training Memory"),"repeated anchor for Training Memory"]};
        repeated.push(exerciseId);
      }
      if(repeated.length>=requested)break;
    }
    const workingSets=items.reduce((sum,item)=>sum+clamp(Math.round(Number(item?.sets)||0),0,10),0);
    return{...session,workingSets,items,anchorExerciseIds:repeated,summary:`${items.length} movements · ${workingSets} working sets · about ${session.minutes} minutes`};
  }

  function planItemCount(plan){return WEEKDAYS.reduce((sum,day)=>sum+(Array.isArray(plan?.days?.[day])?plan.days[day].length:0),0);}
  function sessionPlanError(message,code){return Object.assign(new Error(message),{code});}
  function sessionInstanceId(day,exerciseId,index,used,makeInstanceId){
    const requested=typeof makeInstanceId==="function"?String(makeInstanceId(exerciseId,index,day)||""):"";
    const stem=`session-${day.toLowerCase()}-${exerciseId}`.replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,92);
    let value=/^[a-zA-Z0-9_-]{6,100}$/.test(requested)&&!used.has(requested)?requested:stem,suffix=2;
    while(used.has(value))value=`${stem.slice(0,96-String(suffix).length)}-${suffix++}`;
    used.add(value);return value;
  }
  function mergeSessionIntoPlan(plan,day,session,{makeInstanceId,maxDayItems=30,maxPlanItems=140}={}){
    if(!plan||typeof plan!=="object"||!(Array.isArray(plan.restDays)?plan.restDays.every(name=>WEEKDAYS.includes(name)):WEEKDAYS.includes(plan.restDay)||plan.restDay===null)||!WEEKDAYS.every((name)=>Array.isArray(plan.days?.[name])))throw sessionPlanError("Your weekly plan is unavailable. Refresh Strata+ and try again.","INVALID_WEEKLY_PLAN");
    if(!WEEKDAYS.includes(day))throw sessionPlanError("Choose a valid planner day.","INVALID_SESSION_DAY");
    if((plan.restDays||[plan.restDay]).includes(day))throw sessionPlanError(`${day} is your recovery day. Choose another day or change it in My Plan first.`,"SESSION_REST_DAY");
    const sourceItems=Array.isArray(session?.items)?session.items:[];
    if(!sourceItems.length)throw sessionPlanError("Build a session before adding it to your week.","EMPTY_SESSION");
    const output={...plan,days:Object.fromEntries(WEEKDAYS.map((name)=>[name,plan.days[name].map((item)=>({...item}))]))},existingIds=new Set(output.days[day].map((item)=>String(item.exerciseId))),pending=[],seen=new Set();
    for(const item of sourceItems){
      const exerciseId=String(item?.exerciseId||item?.exercise?.id||"");
      if(!exerciseId||seen.has(exerciseId)){continue;}
      seen.add(exerciseId);
      if(existingIds.has(exerciseId))continue;
      pending.push({exerciseId,sets:clamp(Math.round(Number(item.sets)||3),1,10),reps:String(item.reps||item.exercise?.reps||"8–12").trim().slice(0,20)||"8–12"});
    }
    const skipped=sourceItems.length-pending.length;
    if(output.days[day].length+pending.length>maxDayItems)throw sessionPlanError(`${day} does not have room for the complete session. Remove exercises in My Plan or choose another day.`,"SESSION_DAY_CAPACITY");
    if(planItemCount(output)+pending.length>maxPlanItems)throw sessionPlanError("Your weekly plan does not have room for the complete session. Remove exercises in My Plan, then try again.","SESSION_PLAN_CAPACITY");
    const usedInstances=new Set(WEEKDAYS.flatMap((name)=>output.days[name].map((item)=>String(item.instanceId||""))).filter(Boolean));
    pending.forEach((item,index)=>output.days[day].push({...item,instanceId:sessionInstanceId(day,item.exerciseId,index,usedInstances,makeInstanceId)}));
    return {plan:output,added:pending.length,skipped,changed:pending.length>0};
  }

  function weeklyPulse(plan,{today=new Date(),profileDays=0}={}){
    const fallbackDate=today instanceof Date&&!Number.isNaN(today.getTime())?today:new Date(),fallbackDay=WEEKDAYS[(fallbackDate.getDay()+6)%7],rawDay=typeof today==="string"&&WEEKDAYS.includes(today)?today:fallbackDay,todayIndex=WEEKDAYS.indexOf(rawDay);
    const scheduled=WEEKDAYS.map((day)=>({day,items:Array.isArray(plan?.days?.[day])?plan.days[day]:[]})).filter(({items})=>items.length),scheduledDays=scheduled.length,targetDays=clamp(Math.round(Number(profileDays)||1),1,7),progressPercent=round(clamp(scheduledDays/targetDays*100,0,100));
    if(!scheduledDays)return {day:null,isToday:false,offset:null,movements:0,workingSets:0,scheduledDays,targetDays,progressPercent:0,eyebrow:"Saved week",title:"No sessions scheduled.",detail:`0 scheduled training days · ${targetDays}-day profile target.`,actionLabel:"Build my week"};
    let selected=null,offset=0;
    for(;offset<WEEKDAYS.length;offset++){
      const day=WEEKDAYS[(todayIndex+offset)%WEEKDAYS.length],items=Array.isArray(plan?.days?.[day])?plan.days[day]:[];
      if(items.length){selected={day,items};break;}
    }
    const movements=selected.items.length,workingSets=selected.items.reduce((sum,item)=>sum+clamp(Math.round(Number(item?.sets)||0),0,10),0),isToday=offset===0,when=isToday?"Today":offset===1?"Tomorrow":selected.day;
    return {day:selected.day,isToday,offset,movements,workingSets,scheduledDays,targetDays,progressPercent,eyebrow:isToday?"Today in your week":"Next in your week",title:`${when} · ${movements} movement${movements===1?"":"s"}.`,detail:`${selected.day} · ${workingSets} working sets · ${scheduledDays} scheduled training day${scheduledDays===1?"":"s"} vs ${targetDays}-day profile target.`,actionLabel:"Open weekly plan"};
  }

  return {FACTOR_KEYS,TRAIT_KEYS,ISOLATION,UNILATERAL,OVERHEAD,DEEP_KNEE,UNSUPPORTED_HINGE,FLOOR,WEEKDAYS,SESSION_LENGTHS,SESSION_FOCUSES,SESSION_SELECTION_MODES:SessionSelection?.SESSION_SELECTION_MODES,hasTrait,movementClass,round,clamp,levelNumber,averageMetric,setupScore,setupLabel,resistanceProfile,practicality,factorWeights,weightedBaseline,scoreAdjustment,excludedByLimitations,personalResult,similarity,targetsCompatible,alternativesFor,exerciseGuidance,gainsAndLosses,normalizeShortlist,filterExercises,comparisonRecommendation,sessionRoleMatches,sessionFocusMatches,sessionMuscleTargets,buildSession,repeatSessionAnchors,mergeSessionIntoPlan,weeklyPulse};
});
