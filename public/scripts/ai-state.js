/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAiState=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  // The conversation lives only in this browser tab (sessionStorage), keyed by account, so another
  // member signing in on the same device never sees it and closing the tab forgets it.
  const PREFIX="strata-ai-conversation:";

  function createState(){
    return {user:null,csrfToken:"",status:null,messages:[],pending:null,busy:false,applying:"",loadError:""};
  }
  const key=userId=>`${PREFIX}${String(userId||"")}`;
  function load(storage,userId){
    try{const raw=storage?.getItem?.(key(userId));return raw?JSON.parse(raw):null;}catch{return null;}
  }
  function save(storage,userId,conversation){
    try{storage?.setItem?.(key(userId),JSON.stringify(conversation));return true;}catch{return false;}
  }
  function clear(storage,userId){
    try{storage?.removeItem?.(key(userId));}catch{/* Nothing to forget when storage is unavailable. */}
  }
  /** Forgets every stored conversation, for sign-out. */
  function clearAll(storage){
    try{
      const keys=[];for(let index=0;index<(storage?.length||0);index+=1){const name=storage.key(index);if(name?.startsWith(PREFIX))keys.push(name);}
      keys.forEach(name=>storage.removeItem(name));
    }catch{/* Nothing to forget when storage is unavailable. */}
  }

  return Object.freeze({createState,load,save,clear,clearAll});
});
