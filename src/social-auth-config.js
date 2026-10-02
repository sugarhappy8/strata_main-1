// @ts-check
"use strict";

// Sign in with Google, Apple, or Samsung. Each provider's button appears only when every value it needs is set,
// so a half-configured provider never sends a member to a sign-in page that cannot finish. SIGN_IN_TOKEN_KEY seals
// the Apple refresh token STRATA keeps only so it can revoke Sign in with Apple when the account is deleted.

const {createPrivateKey}=require("node:crypto");
const {keyId,tokenKey}=require("./devices-config");

/** @typedef {"google"|"apple"|"samsung"} SocialProviderId */

const SOCIAL_PROVIDER_IDS=/** @type {readonly SocialProviderId[]} */(Object.freeze(["google","apple","samsung"]));
// Published OpenID Connect endpoints (each provider's /.well-known/openid-configuration). Apple returns the code
// with a cross-site form POST because STRATA asks for the member's name and email; the others redirect back.
const PROVIDER_DEFAULTS=Object.freeze({
  google:Object.freeze({
    name:"Google",issuers:["https://accounts.google.com","accounts.google.com"],
    authorizeUrl:"https://accounts.google.com/o/oauth2/v2/auth",tokenUrl:"https://oauth2.googleapis.com/token",
    jwksUrl:"https://www.googleapis.com/oauth2/v3/certs",userinfoUrl:"",revokeUrl:"",
    scope:"openid email profile",responseMode:"query",pkce:true,nonceRequired:true
  }),
  apple:Object.freeze({
    name:"Apple",issuers:["https://appleid.apple.com"],
    authorizeUrl:"https://appleid.apple.com/auth/authorize",tokenUrl:"https://appleid.apple.com/auth/token",
    jwksUrl:"https://appleid.apple.com/auth/keys",userinfoUrl:"",revokeUrl:"https://appleid.apple.com/auth/revoke",
    scope:"name email",responseMode:"form_post",pkce:false,nonceRequired:true
  }),
  samsung:Object.freeze({
    name:"Samsung",issuers:["https://account.samsung.com/iam"],
    authorizeUrl:"https://account.samsung.com/iam/oidc/authorize",tokenUrl:"https://api.account.samsung.com/auth/oidc/token",
    jwksUrl:"https://account.samsung.com/.well-known/jwks",userinfoUrl:"https://api.account.samsung.com/v2/profile/user/oidc/userinfo",revokeUrl:"",
    scope:"openid email profile",responseMode:"query",pkce:false,nonceRequired:false
  })
});
const LOCAL_HTTP=/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const APPLE_ID=/^[A-Z0-9]{10}$/;

/** @param {string|undefined} value */
function clean(value){return String(value??"").trim();}

/**
 * The Apple .p8 key as an ES256 signing key, or null. Hosts often store it on one line with literal \n.
 * @param {string} value
 */
function applePrivateKey(value){
  if(!value)return null;
  try{
    const key=createPrivateKey(value.replace(/\\n/g,"\n"));
    return key.asymmetricKeyType==="ec"&&key.asymmetricKeyDetails?.namedCurve==="prime256v1"?key:null;
  }catch{return null;}
}

/**
 * Reads the sign-in provider settings. Outside production, SIGN_IN_PROVIDER_STAND_IN may name a loopback server
 * that answers for all three providers, so tests can sign in without reaching Google, Apple, or Samsung.
 * @param {Record<string,string|undefined>} env
 */
