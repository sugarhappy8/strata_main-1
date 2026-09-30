"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {aiSettings,createAiProvider,extractJson,stripReasoning}=require("../src/ai-provider");

function fakeFetch(responses){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init,body:init.body?JSON.parse(init.body):null});
    const next=responses.shift();
    if(next instanceof Error)throw next;
    return new Response(typeof next.body==="string"?next.body:JSON.stringify(next.body),{status:next.status||200,headers:{"Content-Type":"application/json"}});
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

test("the client sends the key, model, and Atomic llama.cpp schema to the configured server",async()=>{
  const {calls,fetchImpl}=fakeFetch([answer('<think>x</think>{"reply":"ok"}'),{body:{data:[{id:"local-model"},{id:"other"}]}}]);
  const provider=createAiProvider({baseUrl:"https://ai.example.test/v1/",apiKey:"secret-key",model:"local-model",extraHeaders:{"CF-Access-Client-Id":"id"},fetchImpl});
  assert.equal(provider.configured,true);assert.equal(provider.model,"local-model");
  const result=await provider.complete({messages:[{role:"user",content:"hello"}],maxTokens:50,temperature:0.2});
  assert.deepEqual(result,{text:'{"reply":"ok"}',data:{reply:"ok"},truncated:false});
  assert.equal(calls[0].url,"https://ai.example.test/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization,"Bearer secret-key");assert.equal(calls[0].init.headers["CF-Access-Client-Id"],"id");
  assert.equal(calls[0].body.response_format.type,"json_object");assert.equal(calls[0].body.response_format.schema.properties.reply.maxLength,900);assert.equal(calls[0].body.response_format.json_schema,undefined);assert.deepEqual(calls[0].body.chat_template_kwargs,{enable_thinking:false});
  assert.equal(calls[0].body.model,"local-model");assert.equal(calls[0].body.max_tokens,50);assert.equal(calls[0].body.temperature,0.2);assert.equal(calls[0].body.stream,false);
  assert.deepEqual(await provider.health(),{ok:true,modelListed:true});assert.equal(calls[1].url,"https://ai.example.test/v1/models");
});

test("a server that rejects structured modes falls back to plain requests and remembers it",async()=>{
  const {calls,fetchImpl}=fakeFetch([{status:400,body:{error:"schema unsupported"}},{status:400,body:{error:"JSON mode unsupported"}},answer('{"reply":"plain"}'),answer('{"reply":"again"}')]);
  const provider=createAiProvider({baseUrl:"http://localhost:1337/v1",model:"m",fetchImpl});
  assert.equal((await provider.complete({messages:[]})).data.reply,"plain");
  assert.equal((await provider.complete({messages:[]})).data.reply,"again");
  assert.equal(calls[0].body.response_format.type,"json_object");assert.ok(calls[0].body.response_format.schema);assert.equal(calls[1].body.response_format.type,"json_object");assert.equal(calls[1].body.response_format.schema,undefined);assert.equal(calls[2].body.response_format,undefined);assert.equal(calls[3].body.response_format,undefined);
  assert.equal(calls[0].init.headers.Authorization,undefined,"no key means no authorization header");
});

test("a server can fall back from JSON schema to JSON object mode",async()=>{
  const {calls,fetchImpl}=fakeFetch([{status:400,body:{}},answer('{"reply":"object"}'),answer('{"reply":"again"}')]),provider=createAiProvider({baseUrl:"http://localhost:1337/v1",model:"m",fetchImpl});
  assert.equal((await provider.complete({messages:[]})).data.reply,"object");assert.equal((await provider.complete({messages:[]})).data.reply,"again");
  assert.ok(calls[0].body.response_format.schema);assert.equal(calls[1].body.response_format.type,"json_object");assert.equal(calls[1].body.response_format.schema,undefined);assert.equal(calls[2].body.response_format.type,"json_object");assert.equal(calls[2].body.response_format.schema,undefined);
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
    await assert.rejects(createAiProvider({baseUrl:"https://ai.example.test/v1",model:"m",fetchImpl}).complete({messages:[]}),(error)=>error.code===code&&!/fetch failed|slow/.test(error.message),code);
  }
  const {fetchImpl}=fakeFetch([{status:401,body:{}}]);
  await assert.rejects(createAiProvider({baseUrl:"https://ai.example.test/v1",model:"m",fetchImpl}).health(),{code:"AI_AUTH"});
  const unconfigured=createAiProvider({baseUrl:"",model:"m",fetchImpl:async()=>{throw new Error("must not be called");}});
  assert.equal(unconfigured.configured,false);await assert.rejects(unconfigured.complete({messages:[]}),{code:"AI_NOT_CONFIGURED"});
  assert.equal(createAiProvider({baseUrl:"https://ai.example.test/v1",model:""}).configured,false);
  assert.equal(createAiProvider({baseUrl:"ftp://ai.example.test",model:"m"}).configured,false);
  const {fetchImpl:listFetch}=fakeFetch([{body:{data:"not a list"}}]);
  assert.deepEqual(await createAiProvider({baseUrl:"https://ai.example.test/v1",model:"m",fetchImpl:listFetch}).health(),{ok:true,modelListed:false});
});

