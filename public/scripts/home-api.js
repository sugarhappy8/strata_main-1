/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataHomeApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createClient({ fetchImpl }) {
    if (typeof fetchImpl !== "function") throw new TypeError("Homepage API requires fetch.");
    async function request(path, options = {}) {
      const headers = {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      };
      let response;
      try {
        response = await fetchImpl(path, { ...options, headers, credentials: "same-origin" });
      } catch (cause) {
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection and try again."),
          { code: "NETWORK_ERROR", cause },
        );
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw Object.assign(new Error(data.error || "Request failed."), {
          status: response.status,
          code: data.code || "REQUEST_FAILED",
          data,
        });
      return data;
    }
    return { request };
  }

  return { createClient };
});
