/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataEntitlements=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  // The server decides tiers and sends the answer as user.capabilities inside
  // /api/me. Pages ask can(user,"feature") instead of reading billing state.
  const FREE_FEATURES=Object.freeze(["rankings","plan.week","profile.basic","account"]);
  const PLUS_FEATURES=Object.freeze(["plus.studio","plus.train","plus.nutrition","plus.recovery","plus.progress","plus.library","plus.compare","plus.ai"]);

  function can(user,feature){
    const capabilities=user?.capabilities;
    if(capabilities&&typeof capabilities==="object")return capabilities[feature]===true;
    // A payload cached by an older build has no capability map; fall back to
    // the Strata+ flag the server has always sent.
    if(FREE_FEATURES.includes(feature))return true;
    return PLUS_FEATURES.includes(feature)&&user?.discovery?.active===true;
  }

  function hasPlus(user){return can(user,"plus.studio");}

  return Object.freeze({FREE_FEATURES,PLUS_FEATURES,can,hasPlus});
});
