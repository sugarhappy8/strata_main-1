(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataActivation=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const INTENT_KEY="strata_activation_intent_v1";
  const GUEST_PLAN_KEY="strata_guest_plan_v1";
  const DECISION_PREFIX="strata_activation_decision_v1:";
  const BACKUP_PREFIX="strata_activation_backup_v1:";
  const GOALS=new Set(["balanced","hypertrophy","strength","time-efficient"]);
  const LEVELS=new Set(["Beginner","Intermediate","Advanced"]);
  const MINUTES=new Set([20,35,50]);
  const PREFERENCES=new Set(["stable","long-range","simple-setup","compound","isolation"]);
  const LIMITATIONS=new Set(["no-overhead","no-deep-knee","no-unsupported-hinge","no-floor","no-unilateral"]);

  function copy(value){return JSON.parse(JSON.stringify(value));}
  function safeParse(value){try{return JSON.parse(value);}catch{return null;}}
  function unique(values,allowed,limit=20){return [...new Set(Array.isArray(values)?values:[])].filter(value=>allowed?allowed.has(value):typeof value==="string"&&value.trim()).slice(0,limit);}
  function cleanText(value,max=120){return String(value??"").replace(/[\u0000-\u001f\u007f]/g,"").trim().slice(0,max);}

  function normalizeProfile(value){
    if(!value||typeof value!=="object")return null;
    const goal=GOALS.has(value.goal)?value.goal:"balanced";
    const level=LEVELS.has(value.level)?value.level:"Beginner";
    const minutes=MINUTES.has(Number(value.minutes))?Number(value.minutes):35;
    const availability=unique(value.availability,new Set(DAYS),6);
    const equipment=unique(value.equipment,null,12).map(item=>cleanText(item,80)).filter(Boolean);
    if(!availability.length||!equipment.length)return null;
    return{
      version:1,goal,level,minutes,equipment,availability,
      preferences:unique(value.preferences,PREFERENCES,5),
      limitations:unique(value.limitations,LIMITATIONS,5),
      focusGroup:cleanText(value.focusGroup,24).toLowerCase()
    };
  }

  function normalizePlan(value){
    if(!value||typeof value!=="object"||value.version!==1||!value.days||typeof value.days!=="object")return null;
    const plan={version:1,restDay:null,restDays:[],days:{}};
    const rawRest=Array.isArray(value.restDays)?value.restDays:value.restDay===null||value.restDay===undefined?[]:[value.restDay];
    if(!Array.isArray(rawRest)||rawRest.length>7||rawRest.some(day=>!DAYS.includes(day))||new Set(rawRest).size!==rawRest.length)return null;
    plan.restDays=unique(rawRest,new Set(DAYS),7);
    plan.restDay=plan.restDays[0]??null;
    if(Object.hasOwn(value,"restDays")&&Object.hasOwn(value,"restDay")&&value.restDay!==plan.restDay)return null;
    const seen=new Set();let total=0;
    for(const day of DAYS){
      const items=value.days[day];
      if(!Array.isArray(items)||items.length>30)return null;
      plan.days[day]=[];
      for(const item of items){
        if(!item||typeof item!=="object")return null;
        if(typeof item.instanceId!=="string"||typeof item.exerciseId!=="string"||typeof item.reps!=="string")return null;
        const instanceId=cleanText(item.instanceId,100),exerciseId=cleanText(item.exerciseId,80),sets=item.sets,reps=cleanText(item.reps,20);
        if(instanceId!==item.instanceId||exerciseId!==item.exerciseId||reps!==item.reps.trim())return null;
        if(!/^[a-zA-Z0-9_-]{1,100}$/.test(instanceId)||seen.has(instanceId)||!/^[a-z0-9-]{2,80}$/.test(exerciseId)||!Number.isInteger(sets)||sets<1||sets>10||!reps)return null;
        seen.add(instanceId);plan.days[day].push({instanceId,exerciseId,sets,reps});total+=1;
      }
    }
    if(total>140||plan.restDays.some(day=>plan.days[day].length))return null;
    return plan;
  }

  function planCount(plan){return DAYS.reduce((total,day)=>total+(Array.isArray(plan?.days?.[day])?plan.days[day].length:0),0);}
  function canonicalPlan(plan){
    const normalized=normalizePlan(plan);
    return normalized?JSON.stringify(normalized):"";
  }
  function fingerprint(plan){
    const text=canonicalPlan(plan);if(!text)return"";
    let hash=2166136261;
    for(let index=0;index<text.length;index+=1){hash^=text.charCodeAt(index);hash=Math.imul(hash,16777619);}
    return `${text.length}-${(hash>>>0).toString(36)}`;
  }
  function samePlan(left,right){const a=canonicalPlan(left),b=canonicalPlan(right);return Boolean(a&&b&&a===b);}

  function writeIntent(storage,value,now=Date.now()){
    const profile=normalizeProfile(value?.profile),plan=normalizePlan(value?.plan);
    if(!profile||!plan||!planCount(plan))throw new TypeError("A complete profile and generated week are required.");
    const intent={format:"strata-activation-intent",version:1,source:value?.source==="onboarding"?"onboarding":"homepage",profile,plan,createdAt:Number(value?.createdAt)||now,updatedAt:now};
    storage.setItem(INTENT_KEY,JSON.stringify(intent));
    return copy(intent);
  }
  function readIntent(storage){
    const raw=safeParse(storage.getItem(INTENT_KEY));
    if(raw?.format!=="strata-activation-intent"||raw.version!==1)return null;
    const profile=normalizeProfile(raw.profile),plan=normalizePlan(raw.plan);
    if(!profile||!plan||!planCount(plan))return null;
    return{format:raw.format,version:1,source:raw.source==="onboarding"?"onboarding":"homepage",profile,plan,createdAt:Number(raw.createdAt)||0,updatedAt:Number(raw.updatedAt)||0};
  }
  function readGuestPlan(storage){return normalizePlan(safeParse(storage.getItem(GUEST_PLAN_KEY)));}

  function deviceCandidates(storage){
    const candidates=[],intent=readIntent(storage),guest=readGuestPlan(storage);
    if(intent)candidates.push({id:"homepage",label:"Homepage week preview",source:"homepage",profile:intent.profile,plan:intent.plan,updatedAt:intent.updatedAt,fingerprint:fingerprint(intent.plan)});
    if(guest&&planCount(guest))candidates.push({id:"guest",label:"Free device plan",source:"guest",profile:null,plan:guest,updatedAt:0,fingerprint:fingerprint(guest)});
    const seen=new Set();
    return candidates.filter(candidate=>{if(!candidate.fingerprint||seen.has(candidate.fingerprint))return false;seen.add(candidate.fingerprint);return true;});
  }

  function decisionKey(userId){return `${DECISION_PREFIX}${encodeURIComponent(cleanText(userId,100))}`;}
  function readDecision(storage,userId){
    const value=safeParse(storage.getItem(decisionKey(userId)));
    return value?.format==="strata-activation-decision"&&value.version===1&&String(value.userId)===String(userId)?value:null;
  }
  function acknowledge(storage,{userId,accountRevision=0,accountPlan,candidate,decision},now=Date.now()){
    if(!userId||!candidate?.plan||!["claimed","kept-account"].includes(decision))throw new TypeError("A valid activation decision is required.");
    const value={format:"strata-activation-decision",version:1,userId:String(userId),decision,accountRevision:Number(accountRevision)||0,accountFingerprint:fingerprint(accountPlan),candidateFingerprint:fingerprint(candidate.plan),decidedAt:now};
    storage.setItem(decisionKey(userId),JSON.stringify(value));return value;
  }
  function shouldOffer(storage,{userId,accountRevision=0,accountPlan,candidate}){
    if(!userId||!candidate?.plan||!planCount(candidate.plan)||samePlan(accountPlan,candidate.plan))return false;
    const previous=readDecision(storage,userId);
    return !(previous&&previous.accountRevision===(Number(accountRevision)||0)&&previous.accountFingerprint===fingerprint(accountPlan)&&previous.candidateFingerprint===fingerprint(candidate.plan));
  }

  function backup(storage,{userId,accountRevision=0,accountPlan,candidate,reason},now=Date.now()){
    const current=normalizePlan(accountPlan),device=normalizePlan(candidate?.plan);
    if(!userId||!current||!device)throw new TypeError("Both valid weeks are required for a local backup.");
    const token=`${now}-${fingerprint(device)}`;
    const key=`${BACKUP_PREFIX}${encodeURIComponent(cleanText(userId,100))}:${token}`;
    const value={format:"strata-activation-backup",version:1,userId:String(userId),reason:reason==="claim"?"claim":"keep-account",accountRevision:Number(accountRevision)||0,accountPlan:current,devicePlan:device,deviceSource:candidate.source,createdAt:now};
    storage.setItem(key,JSON.stringify(value));pruneBackups(storage,userId);return{key,value:copy(value)};
  }
  // Keep only the newest safety copies per account; older ones would otherwise pile up on the device forever.
  function pruneBackups(storage,userId,keep=3){
    if(typeof storage?.key!=="function"||!Number.isInteger(storage.length))return;
    const prefix=`${BACKUP_PREFIX}${encodeURIComponent(cleanText(userId,100))}:`,keys=[];
    for(let index=0;index<storage.length;index+=1){const name=storage.key(index);if(typeof name==="string"&&name.startsWith(prefix))keys.push(name);}
    keys.sort((a,b)=>(Number.parseInt(b.slice(prefix.length),10)||0)-(Number.parseInt(a.slice(prefix.length),10)||0));
    for(const name of keys.slice(keep))storage.removeItem(name);
  }

  return{DAYS,INTENT_KEY,GUEST_PLAN_KEY,DECISION_PREFIX,BACKUP_PREFIX,normalizeProfile,normalizePlan,planCount,fingerprint,samePlan,writeIntent,readIntent,readGuestPlan,deviceCandidates,acknowledge,shouldOffer,backup};
});
