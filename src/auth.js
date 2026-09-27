"use strict";

const {promisify}=require("node:util");
const {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual}=require("node:crypto");
const {
  verificationCodeDigest,
  safeDigestEqual,
  generateVerificationCode,
  maskEmail,
  verificationEmailHash,
  sendAccountActionEmail,
  sendVerificationEmail,
  directSignupAllowed
}=require("./email");
const {cleanText}=require("./plans");
const {createAccountSelfService}=require("./account-self-service");

const scryptAsync=promisify(scrypt);
const SESSION_SECONDS=60*60*24*7;
const SESSION_COOKIE="strata_session";
const SIGNUP_COOKIE="strata_signup";
const VERIFICATION_CODE_MS=10*60*1000;
const VERIFICATION_HARD_MS=30*60*1000;
const VERIFICATION_COOKIE_SECONDS=VERIFICATION_HARD_MS/1000;
const VERIFICATION_RESEND_MS=60*1000;
const VERIFICATION_MAX_ATTEMPTS=5;
const VERIFICATION_MAX_SENDS=4;
const VERIFICATION_EMAIL_SENDS_PER_HOUR=5;
const VERIFICATION_SEND_WINDOW_MS=60*60*1000;
const VERIFICATION_RETENTION_MS=24*60*60*1000;
const ACCOUNT_ACTION_MS=30*60*1000;
const ACCOUNT_ACTION_EMAILS_PER_HOUR=5;
const ACCOUNT_ACTION_SEND_WINDOW_MS=60*60*1000;
const ACCOUNT_ACTION_RETENTION_MS=24*60*60*1000;
const PASSWORD_RESET_RESPONSE="If an account uses that email, a password-reset link has been sent. Check the inbox and spam folder.";

const API_ROUTES=new Set([
  "/api/signup","/api/login","/api/verification-status","/api/verify-email","/api/resend-verification",
  "/api/password-reset/request","/api/account/password-reset/request","/api/password-reset/status","/api/password-reset/complete",
  "/api/account/delete/request","/api/account/delete/cancel","/api/account/delete/status","/api/account/delete/complete",
  "/api/account/sessions","/api/account/sessions/revoke","/api/account/sessions/revoke-others","/api/account/export",
  "/api/me","/api/logout"
]);

function normalizeEmail(value){return cleanText(value,254).toLowerCase();}
function validEmail(email){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);}
function configuredAdminEmail(value){
  const email=normalizeEmail(value);
  if(!email||email!==String(value||"").trim().toLowerCase()||!validEmail(email)||email.includes(",")||/<[^>]+>|replace|example\.(?:com|org|net)$/i.test(email))return "";
  return email;
}
function hashToken(token){return createHash("sha256").update(token).digest("hex");}
function escapeHtml(value){return String(value??"").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));}

/**
 * Typed dependency-injection boundary for the account and session domain.
 * @param {import("./domain-types").AuthServiceDependencies} dependencies
 * @returns {import("./domain-types").AuthService}
 */
