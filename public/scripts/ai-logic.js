/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAiLogic=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const LIMITS=Object.freeze({messageChars:1200,historyTurns:6,storedMessages:40,replyInHistory:320,historyChars:1200});
  const DAYS=Object.freeze(["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]);
  const STARTERS=Object.freeze([
    Object.freeze({label:"Plan a 3-day full-body week",message:"Plan a 3-day full-body week for me."}),
    Object.freeze({label:"Push, pull, legs with dumbbells",message:"Build me a push, pull, legs week using only dumbbells."}),
    Object.freeze({label:"4 days, 45 minutes, glutes first",message:"I can train 4 days a week for about 45 minutes. Focus on glutes and legs."}),
    Object.freeze({label:"Set calories for gentle fat loss",message:"Set up my calorie targets for gentle fat loss."})
  ]);
  const SUGGESTION_PROMPT="Review my plan and suggest improvements.";
  const GOALS=Object.freeze({fat_loss:"Fat loss",maintenance:"Maintenance",muscle_gain:"Muscle gain"});
  const FOCUS=Object.freeze({balanced:"Balanced",strength:"Strength",hypertrophy:"Muscle growth"});
  const MACROS=Object.freeze({balanced:"Balanced macros",higher_protein:"Higher protein"});
  // Requests that may succeed if asked again; anything else needs the member to change something first.
  const RETRYABLE=new Set(["AI_OFFLINE","AI_TIMEOUT","AI_BUSY","AI_UNAVAILABLE","AI_BAD_OUTPUT","AI_EMPTY","AI_FAILED","AI_REQUEST_NOT_FOUND","NETWORK_ERROR","REQUEST_FAILED","AI_RATE_LIMIT"]);

  const isRecord=value=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
  const whole=value=>Math.round(Number(value)||0).toLocaleString("en-US");
  const shortDay=day=>String(day||"").slice(0,3);
  const list=items=>items.length<=1?items.join(""):`${items.slice(0,-1).join(", ")} and ${items.at(-1)}`;

  function messageError(value){
    const text=String(value??"").trim();
    if(!text)return "Write what you would like Strata AI to plan.";
    if(text.length>LIMITS.messageChars)return `Keep your message under ${whole(LIMITS.messageChars)} characters.`;
    return "";
  }

  /** A compact, name-based description of a proposed week, so follow-up requests can refer to it. */
  function describeWeek(week){
    if(!isRecord(week)||!Array.isArray(week.days))return "";
    const days=week.days.map(day=>`${day.day} ${day.name}: ${(day.exercises||[]).map(item=>`${item.name} ${item.sets}x${item.reps}`).join(", ")}`);
    return `Proposed week "${week.title}" (${week.sessionMinutes} min). ${days.join(". ")}. Rest: ${(week.restDays||[]).join(", ")||"none"}.`;
  }

  /** The recent conversation in the shape the server accepts: alternating turns, member first, at most six pairs. */
  function historyFor(messages){
    const turns=[];
    for(const message of Array.isArray(messages)?messages:[]){
      if(message?.role==="user"&&message.text)turns.push({role:"user",content:String(message.text).slice(0,LIMITS.historyChars)});
      else if(message?.role==="assistant"&&message.result?.reply){
        const reply=String(message.result.reply).slice(0,LIMITS.replyInHistory),week=describeWeek(message.result.week);
        turns.push({role:"assistant",content:`${reply}${week?` ${week}`:""}`.slice(0,LIMITS.historyChars)});
      }
    }
    const paired=[];
    for(const turn of turns){if(!paired.length&&turn.role==="assistant")continue;if(paired.at(-1)?.role===turn.role)paired[paired.length-1]=turn;else paired.push(turn);}
    if(paired.at(-1)?.role==="user")paired.pop();
    return paired.slice(-LIMITS.historyTurns*2);
  }

  function weekStats(week){
    const days=Array.isArray(week?.trainingDays)?week.trainingDays.length:0;
    return `${days} training day${days===1?"":"s"} · about ${whole(week?.sessionMinutes)} min · ${whole(week?.workingSets)} working sets`;
  }
  const focusLabel=value=>FOCUS[value]||FOCUS.balanced;

  function patternLabel(changes){
    if(changes?.caloriePattern==="zigzag")return "Higher on training days";
    if(changes?.caloriePattern==="flexible_day")return `One flexible day (${changes.flexibleDay||"Saturday"})`;
    return "Same target every day";
  }
  function nutritionLines(changes){
    if(!isRecord(changes))return [];
    const goal=GOALS[changes.goal]||GOALS.maintenance,pace=changes.goal==="maintenance"?"":`, ${changes.goalPace==="gentle"?"gentle":"moderate"} pace`;
    return [`${goal}${pace}`,patternLabel(changes),MACROS[changes.macroPreference]||"Calories only"];
  }
  function alignmentText(nutrition){
    const alignment=nutrition?.alignment;
    if(!isRecord(alignment)||!Array.isArray(alignment.workoutDays))return "";
    const source=nutrition.basedOn==="proposed"?"this week":"your saved plan";
    return `Your personal setup’s training days will change to ${list(alignment.workoutDays.map(shortDay))}, ${whole(alignment.sessionMinutes)} minutes each, so the targets match ${source}.`;
  }
  function dailyTargets(preview){
    const targets=Array.isArray(preview?.dailyTargets)?preview.dailyTargets:[];
    return targets.map(item=>({day:shortDay(item.day),calories:whole(item.calories),protein:Number(item?.macros?.proteinG)>0?`${whole(item.macros.proteinG)} g protein`:"",training:item.kind==="higher_training_day"}));
  }

  /** The saved plan with one exercise replaced, or null when the plan no longer holds that exercise. */
  function swapPlan(plan,action){
    if(!isRecord(plan?.days)||!isRecord(action)||action.type!=="swap"||!DAYS.includes(action.day))return null;
    const items=Array.isArray(plan.days[action.day])?plan.days[action.day]:[];
    const index=items.findIndex(item=>item?.instanceId===action.instanceId&&item?.exerciseId===action.fromExerciseId);
    if(index<0||items.some(item=>item?.exerciseId===action.toExerciseId))return null;
    const next=items.map((item,position)=>position===index?{...item,exerciseId:action.toExerciseId,reps:String(action.toReps||item.reps).slice(0,20)}:item);
    return {...plan,days:{...plan.days,[action.day]:next}};
  }
  function planExerciseCount(plan){return DAYS.reduce((sum,day)=>sum+(Array.isArray(plan?.days?.[day])?plan.days[day].length:0),0);}

  function statusView(status){
    if(!status)return {tone:"checking",title:"Checking Strata AI…",detail:"",canAsk:false};
    if(!status.configured)return {tone:"offline",title:"Strata AI isn’t switched on yet",detail:"Your plan and nutrition tools work as usual. Check back soon.",canAsk:false};
    if(Number(status.remainingToday)<=0)return {tone:"limit",title:"You’ve used today’s requests",detail:`Strata AI allows ${whole(status.dailyLimit)} requests a day. They reset at midnight UTC.`,canAsk:false};
    const left=`${whole(status.remainingToday)} of ${whole(status.dailyLimit)} requests left today`;
    if(!status.online)return {tone:"offline",title:"Strata AI may be offline",detail:`You can still ask; it will answer if it comes back. ${left}.`,canAsk:true};
    return {tone:"online",title:"Strata AI is ready",detail:left,canAsk:true};
  }
  function pendingText(request,elapsedMs=0){
    if(request?.status==="queued"&&Number(request.position)>0)return Number(request.position)===1?"You’re next in line…":`You’re number ${whole(request.position)} in line…`;
    if(elapsedMs>45000)return "Still working. Detailed weeks can take up to a minute or two…";
    return "Strata AI is planning…";
  }
  function errorView(error){
    const code=String(error?.code||"AI_FAILED");
    const message=String(error?.message||"").trim()||"Strata AI could not finish that request. Try again.";
    return {code,message,retry:RETRYABLE.has(code)};
  }
  function pollDelay(elapsedMs){return elapsedMs<20000?1500:elapsedMs<60000?2500:4000;}

  /** Conversation saved in this tab, checked before use because storage is outside the page's control. */
  function restoreConversation(value){
    if(!isRecord(value)||!Array.isArray(value.messages))return {messages:[],pending:null};
    const messages=value.messages.filter(message=>isRecord(message)&&typeof message.id==="string"&&["user","assistant","error"].includes(message.role)).slice(-LIMITS.storedMessages);
    const source=isRecord(value.pending)?value.pending:null,kind=source?.kind==="suggestions"?"suggestions":"chat";
    const retry=isRecord(source?.retry)&&typeof source.retry.message==="string"&&!(kind==="chat"&&messageError(source.retry.message))?{kind,message:source.retry.message}:null;
    const pending=source&&/^[a-f0-9-]{36}$/.test(String(source.id))?{id:source.id,kind,startedAt:Number(source.startedAt)||Date.now(),retry}:null;
    return {messages,pending};
  }
  function newId(){return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;}

  return Object.freeze({LIMITS,STARTERS,SUGGESTION_PROMPT,alignmentText,dailyTargets,describeWeek,errorView,focusLabel,historyFor,messageError,newId,nutritionLines,patternLabel,pendingText,planExerciseCount,pollDelay,restoreConversation,statusView,swapPlan,weekStats});
});
