// @ts-check
"use strict";

// Sliding sessions. A member who keeps using STRATA (the iOS app above all) stays signed in: once a valid session is past
// half of its lifetime, the session lookup extends it and queues a fresh cookie with the same token. Renewal never goes
// past an absolute cap counted from when the member signed in, so a stolen cookie cannot be kept alive forever.
const SESSION_MAX_LIFETIME_MS=60*24*60*60*1000;

/** @type {WeakMap<import("./domain-types").HttpRequest,string[]>} */
const queuedCookies=new WeakMap();

/**
 * The new expiry for a session that should slide forward, or null when it does not need (or may not get) one.
 * @param {{expires_at:unknown,session_created_at?:unknown}} session
 * @param {{now:number,sessionMs:number,maxLifetimeMs?:number}} options
 * @returns {number|null}
 */
function renewedSessionExpiry(session,{now,sessionMs,maxLifetimeMs=SESSION_MAX_LIFETIME_MS}){
  const expiresAt=Number(session.expires_at),createdAt=Number(session.session_created_at);
  if(!Number.isSafeInteger(expiresAt)||!Number.isSafeInteger(createdAt)||expiresAt<=now)return null;
  if(expiresAt-now>=sessionMs/2)return null;
  const renewed=Math.min(now+sessionMs,createdAt+maxLifetimeMs);
  return renewed-expiresAt>=60_000?renewed:null;
}

/** Remember a cookie for whatever response this request ends up sending. @param {import("./domain-types").HttpRequest} req @param {string} cookie */
function queueResponseCookie(req,cookie){
  const name=cookie.slice(0,cookie.indexOf("=")+1);
  queuedCookies.set(req,[...(queuedCookies.get(req)||[]).filter((item)=>!item.startsWith(name)),cookie]);
}

/** @param {unknown} value @returns {string[]} */
function cookieList(value){return value==null?[]:Array.isArray(value)?value.map(String):[String(value)];}

/**
 * The single choke point: every response written for this request carries the queued cookies, unless the route
 * set a cookie of the same name itself (sign-out, sign-in, and deletion clear or replace the session cookie).
 * @param {import("./domain-types").HttpRequest} req
 * @param {import("./domain-types").HttpResponse} res
 */
function deliverQueuedCookies(req,res){
  const writeHead=res.writeHead;
  /** @type {(...args:any[])=>import("./domain-types").HttpResponse} */
  const wrapped=function(...args){
    const queued=queuedCookies.get(req);
    if(queued?.length){
      const index=args.findIndex((value,position)=>position>0&&value&&typeof value==="object"&&!Array.isArray(value));
      const headers=index>0?args[index]:null;
      const key=headers?Object.keys(headers).find((name)=>name.toLowerCase()==="set-cookie"):undefined;
      const current=headers&&key?cookieList(headers[key]):cookieList(res.getHeader("Set-Cookie"));
      const added=queued.filter((cookie)=>!current.some((item)=>item.startsWith(cookie.slice(0,cookie.indexOf("=")+1))));
      if(added.length){
        if(headers&&key)headers[key]=[...current,...added];
        else if(headers&&!res.hasHeader("Set-Cookie"))headers["Set-Cookie"]=added;
        else res.setHeader("Set-Cookie",[...current,...added]);
      }
      queuedCookies.delete(req);
    }
    return writeHead.apply(res,/** @type {any} */(args));
  };
  res.writeHead=/** @type {any} */(wrapped);
}

module.exports={SESSION_MAX_LIFETIME_MS,deliverQueuedCookies,queueResponseCookie,renewedSessionExpiry};
