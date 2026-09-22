/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPersonalTrainingEnergyUi=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const DAILY_MOVEMENTS=Object.freeze(["mostly_seated","lightly_moving","on_feet","physically_demanding"]);
  const ACTIVITY_INTENSITIES=Object.freeze(["light","moderate","vigorous"]);

  function isRecord(value){return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
  function allowed(value,choices){const normalized=String(value??"").trim().toLowerCase();return choices.includes(normalized)?normalized:"";}
  function wholeNumber(value){if(value==null||value==="")return 0;const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:null;}

  function profileDraftToEnergy(draft){
    const source=isRecord(draft)?draft:{},errors=[];
    const dailyMovement=allowed(source.dailyMovement,DAILY_MOVEMENTS);
    const additionalActivityMinutesPerWeek=wholeNumber(source.additionalActivityMinutesPerWeek);
    const additionalActivityIntensity=allowed(source.additionalActivityIntensity,ACTIVITY_INTENSITIES);
    if(!dailyMovement)errors.push({field:"dailyMovement",message:"Choose your usual daily movement outside planned workouts."});
    if(additionalActivityMinutesPerWeek==null||additionalActivityMinutesPerWeek<0||additionalActivityMinutesPerWeek>1260)errors.push({field:"additionalActivityMinutesPerWeek",message:"Enter 0–1,260 whole minutes of additional activity per week."});
    if(additionalActivityMinutesPerWeek>0&&!additionalActivityIntensity)errors.push({field:"additionalActivityIntensity",message:"Choose the intensity of your additional weekly activity."});
    return{
      ok:errors.length===0,
      payload:{
        dailyMovement,
        additionalActivityMinutesPerWeek:additionalActivityMinutesPerWeek==null?null:additionalActivityMinutesPerWeek,
        additionalActivityIntensity:additionalActivityIntensity||(additionalActivityMinutesPerWeek===0?"moderate":null)
      },
      errors
    };
  }

  function profileEnergyToDraft(profile){
    const source=isRecord(profile)?profile:{},current=Number(source.version)>=4;
    const minutes=current?wholeNumber(source.additionalActivityMinutesPerWeek):0;
    return{
      dailyMovement:current?allowed(source.dailyMovement,DAILY_MOVEMENTS):"",
      additionalActivityMinutesPerWeek:minutes!=null&&minutes>=0&&minutes<=1260?minutes:0,
      additionalActivityIntensity:current?allowed(source.additionalActivityIntensity,ACTIVITY_INTENSITIES)||"moderate":"moderate"
    };
  }

  function hasAdditionalActivity(value){const minutes=wholeNumber(value);return minutes!=null&&minutes>0;}

  function positiveCalories(value){if(!["number","string"].includes(typeof value)||String(value).trim()==="")return null;const parsed=Number(value);return Number.isFinite(parsed)&&parsed>0?parsed:null;}
  function calorieTargetLabel(value,unit="kcal/day"){const calories=positiveCalories(value);return calories==null?"Review required":`${Math.round(calories).toLocaleString()} ${unit}`;}

  function maintenanceDisplay(value){
    const source=isRecord(value)?value:{targetKcal:value},targetKcal=positiveCalories(source.targetKcal??source.baselineKcal);
    const range=[source.planningRangeKcal,source.estimateRangeKcal].find(candidate=>Array.isArray(candidate)&&candidate.length===2&&candidate.every(item=>positiveCalories(item)!=null)&&Number(candidate[0])<=Number(candidate[1]));
    const detail=range?`Planning range: ${Math.round(Number(range[0])).toLocaleString()}–${Math.round(Number(range[1])).toLocaleString()} kcal/day. ${source.rangeLabel||"Not a measured value or a confidence interval."}`:"Planning estimate; actual needs can differ. Intake and morning-weight trends can refine it.";
    return{targetKcal,label:calorieTargetLabel(targetKcal),detail};
  }

  function dailyTargetDisplay(targets){
    const values=(Array.isArray(targets)?targets:[]).map(item=>positiveCalories(item?.calories));
    if(!values.length||values.some(value=>value==null))return{label:"Review required",varies:false};
    const low=Math.round(Math.min(...values)),high=Math.round(Math.max(...values)),varies=low!==high;
    return{label:varies?`${low.toLocaleString()}–${high.toLocaleString()} kcal/day`:calorieTargetLabel(low),varies};
  }

  return Object.freeze({DAILY_MOVEMENTS,ACTIVITY_INTENSITIES,profileDraftToEnergy,profileEnergyToDraft,hasAdditionalActivity,calorieTargetLabel,maintenanceDisplay,dailyTargetDisplay});
});
