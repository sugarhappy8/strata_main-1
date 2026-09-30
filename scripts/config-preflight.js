"use strict";

const {devicesSettings}=require("../src/devices-config");
const {mailboxAddress,validEmailVerificationSecret,validResendApiKey}=require("../src/email");
const {validPaddleApiKey,validPaddleClientToken,validPaddleEnvironment,validPaddleLegacyRecurringPriceIds,validPaddlePriceId,validPaddleProductId,validPaddleWebhookSecret}=require("../src/payments");

const BOOLEAN_VALUES=new Set(["true","false"]);

function clean(value) { return String(value??"").trim(); }
function enabled(value) { return clean(value).toLowerCase()==="true"; }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value)); }
function configured(value,minLength=1) { return clean(value).length>=minLength; }

function productionBaseUrl(value) {
  try {
    const url=new URL(clean(value));
    return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash&&url.pathname==="/"&&!url.search&&url.hostname!=="localhost"&&!url.hostname.endsWith(".localhost");
  } catch { return false; }
}

function tursoUrl(value) {
  try {
    const url=new URL(clean(value));
    return ["libsql:","https:","wss:"].includes(url.protocol)&&Boolean(url.hostname)&&!url.username&&!url.password&&!url.hash&&!url.search;
  } catch { return false; }
}

function addCheck(checks,name,passed,detail) {
  checks.push({name,passed:Boolean(passed),detail});
}

