/* global module */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrataWorkoutApi = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function create({
    state,
    fetchImpl = globalThis.fetch,
    onSessionBlocked = () => {},
    onAccessBlocked = () => {},
    onIdentity = () => {},
  }) {
    async function request(path, options = {}) {
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 15000);
      const method = options.method || "GET";
      try {
        const response = await fetchImpl(path, {
          ...options,
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(method !== "GET"
              ? { "X-CSRF-Token": state.csrfToken, "X-Strata-User": String(state.user?.id || "") }
              : {}),
            ...(options.headers || {}),
          },
        });
        const data = await response.json().catch(() => ({}));
        // A visitor's /api/me is 200 { user: null }. The workout room is for members, so it is the same as a 401.
        const signedOut = response.ok && path === "/api/me" && data?.user === null,
          status = signedOut ? 401 : response.status;
        if (status === 401) onSessionBlocked();
        if (status === 402) onAccessBlocked();
        if (!response.ok || signedOut)
          throw Object.assign(
            new Error(
              data.error ||
                (signedOut ? "Not signed in." : "STRATA could not complete this request."),
            ),
            { status, code: data.code, data },
          );
        return data;
      } catch (error) {
        if (error.status) throw error;
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection and try again."),
          { code: "NETWORK_ERROR", cause: error },
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    async function assertIdentity() {
      if (state.mode !== "account") return;
      let current;
      try {
        current = await request("/api/me");
      } catch (error) {
        if (error.status === 401) onSessionBlocked();
        throw error;
      }
      if (String(current.user?.id) !== String(state.user.id)) {
        onSessionBlocked();
        throw Object.assign(new Error("The signed-in account changed."), {
          code: "IDENTITY_CHANGED",
        });
      }
      if (current.user.discovery?.active !== true) {
        onAccessBlocked();
        throw Object.assign(
          new Error("Strata+ access is required. Your device draft has been kept."),
          { status: 402 },
        );
      }
      state.user = { ...state.user, discovery: current.user.discovery };
      state.csrfToken = String(current.csrfToken || "");
      onIdentity(current);
      if (!state.csrfToken)
        throw new Error("Your secure account session is not ready. Reload before saving.");
    }

    async function accountRead(path) {
      const data = await request(path);
      await assertIdentity();
      return data;
    }
    async function fetchWorkout(id) {
      try {
        return (await accountRead(`/api/workouts/${encodeURIComponent(id)}`)).workout;
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    }
    return { request, assertIdentity, accountRead, fetchWorkout };
  }

  return { create };
});
