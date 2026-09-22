/* global module */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;root.StrataPersonalTrainingDiaryUi=api;})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const prefixes=["coaching"],fields=["LogDate","CaloriesEaten","MorningWeight","ProteinEaten","CarbsEaten","FatEaten"];
  const validDate=(value)=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  function targetsFor(week){
    const rows=Array.isArray(week?.logTargets)?week.logTargets:week?.nutrition?.dailyTargets||[];
    return rows.filter((row)=>validDate(row?.date)).map((row)=>({...row,day:row.day||new Intl.DateTimeFormat("en-US",{weekday:"long",timeZone:"UTC"}).format(new Date(`${row.date}T00:00:00Z`)),calories:typeof row.calories==="number"&&Number.isFinite(row.calories)&&row.calories>0?row.calories:null}));
  }
  function selectedDate(week,requested,today){const rows=targetsFor(week);return rows.some((row)=>row.date===requested)?requested:rows.some((row)=>row.date===today)?today:rows.at(-1)?.date||"";}
  function context(week,logs,date){const row=targetsFor(week).find((item)=>item.date===date);return row?{row,target:row.calories==null?null:row,log:(logs||[]).find((item)=>item.date===date)||null}:null;}
  function captureForms(el){return prefixes.map((prefix)=>({prefix,values:Object.fromEntries(fields.map((field)=>[field,String(el(`${prefix}${field}`)?.value??"")])),complete:Boolean(el(`${prefix}DayComplete`)?.checked)}));}
  function formsChanged(before,el){return JSON.stringify(before)!==JSON.stringify(captureForms(el));}
  return Object.freeze({targetsFor,selectedDate,context,captureForms,formsChanged});
});
