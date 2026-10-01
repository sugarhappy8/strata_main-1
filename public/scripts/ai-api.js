/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAiApi=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  /**
   * Same-origin JSON requests. State-changing requests carry the CSRF token and the expected account,
   * so a request started before a different member signed in is refused by the server.
   */
  function createClient({fetchImpl=globalThis.fetch,getCsrfToken=()=>"",getUserId=()=>""}={}){
    if(typeof fetchImpl!=="function")throw new TypeError("A fetch implementation is required.");
    async function request(path,{method="GET",body}={}){
      const changes=method!=="GET",userId=String(getUserId()||"");
      let response;
      try{
        response=await fetchImpl(path,{method,credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json",...(body?{"Content-Type":"application/json"}:{}),...(changes?{"X-CSRF-Token":getCsrfToken(),...(userId?{"X-Strata-User":userId}:{})}:{})},...(body?{body:JSON.stringify(body)}:{})});
      }catch(cause){
        throw Object.assign(new Error("Could not reach STRATA. Check your connection, then try again."),{code:"NETWORK_ERROR",cause});
      }
      const data=await response.json().catch(()=>null);
      if(!response.ok)throw Object.assign(new Error(data?.error||"The request could not be completed."),{status:response.status,code:data?.code||"REQUEST_FAILED",payload:data||{}});
      if(!data||typeof data!=="object")throw Object.assign(new Error("STRATA sent an unexpected response. Try again."),{code:"INVALID_RESPONSE"});
      return data;
    }
    return Object.freeze({
      me:()=>request("/api/me"),
      status:()=>request("/api/ai/status"),
      ask:({kind,message,history,draftPlan=null,draftPlanUpdatedAt=null})=>request("/api/ai/requests",{method:"POST",body:{kind,...(kind==="chat"?{message,...(draftPlan?{draftPlan,draftPlanUpdatedAt}:{})}:{}),history,expectedUserId:String(getUserId()||"")}}),
      poll:id=>request(`/api/ai/requests/${encodeURIComponent(id)}`),
      plan:()=>request("/api/plan"),
      // Weeks saved from the chat are tagged so the plan history shows an accepted Strata AI proposal.
      savePlan:({plan,expectedPlanUpdatedAt})=>request("/api/plan",{method:"PUT",body:{plan,expectedPlanUpdatedAt,expectedUserId:String(getUserId()||""),source:"ai"}}),
      saveProfile:({profile,expectedRevision})=>request("/api/coaching/profile",{method:"PUT",body:{profile,expectedRevision,expectedUserId:String(getUserId()||"")}}),
      logout:()=>request("/api/logout",{method:"POST"})
    });
  }

  return Object.freeze({createClient});
});
