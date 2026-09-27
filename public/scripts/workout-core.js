(function(root,factory){
  "use strict";
  const core=factory();
  if(typeof module==="object"&&module.exports)module.exports=core;
  else root.StrataWorkout=core;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function localDate(now=new Date()){
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  }
  function today(now=new Date()){return DAYS[(now.getDay()+6)%7];}
  function dayFromSearch(search,now=new Date()){
    const requested=new URLSearchParams(search).get("day");
    return DAYS.includes(requested)?requested:today(now);
  }
  function id(){return globalThis.crypto?.randomUUID?.()||`workout-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
  function inferFormat(exercise,prescribedReps=""){
    const timed=/(?:\b|\d\s*)(?:s|secs?|seconds?|mins?|minutes?)\b/i.test(prescribedReps||exercise.reps||"");
    const assisted=/\bassisted\b/i.test(exercise.name||"");
    // A bench supports these catalog movements; it does not imply added resistance.
    const bodyweight=["Bodyweight","Bench"].includes(exercise.equipment);
    return{measurement:timed?"timed":"reps",loadType:assisted?"assisted":bodyweight?"bodyweight":"external",unit:"kg"};
  }
  function blankSet(){return{reps:null,weight:null,seconds:null,completed:false,effort:null};}
  function normalizeWorkout(value){
    const workout=copy(value);
    workout.entries=(workout.entries||[]).map((entry)=>({
      ...entry,
      planInstanceId:typeof entry.planInstanceId==="string"?entry.planInstanceId:"",
      note:typeof entry.note==="string"?entry.note:"",
      effortType:["rir","rpe"].includes(entry.effortType)?entry.effortType:"none",
      supersetGroup:typeof entry.supersetGroup==="string"?entry.supersetGroup:"",
      replacedFromExerciseId:typeof entry.replacedFromExerciseId==="string"?entry.replacedFromExerciseId:"",
      sets:(entry.sets||[]).map((set)=>({...blankSet(),...set,effort:set?.effort??null}))
    }));
    return workout;
  }
  function createWorkout(plan,day,catalog,now=Date.now()){
    const prescriptions=plan?.days?.[day];
    if(!DAYS.includes(day)||!Array.isArray(prescriptions)||!prescriptions.length)throw new Error("Add exercises to this day in Plan first.");
    if(prescriptions.length>30)throw new Error("This day has more than 30 exercises. Adjust it in Plan before starting.");
    const byId=new Map(catalog.map((exercise)=>[exercise.id,exercise]));
    return{id:id(),title:`${day} workout`,planDay:day,date:localDate(new Date(now)),status:"active",startedAt:now,completedAt:null,elapsedSeconds:0,restEndsAt:null,entries:prescriptions.map((item)=>{
      const exercise=byId.get(item.exerciseId);
      if(!exercise)throw new Error("This plan contains an unavailable exercise. Review it in Plan.");
      if(!Number.isInteger(item.sets)||item.sets<1||item.sets>10)throw new Error("Each exercise needs 1–10 sets. Review this day in Plan.");
      return{id:id(),exerciseId:item.exerciseId,planInstanceId:typeof item.instanceId==="string"?item.instanceId:"",...inferFormat(exercise,item.reps),prescribedReps:String(item.reps||exercise.reps||"").trim().slice(0,40),note:"",effortType:"none",supersetGroup:"",replacedFromExerciseId:"",sets:Array.from({length:item.sets},blankSet)};
    })};
  }
  function effortError(entry,set){
    if(set.effort===null||set.effort===undefined)return "";
    if(entry.effortType==="none")return "Choose RIR or RPE before recording effort.";
    if(typeof set.effort!=="number"||!Number.isFinite(set.effort)||Math.abs(set.effort*2-Math.round(set.effort*2))>.000001)return "Effort must use whole or half steps.";
    if(entry.effortType==="rir"&&(set.effort<0||set.effort>10))return "RIR must be from 0 to 10.";
    if(entry.effortType==="rpe"&&(set.effort<1||set.effort>10))return "RPE must be from 1 to 10.";
    return "";
  }
  function repsError(value){return Number.isInteger(value)&&value>=1&&value<=1000?"":"Enter actual repetitions from 1 to 1,000.";}
  function secondsError(value){return Number.isInteger(value)&&value>=1&&value<=3600?"":"Enter actual time from 1 to 3,600 whole seconds.";}
  function loadError(value){return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1000&&Math.abs(value*100-Math.round(value*100))<=0.000001?"":"Enter an explicit load from 0 to 1,000, using at most 2 decimal places.";}
  function actualError(entry,set){
    return (entry.measurement==="timed"?secondsError(set.seconds):repsError(set.reps))||(entry.loadType!=="bodyweight"?loadError(set.weight):"")||effortError(entry,set);
  }
  // Live-input rules shared by the online and offline loggers. A value that fails
  // here is never applied to the workout, so it can never reach a saved draft.
  function inputError(entry,field,value){
    if(value===null)return "";
    return field==="reps"?repsError(value):field==="seconds"?secondsError(value):field==="weight"?loadError(value):field==="effort"?effortError(entry,{effort:value}):"This field is not recognized.";
  }
  const UNSAFE_NOTE=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  function cleanNote(value){return String(value??"").replace(UNSAFE_NOTE,"").slice(0,500);}
  function progress(workout){
    const sets=(workout?.entries||[]).flatMap((entry)=>entry.sets);
    const completed=sets.filter((set)=>set.completed===true).length;
    return{total:sets.length,completed,percent:sets.length?Math.round(completed/sets.length*100):0};
  }
  function planDaySummary(plan,day){
    const items=Array.isArray(plan?.days?.[day])?plan.days[day]:[];
    return{
      day:DAYS.includes(day)?day:null,
      movements:items.length,
      workingSets:items.reduce((total,item)=>total+(Number.isFinite(Number(item?.sets))?Math.max(0,Number(item.sets)):0),0)
    };
  }
  function nextIncompleteSet(workout){
    const entries=Array.isArray(workout?.entries)?workout.entries:[];
    const counts=progress(workout),visited=new Set();
    for(let entryIndex=0;entryIndex<entries.length;entryIndex++){
      const group=entries[entryIndex]?.supersetGroup;
      if(group){
        if(visited.has(group))continue;visited.add(group);
        const members=entries.map((entry,index)=>entry?.supersetGroup===group?index:-1).filter((index)=>index>=0),rounds=Math.max(0,...members.map((index)=>Array.isArray(entries[index].sets)?entries[index].sets.length:0));
        for(let setIndex=0;setIndex<rounds;setIndex++)for(const memberIndex of members){
          // A shorter partner has no set in this round; skip it rather than point at a missing set.
          const set=entries[memberIndex].sets?.[setIndex];
          if(set&&set.completed!==true)return{entryIndex:memberIndex,setIndex,entryId:entries[memberIndex].id,exerciseId:entries[memberIndex].exerciseId,remaining:counts.total-counts.completed};
        }
        continue;
      }
      const sets=Array.isArray(entries[entryIndex]?.sets)?entries[entryIndex].sets:[];
      const setIndex=sets.findIndex((set)=>set?.completed!==true);
      if(setIndex>=0)return{entryIndex,setIndex,entryId:entries[entryIndex].id,exerciseId:entries[entryIndex].exerciseId,remaining:counts.total-counts.completed};
    }
    return null;
  }
  function remainingSeconds(deadline,now=Date.now()){
    return Number.isFinite(deadline)?Math.max(0,Math.ceil((deadline-now)/1000)):0;
  }
  function timestamp(value){const numeric=Number(value);if(Number.isFinite(numeric))return numeric;const parsed=Date.parse(String(value||""));return Number.isFinite(parsed)?parsed:0;}
  function offlineAccessUntil(discovery,now=Date.now()){
    if(discovery?.active!==true)return 0;
    if(discovery.accessType==="grant"){const grant=discovery.adminGrant;if(grant?.active!==true)return 0;if(grant.expiresAt===null)return now+24*60*60*1000;const expiry=timestamp(grant.expiresAt);return expiry>now?Math.min(expiry,now+24*60*60*1000):0;}
    if(discovery.accessType==="trial")return Math.max(0,timestamp(discovery.trial?.expiresAt));
    const boundaries=[now+24*60*60*1000],subscription=discovery.subscription;
    // No subscription row means this is grandfathered lifetime access. A
    // monthly subscription must carry a current server-verified period.
    if(!subscription)return boundaries[0];
    const periodEndsAt=timestamp(subscription.currentPeriodEndsAt);
    if(periodEndsAt<=now)return 0;
    boundaries.push(periodEndsAt);
    if(["cancel","pause"].includes(subscription.scheduledChange?.action)){
      const scheduledAt=timestamp(subscription.scheduledChange.effectiveAt);
      if(scheduledAt<=now)return 0;
      boundaries.push(scheduledAt);
    }
    return Math.min(...boundaries);
  }
  function duration(seconds){
    const safe=Math.max(0,Math.floor(Number(seconds)||0));
    return safe>=3600?`${Math.floor(safe/3600)}:${String(Math.floor(safe%3600/60)).padStart(2,"0")}:${String(safe%60).padStart(2,"0")}`:`${Math.floor(safe/60)}:${String(safe%60).padStart(2,"0")}`;
  }
  function formatKey(entry){return JSON.stringify([entry.exerciseId,entry.measurement,entry.loadType,entry.unit]);}
  function summary(workout){
    const groups=new Map();
    for(const entry of workout.entries){
      const key=formatKey(entry);
      if(!groups.has(key))groups.set(key,{exerciseId:entry.exerciseId,measurement:entry.measurement,loadType:entry.loadType,unit:entry.unit,completedSets:0,totalReps:0,maxReps:null,maxWeight:null,volume:0,totalSeconds:0,maxSeconds:null,setValues:[]});
      const group=groups.get(key);
      for(const set of entry.sets){
        if(!set.completed||actualError(entry,set))continue;
        group.completedSets++;
        if(entry.measurement==="reps"){
          group.totalReps+=set.reps;
          group.maxReps=Math.max(group.maxReps,set.reps);
          if(entry.loadType==="external"){
            group.maxWeight=Math.max(group.maxWeight,set.weight);
            group.volume+=set.reps*set.weight;
          }
        }else{
          group.totalSeconds+=set.seconds;
          group.maxSeconds=Math.max(group.maxSeconds,set.seconds);
        }
        if(entry.loadType==="external")group.maxWeight=Math.max(group.maxWeight,set.weight);
        if(group.setValues.length<10)group.setValues.push({reps:set.reps,weight:set.weight,seconds:set.seconds,effort:set.effort??null,effortType:set.effort==null?"none":entry.effortType});
      }
      group.volume=Math.round(group.volume*100)/100;
    }
    const {total,completed}=progress(workout);
    return{id:workout.id,title:workout.title,planDay:workout.planDay,date:workout.date,status:workout.status,startedAt:workout.startedAt,completedAt:workout.completedAt,elapsedSeconds:workout.elapsedSeconds,revision:workout.revision,updatedAt:workout.updatedAt,totalSets:total,completedSets:completed,exerciseCount:workout.entries.length,exerciseSummaries:[...groups.values()]};
  }
  function metrics(entry){
    if(entry.measurement==="timed")return[{key:"maxSeconds",label:"Longest set",unit:"seconds"},{key:"totalSeconds",label:"Total time",unit:"seconds"}];
    if(entry.loadType==="external")return[{key:"maxWeight",label:"Heaviest completed set",unit:entry.unit},{key:"volume",label:"External load × reps",unit:`${entry.unit}·reps`},{key:"maxReps",label:"Most reps in one set",unit:"reps"}];
    return[{key:"maxReps",label:"Most reps in one set",unit:"reps"},{key:"totalReps",label:"Total repetitions",unit:"reps"}];
  }
  function series(workouts,key,metric){
    return workouts.filter((workout)=>workout.status==="completed").flatMap((workout)=>{
      const groups=workout.exerciseSummaries.filter((entry)=>formatKey(entry)===key&&entry.completedSets>0);
      if(!groups.length)return[];
      const entry=groups[0];
      if(!metrics(entry).some((item)=>item.key===metric))return[];
      const values=groups.map((group)=>group[metric]).filter((value)=>Number.isFinite(value)&&value>=0);
      if(!values.length)return[];
      const value=metric.startsWith("max")?Math.max(...values):values.reduce((total,current)=>total+current,0);
      return[{id:workout.id,date:workout.date,startedAt:workout.startedAt,value:Math.round(value*100)/100}];
    }).sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
  }
  function bestInWindow(points){return points.length?Math.max(...points.map((point)=>point.value)):null;}
  function previousComparable(history,entry,excludeId="",beforeStartedAt=Infinity){
    const key=formatKey(entry),ordered=[...(Array.isArray(history)?history:[])].sort((a,b)=>Number(b.startedAt)-Number(a.startedAt));
    for(const workout of ordered){
      if(workout?.id===excludeId||workout?.status!=="completed"||Number(workout.startedAt)>=beforeStartedAt)continue;
      const match=(workout.exerciseSummaries||[]).find((item)=>formatKey(item)===key&&Array.isArray(item.setValues));
      if(match)return{workoutId:workout.id,date:workout.date,sets:copy(match.setValues),unit:entry.unit,measurement:entry.measurement,loadType:entry.loadType};
    }
    return null;
  }
  function prescriptionValue(entry){
    const match=String(entry?.prescribedReps||"").match(/\d+(?:\.\d+)?/);
    if(!match)return null;
    let value=Number(match[0]);
    if(entry.measurement==="timed"&&/\bmins?|minutes?\b/i.test(entry.prescribedReps))value*=60;
    return Number.isFinite(value)&&value>0?Math.round(value):null;
  }
  function suggestedTargets(entry,memory){
    const source=memory?.sets?.length?"previous":"prescription",fallback=prescriptionValue(entry);
    const sets=entry.sets.map((_,index)=>{
      const prior=memory?.sets?.[Math.min(index,memory.sets.length-1)]||{};
      return{reps:entry.measurement==="reps"?(Number.isInteger(prior.reps)?prior.reps:fallback):null,seconds:entry.measurement==="timed"?(Number.isInteger(prior.seconds)?prior.seconds:fallback):null,weight:entry.loadType!=="bodyweight"&&typeof prior.weight==="number"?prior.weight:null,effort:null};
    });
    return{source,sets,explanation:source==="previous"?`Repeat the last comparable set values from ${memory.date}; progress only when the work feels controlled.`:"Start with the low end of the written prescription. STRATA will not guess a load."};
  }
  function hasSetValues(entry){return entry.sets.some((set)=>set.completed||set.reps!==null||set.weight!==null||set.seconds!==null||set.effort!==null&&set.effort!==undefined);}
  function applyTargets(entry,values){
    if(hasSetValues(entry))throw new Error("Clear this exercise's logged values before applying a saved target.");
    entry.sets.forEach((set,index)=>{
      const value=values[Math.min(index,values.length-1)];if(!value)return;
      set.reps=entry.measurement==="reps"&&Number.isInteger(value.reps)?value.reps:null;
      set.seconds=entry.measurement==="timed"&&Number.isInteger(value.seconds)?value.seconds:null;
      set.weight=entry.loadType!=="bodyweight"&&typeof value.weight==="number"?value.weight:null;
      set.effort=null;
    });
  }
  function addSet(entry){if(entry.sets.length>=10)throw new Error("An exercise can have at most 10 sets.");entry.sets.push(blankSet());return entry.sets.length-1;}
  function duplicateSet(entry,index){
    if(entry.sets.length>=10)throw new Error("An exercise can have at most 10 sets.");
    const source=entry.sets[index];if(!source)throw new Error("Choose a set to duplicate.");
    entry.sets.splice(index+1,0,{...copy(source),completed:false});return index+1;
  }
  function removeSet(entry,index){
    if(entry.sets.length<=1)throw new Error("Keep at least one set for each exercise.");
    if(!entry.sets[index])throw new Error("Choose a set to remove.");
    if(entry.sets[index].completed)throw new Error("Uncheck this set before removing it.");
    entry.sets.splice(index,1);return Math.max(0,index-1);
  }
  function warmupSets(target){
    const value=Number(target);if(!Number.isFinite(value)||value<=0||value>1000)return[];
    return[[.4,8],[.6,5],[.8,3]].map(([percent,reps])=>({percent:Math.round(percent*100),load:Math.round(value*percent*2)/2,reps}));
  }
  const PLATES={kg:[25,20,15,10,5,2.5,1.25],lb:[45,35,25,10,5,2.5]};
  function plateInventory(unit){return[...(PLATES[unit]||PLATES.kg)];}
  function plateBreakdown(target,bar=20,plates=PLATES.kg){
    const total=Number(target),barWeight=Number(bar);
    if(!Number.isFinite(total)||!Number.isFinite(barWeight)||total<barWeight||barWeight<0||total>1000)return{pairs:[],remainder:null,achievable:false};
    let perSide=(total-barWeight)/2;const pairs=[];
    for(const plate of [...plates].filter((value)=>Number.isFinite(value)&&value>0).sort((a,b)=>b-a)){
      const count=Math.floor((perSide+.000001)/plate);if(count){pairs.push({plate,count});perSide-=plate*count;}
    }
    const remainder=Math.round(perSide*100)/100;return{pairs,remainder,achievable:remainder<.01};
  }
  function swapComparison(reference,candidate){
    const sameTarget=reference?.sub===candidate?.sub,sameGroup=reference?.group===candidate?.group;
    const fitDelta=Number(candidate?.score||0)-Number(reference?.score||0),stabilityDelta=Number(candidate?.metrics?.stability||0)-Number(reference?.metrics?.stability||0);
    return{compatible:sameTarget||sameGroup,target:sameTarget?reference.sub:sameGroup?reference.group:"Different target",fitDelta,stabilityDelta,explanation:`${sameTarget?`Same ${String(reference.sub).toLowerCase()} target`:`Same ${String(reference.group||"training").toLowerCase()} group`} · ${candidate.equipment}. FitScore ${fitDelta===0?"unchanged":`${fitDelta>0?"+":""}${fitDelta}`}; stability ${stabilityDelta===0?"unchanged":`${stabilityDelta>0?"+":""}${stabilityDelta}`}.`};
  }
  function planSwapProposal(plan,day,entry,nextExerciseId){
    const result=copy(plan),items=result?.days?.[day];if(!Array.isArray(items))throw new Error("This workout is no longer linked to that Plan day.");
    let index=entry.planInstanceId?items.findIndex((item)=>item.instanceId===entry.planInstanceId):-1;
    if(index<0){const matches=items.map((item,itemIndex)=>item.exerciseId===entry.exerciseId?itemIndex:-1).filter((itemIndex)=>itemIndex>=0);if(matches.length!==1)throw new Error("Open Plan to choose which repeated exercise should change.");index=matches[0];}
    const before=items[index].exerciseId;items[index].exerciseId=nextExerciseId;return{plan:result,index,before,after:nextExerciseId};
  }
  function payload(workout){
    const fields=["id","title","planDay","date","status","startedAt","completedAt","elapsedSeconds","restEndsAt","entries"];
    const normalized=normalizeWorkout(workout),result=Object.fromEntries(fields.map((field)=>[field,copy(normalized[field])]));
    result.entries=normalized.entries.map((entry)=>({id:entry.id,exerciseId:entry.exerciseId,planInstanceId:entry.planInstanceId,measurement:entry.measurement,loadType:entry.loadType,unit:entry.unit,prescribedReps:entry.prescribedReps,note:entry.note.trim(),effortType:entry.effortType,supersetGroup:entry.supersetGroup,replacedFromExerciseId:entry.replacedFromExerciseId,sets:entry.sets.map((set)=>({reps:set.reps,weight:set.weight,seconds:set.seconds,completed:set.completed,effort:set.effort}))}));
    return result;
  }
  function matches(saved,snapshot){
    try{return JSON.stringify(payload(saved))===JSON.stringify(payload(snapshot));}catch{return false;}
  }
  function draftPrefix(ownerId){
    if(typeof ownerId!=="string"||!ownerId)throw new Error("An explicit storage owner is required.");
    return `strata_workout_draft_v1:${encodeURIComponent(ownerId)}:`;
  }
  function storedValueError(entry,set,field){
    const value=set[field],limit={reps:1000,seconds:3600}[field];
    if(value===null||value===undefined&&!limit)return false;
    if(typeof value!=="number"||!Number.isFinite(value)||value<0)return true;
    if(limit)return !Number.isInteger(value)||value>limit;
    return field==="weight"?value>1000:Boolean(effortError(entry,set));
  }
  function parseDraft(raw,ownerId,repairs){
    try{
      const record=JSON.parse(raw);
      const workout=record.workout;
      if(record.ownerId!==ownerId||!workout||typeof workout.id!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(workout.id)||!Array.isArray(workout.entries)||workout.entries.length<1||workout.entries.length>30)return null;
      if(!["active","completed"].includes(workout.status)||!Number.isFinite(workout.startedAt)||!/^\d{4}-\d{2}-\d{2}$/.test(workout.date))return null;
      for(const entry of workout.entries){
        if(typeof entry.id!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.id)||typeof entry.exerciseId!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.exerciseId)||!["reps","timed"].includes(entry.measurement)||!["external","bodyweight","assisted"].includes(entry.loadType)||!["kg","lb"].includes(entry.unit)||!Array.isArray(entry.sets)||entry.sets.length<1||entry.sets.length>10)return null;
        const normalized={...entry,effortType:entry.effortType||"none"};
        if(entry.note!==undefined&&(typeof entry.note!=="string"||entry.note.length>500||new RegExp(UNSAFE_NOTE.source).test(entry.note))||normalized.effortType&&!['none','rir','rpe'].includes(normalized.effortType)||entry.planInstanceId!==undefined&&entry.planInstanceId!==""&&!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.planInstanceId)||entry.supersetGroup!==undefined&&entry.supersetGroup!==""&&!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.supersetGroup)||entry.replacedFromExerciseId!==undefined&&entry.replacedFromExerciseId!==""&&!/^[a-zA-Z0-9_-]{1,100}$/.test(entry.replacedFromExerciseId))return null;
        for(const [setIndex,set] of entry.sets.entries()){
          if(!set||typeof set.completed!=="boolean")return null;
          for(const field of ["reps","seconds","weight","effort"])if(storedValueError(normalized,set,field)){if(!repairs)return null;repairs.push({entryId:entry.id,exerciseId:entry.exerciseId,setIndex,field,value:set[field]});set[field]=null;}
          if(set.completed&&actualError(normalized,set)){if(!repairs)return null;repairs.push({entryId:entry.id,exerciseId:entry.exerciseId,setIndex,field:"completed",value:true});set.completed=false;}
        }
      }
      return{...record,workout:normalizeWorkout(workout)};
    }catch{return null;}
  }
  function readDraft(raw,ownerId){return parseDraft(raw,ownerId,null);}
  // Opens a draft whose only problems are invalid set values, listing each value it cleared.
  function repairDraft(raw,ownerId){const repairs=[],record=parseDraft(raw,ownerId,repairs);return record?{record,repairs}:null;}
  return{DAYS,copy,localDate,today,dayFromSearch,id,inferFormat,blankSet,normalizeWorkout,createWorkout,effortError,actualError,inputError,cleanNote,progress,planDaySummary,nextIncompleteSet,remainingSeconds,offlineAccessUntil,duration,formatKey,summary,metrics,series,bestInWindow,previousComparable,suggestedTargets,hasSetValues,applyTargets,addSet,duplicateSet,removeSet,warmupSets,plateInventory,plateBreakdown,swapComparison,planSwapProposal,payload,matches,draftPrefix,readDraft,repairDraft};
});
