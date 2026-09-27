/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverProgress=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const WEEK_MS=7*24*60*60*1000;
  function localNoon(date,offset=0){return new Date(date.getFullYear(),date.getMonth(),date.getDate()+offset,12);}
  function localDateKey(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
  function weekContext(now=new Date(),days=[]){
    const today=localNoon(now),todayIndex=(today.getDay()+6)%7,monday=localNoon(today,-todayIndex),dates=days.map((day,index)=>({day,date:localNoon(monday,index)}));
    return{today,todayIndex,monday,dates,dateKeys:new Set(dates.map(({date})=>localDateKey(date)))};
  }
  function safeWorkoutList(value){return Array.isArray(value)?value.filter((workout)=>workout&&typeof workout==="object"&&typeof workout.id==="string"&&["active","completed"].includes(workout.status)&&Array.isArray(workout.exerciseSummaries)):[];}
  function completedWorkouts(workouts){return safeWorkoutList(workouts).filter((workout)=>workout.status==="completed").sort((a,b)=>Number(b.startedAt||0)-Number(a.startedAt||0));}
  function completedThisWeek(workouts,days,now=new Date()){const week=weekContext(now,days);return completedWorkouts(workouts).filter((workout)=>week.dateKeys.has(String(workout.date||"")));}
  function scheduledDays(plan,days){return days.filter((day)=>Array.isArray(plan?.days?.[day])&&plan.days[day].length);}
  function formatDuration(seconds){
    const safe=Math.max(0,Math.round(Number(seconds)||0));
    if(safe<60)return `${safe} sec`;
    const minutes=Math.floor(safe/60),remainder=safe%60;
    return remainder?`${minutes}m ${remainder}s`:`${minutes} min`;
  }
  function compactNumber(value){
    const number=Math.round((Number(value)||0)*10)/10;
    return new Intl.NumberFormat(undefined,{maximumFractionDigits:1,notation:Math.abs(number)>=10_000?"compact":"standard"}).format(number);
  }
  function summaryMetric(summary){
    if(!summary||Number(summary.completedSets)<=0)return null;
    if(summary.measurement==="timed"&&Number(summary.maxSeconds)>0)return{key:"time",value:Number(summary.maxSeconds),label:"Longest set",formatted:formatDuration(summary.maxSeconds),higher:true};
    if(summary.loadType==="external"&&Number(summary.maxWeight)>0){const unit=summary.unit==="lb"?"lb":"kg";return{key:`load:${unit}`,value:Number(summary.maxWeight),label:"Top load",formatted:`${compactNumber(summary.maxWeight)} ${unit}`,higher:true};}
    if(summary.loadType==="assisted"&&summary.minAssistance!=null&&Number(summary.maxReps)>0){const unit=summary.unit==="lb"?"lb":"kg";return{key:`assistance:${unit}`,value:Number(summary.minAssistance),label:"Assistance",formatted:`${compactNumber(summary.minAssistance)} ${unit} assistance`,higher:false};}
    if(Number(summary.maxReps)>0)return{key:"reps",value:Number(summary.maxReps),label:"Most reps",formatted:`${compactNumber(summary.maxReps)} reps`,higher:true};
    return null;
  }
  function summaryKey(summary,metric){return `${String(summary.exerciseId||"")}:${String(summary.measurement||"")}:${String(summary.loadType||"")}:${String(summary.unit||"")}:${metric.key}`;}
  function better(metric,than){return metric.higher?metric.value>than.value:metric.value<than.value;}
  // Like-for-like change against the previous session that recorded the same exercise, measurement, load type, and unit.
  function metricChange(latest,previous){
    if(!previous)return{direction:"first",text:"First log"};
    const difference=Math.round((latest.value-previous.value)*10)/10,size=Math.abs(difference),[kind,unit]=latest.key.split(":");
    if(difference===0)return{direction:"same",text:"No change"};
    const direction=better(latest,previous)?"up":"down",sign=difference>0?"+":"−";
    if(kind==="assistance")return{direction,text:`${compactNumber(size)} ${unit} ${difference<0?"less":"more"} assistance`};
    return{direction,text:kind==="time"?`${sign}${formatDuration(size)}`:kind==="reps"?`${sign}${compactNumber(size)} rep${size===1?"":"s"}`:`${sign}${compactNumber(size)} ${unit}`};
  }
  // One row per comparable exercise record, so a result is never listed twice as both an improvement and a best.
  function exerciseRecords(workouts,limit=6){
    const records=new Map();
    for(const workout of completedWorkouts(workouts).slice().reverse())for(const summary of workout.exerciseSummaries){
      const metric=summaryMetric(summary);if(!metric)continue;
      const key=summaryKey(summary,metric),record=records.get(key)||{key,exerciseId:String(summary.exerciseId||""),sessions:0,latest:null,previous:null,best:null};
      record.previous=record.latest;record.latest={metric,workout};record.sessions+=1;
      if(!record.best||better(metric,record.best.metric))record.best={metric,workout};
      records.set(key,record);
    }
    return[...records.values()].sort((a,b)=>Number(b.latest.workout.startedAt||0)-Number(a.latest.workout.startedAt||0)).slice(0,limit).map((record)=>({...record,change:metricChange(record.latest.metric,record.previous?.metric),newBest:record.sessions>1&&record.best.workout===record.latest.workout}));
  }
  function workoutDate(workout){
    const date=typeof workout.date==="string"&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(workout.date)?new Date(`${workout.date}T12:00:00`):new Date(Number(workout.completedAt||workout.startedAt||0));
    return Number.isNaN(date.getTime())?null:date;
  }
  // Rounding (not flooring) keeps a daylight-saving shift from moving last week's session into this week.
  function weeksAgo(workout,currentMonday,days){const date=workoutDate(workout);return date?Math.round((currentMonday.getTime()-weekContext(date,days).monday.getTime())/WEEK_MS):null;}
  function fourWeekConsistency(workouts,days,now=new Date()){
    const currentMonday=weekContext(now,days).monday,weeks=new Set();
    for(const workout of workouts){const index=weeksAgo(workout,currentMonday,days);if(index!=null&&index>=0&&index<4)weeks.add(index);}
    return weeks.size;
  }
  function addVolume(target,workout){for(const summary of workout.exerciseSummaries){if(summary.loadType!=="external"||!(Number(summary.volume)>0))continue;const unit=summary.unit==="lb"?"lb":"kg";target.set(unit,(target.get(unit)||0)+Number(summary.volume));}return target;}
  function volumeLabel(volumes){return[...volumes].map(([unit,value])=>`${compactNumber(Math.round(value))} ${unit}`).join(" + ");}
  function weeklyHistory(workouts,days,now=new Date(),count=8){
    const currentMonday=weekContext(now,days).monday,weeks=Array.from({length:count},(_,index)=>({start:localNoon(currentMonday,-7*(count-1-index)),weeksAgo:count-1-index,workouts:0,volumes:new Map()}));
    for(const workout of completedWorkouts(workouts)){const index=weeksAgo(workout,currentMonday,days);if(index==null||index<0||index>=count)continue;const week=weeks[count-1-index];week.workouts+=1;addVolume(week.volumes,workout);}
    return weeks.map((week)=>({...week,current:week.weeksAgo===0,volume:volumeLabel(week.volumes)}));
  }
  function volumeChange(current,previous){
    if(current.size!==1||previous.size!==1)return"";
    const [[unit,value]]=[...current],before=previous.get(unit);if(!(before>0))return"";
    const percent=Math.round((value-before)/before*100);return percent===0?"Level with last week.":`${percent>0?"+":"−"}${Math.abs(percent)}% vs last week.`;
  }
  function snapshot({workouts,weeklyPlan,days,now=new Date(),hasMore=false}){
    const completed=completedWorkouts(workouts),weekSessions=completedThisWeek(completed,days,now),planned=scheduledDays(weeklyPlan,days),completedDays=new Set(weekSessions.map((workout)=>String(workout.planDay||"")).filter((day)=>planned.includes(day)));
    const currentMonday=weekContext(now,days).monday,volumes=weekSessions.reduce((total,workout)=>addVolume(total,workout),new Map()),previousVolumes=completed.filter((workout)=>weeksAgo(workout,currentMonday,days)===1).reduce((total,workout)=>addVolume(total,workout),new Map());
    return{
      completed,weekSessions,planned,records:exerciseRecords(completed),weeks:weeklyHistory(completed,days,now),
      adherence:planned.length?`${completedDays.size} / ${planned.length}`:`${weekSessions.length}`,
      adherenceDetail:planned.length?`${completedDays.size} of ${planned.length} planned ${planned.length===1?"day":"days"} done this calendar week.`:`${weekSessions.length} completed ${weekSessions.length===1?"session":"sessions"} this week; no weekly plan is set.`,
      volume:volumeLabel(volumes)||"No load logged",volumeDetail:volumes.size?`Load × reps from completed sets. ${volumeChange(volumes,previousVolumes)||"No comparable load last week."}`:"Only completed sets with an external load count toward volume.",
      consistency:`${fourWeekConsistency(completed,days,now)} / 4 weeks`,consistencyDetail:"Calendar weeks with at least one completed workout.",
      sessions:`${completed.length}${hasMore?"+":""}`,sessionsDetail:hasMore?`${completed.length} completed in your 100 most recent sessions. Older history is in the workout log.`:`${weekSessions.length} this week · in-progress sessions are not counted.`
    };
  }

  return{compactNumber,completedThisWeek,completedWorkouts,exerciseRecords,formatDuration,fourWeekConsistency,metricChange,safeWorkoutList,scheduledDays,snapshot,summaryKey,summaryMetric,weekContext,weeklyHistory};
});
