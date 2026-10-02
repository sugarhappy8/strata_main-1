// @ts-check
"use strict";

// Sign up or sign in with Google, Apple, or Samsung (OpenID Connect, authorization-code flow).
//
// 1. POST /auth/social/start is a same-site form. It records a ten-minute state, binds it to this browser with a
//    SameSite=Lax cookie, and sends the member to the provider.
// 2. The provider returns to /auth/social/<provider>/callback. Apple returns with a cross-site form POST, which
//    carries no SameSite cookie, so every callback only parks the one-time code on its state and moves on.
// 3. GET /auth/social/finish is a top-level navigation, so the Lax cookie arrives. It checks that cookie, exchanges
//    the code, verifies the ID token, then signs in, links, or creates the STRATA account.
// 4. Session cookies are SameSite=Strict, and a navigation that began on the provider's site does not carry them.
//    Finish therefore answers with a short page that moves on by itself; that navigation starts on STRATA.
//
// A provider account is linked to an existing STRATA account only when both sides have verified the same email.

const {randomUUID}=require("node:crypto");
const {open,randomId,seal,sha256}=require("./devices-crypto");
const {cleanText}=require("./plans");
const {SOCIAL_PROVIDER_IDS}=require("./social-auth-config");
const {createSocialAuthClient}=require("./social-auth-client");
const {SOCIAL_MESSAGES}=require("./social-auth-messages");

const STATE_TTL_MS=10*60*1000;
const REVOCATION_RETENTION_MS=7*24*60*60*1000;
const BROWSER_COOKIE="strata_social";
const BROWSER_COOKIE_PATH="/auth/social/finish";
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const CALLBACK=/^\/auth\/social\/(google|apple|samsung)\/callback$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CANCELED_ERRORS=new Set(["access_denied","user_cancelled_authorize","user_cancelled","consent_required"]);
const FALLBACK_NAME="STRATA member";


/** @param {string} message */
function signInError(message){return Object.assign(new Error(message),{status:400,signIn:true});}
/** @param {unknown} value */
const text=(value)=>typeof value==="string"?value:"";
/** @param {unknown} value */
const verified=(value)=>value===true||value==="true";
/** @param {unknown} value */
function displayName(value){const name=cleanText(text(value).replace(/[\u0000-\u001f\u007f<>]/g," ").replace(/\s+/g," "),40);return name.length>=2?name:"";}
/** Apple sends the member's name once, as JSON in the `user` field of its first callback. @param {unknown} value */
function appleName(value){
  try{
    const name=JSON.parse(text(value))?.name;
    return displayName([text(name?.firstName),text(name?.lastName)].filter(Boolean).join(" "))||null;
  }catch{return null;}
}
/** @param {string} value */
function escapeHtml(value){return value.replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]||char);}

/**
 * @param {import("./domain-types").SocialAuthServiceDependencies} dependencies
 * @returns {import("./domain-types").SocialAuthService}
 */
