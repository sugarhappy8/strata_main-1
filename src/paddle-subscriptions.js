// @ts-check
"use strict";

const { cycleMatches, knownCycle, planForPrice } = require("./paddle-catalog");

/** @param {unknown} value */
function clean(value) {
  return String(value || "").trim();
}
/** @param {string} value @param {string} prefix */
function validId(value, prefix) {
  return new RegExp(`^${prefix}_[a-z0-9]{20,}$`).test(value);
}
/** @param {unknown} value */
function validTransactionId(value) {
  const id = clean(value);
  return /^txn_[a-z0-9]{26}$/.test(id) ? id : "";
}
/** @param {unknown} value */
function validSubscriptionId(value) {
  const id = clean(value);
  return /^sub_[a-z0-9]{26}$/.test(id) ? id : "";
}
/** @param {unknown} value */
function validCustomerId(value) {
  const id = clean(value);
  return /^ctm_[a-z0-9]{26}$/.test(id) ? id : "";
}

/** @param {number} milliseconds */
function requestSignal(milliseconds) {
  const signal =
    typeof globalThis.AbortSignal?.timeout === "function"
      ? globalThis.AbortSignal.timeout(milliseconds)
      : undefined;
  return signal ? { signal } : {};
}
/** @param {string} message @param {string} code */
function providerError(message, code) {
  return Object.assign(new Error(message), { status: 502, code });
}

/**
 * Validate the completed initial transaction that Paddle links to a Strata+ subscription. With a price ID, the
 * transaction must be for that price (the one STRATA recorded at checkout); without one, for any current plan.
 * Ownership is checked separately against the local purchase.
 * @param {import("./domain-types").PaddleTransactionData|null|undefined} data
 * @param {import("./domain-types").PaymentConfig} config
 * @param {{priceId?:unknown,productId?:unknown}} [identity]
 * @returns {import("./domain-types").ValidationResult}
 */
function validateCompletedTransaction(
  data,
  config,
  { priceId, productId = config?.productId } = {},
) {
  if (!data || data.status !== "completed") return { ok: false, reason: "status" };
  if (!validTransactionId(data.id)) return { ok: false, reason: "transaction" };
  if (data.origin !== "api") return { ok: false, reason: "origin" };
  if (!validSubscriptionId(data.subscription_id)) return { ok: false, reason: "subscription" };
  if (!validCustomerId(data.customer_id)) return { ok: false, reason: "customer" };
  if (data.collection_mode !== "automatic") return { ok: false, reason: "collection" };
  if (data.custom_data?.strata_version !== 1) return { ok: false, reason: "metadata" };
  if (!Array.isArray(data.items) || data.items.length !== 1) return { ok: false, reason: "items" };
  const item = /** @type {import("./domain-types").PaddleItemData} */ (data.items[0] || {}),
    price = item.price || {};
  if (Number(item.quantity) !== 1) return { ok: false, reason: "quantity" };
  const plan = planForPrice(config, price.id);
  if (priceId === undefined || priceId === null || priceId === "" ? !plan : price.id !== priceId)
    return { ok: false, reason: "price" };
  if (price.product_id !== productId) return { ok: false, reason: "product" };
  if (plan ? !cycleMatches(price.billing_cycle, plan) : !knownCycle(price.billing_cycle))
    return { ok: false, reason: "billing_cycle" };
  return { ok: true };
}

/**
 * Validate a complete subscription snapshot. Catalog mismatches remain valid
 * state but are not entitled, which prevents stale access after a plan change.
 * @param {import("./domain-types").PaddleSubscriptionData|null|undefined} data
 * @param {import("./domain-types").PaymentConfig} config
 * @param {import("./domain-types").SubscriptionValidationIdentity} identity
 * @returns {import("./domain-types").SubscriptionValidationResult}
 */
