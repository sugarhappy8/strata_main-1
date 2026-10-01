"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {GROQ_BASE_URL,aiSettings,createAiProvider,extractJson,retryAfterMs,stripReasoning,structuredFormat}=require("../src/ai-provider");

function fakeFetch(responses){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init,body:init.body?JSON.parse(init.body):null});
    const next=responses.shift();
    if(next instanceof Error)throw next;
    return new Response(typeof next.body==="string"?next.body:JSON.stringify(next.body),{status:next.status||200,headers:{"Content-Type":"application/json",...(next.headers||{})}});
  };
  return {calls,fetchImpl};
}
const answer=(content)=>({body:{choices:[{message:{content}}]}});

test("model answers are read as JSON even with reasoning, fences, or prose around them",()=>{
  assert.deepEqual(extractJson('{"reply":"hi"}'),{reply:"hi"});
  assert.deepEqual(extractJson('<think>plan the week</think>\n```json\n{"reply":"fenced"}\n```'),{reply:"fenced"});
  assert.deepEqual(extractJson('Sure! Here it is: {"reply":"inside"} Hope that helps.'),{reply:"inside"});
  assert.equal(extractJson("no json here"),null);assert.equal(extractJson('{"reply":'),null);
  assert.equal(stripReasoning("thinking without an opening tag</think> answer"),"answer");
  assert.equal(stripReasoning(undefined),"");
});

test("the client sends the key, model, and a strict JSON schema to the configured provider",async()=>{
  const {calls,fetchImpl}=fakeFetch([{body:{choices:[{message:{content:'<think>x</think>{"reply":"ok"}'}}],usage:{prompt_tokens:120,completion_tokens:30,total_tokens:150}}},{body:{data:[{id:"openai/gpt-oss-120b"},{id:"openai/gpt-oss-20b"}]}}]);
  const provider=createAiProvider({baseUrl:"https://api.groq.com/openai/v1/",apiKey:"secret-key",model:"openai/gpt-oss-120b",fallbackModel:"openai/gpt-oss-20b",fetchImpl});
  assert.equal(provider.configured,true);assert.equal(provider.model,"openai/gpt-oss-120b");assert.equal(provider.fallbackModel,"openai/gpt-oss-20b");
  const result=await provider.complete({messages:[{role:"user",content:"hello"}],maxTokens:50,temperature:0.2,reasoningEffort:"low"});
  assert.deepEqual(result,{text:'{"reply":"ok"}',data:{reply:"ok"},truncated:false,model:"openai/gpt-oss-120b",usage:{promptTokens:120,completionTokens:30,totalTokens:150}});
  assert.equal(calls[0].url,"https://api.groq.com/openai/v1/chat/completions");assert.equal(calls[0].init.headers.Authorization,"Bearer secret-key");
  assert.equal(calls[0].body.response_format.type,"json_schema");assert.equal(calls[0].body.response_format.json_schema.strict,true);assert.equal(calls[0].body.response_format.json_schema.name,"strata_response");
  assert.equal(calls[0].body.response_format.json_schema.schema.properties.reply.maxLength,900);assert.equal(calls[0].body.chat_template_kwargs,undefined,"no local-server extensions");
  assert.equal(calls[0].body.model,"openai/gpt-oss-120b");assert.equal(calls[0].body.max_tokens,50);assert.equal(calls[0].body.temperature,0.2);assert.equal(calls[0].body.stream,false);assert.equal(calls[0].body.reasoning_effort,"low");
  assert.deepEqual(await provider.health(),{ok:true,modelListed:true,fallbackListed:true});assert.equal(calls[1].url,"https://api.groq.com/openai/v1/models");
  assert.equal(createAiProvider({baseUrl:GROQ_BASE_URL,model:"m"}).configured,false,"Groq needs a key");
});

