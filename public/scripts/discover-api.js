/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataDiscoverApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function saveErrorDetail(error) {
    if (error?.name === "AbortError")
      return "The request timed out, so the change was not confirmed. Check the current plan before retrying.";
    if (error?.code === "NETWORK_ERROR")
      return "STRATA is offline. Your change was not confirmed; check your connection and retry.";
    if (error?.status === 401)
      return "Your session ended before this change was saved. Sign in again, then retry.";
    if (error?.status === 403)
      return "The secure save token expired. Refresh this page, review your changes, and retry.";
    if (error?.status === 409 || error?.code === "PLAN_CHANGED")
      return "Your plan changed in another tab or device. Review the latest copy before retrying.";
    if ([400, 422].includes(error?.status) && error?.message && error.message !== "Request failed.")
      return error.message;
    if (Number(error?.status) >= 500)
      return "STRATA could not save right now. Your changes are still on screen; retry in a moment.";
    return error?.message && error.message !== "Request failed."
      ? error.message
      : "The change was not saved. Review it and retry.";
  }

  function saveRetryMessage(error) {
    return `Couldn't save — Retry. ${saveErrorDetail(error)}`;
  }

  function assertAccountResponse(response, current, expected) {
    const sameUser = String(current?.userId || "") === String(expected?.userId || ""),
      sameCsrf =
        Boolean(expected?.csrfToken) &&
        String(current?.csrfToken || "") === String(expected.csrfToken) &&
        String(response?.csrfToken || "") === String(expected.csrfToken);
    if (!sameUser || !sameCsrf)
      throw Object.assign(new Error("The signed-in account changed."), { code: "ACCOUNT_CHANGED" });
    return response;
  }

  function createClient({ fetchImpl, getCsrfToken, getGeneration, redirect }) {
    if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
    return async function request(path, options = {}) {
      const requestGeneration = getGeneration(),
        method = String(options.method || "GET").toUpperCase(),
        changesState = method !== "GET" && method !== "HEAD";
      let response;
      try {
        response = await fetchImpl(path, {
          ...options,
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(changesState && getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() } : {}),
            ...(options.headers || {}),
          },
        });
      } catch (cause) {
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection, then try again."),
          { code: "NETWORK_ERROR", cause },
        );
      }
      const data = await response.json().catch(() => ({}));
      if (requestGeneration !== getGeneration())
        throw Object.assign(new Error("This response belongs to an earlier account workspace."), {
          code: "STALE_WORKSPACE_RESPONSE",
          stale: true,
        });
      if (!response.ok) {
        const error = Object.assign(new Error(data.error || "Request failed."), {
          status: response.status,
          code: data.code || "REQUEST_FAILED",
          payload: data,
        });
        if (response.status === 401) {
          error.redirecting = true;
          redirect("/account.html?mode=login&next=discover");
        } else if (response.status === 402 || data.code === "DISCOVERY_ACCESS_REQUIRED") {
          error.redirecting = true;
          redirect("/pricing?reason=access-revoked");
        }
        throw error;
      }
      return data;
    };
  }

  return { assertAccountResponse, createClient, saveErrorDetail, saveRetryMessage };
});
