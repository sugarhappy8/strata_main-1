"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {createLogger,incomingRequestId,observeRequest,safeFields}=require("../src/observability");

test("structured logs redact secrets and provider/account identifiers",()=>{
  const sanitized=safeFields({requestId:"request-123",email:"member@example.com",userId:"user-private",customer_id:"ctm_private",apiKey:"key-private",api_key:"key-private-2",verificationCode:"123456",nested:{password:"secret",passcode:"654321",result:"ok"},token:"value"});
  assert.deepEqual(sanitized,{requestId:"request-123",email:"[redacted]",userId:"[redacted]",customer_id:"[redacted]",apiKey:"[redacted]",api_key:"[redacted]",verificationCode:"[redacted]",nested:{password:"[redacted]",passcode:"[redacted]",result:"ok"},token:"[redacted]"});
  assert.doesNotMatch(JSON.stringify(sanitized),/member@example|user-private|ctm_private|key-private|123456|654321|secret|"value"/);
});

test("free-form log and Error content scrub inline credentials and addresses",()=>{
  const raw="Bearer bearer-secret-value api_key=pdl_live_apikey_private1234567890 token=action-private member@example.com";
  const sanitized=safeFields({message:raw,error:new Error(`Provider failed: ${raw}`)});
  assert.doesNotMatch(JSON.stringify(sanitized),/bearer-secret-value|pdl_live_apikey_private|action-private|member@example\s*\.com/);
  assert.match(sanitized.message,/\[redacted\]/);
  assert.match(sanitized.error.message,/\[redacted-email\]/);
});

test("logger emits bounded machine-readable events without printing raw Error stacks",()=>{
  const lines=[];
  const sink={log:value=>lines.push(value),warn:value=>lines.push(value),error:value=>lines.push(value)};
  const logger=createLogger({sink,clock:()=>new Date("2026-09-07T00:00:00.000Z"),environment:"production"});
  logger.error("provider.failure",{error:Object.assign(new Error("Paddle unavailable"),{code:"PADDLE_DOWN"}),authorization:"Bearer secret"});
  assert.equal(lines.length,1);
  const parsed=JSON.parse(lines[0]);
  assert.deepEqual(parsed.error,{name:"Error",code:"PADDLE_DOWN",message:"Paddle unavailable"});
  assert.equal(parsed.authorization,"[redacted]");
  assert.equal(parsed.level,"error");
  assert.equal(parsed.event,"provider.failure");
  assert.equal(Object.hasOwn(parsed.error,"stack"),false);
});

test("request observation propagates a valid trace id and logs one terminal record",()=>{
  const records=[],response=new EventEmitter();
  response.statusCode=204;response.writableEnded=true;response.headers={};response.setHeader=(name,value)=>{response.headers[name]=value;};
  const request={headers:{"x-request-id":"edge-request-1234"},method:"POST",url:"/api/plan?private=value"};
  const logger={info:(event,fields)=>records.push({event,...fields})};
  let timestamp=10;
  assert.equal(observeRequest(request,response,logger,{now:()=>timestamp,makeId:()=>"generated-request-id"}),"edge-request-1234");
  timestamp=16.5;response.emit("finish");response.emit("close");
  assert.equal(response.headers["X-Request-ID"],"edge-request-1234");
  assert.equal(request.strataRequestId,"edge-request-1234");
  assert.deepEqual(records,[{event:"http.request",requestId:"edge-request-1234",method:"POST",path:"/api/plan",status:204,durationMs:6.5,state:"finished"}]);
});

test("untrusted request identifiers are replaced",()=>{
  assert.equal(incomingRequestId("too short"),"");
  assert.equal(incomingRequestId("valid-request:123"),"valid-request:123");
  assert.equal(incomingRequestId("header\nspoofing"),"");
});
