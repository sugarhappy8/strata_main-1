/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAccountState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createState({ pendingQueryError = "" } = {}) {
    let identityGeneration = 0,
      sessionGeneration = 0,
      privateGeneration = 0,
      privateUserId = "",
      csrfToken = "",
      navigating = false,
      pendingError = pendingQueryError;
    return {
      beginIdentity() {
        identityGeneration += 1;
        return identityGeneration;
      },
      isCurrentIdentity(value) {
        return value === identityGeneration;
      },
      beginSessionList() {
        sessionGeneration += 1;
        return sessionGeneration;
      },
      isCurrentSessionList(value) {
        return value === sessionGeneration;
      },
      beginPrivateOperation() {
        return { generation: privateGeneration, userId: privateUserId };
      },
      isCurrentPrivateOperation(value) {
        return (
          Boolean(privateUserId) &&
          value?.generation === privateGeneration &&
          value?.userId === privateUserId
        );
      },
      setPrivateUser(value) {
        privateGeneration += 1;
        privateUserId = String(value || "");
        return privateUserId;
      },
      invalidatePrivateRequests() {
        identityGeneration += 1;
        sessionGeneration += 1;
        privateGeneration += 1;
        privateUserId = "";
        csrfToken = "";
      },
      getCsrfToken() {
        return csrfToken;
      },
      setCsrfToken(value) {
        csrfToken = String(value || "");
        return csrfToken;
      },
      isNavigating() {
        return navigating;
      },
      setNavigating(value = true) {
        navigating = value === true;
      },
      takePendingError() {
        const value = pendingError;
        pendingError = "";
        return value;
      },
    };
  }

  return { createState };
});