test("settings come from the environment with safe defaults and bounds",()=>{
  const defaults=aiSettings({});
  assert.deepEqual(defaults.limits,{maxConcurrent:3,maxQueue:20,dailyLimit:30});assert.equal(defaults.provider.timeoutMs,120000);assert.equal(defaults.insecure,false);
  const tuned=aiSettings({AI_BASE_URL:" https://ai.example.test/v1 ",AI_API_KEY:"k",AI_MODEL:"m",AI_TIMEOUT_MS:"30000",AI_MAX_CONCURRENT:"2",AI_MAX_QUEUE:"5",AI_DAILY_LIMIT:"10",AI_ACCESS_CLIENT_ID:"cid",AI_ACCESS_CLIENT_SECRET:"csecret"});
  assert.equal(tuned.provider.baseUrl,"https://ai.example.test/v1");assert.equal(tuned.provider.timeoutMs,30000);
  assert.deepEqual(tuned.limits,{maxConcurrent:2,maxQueue:5,dailyLimit:10});
  assert.deepEqual(tuned.provider.extraHeaders,{"CF-Access-Client-Id":"cid","CF-Access-Client-Secret":"csecret"});
  const invalid=aiSettings({AI_TIMEOUT_MS:"5",AI_MAX_CONCURRENT:"999",AI_MAX_QUEUE:"abc",AI_DAILY_LIMIT:"",AI_ACCESS_CLIENT_ID:"only-id"});
  assert.equal(invalid.provider.timeoutMs,120000);assert.deepEqual(invalid.limits,{maxConcurrent:3,maxQueue:20,dailyLimit:30});assert.deepEqual(invalid.provider.extraHeaders,{});
  const plain=aiSettings({NODE_ENV:"production",AI_BASE_URL:"http://203.0.113.5:1337/v1",AI_MODEL:"m"});
  assert.equal(plain.insecure,true,"production never sends the key over plain HTTP");assert.equal(plain.provider.baseUrl,"");
  assert.equal(aiSettings({NODE_ENV:"production",AI_BASE_URL:"http://127.0.0.1:1337/v1"}).insecure,false,"this machine is allowed");
  assert.equal(aiSettings({NODE_ENV:"development",AI_BASE_URL:"http://192.168.1.4:1337/v1"}).insecure,false);
});

test("a rejected prompt is reported as too large without turning JSON mode off",async()=>{
  const {calls,fetchImpl}=fakeFetch([{status:400,body:{}},{status:400,body:{}},{status:400,body:{}},{body:{choices:[{message:{content:'{"reply":"cut'},finish_reason:"length"}]}}]);
  const provider=createAiProvider({baseUrl:"https://ai.example.test/v1",model:"m",fetchImpl});
  await assert.rejects(provider.complete({messages:[]}),{code:"AI_TOO_LARGE"});
  const cut=await provider.complete({messages:[]});
  assert.ok(calls[3].body.response_format.schema,"all fallbacks failed, so the server's schema support was not disproved");
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
