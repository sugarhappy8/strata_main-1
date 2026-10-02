"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {parseOptions:parsePreflightOptions,productionBaseUrl,tursoUrl,validateDeploymentEnvironment}=require("../scripts/config-preflight");
const {deploymentUrl,parseOptions:parseSmokeOptions,validateStatus}=require("../scripts/deploy-smoke");
const {getEmailVerificationConfig}=require("../src/email");
const {getPaymentConfig}=require("../src/payments");

function productionEnvironment(overrides={}) {
  return {
    NODE_ENV:"production",APP_BASE_URL:"https://strata.example/",TURSO_DATABASE_URL:"libsql://strata.example.turso.io",
    TURSO_AUTH_TOKEN:"turso-token-with-enough-entropy",SECURE_COOKIES:"true",TRUST_PROXY:"true",
    ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS:"false",ADMIN_EMAIL:"owner@example.com",
    EMAIL_VERIFICATION_ENABLED:"true",RESEND_API_KEY:"re_production_api_key_123456789",EMAIL_FROM:"STRATA <accounts@example.com>",
    EMAIL_REPLY_TO:"support@example.com",SUPPORT_EMAIL:"support@example.com",EMAIL_VERIFICATION_SECRET:"email-secret-that-is-at-least-thirty-two-characters",
    PADDLE_CHECKOUT_ENABLED:"true",PADDLE_ENVIRONMENT:"live",PADDLE_PRODUCT_ID:"pro_recurringproduct1234567890",PADDLE_PRICE_ID:"pri_recurringprice123456789012",
    PADDLE_CLIENT_TOKEN:"live_client_token_1234567890",PADDLE_API_KEY:"pdl_live_apikey_privatecredential123456789012",PADDLE_WEBHOOK_SECRET:"pdl_ntfset_signingsecret1234567890",
    ...overrides
  };
}

test("production configuration preflight requires complete separated provider boundaries",()=>{
  const result=validateDeploymentEnvironment(productionEnvironment(),{requireEmail:true,requirePayments:true});
  assert.equal(result.ok,true);
  assert.deepEqual(result.failures,[]);
  assert.equal(result.checks.every((check)=>check.passed),true);

  const shared="this-value-was-incorrectly-reused-across-boundaries";
  const invalid=validateDeploymentEnvironment(productionEnvironment({TURSO_AUTH_TOKEN:shared,EMAIL_VERIFICATION_SECRET:shared,PADDLE_WEBHOOK_SECRET:shared,SECURE_COOKIES:"false"}),{requireEmail:true,requirePayments:true});
  assert.equal(invalid.ok,false);
  assert.ok(invalid.failures.some(({name})=>name==="cookies.secure"));
  assert.ok(invalid.failures.some(({name})=>name==="secrets.separated"));
  assert.doesNotMatch(JSON.stringify(invalid),new RegExp(shared),"preflight output must never include secret values");
});

test("preflight checks Polar connected devices only once they are configured",()=>{
  const off=validateDeploymentEnvironment(productionEnvironment(),{requireEmail:true,requirePayments:true});
  assert.equal(off.checks.some(({name})=>name==="devices.polar"),false);assert.ok(off.warnings.some((warning)=>/Polar connected devices are off/.test(warning)));
  const key=Buffer.alloc(32,7).toString("base64"),polar={POLAR_CLIENT_ID:"polar-client-id",POLAR_CLIENT_SECRET:"polar-client-secret-value",DEVICE_TOKEN_KEY:key};
  const ready=validateDeploymentEnvironment(productionEnvironment(polar),{requireEmail:true,requirePayments:true});
  assert.equal(ready.ok,true);assert.equal(ready.checks.find(({name})=>name==="devices.polar").passed,true);
  const oldHook=validateDeploymentEnvironment(productionEnvironment({...polar,POLAR_WEBHOOK_SECRET:"unused-v3-secret"}),{requireEmail:true,requirePayments:true});
  assert.equal(oldHook.ok,true);assert.ok(oldHook.warnings.some((warning)=>/ignored by AccessLink V4/.test(warning)));
  const broken=validateDeploymentEnvironment(productionEnvironment({...polar,DEVICE_TOKEN_KEY:"short",POLAR_API_URL:"http://polar.example"}),{requireEmail:true,requirePayments:true});
  assert.equal(broken.ok,false);assert.match(broken.failures.find(({name})=>name==="devices.polar").detail,/DEVICE_TOKEN_KEY[\s\S]*https/);
  assert.doesNotMatch(JSON.stringify(broken),/polar-client-secret-value/);
});

