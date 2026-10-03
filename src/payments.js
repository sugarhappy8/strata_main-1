// @ts-check
"use strict";

const {
  createCustomerPortalSession: createPortalSession,
  validateCompletedTransaction,
  validateSubscription,
} = require("./paddle-subscriptions");
const {
  verifyPaddleSignature,
  fetchPaddleIpv4Cidrs: fetchWebhookIpv4Cidrs,
  isPaddleWebhookAddress,
} = require("./paddle-webhooks");
const {
  createPaddleCheckoutRetirement,
  validateRetiredPaddleCheckoutTransaction,
} = require("./paddle-checkout-retirement");
const {
  DEFAULT_PRODUCT_ID,
  DEFAULT_PRICE_ID,
  clean,
  validPaddleEnvironment,
  validPaddleProductId,
  validPaddlePriceId,
  validPaddleClientToken,
  validPaddleApiKey,
  validPaddleWebhookSecret,
  currentPublicPrice,
  exactCurrentCheckoutPrice,
} = require("./paddle-catalog");

const LIVE_API_BASE = "https://api.paddle.com";
const SANDBOX_API_BASE = "https://sandbox-api.paddle.com";
const TRANSACTION_STATUSES = new Set([
  "draft",
  "ready",
  "billed",
  "paid",
  "completed",
  "canceled",
  "past_due",
]);
const CREATED_TRANSACTION_STATUSES = new Set(["draft", "ready"]);
const CHECKOUT_RECOVERY_CLOCK_SKEW_MS = 60_000;
const CHECKOUT_RECOVERY_WINDOW_MS = 5 * 60_000;
/** @type {WeakMap<import("./domain-types").PaymentConfig,import("./domain-types").PaddleSecrets>} */
const secretsByConfig = new WeakMap();

/** @param {number} milliseconds */
function timeoutSignal(milliseconds) {
  return typeof globalThis.AbortSignal?.timeout === "function"
    ? globalThis.AbortSignal.timeout(milliseconds)
    : undefined;
}
/** @param {number} milliseconds @returns {Pick<RequestInit,"signal">} */
function requestSignal(milliseconds) {
  const signal = timeoutSignal(milliseconds);
  return signal ? { signal } : {};
}