function createAuthService({
  store,
  emailConfig,
  environment=process.env,
  exerciseIds=new Set(),
  isUniqueViolation=()=>false,
  trustedAuthOrigin,
  rateAllowed,
  http,
  getUserPayload,
  claimAdminForLogin=async(user)=>user,
  reconcileCheckoutCreationBeforeDeletion=async()=>0,
  reconcileUnsettledPurchases=async()=>0,
  logger=console
}){
  if(!store||!emailConfig||typeof trustedAuthOrigin!=="function"||typeof rateAllowed!=="function"||!http||typeof getUserPayload!=="function"){
    throw new TypeError("Auth service requires store, email configuration, request guards, HTTP helpers, and a user-payload resolver.");
  }
  const {json,bodyJson,bodyForm,redirect,securityHeaders}=http;

  function accountRateAllowed(req,input) {
    return rateAllowed(req,"auth-network",400)&&
      rateAllowed(req,`identity:auth:${hashToken(normalizeEmail(input.email))}`,10);
  }
  function verificationRateAllowed(req,kind) {
    const token=cookieMap(req.headers.cookie||"")[SIGNUP_COOKIE]||"missing";
    const maximum=kind==="verify-email"?12:6;
    return rateAllowed(req,`${kind}-network`,kind==="verify-email"?600:300)&&
      rateAllowed(req,`identity:${kind}:${hashToken(token)}`,maximum);
  }

  async function passwordHash(password,salt){
    const key=await scryptAsync(password,Buffer.from(salt,"base64"),64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
    return Buffer.from(key).toString("base64");
  }

  async function passwordMatches(password,user){
    const actual=Buffer.from(await passwordHash(password,user.password_salt),"base64");
    const expected=Buffer.from(user.password_hash,"base64");
    return actual.length===expected.length&&timingSafeEqual(actual,expected);
  }

  function accountStorageUnavailable(error){
    logger.error("Account storage request failed:",error);
    return Object.assign(new Error("Account storage is temporarily unavailable. Please try again."),{status:503,cause:error});
  }

  function authAudit(event,{purpose="",email=""}={}){
    const entry={event:String(event),at:new Date().toISOString()};
    if(["signup","login","password_reset","account_delete"].includes(purpose))entry.purpose=purpose;
    if(email)entry.email=maskEmail(email);
    logger.info(`Auth audit ${JSON.stringify(entry)}`);
  }

  function cookieMap(header=""){
    const cookies=Object.create(null);
    for(const part of String(header||"").split(";")){
      const trimmed=part.trim(),separator=trimmed.indexOf("=");
      if(separator<1)continue;
      try{
        const key=decodeURIComponent(trimmed.slice(0,separator));
        const value=decodeURIComponent(trimmed.slice(separator+1));
        if(key)cookies[key]=value;
      }catch{/* Ignore a malformed pair without invalidating other cookies. */}
    }
    return cookies;
  }

  async function sessionFor(req){
    const token=cookieMap(req.headers.cookie)[SESSION_COOKIE];
    if(!token||token.length>200)return null;
    const session=await store.session(hashToken(token),Date.now())||null;
    // Once verification is requested, a provider misconfiguration must fail closed.
    if(session&&emailConfig.requestedEnabled&&!Number(session.email_verified_at))return null;
    return session;
  }

  function secureCookie(name,token,maxAge){
    const parts=[`${name}=${encodeURIComponent(token)}`,"Path=/","HttpOnly","SameSite=Strict",`Max-Age=${maxAge}`];
    if(environment.NODE_ENV==="production"||environment.SECURE_COOKIES==="true")parts.push("Secure");
    return parts.join("; ");
  }
  function sessionCookie(token,maxAge=SESSION_SECONDS){return secureCookie(SESSION_COOKIE,token,maxAge);}
  function signupCookie(token,maxAge=VERIFICATION_COOKIE_SECONDS){return secureCookie(SIGNUP_COOKIE,token,maxAge);}
  function signupTokenFor(req){
    const token=cookieMap(req.headers.cookie)[SIGNUP_COOKIE];
    return token&&token.length<=200?token:null;
  }

  function prepareSession(userId,now=Date.now(),authVersion=1){
    const token=randomBytes(32).toString("base64url");
    const csrfToken=randomBytes(24).toString("base64url");
    return {token,csrfToken,record:{tokenHash:hashToken(token),userId,csrfToken,expiresAt:now+SESSION_SECONDS*1000,createdAt:now,authVersion:Number(authVersion)||1}};
  }

  async function createSession(userId,authVersion=1){
    const session=prepareSession(userId,Date.now(),authVersion);
    if(!await store.insertSession(session.record)){
      throw Object.assign(new Error("Your credentials changed while signing in. Please try again."),{status:409,code:"AUTHENTICATION_RETRY"});
    }
    return {token:session.token,csrfToken:session.csrfToken};
  }

  async function requireSession(req,res){
    const session=await sessionFor(req);
    if(!session){json(res,401,{error:"Sign in required."});return null;}
    return session;
  }

  function safeTokenEqual(actual,expected){
    const left=Buffer.from(String(actual||""));
    const right=Buffer.from(String(expected||""));
    return left.length===right.length&&left.length>0&&timingSafeEqual(left,right);
  }
  function validCsrf(req,session){
    const expectedUser=req.headers["x-strata-user"];
    return (expectedUser===undefined||expectedUser===String(session?.id))&&safeTokenEqual(req.headers["x-csrf-token"],session?.csrf_token);
  }
  const accountSelfService=createAccountSelfService({store,http:{json,bodyJson,securityHeaders},requireSession,validCsrf,rateAllowed,logger});

  function validateRegistration(input){
    const name=cleanText(input.name,40),email=normalizeEmail(input.email),password=String(input.password||"");
    if(name.length<2||!validEmail(email)||password.length<10||password.length>128){
      throw Object.assign(new Error("Use a valid name, email, and password of 10–128 characters."),{status:400});
    }
    return {name,email,password};
  }

  async function registerAccountDirect(input){
    const {name,email,password}=validateRegistration(input);
    try{
      if(await store.userByEmail(email))throw Object.assign(new Error("An account with that email already exists."),{status:409});
      const id=randomUUID(),salt=randomBytes(16).toString("base64"),hash=await passwordHash(password,salt),now=Date.now();
      try{await store.insertUser({id,name,email,passwordHash:hash,passwordSalt:salt,createdAt:now});}
      catch(error){if(isUniqueViolation(error))throw Object.assign(new Error("An account with that email already exists."),{status:409});throw error;}
      const session=await createSession(id,1),user=await store.userById(id);
      return {session,user};
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  function verificationPublic(row,now=Date.now()){
    const deliveryState=row.delivery_state==="sent"?"sent":row.delivery_state==="failed"?"failed":"pending";
    return {
      verificationRequired:true,
      purpose:row.purpose==="login"?"login":"signup",
      maskedEmail:maskEmail(row.email),
      expiresAt:Number(row.expires_at),
      resendAfter:Math.max(now,Number(row.last_sent_at)+VERIFICATION_RESEND_MS),
      attemptsRemaining:Math.max(0,VERIFICATION_MAX_ATTEMPTS-Number(row.attempts_used||0)),
      deliveryState
    };
  }
  function verificationError(message,status,code,extra={}){return Object.assign(new Error(message),{status,code,...extra});}
  function ensureVerificationDeliveryConfigured(){
    if(!emailConfig.enabled)throw verificationError("Email verification is temporarily unavailable. Please try again later.",503,"EMAIL_VERIFICATION_UNAVAILABLE");
  }

  async function claimVerificationSendSlot({email,challengeId,generation,sentAt}){
    const now=Date.now();
    const send={id:randomUUID(),emailHash:verificationEmailHash(emailConfig,email),challengeId,generation:Number(generation),sentAt:Number(sentAt)};
    const claimed=await store.claimVerificationSend(send,now-VERIFICATION_SEND_WINDOW_MS,VERIFICATION_EMAIL_SENDS_PER_HOUR);
    return {claimed,send};
  }
  function verificationEmailLimit(){
    return verificationError("Too many verification emails were requested. Please wait and try again.",429,"VERIFICATION_EMAIL_LIMIT",{retryAfter:3600});
  }

  async function deliverVerification(row,code){
    const remainingMs=Math.min(Number(row.expires_at),Number(row.hard_expires_at))-Date.now();
    if(remainingMs<=0)throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
    try{
      const delivery=await sendVerificationEmail(emailConfig,{to:row.email,name:row.name,code,challengeId:row.challenge_id,generation:Number(row.generation),purpose:row.purpose==="login"?"login":"signup",expiresInMinutes:Math.max(1,Math.ceil(remainingMs/60000))});
      await store.markVerificationDelivery(row.challenge_id,Number(row.generation),"sent",Date.now());
      return delivery;
    }catch(error){
      await store.markVerificationDelivery(row.challenge_id,Number(row.generation),"failed",Date.now());
      logger.error(`Verification email delivery failed: ${error?.code||"provider-error"}`);
      throw verificationError("The verification email could not be sent. Please wait a moment and resend it.",503,"EMAIL_DELIVERY_UNAVAILABLE");
    }
  }

  async function createVerificationChallenge({purpose,userId,email,name,passwordHash="",passwordSalt=""}){
    const code=generateVerificationCode(),challengeId=randomUUID(),signupToken=randomBytes(32).toString("base64url"),now=Date.now(),generation=1;
    const row={
      challengeId,browserTokenHash:hashToken(signupToken),purpose,userId,email,name,passwordHash,passwordSalt,
      codeDigest:verificationCodeDigest(emailConfig,{challengeId,generation,email,code}),generation,attemptsUsed:0,sendCount:1,lastSentAt:now,
      expiresAt:now+VERIFICATION_CODE_MS,hardExpiresAt:now+VERIFICATION_HARD_MS,deliveryState:"sending",createdAt:now,updatedAt:now
    };
    const reservation=await claimVerificationSendSlot({email:row.email,challengeId,generation,sentAt:now});
    if(!reservation.claimed)throw verificationEmailLimit();
    await store.insertVerification(row);
    const stored=await store.verificationByTokenHash(row.browserTokenHash);
    try{await deliverVerification(stored,code);}
    catch(error){error.signupToken=signupToken;error.verification=verificationPublic(stored);throw error;}
    authAudit("verification_challenge_sent",{purpose,email});
    return {signupToken,verification:verificationPublic(stored)};
  }

  async function beginAccountRegistration(input){
    if(!emailConfig.requestedEnabled){
      if(!directSignupAllowed(emailConfig,environment.NODE_ENV,environment.ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS)){
        throw verificationError("Email verification is temporarily unavailable. Please try again later.",503,"EMAIL_VERIFICATION_UNAVAILABLE");
      }
      authAudit("test_only_unverified_signup",{purpose:"signup",email:normalizeEmail(input?.email)});
      return {verified:true,...await registerAccountDirect(input)};
    }
    ensureVerificationDeliveryConfigured();
    const {name,email,password}=validateRegistration(input);
    try{
      if(await store.userByEmail(email)){
        authAudit("signup_existing_email_rejected",{purpose:"signup",email});
        throw Object.assign(new Error("An account with that email already exists."),{status:409,code:"ACCOUNT_EXISTS"});
      }
      const passwordSalt=randomBytes(16).toString("base64");
      return await createVerificationChallenge({purpose:"signup",userId:randomUUID(),email,name,passwordHash:await passwordHash(password,passwordSalt),passwordSalt});
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  async function verificationForRequest(req){
    const token=signupTokenFor(req);
    if(!token)return null;
    try{return await store.verificationByTokenHash(hashToken(token));}
    catch(error){throw accountStorageUnavailable(error);}
  }
  function usableVerification(row,now=Date.now()){return Boolean(row&&!row.consumed_at&&Number(row.hard_expires_at)>now);}

  async function verifyAccountEmail(req,input){
    const code=String(input.code||"").trim(),row=await verificationForRequest(req),now=Date.now();
    if(!usableVerification(row,now))throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
    if(Number(row.expires_at)<=now)throw verificationError("That verification code expired. Request a new code and try again.",410,"VERIFICATION_CODE_EXPIRED",{verification:verificationPublic(row,now)});
    const attempt=await store.claimVerificationAttempt(row.challenge_id,Number(row.generation),now,VERIFICATION_MAX_ATTEMPTS);
    if(!attempt){
      const current=await verificationForRequest(req),checkedAt=Date.now();
      if(!usableVerification(current,checkedAt))throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
      if(Number(current.generation)!==Number(row.generation))throw verificationError("A newer verification code was sent. Use the most recent code from your email.",409,"VERIFICATION_CODE_REPLACED",{verification:verificationPublic(current,checkedAt)});
      if(Number(current.expires_at)<=checkedAt)throw verificationError("That verification code expired. Request a new code and try again.",410,"VERIFICATION_CODE_EXPIRED",{verification:verificationPublic(current,checkedAt)});
      throw verificationError("That verification code is invalid or expired. Request a new code and try again.",400,"INVALID_VERIFICATION_CODE",{attemptsRemaining:Math.max(0,VERIFICATION_MAX_ATTEMPTS-Number(current.attempts_used||0)),verification:verificationPublic(current,checkedAt)});
    }
    const remaining=Math.max(0,VERIFICATION_MAX_ATTEMPTS-Number(attempt.attempts_used));
    if(!/^[0-9]{6}$/.test(code))throw verificationError("That verification code is invalid or expired. Request a new code and try again.",400,"INVALID_VERIFICATION_CODE",{attemptsRemaining:remaining});
    const actual=verificationCodeDigest(emailConfig,{challengeId:attempt.challenge_id,generation:Number(attempt.generation),email:attempt.email,code});
    if(!safeDigestEqual(actual,attempt.code_digest))throw verificationError("That verification code is invalid or expired. Request a new code and try again.",400,"INVALID_VERIFICATION_CODE",{attemptsRemaining:remaining});
    const purpose=attempt.purpose==="login"?"login":"signup",preparedSession=prepareSession(attempt.user_id,now);
    if(purpose==="login"){
      let user;
      try{user=await store.completeLoginVerification(attempt.challenge_id,Number(attempt.generation),now,preparedSession.record);}
      catch(error){throw accountStorageUnavailable(error);}
      if(!user)throw verificationError("That verification code is invalid or expired. Request a new code and try again.",400,"INVALID_VERIFICATION_CODE");
      authAudit("verification_completed",{purpose,email:attempt.email});
      return {purpose,session:{token:preparedSession.token,csrfToken:preparedSession.csrfToken},user};
    }
    if(await store.userByEmail(attempt.email)){
      await store.consumeVerification(attempt.challenge_id,Number(attempt.generation),now);
      throw verificationError("An account with that email already exists. Sign in instead.",409,"ACCOUNT_EXISTS",{clearSignup:true});
    }
    let user;
    try{user=await store.completeSignup(attempt.challenge_id,Number(attempt.generation),now,preparedSession.record);}
    catch(error){
      if(isUniqueViolation(error)){
        let existing=null;
        try{existing=await store.userByEmail(attempt.email);}
        catch(storageError){throw accountStorageUnavailable(storageError);}
        if(existing)throw verificationError("An account with that email already exists. Sign in instead.",409,"ACCOUNT_EXISTS",{clearSignup:true});
      }
      throw accountStorageUnavailable(error);
    }
    if(!user)throw verificationError("That verification code is invalid or expired. Request a new code and try again.",400,"INVALID_VERIFICATION_CODE");
    authAudit("verification_completed",{purpose,email:attempt.email});
    return {purpose,session:{token:preparedSession.token,csrfToken:preparedSession.csrfToken},user};
  }

  async function resendAccountVerification(req){
    ensureVerificationDeliveryConfigured();
    const row=await verificationForRequest(req),now=Date.now();
    if(!usableVerification(row,now))throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
    const retryMs=Number(row.last_sent_at)+VERIFICATION_RESEND_MS-now;
    if(retryMs>0)throw verificationError("Please wait before requesting another verification code.",429,"VERIFICATION_COOLDOWN",{retryAfter:Math.ceil(retryMs/1000)});
    if(Number(row.send_count)>=VERIFICATION_MAX_SENDS)throw verificationError("This verification request has reached its resend limit. Create the account again to continue.",429,"VERIFICATION_SEND_LIMIT",{clearSignup:true});
    if(Number(row.hard_expires_at)-now<VERIFICATION_RESEND_MS)throw verificationError("This verification request is too close to expiring to send another code. Use the current code or create the account again after it expires.",409,"VERIFICATION_EXPIRING",{verification:verificationPublic(row,now)});
    const code=generateVerificationCode(),nextGeneration=Number(row.generation)+1;
    const reservation=await claimVerificationSendSlot({email:row.email,challengeId:row.challenge_id,generation:nextGeneration,sentAt:now});
    let mayRotate=reservation.claimed;
    if(!mayRotate){
      const current=await verificationForRequest(req),checkedAt=Date.now();
      if(usableVerification(current,checkedAt)){
        const reserved=Number(current.generation)===Number(row.generation)?await store.verificationSendByChallengeGeneration(row.challenge_id,nextGeneration):null;
        if(reserved)mayRotate=true;
        else{
          const sends=await store.countVerificationSends(verificationEmailHash(emailConfig,row.email),checkedAt-VERIFICATION_SEND_WINDOW_MS);
          if(sends>=VERIFICATION_EMAIL_SENDS_PER_HOUR)throw verificationEmailLimit();
          const retryAfter=Math.max(1,Math.ceil((Number(current.last_sent_at)+VERIFICATION_RESEND_MS-checkedAt)/1000));
          throw verificationError("Another verification-code request is already being processed. Please wait before trying again.",429,"VERIFICATION_COOLDOWN",{retryAfter,verification:verificationPublic(current,checkedAt)});
        }
      }
      if(!mayRotate)throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
    }
    const updated=await store.rotateVerification(row.challenge_id,Number(row.generation),{
      codeDigest:verificationCodeDigest(emailConfig,{challengeId:row.challenge_id,generation:nextGeneration,email:row.email,code}),
      lastSentAt:now,expiresAt:Math.min(now+VERIFICATION_CODE_MS,Number(row.hard_expires_at)),deliveryState:"sending",updatedAt:now
    });
    if(!updated){
      const current=await verificationForRequest(req),checkedAt=Date.now();
      if(usableVerification(current,checkedAt)){
        const retryAfter=Math.max(1,Math.ceil((Number(current.last_sent_at)+VERIFICATION_RESEND_MS-checkedAt)/1000));
        throw verificationError("Another verification-code request is already being processed. Please wait before trying again.",429,"VERIFICATION_COOLDOWN",{retryAfter,verification:verificationPublic(current,checkedAt)});
      }
      throw verificationError("Your verification request expired. Create the account again to receive a new code.",410,"VERIFICATION_EXPIRED",{clearSignup:true});
    }
    await deliverVerification(updated,code);
    return verificationPublic(updated);
  }

  async function authenticateAccount(input){
    const email=normalizeEmail(input.email),password=String(input.password||"");
    try{
      const user=await store.userByEmail(email);
      if(!user){await passwordHash(password,Buffer.alloc(16).toString("base64"));throw Object.assign(new Error("Email or password is incorrect."),{status:401});}
      if(!await passwordMatches(password,user))throw Object.assign(new Error("Email or password is incorrect."),{status:401});
      if(user.suspended_at)throw Object.assign(new Error("This account is temporarily paused. Contact STRATA support for help."),{status:403,code:"ACCOUNT_SUSPENDED"});
      if(emailConfig.requestedEnabled&&!Number(user.email_verified_at)){
        ensureVerificationDeliveryConfigured();
        return await createVerificationChallenge({purpose:"login",userId:user.id,email:user.email,name:user.name});
      }
      const currentUser=await claimAdminForLogin(user);
      return {session:await createSession(currentUser.id,currentUser.auth_version),user:currentUser};
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  function ensureAccountEmailConfigured(){
    if(!emailConfig.enabled)throw Object.assign(new Error("Account recovery email is temporarily unavailable. Please try again later."),{status:503,code:"ACCOUNT_EMAIL_UNAVAILABLE"});
  }
  function validAccountActionToken(value){const token=String(value||"").trim();return /^[A-Za-z0-9_-]{43}$/.test(token)?token:"";}
  function accountActionError(message,status,code){return Object.assign(new Error(message),{status,code});}
  function accountEmailHash(email){return emailConfig.secretConfigured?verificationEmailHash(emailConfig,email):"";}

  async function claimAccountActionSend(email,purpose){
    const now=Date.now(),emailHash=verificationEmailHash(emailConfig,email),send={id:randomUUID(),emailHash,purpose,sentAt:now};
    const claimed=await store.claimAccountActionSend(send,now-ACCOUNT_ACTION_SEND_WINDOW_MS,ACCOUNT_ACTION_EMAILS_PER_HOUR);
    return {claimed,emailHash};
  }

  async function createAndDeliverAccountAction(user,purpose){
    const token=randomBytes(32).toString("base64url"),now=Date.now();
    const staged=await store.stageAccountAction({requestId:randomUUID(),userId:user.id,purpose,tokenHash:hashToken(token),expiresAt:now+ACCOUNT_ACTION_MS,createdAt:now});
    if(!staged)throw new Error("Account action could not be staged.");
    try{
      await sendAccountActionEmail(emailConfig,{to:user.email,name:user.name,token,requestId:staged.request_id,purpose,expiresInMinutes:Math.ceil(ACCOUNT_ACTION_MS/60000)});
      const action=await store.activateAccountAction(staged.request_id,staged.token_hash,Date.now());
      if(!action)throw new Error("Delivered account action could not be activated.");
      authAudit("account_action_sent",{purpose,email:user.email});
      return {expiresAt:Number(action.expires_at),maskedEmail:maskEmail(user.email)};
    }catch(error){
      try{await store.discardStagedAccountAction(staged.request_id,staged.token_hash);}
      catch(discardError){logger.error("Staged account-action cleanup failed:",discardError);}
      logger.error(`Account action email delivery failed: ${error?.code||"provider-error"}`);
      throw accountActionError("The account email could not be sent. Please try again in a moment.",503,"ACCOUNT_EMAIL_DELIVERY_UNAVAILABLE");
    }
  }

  async function requestForgotPassword(input){
    ensureAccountEmailConfigured();
    const email=normalizeEmail(input?.email);
    if(!validEmail(email))throw accountActionError("Enter a valid email address.",400,"INVALID_EMAIL");
    try{
      const reservation=await claimAccountActionSend(email,"password_reset");
      if(reservation.claimed){
        const user=await store.userByEmail(email);
        if(user)void createAndDeliverAccountAction(user,"password_reset").catch((error)=>logger.error(`Background password-reset delivery failed: ${error?.code||"provider-error"}`));
      }
      await new Promise((resolve)=>setTimeout(resolve,400));
      authAudit("password_reset_requested",{purpose:"password_reset",email});
      return {ok:true,message:PASSWORD_RESET_RESPONSE};
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  async function requestSignedInAccountAction(session,purpose){
    ensureAccountEmailConfigured();
    try{
      const principal=purpose==="account_delete"?await store.adminPrincipal():null;
      if(principal?.user_id===session.id)throw accountActionError("The primary administrator account cannot be deleted while it owns site management.",409,"ADMIN_ACCOUNT_PROTECTED");
      const reservation=await claimAccountActionSend(session.email,purpose);
      if(!reservation.claimed)throw accountActionError("Too many account emails were requested. Please wait and try again.",429,"ACCOUNT_EMAIL_LIMIT");
      return await createAndDeliverAccountAction(session,purpose);
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  async function inspectAccountAction(input,expectedPurpose){
    const token=validAccountActionToken(input?.token);
    if(!token)return {active:false};
    try{
      const row=await store.accountActionByTokenHash(hashToken(token));
      const active=Boolean(row&&row.purpose===expectedPurpose&&row.delivery_state==="sent"&&row.consumed_at==null&&Number(row.expires_at)>Date.now());
      return active?{active:true,expiresAt:Number(row.expires_at),maskedEmail:maskEmail(row.email)}:{active:false};
    }catch(error){throw accountStorageUnavailable(error);}
  }

  async function resetPassword(input){
    const token=validAccountActionToken(input?.token),password=String(input?.password||""),confirmation=String(input?.confirmation||"");
    if(!token)throw accountActionError("This password-reset link is invalid or expired. Request a new one.",400,"INVALID_RESET_LINK");
    if(password.length<10||password.length>128)throw accountActionError("Use a password of 10–128 characters.",400,"INVALID_PASSWORD");
    if(password!==confirmation)throw accountActionError("The two password entries do not match.",400,"PASSWORD_MISMATCH");
    try{
      const action=await store.accountActionByTokenHash(hashToken(token));
      if(!action||action.purpose!=="password_reset"||action.delivery_state!=="sent"||action.consumed_at!=null||Number(action.expires_at)<=Date.now())throw accountActionError("This password-reset link is invalid or expired. Request a new one.",400,"INVALID_RESET_LINK");
      const salt=randomBytes(16).toString("base64"),hash=await passwordHash(password,salt);
      const user=await store.completePasswordReset(hashToken(token),hash,salt,Date.now());
      if(!user)throw accountActionError("This password-reset link is invalid or expired. Request a new one.",400,"INVALID_RESET_LINK");
      authAudit("password_reset_completed",{purpose:"password_reset",email:user.email});
      return user;
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  async function deleteAccountWithToken(input){
    const token=validAccountActionToken(input?.token);
    if(!token)throw accountActionError("This deletion link is invalid or expired. Request a new one from your account.",400,"INVALID_DELETE_LINK");
    if(String(input?.confirmation||"").trim()!=="DELETE")throw accountActionError("Type DELETE exactly to confirm permanent account deletion.",400,"DELETE_CONFIRMATION_REQUIRED");
    try{
      const action=await store.accountActionByTokenHash(hashToken(token));
      if(!action||action.purpose!=="account_delete"||action.delivery_state!=="sent"||action.consumed_at!=null||Number(action.expires_at)<=Date.now())throw accountActionError("This deletion link is invalid or expired. Request a new one from your account.",400,"INVALID_DELETE_LINK");
      const principal=await store.adminPrincipal();
      if(principal?.user_id===action.user_id)throw accountActionError("The primary administrator account cannot be deleted while it owns site management.",409,"ADMIN_ACCOUNT_PROTECTED");
      if(await reconcileCheckoutCreationBeforeDeletion(action.user_id)>0)throw accountActionError("A Strata+ checkout is still being prepared. Nothing was deleted; please try again later.",409,"CHECKOUT_PREPARING");
      if(await reconcileUnsettledPurchases(action.user_id)>0)throw accountActionError("A Strata+ payment is still being processed. Nothing was deleted; please try again later.",409,"PURCHASE_PENDING");
      const result=await store.deleteAccount(hashToken(token),Date.now(),accountEmailHash(action.email));
      if(result.status==="purchase_pending")throw accountActionError("A Strata+ payment is still being processed. Nothing was deleted; please try again later.",409,"PURCHASE_PENDING");
      if(result.status==="checkout_pending")throw accountActionError("A Strata+ checkout is still being prepared. Nothing was deleted; please try again later.",409,"CHECKOUT_PREPARING");
      if(result.status!=="deleted")throw accountActionError("This deletion link is invalid or expired. Request a new one from your account.",400,"INVALID_DELETE_LINK");
      authAudit("account_deleted",{purpose:"account_delete",email:action.email});
      return result.user;
    }catch(error){
      if(error.status)throw error;
      throw accountStorageUnavailable(error);
    }
  }

  function safeAccountNext(value){
    const next=String(value||"");
    if(next==="admin"||next==="/admin"||next==="/admin.html")return "/admin";
    if(next==="pricing"||next==="/pricing"||next==="/pricing.html")return "/pricing";
    if(next==="discover"||next==="/discover.html")return "/discover.html";
    if(/^\/workout\.html\?day=(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(next))return next;
    if(next==="workout"||next==="/workout.html")return "/workout.html";
    if(next==="onboarding"||next==="/onboarding.html")return "/onboarding.html";
    if(next==="ai"||next==="/ai"||next==="/ai.html")return "/ai";
    if(next==="/planner.html"||next==="/discover.html"||/^\/planner\.html\?add=[a-z0-9-]{2,80}$/.test(next))return next;
    return "/planner.html";
  }
  function accountErrorLocation(mode,message,requestedNext){
    const params=new URLSearchParams({mode,error:message}),next=safeAccountNext(requestedNext);
    if(next.startsWith("/planner.html")){params.set("next","planner");const add=new URL(next,"http://strata.local").searchParams.get("add");if(add)params.set("add",add);}
    else if(next==="/pricing")params.set("next","pricing");
    else if(next==="/discover.html")params.set("next","discover");
    else if(next==="/admin")params.set("next","admin");
    else if(next.startsWith("/workout.html"))params.set("next",next==="/workout.html"?"workout":next);
    else if(next==="/onboarding.html")params.set("next","onboarding");
    else if(next==="/ai")params.set("next","ai");
    return `/account.html?${params}`;
  }
  function verificationLocation(requestedNext,{error="",sent=false,purpose=""}={}){
    const params=new URLSearchParams(),next=safeAccountNext(requestedNext);
    if(next.startsWith("/planner.html")){params.set("next","planner");const add=new URL(next,"http://strata.local").searchParams.get("add");if(add)params.set("add",add);}
    else if(next==="/pricing")params.set("next","pricing");
    else if(next==="/discover.html")params.set("next","discover");
    else if(next==="/admin")params.set("next","admin");
    else if(next.startsWith("/workout.html"))params.set("next",next==="/workout.html"?"workout":next);
    else if(next==="/onboarding.html")params.set("next","onboarding");
    else if(next==="/ai")params.set("next","ai");
    if(purpose==="login"||purpose==="signup")params.set("purpose",purpose);
    if(error)params.set("error",error);
    if(sent)params.set("sent","1");
    return `/verify-email.html${params.size?`?${params}`:""}`;
  }
  function requestedPageNext(url){
    const requested=cleanText(url.searchParams.get("next"),100),add=cleanText(url.searchParams.get("add"),80);
    if(requested==="planner")return /^[a-z0-9-]{2,80}$/.test(add)&&exerciseIds.has(add)?`/planner.html?add=${add}`:"/planner.html";
    if(requested==="pricing")return "/pricing";
    if(requested==="discover")return "/discover.html";
    if(requested==="admin")return "/admin";
    return safeAccountNext(requested);
  }
  function replaceInputValue(html,id,value){
    const pattern=new RegExp(`(<input\\b[^>]*\\bid="${id}"[^>]*\\bvalue=")[^"]*(")`);
    return html.replace(pattern,(_match,before,after)=>`${before}${escapeHtml(value)}${after}`);
  }
  function revealPageMessage(html,id,message){
    if(!message)return html;
    const pattern=new RegExp(`(<div\\b[^>]*\\bid="${id}"[^>]*?)\\s+hidden(\\s*><\\/div>)`);
    return html.replace(pattern,(_match,before,after)=>`${before}${after.slice(0,-6)}${escapeHtml(message)}</div>`);
  }
  function replaceElementText(html,id,message){
    if(!message)return html;
    const pattern=new RegExp(`(<[^>]+\\bid="${id}"[^>]*>)[^<]*(<\\/[^>]+>)`);
    return html.replace(pattern,(_match,before,after)=>`${before}${escapeHtml(message)}${after}`);
  }
  function safeAccountPageError(value){
    const messages=new Set(["Cross-origin request rejected.","Too many attempts. Try again later.","Use a valid name, email, and password of 10–128 characters.","An account with that email already exists.","Email or password is incorrect.","This account is temporarily paused. Contact STRATA support for help.","Admin ownership is secured. Sign in again to continue.","Administrator access required.","Unable to complete the account request.","Account storage is temporarily unavailable. Please try again.","Email verification is temporarily unavailable. Please try again later."]);
    const message=cleanText(value,240);
    return message?(messages.has(message)?message:"Unable to complete the account request. Please try again."):"";
  }
  function safeVerificationPageError(value){
    const message=cleanText(value,300);
    if(!message)return "";
    const known=new Map([
      ["That verification code is invalid or expired. Request a new code and try again.","That code is incorrect or expired. Check the email or request another code."],
      ["That verification code expired. Request a new code and try again.","That code expired. Request another code below."],
      ["Your verification request expired. Create the account again to receive a new code.","Your verification request expired. Return to signup to begin again."],
      ["Please wait before requesting another verification code.","Please wait before requesting another code."],
      ["This verification request has reached its resend limit. Create the account again to continue.","This request reached its resend limit. Return to signup to begin again."],
      ["Too many verification emails were requested. Please wait and try again.","Too many verification emails were requested. Please wait and try again."],
      ["The verification email could not be sent. Please wait a moment and resend it.","We could not send the verification email. Please wait a moment, then request another code."],
      ["Email verification is temporarily unavailable. Please try again later.","Email verification is temporarily unavailable. Please try again later."],
      ["Too many attempts. Try again later.","Too many attempts. Please wait and try again."],
      ["Cross-origin request rejected.","The security check failed. Return to signup and try again."]
    ]);
    return known.get(message)||"Unable to complete the verification request. Please try again.";
  }
  function renderAccountFallbacks(html,url){
    const next=requestedPageNext(url);
    let output=replaceInputValue(html,"signupNext",next);
    output=replaceInputValue(output,"loginNext",next);
    const message=safeAccountPageError(url.searchParams.get("error"));
    if(message)output=revealPageMessage(output,url.searchParams.get("mode")==="login"?"loginMessage":"signupMessage",message);
    return output;
  }
  function renderVerificationFallbacks(html,url){
    const next=requestedPageNext(url);
    let output=replaceInputValue(html,"verificationNext",next);
    output=replaceInputValue(output,"resendNext",next);
    const purpose=url.searchParams.get("purpose")==="login"?"login":"signup";
    output=replaceInputValue(output,"verificationPurpose",purpose);
    output=replaceInputValue(output,"resendPurpose",purpose);
    let message=safeVerificationPageError(url.searchParams.get("error"));
    if(!message&&url.searchParams.get("delivery")==="failed")message="We could not send the verification email. Please wait a moment, then request another code.";
    output=revealPageMessage(output,"verificationMessage",message);
    if(url.searchParams.get("sent")==="1")output=replaceElementText(output,"verificationStatus","A fresh code was sent. Check your inbox and spam folder.");
    return output;
  }

  function sendVerificationApiError(res,error){
    const headers={};
    if(error.signupToken)headers["Set-Cookie"]=signupCookie(error.signupToken);
    if(error.clearSignup)headers["Set-Cookie"]=signupCookie("",0);
    if(error.retryAfter)headers["Retry-After"]=String(error.retryAfter);
    json(res,error.status||500,{error:error.status?error.message:"Unable to complete the verification request.",code:error.code||"VERIFICATION_FAILED",verificationRequired:Boolean(error.verification),...(error.verification||{}),...(Number.isFinite(error.attemptsRemaining)?{attemptsRemaining:error.attemptsRemaining}:{}),...(Number.isFinite(error.retryAfter)?{retryAfter:error.retryAfter}:{})},headers);
  }

  async function handleForm(req,res,url){
    const recoveryRoutes=new Set(["/auth/password-reset/request","/auth/password-reset/complete","/auth/account-delete/complete"]);
    if(recoveryRoutes.has(url.pathname)){
      if(req.method!=="POST"){json(res,405,{error:"Method not allowed."},{Allow:"POST"});return;}
      const input=await bodyForm(req);
      if(!trustedAuthOrigin(req)){
        const location=url.pathname==="/auth/password-reset/request"?"/forgot-password?error=security":url.pathname==="/auth/password-reset/complete"?"/reset-password?error=security":"/delete-account?error=security";
        redirect(res,location);return;
      }
      try{
        if(url.pathname==="/auth/password-reset/request"){if(rateAllowed(req,"password-reset-request",8))await requestForgotPassword(input);redirect(res,"/forgot-password?sent=1");return;}
        if(url.pathname==="/auth/password-reset/complete"){
          if(!rateAllowed(req,"password-reset-complete",10))throw accountActionError("Too many attempts. Try again later.",429,"PASSWORD_RESET_RATE_LIMIT");
          await resetPassword(input);redirect(res,"/account.html?mode=login&reset=1",{"Set-Cookie":sessionCookie("",0)});return;
        }
        if(!rateAllowed(req,"account-delete-complete",10))throw accountActionError("Too many attempts. Try again later.",429,"ACCOUNT_DELETE_RATE_LIMIT");
        await deleteAccountWithToken(input);redirect(res,"/delete-account?deleted=1",{"Set-Cookie":[sessionCookie("",0),signupCookie("",0)]});return;
      }catch(error){
        if(!error.status)logger.error(error);
        const location=url.pathname==="/auth/password-reset/request"?"/forgot-password?sent=1":url.pathname==="/auth/password-reset/complete"?"/reset-password?error=invalid":"/delete-account?error=invalid";
        redirect(res,location);return;
      }
    }
    const routes=new Set(["/auth/signup","/auth/login","/auth/verify-email","/auth/resend-verification"]);
    if(!routes.has(url.pathname)){json(res,404,{error:"Account route not found."});return;}
    if(req.method!=="POST"){json(res,405,{error:"Method not allowed."},{Allow:"POST"});return;}
    const input=await bodyForm(req),verificationAction=url.pathname==="/auth/verify-email"||url.pathname==="/auth/resend-verification";
    const rejectedLocation=(message)=>verificationAction?verificationLocation(input.next,{error:message,purpose:input.purpose}):accountErrorLocation(url.pathname==="/auth/login"?"login":"signup",message,input.next);
    if(!trustedAuthOrigin(req)){redirect(res,rejectedLocation("Cross-origin request rejected."));return;}
    const rateKind=url.pathname==="/auth/verify-email"?"verify-email":url.pathname==="/auth/resend-verification"?"resend-verification":"auth";
    if(!(rateKind==="auth"?accountRateAllowed(req,input):verificationRateAllowed(req,rateKind))){redirect(res,rejectedLocation("Too many attempts. Try again later."));return;}
    try{
      if(url.pathname==="/auth/signup"||url.pathname==="/auth/login"){
        const result=url.pathname==="/auth/signup"?await beginAccountRegistration(input):await authenticateAccount(input);
        if(result.verification)redirect(res,verificationLocation(input.next,{purpose:result.verification.purpose}),{"Set-Cookie":signupCookie(result.signupToken)});
        else redirect(res,safeAccountNext(input.next),{"Set-Cookie":sessionCookie(result.session.token)});
        return;
      }
      if(url.pathname==="/auth/verify-email"){
        const result=await verifyAccountEmail(req,input);
        redirect(res,safeAccountNext(input.next),{"Set-Cookie":[sessionCookie(result.session.token),signupCookie("",0)]});return;
      }
      const verification=await resendAccountVerification(req);
      redirect(res,verificationLocation(input.next,{sent:true,purpose:verification.purpose||input.purpose}));
    }catch(error){
      const message=error.status?error.message:"Unable to complete the account request.";
      if(!error.status)logger.error(error);
      const headers={};
      if(error.signupToken)headers["Set-Cookie"]=signupCookie(error.signupToken);
      if(error.clearSignup)headers["Set-Cookie"]=signupCookie("",0);
      if((url.pathname==="/auth/signup"||url.pathname==="/auth/login")&&error.signupToken)redirect(res,verificationLocation(input.next,{error:message,purpose:error.verification?.purpose||input.purpose}),headers);
      else if(url.pathname==="/auth/verify-email"&&error.code==="ACCOUNT_EXISTS")redirect(res,accountErrorLocation("login",message,input.next),headers);
      else if(url.pathname==="/auth/verify-email"||url.pathname==="/auth/resend-verification")redirect(res,verificationLocation(input.next,{error:message,purpose:error.verification?.purpose||input.purpose}),headers);
      else redirect(res,accountErrorLocation(url.pathname==="/auth/signup"?"signup":"login",message,input.next),headers);
    }
  }

  async function handleApi(req,res,url){
    if(!API_ROUTES.has(url.pathname))return false;
    if(await accountSelfService.handleApi(req,res,url))return true;
    if(url.pathname==="/api/signup"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      try{
        const input=await bodyJson(req);
        if(!accountRateAllowed(req,input)){json(res,429,{error:"Too many attempts. Try again later.",code:"AUTH_RATE_LIMIT"},{"Retry-After":"900"});return true;}
        const result=await beginAccountRegistration(input);
        if(result.verification)json(res,202,result.verification,{"Set-Cookie":signupCookie(result.signupToken)});
        else json(res,201,{user:await getUserPayload(result.user)},{"Set-Cookie":sessionCookie(result.session.token)});
      }catch(error){if(!error.status)throw error;sendVerificationApiError(res,error);}
      return true;
    }
    if(url.pathname==="/api/login"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      try{
        const input=await bodyJson(req);
        if(!accountRateAllowed(req,input)){json(res,429,{error:"Too many attempts. Try again later.",code:"AUTH_RATE_LIMIT"},{"Retry-After":"900"});return true;}
        const result=await authenticateAccount(input);
        if(result.verification)json(res,202,result.verification,{"Set-Cookie":signupCookie(result.signupToken)});
        else json(res,200,{user:await getUserPayload(result.user)},{"Set-Cookie":sessionCookie(result.session.token)});
      }catch(error){
        if(!error.status)throw error;
        if(error.signupToken||error.verification||/^(?:EMAIL_|VERIFICATION_)/.test(String(error.code||"")))sendVerificationApiError(res,error);
        else json(res,error.status,{error:error.message,code:error.code||"AUTHENTICATION_FAILED"});
      }
      return true;
    }
    if(url.pathname==="/api/verification-status"&&req.method==="GET"){
      const row=await verificationForRequest(req),now=Date.now();
      if(!usableVerification(row,now))json(res,200,{active:false,...(row?{purpose:row.purpose==="login"?"login":"signup"}:{})});
      else json(res,200,{active:true,...verificationPublic(row,now)});
      return true;
    }
    if(url.pathname==="/api/verify-email"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!verificationRateAllowed(req,"verify-email")){json(res,429,{error:"Too many attempts. Try again later.",code:"VERIFICATION_RATE_LIMIT"},{"Retry-After":"900"});return true;}
      try{
        const result=await verifyAccountEmail(req,await bodyJson(req));
        json(res,result.purpose==="login"?200:201,{user:await getUserPayload(result.user)},{"Set-Cookie":[sessionCookie(result.session.token),signupCookie("",0)]});
      }catch(error){if(!error.status)throw error;sendVerificationApiError(res,error);}
      return true;
    }
    if(url.pathname==="/api/resend-verification"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!verificationRateAllowed(req,"resend-verification")){json(res,429,{error:"Too many attempts. Try again later.",code:"VERIFICATION_RATE_LIMIT"},{"Retry-After":"900"});return true;}
      try{json(res,202,await resendAccountVerification(req));}
      catch(error){if(!error.status)throw error;sendVerificationApiError(res,error);}
      return true;
    }
    if(url.pathname==="/api/password-reset/request"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!rateAllowed(req,"password-reset-request",8)){json(res,202,{ok:true,message:PASSWORD_RESET_RESPONSE});return true;}
      try{json(res,202,await requestForgotPassword(await bodyJson(req)));}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"PASSWORD_RESET_REQUEST_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/account/password-reset/request"&&req.method==="POST"){
      const session=await requireSession(req,res);if(!session)return true;
      if(!validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return true;}
      await bodyJson(req);
      if(!rateAllowed(req,`password-reset-account:${session.id}`,5)){json(res,429,{error:"Too many account emails were requested. Please wait and try again.",code:"ACCOUNT_EMAIL_LIMIT"});return true;}
      try{json(res,202,{ok:true,...await requestSignedInAccountAction(session,"password_reset")});}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"PASSWORD_RESET_REQUEST_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/password-reset/status"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!rateAllowed(req,"password-reset-status",30)){json(res,429,{error:"Too many attempts. Try again later."});return true;}
      json(res,200,await inspectAccountAction(await bodyJson(req),"password_reset"));return true;
    }
    if(url.pathname==="/api/password-reset/complete"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!rateAllowed(req,"password-reset-complete",10)){json(res,429,{error:"Too many attempts. Try again later.",code:"PASSWORD_RESET_RATE_LIMIT"});return true;}
      try{await resetPassword(await bodyJson(req));json(res,200,{ok:true,message:"Password reset complete. Sign in with your new password."},{"Set-Cookie":sessionCookie("",0)});}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"PASSWORD_RESET_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/account/delete/request"&&req.method==="POST"){
      const session=await requireSession(req,res);if(!session)return true;
      if(!validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return true;}
      await bodyJson(req);
      if(!rateAllowed(req,`account-delete-request:${session.id}`,5)){json(res,429,{error:"Too many account emails were requested. Please wait and try again.",code:"ACCOUNT_EMAIL_LIMIT"});return true;}
      try{json(res,202,{ok:true,...await requestSignedInAccountAction(session,"account_delete")});}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"ACCOUNT_DELETE_REQUEST_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/account/delete/cancel"&&req.method==="POST"){
      const session=await requireSession(req,res);if(!session)return true;
      if(!validCsrf(req,session)){json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"});return true;}
      await bodyJson(req);await store.cancelAccountDeletion(session.id);json(res,200,{ok:true});return true;
    }
    if(url.pathname==="/api/account/delete/status"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!rateAllowed(req,"account-delete-status",30)){json(res,429,{error:"Too many attempts. Try again later."});return true;}
      json(res,200,await inspectAccountAction(await bodyJson(req),"account_delete"));return true;
    }
    if(url.pathname==="/api/account/delete/complete"&&req.method==="POST"){
      if(!trustedAuthOrigin(req)){json(res,403,{error:"Cross-origin request rejected."});return true;}
      if(!rateAllowed(req,"account-delete-complete",10)){json(res,429,{error:"Too many attempts. Try again later.",code:"ACCOUNT_DELETE_RATE_LIMIT"});return true;}
      try{await deleteAccountWithToken(await bodyJson(req));json(res,200,{ok:true,message:"Your STRATA account was permanently deleted."},{"Set-Cookie":[sessionCookie("",0),signupCookie("",0)]});}
      catch(error){if(!error.status)throw error;json(res,error.status,{error:error.message,code:error.code||"ACCOUNT_DELETE_FAILED"});}
      return true;
    }
    if(url.pathname==="/api/me"&&req.method==="GET"){
      const session=await sessionFor(req);
      if(!session)json(res,401,{error:"Not signed in."});
      else json(res,200,{user:await getUserPayload(session),csrfToken:session.csrf_token});
      return true;
    }
    if(url.pathname==="/api/logout"&&req.method==="POST"){
      const token=cookieMap(req.headers.cookie)[SESSION_COOKIE];
      if(token&&token.length<=200){
        try{await store.deleteSession(hashToken(token));}
        catch(error){logger.error("Session cleanup during logout failed:",error);json(res,503,{error:"Could not sign out safely. Please try again."});return true;}
      }
      json(res,200,{ok:true},{"Set-Cookie":sessionCookie("",0)});return true;
    }
    return false;
  }

  async function cleanup(now=Date.now()){
    await store.deleteOldVerificationData(now,now-VERIFICATION_RETENTION_MS);
    await store.deleteOldAccountActionData(now,now-ACCOUNT_ACTION_RETENTION_MS);
  }

  return Object.freeze({
    handleApi,handleForm,renderAccountFallbacks,renderVerificationFallbacks,cleanup,
    sessionFor,requireSession,sessionCookie,signupCookie,prepareSession,passwordMatches,validCsrf,
    requestSignedInAccountAction,accountActionError,accountEmailHash,normalizeEmail,hashToken
  });
}

module.exports={createAuthService,configuredAdminEmail,normalizeEmail};