function createSocialAuthService({store,settings,getAuth,claimAdminForLogin=async(user)=>user,trustedAuthOrigin,rateAllowed,http,isUniqueViolation=()=>false,client=null,fetchImpl,logger=null,now=Date.now}){
  if(!store||!settings||typeof getAuth!=="function"||typeof trustedAuthOrigin!=="function"||typeof rateAllowed!=="function"||!http)throw new TypeError("Social sign-in requires storage, settings, the auth service, request guards, and HTTP helpers.");
  const {bodyForm,redirect,securityHeaders}=http;
  const provider=client||createSocialAuthClient({settings,now,...(fetchImpl?{fetchImpl}:{})});
  /** @returns {import("./domain-types").AuthService} */
  function auth(){const service=getAuth();if(!service)throw new Error("The auth service is not ready.");return service;}

  /** @param {string} value @param {number} maxAge */
  function browserCookie(value,maxAge){
    const parts=[`${BROWSER_COOKIE}=${encodeURIComponent(value)}`,`Path=${BROWSER_COOKIE_PATH}`,"HttpOnly","SameSite=Lax",`Max-Age=${maxAge}`];
    if(settings.secureCookies)parts.push("Secure");
    return parts.join("; ");
  }
  /** @param {import("./domain-types").HttpRequest} req */
  function browserToken(req){
    for(const part of String(req.headers.cookie||"").split(";")){
      const index=part.indexOf("=");
      if(index>0&&part.slice(0,index).trim()===BROWSER_COOKIE){try{return decodeURIComponent(part.slice(index+1).trim());}catch{return "";}}
    }
    return "";
  }
  /** Outside production the address may follow the request host, so a local server needs no extra settings. @param {import("./domain-types").HttpRequest} req @param {string} id */
  function redirectUriFor(req,id){
    if(settings.redirectBase)return `${settings.redirectBase}/auth/social/${id}/callback`;
    const protocol=String(req.headers["x-forwarded-proto"]||"http").split(",")[0]?.trim()||"http";
    return `${protocol}://${req.headers.host}/auth/social/${id}/callback`;
  }
  /** @param {import("./domain-types").HttpResponse} res @param {string} intent @param {string} message @param {string} next @param {Record<string,string|string[]>} [headers] */
  function backToAccount(res,intent,message,next,headers={}){redirect(res,auth().accountErrorLocation(intent==="login"?"login":"signup",message,next),headers);}
  /** @param {import("./domain-types").HttpResponse} res @param {string} method */
  function notAllowed(res,method){res.writeHead(405,{...securityHeaders(),Allow:method,"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});res.end("Method not allowed.");}

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function start(req,res){
    if(req.method!=="POST"){notAllowed(res,"POST");return;}
    const input=await bodyForm(req),intent=input.intent==="login"?"login":"signup";
    const fail=(/** @type {string} */ message)=>backToAccount(res,intent,message,text(input.next));
    if(!trustedAuthOrigin(req)){fail(SOCIAL_MESSAGES.origin);return;}
    const id=SOCIAL_PROVIDER_IDS.find((candidate)=>candidate===input.provider);
    if(!id||!settings.providers[id].configured){fail(SOCIAL_MESSAGES.unavailable);return;}
    if(!rateAllowed(req,"social-sign-in-start",30)){fail(SOCIAL_MESSAGES.rate);return;}
    const state=randomId(32),browser=randomId(32),nonce=randomId(32),codeVerifier=randomId(48),time=now(),redirectUri=redirectUriFor(req,id);
    await store.insertSocialSignInState({stateHash:sha256(state),provider:id,browserHash:sha256(browser),nonce,codeVerifier,intent,nextPath:auth().safeAccountNext(input.next),redirectUri,createdAt:time,expiresAt:time+STATE_TTL_MS});
    redirect(res,provider.authorizeUrl(id,{state,nonce,codeVerifier,redirectUri}),{"Set-Cookie":browserCookie(browser,STATE_TTL_MS/1000)});
  }

  /** The provider sends the member back here. No STRATA cookie can be trusted to arrive, so nothing signs in yet. @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url @param {import("./domain-types").SocialProviderId} id */
  async function callback(req,res,url,id){
    const expected=settings.providers[id].responseMode==="form_post"?"POST":"GET";
    if(req.method!==expected){notAllowed(res,expected);return;}
    const input=expected==="POST"?await bodyForm(req):Object.fromEntries(url.searchParams);
    const state=text(input.state),code=text(input.code),problem=text(input.error),issuer=text(input.iss);
    if(!TOKEN.test(state)||!rateAllowed(req,"social-sign-in-callback",60)){backToAccount(res,"login",SOCIAL_MESSAGES.expired,"");return;}
    const usable=!problem&&code&&code.length<=2048&&/^[\x21-\x7e]+$/.test(code)&&(!issuer||settings.providers[id].issuers.includes(issuer));
    if(!usable){
      const discarded=await store.discardSocialSignInState(sha256(state));
      backToAccount(res,text(discarded?.intent),CANCELED_ERRORS.has(problem)?SOCIAL_MESSAGES.canceled:SOCIAL_MESSAGES.failed,text(discarded?.next_path));
      return;
    }
    const recorded=await store.recordSocialSignInReturn(sha256(state),id,code,id==="apple"?appleName(input.user):null,now());
    if(!recorded){backToAccount(res,"login",SOCIAL_MESSAGES.expired,"");return;}
    redirect(res,`/auth/social/finish?${new URLSearchParams({state})}`);
  }

  /** What the provider vouches for: the stable subject, the email address and whether it verified it, and a name. @param {import("./domain-types").SocialProviderId} id @param {any} pending */
  async function readProfile(id,pending){
    const tokens=await provider.exchangeCode(id,{code:text(pending.code),redirectUri:text(pending.redirect_uri),codeVerifier:text(pending.code_verifier)});
    const claims=await provider.verifyIdToken(id,tokens.idToken,{nonce:text(pending.nonce)});
    let email=text(claims.email).trim().toLowerCase(),emailVerified=verified(claims.email_verified);
    let name=displayName(claims.name)||displayName(`${text(claims.given_name)} ${text(claims.family_name)}`);
    // Samsung may keep the email address and profile in userinfo rather than the ID token.
    if(id==="samsung"&&(!email||!emailVerified||!name)){
      const info=await provider.userinfo(id,tokens.accessToken);
      if(info.sub===claims.sub){
        const infoEmail=text(info.email).trim().toLowerCase();
        if(!email)email=infoEmail;
        if(!emailVerified&&infoEmail===email)emailVerified=verified(info.email_verified);
        name=name||displayName(info.name)||displayName(`${text(info.given_name)} ${text(info.family_name)}`)||displayName(info.nickname);
      }
    }
    return {subject:String(claims.sub),email:EMAIL.test(email)&&email.length<=254?email:"",emailVerified,name:name||displayName(pending.profile_name)||FALLBACK_NAME,
      refreshToken:id==="apple"?tokens.refreshToken:""};
  }

  /** Signs in the linked account, links a verified account with the same email, or creates one. @param {import("./domain-types").SocialProviderId} id @param {Awaited<ReturnType<typeof readProfile>>} profile */
  async function resolveAccount(id,profile){
    const time=now(),tokenSealed=profile.refreshToken?seal(settings.keys,profile.refreshToken):null;
    const known=await store.accountIdentity(id,profile.subject);
    if(known){
      if(known.suspended_at)throw signInError(SOCIAL_MESSAGES.paused);
      await store.touchAccountIdentity({provider:id,subject:profile.subject,userId:String(known.id),email:profile.email||String(known.identity_email),tokenSealed,at:time});
      return {user:known,outcome:"signed_in"};
    }
    if(!profile.email||!profile.emailVerified)throw signInError(SOCIAL_MESSAGES.noEmail);
    const existing=await store.userByEmail(profile.email);
    if(existing){
      if(existing.suspended_at)throw signInError(SOCIAL_MESSAGES.paused);
      if(!Number(existing.email_verified_at))throw signInError(SOCIAL_MESSAGES.unverified);
      const identity={provider:id,subject:profile.subject,userId:String(existing.id),email:profile.email,tokenSealed,at:time};
      if(!await store.linkAccountIdentity(identity)&&(await store.accountIdentity(id,profile.subject))?.id!==existing.id)throw signInError(SOCIAL_MESSAGES.otherLinked);
      return {user:existing,outcome:"linked"};
    }
    const userId=randomUUID();
    try{
      const user=await store.createSocialAccount({id:userId,name:profile.name,email:profile.email,createdAt:time},{provider:id,subject:profile.subject,userId,email:profile.email,tokenSealed,at:time});
      if(!user)throw new Error("The new account was not created.");
      return {user,outcome:"created"};
    }catch(error){
      // Another request created the same email or sign-in a moment ago; signing in again finds it.
      if(isUniqueViolation(error))throw signInError(SOCIAL_MESSAGES.failed);
      throw error;
    }
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
  async function finish(req,res,url){
    if(req.method!=="GET"){notAllowed(res,"GET");return;}
    const clear=browserCookie("",0),state=text(url.searchParams.get("state")),browser=browserToken(req);
    if(!TOKEN.test(state)||!TOKEN.test(browser)||!rateAllowed(req,"social-sign-in-finish",30)){backToAccount(res,"login",SOCIAL_MESSAGES.expired,"",{"Set-Cookie":clear});return;}
    const pending=await store.consumeSocialSignInState(sha256(state),sha256(browser),now());
    if(!pending){backToAccount(res,"login",SOCIAL_MESSAGES.expired,"",{"Set-Cookie":clear});return;}
    const id=/** @type {import("./domain-types").SocialProviderId} */(text(pending.provider)),intent=text(pending.intent),next=auth().safeAccountNext(pending.next_path);
    const fail=(/** @type {string} */ message)=>backToAccount(res,intent,message,next,{"Set-Cookie":clear});
    let resolved;
    try{resolved=await resolveAccount(id,await readProfile(id,pending));}
    catch(error){
      const failure=/** @type {any} */(error);
      if(failure?.signIn){fail(failure.message);return;}
      if(!String(failure?.code||"").startsWith("SOCIAL_"))throw error;
      logger?.warn?.("auth.social_sign_in_failed",{provider:id,code:failure.code});
      fail(failure.code==="SOCIAL_NOT_CONFIGURED"?SOCIAL_MESSAGES.unavailable:SOCIAL_MESSAGES.failed);return;
    }
    const user=await claimAdminForLogin(resolved.user);
    const session=auth().prepareSession(String(user.id),now(),Number(user.auth_version)||1);
    if(!await store.insertSession(session.record)){fail(SOCIAL_MESSAGES.failed);return;}
    logger?.info?.("auth.social_sign_in",{provider:id,outcome:resolved.outcome});
    const location=escapeHtml(next);
    const page=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${location}"><title>Signing in — STRATA</title></head><body style="font-family:system-ui,sans-serif;background:#10110f;color:#f2f3eb;display:grid;place-items:center;min-height:100vh;margin:0"><main><p>You’re signed in. <a href="${location}" style="color:#d4f578">Continue</a></p></main></body></html>`;
    res.writeHead(200,{...securityHeaders(),"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","Set-Cookie":[auth().sessionCookie(session.token),clear]});
    res.end(page);
  }

  /** Revokes queued Sign in with Apple tokens of deleted accounts. @returns {Promise<number>} */
  async function revokeQueued(){
    if(!settings.providers.apple.configured)return 0;
    let revoked=0;
    for(const row of await store.pendingSignInRevocations(25)){
      try{await provider.revoke(row.provider,open(settings.keys,String(row.token_sealed)));await store.completeSignInRevocation(Number(row.id));revoked+=1;}
      catch(error){
        const code=String(/** @type {any} */(error)?.code||"");
        // A token sealed with a key that is gone can never be revoked; the member can still remove STRATA from their Apple Account.
        if(code==="DEVICE_KEY_MISSING"||code==="DEVICE_TOKEN_UNREADABLE")await store.completeSignInRevocation(Number(row.id));
        else await store.retrySignInRevocation(Number(row.id));
        logger?.warn?.("auth.social_revocation_failed",{provider:String(row.provider),code:code||"SOCIAL_REVOKE_FAILED"});
      }
    }
    return revoked;
  }

  return Object.freeze({
    /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res @param {URL} url */
    async handle(req,res,url){
      if(url.pathname==="/auth/social/start"){await start(req,res);return true;}
      if(url.pathname==="/auth/social/finish"){await finish(req,res,url);return true;}
      const match=url.pathname.match(CALLBACK);
      if(match){await callback(req,res,url,/** @type {import("./domain-types").SocialProviderId} */(match[1]));return true;}
      return false;
    },
    /** Shows the buttons of configured providers on the account page. @param {string} html */
    renderAccountPage(html){
      if(!settings.enabled.length)return html;
      let output=html.replace(/(data-social-options)\s+hidden/g,"$1");
      for(const id of settings.enabled)output=output.replace(new RegExp(`(data-social="${id}")\\s+hidden`,"g"),"$1");
      return output;
    },
    enabledProviders:()=>[...settings.enabled],
    async cleanup(time=now()){
      await store.deleteExpiredSocialSignInData(time,time-REVOCATION_RETENTION_MS);
      return revokeQueued();
    }
  });
}

module.exports={createSocialAuthService};