test("a rate-limited model rests for Retry-After while the fallback model answers",async()=>{
  let time=1_000_000;
  const {calls,fetchImpl}=fakeFetch([{status:429,body:{},headers:{"retry-after":"30"}},answer('{"reply":"fallback"}'),answer('{"reply":"still fallback"}'),answer('{"reply":"primary again"}')]);
  const provider=createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"big",fallbackModel:"small",fetchImpl,now:()=>time});
  const first=await provider.complete({messages:[]});assert.equal(first.data.reply,"fallback");assert.equal(first.model,"small");
  assert.deepEqual(calls.map(call=>call.body.model),["big","small"]);
  time+=10_000;assert.equal((await provider.complete({messages:[]})).model,"small","the primary is skipped while it rests");
  time+=21_000;assert.equal((await provider.complete({messages:[]})).model,"big","the primary returns after Retry-After");
  const {fetchImpl:limited}=fakeFetch([{status:429,body:{},headers:{"retry-after":"5"}},{status:429,body:{},headers:{"retry-after":"9"}}]);
  await assert.rejects(createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"big",fallbackModel:"small",fetchImpl:limited,now:()=>time}).complete({messages:[]}),(error)=>error.code==="AI_RATE_LIMIT"&&error.retryAt===time+5000);
  const {calls:retired,fetchImpl:gone}=fakeFetch([{status:404,body:{error:{code:"model_not_found"}}},answer('{"reply":"from fallback"}')]);
  assert.equal((await createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"retired",fallbackModel:"current",fetchImpl:gone}).complete({messages:[]})).model,"current");assert.equal(retired.length,2);
  assert.equal(retryAfterMs(new Response("",{headers:{"retry-after":new Date(time+12_000).toUTCString()}}),time)>=11_000,true);assert.equal(retryAfterMs(new Response(""),time),60000);
});

test("a provider that rejects structured modes falls back to JSON mode, then plain requests, and remembers it per model",async()=>{
  const {calls,fetchImpl}=fakeFetch([{status:400,body:{error:"schema unsupported"}},{status:400,body:{error:"JSON mode unsupported"}},answer('{"reply":"plain"}'),answer('{"reply":"again"}')]);
  const provider=createAiProvider({baseUrl:"http://localhost:1337/v1",model:"m",fetchImpl});
  assert.equal((await provider.complete({messages:[]})).data.reply,"plain");
  assert.equal((await provider.complete({messages:[]})).data.reply,"again");
  assert.equal(calls[0].body.response_format.type,"json_schema");assert.deepEqual(calls[1].body.response_format,{type:"json_object"});assert.equal(calls[2].body.response_format,undefined);assert.equal(calls[3].body.response_format,undefined);
  assert.equal(calls[0].init.headers.Authorization,undefined,"no key means no authorization header");
  assert.deepEqual(structuredFormat({schema:{type:"object"}},"object"),{type:"json_object"});assert.equal(structuredFormat({schema:{}},"plain"),null);assert.deepEqual(structuredFormat({},"schema"),{type:"json_object"});
});

test("failures map to clear codes without exposing server details",async()=>{
  const cases=[
    [{status:401,body:{}},"AI_AUTH"],[{status:403,body:{}},"AI_AUTH"],[{status:500,body:{}},"AI_UNAVAILABLE"],
    [new TypeError("fetch failed"),"AI_OFFLINE"],[Object.assign(new Error("slow"),{name:"TimeoutError"}),"AI_TIMEOUT"],
    [{status:524,body:{}},"AI_TIMEOUT"],[{status:504,body:{}},"AI_TIMEOUT"],[{status:413,body:{}},"AI_TOO_LARGE"],
    [answer("   "),"AI_EMPTY"],[answer("<think>only thinking</think>"),"AI_EMPTY"],[{body:{choices:[]}},"AI_EMPTY"]
  ];
  for(const [response,code] of cases){
    const {fetchImpl}=fakeFetch([response]);
    await assert.rejects(createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"m",fetchImpl}).complete({messages:[]}),(error)=>error.code===code&&!/fetch failed|slow/.test(error.message),code);
  }
  const {fetchImpl}=fakeFetch([{status:401,body:{}}]);
  await assert.rejects(createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"m",fetchImpl}).health(),{code:"AI_AUTH"});
  const unconfigured=createAiProvider({baseUrl:"",model:"m",fetchImpl:async()=>{throw new Error("must not be called");}});
  assert.equal(unconfigured.configured,false);await assert.rejects(unconfigured.complete({messages:[]}),{code:"AI_NOT_CONFIGURED"});
  assert.equal(createAiProvider({baseUrl:"https://ai.example.test/v1",model:""}).configured,false);
  assert.equal(createAiProvider({baseUrl:"ftp://ai.example.test",model:"m"}).configured,false);
  const {fetchImpl:listFetch}=fakeFetch([{body:{data:"not a list"}}]);
  assert.deepEqual(await createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"m",fetchImpl:listFetch}).health(),{ok:true,modelListed:false,fallbackListed:null});
});

