// @ts-check
"use strict";

// Polar AccessLink v3 client. It only talks to the configured Polar addresses, sends each member's own token,
// stays under the rate limits Polar reports in every response, and never holds a request open for long.

const {createHmac}=require("node:crypto");
const {sameSecret}=require("./devices-crypto");

/** @param {string} code @param {string} message @param {number} [status] @param {Record<string,unknown>} [extra] */
function polarError(code,message,status=502,extra={}){return Object.assign(new Error(message),{code,status,...extra});}
/** Releases the connection of a response STRATA will not read. @param {Response} response */
function discard(response){void response.body?.cancel().catch(()=>{});}
/** One number of a header such as "RateLimit-Usage: 50, 700", or null when it is missing. @param {string|null} value @param {number} index */
function headerNumber(value,index){const part=String(value??"").split(",")[index]?.trim(),number=Number(part);return part&&Number.isFinite(number)?number:null;}

/**
 * @param {{settings:{polar:{clientId:string,clientSecret:string,authorizeUrl:string,tokenUrl:string,apiBase:string}},
 *   fetchImpl?:typeof fetch,now?:()=>number,timeoutMs?:number,headroom?:number}} options
 */
function createPolarClient({settings,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=15000,headroom=0.8}){
  const polar=settings.polar;
  let blockedUntil=0;

  /** Stops before a window is used up: at 80% of either Polar window, wait for that window to reset. @param {Response} response */
  function observeLimits(response){
    for(const index of [0,1]){
      const usage=headerNumber(response.headers.get("ratelimit-usage"),index),limit=headerNumber(response.headers.get("ratelimit-limit"),index),reset=headerNumber(response.headers.get("ratelimit-reset"),index);
      if(usage!==null&&limit&&reset!==null&&usage>=limit*headroom)blockedUntil=Math.max(blockedUntil,now()+reset*1000);
    }
    if(response.status===429){
      const wait=headerNumber(response.headers.get("retry-after"),0)??headerNumber(response.headers.get("ratelimit-reset"),0)??60;
      blockedUntil=Math.max(blockedUntil,now()+Math.max(1,wait)*1000);
    }
  }
  /** @param {string} url @param {RequestInit} init */
  async function send(url,init){
    if(now()<blockedUntil)throw polarError("POLAR_RATE_LIMIT","Polar asked STRATA to slow down. Syncing continues shortly.",503,{retryAt:blockedUntil});
    let response;
    try{response=await fetchImpl(url,{...init,signal:AbortSignal.timeout(timeoutMs)});}
    catch(error){
      const timedOut=/** @type {Error} */(error)?.name==="TimeoutError";
      throw polarError(timedOut?"POLAR_TIMEOUT":"POLAR_UNAVAILABLE",timedOut?"Polar took too long to answer.":"Polar could not be reached.",503);
    }
    observeLimits(response);
    return response;
  }
  /** @param {Response} response */
  function assertOk(response){
    if(response.ok)return;
    discard(response);
    if(response.status===401||response.status===403)throw polarError("POLAR_AUTH","Polar no longer accepts this connection. Reconnect Polar.",401);
    if(response.status===429)throw polarError("POLAR_RATE_LIMIT","Polar asked STRATA to slow down. Syncing continues shortly.",503,{retryAt:blockedUntil});
    if(response.status>=500)throw polarError("POLAR_UNAVAILABLE","Polar is unavailable right now.",503);
    throw polarError("POLAR_BAD_RESPONSE",`Polar answered with status ${response.status}.`,502);
  }
  /** @param {Response} response */
  async function readJson(response){
    try{return await response.json();}
    catch{throw polarError("POLAR_BAD_RESPONSE","Polar sent a response STRATA could not read.",502);}
  }
  const clientAuthorization=()=>`Basic ${Buffer.from(`${polar.clientId}:${polar.clientSecret}`).toString("base64")}`;
  /** @param {string} token @param {string} path @param {RequestInit} [init] */
  function member(token,path,init={}){
    return send(`${polar.apiBase}${path}`,{...init,headers:{Authorization:`Bearer ${token}`,Accept:"application/json",...(init.body?{"Content-Type":"application/json"}:{})}});
  }
  /** A member read that treats "nothing here" (204 or 404) as no data. @param {string} token @param {string} path */
  async function memberRead(token,path){
    const response=await member(token,path);
    if(response.status===204||response.status===404){discard(response);return null;}
    assertOk(response);return readJson(response);
  }

  return {
    /** @param {{state:string,redirectUri:string}} options */
    authorizeUrl({state,redirectUri}){
      const url=new URL(polar.authorizeUrl);
      url.search=new URLSearchParams({response_type:"code",client_id:polar.clientId,redirect_uri:redirectUri,scope:"accesslink.read_all",state}).toString();
      return url.toString();
    },
    /** @param {string} code @param {string} redirectUri */
    async exchangeCode(code,redirectUri){
      const response=await send(polar.tokenUrl,{method:"POST",headers:{Authorization:clientAuthorization(),"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json;charset=UTF-8"},
        body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri}).toString()});
      if(response.status===400||response.status===401){discard(response);throw polarError("POLAR_CODE_REJECTED","Polar did not accept this sign-in. Start connecting again.",400);}
      assertOk(response);
      const body=await readJson(response),accessToken=String(body?.access_token??""),providerUserId=String(body?.x_user_id??""),expiresIn=Number(body?.expires_in);
      if(!accessToken||accessToken.length>4096||!/^\d{1,20}$/.test(providerUserId))throw polarError("POLAR_BAD_RESPONSE","Polar sent an incomplete sign-in response.",502);
      return {accessToken,providerUserId,expiresAt:Number.isFinite(expiresIn)&&expiresIn>0?now()+expiresIn*1000:null};
    },
    /** Links the member to this app; Polar answers 409 when this Polar account is already linked. @param {string} token @param {string} memberRef */
    async registerUser(token,memberRef){
      const response=await member(token,"/v3/users",{method:"POST",body:JSON.stringify({"member-id":memberRef})});
      if(response.status===409){discard(response);return {registered:false};}
      assertOk(response);discard(response);return {registered:true};
    },
    /** Unlinks the member. A token Polar no longer accepts means access is already gone. @param {string} token @param {string} providerUserId */
    async deregisterUser(token,providerUserId){
      const response=await member(token,`/v3/users/${encodeURIComponent(providerUserId)}`,{method:"DELETE"});
      if([200,204,401,403,404].includes(response.status)){discard(response);return {removed:true};}
      assertOk(response);discard(response);return {removed:true};
    },
    /** @param {string} token */
    sleep:(token)=>memberRead(token,"/v3/users/sleep"),
    /** @param {string} token */
    nightlyRecharge:(token)=>memberRead(token,"/v3/users/nightly-recharge"),
    /** @param {string} token @param {string} date */
    heartRate:(token,date)=>memberRead(token,`/v3/users/continuous-heart-rate/${encodeURIComponent(date)}`),
    /** @param {string} token */
    exercises:(token)=>memberRead(token,"/v3/exercises"),
    /** App-level webhook management for scripts/polar-webhook.js. @param {"GET"|"POST"|"DELETE"} method @param {string} path @param {unknown} [body] */
    async webhook(method,path,body){
      const response=await send(`${polar.apiBase}/v3/webhooks${path}`,{method,headers:{Authorization:clientAuthorization(),Accept:"application/json",...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(response.status===204||response.status===404){discard(response);return null;}
      assertOk(response);return readJson(response);
    },
    blockedUntil:()=>blockedUntil
  };
}

/**
 * Checks Polar-Webhook-Signature: an HMAC-SHA256 of the raw body keyed with the webhook's signature_secret_key.
 * Polar documents the hex form; the base64 form is also accepted so an encoding difference cannot drop real events.
 * @param {Buffer} rawBody @param {unknown} header @param {string} secret
 */
function validWebhookSignature(rawBody,header,secret){
  const signature=String(header??"").trim().replace(/^sha256=/i,"");
  if(!secret||!signature||signature.length>200)return false;
  const digest=createHmac("sha256",secret).update(rawBody).digest();
  return sameSecret(signature.toLowerCase(),digest.toString("hex"))||sameSecret(signature,digest.toString("base64"));
}

module.exports={createPolarClient,polarError,validWebhookSignature};
