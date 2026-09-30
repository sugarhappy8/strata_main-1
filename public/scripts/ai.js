"use strict";

(() => {
  const logic=globalThis.StrataAiLogic,store=globalThis.StrataAiState,state=store.createState();
  const el=id=>document.getElementById(id);
  const nodes={
    conversation:el("aiConversation"),empty:el("aiEmpty"),starterList:el("aiStarters"),starters:[],form:el("aiForm"),message:el("aiMessage"),count:el("aiCount"),
    send:el("aiSend"),suggest:el("aiSuggest"),reset:el("aiReset"),formError:el("aiFormError"),announce:el("aiAnnounce"),status:el("aiStatus"),
    statusTitle:el("aiStatusTitle"),statusDetail:el("aiStatusDetail"),userName:el("userName"),logout:el("logoutButton"),
    confirm:el("aiConfirm"),confirmText:el("aiConfirmText")
  };
  const client=globalThis.StrataAiApi.createClient({getCsrfToken:()=>state.csrfToken,getUserId:()=>state.user?.id});
  const view=globalThis.StrataAiRender.createRenderer({nodes,logic,energy:globalThis.StrataPersonalTrainingEnergyUi});
  const storage=(()=>{try{return globalThis.sessionStorage;}catch{return null;}})();
  let generation=0,pollTimer=0;

  function render(){view.renderConversation(state);view.renderStatus(state);view.renderComposer(state);}
  function persist(){if(state.user)store.save(storage,state.user.id,{messages:state.messages.slice(-logic.LIMITS.storedMessages),pending:state.pending&&{id:state.pending.id,kind:state.pending.kind,startedAt:state.pending.startedAt,retry:state.pending.retry}});}
  const findMessage=id=>state.messages.find(message=>message.id===id&&message.role==="assistant");

  /** Signed-out, lapsed, or switched accounts leave the page instead of showing someone else's work. */
  function handleAccessError(error){
    if(error?.status===401){location.assign("/account.html?mode=login&next=ai");return true;}
    if(error?.status===402||error?.code==="DISCOVERY_ACCESS_REQUIRED"){location.assign("/pricing?reason=ai");return true;}
    if(["AI_ACCOUNT_CHANGED","ACCOUNT_CHANGED","COACHING_ACCOUNT_CHANGED"].includes(error?.code)){location.reload();return true;}
    return false;
  }

  async function refreshStatus(){
    try{const status=await client.status();state.status=status;if(status.csrfToken)state.csrfToken=status.csrfToken;}
    catch(error){if(handleAccessError(error))return;if(!state.status)state.status={configured:true,online:false,dailyLimit:0,remainingToday:1};}
    render();
  }

  function finish(entry){
    state.pending=null;state.messages.push(entry);persist();render();view.reveal(entry.id);
    if(entry.role==="assistant")view.announce(`Strata AI answered. ${entry.result.reply}`);
    else view.announce(entry.error.message);
    void refreshStatus();
  }
  function failure(error,retry){return {id:logic.newId(),role:"error",error:logic.errorView(error),retry};}

  async function poll(expected){
    if(expected!==generation||!state.pending)return;
    const pending=state.pending;
    try{
      const {request}=await client.poll(pending.id);
      if(expected!==generation)return;
      pending.failures=0;pending.request=request;
      if(request.status==="done")return finish({id:logic.newId(),role:"assistant",kind:pending.kind,result:request.result,applied:{}});
      if(request.status==="failed")return finish(failure(request.error,pending.retry));
    }catch(error){
      if(expected!==generation||handleAccessError(error))return;
      pending.failures=(pending.failures||0)+1;
      if(error?.status===404||pending.failures>=4)return finish(failure(error?.status===404?{code:"AI_REQUEST_NOT_FOUND",message:"That request expired before Strata AI answered. Ask again."}:error,pending.retry));
    }
    view.renderConversation(state);
    pollTimer=setTimeout(()=>{void poll(expected);},logic.pollDelay(Date.now()-pending.startedAt)*(pending.failures?2:1));
  }

  async function ask(kind,message,{addUserMessage=true}={}){
    if(state.pending||state.busy)return;
    const history=logic.historyFor(state.messages),draft=kind==="chat"?logic.draftPlanFor(state.messages):null;
    if(addUserMessage){state.messages.push({id:logic.newId(),role:"user",kind,text:kind==="suggestions"?logic.SUGGESTION_PROMPT:message});if(kind==="chat")nodes.message.value="";}
    state.busy=true;view.setFormError("");render();
    const retry={kind,message};
    try{
      const {request}=await client.ask({kind,message,history,draftPlan:draft?.plan,draftPlanUpdatedAt:draft?.planUpdatedAt});
      state.pending={id:request.id,kind,startedAt:Date.now(),request,retry};
      persist();
      const expected=++generation;clearTimeout(pollTimer);pollTimer=setTimeout(()=>{void poll(expected);},logic.pollDelay(0));
    }catch(error){
      if(!handleAccessError(error)){state.messages.push(failure(error,retry));persist();view.announce(error.message);void refreshStatus();}
    }finally{state.busy=false;render();}
  }

  async function send(){
    const text=nodes.message.value.trim(),problem=logic.messageError(text);
    if(problem){view.setFormError(problem);nodes.message.focus();return;}
    await ask("chat",text);
  }

  function confirmReplace(count){
    const text=`Your current plan has ${count} exercise${count===1?"":"s"}. Applying this week replaces it. You can still edit every day afterwards in Plan.`;
    if(typeof nodes.confirm?.showModal!=="function")return Promise.resolve(window.confirm(text));
    nodes.confirmText.textContent=text;nodes.confirm.returnValue="";
    return new Promise(resolve=>{nodes.confirm.addEventListener("close",()=>resolve(nodes.confirm.returnValue==="replace"),{once:true});nodes.confirm.showModal();});
  }

  /** Runs one apply action with a busy marker, reporting failures on the message they belong to. */
  async function applying(message,key,work){
    if(!message||state.applying)return;
    state.applying=`${message.id}:${key}`;message.notice="";render();
    try{const done=await work();if(done){message.applied={...message.applied,...done.applied};view.announce(done.announce);}}
    catch(error){if(!handleAccessError(error))message.notice=error?.code==="PLAN_CHANGED"?"Your plan changed in another tab or device. Try again to apply it to the latest copy.":error?.code==="COACHING_PROFILE_CHANGED"?"Your personal setup changed after Strata AI calculated these targets. Ask again for fresh ones.":error?.message||"That change was not saved. Try again.";}
    finally{state.applying="";persist();render();if(message.notice)view.announce(message.notice);}
  }
  const samePlanOwner=data=>{if(data?.user?.id&&String(data.user.id)!==String(state.user?.id)){location.reload();return false;}return true;};

  const actions={
    send,
    suggest:()=>ask("suggestions",""),
    starter:index=>{const starter=logic.STARTERS[index];if(!starter)return;nodes.message.value=starter.message;return send();},
    followUp:index=>{const reply=logic.FOLLOW_UPS[index];if(!reply)return;nodes.message.value=reply.message;return send();},
    inputChanged:()=>{view.setFormError("");view.renderComposer(state);},
    refine:()=>{nodes.message.placeholder="What should change? For example: a shorter Friday.";nodes.message.focus();},
    retry:id=>{
      const index=state.messages.findIndex(message=>message.id===id&&message.role==="error");
      const entry=state.messages[index];if(!entry?.retry||state.pending||state.busy)return;
      state.messages.splice(index,1);persist();return ask(entry.retry.kind,entry.retry.message,{addUserMessage:false});
    },
    applyWeek:id=>{const message=findMessage(id);return applying(message,"week",async()=>{
      const current=await client.plan();if(!samePlanOwner(current))return null;
      if(!logic.planRevisionMatches(message,current))throw Object.assign(new Error("Your plan changed after this week was created. Ask Strata AI to update the latest plan."),{code:"PLAN_CHANGED"});
      const count=logic.planExerciseCount(current.plan);
      if(count>0&&!await confirmReplace(count))return null;
      await client.savePlan({plan:message.result.week.plan,expectedPlanUpdatedAt:message.result.planUpdatedAt});
      return {applied:{week:true},announce:"Saved as your weekly plan."};
    });},
    applyNutrition:id=>{const message=findMessage(id);return applying(message,"nutrition",async()=>{
      const nutrition=message.result.nutrition;
      await client.saveProfile({profile:nutrition.profile,expectedRevision:nutrition.expectedRevision});
      return {applied:{nutrition:true},announce:"Saved to your nutrition targets."};
    });},
    applySwap:(id,suggestionId)=>{const message=findMessage(id),suggestion=message?.result?.suggestions?.find(item=>item.id===suggestionId);if(!suggestion?.action)return;return applying(message,suggestionId,async()=>{
      const current=await client.plan();if(!samePlanOwner(current))return null;
      const plan=logic.swapPlan(current.plan,suggestion.action);
      if(!plan)throw new Error("Your plan changed, so this swap no longer fits. Ask for fresh suggestions.");
      await client.savePlan({plan,expectedPlanUpdatedAt:current.planUpdatedAt});
      return {applied:{swaps:{...message.applied?.swaps,[suggestionId]:true}},announce:`Swapped ${suggestion.action.fromName} for ${suggestion.action.toName}.`};
    });},
    reset:()=>{if(state.pending||state.applying)return;state.messages=[];store.clear(storage,state.user?.id);view.setFormError("");render();nodes.message.focus();},
    logout:async()=>{
      generation+=1;clearTimeout(pollTimer);store.clearAll(storage);
      try{await client.logout();}catch{/* The account page confirms the signed-out state either way. */}
      location.assign("/account.html?mode=login");
    },
    refreshStatus,
    reload:()=>location.reload()
  };

  async function start(){
    view.renderStarters();render();
    try{
      const data=await client.me();
      state.user=data.user;state.csrfToken=String(data.csrfToken||"");
      nodes.userName.textContent=data.user?.name||"Member";
    }catch(error){
      if(handleAccessError(error))return;
      nodes.statusTitle.textContent="STRATA couldn’t load your account";nodes.statusDetail.textContent="Check your connection, then refresh this page.";nodes.status.dataset.tone="offline";return;
    }
    store.clearAll(storage,{except:state.user.id});
    const saved=logic.restoreConversation(store.load(storage,state.user.id));
    state.messages=saved.messages;
    if(saved.pending)state.pending={...saved.pending,request:{status:"running",position:0}};
    globalThis.StrataAiEvents.bind({nodes,actions});
    render();
    if(state.pending){const expected=++generation;void poll(expected);}
    await refreshStatus();
  }

  void start();
})();
