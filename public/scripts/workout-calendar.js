/* global module */
(function(root,factory){
  "use strict";
  const calendar=factory();
  if(typeof module==="object"&&module.exports)module.exports=calendar;
  else root.StrataWorkoutCalendar=calendar;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";
  const DAY_MS=24*60*60*1000;
  function dateStamp(date){return `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,"0")}${String(date.getDate()).padStart(2,"0")}`;}
  function isoDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;}
  function escapeIcs(value){return String(value||"").replace(/\\/g,"\\\\").replace(/\r?\n/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");}
  // RFC 5545 keeps content lines within 75 octets; a longer line continues on lines that start with a space.
  function fold(line){let out="",size=0;for(const character of line){const point=character.codePointAt(0)||0,bytes=point<0x80?1:point<0x800?2:point<0x10000?3:4;if(size+bytes>75){out+="\r\n ";size=1;}out+=character;size+=bytes;}return out;}
  function nextPlannedSession(plan,days,from=new Date()){
    const start=new Date(from.getFullYear(),from.getMonth(),from.getDate(),12);
    for(let offset=1;offset<=7;offset++){
      const date=new Date(start.getTime()+offset*DAY_MS),day=days[(date.getDay()+6)%7];
      const items=Array.isArray(plan?.days?.[day])?plan.days[day]:[];
      if(items.length)return{day,date:isoDate(date),movements:items.length,workingSets:items.reduce((total,item)=>total+(Number.isFinite(Number(item?.sets))?Math.max(0,Number(item.sets)):0),0)};
    }
    return null;
  }
  function event(session){
    if(!session)return null;
    const start=new Date(`${session.date}T12:00:00`),end=new Date(start.getTime()+DAY_MS),title=`STRATA · ${session.day} workout`;
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//STRATA//Training Plan//EN","CALSCALE:GREGORIAN","BEGIN:VEVENT",`DTSTART;VALUE=DATE:${dateStamp(start)}`,`DTEND;VALUE=DATE:${dateStamp(end)}`,`SUMMARY:${escapeIcs(title)}`,`DESCRIPTION:${escapeIcs(`${session.movements} planned movement${session.movements===1?"":"s"} · ${session.workingSets} working set${session.workingSets===1?"":"s"}. Open STRATA when you are ready to train.`)}`,"END:VEVENT","END:VCALENDAR",""];
    return{...session,title,filename:`strata-${session.date}-${session.day.toLowerCase()}.ics`,href:`data:text/calendar;charset=utf-8,${encodeURIComponent(lines.map(fold).join("\r\n"))}`};
  }
  // One repeating event per planned weekday at a chosen local time, with an optional reminder. Each weekday keeps
  // the same UID and a newer SEQUENCE, so importing a fresh file updates earlier events instead of duplicating them.
  function weeklySchedule(plan,days,{time="18:00",alarmMinutes=30,durationMinutes=60,from=new Date()}={}){
    const planned=days.filter((day)=>Array.isArray(plan?.days?.[day])&&plan.days[day].length),match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time));
    if(!planned.length||!match)return null;
    const codes=["MO","TU","WE","TH","FR","SA","SU"],local=(date)=>`${dateStamp(date)}T${String(date.getHours()).padStart(2,"0")}${String(date.getMinutes()).padStart(2,"0")}00`,stamp=from.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,""),sequence=Math.max(0,Math.floor(from.getTime()/60000));
    const events=planned.flatMap((day)=>{
      const index=days.indexOf(day),start=new Date(from.getFullYear(),from.getMonth(),from.getDate(),Number(match[1]),Number(match[2]));start.setDate(start.getDate()+(index-(start.getDay()+6)%7+7)%7);
      const items=plan.days[day],sets=items.reduce((total,item)=>total+(Number.isFinite(Number(item?.sets))?Math.max(0,Number(item.sets)):0),0),end=new Date(start.getTime()+durationMinutes*60000);
      return["BEGIN:VEVENT",`UID:strata-weekly-${day.toLowerCase()}@stratafitness.online`,`SEQUENCE:${sequence}`,`DTSTAMP:${stamp}`,`DTSTART:${local(start)}`,`DTEND:${local(end)}`,`RRULE:FREQ=WEEKLY;BYDAY=${codes[index]}`,`SUMMARY:${escapeIcs(`STRATA · ${day} workout`)}`,`DESCRIPTION:${escapeIcs(`${items.length} movement${items.length===1?"":"s"} · ${sets} working set${sets===1?"":"s"}. Open STRATA to start.`)}`,...(alarmMinutes>0?["BEGIN:VALARM","ACTION:DISPLAY",`DESCRIPTION:${escapeIcs(`${day} workout`)}`,`TRIGGER:-PT${alarmMinutes}M`,"END:VALARM"]:[]),"END:VEVENT"];
    });
    const ics=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//STRATA//Weekly Training//EN","CALSCALE:GREGORIAN","METHOD:PUBLISH",...events,"END:VCALENDAR",""].map(fold).join("\r\n");
    return{days:planned,filename:"strata-weekly-training.ics",ics,href:`data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`};
  }
  return{nextPlannedSession,event,weeklySchedule};
});
