"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");
const {
  directSignupAllowed,
  escapeHtml,
  generateVerificationCode,
  getEmailVerificationConfig,
  maskEmail,
  safeDigestEqual,
  sendAccountActionEmail,
  sendSupportAcknowledgment,
  sendSupportNotification,
  sendSupportResponse,
  sendVerificationEmail,
  verificationCodeDigest,
  verificationEmailHash
}=require("../src/email");

function validEnv(overrides={}) {
  return {
    NODE_ENV:"production",
    EMAIL_VERIFICATION_ENABLED:"true",
    RESEND_API_KEY:"re_abcdefghijklmnopqrstuvwxyz123456",
    EMAIL_FROM:"STRATA <verify@stratafitness.online>",
    EMAIL_REPLY_TO:"support@stratafitness.online",
    EMAIL_VERIFICATION_SECRET:"v".repeat(48),
    APP_BASE_URL:"https://stratafitness.online",
    ...overrides
  };
}

test("email configuration fails closed when enabled and stays serialization-safe",()=>{
  const disabled=getEmailVerificationConfig({EMAIL_VERIFICATION_ENABLED:"false"});
  assert.equal(disabled.enabled,false);
  assert.equal(disabled.configured,false);
  assert.equal(disabled.deliveryConfigured,false);
  assert.equal(disabled.secretConfigured,false);
  assert.deepEqual(disabled.missing,[]);

  const incomplete=getEmailVerificationConfig({EMAIL_VERIFICATION_ENABLED:"true",APP_BASE_URL:"http://not-production.test"});
  assert.equal(incomplete.enabled,false);
  assert.equal(incomplete.configured,false);
  assert.ok(incomplete.missing.length>=4);

  const config=getEmailVerificationConfig(validEnv());
  assert.equal(config.enabled,true);
  assert.equal(config.configured,true);
  assert.equal(config.deliveryConfigured,true);
  assert.equal(config.secretConfigured,true);
  assert.equal(config.appBaseUrl,"https://stratafitness.online");
  const serialized=JSON.stringify(config);
  assert.doesNotMatch(serialized,/re_abcdefghijklmnopqrstuvwxyz|vvvvvvvv/);
  assert.doesNotMatch(serialized,/API_KEY|SECRET/);
});

test("unverified direct signup requires an explicit test-only override",()=>{
  for (const flag of [undefined,"","false","treu","1","yes"]) {
    const env={NODE_ENV:"production"};
    if(flag!==undefined)env.EMAIL_VERIFICATION_ENABLED=flag;
    const config=getEmailVerificationConfig(env);
    assert.equal(directSignupAllowed(config,"production","true"),false,`production flag ${String(flag)}`);
    if(flag!=="false") assert.equal(config.flagValid,false,`flag validity ${String(flag)}`);
  }

  const disabled=getEmailVerificationConfig({NODE_ENV:"test",EMAIL_VERIFICATION_ENABLED:"false"});
  assert.equal(directSignupAllowed(disabled,"test","true"),true);
  assert.equal(directSignupAllowed(disabled,"test","false"),false);
  assert.equal(directSignupAllowed(disabled,"test",""),false);
  assert.equal(directSignupAllowed(disabled,"development","true"),false);
  assert.equal(directSignupAllowed(disabled,"","true"),false);
  assert.equal(directSignupAllowed(disabled,"staging","true"),false);
  assert.equal(directSignupAllowed(disabled,"prodution","true"),false);

  const requestedButIncomplete=getEmailVerificationConfig({NODE_ENV:"test",EMAIL_VERIFICATION_ENABLED:"true"});
  assert.equal(requestedButIncomplete.enabled,false);
  assert.equal(directSignupAllowed(requestedButIncomplete,"test","true"),false);
});