test("preflight and runtime reject the same malformed provider credentials",()=>{
  const environment=productionEnvironment({
    RESEND_API_KEY:"long-but-not-a-resend-key",
    PADDLE_CLIENT_TOKEN:"long-but-not-a-live-token",
    PADDLE_API_KEY:"long-but-not-a-live-api-key-credential-value",
    PADDLE_WEBHOOK_SECRET:"long-but-not-a-webhook-signing-secret"
  });
  const result=validateDeploymentEnvironment(environment,{requireEmail:true,requirePayments:true});
  assert.equal(result.ok,false);
  assert.deepEqual(result.failures.map(({name})=>name).filter((name)=>name.includes("api-key")||name.includes("client-token")||name.includes("webhook-secret")),[
    "email.api-key","payments.client-token","payments.api-key","payments.webhook-secret"
  ]);
  assert.equal(getEmailVerificationConfig(environment).configured,false);
  assert.equal(getPaymentConfig(environment).configured,false);
});

test("preflight and runtime fail closed on a malformed legacy recurring-price allowlist",()=>{
  const current="pri_recurringprice123456789012";
  for(const value of [current,"pri_invalid",`${current},${current}`,`${current},`]){
    const environment=productionEnvironment({PADDLE_LEGACY_RECURRING_PRICE_IDS:value});
    const result=validateDeploymentEnvironment(environment,{requirePayments:true});
    assert.ok(result.failures.some(({name})=>name==="payments.legacy-prices"),value);
    assert.equal(getPaymentConfig(environment).configured,false,value);
  }
  const valid=productionEnvironment({PADDLE_LEGACY_RECURRING_PRICE_IDS:"pri_previousmonthlyprice123456789"});
  assert.equal(validateDeploymentEnvironment(valid,{requirePayments:true}).ok,true);
  assert.equal(getPaymentConfig(valid).configured,true);
});

test("preflight accepts runtime-valid sender syntax and rejects production sandbox",()=>{
  const live=productionEnvironment();
  assert.equal(validateDeploymentEnvironment(live,{requireEmail:true,requirePayments:true}).ok,true);
  assert.equal(getEmailVerificationConfig(live).configured,true);
  const sandbox=productionEnvironment({
    PADDLE_ENVIRONMENT:"sandbox",PADDLE_PRODUCT_ID:"pro_sandboxproduct12345678901",PADDLE_PRICE_ID:"pri_sandboxprice1234567890123",
    PADDLE_CLIENT_TOKEN:"test_client_token_1234567890",PADDLE_API_KEY:"pdl_sdbx_apikey_privatecredential123456789012"
  });
  assert.ok(validateDeploymentEnvironment(sandbox,{requirePayments:true}).failures.some(({name})=>name==="payments.environment"));
  assert.equal(getPaymentConfig(sandbox).configured,false);
});

test("preflight validates production and Turso URL shapes without accepting embedded credentials",()=>{
  assert.equal(productionBaseUrl("https://strata.example/"),true);
  assert.equal(productionBaseUrl("http://strata.example/"),false);
  assert.equal(productionBaseUrl("https://user:secret@strata.example/"),false);
  assert.equal(tursoUrl("libsql://database-name.turso.io"),true);
  assert.equal(tursoUrl("libsql://token@database-name.turso.io"),false);
  assert.deepEqual(parsePreflightOptions(["--require-all","--json"]),{requireEmail:true,requirePayments:true,json:true});
});

test("deployment smoke target is bounded to HTTPS except loopback",()=>{
  assert.equal(deploymentUrl("https://strata.example/path").href,"https://strata.example/");
  assert.equal(deploymentUrl("http://127.0.0.1:4173").href,"http://127.0.0.1:4173/");
  assert.throws(()=>deploymentUrl("http://strata.example"),/must use HTTPS/);
  assert.throws(()=>deploymentUrl("https://user:secret@strata.example"),/without credentials/);
  assert.deepEqual(parseSmokeOptions(["https://strata.example","--json"],{STRATA_EXPECTED_BUILD:"7.5.0",STRATA_SMOKE_TIMEOUT_MS:"15000"}),{
    target:"https://strata.example",expectedBuild:"7.5.0",timeoutMs:15000,json:true
  });
});

test("deployment smoke rejects a wrong version or a status that reveals the setup",()=>{
  const ready={ok:true,version:"7.5.0"};
  assert.doesNotThrow(()=>validateStatus(ready,{expectedBuild:"7.5.0"}));
  assert.throws(()=>validateStatus({...ready,version:"7.4.1"},{expectedBuild:"7.5.0"}),/expected 7\.5\.0/);
  assert.throws(()=>validateStatus({ok:false,version:"7.5.0"}),/operational/);
  assert.throws(()=>validateStatus({...ready,storage:"turso",paymentsConfigured:true}),/reveals setup it should not: storage, paymentsConfigured/);
});
