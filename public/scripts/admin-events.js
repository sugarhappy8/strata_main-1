/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminEvents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function bindEvents({ document, window, state, userLimit, supportLimit, handlers }) {
    if (!document || !window || !state || !handlers)
      throw new TypeError(
        "Admin events require document, window, state, and handler dependencies.",
      );
    const el = (id) => document.getElementById(id);
    const sectionButtons = [...document.querySelectorAll("[data-section]")];
    for (const button of sectionButtons) {
      button.addEventListener("click", () =>
        handlers.activateSection(button.dataset.section, { replaceHash: true }),
      );
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = sectionButtons.indexOf(button);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? sectionButtons.length - 1
              : event.key === "ArrowRight"
                ? (current + 1) % sectionButtons.length
                : (current - 1 + sectionButtons.length) % sectionButtons.length;
        sectionButtons[index].focus();
        handlers.activateSection(sectionButtons[index].dataset.section, { replaceHash: true });
      });
    }
    el("refreshOverview").addEventListener("click", () => {
      void handlers.loadOverview();
    });
    el("productSignalDays").addEventListener("change", () => {
      void handlers.loadProductSignals();
    });
    el("userSearchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      state.users.query = el("userQuery").value.trim();
      state.users.offset = 0;
      void handlers.loadUsers();
    });
    el("clearUserSearch").addEventListener("click", () => {
      el("userQuery").value = "";
      state.users.query = "";
      state.users.offset = 0;
      void handlers.loadUsers();
      el("userQuery").focus();
    });
    el("previousUsers").addEventListener("click", () => {
      state.users.offset = Math.max(0, state.users.offset - userLimit);
      void handlers.loadUsers();
    });
    el("nextUsers").addEventListener("click", () => {
      if (state.users.offset + userLimit < state.users.total) {
        state.users.offset += userLimit;
        void handlers.loadUsers();
      }
    });
    el("closeUserDialog").addEventListener("click", () =>
      handlers.closeDialog(el("userDialog"), state.userDialogTrigger),
    );
    el("userDialog").addEventListener("close", handlers.syncDialogLock);
    for (const button of document.querySelectorAll("[data-user-action]"))
      button.addEventListener("click", () =>
        handlers.openActionConfirmation(button.dataset.userAction, button),
      );
    el("confirmForm").addEventListener("submit", handlers.submitUserAction);
    el("closeConfirmDialog").addEventListener("click", () =>
      handlers.closeDialog(el("confirmDialog"), state.actionTrigger),
    );
    el("cancelAction").addEventListener("click", () =>
      handlers.closeDialog(el("confirmDialog"), state.actionTrigger),
    );
    el("confirmDialog").addEventListener("close", handlers.syncDialogLock);
    el("grantUnit").addEventListener("change", handlers.updateGrantFields);
    el("supportFilterForm").addEventListener("submit", (event) => {
      event.preventDefault();
      state.support.status = el("supportStatusFilter").value;
      state.support.offset = 0;
      void handlers.loadSupport();
    });
    el("refreshSupport").addEventListener("click", () => {
      void handlers.loadSupport();
    });
    el("previousSupport").addEventListener("click", () => {
      state.support.offset = Math.max(0, state.support.offset - supportLimit);
      void handlers.loadSupport();
    });
    el("nextSupport").addEventListener("click", () => {
      if (state.support.offset + supportLimit < state.support.total) {
        state.support.offset += supportLimit;
        void handlers.loadSupport();
      }
    });
    el("supportUpdateForm").addEventListener("submit", handlers.submitSupportUpdate);
    el("ticketResponse").addEventListener("input", handlers.updateSupportSubmitLabel);
    el("closeSupportDialog").addEventListener("click", () =>
      handlers.closeDialog(el("supportDialog"), state.supportDialogTrigger),
    );
    el("cancelSupportUpdate").addEventListener("click", () =>
      handlers.closeDialog(el("supportDialog"), state.supportDialogTrigger),
    );
    el("supportDialog").addEventListener("close", handlers.syncDialogLock);
    el("refreshAudit").addEventListener("click", () => {
      void handlers.loadAudit();
    });
    document.addEventListener("visibilitychange", handlers.handleVisibilityChange);
    window.addEventListener("focus", handlers.handleVisibilityChange);
    window.addEventListener("pageshow", handlers.handlePageShow);
  }

  return { bindEvents };
});
