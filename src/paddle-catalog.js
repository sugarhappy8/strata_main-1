// @ts-check
"use strict";

// Live IDs of the retired Build 7.4 one-time price. They are configuration guards only: that price
// is never accepted as a checkout price, and the live product is refused in sandbox.
const DEFAULT_PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const DEFAULT_PRICE_ID = "pri_01m1kyc2zd313d7a3ssmg02424";
// Strata+ sells one membership on two plans. Each plan's Paddle price ID comes from the deployment
// (PADDLE_PRICE_ID, PADDLE_YEARLY_PRICE_ID); the amount and cadence are fixed here, so a checkout fails closed
// when Paddle's price does not match what the pricing page and terms say.
const PLANS = Object.freeze({
  monthly: Object.freeze({
    key: "monthly",
    amount: "4.99",
    minorUnits: "499",
    currency: "USD",
    interval: "month",
    frequency: 1,
  }),
  yearly: Object.freeze({
    key: "yearly",
    amount: "29.99",
    minorUnits: "2999",
    currency: "USD",
    interval: "year",
    frequency: 1,
  }),
});
const CURRENT_PRICE_AMOUNT = PLANS.monthly.amount;
const CURRENT_PRICE_MINOR_UNITS = PLANS.monthly.minorUnits;
const CURRENT_PRICE_CURRENCY = PLANS.monthly.currency;

/** @param {unknown} value */
function clean(value) {
  return String(value || "").trim();
}
/** @param {string} value @param {string} prefix */
function validId(value, prefix) {
  return new RegExp(`^${prefix}_[a-z0-9]{20,}$`).test(value);
}
/** @param {unknown} value */
function placeholderCredential(value) {
  return /replace[-_ ]?with|<[^>]+>|your[-_ ]?(?:private|secret|key)/i.test(String(value || ""));
}
/** @param {unknown} value @param {string|undefined} nodeEnv */
function validPaddleEnvironment(value, nodeEnv) {
  const environment = clean(value).toLowerCase();
  return (
    ["live", "sandbox"].includes(environment) &&
    !(environment === "sandbox" && nodeEnv === "production")
  );
}
/** @param {unknown} value @param {boolean} [sandbox] */
function validPaddleProductId(value, sandbox = false) {
  const id = clean(value);
  return validId(id, "pro") && (!sandbox || id !== DEFAULT_PRODUCT_ID);
}
/** @param {unknown} value */
function validPaddlePriceId(value) {
  const id = clean(value);
  return validId(id, "pri") && id !== DEFAULT_PRICE_ID;
}
/** @param {unknown} value @param {boolean} [sandbox] */
function validPaddleClientToken(value, sandbox = false) {
  const token = clean(value);
  return (
    token.startsWith(sandbox ? "test_" : "live_") &&
    token.length >= 20 &&
    (sandbox || !/sandbox|sdbx/i.test(token)) &&
    !placeholderCredential(token)
  );
}
/** @param {unknown} value @param {boolean} [sandbox] */
function validPaddleApiKey(value, sandbox = false) {
  const key = clean(value);
  return (
    key.startsWith(sandbox ? "pdl_sdbx_apikey_" : "pdl_live_apikey_") &&
    key.length >= 40 &&
    (sandbox || !/sandbox|sdbx/i.test(key)) &&
    !placeholderCredential(key)
  );
}
/** @param {unknown} value */
function validPaddleWebhookSecret(value) {
  const secret = clean(value);
  return secret.startsWith("pdl_ntfset_") && secret.length >= 20 && !placeholderCredential(secret);
}
/** @param {import("./domain-types").PlanDefinition} plan @returns {import("./domain-types").PaymentPrice} */
function publicPrice(plan) {
  return {
    amount: plan.amount,
    currency: plan.currency,
    interval: plan.interval,
    frequency: plan.frequency,
  };
}
/** The monthly plan's public price, kept for clients that read one price. */
function currentPublicPrice() {
  return publicPrice(PLANS.monthly);
}
/**
 * The plans a deployment sells: monthly always, yearly only when its price ID is configured.
 * @param {string} priceId @param {string} yearlyPriceId @returns {readonly import("./domain-types").ConfiguredPlan[]}
 */
function configuredPlans(priceId, yearlyPriceId) {
  return Object.freeze(
    [
      { ...PLANS.monthly, priceId },
      ...(yearlyPriceId ? [{ ...PLANS.yearly, priceId: yearlyPriceId }] : []),
    ].map((plan) => Object.freeze(plan)),
  );
}
/** @param {{plans?:readonly import("./domain-types").ConfiguredPlan[]}|null|undefined} config @param {unknown} priceId */
function planForPrice(config, priceId) {
  const id = clean(priceId);
  return (id && config?.plans?.find((plan) => plan.priceId === id)) || null;
}
/** @param {{plans?:readonly import("./domain-types").ConfiguredPlan[]}|null|undefined} config @param {unknown} key */
function planForKey(config, key) {
  return config?.plans?.find((plan) => plan.key === clean(key)) || null;
}
/** @param {unknown} value @param {{interval:string,frequency:number}} plan */
function cycleMatches(value, plan) {
  const cycle = /** @type {{interval?:unknown;frequency?:unknown}|null} */ (
    value && typeof value === "object" ? value : null
  );
  return cycle?.interval === plan.interval && Number(cycle?.frequency) === plan.frequency;
}
/**
 * A cadence one of the plans uses. An unknown price still has to bill monthly or yearly to be recognised.
 * @param {unknown} value
 */
function knownCycle(value) {
  return Object.values(PLANS).some((plan) => cycleMatches(value, plan));
}
/**
 * Confirm the checkout item is one of the deployment's plans and carries that plan's exact amount, currency, and
 * cadence. The product and the account are validated separately.
 * @param {import("./domain-types").PaddleTransactionData|null|undefined} data
 * @param {{plans?:readonly import("./domain-types").ConfiguredPlan[]}|null|undefined} config
 */
function exactCurrentCheckoutPrice(data, config) {
  if (!Array.isArray(data?.items) || data.items.length !== 1) return false;
  const price = data.items[0]?.price,
    plan = planForPrice(config, price?.id),
    unitPrice = price?.unit_price;
  return Boolean(
    plan &&
    String(unitPrice?.amount || "") === plan.minorUnits &&
    unitPrice?.currency_code === plan.currency &&
    cycleMatches(price?.billing_cycle, plan),
  );
}

module.exports = {
  DEFAULT_PRODUCT_ID,
  DEFAULT_PRICE_ID,
  PLANS,
  CURRENT_PRICE_AMOUNT,
  CURRENT_PRICE_MINOR_UNITS,
  CURRENT_PRICE_CURRENCY,
  clean,
  validPaddleEnvironment,
  validPaddleProductId,
  validPaddlePriceId,
  validPaddleClientToken,
  validPaddleApiKey,
  validPaddleWebhookSecret,
  configuredPlans,
  currentPublicPrice,
  cycleMatches,
  exactCurrentCheckoutPrice,
  knownCycle,
  planForKey,
  planForPrice,
  publicPrice,
};
