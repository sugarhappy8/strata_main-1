/* global module */
/* In the iOS app, Delete account deletes the account right here (App Review Guideline 5.1.1(v): App Review cannot open
   an email). The member re-enters the account password and types DELETE in a modal dialog; showModal keeps focus
   inside it and Escape closes it. Browsers never open it and keep the emailed deletion link, which the dialog still
   offers as "Email me a deletion link instead". An account made with Google has no password: it
   types DELETE only, and the server accepts that within 15 minutes of signing in. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAccountDeleteDialog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DONE_MS = 2500,
    APPLE_DONE_MS = 7000,
    DELETED = "Your STRATA account was permanently deleted.";

  function createController({
    element,
    api,
    logic,
    getUser = () => null,
    emailInstead = () => {},
    manageApple = () => {},
    onDeleted = () => {},
    navigate = (path) => globalThis.location.replace(path),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    app = Boolean(globalThis.StrataApp),
  }) {
    const dialog = element("accountDeleteDialog"),
      form = element("accountDeleteForm"),
      done = element("accountDeleteDone");
    const password = element("accountDeletePassword"),
      confirmation = element("accountDeleteConfirmation"),
      submit = element("accountDeleteSubmit"),
      error = element("accountDeleteError");
    let busy = false,
      deleted = false,
      left = false,
      trigger = null;

    const available = () => Boolean(app && dialog && typeof dialog.showModal === "function");
    const passwordless = () => logic.hasPassword(getUser()) === false;
    const ready = () =>
      confirmation.value === "DELETE" && (passwordless() || password.value.length > 0);
    function sync() {
      submit.disabled = busy || !ready();
    }
    function leave() {
      if (left) return;
      left = true;
      navigate("/");
    }

    function clearError() {
      error.textContent = "";
      for (const input of [password, confirmation]) {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      }
    }
    function showError(message, field = null) {
      clearError();
      error.textContent = message;
      if (!field) return;
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", "accountDeleteError");
      field.focus();
    }
    function setBusy(value) {
      busy = value;
      sync();
      if (value) {
        form.setAttribute("aria-busy", "true");
        submit.dataset.busy = "true";
      } else {
        form.removeAttribute("aria-busy");
        delete submit.dataset.busy;
      }
    }
    function reset() {
      setBusy(false);
      password.value = "";
      confirmation.value = "";
      clearError();
      form.hidden = false;
      done.hidden = true;
      sync();
    }

    function open(from = null) {
      if (!available() || dialog.open || deleted) return false;
      trigger = from;
      reset();
      element("accountDeleteApple").hidden = !logic.appleMayBill(getUser());
      const noPassword = passwordless();
      password.hidden = noPassword;
      password.required = !noPassword;
      for (const label of password.labels || []) label.hidden = noPassword;
      element("accountDeleteRecentNote").hidden = !noPassword;
      dialog.showModal();
      element("accountDeleteTitle").focus();
      return true;
    }

    // The account is gone: say so (with Apple's billing notice when it applies) for a moment, then leave signed out.
    function showDone(result) {
      const apple = logic.appleDeletionNotice(result),
        message =
          typeof result?.message === "string" && result.message.trim()
            ? result.message.trim()
            : DELETED;
      element("accountDeleteDoneMessage").textContent = message.startsWith(DELETED)
        ? message
        : DELETED;
      const manage = element("accountDeleteDoneManage");
      manage.hidden = !apple;
      if (apple) manage.href = apple.manageUrl;
      form.hidden = true;
      done.hidden = false;
      done.focus();
      onDeleted();
      setTimer(leave, apple ? APPLE_DONE_MS : DONE_MS);
    }

    async function remove(event) {
      event?.preventDefault?.();
      if (busy || deleted) return;
      if (confirmation.value !== "DELETE") {
        showError("Type DELETE exactly to confirm.", confirmation);
        return;
      }
      if (!passwordless() && !password.value) {
        showError("Enter your STRATA password.", password);
        return;
      }
      clearError();
      setBusy(true);
      // The outcome of a deletion is always shown, even if the web view closed the dialog while it was being sent.
      const reveal = () => {
        if (!dialog.open) dialog.showModal();
      };
      try {
        const result = await api.deleteNow(
          passwordless()
            ? { confirmation: "DELETE" }
            : { password: password.value, confirmation: "DELETE" },
          String(getUser()?.id || ""),
        );
        deleted = true;
        password.value = "";
        setBusy(false);
        reveal();
        showDone(result);
      } catch (failure) {
        setBusy(false);
        reveal();
        const code = String(failure?.code || "");
        if (code === "PASSWORD_INCORRECT") password.value = "";
        showError(
          logic.deleteNowError(failure),
          code === "PASSWORD_INCORRECT"
            ? password
            : code === "DELETE_CONFIRMATION_REQUIRED"
              ? confirmation
              : null,
        );
        sync();
      }
    }

    if (dialog && form) {
      form.addEventListener("submit", (event) => {
        void remove(event);
      });
      for (const input of [password, confirmation])
        input.addEventListener("input", () => {
          if (error.textContent) clearError();
          sync();
        });
      // Escape closes, except while the request is in flight; after deletion, closing leaves the page.
      dialog.addEventListener("cancel", (event) => {
        if (busy) event.preventDefault();
      });
      dialog.addEventListener("close", () => {
        if (deleted) {
          leave();
          return;
        }
        if (busy) return;
        reset();
        trigger?.focus?.();
      });
      element("accountDeleteDismiss").addEventListener("click", () => {
        if (!busy) dialog.close();
      });
      element("accountDeleteEmail").addEventListener("click", () => {
        if (busy) return;
        dialog.close();
        emailInstead();
      });
      element("accountDeleteManage").addEventListener("click", (event) =>
        manageApple(event, element("accountDeleteManage").href),
      );
      element("accountDeleteDoneManage").addEventListener("click", (event) =>
        manageApple(event, element("accountDeleteDoneManage").href),
      );
      element("accountDeleteDoneContinue").addEventListener("click", leave);
    }

    return Object.freeze({ available, open, remove, isOpen: () => Boolean(dialog?.open) });
  }

  return { createController, DONE_MS, APPLE_DONE_MS };
});
