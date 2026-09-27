// @ts-check
"use strict";

// OpenAI-compatible chat client for Strata AI. It only talks to the configured base URL, always
// sends the configured key, and never lets a slow model hold a request open indefinitely.

const {aiResponseFormat}=require("./ai-response-schema");
const REASONING=/<think>[\s\S]*?<\/think>/gi;
// Gateway timeouts, including Cloudflare's 100-second limit (524), mean the model was too slow.
const TIMEOUT_STATUSES=new Set([408,504,522,524]);

/** @param {string} code @param {string} message @param {number} [status] */
function providerError(code,message,status=503){return Object.assign(new Error(message),{code,status});}

/** Removes reasoning blocks some models emit before their answer. @param {unknown} value */
function stripReasoning(value){return String(value??"").replace(REASONING,"").replace(/^[\s\S]*?<\/think>/i,"").trim();}

/** Reads the first JSON object from a model answer, tolerating code fences and surrounding prose. @param {unknown} value @returns {any} */
function extractJson(value){
  const text=stripReasoning(value).replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try{return JSON.parse(text);}catch{/* fall through to the outermost braces */}
  const start=text.indexOf("{"),end=text.lastIndexOf("}");
  if(start>=0&&end>start){try{return JSON.parse(text.slice(start,end+1));}catch{/* not JSON */}}
  return null;
}

/**
 * @param {{baseUrl?:string,apiKey?:string,model?:string,timeoutMs?:number,extraHeaders?:Record<string,string>,fetchImpl?:typeof fetch}} [options]
 */
function createAiProvider({baseUrl="",apiKey="",model="",timeoutMs=120000,extraHeaders={},fetchImpl=globalThis.fetch}={}){
  const base=String(baseUrl||"").trim().replace(/\/+$/,""),name=String(model||"").trim();
  const configured=Boolean(/^https?:\/\/[^\s]+$/i.test(base)&&name);
  // Prefer a strict grammar, then remember the strongest JSON mode this compatible server accepts.
  let structured="schema";
  /** @returns {Record<string,string>} */
  function headers(){return {"Content-Type":"application/json",Accept:"application/json",...(apiKey?{Authorization:`Bearer ${apiKey}`}:{}),...extraHeaders};}
  /** @param {string} path @param {RequestInit} init @param {number} ms */
  async function send(path,init,ms){
    if(!configured)throw providerError("AI_NOT_CONFIGURED","Strata AI is not set up on this server yet.");
    try{return await fetchImpl(`${base}${path}`,{...init,headers:headers(),signal:AbortSignal.timeout(ms)});}
    catch(error){
      const timedOut=/** @type {Error} */(error)?.name==="TimeoutError";
      throw providerError(timedOut?"AI_TIMEOUT":"AI_OFFLINE",timedOut?"Strata AI took too long to answer. Try a shorter request.":"Strata AI is offline right now. Try again soon.");
    }
  }
  /** @param {Response} response */
  function assertOk(response){
    if(response.status===401||response.status===403)throw providerError("AI_AUTH","Strata AI refused this server's key. The owner needs to check the AI settings.");
    if(TIMEOUT_STATUSES.has(response.status))throw providerError("AI_TIMEOUT","Strata AI took too long to answer. Try a shorter request.");
    if(response.status===400||response.status===413)throw providerError("AI_TOO_LARGE","Strata AI could not take a request that large. Start a new conversation or ask something shorter.",502);
    if(!response.ok)throw providerError("AI_UNAVAILABLE","Strata AI is unavailable right now. Try again soon.");
  }
  async function health(){
    const response=await send("/models",{method:"GET"},8000);assertOk(response);
    const body=await response.json().catch(()=>null),ids=Array.isArray(body?.data)?body.data.map((/** @type {any} */ item)=>String(item?.id??"")):[];
    return {ok:true,modelListed:ids.includes(name)};
  }
  /** @param {{messages:Array<{role:string,content:string}>,maxTokens?:number,temperature?:number,responseFormat?:any}} request */
  async function complete({messages,maxTokens=1100,temperature=0.3,responseFormat=aiResponseFormat()}){
    const body={model:name,messages,temperature,max_tokens:maxTokens,stream:false};
    const request=(/** @type {"schema"|"object"|"plain"} */ mode)=>send("/chat/completions",{method:"POST",body:JSON.stringify(mode==="plain"?body:{...body,response_format:mode==="schema"?responseFormat:{type:"json_object"},chat_template_kwargs:{enable_thinking:false}})},timeoutMs);
    let response=await request(/** @type {any} */(structured));
    if(response.status===400&&structured==="schema"){const object=await request("object");if(object.ok){structured="object";response=object;}else if(object.status===400){const plain=await request("plain");if(plain.ok)structured="plain";response=plain;}else response=object;}
    else if(response.status===400&&structured==="object"){const plain=await request("plain");if(plain.ok)structured="plain";response=plain;}
    assertOk(response);
    const payload=await response.json().catch(()=>null),choice=payload?.choices?.[0],content=choice?.message?.content;
    if(typeof content!=="string"||!stripReasoning(content))throw providerError("AI_EMPTY","Strata AI returned an empty answer. Try again.",502);
    return {text:stripReasoning(content),data:extractJson(content),truncated:choice?.finish_reason==="length"};
  }
  return {configured,model:name,complete,health};
}

/**
 * Reads Strata AI settings from the environment. Invalid numbers fall back to safe defaults, and in
 * production a plain-HTTP address other than this machine is refused so the key never travels unencrypted.
 * @param {Record<string,string|undefined>} env
 */
function aiSettings(env){
  const number=(/** @type {string|undefined} */ value,/** @type {number} */ fallback,/** @type {number} */ min,/** @type {number} */ max)=>{const parsed=Number(value);return value!==undefined&&value!==""&&Number.isFinite(parsed)&&parsed>=min&&parsed<=max?Math.floor(parsed):fallback;};
  const base=String(env.AI_BASE_URL||"").trim(),local=/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(base);
  const insecure=env.NODE_ENV==="production"&&/^http:\/\//i.test(base)&&!local;
  /** @type {Record<string,string>} */
  const extraHeaders={};
  if(env.AI_ACCESS_CLIENT_ID&&env.AI_ACCESS_CLIENT_SECRET){extraHeaders["CF-Access-Client-Id"]=env.AI_ACCESS_CLIENT_ID;extraHeaders["CF-Access-Client-Secret"]=env.AI_ACCESS_CLIENT_SECRET;}
  return {insecure,provider:{baseUrl:insecure?"":base,apiKey:String(env.AI_API_KEY||""),model:String(env.AI_MODEL||""),timeoutMs:number(env.AI_TIMEOUT_MS,120000,5000,600000),extraHeaders},
    limits:{maxConcurrent:number(env.AI_MAX_CONCURRENT,3,1,16),maxQueue:number(env.AI_MAX_QUEUE,20,1,200),dailyLimit:number(env.AI_DAILY_LIMIT,30,1,1000)}};
}

module.exports={aiSettings,createAiProvider,extractJson,stripReasoning};
