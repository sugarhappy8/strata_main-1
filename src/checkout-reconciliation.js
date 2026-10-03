// @ts-check
"use strict";
const {
  fetchPaddleTransaction,
  cancelPaddleTransaction,
  retirePaddleDraftTransaction,
  validateRetiredPaddleCheckoutTransaction,
  validateCheckoutTransaction,
  validateCheckoutTransactionForRetirement,
  validateCheckoutRecoveryTransaction,
  validateCompletedTransaction,
  exactCurrentCheckoutPrice,
} = require("./payments");
const { cleanText } = require("./plans");
const ABANDONED_CHECKOUT_MS = 30 * 60 * 1000,
  MAX_DELETION_RECONCILIATIONS = 8;
const PADDLE_CANCELABLE_STALE_STATUSES = new Set(["ready", "billed"]);
/** @param {unknown} value @param {number} fallback */
const eventTime = (value, fallback) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};
/** @param {{store:import("./domain-types").BillingStore;paymentConfig:import("./domain-types").PaymentConfig;now:()=>number;authService:()=>import("./domain-types").AuthService}} dependencies */
function createCheckoutReconciliation({ store, paymentConfig, now, authService }) {
  /** @param {{price_id:string;product_id:string}} purchase */
  function currentPurchase(purchase) {
    return (
      purchase.product_id === paymentConfig.productId && purchase.price_id === paymentConfig.priceId
    );
  }
  // A draft or ready checkout must also carry the exact public price, not only the price ID.
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {string} userId @param {string} checkoutId */
  function currentCheckout(remote, userId, checkoutId) {
    return (
      validateCheckoutRecoveryTransaction(remote.data, paymentConfig, { userId, checkoutId }).ok &&
      (!["draft", "ready"].includes(remote.status) || exactCurrentCheckoutPrice(remote.data))
    );
  }
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {import("./domain-types").PurchaseRow} purchase */
  function validatePurchaseCheckoutForCancellation(remote, purchase) {
    return validateCheckoutTransaction(remote.data, paymentConfig, {
      userId: purchase.user_id,
      checkoutId: String(remote.data.custom_data?.strata_checkout_id || "").trim(),
      priceId: purchase.price_id,
      productId: purchase.product_id,
    });
  }
  /** @param {string} userId @param {{reuseDraft?:boolean;includeFresh?:boolean;checkSubscription?:boolean;transactionIds?:string[]}} [options] */
  async function reconcileUnsettledPurchases(
    userId,
    { reuseDraft = false, includeFresh = false, checkSubscription = true, transactionIds } = {},
  ) {
    const subscription = await store.subscriptionForUser(userId);
    if (
      checkSubscription &&
      subscription &&
      ["active", "trialing", "past_due", "paused"].includes(subscription.status)
    ) {
      const cancelAt = Number(subscription.scheduled_change_at);
      const scheduled =
        subscription.scheduled_change_action === "cancel" &&
        Number.isSafeInteger(cancelAt) &&
        cancelAt > 0
          ? ` It remains active until ${new Date(cancelAt).toISOString()}.`
          : subscription.status === "paused"
            ? " It can still resume billing, so cancel it from subscription management first."
            : " Cancel it from subscription management first.";
      throw authService().accountActionError(
        `Your Strata+ monthly subscription has not ended.${scheduled} Nothing was deleted.`,
        409,
        "SUBSCRIPTION_ACTIVE",
      );
    }
    const purchases = await store.unsettledPurchasesForUser(userId);
    const timestamp = now();
    const staleBefore = timestamp - ABANDONED_CHECKOUT_MS;
    const stale = purchases
      .filter(
        (purchase) =>
          (!transactionIds || transactionIds.includes(purchase.transaction_id)) &&
          (includeFresh ||
            purchase.paddle_status === "past_due" ||
            Number(purchase.updated_at) <= staleBefore),
      )
      .sort(
        (a, b) =>
          Number(["draft", "paid", "past_due"].includes(a.paddle_status)) -
          Number(["draft", "paid", "past_due"].includes(b.paddle_status)),
      )
      .slice(0, MAX_DELETION_RECONCILIATIONS);
    const reconciled = await Promise.allSettled(
      stale.map(async (purchase) => {
        // Only a checkout on the current catalog can be reused. One on any other price (an earlier
        // monthly price, the retired one-time price) is switched off like an abandoned one, after it is
        // checked against the price and product STRATA recorded for it.
        const current = currentPurchase(purchase),
          reuse = reuseDraft && current;
        let remote;
        try {
          remote = await fetchPaddleTransaction(paymentConfig, purchase.transaction_id);
        } catch {
          throw authService().accountActionError(
            "STRATA could not safely confirm an older Strata+ checkout. Please try again later.",
            503,
            "PURCHASE_RECONCILIATION_UNAVAILABLE",
          );
        }
        const reconciledAt = Math.max(now(), Number(purchase.updated_at) + 1);
        const checkoutId = cleanText(remote.data.custom_data?.strata_checkout_id, 100);
        const retirementValidation = validateCheckoutTransactionForRetirement(
          remote.data,
          paymentConfig,
          {
            userId: purchase.user_id,
            checkoutId,
            priceId: purchase.price_id,
            productId: purchase.product_id,
          },
        );
        if (validateRetiredPaddleCheckoutTransaction(remote.data).ok) {
          await store.revokePurchase(
            purchase.transaction_id,
            "checkout_disabled",
            reconciledAt,
            reconciledAt,
          );
          return;
        }
        if (remote.status === "canceled") {
          const validation = reuse
            ? validatePurchaseCheckoutForCancellation(remote, purchase)
            : retirementValidation;
          if (!validation.ok)
            throw authService().accountActionError(
              "STRATA could not safely validate an abandoned Strata+ checkout. Please contact support.",
              503,
              "PURCHASE_RECONCILIATION_INVALID",
            );
          await store.updatePurchaseStatus(purchase.transaction_id, "canceled", reconciledAt);
          return;
        }
        if (remote.status === "draft") {
          if (reuse) {
            if (!exactCurrentCheckoutPrice(remote.data))
              throw authService().accountActionError(
                "STRATA could not safely validate the current checkout price. Please contact support.",
                503,
                "PURCHASE_RECONCILIATION_INVALID",
              );
          } else {
            if (!retirementValidation.ok)
              throw authService().accountActionError(
                "STRATA could not safely validate an abandoned Strata+ checkout. Please contact support.",
                503,
                "PURCHASE_RECONCILIATION_INVALID",
              );
            try {
              await retirePaddleDraftTransaction(paymentConfig, purchase.transaction_id);
            } catch {
              throw authService().accountActionError(
                "STRATA could not safely disable an abandoned Strata+ checkout. Please try again later.",
                503,
                "PURCHASE_RECONCILIATION_UNAVAILABLE",
              );
            }
            await store.revokePurchase(
              purchase.transaction_id,
              "checkout_disabled",
              reconciledAt,
              reconciledAt,
            );
          }
          return;
        }
        if (PADDLE_CANCELABLE_STALE_STATUSES.has(remote.status)) {
          const validation = reuse
            ? validatePurchaseCheckoutForCancellation(remote, purchase)
            : retirementValidation;
          if (!validation.ok)
            throw authService().accountActionError(
              "STRATA could not safely validate an abandoned Strata+ checkout. Please contact support.",
              503,
              "PURCHASE_RECONCILIATION_INVALID",
            );
          try {
            await cancelPaddleTransaction(paymentConfig, purchase.transaction_id);
          } catch {
            throw authService().accountActionError(
              "STRATA could not safely close an abandoned Strata+ checkout. Please try again later.",
              503,
              "PURCHASE_RECONCILIATION_UNAVAILABLE",
            );
          }
          await store.updatePurchaseStatus(purchase.transaction_id, "canceled", reconciledAt);
          return;
        }
        if (remote.status === "completed") {
          if (!current)
            throw authService().accountActionError(
              "STRATA could not safely validate a completed Strata+ checkout catalog. Please contact support.",
              503,
              "PURCHASE_RECONCILIATION_INVALID",
            );
          const validation = validateCompletedTransaction(remote.data, paymentConfig);
          const claimedUser = cleanText(remote.data.custom_data?.strata_user_id, 100);
          if (!validation.ok || claimedUser !== purchase.user_id) {
            throw authService().accountActionError(
              "STRATA could not safely validate a completed Strata+ checkout. Please contact support.",
              503,
              "PURCHASE_RECONCILIATION_INVALID",
            );
          }
          const completedAt = eventTime(remote.data.updated_at, now());
          const subscriptionId = cleanText(remote.data.subscription_id, 100);
          const completed = await store.completePurchase(purchase.transaction_id, {
            customerId: cleanText(remote.data.customer_id, 100) || null,
            subscriptionId,
            completedAt,
            updatedAt: completedAt,
          });
          if (!completed || completed.subscription_id !== subscriptionId)
            throw authService().accountActionError(
              "STRATA could not safely attach the completed Strata+ subscription. Please contact support.",
              503,
              "PURCHASE_RECONCILIATION_INVALID",
            );
        }
      }),
    );
    const failure = reconciled.find((result) => result.status === "rejected");
    if (failure && failure.status === "rejected") throw failure.reason;
    return checkSubscription
      ? store.pendingPurchasesForUser(userId)
      : (await store.unsettledPurchasesForUser(userId)).length;
  }

  return {
    currentPurchase,
    currentCheckout,
    validatePurchaseCheckoutForCancellation,
    reconcileUnsettledPurchases,
  };
}
module.exports = { createCheckoutReconciliation };