test("placeholder credentials are rejected and example secrets are blank",()=>{
  for (const overrides of [
    {RESEND_API_KEY:"re_replace-with-your-private-api-key"},
    {RESEND_API_KEY:"re_<YOUR_PRIVATE_API_KEY>"},
    {EMAIL_VERIFICATION_SECRET:"replace-with-a-random-secret-that-is-at-least-32-characters"},
    {EMAIL_VERIFICATION_SECRET:"<YOUR_PRIVATE_VERIFICATION_SECRET_32_CHARS>"}
  ]) {
    const config=getEmailVerificationConfig(validEnv(overrides));
    assert.equal(config.enabled,false);
    assert.equal(config.configured,false);
  }

  const example=readFileSync(join(__dirname,"..",".env.example"),"utf8");
  assert.match(example,/^RESEND_API_KEY=\s*$/m);
  assert.match(example,/^EMAIL_VERIFICATION_SECRET=\s*$/m);
});

test("six-digit codes and keyed digests preserve leading zeroes and bind every field",()=>{
  const config=getEmailVerificationConfig(validEnv());
  assert.equal(generateVerificationCode(()=>42),"000042");
  assert.throws(()=>generateVerificationCode(()=>1_000_000));
  const input={challengeId:"challenge-1",generation:1,email:"Person@Example.com",code:"000042"};
  const digest=verificationCodeDigest(config,input);
  assert.match(digest,/^[a-f0-9]{64}$/);
  assert.equal(safeDigestEqual(digest,verificationCodeDigest(config,{...input,email:"person@example.com"})),true);
  assert.equal(safeDigestEqual(digest,verificationCodeDigest(config,{...input,generation:2})),false);
  assert.equal(safeDigestEqual(digest,verificationCodeDigest(config,{...input,code:"000043"})),false);
  assert.notEqual(verificationEmailHash(config,"person@example.com"),verificationEmailHash(config,"other@example.com"));
});

test("masking and HTML escaping do not expose unsafe markup",()=>{
  assert.equal(maskEmail("saeed@example.com"),"s***d@example.com");
  assert.equal(maskEmail("a@example.com"),"*@example.com");
  assert.equal(maskEmail("invalid"),"your email address");
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`),"&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
});

test("Resend delivery uses server credentials, escaped HTML, and an idempotency key",async()=>{
  const config=getEmailVerificationConfig(validEnv({NODE_ENV:"test",RESEND_API_BASE:"http://127.0.0.1:9999"}));
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({id:"email-message-1"})};
  };
  const result=await sendVerificationEmail(config,{
    to:"Person@Example.com",
    name:"Saeed <Admin>",
    code:"012345",
    challengeId:"challenge-1",
    generation:3,
    expiresInMinutes:10
  },fetchImpl);
  assert.deepEqual(result,{messageId:"email-message-1"});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,"http://127.0.0.1:9999/emails");
  assert.equal(calls[0].options.headers.Authorization,"Bearer re_abcdefghijklmnopqrstuvwxyz123456");
  assert.match(calls[0].options.headers["Idempotency-Key"],/^strata-[a-f0-9]{64}$/);
  const body=JSON.parse(calls[0].options.body);
  assert.deepEqual(body.to,["person@example.com"]);
  assert.match(body.text,/012345/);
  assert.match(body.text,/https:\/\/stratafitness\.online\/verify-email/);
  assert.match(body.text,/browser where you started signup/i);
  assert.match(body.html,/Saeed &lt;Admin&gt;/);
  assert.doesNotMatch(body.html,/<Admin>/);
  assert.equal(body.reply_to,"support@stratafitness.online");

  await assert.rejects(
    ()=>sendVerificationEmail(config,{to:"person@example.com",name:"Person",code:"012345",challengeId:"challenge-2",generation:1},async()=>({ok:false,json:async()=>({message:"private provider detail"})})),
    (error)=>error.code==="EMAIL_DELIVERY_FAILED"&&!error.message.includes("private provider detail")
  );
});

test("account-action emails use one-time fragment links and purpose-bound idempotency",async()=>{
  const config=getEmailVerificationConfig(validEnv({NODE_ENV:"test",RESEND_API_BASE:"http://127.0.0.1:9999"}));
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({id:`message-${calls.length}`})};
  };
  const token="a".repeat(43);
  const reset=await sendAccountActionEmail(config,{
    to:"Person@Example.com",
    name:"Saeed <Admin>",
    token,
    requestId:"request-1",
    purpose:"password_reset",
    expiresInMinutes:30
  },fetchImpl);
  const deletion=await sendAccountActionEmail(config,{
    to:"Person@Example.com",
    name:"Saeed <Admin>",
    token,
    requestId:"request-1",
    purpose:"account_delete",
    expiresInMinutes:30
  },fetchImpl);

  assert.deepEqual(reset,{messageId:"message-1"});
  assert.deepEqual(deletion,{messageId:"message-2"});
  assert.equal(calls.length,2);
  const resetBody=JSON.parse(calls[0].options.body);
  const deleteBody=JSON.parse(calls[1].options.body);
  assert.deepEqual(resetBody.to,["person@example.com"]);
  assert.match(resetBody.text,new RegExp(`https://stratafitness\\.online/reset-password#token=${token}`));
  assert.match(deleteBody.text,new RegExp(`https://stratafitness\\.online/delete-account#token=${token}`));
  assert.match(deleteBody.text,/Merely opening this email will not delete anything/i);
  assert.match(resetBody.html,/Saeed &lt;Admin&gt;/);
  assert.notEqual(calls[0].options.headers["Idempotency-Key"],calls[1].options.headers["Idempotency-Key"]);
  assert.match(calls[0].options.headers["Idempotency-Key"],/^strata-action-[a-f0-9]{64}$/);
  await assert.rejects(
    ()=>sendAccountActionEmail(config,{to:"person@example.com",token:"too-short",requestId:"request-2",purpose:"password_reset"},fetchImpl),
    TypeError
  );
});

