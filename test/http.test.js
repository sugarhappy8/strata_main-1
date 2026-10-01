"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const { Readable }=require("node:stream");
const { gunzipSync }=require("node:zlib");
const {
  securityHeaders,
  gzipAccepted,
  responseBody,
  json,
  bodyBuffer,
  bodyJson,
  bodyForm,
  redirect
}=require("../src/http");

function response(method="GET") {
  return {
    req:{method,headers:{}},
    status:null,
    headers:null,
    body:undefined,
    writeHead(status,headers){ this.status=status; this.headers=headers; },
    end(body){ this.body=body; }
  };
}

test("security headers are complete and returned as a fresh object",()=>{
  const first=securityHeaders(),second=securityHeaders();
  assert.notEqual(first,second);
  assert.equal(first["X-Content-Type-Options"],"nosniff");
  assert.equal(first["X-Frame-Options"],"DENY");
  assert.match(first["Content-Security-Policy"],/frame-ancestors 'none'/);
  assert.equal(first["Strict-Transport-Security"],undefined,"HSTS is never sent from development or test servers");
  assert.equal(securityHeaders(true)["Strict-Transport-Security"],"max-age=31536000","production pins HTTPS for a year");
});

test("gzip negotiation respects explicit quality values and response metadata",()=>{
  assert.equal(gzipAccepted("gzip"),true);
  assert.equal(gzipAccepted("gzip;q=0, *;q=1"),false);
  assert.equal(gzipAccepted("br, *;q=0.5"),true);
  assert.equal(gzipAccepted("gzip;q=invalid"),false);

  const original="compress me ".repeat(300);
  const headers={"content-type":"text/plain; charset=utf-8","content-length":"stale",Vary:"Cookie"};
  const compressed=responseBody({headers:{"accept-encoding":"gzip"}},original,headers);
  assert.equal(headers["Content-Encoding"],"gzip");
  assert.equal(headers.Vary,"Cookie, Accept-Encoding");
  assert.equal(headers["content-length"],undefined);
  assert.equal(headers["Content-Length"],compressed.length);
  assert.equal(gunzipSync(compressed).toString(),original);
});

test("JSON responses preserve HEAD semantics and no-store defaults",()=>{
  const get=response();
  json(get,201,{ok:true});
  assert.equal(get.status,201);
  assert.equal(get.headers["Cache-Control"],"no-store");
  assert.deepEqual(JSON.parse(get.body.toString()),{ok:true});

  const head=response("HEAD");
  json(head,200,{ok:true});
  assert.equal(head.body,undefined);
  assert.equal(head.headers["Content-Length"],11);
});

test("request body helpers parse supported formats and reject invalid or oversized input",async()=>{
  assert.deepEqual(await bodyJson(Readable.from([Buffer.from("{\"ok\":true}")])),{ok:true});
  for (const body of ["null","[]","true","12",'"text"']) {
    await assert.rejects(bodyJson(Readable.from([Buffer.from(body)])),(error)=>error.status===400);
  }
  await assert.rejects(bodyJson(Readable.from([Buffer.from("not json")])),(error)=>error.status===400&&error.message==="Invalid JSON.");
  assert.deepEqual(await bodyForm(Readable.from([Buffer.from("name=STRATA&mode=fast")])),{name:"STRATA",mode:"fast"});
  await assert.rejects(bodyBuffer(Readable.from([Buffer.alloc(5)]),4),(error)=>error.status===413&&error.message==="Request is too large.");
});

test("redirect responses apply secure no-store defaults and allow explicit headers",()=>{
  const res=response();
  redirect(res,"/account",{"Set-Cookie":"session=abc"});
  assert.equal(res.status,303);
  assert.equal(res.headers.Location,"/account");
  assert.equal(res.headers["Cache-Control"],"no-store");
  assert.equal(res.headers["Set-Cookie"],"session=abc");
});
