// @ts-check
"use strict";

const DEFAULT_PRODUCT_ID = "pro_01m1ky8j916ybyacs836dxbz8x";
const DEFAULT_PRICE_ID = "pri_01m1kyc2zd313d7a3ssmg02424";
const CURRENT_PRICE_AMOUNT = "2.99";
const CURRENT_PRICE_MINOR_UNITS = "299";
const CURRENT_PRICE_CURRENCY = "USD";

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
/**
 * Parse a bounded, unique allowlist of earlier recurring prices. The current
 * and retired one-time prices are deliberately rejected.
 * @param {unknown} value
 * @param {string} currentPriceId
 * @returns {{ids:string[];valid:boolean}}
 */
function parseLegacyRecurringPriceIds(value, currentPriceId) {
  const raw = clean(value);
  if (!raw) return { ids: [], valid: true };
  const ids = raw.split(",").map(clean),
    unique = new Set(ids);
  const valid =
    ids.length <= 20 &&
    ids.length === unique.size &&
    ids.every((id) => validPaddlePriceId(id) && id !== currentPriceId);
  return { ids: valid ? ids : [], valid };
}
/** @param {unknown} value @param {unknown} currentPriceId */
function validPaddleLegacyRecurringPriceIds(value, currentPriceId) {
  return parseLegacyRecurringPriceIds(value, clean(currentPriceId)).valid;
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
/** @returns {import("./domain-types").PaymentPrice} */
function currentPublicPrice() {
  return {
    amount: CURRENT_PRICE_AMOUNT,
    currency: CURRENT_PRICE_CURRENCY,
    interval: "month",
    frequency: 1,
  };
}
/**
 * Confirm the checkout item carries the exact public amount and currency.
 * Catalog IDs and billing cadence are validated separately.
 * @param {import("./domain-types").PaddleTransactionData|null|undefined} data
 */
function exactCurrentCheckoutPrice(data) {
  if (!Array.isArray(data?.items) || data.items.length !== 1) return false;
  const unitPrice = data.items[0]?.price?.unit_price;
  return (
    String(unitPrice?.amount || "") === CURRENT_PRICE_MINOR_UNITS &&
    unitPrice?.currency_code === CURRENT_PRICE_CURRENCY
  );
}

/** @param {import("./domain-types").SubscriptionRow} existing @param {import("./domain-types").PurchaseRow|null} purchase @param {Extract<import("./domain-types").SubscriptionValidationResult,{ok:true}>} next @param {import("./domain-types").PaymentConfig} config */
function subscriptionCatalogTransition(existing, purchase, next, config) {
  if (purchase?.price_id === next.priceId && purchase.product_id === next.productId)
    return existing.price_id === next.priceId && existing.product_id === next.productId
      ? "same"
      : "restore";
  const current = next.priceId === config.priceId && next.productId === config.productId;
  const legacy =
    purchase?.product_id === config.productId &&
    config.legacyRecurringPriceIds.includes(purchase.price_id);
  if (legacy && current) return "migrate";
  if (next.productId === config.productId && config.legacyRecurringPriceIds.includes(next.priceId))
    return "reject";
  return existing.price_id === next.priceId && existing.product_id === next.productId
    ? "same"
    : "change";
}

module.exports = {
  DEFAULT_PRODUCT_ID,
  DEFAULT_PRICE_ID,
  CURRENT_PRICE_AMOUNT,
  CURRENT_PRICE_MINOR_UNITS,
  CURRENT_PRICE_CURRENCY,
  clean,
  validPaddleEnvironment,
  validPaddleProductId,
  validPaddlePriceId,
  parseLegacyRecurringPriceIds,
  validPaddleLegacyRecurringPriceIds,
  validPaddleClientToken,
  validPaddleApiKey,
  validPaddleWebhookSecret,
  currentPublicPrice,
  exactCurrentCheckoutPrice,
  subscriptionCatalogTransition,
};
