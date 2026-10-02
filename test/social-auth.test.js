"use strict";

// Sign in with Google, Apple, or Samsung: which settings turn a provider on, every way an ID token is refused, and
// how deleted accounts' Apple tokens are revoked. The full browser round trip is in server-social-auth.test.js.
const test=require("node:test"),assert=require("node:assert/strict");
const {generateKeyPairSync,randomBytes,sign}=require("node:crypto");
const {socialAuthSettings}=require("../src/social-auth-config");
const {codeChallenge,createSocialAuthClient}=require("../src/social-auth-client");
const {createSocialAuthService}=require("../src/social-auth");
const {seal}=require("../src/devices-crypto");
const {SOCIAL_PAGE_MESSAGES}=require("../src/social-auth-messages");

const NOW=1_800_000_000_000,SECONDS=NOW/1000;
const rsa=generateKeyPairSync("rsa",{modulusLength:2048}),other=generateKeyPairSync("rsa",{modulusLength:2048});
const applePem=generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"});
const TOKEN_KEY=randomBytes(32).toString("base64");
const b64=(value)=>Buffer.from(JSON.stringify(value)).toString("base64url");
const ENV={NODE_ENV:"test",GOOGLE_SIGN_IN_CLIENT_ID:"google-client",GOOGLE_SIGN_IN_CLIENT_SECRET:"google-secret",SAMSUNG_SIGN_IN_CLIENT_ID:"samsung-client",SAMSUNG_SIGN_IN_CLIENT_SECRET:"samsung-secret",
  APPLE_SIGN_IN_SERVICES_ID:"online.stratafitness.signin",APPLE_SIGN_IN_TEAM_ID:"TEAM123456",APPLE_SIGN_IN_KEY_ID:"KEY1234567",APPLE_SIGN_IN_PRIVATE_KEY:applePem.replace(/\n/g,"\\n"),SIGN_IN_TOKEN_KEY:TOKEN_KEY};

function jwt(claims,{kid="key-1",alg="RS256",key=rsa.privateKey}={}){
  const input=`${b64({alg,kid})}.${b64(claims)}`;
  return `${input}.${sign("RSA-SHA256",Buffer.from(input),key).toString("base64url")}`;
}
const claims=(extra={})=>({iss:"https://accounts.google.com",aud:"google-client",sub:"subject-1",email:"a@example.test",email_verified:true,nonce:"nonce-1",iat:SECONDS,exp:SECONDS+600,...extra});
function keyServer(keys=[{...rsa.publicKey.export({format:"jwk"}),kid:"key-1",alg:"RS256",use:"sig"}]){
  const calls=[];
  return {calls,fetchImpl:async(url)=>{calls.push(String(url));return new Response(JSON.stringify({keys}),{status:200,headers:{"Content-Type":"application/json"}});}};
}

test("a provider turns on only when every value it needs is set",()=>{
  const none=socialAuthSettings({NODE_ENV:"test"});
  assert.deepEqual(none.enabled,[]);
  assert.match(none.providers.google.problems[0],/GOOGLE_SIGN_IN_CLIENT_ID and GOOGLE_SIGN_IN_CLIENT_SECRET/);
  assert.deepEqual(socialAuthSettings(ENV).enabled,["google","apple","samsung"]);
  assert.deepEqual(socialAuthSettings({...ENV,GOOGLE_SIGN_IN_CLIENT_SECRET:""}).enabled,["apple","samsung"]);

  const noKey=socialAuthSettings({...ENV,SIGN_IN_TOKEN_KEY:""}).providers.apple;
  assert.equal(noKey.configured,false);assert.match(noKey.problems.join(" "),/SIGN_IN_TOKEN_KEY/);
  assert.match(socialAuthSettings({...ENV,APPLE_SIGN_IN_PRIVATE_KEY:"not a key"}).providers.apple.problems.join(" "),/\.p8 key/);
  const rsaKey=rsa.privateKey.export({type:"pkcs8",format:"pem"});
  assert.equal(socialAuthSettings({...ENV,APPLE_SIGN_IN_PRIVATE_KEY:rsaKey}).providers.apple.configured,false,"only an EC P-256 key signs Apple's client secret");
  assert.match(socialAuthSettings({...ENV,APPLE_SIGN_IN_TEAM_ID:"team"}).providers.apple.problems.join(" "),/10-character/);

  const production=socialAuthSettings({...ENV,NODE_ENV:"production",APP_BASE_URL:"http://stratafitness.online"});
  assert.deepEqual(production.enabled,[]);assert.match(production.providers.google.problems.join(" "),/APP_BASE_URL must be an https address/);
  const live=socialAuthSettings({...ENV,NODE_ENV:"production",APP_BASE_URL:"https://stratafitness.online/",SIGN_IN_PROVIDER_STAND_IN:"http://127.0.0.1:9999"});
  assert.equal(live.redirectBase,"https://stratafitness.online");assert.equal(live.secureCookies,true);
  assert.equal(live.providers.google.tokenUrl,"https://oauth2.googleapis.com/token","production never uses a stand-in");
  const local=socialAuthSettings({...ENV,SIGN_IN_PROVIDER_STAND_IN:"http://127.0.0.1:9999/"});
  assert.deepEqual([local.providers.samsung.issuers,local.providers.samsung.userinfoUrl,local.providers.google.revokeUrl],[["http://127.0.0.1:9999/samsung"],"http://127.0.0.1:9999/samsung/userinfo",""]);
  assert.equal(socialAuthSettings({...ENV,SIGN_IN_PROVIDER_STAND_IN:"https://example.test"}).providers.google.tokenUrl,"https://oauth2.googleapis.com/token","a stand-in must be this machine");
});

