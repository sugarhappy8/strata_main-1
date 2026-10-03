/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPricingState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createState() {
    return {
      user: null,
      csrfToken: "",
      accountStatus: "loading",
      config: null,
      configError: "",
      paddleReady: false,
      busy: true,
      awaitingAccess: false,
      checkoutOpen: false,
      checkoutPrepared: false,
      actionError: "",
      currentTransactionId: "",
      currentCheckoutUserId: "",
      plan: "monthly",
    };
  }

  return { createState };
});
