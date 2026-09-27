/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAiEvents=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  const APPLY={"apply-week":"applyWeek","apply-nutrition":"applyNutrition","apply-swap":"applySwap"};

  function bind({windowImpl=globalThis.window,documentImpl=globalThis.document,nodes,actions}){
    nodes.form.addEventListener("submit",event=>{event.preventDefault();void actions.send();});
    nodes.message.addEventListener("input",actions.inputChanged);
    // Enter sends and Shift+Enter starts a new line, as in most chat tools; IME composition is left alone.
    nodes.message.addEventListener("keydown",event=>{
      if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing&&!event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();void actions.send();}
    });
    nodes.suggest.addEventListener("click",()=>{void actions.suggest();});
    nodes.reset.addEventListener("click",actions.reset);
    nodes.starterList.addEventListener("click",event=>{
      const starter=event.target.closest?.("button[data-starter]");
      if(starter&&!starter.disabled)void actions.starter(Number(starter.dataset.starter));
    });
    nodes.conversation.addEventListener("click",event=>{
      const control=event.target.closest?.("button[data-action]");
      if(!control||control.disabled)return;
      const action=control.dataset.action,id=control.dataset.id;
      if(APPLY[action])void actions[APPLY[action]](id,control.dataset.suggestion);
      else if(action==="refine")actions.refine(id);
      else if(action==="retry")void actions.retry(id);
    });
    nodes.logout?.addEventListener("click",()=>{void actions.logout();});
    const refresh=()=>{if(!documentImpl?.visibilityState||documentImpl.visibilityState==="visible")void actions.refreshStatus();};
    documentImpl?.addEventListener?.("visibilitychange",refresh);
    windowImpl?.addEventListener?.("online",refresh);
    windowImpl?.addEventListener?.("pageshow",event=>{if(event.persisted)void actions.reload();});
  }

  return Object.freeze({bind});
});
