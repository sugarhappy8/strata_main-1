/* global module */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  root.StrataAccountApi=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(){
  "use strict";

  function createClient({fetchImpl,getCsrfToken=()=>""}){
    if(typeof fetchImpl!=="function")throw new TypeError("A fetch implementation is required.");

    async function requestJson(path,options={}){
      let response;
      try{
        response=await fetchImpl(path,{...options,credentials:"same-origin",headers:{Accept:"application/json",...(options.headers||{})}});
      }catch(cause){
        throw Object.assign(new Error("Could not reach STRATA. Check your connection and try again."),{code:"network",cause});
      }
      const contentType=String(response.headers?.get?.("content-type")||"").toLowerCase();
      const data=contentType.includes("json")?await response.json().catch(()=>null):null;
      if(!response.ok)throw Object.assign(new Error(data?.error||"Request failed."),{
        status:response.status,code:data?.code,verificationRequired:data?.verificationRequired===true,maskedEmail:data?.maskedEmail,
        purpose:data?.purpose==="login"?"login":"signup",deliveryState:["sent","failed","pending"].includes(data?.deliveryState)?data.deliveryState:""
      });
      if(!data||typeof data!=="object")throw Object.assign(new Error("The account service returned an unexpected response."),{code:"invalid-response",status:502});
      return data;
    }

    function mutation(path,body={}){
      return requestJson(path,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":getCsrfToken()},body:JSON.stringify(body)});
    }

    async function exportAccount(){
      let response;
      try{
        response=await fetchImpl("/api/account/export",{method:"POST",credentials:"same-origin",headers:{Accept:"application/json","Content-Type":"application/json","X-CSRF-Token":getCsrfToken()},body:"{}"});
      }catch(cause){
        throw Object.assign(new Error("Could not reach STRATA. Check your connection and try again."),{code:"network",cause});
      }
      if(!response.ok){
        const data=String(response.headers?.get?.("content-type")||"").includes("json")?await response.json().catch(()=>null):null;
        throw Object.assign(new Error(data?.error||"The export request failed."),{status:response.status,code:data?.code});
      }
      if(response.headers?.get?.("x-strata-export")!=="account-v1")throw Object.assign(new Error("The export response was incomplete."),{code:"invalid-response"});
      return{blob:await response.blob(),contentDisposition:String(response.headers?.get?.("content-disposition")||"")};
    }

    return{
      status:()=>requestJson("/api/status"),
      health:()=>requestJson("/healthz"),
      identity:(options={})=>requestJson("/api/me",options),
      plan:()=>requestJson("/api/plan",{cache:"no-store"}),
      workouts:()=>requestJson("/api/workouts?limit=100&offset=0",{cache:"no-store"}),
      sessions:()=>requestJson("/api/account/sessions",{cache:"no-store"}),
      authenticate:(mode,payload)=>requestJson(`/api/${mode}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}),
      logout:()=>requestJson("/api/logout",{method:"POST"}),
      revokeSession:(sessionId)=>mutation("/api/account/sessions/revoke",{sessionId}),
      revokeOtherSessions:()=>mutation("/api/account/sessions/revoke-others"),
      billingPortal:()=>mutation("/api/billing/portal"),
      requestPasswordReset:()=>mutation("/api/account/password-reset/request"),
      requestDeletion:()=>mutation("/api/account/delete/request"),
      cancelDeletion:()=>mutation("/api/account/delete/cancel"),
      exportAccount,
      devices:()=>requestJson("/api/devices",{cache:"no-store"}),
      deviceRequest:(path,method="POST",body={})=>requestJson(path,{method,headers:{"Content-Type":"application/json","X-CSRF-Token":getCsrfToken()},body:JSON.stringify(body)})
    };
  }

  return{createClient};
});
