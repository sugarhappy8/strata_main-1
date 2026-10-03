/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createClient({ fetchImpl, getSession, verifyIdentity, onAccountChanged }) {
    if (typeof fetchImpl !== "function" || typeof getSession !== "function")
      throw new TypeError("Planner API requires fetch and session access.");
    async function request(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase(),
        changesState = method !== "GET" && method !== "HEAD";
      const session = getSession();
      if (changesState && !session.guest && typeof verifyIdentity === "function")
        await verifyIdentity();
      const current = getSession();
      let response;
      try {
        response = await fetchImpl(path, {
          ...options,
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(changesState && current.csrfToken ? { "X-CSRF-Token": current.csrfToken } : {}),
            ...(changesState && current.userId ? { "X-Strata-User": String(current.userId) } : {}),
            ...(options.headers || {}),
          },
        });
      } catch (cause) {
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection and try again."),
          { code: "NETWORK_ERROR", cause },
        );
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = Object.assign(new Error(data.error || "Request failed."), {
          status: response.status,
          code: data.code || "REQUEST_FAILED",
          data,
        });
        if (error.code === "ACCOUNT_CHANGED") onAccountChanged?.();
        throw error;
      }
      return data;
    }
    return { request };
  }

  // Plan starts from the library, which leaves out setup notes and cues. The first guide fetches them with the full
  // catalog, and the guide builder (discovery-core.js) with them; offline, both come from the service worker cache.
  // A failed load is forgotten, so the next guide tries again.
  function createGuidanceLoader({ request, documentImpl, hasBuilder, catalogPath, builderPath }) {
    let pending = null;
    const loadScript = (src) =>
      new Promise((resolve, reject) => {
        const script = documentImpl.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("The exercise guide could not load."));
        documentImpl.head.append(script);
      });
    return function loadGuidance() {
      pending ||= Promise.all([
        request(catalogPath),
        hasBuilder() ? null : loadScript(builderPath),
      ]).then(
        ([catalog]) => catalog,
        (error) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    };
  }

  return { createClient, createGuidanceLoader };
});
