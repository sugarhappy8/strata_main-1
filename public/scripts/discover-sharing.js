/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataDiscoverSharing=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createSharing({state,document,navigator,urlApi,fileCtor,labels,exerciseById,titleCase,personalResult,personalLabel,comparisonWinner,showToast}){
    function cardLines(kind,id){
      if(kind==="exercise"){const exercise=exerciseById(id),personal=personalResult(exercise);return{eyebrow:`${labels[exercise.group]||titleCase(exercise.group)} / ${exercise.sub}`,title:exercise.name,score:`${exercise.score}`,scoreLabel:"OFFICIAL FITSCORE",lines:[personalLabel(personal,{long:true}),`${exercise.equipment} · ${exercise.pattern}`,exercise.why],footer:"Evidence-aware Strata+ comparison"};}
      if(kind==="comparison"){const exercises=state.compare.map(exerciseById).filter(Boolean),verdict=comparisonWinner(exercises);return{eyebrow:"EXERCISE BATTLE",title:exercises.map((exercise)=>exercise.name).join(" vs. "),score:verdict.winner?String(verdict.winner.score):"—",scoreLabel:verdict.winner?"LEADING FITSCORE":"NO UNIVERSAL WINNER",lines:exercises.map((exercise)=>`${exercise.score} FitScore · ${personalLabel(personalResult(exercise))} — ${exercise.name}`),footer:"Compare the trade-offs, not just the score"};}
      const top=state.recommendations.slice(0,5);return{eyebrow:"PERSONALIZED SHORTLIST",title:`${titleCase(state.preferences.goal)} selection`,score:String(top[0]?.result.match||"—"),scoreLabel:"TOP PERSONAL MATCH",lines:top.map(({exercise,result},index)=>`${index+1}. ${exercise.name} — ${result.match}% match`),footer:`${state.preferences.days} days · ${state.preferences.level} · community ratings separate`};
    }
    // Fills every allowed line, then ends the last one with an ellipsis only when words remain.
    function wrapCanvasText(ctx,text,x,y,maxWidth,lineHeight,maxLines=3){
      const fits=(value)=>ctx.measureText(value).width<=maxWidth,lines=[];
      for(const word of String(text).split(/\s+/).filter(Boolean)){const last=lines.length-1,test=last>=0?`${lines[last]} ${word}`:word;if(last>=0&&fits(test))lines[last]=test;else lines.push(word);}
      const shown=lines.slice(0,maxLines);if(lines.length>maxLines)shown[maxLines-1]=lines.slice(maxLines-1).join(" ");
      shown.forEach((line,index)=>{let final=line;if(!fits(final)){while(final&&!fits(`${final}…`))final=final.slice(0,-1);final=`${final.trimEnd()}…`;}ctx.fillText(final,x,y+index*lineHeight);});
      return y+Math.max(1,shown.length)*lineHeight;
    }
    function drawCanvasBrand(ctx){ctx.save();ctx.translate(70,60);ctx.transform(1,0,-.2,1,0,0);ctx.fillStyle="#d4f578";ctx.fillRect(0,14,10,24);ctx.fillRect(15,7,10,31);ctx.fillRect(30,0,10,38);ctx.restore();ctx.fillStyle="#faf9f5";ctx.font="700 42px Manrope, sans-serif";ctx.fillText("STRATA",126,95);}
    async function shareCard(kind,id=null){
      try{
        const data=cardLines(kind,id),canvas=document.createElement("canvas");canvas.width=1080;canvas.height=1350;const ctx=canvas.getContext("2d");if(!ctx)throw new Error("Canvas is unavailable.");
        ctx.fillStyle="#10110f";ctx.fillRect(0,0,1080,1350);ctx.strokeStyle="rgba(212,245,120,.18)";ctx.lineWidth=2;ctx.beginPath();ctx.arc(960,110,360,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.arc(960,110,470,0,Math.PI*2);ctx.stroke();drawCanvasBrand(ctx);ctx.fillStyle="#d4f578";ctx.font="500 20px 'DM Mono', monospace";ctx.fillText(data.eyebrow.toUpperCase(),70,180);ctx.fillStyle="#faf9f5";ctx.font="700 78px Manrope, sans-serif";let y=wrapCanvasText(ctx,data.title.toUpperCase(),70,285,900,86,3);y=Math.max(y+35,515);ctx.fillStyle="#d4f578";ctx.font="700 190px Manrope, sans-serif";ctx.fillText(data.score,70,y+150);ctx.fillStyle="#faf9f5";ctx.font="500 21px 'DM Mono', monospace";ctx.fillText(data.scoreLabel,310,y+130);
        let lineY=y+245;ctx.strokeStyle="rgba(255,255,255,.22)";for(const line of data.lines.slice(0,5)){ctx.beginPath();ctx.moveTo(70,lineY-34);ctx.lineTo(1010,lineY-34);ctx.stroke();ctx.fillStyle="#faf9f5";ctx.font="500 30px Manrope, sans-serif";lineY=wrapCanvasText(ctx,line,70,lineY,920,40,2)+25;}ctx.strokeStyle="rgba(255,255,255,.22)";ctx.beginPath();ctx.moveTo(70,1240);ctx.lineTo(1010,1240);ctx.stroke();ctx.fillStyle="rgba(255,255,255,.55)";ctx.font="500 18px 'DM Mono', monospace";ctx.fillText(data.footer.toUpperCase(),70,1290);ctx.fillStyle="#d4f578";ctx.textAlign="right";ctx.fillText("STRATAFITNESS.ONLINE",1010,1290);ctx.textAlign="left";
        const blob=await new Promise((resolve)=>canvas.toBlob(resolve,"image/png"));if(!blob)throw new Error("Image export is unavailable.");const filename=`strata-${kind}-${Date.now()}.png`;
        if(typeof fileCtor==="function"&&navigator.share){const file=new fileCtor([blob],filename,{type:"image/png"});if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:`STRATA ${kind} card`,text:"Exercise intelligence from STRATA"});return;}catch(error){if(error.name==="AbortError")return;}}}
        const url=urlApi.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=filename;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>urlApi.revokeObjectURL(url),1000);showToast("Share card downloaded.");
      }catch(error){showToast(`Share failed: ${error.message}`);}
    }
    return{cardLines,drawCanvasBrand,shareCard,wrapCanvasText};
  }

  return{createSharing};
});
