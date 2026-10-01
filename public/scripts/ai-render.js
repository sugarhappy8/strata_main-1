/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAiRender=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const WEEK=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

  /**
   * Every piece of model or member text is set with textContent; nothing here parses HTML.
   * A `scroller` keeps new messages scrolling inside a panel (the Strata+ chat) instead of the page.
   */
  function createRenderer({documentImpl=globalThis.document,nodes,logic,energy,scroller=null}){
    const doc=documentImpl;
    let current={applying:""};
    function el(tag,options={},children=[]){
      const node=doc.createElement(tag);
      if(options.className)node.className=options.className;
      if(options.text!=null)node.textContent=String(options.text);
      for(const [name,value] of Object.entries(options.attrs||{}))if(value!=null&&value!==false)node.setAttribute(name,value===true?"":String(value));
      for(const child of children)if(child)node.append(child);
      return node;
    }
    const button=(label,action,id,{extra={},primary=false,disabled=false}={})=>el("button",{className:primary?"ai-button ai-button-primary":"ai-button",text:label,attrs:{type:"button","data-action":action,"data-id":id,disabled,...extra}});
    const kicker=text=>el("p",{className:"ai-card-kicker",text});
    const applied=(text,href,label)=>el("p",{className:"ai-applied",attrs:{role:"note"}},[el("span",{text}),href?el("a",{text:label,attrs:{href}}):null]);

    function weekCard(message){
      const week=message.result.week,id=message.id,done=message.applied?.week,busy=current.applying===`${id}:week`;
      const strip=el("ol",{className:"ai-week-strip",attrs:{"aria-label":"Training and rest days"}},WEEK.map(day=>{
        const training=week.trainingDays.includes(day);
        return el("li",{className:training?"is-training":"is-rest"},[el("abbr",{text:day.slice(0,3),attrs:{title:day}}),el("span",{text:training?"Train":"Rest"})]);
      }));
      const days=el("ol",{className:"ai-week-days"},week.days.map(day=>el("li",{className:"ai-day"},[
        el("div",{className:"ai-day-head"},[el("strong",{text:day.day}),el("span",{text:day.name}),el("small",{text:`${day.workingSets} sets · ~${day.minutes} min`})]),
        el("ul",{className:"ai-exercises"},day.exercises.map(item=>el("li",{},[el("span",{text:item.name}),el("span",{className:"ai-sets",text:`${item.sets} × ${item.reps}`})])))
      ])));
      return el("section",{className:"ai-card ai-week",attrs:{"aria-label":`Proposed week: ${week.title}`}},[
        kicker(`Proposed week · ${logic.focusLabel(week.focus)}`),el("h3",{text:week.title}),el("p",{className:"ai-card-meta",text:logic.weekStats(week)}),
        strip,days,...(week.notes||[]).map(note=>el("p",{className:"ai-note",text:note})),
        done?applied("Saved as your weekly plan.","/planner.html","Open Plan"):el("div",{className:"ai-actions"},[
          button(busy?"Saving…":"Apply to my plan","apply-week",id,{primary:true}),
          button("Ask for changes","refine",id)
        ])
      ]);
    }

    function nutritionCard(message){
      const nutrition=message.result.nutrition,id=message.id;
      if(nutrition.needsSetup)return el("section",{className:"ai-card ai-nutrition",attrs:{"aria-label":"Nutrition targets"}},[
        kicker("Nutrition targets"),el("p",{text:nutrition.message||"Calorie targets come from your personal setup."}),
        el("ul",{className:"ai-chips"},logic.nutritionLines(nutrition.changes).map(text=>el("li",{text}))),
        el("div",{className:"ai-actions"},[el("a",{className:"ai-button ai-button-primary",text:"Complete personal setup",attrs:{href:"/discover.html#nutritionWorkspace"}})])
      ]);
      const summary=energy?.targetSummary?.(nutrition.preview)||{label:"",math:""},done=message.applied?.nutrition,busy=current.applying===`${id}:nutrition`;
      const weekPending=nutrition.basedOn==="proposed"&&message.result.week&&!message.applied?.week;
      return el("section",{className:"ai-card ai-nutrition",attrs:{"aria-label":"Proposed nutrition targets"}},[
        kicker("Nutrition targets · calculated by STRATA"),el("h3",{text:summary.label}),summary.math?el("p",{className:"ai-math",text:summary.math}):null,
        el("ul",{className:"ai-chips"},logic.nutritionLines(nutrition.changes).map(text=>el("li",{text}))),
        el("ol",{className:"ai-targets",attrs:{"aria-label":"Daily calorie targets"}},logic.dailyTargets(nutrition.preview).map(item=>el("li",{className:item.training?"is-training":""},[el("abbr",{text:item.day}),el("strong",{text:item.calories}),item.protein?el("small",{text:item.protein}):null]))),
        logic.alignmentText(nutrition)?el("p",{className:"ai-note",text:logic.alignmentText(nutrition)}):null,
        weekPending&&!done?el("p",{className:"ai-note",text:"These targets assume you also apply the week above."}):null,
        done?applied("Saved to your nutrition targets.","/discover.html#nutritionWorkspace","Open Nutrition"):el("div",{className:"ai-actions"},[
          button(busy?"Saving…":"Apply nutrition targets","apply-nutrition",id,{primary:true})
        ])
      ]);
    }

    function suggestionsCard(message){
      const id=message.id;
      return el("section",{className:"ai-card ai-suggestions",attrs:{"aria-label":"Suggestions"}},[kicker("Suggestions"),el("ol",{},message.result.suggestions.map(item=>{
        const action=item.action,done=message.applied?.swaps?.[item.id],busy=current.applying===`${id}:${item.id}`;
        return el("li",{},[el("p",{text:item.text}),action?el("div",{className:"ai-swap"},[
          el("span",{text:`${action.day}: ${action.fromName} → ${action.toName}`}),
          done?el("span",{className:"ai-applied",text:"Swapped in your plan"}):button(busy?"Saving…":"Apply swap","apply-swap",id,{extra:{"data-suggestion":item.id}})
        ]):null]);
      }))]);
    }

    function messageNode(message,latest){
      if(message.role==="user")return el("li",{className:"ai-turn ai-turn-user"},[el("p",{text:message.text})]);
      if(message.role==="error")return el("li",{className:"ai-turn ai-turn-error"},[el("p",{text:message.error?.message||"Strata AI could not answer."}),message.error?.retry&&message.retry?button("Try again","retry",message.id):null]);
      const result=message.result||{};
      return el("li",{className:"ai-turn ai-turn-assistant"},[
        el("span",{className:"ai-avatar",text:"AI",attrs:{"aria-hidden":"true"}}),
        el("div",{className:"ai-body"},[
          el("p",{className:"ai-sender",text:"Strata AI"}),el("p",{className:"ai-reply",text:result.reply}),
          result.searched?.length?el("p",{className:"ai-note",text:`Searched STRATA’s 320 exercises for: ${result.searched.join(", ")}.`}):null,
          result.week?weekCard(message):null,
          result.weekIssue?el("p",{className:"ai-note ai-note-warn",text:result.weekIssue}):null,
          result.nutrition?nutritionCard(message):null,
          result.suggestions?.length?suggestionsCard(message):null,
          message.notice?el("p",{className:"ai-note ai-note-warn",text:message.notice}):null,
          ...(()=>{const replies=logic.followUps(message,{latest});return replies.length?[el("ul",{className:"ai-followups",attrs:{"aria-label":"Quick replies"}},replies.map(item=>el("li",{},[el("button",{className:"ai-starter ai-followup",text:item.label,attrs:{type:"button","data-followup":item.index}})])))]:[];})()
        ])
      ]);
    }

    const rendered=new Map();
    /** Updates only the messages that changed, so screen readers and scroll position are not disturbed. */
    function renderConversation(state){
      current=state;
      const list=nodes.conversation,seen=new Set(),latestId=state.messages.at(-1)?.id;
      state.messages.forEach((message,index)=>{
        const latest=message.id===latestId;
        const signature=JSON.stringify([message.applied||null,message.notice||"",latest,state.applying.startsWith(`${message.id}:`)?state.applying:""]);
        seen.add(message.id);
        let entry=rendered.get(message.id);
        if(!entry||entry.signature!==signature){
          const node=messageNode(message,latest);node.dataset.id=message.id;
          if(entry)entry.node.replaceWith(node);
          entry={node,signature};rendered.set(message.id,entry);
        }
        if(list.children[index]!==entry.node)list.insertBefore(entry.node,list.children[index]||null);
      });
      for(const [id,entry] of rendered)if(!seen.has(id)){entry.node.remove();rendered.delete(id);}
      for(const control of list.querySelectorAll("button[data-action^='apply']"))control.disabled=Boolean(state.applying);
      for(const control of list.querySelectorAll("button[data-followup],button[data-action='retry']"))control.disabled=Boolean(state.pending||state.busy);
      let pending=list.querySelector(".ai-turn-pending");
      if(state.pending){
        if(!pending)pending=el("li",{className:"ai-turn ai-turn-pending",attrs:{"aria-busy":"true"}},[el("span",{className:"ai-avatar",text:"AI",attrs:{"aria-hidden":"true"}}),el("div",{className:"ai-thinking"},[el("span",{className:"ai-dots",attrs:{"aria-hidden":"true"}},[el("i"),el("i"),el("i")]),el("p",{})])]);
        pending.querySelector("p").textContent=logic.pendingText(state.pending.request,Date.now()-state.pending.startedAt);
        list.append(pending);
      }else pending?.remove();
      nodes.empty.hidden=state.messages.length>0||Boolean(state.pending);
      nodes.reset.hidden=state.messages.length===0;
    }

    function renderStatus(state){
      const view=logic.statusView(state.status);
      nodes.status.dataset.tone=view.tone;nodes.statusTitle.textContent=view.title;nodes.statusDetail.textContent=view.detail;
      return view;
    }
    function renderComposer(state){
      const view=logic.statusView(state.status),blocked=!view.canAsk||Boolean(state.pending)||state.busy;
      nodes.send.disabled=blocked;nodes.suggest.disabled=blocked;
      (nodes.sendLabel||nodes.send).textContent=state.pending?"Working…":"Ask Strata AI";
      const length=nodes.message.value.length;
      nodes.count.textContent=`${length.toLocaleString("en-US")} / ${logic.LIMITS.messageChars.toLocaleString("en-US")}`;
      nodes.count.dataset.over=String(length>logic.LIMITS.messageChars);
      for(const starter of nodes.starters)starter.disabled=blocked;
    }
    const motion=()=>globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth";
    /** Brings a new answer into view from its first line, so long proposals read from the top. */
    function reveal(id){
      const node=rendered.get(id)?.node;
      if(node&&scroller)scroller.scrollTo?.({top:Math.max(0,node.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop-12),behavior:motion()});
      else node?.scrollIntoView?.({block:"start",behavior:motion()});
    }
    /** In a panel, follows the conversation to its newest line after the member sends something. */
    function revealEnd(){scroller?.scrollTo?.({top:scroller.scrollHeight,behavior:motion()});}
    function setFormError(text){nodes.formError.textContent=text||"";nodes.formError.hidden=!text;}
    function announce(text){nodes.announce.textContent="";if(text)setTimeout(()=>{nodes.announce.textContent=text;},60);}
    function renderStarters(){
      nodes.starterList.replaceChildren(...logic.STARTERS.map((starter,index)=>el("li",{},[el("button",{className:"ai-starter",text:starter.label,attrs:{type:"button","data-starter":index}})])));
      nodes.starters=[...nodes.starterList.querySelectorAll("button")];
    }

    return Object.freeze({announce,renderComposer,renderConversation,renderStarters,renderStatus,reveal,revealEnd,setFormError});
  }

  return Object.freeze({createRenderer});
});
