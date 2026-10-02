/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminSession = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createSessionCoordinator({
    client,
    state,
    document,
    location,
    userId,
    cleanString,
    lockPrivateView,
    setIdentity,
    showAccess,
    openDashboard,
    handleAuthorizationFailure,
  }) {
    if (!client || !state || !document || !location || typeof lockPrivateView !== "function")
      throw new TypeError("Admin session coordination requires private-view dependencies.");
    const isCurrent = (operation) => state.isCurrentPrivateOperation(operation);
    let revalidation = null;

    function handlePageShow(event) {
      if (!event.persisted) return;
      lockPrivateView("Reloading this restored page to verify the current administrator session.");
      location.reload();
    }

    async function handleVisibilityChange() {
      if (document.hidden) return;
      if (revalidation) return revalidation;
      const expectedAdminId = userId(state.admin);
      lockPrivateView("Verifying the current account before showing private administration again.");
      const operation = state.capturePrivateOperation();
      const task = (async () => {
        try {
          const result = await client.identity();
          if (!isCurrent(operation)) return;
          const currentAdminId = userId(result.user);
          if (!result.user) {
            showAccess(
              "Your private session ended. Sign in with the verified administrator account to continue.",
              { signedOut: true, focus: true },
            );
            return;
          }
          if (expectedAdminId && currentAdminId !== expectedAdminId) {
            showAccess(
              "The signed-in account changed while Admin was open. Sign in with the approved administrator account to continue.",
              { focus: true },
            );
            return;
          }
          if (result.user.isAdmin !== true && result.user.admin !== true) {
            showAccess(
              "This account is signed in, but it is not an approved STRATA administrator.",
              { focus: true },
            );
            return;
          }
          const csrfToken = cleanString(result.csrfToken, "");
          if (!csrfToken) {
            showAccess(
              "The secure administrator session changed. Sign in again before viewing private data.",
              { signedOut: true, focus: true },
            );
            return;
          }
          state.admin = result.user;
          state.csrfToken = csrfToken;
          const adminSession = await client.adminSession();
          if (!isCurrent(operation)) return;
          if (adminSession.admin !== true) {
            showAccess(
              "This account is signed in, but it is not an approved STRATA administrator.",
              { focus: true },
            );
            return;
          }
          setIdentity(result.user);
          openDashboard();
        } catch (error) {
          if (isCurrent(operation) && !handleAuthorizationFailure(error))
            showAccess(
              "STRATA could not revalidate this administrator session. Reload and try again before viewing private data.",
              { focus: true },
            );
        }
      })();
      revalidation = task;
      try {
        return await task;
      } finally {
        if (revalidation === task) revalidation = null;
      }
    }

    return { handlePageShow, handleVisibilityChange };
  }

  return { createSessionCoordinator };
});