function validateDeploymentEnvironment(environment=process.env,{requireEmail=false,requirePayments=false}={}) {
  const checks=[],warnings=[];
  const emailRequested=enabled(environment.EMAIL_VERIFICATION_ENABLED);
  const paymentsRequested=enabled(environment.PADDLE_CHECKOUT_ENABLED);
  const paddleEnvironment=clean(environment.PADDLE_ENVIRONMENT).toLowerCase()||"live";
  const paddleSandbox=paddleEnvironment==="sandbox";

  addCheck(checks,"runtime.production",clean(environment.NODE_ENV)==="production","NODE_ENV must be production.");
  addCheck(checks,"runtime.public-url",productionBaseUrl(environment.APP_BASE_URL),"APP_BASE_URL must be a root HTTPS URL without credentials, query data, or a fragment.");
  addCheck(checks,"storage.url",tursoUrl(environment.TURSO_DATABASE_URL),"TURSO_DATABASE_URL must be a valid libsql, HTTPS, or WSS endpoint.");
  addCheck(checks,"storage.token",configured(environment.TURSO_AUTH_TOKEN,20),"TURSO_AUTH_TOKEN must be configured.");
  addCheck(checks,"cookies.secure",enabled(environment.SECURE_COOKIES),"SECURE_COOKIES must be true for a production deployment.");
  addCheck(checks,"proxy.flag",BOOLEAN_VALUES.has(clean(environment.TRUST_PROXY).toLowerCase()),"TRUST_PROXY must be explicitly true or false.");
  addCheck(checks,"test-bypass.disabled",!enabled(environment.ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS),"ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS must not be enabled.");
  addCheck(checks,"admin.email",validEmail(environment.ADMIN_EMAIL),"ADMIN_EMAIL must be a valid mailbox.");

  if (requireEmail||emailRequested) {
    addCheck(checks,"email.enabled",emailRequested,"EMAIL_VERIFICATION_ENABLED must be true when email is required.");
    addCheck(checks,"email.api-key",validResendApiKey(environment.RESEND_API_KEY),"RESEND_API_KEY must be a non-placeholder Resend API key.");
    addCheck(checks,"email.from",Boolean(mailboxAddress(environment.EMAIL_FROM)),"EMAIL_FROM must be a valid mailbox or display-name mailbox.");
    addCheck(checks,"email.reply-to",Boolean(mailboxAddress(environment.EMAIL_REPLY_TO)),"EMAIL_REPLY_TO must be a valid mailbox.");
    addCheck(checks,"email.support",Boolean(mailboxAddress(environment.SUPPORT_EMAIL)),"SUPPORT_EMAIL must be a valid mailbox.");
    addCheck(checks,"email.verification-secret",validEmailVerificationSecret(environment.EMAIL_VERIFICATION_SECRET),"EMAIL_VERIFICATION_SECRET must be a non-placeholder secret of at least 32 characters.");
  } else warnings.push("Email verification is disabled; verification, recovery, deletion confirmation, and support delivery cannot be exercised.");

  if (requirePayments||paymentsRequested) {
    addCheck(checks,"payments.enabled",paymentsRequested,"PADDLE_CHECKOUT_ENABLED must be true when checkout is required.");
    addCheck(checks,"payments.environment",validPaddleEnvironment(paddleEnvironment,clean(environment.NODE_ENV)),"PADDLE_ENVIRONMENT must be live, or sandbox only outside production.");
    addCheck(checks,"payments.product",validPaddleProductId(environment.PADDLE_PRODUCT_ID,paddleSandbox),"PADDLE_PRODUCT_ID must identify the selected Paddle environment's product.");
    addCheck(checks,"payments.price",validPaddlePriceId(environment.PADDLE_PRICE_ID),"PADDLE_PRICE_ID must identify the recurring Paddle price.");
    addCheck(checks,"payments.legacy-prices",validPaddleLegacyRecurringPriceIds(environment.PADDLE_LEGACY_RECURRING_PRICE_IDS,environment.PADDLE_PRICE_ID),"PADDLE_LEGACY_RECURRING_PRICE_IDS must contain only distinct earlier recurring price IDs.");
    addCheck(checks,"payments.client-token",validPaddleClientToken(environment.PADDLE_CLIENT_TOKEN,paddleSandbox),"PADDLE_CLIENT_TOKEN must match the selected Paddle environment.");
    addCheck(checks,"payments.api-key",validPaddleApiKey(environment.PADDLE_API_KEY,paddleSandbox),"PADDLE_API_KEY must match the selected Paddle environment.");
    addCheck(checks,"payments.webhook-secret",validPaddleWebhookSecret(environment.PADDLE_WEBHOOK_SECRET),"PADDLE_WEBHOOK_SECRET must be a non-placeholder signing secret.");
  } else warnings.push("Paddle checkout is disabled; purchase creation and signed webhook reconciliation cannot be exercised.");

  // Polar connected devices are optional; once any Polar value is set, the whole set must be valid.
  const polarRequested=["POLAR_CLIENT_ID","POLAR_CLIENT_SECRET","DEVICE_TOKEN_KEY"].some((key)=>configured(environment[key]));
  if (polarRequested) {
    const devices=devicesSettings(environment);
    addCheck(checks,"devices.polar",devices.configured,devices.problems.join(" ")||"Polar connected devices are configured.");
    if (!configured(environment.POLAR_WEBHOOK_SECRET)) warnings.push("POLAR_WEBHOOK_SECRET is not set; Polar webhooks are rejected and connections sync once a day. Run npm run polar:webhook -- create to get it.");
  } else warnings.push("Polar connected devices are off; set POLAR_CLIENT_ID, POLAR_CLIENT_SECRET, and DEVICE_TOKEN_KEY to offer them.");

  const secrets=[
    clean(environment.TURSO_AUTH_TOKEN),clean(environment.RESEND_API_KEY),clean(environment.EMAIL_VERIFICATION_SECRET),
    clean(environment.PADDLE_CLIENT_TOKEN),clean(environment.PADDLE_API_KEY),clean(environment.PADDLE_WEBHOOK_SECRET),
    clean(environment.POLAR_CLIENT_SECRET),clean(environment.POLAR_WEBHOOK_SECRET),clean(environment.DEVICE_TOKEN_KEY),clean(environment.DEVICE_TOKEN_KEY_PREVIOUS)
  ].filter(Boolean);
  addCheck(checks,"secrets.separated",new Set(secrets).size===secrets.length,"Provider tokens and application secrets must not reuse the same value.");
  if (!enabled(environment.TRUST_PROXY)) warnings.push("TRUST_PROXY is false. This is correct only when Node receives traffic directly rather than through a trusted reverse proxy.");
  if (paddleEnvironment==="sandbox"&&paymentsRequested) warnings.push("Paddle sandbox must use an isolated non-production database and sandbox catalog identifiers.");

  const failures=checks.filter((check)=>!check.passed);
  return {
    ok:failures.length===0,
    requirements:{email:requireEmail,payments:requirePayments},
    providers:{emailRequested,paymentsRequested,paddleEnvironment},
    checks,failures:failures.map(({name,detail})=>({name,detail})),warnings
  };
}

function parseOptions(argumentsList) {
  const values=new Set(argumentsList);
  const requireAll=values.has("--require-all");
  return {requireEmail:requireAll||values.has("--require-email"),requirePayments:requireAll||values.has("--require-payments"),json:values.has("--json")};
}

function main(argumentsList=process.argv.slice(2),environment=process.env,logger=console) {
  const options=parseOptions(argumentsList),result=validateDeploymentEnvironment(environment,options);
  if (options.json) logger.log(JSON.stringify(result,null,2));
  else {
    for (const check of result.checks) logger.log(`${check.passed?"PASS":"FAIL"} ${check.name} — ${check.detail}`);
    for (const warning of result.warnings) logger.warn(`WARN ${warning}`);
    logger.log(result.ok?"Production configuration preflight passed.":`Production configuration preflight failed (${result.failures.length} check${result.failures.length===1?"":"s"}).`);
  }
  if (!result.ok) process.exitCode=1;
  return result;
}

if (require.main===module) main();

module.exports={main,parseOptions,productionBaseUrl,tursoUrl,validateDeploymentEnvironment};