function validateSubscription(
  data,
  config,
  { userId, transactionId, requireTransaction = false } = {},
) {
  if (!data || !validSubscriptionId(data.id)) return { ok: false, reason: "subscription" };
  const status = clean(data.status);
  if (!["active", "trialing", "past_due", "paused", "canceled"].includes(status))
    return { ok: false, reason: "status" };
  if (data.collection_mode !== "automatic") return { ok: false, reason: "collection" };
  if (!validCustomerId(data.customer_id)) return { ok: false, reason: "customer" };
  if (clean(data.custom_data?.strata_user_id) !== clean(userId))
    return { ok: false, reason: "account" };
  if (data.custom_data?.strata_version !== 1) return { ok: false, reason: "metadata" };
  if (!knownCycle(data.billing_cycle)) return { ok: false, reason: "billing_cycle" };
  if (requireTransaction && validTransactionId(data.transaction_id) !== clean(transactionId))
    return { ok: false, reason: "transaction" };
  if (!Array.isArray(data.items) || data.items.length !== 1) return { ok: false, reason: "items" };
  const item = /** @type {import("./domain-types").PaddleSubscriptionItemData} */ (
      data.items[0] || {}
    ),
    price = item.price || {};
  if (Number(item.quantity) !== 1 || item.recurring !== true)
    return { ok: false, reason: "quantity" };
  if (!validId(clean(price.id), "pri") || !validId(clean(price.product_id), "pro"))
    return { ok: false, reason: "catalog" };
  if (!knownCycle(price.billing_cycle)) return { ok: false, reason: "billing_cycle" };
  const billing = /** @type {{interval:string,frequency:number}} */ (data.billing_cycle);
  if (
    !cycleMatches(price.billing_cycle, {
      interval: billing.interval,
      frequency: Number(billing.frequency),
    })
  )
    return { ok: false, reason: "billing_cycle" };
  const scheduled = data.scheduled_change;
  if (
    scheduled !== null &&
    scheduled !== undefined &&
    (!scheduled ||
      typeof scheduled !== "object" ||
      !["cancel", "pause", "resume"].includes(clean(scheduled.action)) ||
      !Number.isFinite(Date.parse(clean(scheduled.effective_at))))
  )
    return { ok: false, reason: "scheduled_change" };
  const periodEnd = data.current_billing_period?.ends_at;
  if (
    ["active", "trialing", "past_due"].includes(status) &&
    !Number.isFinite(Date.parse(clean(periodEnd)))
  )
    return { ok: false, reason: "billing_period" };
  // Only a current plan, billing at that plan's cadence, unlocks Strata+.
  const plan = price.product_id === config.productId ? planForPrice(config, price.id) : null;
  return {
    ok: true,
    entitled: Boolean(plan && cycleMatches(price.billing_cycle, plan)),
    subscriptionId: clean(data.id),
    customerId: clean(data.customer_id),
    status: /** @type {import("./domain-types").SubscriptionStatus} */ (status),
    priceId: clean(price.id),
    productId: clean(price.product_id),
    scheduledChangeAction: scheduled
      ? /** @type {import("./domain-types").ScheduledSubscriptionAction} */ (
          clean(scheduled.action)
        )
      : null,
    scheduledChangeAt: scheduled ? Date.parse(clean(scheduled.effective_at)) : null,
    currentPeriodEndsAt: periodEnd ? Date.parse(clean(periodEnd)) : null,
  };
}

/** @param {unknown} value */
function safePortalUrl(value) {
  let url;
  try {
    url = new URL(clean(value));
  } catch {
    return "";
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "customer-portal.paddle.com" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/cpl_")
  )
    return "";
  return url.href;
}

/**
 * Create account-bound temporary customer-portal links. The caller obtains the
 * private credentials from its non-serializable config and never persists URLs.
 * @param {import("./domain-types").PaddleSecrets|undefined} secrets
 * @param {import("./domain-types").PaddlePortalIdentity} identity
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<import("./domain-types").PaddlePortalLinks>}
 */
async function createCustomerPortalSession(
  secrets,
  { customerId, subscriptionId },
  fetchImpl = globalThis.fetch,
) {
  const customer = validCustomerId(customerId),
    subscription = validSubscriptionId(subscriptionId);
  if (!secrets?.apiKey)
    throw providerError(
      "Subscription management is temporarily unavailable.",
      "PADDLE_PORTAL_UNAVAILABLE",
    );
  if (!customer || !subscription)
    throw new TypeError("Valid customer and subscription IDs are required.");
  let response;
  try {
    response = await fetchImpl(
      `${secrets.apiBase}/customers/${encodeURIComponent(customer)}/portal-sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secrets.apiKey}`,
          "Content-Type": "application/json",
          "Paddle-Version": "1",
        },
        ...requestSignal(10_000),
        body: JSON.stringify({ subscription_ids: [subscription] }),
      },
    );
  } catch {
    throw providerError(
      "Subscription management is temporarily unavailable.",
      "PADDLE_PORTAL_UNAVAILABLE",
    );
  }
  if (!response?.ok)
    throw providerError(
      "Subscription management is temporarily unavailable.",
      "PADDLE_PORTAL_FAILED",
    );
  /** @type {{data?:import("./domain-types").PaddlePortalSessionData}|null} */
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const data = payload?.data;
  const entry = Array.isArray(data?.urls?.subscriptions)
    ? data.urls.subscriptions.find((item) => item?.id === subscription)
    : null;
  const overviewUrl = safePortalUrl(data?.urls?.general?.overview),
    cancelUrl = safePortalUrl(entry?.cancel_subscription);
  const updatePaymentMethodUrl = safePortalUrl(entry?.update_subscription_payment_method);
  if (data?.customer_id !== customer || !overviewUrl || !cancelUrl || !updatePaymentMethodUrl) {
    throw providerError(
      "Paddle returned an invalid subscription-management link.",
      "PADDLE_PORTAL_INVALID_RESPONSE",
    );
  }
  return { overviewUrl, cancelUrl, updatePaymentMethodUrl };
}

module.exports = {
  createCustomerPortalSession,
  validateCompletedTransaction,
  validateSubscription,
};
