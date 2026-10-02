// @ts-check
"use strict";

const RETIRED_CHECKOUT_PAYMENT_TERM_DAYS = 30;

/** @param {unknown} value */
function clean(value) {
  return String(value || "").trim();
}
/** @param {unknown} value */
function validTransactionId(value) {
  return /^txn_[a-z0-9]{26}$/.test(clean(value));
}

/** @param {import("./domain-types").PaddleTransactionData|null|undefined} data */
function validateRetiredPaddleCheckoutTransaction(data) {
  const details = data?.billing_details,
    terms = details?.payment_terms;
  const checkoutDisabled = data?.checkout === null || data?.checkout?.url === null;
  return data &&
    validTransactionId(data.id) &&
    ["draft", "ready"].includes(clean(data.status)) &&
    data.collection_mode === "manual" &&
    details?.enable_checkout === false &&
    checkoutDisabled &&
    terms?.interval === "day" &&
    Number(terms.frequency) === RETIRED_CHECKOUT_PAYMENT_TERM_DAYS &&
    data.custom_data === null
    ? { ok: true }
    : { ok: false, reason: "retirement" };
}

/**
 * @param {{
 *   transactionRequest:(config:import("./domain-types").PaymentConfig,transactionId:unknown,options:{method:string,body:unknown,fetchImpl:import("./domain-types").FetchLike})=>Promise<import("./domain-types").PaddleFetchedTransactionResult>,
 *   transactionError:(message:string,code:string)=>Error,
 *   validateTransaction:(data:import("./domain-types").PaddleTransactionData|null|undefined,config:import("./domain-types").PaymentConfig,identity:import("./domain-types").CheckoutIdentity)=>{ok:boolean,reason?:string},
 *   defaultProductId:string,
 *   defaultPriceId:string
 * }} dependencies
 */
function createPaddleCheckoutRetirement({
  transactionRequest,
  transactionError,
  validateTransaction,
  defaultProductId,
  defaultPriceId,
}) {
  /** @param {import("./domain-types").PaymentConfig} config @param {unknown} transactionId @param {import("./domain-types").FetchLike} fetchImpl */
  async function retirePaddleDraftTransaction(config, transactionId, fetchImpl = globalThis.fetch) {
    const transaction = await transactionRequest(config, transactionId, {
      method: "PATCH",
      body: {
        collection_mode: "manual",
        billing_details: {
          enable_checkout: false,
          payment_terms: { interval: "day", frequency: RETIRED_CHECKOUT_PAYMENT_TERM_DAYS },
        },
        custom_data: null,
      },
      fetchImpl,
    });
    if (!validateRetiredPaddleCheckoutTransaction(transaction.data).ok)
      throw transactionError(
        "Paddle did not safely retire the abandoned draft checkout.",
        "PADDLE_RECONCILIATION_FAILED",
      );
    return transaction;
  }

  /** @param {import("./domain-types").PaddleTransactionData|null|undefined} data @param {import("./domain-types").PaymentConfig} config @param {import("./domain-types").CheckoutIdentity} identity */
  function validateCheckoutTransactionForRetirement(
    data,
    config,
    { userId, checkoutId, priceId, productId } = {},
  ) {
    const durableProductId = clean(productId),
      remoteProductId = clean(data?.items?.[0]?.price?.product_id),
      expectedProductId = durableProductId || remoteProductId;
    const retiredOneTimeCancellation =
      clean(priceId) === defaultPriceId && expectedProductId === defaultProductId;
    return expectedProductId
      ? validateTransaction(data, config, {
          userId,
          checkoutId,
          priceId,
          productId: expectedProductId,
          retiredOneTimeCancellation,
        })
      : { ok: false, reason: "product" };
  }

  return Object.freeze({ retirePaddleDraftTransaction, validateCheckoutTransactionForRetirement });
}

module.exports = { createPaddleCheckoutRetirement, validateRetiredPaddleCheckoutTransaction };
