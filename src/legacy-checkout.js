// @ts-check
"use strict";

const {
  DEFAULT_PRODUCT_ID,
  DEFAULT_PRICE_ID,
  replacePaddleTransactionItems,
  validateCheckoutTransaction,
  validateCheckoutRecoveryTransaction,
  exactCurrentCheckoutPrice,
} = require("./payments");

/** @param {unknown} value @param {number} [fallback] */
function eventTime(value, fallback = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** @param {import("./domain-types").PaddleTransactionData|null|undefined} data @param {import("./domain-types").PaymentConfig} config @param {import("./domain-types").CheckoutIdentity} identity */
function validateRetiredCompletedTransaction(data, config, { userId, checkoutId } = {}) {
  if (
    data?.status !== "completed" ||
    !String(userId || "").trim() ||
    !String(checkoutId || "").trim()
  )
    return { ok: false, reason: "identity" };
  return validateCheckoutRecoveryTransaction(data, config, {
    userId,
    checkoutId,
    priceId: DEFAULT_PRICE_ID,
    productId: DEFAULT_PRODUCT_ID,
    retiredOneTimeCancellation: true,
  });
}

/** @param {{store:import("./domain-types").BillingStore;paymentConfig:import("./domain-types").PaymentConfig;now:()=>number;reconciliationError:(message:string,code?:string)=>Error}} dependencies */
function createLegacyCheckoutPolicy({ store, paymentConfig, now, reconciliationError }) {
  /** @param {unknown} priceId */
  function legacyRecurring(priceId) {
    return paymentConfig.legacyRecurringPriceIds.includes(String(priceId || ""));
  }
  /** @param {{price_id:string;product_id:string}} purchase */
  function purchaseCatalog(purchase) {
    if (purchase.product_id === paymentConfig.productId) {
      if (purchase.price_id === paymentConfig.priceId) return "current";
      if (legacyRecurring(purchase.price_id)) return "legacy-recurring";
    }
    return purchase.price_id === DEFAULT_PRICE_ID && purchase.product_id === DEFAULT_PRODUCT_ID
      ? "retired"
      : "";
  }
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {string} userId @param {string} checkoutId */
  function checkoutCatalog(remote, userId, checkoutId) {
    if (
      validateCheckoutRecoveryTransaction(remote.data, paymentConfig, { userId, checkoutId }).ok &&
      (!["draft", "ready"].includes(remote.status) || exactCurrentCheckoutPrice(remote.data))
    )
      return "current";
    for (const priceId of paymentConfig.legacyRecurringPriceIds) {
      if (
        validateCheckoutRecoveryTransaction(remote.data, paymentConfig, {
          userId,
          checkoutId,
          priceId,
          productId: paymentConfig.productId,
        }).ok
      )
        return "legacy-recurring";
    }
    const retired =
      remote.status === "completed"
        ? validateRetiredCompletedTransaction(remote.data, paymentConfig, { userId, checkoutId })
        : validateCheckoutRecoveryTransaction(remote.data, paymentConfig, {
            userId,
            checkoutId,
            priceId: DEFAULT_PRICE_ID,
            productId: DEFAULT_PRODUCT_ID,
            retiredOneTimeCancellation: true,
          });
    return retired.ok ? "retired" : "";
  }
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {import("./domain-types").PurchaseRow} purchase */
  function validatePurchaseCheckoutForCancellation(remote, purchase) {
    const checkoutId = String(remote.data.custom_data?.strata_checkout_id || "").trim(),
      catalog = purchaseCatalog(purchase);
    const stored = validateCheckoutTransaction(remote.data, paymentConfig, {
      userId: purchase.user_id,
      checkoutId,
      priceId: purchase.price_id,
      productId: purchase.product_id,
      retiredOneTimeCancellation: catalog === "retired",
    });
    return stored.ok
      ? stored
      : catalog === "retired"
        ? validateCheckoutTransaction(remote.data, paymentConfig, {
            userId: purchase.user_id,
            checkoutId,
          })
        : stored;
  }
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {import("./domain-types").PurchaseRow} purchase */
  async function migrateReusableDraft(remote, purchase) {
    const source = purchaseCatalog(purchase);
    if (source === "current") {
      if (!exactCurrentCheckoutPrice(remote.data))
        throw reconciliationError(
          "STRATA could not safely validate the current checkout price. Please contact support.",
          "PURCHASE_RECONCILIATION_INVALID",
        );
      return purchase;
    }
    const checkoutId = String(remote.data.custom_data?.strata_checkout_id || "").trim();
    const remoteCatalog = checkoutCatalog(remote, purchase.user_id, checkoutId),
      remotePriceId = String(remote.data.items?.[0]?.price?.id || "").trim();
    const sourceMatches =
      remoteCatalog === "current" ||
      (source === "retired" && remoteCatalog === "retired") ||
      (source === "legacy-recurring" &&
        remoteCatalog === "legacy-recurring" &&
        remotePriceId === purchase.price_id);
    if (
      !["retired", "legacy-recurring"].includes(source) ||
      !["draft", "ready"].includes(remote.status) ||
      !sourceMatches
    )
      throw reconciliationError(
        "STRATA could not safely validate the older checkout catalog. Please contact support.",
        "PURCHASE_RECONCILIATION_INVALID",
      );
    let migrated = remote;
    if (remoteCatalog !== "current") {
      try {
        migrated = await replacePaddleTransactionItems(paymentConfig, purchase.transaction_id);
      } catch {
        throw reconciliationError(
          "The older checkout could not be updated to the current monthly plan. Please try again later.",
        );
      }
    }
    if (
      !["draft", "ready"].includes(migrated.status) ||
      !validateCheckoutTransaction(migrated.data, paymentConfig, {
        userId: purchase.user_id,
        checkoutId,
      }).ok ||
      !exactCurrentCheckoutPrice(migrated.data)
    )
      throw reconciliationError(
        "STRATA could not safely validate the updated monthly checkout. Please contact support.",
        "PURCHASE_RECONCILIATION_INVALID",
      );
    const updatedAt = Math.max(
      now(),
      Number(purchase.updated_at) + 1,
      eventTime(migrated.data.updated_at, now()),
    );
    const stored = await store.replacePendingPurchaseCatalog(purchase, {
      priceId: paymentConfig.priceId,
      productId: paymentConfig.productId,
      paddleStatus: migrated.status,
      updatedAt,
    });
    if (stored) return stored;
    const current = await store.purchaseByTransaction(purchase.transaction_id);
    if (
      current?.user_id === purchase.user_id &&
      purchaseCatalog(current) === "current" &&
      current.completed_at == null &&
      current.access_revoked_at == null
    )
      return current;
    throw reconciliationError(
      "The checkout changed while it was being updated. Please try again later.",
    );
  }
  /** @param {import("./domain-types").PaddleFetchedTransactionResult} remote @param {import("./domain-types").PurchaseRow} purchase @param {number} updatedAt */
  async function completeCatalogMigration(remote, purchase, updatedAt) {
    const checkoutId = String(remote.data.custom_data?.strata_checkout_id || "").trim(),
      subscriptionId = String(remote.data.subscription_id || "").trim(),
      customerId = String(remote.data.customer_id || "").trim();
    if (
      !["retired", "legacy-recurring"].includes(purchaseCatalog(purchase)) ||
      checkoutCatalog(remote, purchase.user_id, checkoutId) !== "current"
    )
      throw reconciliationError(
        "STRATA could not safely validate the completed catalog migration. Please contact support.",
        "PURCHASE_RECONCILIATION_INVALID",
      );
    const completedAt = eventTime(remote.data.updated_at, now()),
      stored = await store.completePurchaseCatalogMigration(purchase, {
        priceId: paymentConfig.priceId,
        productId: paymentConfig.productId,
        customerId,
        subscriptionId,
        completedAt,
        updatedAt,
      });
    if (stored?.subscription_id === subscriptionId && stored.customer_id === customerId)
      return stored;
    const current = await store.purchaseByTransaction(purchase.transaction_id);
    if (
      current &&
      purchaseCatalog(current) === "current" &&
      current.paddle_status === "completed" &&
      current.subscription_id === subscriptionId &&
      current.customer_id === customerId
    )
      return current;
    throw reconciliationError(
      "The completed checkout changed while its catalog was being recovered. Please try again later.",
    );
  }
  return {
    purchaseCatalog,
    checkoutCatalog,
    validatePurchaseCheckoutForCancellation,
    migrateReusableDraft,
    completeCatalogMigration,
  };
}

module.exports = { validateRetiredCompletedTransaction, createLegacyCheckoutPolicy };
