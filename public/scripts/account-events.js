/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAccountEvents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function setupPasswordToggle({ input, button, description }) {
    if (!input || !button) return;
    button.addEventListener("click", () => {
      const show = button.getAttribute("aria-pressed") !== "true";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", show ? "true" : "false");
      button.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${description}`);
      button.textContent = show ? "Hide" : "Show";
    });
  }

  function bind({
    nodes,
    actions,
    enhanceAuth,
    windowImpl = globalThis,
    documentImpl = globalThis.document,
  }) {
    nodes.passwordReset.addEventListener("click", (event) => {
      void actions.requestSecurityEmail("password", event);
    });
    nodes.deleteRequest.addEventListener("click", (event) => {
      void actions.requestSecurityEmail("delete", event);
    });
    nodes.manageSubscription.addEventListener("click", (event) => {
      void actions.openBillingPortal("overview", event);
    });
    nodes.updatePayment.addEventListener("click", (event) => {
      void actions.openBillingPortal("payment", event);
    });
    nodes.cancelSubscription.addEventListener("click", (event) => {
      void actions.openBillingPortal("cancel", event);
    });
    nodes.sessionList.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-revoke-session]"),
        sessionId = button?.dataset?.revokeSession;
      if (button && sessionId) void actions.revokeSession(sessionId, button);
    });
    nodes.revokeOtherSessions.addEventListener("click", (event) => {
      void actions.revokeOtherSessions(event.currentTarget);
    });
    nodes.exportData.addEventListener("click", actions.downloadExport);
    nodes.deleteCancel.addEventListener("click", actions.cancelDeletion);
    nodes.reload.addEventListener("click", actions.reload);
    nodes.logout.addEventListener("click", actions.logout);
    setupPasswordToggle({
      input: nodes.signupPassword,
      button: nodes.signupPasswordToggle,
      description: "signup password",
    });
    setupPasswordToggle({
      input: nodes.loginPassword,
      button: nodes.loginPasswordToggle,
      description: "sign-in password",
    });
    documentImpl?.addEventListener?.("visibilitychange", actions.handleForeground);
    windowImpl?.addEventListener?.("focus", actions.handleForeground);
    windowImpl?.addEventListener?.("pageshow", actions.handlePageShow);
    if (enhanceAuth) {
      actions.enhanceForm("signup");
      actions.enhanceForm("login");
    }
  }

  return { setupPasswordToggle, bind };
});