test("settings default to Groq, read models only from the environment, and bound every limit",()=>{
  const defaults=aiSettings({});
  assert.equal(defaults.provider.baseUrl,GROQ_BASE_URL);assert.equal(defaults.provider.model,"","models are never hard-coded");assert.equal(defaults.provider.fallbackModel,"");assert.equal(defaults.provider.timeoutMs,60000);
  assert.deepEqual(defaults.limits,{maxConcurrent:3,maxQueue:20,userDaily:30,dailyRequests:900,perMinute:25,briefShare:0.4});assert.deepEqual(defaults.brief,{enabled:true,hour:5});assert.equal(defaults.insecure,false);
  const tuned=aiSettings({GROQ_API_KEY:"gsk",STRATA_AI_MODEL:"openai/gpt-oss-120b",STRATA_AI_FALLBACK_MODEL:"openai/gpt-oss-20b",STRATA_AI_TIMEOUT_MS:"30000",STRATA_AI_MAX_CONCURRENT:"2",STRATA_AI_MAX_QUEUE:"5",STRATA_AI_USER_DAILY_LIMIT:"10",STRATA_AI_DAILY_REQUESTS:"14000",STRATA_AI_REQUESTS_PER_MINUTE:"300",STRATA_AI_BRIEF_SHARE:"0.25",STRATA_AI_DAILY_BRIEF:"false",STRATA_AI_BRIEF_HOUR:"6"});
  assert.deepEqual(tuned.provider,{baseUrl:GROQ_BASE_URL,apiKey:"gsk",model:"openai/gpt-oss-120b",fallbackModel:"openai/gpt-oss-20b",timeoutMs:30000});
  assert.deepEqual(tuned.limits,{maxConcurrent:2,maxQueue:5,userDaily:10,dailyRequests:14000,perMinute:300,briefShare:0.25});assert.deepEqual(tuned.brief,{enabled:false,hour:6});
  const invalid=aiSettings({STRATA_AI_TIMEOUT_MS:"5",STRATA_AI_MAX_CONCURRENT:"999",STRATA_AI_MAX_QUEUE:"abc",STRATA_AI_USER_DAILY_LIMIT:"",STRATA_AI_BRIEF_SHARE:"2",STRATA_AI_BRIEF_HOUR:"25"});
  assert.equal(invalid.provider.timeoutMs,60000);assert.deepEqual(invalid.limits,{maxConcurrent:3,maxQueue:20,userDaily:30,dailyRequests:900,perMinute:25,briefShare:0.4});assert.equal(invalid.brief.hour,5);
  assert.equal(aiSettings({AI_BASE_URL:"http://127.0.0.1:1337/v1",AI_MODEL:"local"}).provider.model,"","the retired local-PC settings are ignored");
  const plain=aiSettings({NODE_ENV:"production",STRATA_AI_BASE_URL:"http://203.0.113.5:1337/v1",STRATA_AI_MODEL:"m"});
  assert.equal(plain.insecure,true,"production never sends the key over plain HTTP");assert.equal(plain.provider.baseUrl,"");
  assert.equal(aiSettings({NODE_ENV:"production",STRATA_AI_BASE_URL:"http://127.0.0.1:1337/v1"}).insecure,false,"this machine is allowed");
});

test("a rejected prompt is reported as too large without turning JSON mode off",async()=>{
  const {calls,fetchImpl}=fakeFetch([{status:400,body:{}},{status:400,body:{}},{status:400,body:{}},{body:{choices:[{message:{content:'{"reply":"cut'},finish_reason:"length"}]}}]);
  const provider=createAiProvider({baseUrl:"https://ai.example.test/v1",apiKey:"k",model:"m",fetchImpl});
  await assert.rejects(provider.complete({messages:[]}),{code:"AI_TOO_LARGE"});
  const cut=await provider.complete({messages:[]});
  assert.equal(calls[3].body.response_format.type,"json_schema","all fallbacks failed, so the provider's schema support was not disproved");
  assert.equal(cut.truncated,true);assert.equal(cut.data,null);
});

test("responses STRATA discards while falling back are cancelled so their connections are released",async()=>{
  const cancelled=[];let call=0;
  const fetchImpl=async()=>{
    call+=1;const index=call;
    if(index<3)return new Response(new ReadableStream({pull(controller){controller.enqueue(new TextEncoder().encode("{}"));},cancel(){cancelled.push(index);}}),{status:400,headers:{"Content-Type":"application/json"}});
    return new Response(JSON.stringify({choices:[{message:{content:'{"reply":"plain"}'}}]}),{status:200,headers:{"Content-Type":"application/json"}});
  };
  const provider=createAiProvider({baseUrl:"http://localhost:1337/v1",model:"m",fetchImpl});
  assert.equal((await provider.complete({messages:[{role:"user",content:"hi"}]})).data.reply,"plain");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(cancelled,[1,2]);
});