function socialAuthSettings(env){
  const production=env.NODE_ENV==="production";
  const standIn=production?"":clean(env.SIGN_IN_PROVIDER_STAND_IN).replace(/\/+$/,"");
  const base=clean(env.APP_BASE_URL).replace(/\/+$/,"");
  const redirectBase=/^https:\/\/[^\s/]+$/i.test(base)||!production&&LOCAL_HTTP.test(base)?base:"";
  const keys=[tokenKey(clean(env.SIGN_IN_TOKEN_KEY)),tokenKey(clean(env.SIGN_IN_TOKEN_KEY_PREVIOUS))]
    .filter((key)=>key!==null).map((key)=>({id:keyId(key),key}));
  const sealingKey=tokenKey(clean(env.SIGN_IN_TOKEN_KEY));
  const appleKey=applePrivateKey(clean(env.APPLE_SIGN_IN_PRIVATE_KEY));
  const apple={teamId:clean(env.APPLE_SIGN_IN_TEAM_ID),keyId:clean(env.APPLE_SIGN_IN_KEY_ID),privateKey:appleKey};
  const credentials={
    google:{clientId:clean(env.GOOGLE_SIGN_IN_CLIENT_ID),clientSecret:clean(env.GOOGLE_SIGN_IN_CLIENT_SECRET)},
    apple:{clientId:clean(env.APPLE_SIGN_IN_SERVICES_ID),clientSecret:""},
    samsung:{clientId:clean(env.SAMSUNG_SIGN_IN_CLIENT_ID),clientSecret:clean(env.SAMSUNG_SIGN_IN_CLIENT_SECRET)}
  };
  /** @param {SocialProviderId} id */
  function provider(id){
    const defaults=PROVIDER_DEFAULTS[id],{clientId,clientSecret}=credentials[id];
    /** @type {string[]} */
    const problems=[];
    const endpoints=standIn&&LOCAL_HTTP.test(standIn)
      ?{issuers:[`${standIn}/${id}`],authorizeUrl:`${standIn}/${id}/authorize`,tokenUrl:`${standIn}/${id}/token`,jwksUrl:`${standIn}/${id}/jwks`,
        userinfoUrl:defaults.userinfoUrl?`${standIn}/${id}/userinfo`:"",revokeUrl:defaults.revokeUrl?`${standIn}/${id}/revoke`:""}
      :{};
    if(id==="apple"){
      if(!clientId||!apple.teamId||!apple.keyId||!clean(env.APPLE_SIGN_IN_PRIVATE_KEY))problems.push("APPLE_SIGN_IN_SERVICES_ID, APPLE_SIGN_IN_TEAM_ID, APPLE_SIGN_IN_KEY_ID, and APPLE_SIGN_IN_PRIVATE_KEY are required.");
      else if(!APPLE_ID.test(apple.teamId)||!APPLE_ID.test(apple.keyId))problems.push("APPLE_SIGN_IN_TEAM_ID and APPLE_SIGN_IN_KEY_ID are 10-character Apple identifiers.");
      else if(!appleKey)problems.push("APPLE_SIGN_IN_PRIVATE_KEY must be the Sign in with Apple .p8 key (an EC P-256 private key).");
      if(!sealingKey)problems.push("SIGN_IN_TOKEN_KEY must be 32 random bytes written as base64 so Apple tokens can be revoked when an account is deleted.");
    }else if(!clientId||!clientSecret){
      const prefix=id.toUpperCase();
      problems.push(`${prefix}_SIGN_IN_CLIENT_ID and ${prefix}_SIGN_IN_CLIENT_SECRET are required.`);
    }
    if(production&&!redirectBase)problems.push("APP_BASE_URL must be an https address in production.");
    return Object.freeze({id,...defaults,...endpoints,clientId,clientSecret,configured:problems.length===0,problems:Object.freeze(problems)});
  }
  const providers=Object.freeze({google:provider("google"),apple:provider("apple"),samsung:provider("samsung")});
  return Object.freeze({
    providers,
    enabled:Object.freeze(SOCIAL_PROVIDER_IDS.filter((id)=>providers[id].configured)),
    apple:Object.freeze(apple),keys,redirectBase,
    secureCookies:production||env.SECURE_COOKIES==="true"
  });
}

module.exports={PROVIDER_DEFAULTS,SOCIAL_PROVIDER_IDS,socialAuthSettings};