test("support mail keeps ticket bodies in Admin and keys each distinct response safely",async()=>{
  const config=getEmailVerificationConfig(validEnv({NODE_ENV:"test",RESEND_API_BASE:"http://127.0.0.1:9999"}));
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({id:`support-message-${calls.length}`})};
  };
  const ticket={
    id:"ticket-1",reference:"STR-2026-A1B2C3",name:"Saeed <Owner>",
    email:"person@example.com",category:"account",subject:"Account help",
    referenceId:"txn_reference",message:"Private ticket body <script>alert(1)</script>",
    updated_at:1_810_000_000_000
  };

  await sendSupportAcknowledgment(config,ticket,fetchImpl);
  await sendSupportNotification(config,ticket,fetchImpl);
  await sendSupportResponse(config,ticket,"First safe response.",fetchImpl);
  await sendSupportResponse(config,ticket,"Second safe response.",fetchImpl);
  await sendSupportResponse(config,ticket,"First safe response.",fetchImpl);

  const notification=JSON.parse(calls[1].options.body);
  assert.deepEqual(notification.to,["support@stratafitness.online"]);
  assert.equal(notification.reply_to,"person@example.com");
  assert.match(notification.text,/https:\/\/stratafitness\.online\/admin#support/);
  assert.doesNotMatch(notification.text,/Private ticket body|script/i,"support content belongs in the private dashboard, not the owner notification");
  assert.doesNotMatch(notification.html,/Private ticket body|<script/i);

  const firstKey=calls[2].options.headers["Idempotency-Key"];
  const secondKey=calls[3].options.headers["Idempotency-Key"];
  const retryKey=calls[4].options.headers["Idempotency-Key"];
  assert.notEqual(firstKey,secondKey,"different reply text must not reuse a provider idempotency key");
  assert.equal(firstKey,retryKey,"retrying the same reply against the same ticket version must be idempotent");
  assert.match(JSON.parse(calls[2].options.body).html,/First safe response\./);
});