/** @param {NodeJS.ProcessEnv} env @returns {import("./domain-types").PaymentConfig} */
function getPaymentConfig(env = process.env) {
  const requestedEnvironment = clean(env.PADDLE_ENVIRONMENT).toLowerCase() || "live";
  const sandbox = requestedEnvironment === "sandbox";
  const environment = sandbox ? "sandbox" : "live";
  // Sandbox entitlements must never be written to a production application.
  const environmentAllowed = validPaddleEnvironment(requestedEnvironment, env.NODE_ENV);
  // Both current catalog IDs are deployment-owned. Falling back to the
  // retired product could make a newly configured price look locally valid
  // while Paddle correctly rejects the mismatched pair.
  const productId = clean(env.PADDLE_PRODUCT_ID);
  // A recurring price has a different Paddle catalog ID from the retired
  // one-time price. Require the deployment to supply that ID explicitly.
  const priceId = clean(env.PADDLE_PRICE_ID);
  const clientToken = clean(env.PADDLE_CLIENT_TOKEN);
  const apiKey = clean(env.PADDLE_API_KEY);
  const webhookSecret = clean(env.PADDLE_WEBHOOK_SECRET);
  const requestedEnabled = clean(env.PADDLE_CHECKOUT_ENABLED).toLowerCase() === "true";
  const validClientToken = validPaddleClientToken(clientToken, sandbox);
  const validApiKey = validPaddleApiKey(apiKey, sandbox);
  const validWebhookSecret = validPaddleWebhookSecret(webhookSecret);
  // The previous live price is a one-time catalog item. It must never be
  // accepted for new recurring checkouts, even when supplied explicitly.
  const validCatalog = validPaddleProductId(productId, sandbox) && validPaddlePriceId(priceId);
  const configured =
    environmentAllowed && validClientToken && validApiKey && validWebhookSecret && validCatalog;
  /** @type {string[]} */
  const missing = [];
  if (!environmentAllowed)
    missing.push("supported payment environment (sandbox is non-production only)");
  if (!validClientToken) missing.push(`${environment} client-side token`);
  if (!validApiKey) missing.push(`${environment} API key`);
  if (!validWebhookSecret) missing.push("webhook signing secret");
  if (!validCatalog) missing.push(`valid ${environment} catalog IDs`);

  // Deliberately contains browser-safe fields only. Server credentials live in
  // a private WeakMap so they cannot be serialized into a response by mistake.
  /** @type {import("./domain-types").PaymentConfig} */
  const config = {
    environment,
    productId,
    priceId,
    clientToken: environmentAllowed && validClientToken ? clientToken : "",
    price: currentPublicPrice(),
    requestedEnabled,
    configured,
    enabled: requestedEnabled && configured,
    missing,
  };
  let apiBase = sandbox ? SANDBOX_API_BASE : LIVE_API_BASE;
  if (env.NODE_ENV === "test" && clean(env.PADDLE_API_BASE)) apiBase = clean(env.PADDLE_API_BASE);
  secretsByConfig.set(config, {
    apiKey: environmentAllowed && validApiKey ? apiKey : "",
    webhookSecret: environmentAllowed && validWebhookSecret ? webhookSecret : "",
    apiBase,
  });
  return Object.freeze(config);
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @returns {import("./domain-types").PublicPaymentConfig}
 */
function publicPaymentConfig(config) {
  return {
    environment: config.environment,
    enabled: config.enabled,
    configured: config.configured,
    productId: config.productId,
    priceId: config.priceId,
    clientToken: config.clientToken,
    price: { ...config.price },
  };
}

/** @param {import("./domain-types").PaymentConfig} config */
function webhookSecretFor(config) {
  return secretsByConfig.get(config)?.webhookSecret || "";
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {import("./domain-types").CheckoutIdentity} identity
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<import("./domain-types").PaddleTransactionResult>}
 */
async function createPaddleTransaction(
  config,
  { userId, checkoutId } = {},
  fetchImpl = globalThis.fetch,
) {
  const secrets = secretsByConfig.get(config);
  if (!config?.enabled || !secrets?.apiKey) {
    throw Object.assign(new Error("Checkout is not available yet."), {
      status: 503,
      code: "CHECKOUT_UNAVAILABLE",
    });
  }
  if (!userId)
    throw Object.assign(new Error("Sign in required."), { status: 401, code: "SIGN_IN_REQUIRED" });
  if (!clean(checkoutId)) throw new TypeError("A checkout reference is required.");
  let response;
  try {
    response = await fetchImpl(`${secrets.apiBase}/transactions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secrets.apiKey}`,
        "Content-Type": "application/json",
        "Paddle-Version": "1",
      },
      ...requestSignal(10_000),
      body: JSON.stringify({
        items: [{ price_id: config.priceId, quantity: 1 }],
        collection_mode: "automatic",
        custom_data: {
          strata_user_id: userId,
          ...(checkoutId ? { strata_checkout_id: checkoutId } : {}),
          strata_version: 1,
        },
      }),
    });
  } catch {
    throw Object.assign(new Error("Paddle could not be reached. Please try again."), {
      status: 502,
      code: "PADDLE_UNAVAILABLE",
    });
  }
  if (!response?.ok) {
    throw Object.assign(new Error("Checkout could not be prepared. Please try again."), {
      status: 502,
      code: "PADDLE_REQUEST_FAILED",
    });
  }
  /** @type {{data?:import("./domain-types").PaddleTransactionData}|null} */
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const transactionId = validTransactionId(payload?.data?.id);
  const status = clean(payload?.data?.status);
  const validation = validateCheckoutTransaction(payload?.data, config, { userId, checkoutId });
  if (
    !transactionId ||
    !CREATED_TRANSACTION_STATUSES.has(status) ||
    !validation.ok ||
    !exactCurrentCheckoutPrice(payload?.data)
  ) {
    throw Object.assign(new Error("Checkout could not be prepared. Please try again."), {
      status: 502,
      code: "PADDLE_INVALID_RESPONSE",
    });
  }
  return { transactionId, status };
}

/** @param {unknown} value */
function validTransactionId(value) {
  const id = clean(value);
  return /^txn_[a-z0-9]{26}$/.test(id) ? id : "";
}

/** @param {unknown} value */
function monthlyCycle(value) {
  if (!value || typeof value !== "object") return false;
  const cycle = /** @type {{interval?:unknown;frequency?:unknown}} */ (value);
  return cycle.interval === "month" && Number(cycle.frequency) === 1;
}

