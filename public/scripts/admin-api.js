/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createClient({ fetchImpl, getCsrfToken = () => "" }) {
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

    async function request(path, options = {}) {
      const method = String(options.method || "GET").toUpperCase();
      const headers = {
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      };
      const csrfToken = String(getCsrfToken() || "");
      if (!["GET", "HEAD"].includes(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
      let response;
      try {
        response = await fetchImpl(path, {
          ...options,
          method,
          headers,
          credentials: "same-origin",
        });
      } catch (cause) {
        throw Object.assign(new Error("Network request failed."), { code: "network", cause });
      }
      const type = String(response.headers?.get?.("content-type") || "").toLowerCase();
      const data = type.includes("json") ? await response.json().catch(() => null) : null;
      if (!response.ok)
        throw Object.assign(
          new Error(data?.error || `Request failed with status ${response.status}.`),
          { status: response.status, code: data?.code, data },
        );
      return data && typeof data === "object" ? data : {};
    }

    const post = (path, payload) =>
      request(path, { method: "POST", body: JSON.stringify(payload) });
    return {
      identity: () => request("/api/me"),
      adminSession: () => request("/api/admin/session"),
      overview: () => request("/api/admin/overview"),
      aiUsage: () => request("/api/ai/usage"),
      productSignals: (days) =>
        request(`/api/admin/product-signals?days=${encodeURIComponent(days)}`),
      users: (params) => request(`/api/admin/users?${params}`),
      user: (id) => request(`/api/admin/users/${encodeURIComponent(id)}`),
      userAction: (id, payload) =>
        post(`/api/admin/users/${encodeURIComponent(id)}/actions`, payload),
      support: (params) => request(`/api/admin/support?${params}`),
      updateSupport: (id, payload) => post(`/api/admin/support/${encodeURIComponent(id)}`, payload),
      audit: () => request("/api/admin/audit?limit=50"),
    };
  }

  return { createClient };
});
