// @ts-check
"use strict";

/**
 * Profile-v4 activity is deliberately split into ordinary non-workout movement,
 * the generated STRATA sessions, and explicitly entered activity outside STRATA.
 * The PAL anchors are conservative product heuristics informed by the activity
 * descriptions in the 2023 DRI; they are not measured individual PAL values.
 */
const DAILY_MOVEMENT_PAL=Object.freeze({
  mostly_seated:1.35,
  lightly_moving:1.5,
  on_feet:1.6,
  physically_demanding:1.75
});
const ADDITIONAL_ACTIVITY_MET=Object.freeze({light:3,moderate:4.5,vigorous:7});
const RESISTANCE_MET=Object.freeze({adult:3.5,older_adult:4.3});

/** @param {number} value @param {number} low @param {number} high */
function clamp(value,low,high){return Math.max(low,Math.min(high,value));}
/**
 * Gross MET energy minus the resting energy already represented by the PAL base.
 * The oxygen reference belongs to the MET table, not the person's birthday.
 * Standard METs use 3.5; only values from the older-adult MET60+ table use 2.7.
 * @param {{age?:number,weightKg:number,rmrKcal:number,minutes:number,met:number,oxygenMlPerKgMinute?:number}} input
 */
function netActivityKcal({weightKg,rmrKcal,minutes,met,oxygenMlPerKgMinute=3.5}){
  const boundedMinutes=clamp(Number(minutes)||0,0,10080),gross=met*oxygenMlPerKgMinute*weightKg/200*boundedMinutes,resting=rmrKcal/1440*boundedMinutes;
  return Math.max(0,gross-resting);
}
/** @param {any} session */
function usableSession(session){return session&&session.status!=="unavailable"&&Array.isArray(session.exercises)&&session.exercises.length>0&&Number.isFinite(Number(session.estimatedDurationMinutes));}
/**
 * @param {{age:number,weightKg:number,rmrKcal:number,dailyMovement:string,additionalActivityMinutesPerWeek:number,additionalActivityIntensity:string}} profile
 * @param {{sessions?:any[]}|null} training
 */
function activityBudget(profile,training=null){
  const movementPal=DAILY_MOVEMENT_PAL[/** @type {keyof typeof DAILY_MOVEMENT_PAL} */(profile.dailyMovement)];
  const additionalMet=ADDITIONAL_ACTIVITY_MET[/** @type {keyof typeof ADDITIONAL_ACTIVITY_MET} */(profile.additionalActivityIntensity)];
  if(!movementPal||!additionalMet)throw new TypeError("Structured daily movement and additional-activity intensity are required.");
  const rmrKcal=Number(profile.rmrKcal),weightKg=Number(profile.weightKg),age=Number(profile.age),nonWorkoutKcal=rmrKcal*movementPal,resistanceMet=age>=60?RESISTANCE_MET.older_adult:RESISTANCE_MET.adult;
  const resistanceOxygenMlPerKgMinute=age>=60?2.7:3.5,additionalOxygenMlPerKgMinute=3.5;
  const sessions=(Array.isArray(training?.sessions)?training.sessions:[]).filter(usableSession).map((session)=>{
    const seconds=Number.isFinite(session.estimatedDurationSeconds)?session.estimatedDurationSeconds:Number(session.estimatedDurationMinutes)*60,minutes=clamp(seconds/60,0,180),kcal=netActivityKcal({weightKg,rmrKcal,minutes,met:resistanceMet,oxygenMlPerKgMinute:resistanceOxygenMlPerKgMinute});
    return {day:String(session.day||""),minutes:Math.round(minutes),durationSeconds:Math.round(minutes*60),kcal,status:String(session.status||"ready")};
  });
  const plannedTrainingWeekKcal=sessions.reduce((sum,session)=>sum+session.kcal,0),additionalActivityWeekKcal=netActivityKcal({weightKg,rmrKcal,minutes:profile.additionalActivityMinutesPerWeek,met:additionalMet,oxygenMlPerKgMinute:additionalOxygenMlPerKgMinute}),activityWeekKcal=plannedTrainingWeekKcal+additionalActivityWeekKcal;
  return {movementPal,nonWorkoutKcal,plannedTrainingWeekKcal,additionalActivityWeekKcal,activityWeekKcal,targetKcal:nonWorkoutKcal+activityWeekKcal/7,resistanceMet,resistanceOxygenMlPerKgMinute,additionalMet,additionalOxygenMlPerKgMinute,sessions};
}

module.exports={ADDITIONAL_ACTIVITY_MET,DAILY_MOVEMENT_PAL,RESISTANCE_MET,activityBudget,netActivityKcal};