/** @param {string} message @param {string} code */
function paddleTransactionError(message, code) {
  return Object.assign(new Error(message), { status: 502, code });
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {unknown} transactionId
 * @param {{method?:string,body?:unknown,fetchImpl?:import("./domain-types").FetchLike}} options
 * @returns {Promise<import("./domain-types").PaddleFetchedTransactionResult>}
 */
async function paddleTransactionRequest(
  config,
  transactionId,
  { method = "GET", body, fetchImpl = globalThis.fetch } = {},
) {
  const secrets = secretsByConfig.get(config);
  const id = validTransactionId(transactionId);
  if (!secrets?.apiKey)
    throw paddleTransactionError(
      "Paddle transaction status is temporarily unavailable.",
      "PADDLE_RECONCILIATION_UNAVAILABLE",
    );
  if (!id) throw new TypeError("A valid Paddle transaction ID is required.");
  /** @type {Record<string,string>} */
  const headers = { Authorization: `Bearer ${secrets.apiKey}`, "Paddle-Version": "1" };
  /** @type {RequestInit} */
  const options = {
    method,
    headers,
    ...requestSignal(10_000),
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(
      `${secrets.apiBase}/transactions/${encodeURIComponent(id)}`,
      options,
    );
  } catch {
    throw paddleTransactionError(
      "Paddle transaction status is temporarily unavailable.",
      "PADDLE_RECONCILIATION_UNAVAILABLE",
    );
  }
  if (!response?.ok)
    throw paddleTransactionError(
      "Paddle transaction status could not be confirmed.",
      "PADDLE_RECONCILIATION_FAILED",
    );
  /** @type {{data?:import("./domain-types").PaddleTransactionData}|null} */
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const data = payload?.data;
  const returnedId = validTransactionId(data?.id);
  const status = clean(data?.status);
  if (!data || returnedId !== id || !TRANSACTION_STATUSES.has(status)) {
    throw paddleTransactionError(
      "Paddle returned an invalid transaction status.",
      "PADDLE_RECONCILIATION_INVALID_RESPONSE",
    );
  }
  return { transactionId: returnedId, status, data };
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {unknown} transactionId
 * @param {import("./domain-types").FetchLike} fetchImpl
 */
async function fetchPaddleTransaction(config, transactionId, fetchImpl = globalThis.fetch) {
  return paddleTransactionRequest(config, transactionId, { fetchImpl });
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {unknown} transactionId
 * @param {import("./domain-types").FetchLike} fetchImpl
 */
async function cancelPaddleTransaction(config, transactionId, fetchImpl = globalThis.fetch) {
  const transaction = await paddleTransactionRequest(config, transactionId, {
    method: "PATCH",
    body: { status: "canceled" },
    fetchImpl,
  });
  if (transaction.status !== "canceled") {
    throw paddleTransactionError(
      "Paddle did not cancel the abandoned checkout.",
      "PADDLE_RECONCILIATION_FAILED",
    );
  }
  return { transactionId: transaction.transactionId, status: transaction.status };
}

/** @param {import("./domain-types").PaddleTransactionData|null|undefined} data @param {import("./domain-types").PaymentConfig} config @param {import("./domain-types").CheckoutIdentity} identity */
function validateCheckoutTransaction(
  data,
  config,
  { userId, checkoutId, priceId = config?.priceId, productId = config?.productId } = {},
) {
  if (!data || !validTransactionId(data.id) || !TRANSACTION_STATUSES.has(clean(data.status)))
    return { ok: false, reason: "transaction" };
  if (data.origin !== "api") return { ok: false, reason: "origin" };
  if (data.subscription_id != null) return { ok: false, reason: "subscription" };
  if (data.collection_mode !== "automatic") return { ok: false, reason: "collection" };
  if (clean(data.custom_data?.strata_user_id) !== clean(userId))
    return { ok: false, reason: "account" };
  if (clean(data.custom_data?.strata_checkout_id) !== clean(checkoutId))
    return { ok: false, reason: "checkout" };
  if (data.custom_data?.strata_version !== 1) return { ok: false, reason: "metadata" };
  if (!Array.isArray(data.items) || data.items.length !== 1) return { ok: false, reason: "items" };
  const item = /** @type {import("./domain-types").PaddleItemData} */ (data.items[0] || {}),
    price = item.price || {};
  if (Number(item.quantity) !== 1) return { ok: false, reason: "quantity" };
  if (price.id !== priceId) return { ok: false, reason: "price" };
  if (price.product_id !== productId) return { ok: false, reason: "product" };
  return monthlyCycle(price.billing_cycle) ? { ok: true } : { ok: false, reason: "billing_cycle" };
}

/** @param {import("./domain-types").PaddleTransactionData|null|undefined} data @param {import("./domain-types").PaymentConfig} config @param {import("./domain-types").CheckoutIdentity} identity */
function validateCheckoutRecoveryTransaction(data, config, identity = {}) {
  if (data?.status !== "completed") return validateCheckoutTransaction(data, config, identity);
  const completed = validateCompletedTransaction(data, {
    ...config,
    priceId: String(identity.priceId || config?.priceId || ""),
    productId: String(identity.productId || config?.productId || ""),
  });
  if (!completed.ok) return completed;
  if (clean(data.custom_data?.strata_user_id) !== clean(identity.userId))
    return { ok: false, reason: "account" };
  return clean(data.custom_data?.strata_checkout_id) === clean(identity.checkoutId)
    ? { ok: true }
    : { ok: false, reason: "checkout" };
}

const { retirePaddleDraftTransaction, validateCheckoutTransactionForRetirement } =
  createPaddleCheckoutRetirement({
    transactionRequest: paddleTransactionRequest,
    transactionError: paddleTransactionError,
    validateTransaction: validateCheckoutTransaction,
  });

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {import("./domain-types").CheckoutRecoveryIdentity} identity
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<import("./domain-types").PaddleFetchedTransactionResult|null>}
 */
async function findPaddleCheckoutTransaction(
  config,
  {
    userId,
    checkoutId,
    createdAt,
    priceId = config?.priceId,
    productId = config?.productId,
    retirement = false,
  } = {},
  fetchImpl = globalThis.fetch,
) {
  const secrets = secretsByConfig.get(config);
  if (!secrets?.apiKey)
    throw paddleTransactionError(
      "Paddle transaction status is temporarily unavailable.",
      "PADDLE_RECONCILIATION_UNAVAILABLE",
    );
  const referenceTime = Number(createdAt);
  const windowStart = Math.max(0, referenceTime - CHECKOUT_RECOVERY_CLOCK_SKEW_MS);
  const windowEnd = referenceTime + CHECKOUT_RECOVERY_WINDOW_MS;
  if (
    !clean(userId) ||
    !clean(checkoutId) ||
    !Number.isFinite(referenceTime) ||
    referenceTime < 0 ||
    !Number.isFinite(new Date(windowEnd).getTime())
  ) {
    throw new TypeError("A checkout reference is required.");
  }
  const base = new URL(`${secrets.apiBase.replace(/\/$/, "")}/transactions`);
  base.searchParams.set("created_at[GTE]", new Date(windowStart).toISOString());
  base.searchParams.set("created_at[LTE]", new Date(windowEnd).toISOString());
  base.searchParams.set("origin", "api");
  base.searchParams.set("collection_mode", "automatic");
  base.searchParams.set("order_by", "created_at[ASC]");
  base.searchParams.set("per_page", "30");
  let pageUrl = new URL(base);
  const visitedPages = new Set();
  while (true) {
    if (visitedPages.has(pageUrl.href)) {
      throw paddleTransactionError(
        "Paddle returned a repeated transaction page.",
        "PADDLE_RECONCILIATION_INVALID_RESPONSE",
      );
    }
    visitedPages.add(pageUrl.href);
    let response;
    try {
      response = await fetchImpl(pageUrl, {
        headers: {
          Authorization: `Bearer ${secrets.apiKey}`,
          "Paddle-Version": "1",
          "Skip-Count": "true",
        },
        ...requestSignal(10_000),
      });
    } catch {
      throw paddleTransactionError(
        "Paddle transaction status is temporarily unavailable.",
        "PADDLE_RECONCILIATION_UNAVAILABLE",
      );
    }
    if (!response?.ok)
      throw paddleTransactionError(
        "Paddle transaction status could not be confirmed.",
        "PADDLE_RECONCILIATION_FAILED",
      );
    /** @type {{data?:import("./domain-types").PaddleTransactionData[],meta?:{pagination?:{has_more?:unknown,next?:unknown}}}|null} */
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!Array.isArray(payload?.data))
      throw paddleTransactionError(
        "Paddle returned an invalid transaction list.",
        "PADDLE_RECONCILIATION_INVALID_RESPONSE",
      );
    const match = payload.data.find((transaction) => {
      const transactionTime = Date.parse(clean(transaction?.created_at));
      const standard = validateCheckoutRecoveryTransaction(transaction, config, {
        userId,
        checkoutId,
        priceId,
        productId,
      });
      const validation =
        retirement && !standard.ok
          ? validateCheckoutTransactionForRetirement(transaction, config, {
              userId,
              checkoutId,
              priceId,
            })
          : standard;
      const currentUnfinished =
        priceId === config.priceId &&
        productId === config.productId &&
        ["draft", "ready"].includes(clean(transaction?.status));
      return (
        Number.isFinite(transactionTime) &&
        transactionTime >= windowStart &&
        transactionTime <= windowEnd &&
        validation.ok &&
        (!currentUnfinished || exactCurrentCheckoutPrice(transaction))
      );
    });
    if (match)
      return {
        transactionId: validTransactionId(match.id),
        status: clean(match.status),
        data: match,
      };
    const pagination = payload?.meta?.pagination;
    if (typeof pagination?.has_more !== "boolean") {
      throw paddleTransactionError(
        "Paddle returned invalid transaction pagination.",
        "PADDLE_RECONCILIATION_INVALID_RESPONSE",
      );
    }
    if (!pagination.has_more) return null;
    const nextValue = clean(pagination.next);
    /** @type {URL|null} */
    let next;
    try {
      next = new URL(nextValue, base);
    } catch {
      next = null;
    }
    const cursors = next?.searchParams.getAll("after") || [];
    const cursor = cursors.length === 1 ? clean(cursors[0]) : "";
    if (
      !next ||
      next.origin !== base.origin ||
      next.pathname !== base.pathname ||
      next.username ||
      next.password ||
      next.hash ||
      !cursor ||
      cursor.length > 512
    ) {
      throw paddleTransactionError(
        "Paddle returned an invalid transaction page.",
        "PADDLE_RECONCILIATION_INVALID_RESPONSE",
      );
    }
    pageUrl = new URL(base);
    pageUrl.searchParams.set("after", cursor);
  }
}

/**
 * @param {import("./domain-types").PaymentConfig} config
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<string[]>}
 */
async function fetchPaddleIpv4Cidrs(config, fetchImpl = globalThis.fetch) {
  return fetchWebhookIpv4Cidrs(secretsByConfig.get(config), fetchImpl);
}

/**
 * Create short-lived, account-bound Paddle customer-portal links. These URLs
 * are returned directly and deliberately never persisted.
 * @param {import("./domain-types").PaymentConfig} config
 * @param {{customerId:unknown;subscriptionId:unknown}} identity
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<import("./domain-types").PaddlePortalLinks>}
 */
async function createCustomerPortalSession(
  config,
  { customerId, subscriptionId },
  fetchImpl = globalThis.fetch,
) {
  return createPortalSession(
    secretsByConfig.get(config),
    { customerId, subscriptionId },
    fetchImpl,
  );
}

/**
 * @param {import("./domain-types").PaddleAdjustmentData|null|undefined} data
 * @returns {{transactionId:string,reason:"refund"|"chargeback"}|null}
 */
function fullRevocationFromAdjustment(data) {
  if (!data || data.status !== "approved" || data.type !== "full") return null;
  if (data.action !== "refund" && data.action !== "chargeback") return null;
  const transactionId = validTransactionId(data.transaction_id);
  if (!transactionId) return null;
  return { transactionId, reason: data.action };
}

module.exports = {
  DEFAULT_PRODUCT_ID,
  DEFAULT_PRICE_ID,
  LIVE_API_BASE,
  SANDBOX_API_BASE,
  getPaymentConfig,
  validPaddleEnvironment,
  validPaddleProductId,
  validPaddlePriceId,
  validPaddleClientToken,
  validPaddleApiKey,
  validPaddleWebhookSecret,
  exactCurrentCheckoutPrice,
  publicPaymentConfig,
  webhookSecretFor,
  verifyPaddleSignature,
  createPaddleTransaction,
  fetchPaddleTransaction,
  cancelPaddleTransaction,
  retirePaddleDraftTransaction,
  validateRetiredPaddleCheckoutTransaction,
  validateCheckoutTransaction,
  validateCheckoutTransactionForRetirement,
  validateCheckoutRecoveryTransaction,
  findPaddleCheckoutTransaction,
  fetchPaddleIpv4Cidrs,
  isPaddleWebhookAddress,
  validateCompletedTransaction,
  validateSubscription,
  createCustomerPortalSession,
  fullRevocationFromAdjustment,
};
