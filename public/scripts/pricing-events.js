/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataPricingEvents=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function bind({windowImpl=globalThis.window,documentImpl=globalThis.document,buyButton,checkButton,actions}){
    const recheckAccount=()=>{if(!documentImpl.visibilityState||documentImpl.visibilityState==="visible")void actions.recheckAccount();};
    buyButton.addEventListener("click",()=>{void actions.openCheckout();});
    checkButton.addEventListener("click",()=>{void actions.refreshAccess({focus:true});});
    windowImpl?.addEventListener?.("online",actions.renderPurchaseState);
    windowImpl?.addEventListener?.("offline",actions.renderPurchaseState);
    documentImpl?.addEventListener?.("visibilitychange",recheckAccount);
    windowImpl?.addEventListener?.("focus",recheckAccount);
    windowImpl?.addEventListener?.("pageshow",event=>{if(event.persisted)recheckAccount();});
  }

  return{bind};
});
