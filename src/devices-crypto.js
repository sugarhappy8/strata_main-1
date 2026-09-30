// @ts-check
"use strict";

// Members' device tokens are sealed with AES-256-GCM before they reach the database. Each sealed value names
// the key that sealed it, so DEVICE_TOKEN_KEY can be rotated by moving the old key to DEVICE_TOKEN_KEY_PREVIOUS.

const {createCipheriv,createDecipheriv,createHash,randomBytes,timingSafeEqual}=require("node:crypto");

/** @typedef {{id:string,key:Buffer}} DeviceKey */

/** @param {DeviceKey} key */
const aad=(key)=>Buffer.from(`strata-device-token:${key.id}`);

/** @param {DeviceKey[]} keys @param {string} plaintext @returns {string} */
function seal(keys,plaintext){
  const key=keys[0];
  if(!key)throw Object.assign(new Error("No device token key is configured."),{code:"DEVICE_KEY_MISSING"});
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key.key,iv);
  cipher.setAAD(aad(key));
  const body=Buffer.concat([cipher.update(String(plaintext),"utf8"),cipher.final()]);
  return ["v1",key.id,iv.toString("base64url"),body.toString("base64url"),cipher.getAuthTag().toString("base64url")].join(".");
}

/** @param {DeviceKey[]} keys @param {string} sealed @returns {string} */
function open(keys,sealed){
  const [version,id,iv,body,tag,...rest]=String(sealed||"").split(".");
  if(version!=="v1"||!id||!iv||!body||!tag||rest.length)throw Object.assign(new Error("This device token cannot be read."),{code:"DEVICE_TOKEN_UNREADABLE"});
  const key=keys.find((candidate)=>candidate.id===id);
  if(!key)throw Object.assign(new Error("This device token was sealed with a key that is no longer configured."),{code:"DEVICE_KEY_MISSING"});
  try{
    const decipher=createDecipheriv("aes-256-gcm",key.key,Buffer.from(iv,"base64url"),{authTagLength:16});
    decipher.setAAD(aad(key));decipher.setAuthTag(Buffer.from(tag,"base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body,"base64url")),decipher.final()]).toString("utf8");
  }catch{throw Object.assign(new Error("This device token cannot be read."),{code:"DEVICE_TOKEN_UNREADABLE"});}
}

/** @param {string} value */
function sha256(value){return createHash("sha256").update(String(value)).digest("hex");}
/** @param {number} [bytes] */
function randomId(bytes=32){return randomBytes(bytes).toString("base64url");}
/** Constant-time comparison of two strings. @param {string} left @param {string} right */
function sameSecret(left,right){
  const a=Buffer.from(String(left)),b=Buffer.from(String(right));
  return a.length===b.length&&timingSafeEqual(a,b);
}

module.exports={open,randomId,sameSecret,seal,sha256};