test("authorization addresses ask for exactly what each provider needs",()=>{
  const client=createSocialAuthClient({settings:socialAuthSettings(ENV),fetchImpl:async()=>{throw new Error("no network");}});
  const request={state:"state-1",nonce:"nonce-1",codeVerifier:"verifier-1",redirectUri:"https://stratafitness.online/auth/social/google/callback"};
  const google=new URL(client.authorizeUrl("google",request));
  assert.equal(google.origin+google.pathname,"https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(google.searchParams),{response_type:"code",client_id:"google-client",redirect_uri:request.redirectUri,scope:"openid email profile",state:"state-1",nonce:"nonce-1",code_challenge:codeChallenge("verifier-1"),code_challenge_method:"S256",prompt:"select_account"});
  const apple=new URL(client.authorizeUrl("apple",request));
  assert.equal(apple.searchParams.get("response_mode"),"form_post");assert.equal(apple.searchParams.get("scope"),"name email");assert.equal(apple.searchParams.has("code_challenge"),false);
  const samsung=new URL(client.authorizeUrl("samsung",request));
  assert.equal(samsung.origin+samsung.pathname,"https://account.samsung.com/iam/oidc/authorize");assert.equal(samsung.searchParams.has("response_mode"),false);
  assert.throws(()=>createSocialAuthClient({settings:socialAuthSettings({NODE_ENV:"test"})}).authorizeUrl("google",request),{code:"SOCIAL_NOT_CONFIGURED"});
});

test("an ID token is accepted only when its signature, issuer, audience, time, nonce, and subject all check out",async()=>{
  const keys=keyServer(),client=createSocialAuthClient({settings:socialAuthSettings(ENV),fetchImpl:keys.fetchImpl,now:()=>NOW});
  const accepted=await client.verifyIdToken("google",jwt(claims()),{nonce:"nonce-1"});
  assert.equal(accepted.sub,"subject-1");
  assert.equal((await client.verifyIdToken("google",jwt(claims({iss:"accounts.google.com"})),{nonce:"nonce-1"})).sub,"subject-1","Google's short issuer is listed");
  assert.equal((await client.verifyIdToken("google",jwt(claims({aud:["google-client","other"],azp:"google-client"})),{nonce:"nonce-1"})).sub,"subject-1");

  const refused=[
    ["another signing key",jwt(claims(),{key:other.privateKey})],
    ["no signature",`${b64({alg:"none",kid:"key-1"})}.${b64(claims())}.`],
    ["another algorithm",jwt(claims(),{alg:"HS256"})],
    ["another issuer",jwt(claims({iss:"https://appleid.apple.com"}))],
    ["another audience",jwt(claims({aud:"someone-else"}))],
    ["several audiences without azp",jwt(claims({aud:["google-client","other"]}))],
    ["expired",jwt(claims({exp:SECONDS-121}))],
    ["issued in the future",jwt(claims({iat:SECONDS+121}))],
    ["another nonce",jwt(claims({nonce:"nonce-2"}))],
    ["no nonce",jwt(claims({nonce:undefined}))],
    ["no subject",jwt(claims({sub:""}))],
    ["not a token","abc.def"]
  ];
  for(const [label,token] of refused)await assert.rejects(client.verifyIdToken("google",token,{nonce:"nonce-1"}),{code:"SOCIAL_TOKEN_INVALID"},label);
  const tampered=jwt(claims()).split(".");tampered[1]=b64(claims({sub:"subject-2"}));
  await assert.rejects(client.verifyIdToken("google",tampered.join("."),{nonce:"nonce-1"}),{code:"SOCIAL_TOKEN_INVALID"},"a changed payload");

  // Samsung's nonce is checked when present, but Samsung does not promise to echo it.
  const samsung=createSocialAuthClient({settings:socialAuthSettings(ENV),fetchImpl:keyServer().fetchImpl,now:()=>NOW});
  const samsungClaims={iss:"https://account.samsung.com/iam",aud:"samsung-client",sub:"s-1",iat:SECONDS,exp:SECONDS+600};
  assert.equal((await samsung.verifyIdToken("samsung",jwt(samsungClaims),{nonce:"nonce-1"})).sub,"s-1");
  await assert.rejects(samsung.verifyIdToken("samsung",jwt({...samsungClaims,nonce:"other"}),{nonce:"nonce-1"}),{code:"SOCIAL_TOKEN_INVALID"});
});

test("signing keys are cached, and an unknown key is looked up again at most once a minute",async()=>{
  const keys=keyServer();let time=NOW;
  const client=createSocialAuthClient({settings:socialAuthSettings(ENV),fetchImpl:keys.fetchImpl,now:()=>time});
  await client.verifyIdToken("google",jwt(claims()),{nonce:"nonce-1"});
  await client.verifyIdToken("google",jwt(claims()),{nonce:"nonce-1"});
  assert.equal(keys.calls.length,1);
  await assert.rejects(client.verifyIdToken("google",jwt(claims(),{kid:"rotated"}),{nonce:"nonce-1"}),{code:"SOCIAL_TOKEN_INVALID"});
  assert.equal(keys.calls.length,1,"a refresh within a minute of the last fetch is not repeated");
  time+=61_000;
  await assert.rejects(client.verifyIdToken("google",jwt(claims(),{kid:"rotated"}),{nonce:"nonce-1"}),{code:"SOCIAL_TOKEN_INVALID"});
  assert.equal(keys.calls.length,2);
  const empty=createSocialAuthClient({settings:socialAuthSettings(ENV),fetchImpl:keyServer([]).fetchImpl,now:()=>NOW});
  await assert.rejects(empty.verifyIdToken("google",jwt(claims()),{nonce:"nonce-1"}),{code:"SOCIAL_BAD_RESPONSE"});
});

test("the code exchange sends the client credentials and reports a refused code",async()=>{
  const sent=[];let status=200;
  const client=createSocialAuthClient({settings:socialAuthSettings(ENV),now:()=>NOW,fetchImpl:async(url,init)=>{
    sent.push({url:String(url),form:Object.fromEntries(new URLSearchParams(String(init.body)))});
    return new Response(JSON.stringify(status===200?{id_token:"a.b.c",access_token:"access",refresh_token:"refresh"}:{error:"invalid_grant"}),{status});
  }});
  assert.deepEqual(await client.exchangeCode("google",{code:"code-1",redirectUri:"https://x.test/cb",codeVerifier:"verifier"}),{idToken:"a.b.c",accessToken:"access",refreshToken:"refresh"});
  assert.deepEqual(sent[0].form,{grant_type:"authorization_code",code:"code-1",redirect_uri:"https://x.test/cb",client_id:"google-client",client_secret:"google-secret",code_verifier:"verifier"});
  await client.exchangeCode("apple",{code:"code-2",redirectUri:"https://x.test/cb",codeVerifier:"unused"});
  const [header,payload]=sent[1].form.client_secret.split(".").slice(0,2).map((part)=>JSON.parse(Buffer.from(part,"base64url")));
  assert.deepEqual(header,{alg:"ES256",kid:"KEY1234567",typ:"JWT"});
  assert.deepEqual(payload,{iss:"TEAM123456",iat:SECONDS,exp:SECONDS+300,aud:"https://appleid.apple.com",sub:"online.stratafitness.signin"});
  assert.equal(sent[1].form.code_verifier,undefined);
  status=400;await assert.rejects(client.exchangeCode("google",{code:"used",redirectUri:"https://x.test/cb",codeVerifier:"v"}),{code:"SOCIAL_CODE_REJECTED",status:400});
  status=503;await assert.rejects(client.exchangeCode("google",{code:"c",redirectUri:"https://x.test/cb",codeVerifier:"v"}),{code:"SOCIAL_UNAVAILABLE"});
});

function revocationHarness({settings=socialAuthSettings(ENV),revoke=async()=>true}={}){
  const keys=socialAuthSettings(ENV).keys,rows=[
    {id:1,provider:"apple",token_sealed:seal(keys,"refresh-1")},
    {id:2,provider:"apple",token_sealed:seal(keys,"refresh-2")},
    {id:3,provider:"apple",token_sealed:"v1.unknown.key.value.tag"}
  ];
  const calls={revoked:[],completed:[],retried:[],deleted:[]};
  const store={
    async pendingSignInRevocations(limit){assert.equal(limit,25);return rows;},
    async completeSignInRevocation(id){calls.completed.push(id);},
    async retrySignInRevocation(id){calls.retried.push(id);},
    async deleteExpiredSocialSignInData(now,staleBefore){calls.deleted.push([now,staleBefore]);}
  };
  const client={async revoke(id,token){calls.revoked.push([id,token]);return revoke(token);}};
  const service=createSocialAuthService({store,settings,client,getAuth:()=>({}),trustedAuthOrigin:()=>true,rateAllowed:()=>true,http:{bodyForm:async()=>({}),redirect:()=>{},securityHeaders:()=>({})},now:()=>NOW});
  return {service,calls};
}

test("deleted accounts' Apple tokens are revoked, retried when Apple fails, and dropped when they can never be read",async()=>{
  const ok=revocationHarness();
  assert.equal(await ok.service.cleanup(),2);
  assert.deepEqual(ok.calls.revoked,[["apple","refresh-1"],["apple","refresh-2"]]);
  assert.deepEqual(ok.calls.completed,[1,2,3]);assert.deepEqual(ok.calls.retried,[]);
  assert.deepEqual(ok.calls.deleted,[[NOW,NOW-7*24*60*60*1000]]);

  const failing=revocationHarness({revoke:async(token)=>{if(token==="refresh-2")throw Object.assign(new Error("Apple is down"),{code:"SOCIAL_UNAVAILABLE"});return true;}});
  assert.equal(await failing.service.cleanup(),1);
  assert.deepEqual(failing.calls.completed,[1,3]);assert.deepEqual(failing.calls.retried,[2]);

  const off=revocationHarness({settings:socialAuthSettings({...ENV,APPLE_SIGN_IN_SERVICES_ID:""})});
  assert.equal(await off.service.cleanup(),0);assert.deepEqual(off.calls.revoked,[],"tokens wait until Apple is configured again");
});

test("the account page shows only the configured buttons, and every sign-in message is allowlisted for it",()=>{
  const html='<div class="social-sign-in" data-social-options hidden><button data-social="apple" hidden></button><button data-social="google" hidden></button><button data-social="samsung" hidden></button></div>';
  const service=(env)=>revocationHarness({settings:socialAuthSettings(env)}).service;
  assert.equal(service({NODE_ENV:"test"}).renderAccountPage(html),html);
  assert.equal(service({...ENV,APPLE_SIGN_IN_SERVICES_ID:""}).renderAccountPage(html),'<div class="social-sign-in" data-social-options><button data-social="apple" hidden></button><button data-social="google"></button><button data-social="samsung"></button></div>');
  const {KNOWN_AUTH_ERRORS}=loadAccountLogicAllowlist();
  for(const message of SOCIAL_PAGE_MESSAGES)assert.ok(KNOWN_AUTH_ERRORS.includes(message),`account-logic.js shows: ${message}`);
});

function loadAccountLogicAllowlist(){
  const source=require("node:fs").readFileSync(require("node:path").join(__dirname,"..","public","scripts","account-logic.js"),"utf8");
  const list=source.slice(source.indexOf("const KNOWN_AUTH_ERRORS"),source.indexOf("]);",source.indexOf("const KNOWN_AUTH_ERRORS")));
  return {KNOWN_AUTH_ERRORS:[...list.matchAll(/"([^"]+)"/g)].map((match)=>match[1])};
}
