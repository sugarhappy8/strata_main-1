// @ts-check
"use strict";

// Connected-device settings. Polar AccessLink needs the client id and secret from admin.polaraccesslink.com,
// and DEVICE_TOKEN_KEY encrypts each member's V4 credential envelope at rest. Until all three are set the feature stays off.

const {createHash}=require("node:crypto");

const POLAR_DEFAULTS=Object.freeze({
  authorizeUrl:"https://auth.polar.com/oauth/authorize",
  tokenUrl:"https://auth.polar.com/oauth/token",
  apiBase:"https://www.polaraccesslink.com/v4/data"
});
const LOCAL_HTTP=/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

/** @param {string|undefined} value */
function clean(value){return String(value??"").trim();}

/** A 32-byte key written as base64 or base64url, or null. @param {string} value @returns {Buffer|null} */
function tokenKey(value){
  if(!/^[A-Za-z0-9+/_-]{43}=?$/.test(value))return null;
  const key=Buffer.from(value.replace(/-/g,"+").replace(/_/g,"/"),"base64");
  return key.length===32?key:null;
}
/** A short, non-secret label that records which key sealed a token. @param {Buffer} key */
function keyId(key){return createHash("sha256").update(key).digest("hex").slice(0,8);}

/**
 * Reads the connected-device settings. Polar addresses must use https; plain http is accepted only for this
 * machine outside production, so tests can use a local stand-in and a member's token never travels unencrypted.
 * @param {Record<string,string|undefined>} env
 */
function devicesSettings(env){
  const production=env.NODE_ENV==="production";
  /** @param {string} value @param {string} fallback */
  const endpoint=(value,fallback)=>{
    const url=(value||fallback).replace(/\/+$/,"");
    return /^https:\/\/[^\s]+$/i.test(url)||!production&&LOCAL_HTTP.test(url)?url:"";
  };
  const keys=[tokenKey(clean(env.DEVICE_TOKEN_KEY)),tokenKey(clean(env.DEVICE_TOKEN_KEY_PREVIOUS))]
    .filter((key)=>key!==null).map((key)=>({id:keyId(key),key}));
  const current=tokenKey(clean(env.DEVICE_TOKEN_KEY));
  const clientId=clean(env.POLAR_CLIENT_ID),clientSecret=clean(env.POLAR_CLIENT_SECRET);
  const authorizeUrl=endpoint(clean(env.POLAR_AUTH_URL),POLAR_DEFAULTS.authorizeUrl);
  const tokenUrl=endpoint(clean(env.POLAR_TOKEN_URL),POLAR_DEFAULTS.tokenUrl);
  const apiBase=endpoint(clean(env.POLAR_API_URL),POLAR_DEFAULTS.apiBase);
  const base=clean(env.APP_BASE_URL).replace(/\/+$/,"");
  const redirectUri=clean(env.POLAR_REDIRECT_URI)||(base?`${base}/api/devices/polar/callback`:"");
  /** @type {string[]} */
  const problems=[];
  if(!clientId||!clientSecret)problems.push("POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required.");
  if(!current)problems.push("DEVICE_TOKEN_KEY must be 32 random bytes written as base64.");
  if(!authorizeUrl||!tokenUrl||!apiBase)problems.push("Polar addresses must use https.");
  if(production&&!/^https:\/\/[^\s]+$/i.test(redirectUri))problems.push("POLAR_REDIRECT_URI or APP_BASE_URL must be an https address in production.");
  return {
    configured:problems.length===0,problems,keys,
    polar:{clientId,clientSecret,authorizeUrl,tokenUrl,apiBase,redirectUri},
    secureCookies:production||env.SECURE_COOKIES==="true",
    // How often the sync loop looks for due connections. Tests shorten it; the default suits production.
    syncIntervalMs:Math.min(3600000,Math.max(200,Math.floor(Number(env.DEVICE_SYNC_INTERVAL_MS)||60000)))
  };
}

module.exports={POLAR_DEFAULTS,devicesSettings,keyId,tokenKey};
