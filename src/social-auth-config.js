// @ts-check
"use strict";

// Sign in with Google. The button appears only when the client ID and secret are both set, so a half-configured
// provider never sends a member to a sign-in page that cannot finish.

/** @typedef {"google"} SocialProviderId */

const SOCIAL_PROVIDER_IDS=/** @type {readonly SocialProviderId[]} */(Object.freeze(["google"]));
// Google's published OpenID Connect endpoints (https://accounts.google.com/.well-known/openid-configuration).
const PROVIDER_DEFAULTS=Object.freeze({
  google:Object.freeze({
    name:"Google",issuers:["https://accounts.google.com","accounts.google.com"],
    authorizeUrl:"https://accounts.google.com/o/oauth2/v2/auth",tokenUrl:"https://oauth2.googleapis.com/token",
    jwksUrl:"https://www.googleapis.com/oauth2/v3/certs",scope:"openid email profile"
  })
});
const LOCAL_HTTP=/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;

/** @param {string|undefined} value */
function clean(value){return String(value??"").trim();}

/**
 * Reads the sign-in provider settings. Outside production, SIGN_IN_PROVIDER_STAND_IN may name a loopback server
 * that answers for Google, so tests can sign in without reaching Google.
 * @param {Record<string,string|undefined>} env
 */
function socialAuthSettings(env){
  const production=env.NODE_ENV==="production";
  const standIn=production?"":clean(env.SIGN_IN_PROVIDER_STAND_IN).replace(/\/+$/,"");
  const base=clean(env.APP_BASE_URL).replace(/\/+$/,"");
  const redirectBase=/^https:\/\/[^\s/]+$/i.test(base)||!production&&LOCAL_HTTP.test(base)?base:"";
  const credentials={google:{clientId:clean(env.GOOGLE_SIGN_IN_CLIENT_ID),clientSecret:clean(env.GOOGLE_SIGN_IN_CLIENT_SECRET)}};
  /** @param {SocialProviderId} id */
  function provider(id){
    const defaults=PROVIDER_DEFAULTS[id],{clientId,clientSecret}=credentials[id];
    /** @type {string[]} */
    const problems=[];
    const endpoints=standIn&&LOCAL_HTTP.test(standIn)
      ?{issuers:[`${standIn}/${id}`],authorizeUrl:`${standIn}/${id}/authorize`,tokenUrl:`${standIn}/${id}/token`,jwksUrl:`${standIn}/${id}/jwks`}
      :{};
    if(!clientId||!clientSecret){
      const prefix=id.toUpperCase();
      problems.push(`${prefix}_SIGN_IN_CLIENT_ID and ${prefix}_SIGN_IN_CLIENT_SECRET are required.`);
    }
    if(production&&!redirectBase)problems.push("APP_BASE_URL must be an https address in production.");
    return Object.freeze({id,...defaults,...endpoints,clientId,clientSecret,configured:problems.length===0,problems:Object.freeze(problems)});
  }
  const providers=Object.freeze({google:provider("google")});
  return Object.freeze({
    providers,
    enabled:Object.freeze(SOCIAL_PROVIDER_IDS.filter((id)=>providers[id].configured)),
    redirectBase,
    secureCookies:production||env.SECURE_COOKIES==="true"
  });
}

module.exports={PROVIDER_DEFAULTS,SOCIAL_PROVIDER_IDS,socialAuthSettings};
