// @ts-check
"use strict";

const {withAppendedCookies}=require("./session-renewal");
const { gzipSync }=require("node:zlib");

const MAX_BODY_BYTES=64*1024;
const MAX_WEBHOOK_BYTES=256*1024;
const MIN_GZIP_BYTES=1024;

/**
 * Headers every response carries. HSTS is sent only in production, which is served over HTTPS (browsers ignore it
 * over plain HTTP); it omits includeSubDomains so other hosts under the domain are not forced onto HTTPS.
 * form-action names Google's sign-in page: the sign-in form's answer redirects there.
 * @param {boolean} [production]
 */
function securityHeaders(production=process.env.NODE_ENV==="production") {
  return {
    ...(production?{"Strict-Transport-Security":"max-age=31536000"}:{}),
    "Content-Security-Policy":"default-src 'self'; img-src 'self' https://*.paddle.com data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' https://cdn.paddle.com; connect-src 'self' https://*.paddle.com; manifest-src 'self'; worker-src 'self'; frame-src https://*.paddle.com; object-src 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'",
    "X-Content-Type-Options":"nosniff",
    "X-Frame-Options":"DENY",
    "Referrer-Policy":"strict-origin-when-cross-origin",
    "Permissions-Policy":"camera=(), microphone=(), geolocation=()"
  };
}

/** @param {import("./domain-types").HttpHeaders} headers @param {string} name */
function headerKey(headers,name) {
  const lowered=name.toLowerCase();
  return Object.keys(headers).find((key)=>key.toLowerCase()===lowered);
}

/** @param {import("./domain-types").HttpHeaders} headers @param {string} value */
function appendVary(headers,value) {
  const key=headerKey(headers,"Vary")||"Vary";
  const values=String(headers[key]||"").split(",").map((item)=>item.trim()).filter(Boolean);
  if (!values.some((item)=>item.toLowerCase()===value.toLowerCase())) values.push(value);
  headers[key]=values.join(", ");
}

/** @param {unknown} header */
function gzipAccepted(header) {
  /** @type {number|undefined} */
  let explicit;
  /** @type {number|undefined} */
  let wildcard;
  for (const item of String(header||"").split(",")) {
    const [rawCoding="",...parameters]=item.trim().split(";");
    const coding=rawCoding.trim().toLowerCase();
    if (!coding) continue;
    let quality=1;
    for (const parameter of parameters) {
      const match=parameter.trim().match(/^q\s*=\s*(.+)$/i);
      if (!match) continue;
      const qualityText=match[1]||"";
      const valid=/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qualityText);
      quality=valid?Number(qualityText):0;
      break;
    }
    if (coding==="gzip") explicit=explicit===undefined?quality:Math.max(explicit,quality);
    if (coding==="*") wildcard=wildcard===undefined?quality:Math.max(wildcard,quality);
  }
  return (explicit??wildcard??0)>0;
}

/** @param {string} contentType */
function compressibleType(contentType) {
  return /^text\//i.test(contentType)||/^(?:application\/(?:json|javascript|manifest\+json)|image\/svg\+xml)(?:;|$)/i.test(contentType);
}

/**
 * @param {import("./domain-types").HttpRequest} req
 * @param {string|Buffer} body
 * @param {import("./domain-types").HttpHeaders} headers
 */
function responseBody(req,body,headers) {
  const original=Buffer.isBuffer(body)?body:Buffer.from(String(body));
  const typeKey=headerKey(headers,"Content-Type");
  const encodingKey=headerKey(headers,"Content-Encoding");
  const canCompress=!encodingKey&&original.length>=MIN_GZIP_BYTES&&compressibleType(String(typeKey?headers[typeKey]:""));
  let payload=original;
  if (canCompress) {
    appendVary(headers,"Accept-Encoding");
    if (gzipAccepted(req?.headers?.["accept-encoding"])) {
      const compressed=gzipSync(original);
      if (compressed.length<original.length) {
        headers["Content-Encoding"]="gzip";
        payload=compressed;
      }
    }
  }
  const lengthKey=headerKey(headers,"Content-Length");
  if (lengthKey) delete headers[lengthKey];
  headers["Content-Length"]=payload.length;
  return payload;
}

/**
 * @param {import("./domain-types").HttpResponse} res
 * @param {number} status
 * @param {unknown} data
 * @param {import("./domain-types").HttpHeaders} headers
 */
function json(res,status,data,headers={}) {
  const responseHeaders=withAppendedCookies(res,{...securityHeaders(),"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers});
  const body=responseBody(res.req,JSON.stringify(data),responseHeaders);
  res.writeHead(status,responseHeaders);
  if (res.req?.method==="HEAD") res.end(); else res.end(body);
}

/** @param {import("./domain-types").HttpRequest} req @param {number} maxBytes @returns {Promise<Buffer>} */
function bodyBuffer(req,maxBytes=MAX_BODY_BYTES) {
  return new Promise((resolve,reject)=>{
    /** @type {Buffer[]} */
    let chunks=[];
    let bytes=0,tooLarge=false;
    req.on("data",(chunk)=>{
      if (tooLarge) return;
      bytes+=chunk.length;
      if (bytes>maxBytes) {
        tooLarge=true;
        chunks=[];
        reject(Object.assign(new Error("Request is too large."),{status:413}));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
    });
    req.on("end",()=>{ if (!tooLarge) resolve(Buffer.concat(chunks,bytes)); });
    req.on("error",reject);
  });
}

/** @param {import("./domain-types").HttpRequest} req */
async function bodyText(req) {
  return (await bodyBuffer(req)).toString("utf8");
}

/** @param {import("./domain-types").HttpRequest} req @returns {Promise<unknown>} */
async function bodyJson(req) {
  const body=await bodyText(req);
  try {
    const input=body?JSON.parse(body):{};
    if (!input||typeof input!=="object"||Array.isArray(input)) throw new Error("Invalid body shape");
    return input;
  }
  catch { throw Object.assign(new Error("Invalid JSON."),{status:400}); }
}

/** @param {import("./domain-types").HttpRequest} req @returns {Promise<Record<string,string>>} */
async function bodyForm(req) {
  const body=await bodyText(req),params=new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

/**
 * @param {import("./domain-types").HttpResponse} res
 * @param {string} location
 * @param {import("./domain-types").HttpHeaders} headers
 */
function redirect(res,location,headers={}) {
  res.writeHead(303,withAppendedCookies(res,{...securityHeaders(),Location:location,"Cache-Control":"no-store",...headers}));
  res.end();
}

module.exports={
  MAX_BODY_BYTES,
  MAX_WEBHOOK_BYTES,
  securityHeaders,
  gzipAccepted,
  responseBody,
  json,
  bodyBuffer,
  bodyText,
  bodyJson,
  bodyForm,
  redirect
};
