/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPricingApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createRequestJson(fetchImpl = globalThis.fetch) {
    return async function requestJson(path, options = {}) {
      let response;
      try {
        response = await fetchImpl(path, {
          ...options,
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {}),
          },
        });
      } catch (cause) {
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection and try again."),
          { code: "NETWORK_ERROR", cause },
        );
      }
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw Object.assign(new Error(data?.error || "The request could not be completed."), {
          status: response.status,
          code: data?.code || "REQUEST_FAILED",
        });
      if (!data || typeof data !== "object")
        throw Object.assign(new Error("STRATA received an unexpected checkout response."), {
          code: "INVALID_RESPONSE",
        });
      return data;
    };
  }

  return { createRequestJson };
});
