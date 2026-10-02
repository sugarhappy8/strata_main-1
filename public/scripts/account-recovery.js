"use strict";

const el = (id) => document.getElementById(id);
const page = document.body?.dataset?.accountPage || "";

async function readJson(path, options = {}) {
  let response;
  try {
    response = await globalThis.fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
  } catch (cause) {
    throw Object.assign(new Error("Could not reach STRATA. Check your connection and try again."), {
      code: "network",
      cause,
    });
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const data = contentType.includes("json") ? await response.json().catch(() => null) : null;
  if (!response.ok)
    throw Object.assign(new Error(data?.error || "Request failed."), {
      status: response.status,
      code: data?.code || "REQUEST_FAILED",
    });
  if (!data || typeof data !== "object")
    throw Object.assign(new Error("STRATA returned an unexpected response."), {
      status: 502,
      code: "INVALID_RESPONSE",
    });
  return data;
}

function setBusy(form, button, busy) {
  if (!form || !button) return;
  form.dataset.submitting = busy ? "true" : "";
  if (busy) form.setAttribute("aria-busy", "true");
  else form.removeAttribute("aria-busy");
  button.disabled = busy;
  if (busy) {
    const labels = {
      recoverySubmit: "Sending reset link, please wait",
      resetSubmit: "Resetting password, please wait",
      deleteSubmit: "Deleting account, please wait",
    };
    button.dataset.busy = "true";
    button.setAttribute("aria-label", labels[button.id] || "Working, please wait");
  } else {
    delete button.dataset.busy;
    button.removeAttribute("aria-label");
  }
}

function clearMessage(node) {
  if (!node) return;
  node.hidden = true;
  node.textContent = "";
}

function showMessage(node, message, { focus = true } = {}) {
  node.textContent = message;
  node.hidden = false;
  if (focus) requestAnimationFrame(() => node.focus({ preventScroll: false }));
}

function showFieldMessage(node, field, message) {
  showMessage(node, message, { focus: false });
  field.setAttribute("aria-invalid", "true");
  requestAnimationFrame(() => field.focus({ preventScroll: false }));
}

function setupPasswordToggle(inputId, buttonId, description) {
  const input = el(inputId),
    button = el(buttonId);
  if (!input || !button) return;
  button.addEventListener("click", () => {
    const show = button.getAttribute("aria-pressed") !== "true";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", show ? "true" : "false");
    button.setAttribute("aria-label", `${show ? "Hide" : "Show"} ${description}`);
    button.textContent = show ? "Hide" : "Show";
  });
}

function bearerToken() {
  const raw = new URLSearchParams(String(location.hash || "").replace(/^#/, "")).get("token") || "";
  const token = /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : "";
  if (location.hash) history.replaceState({}, "", `${location.pathname}${location.search}`);
  return token;
}

// While a Strata+ subscription bought in the iOS app is live or set to renew, the server's deletion responses carry
// appleBilling: deleting the account does not stop Apple's billing, so the page says so and links to Apple.
const APPLE_MANAGE_URL = "https://apps.apple.com/account/subscriptions";
function safeAppleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" &&
      url.hostname === "apps.apple.com" &&
      !url.username &&
      !url.password
      ? url.href
      : APPLE_MANAGE_URL;
  } catch {
    return APPLE_MANAGE_URL;
  }
}
function showAppleBilling(response) {
  const notice = el("deleteAppleBilling"),
    message =
      typeof response?.appleBilling?.message === "string"
        ? response.appleBilling.message.trim()
        : "";
  if (!notice || !message) return;
  el("deleteAppleBillingMessage").textContent = message;
  el("deleteAppleBillingLink").href = safeAppleUrl(response.appleBilling.manageUrl);
  notice.hidden = false;
}
// Inside the iOS app the link opens Apple's own subscriptions sheet when the app build has it.
async function openAppleSubscriptions(event) {
  const native = globalThis.StrataApp ? globalThis.StrataAppMode?.plugin?.() : null;
  if (typeof native?.manageSubscriptions !== "function") return;
  event.preventDefault();
  try {
    await native.manageSubscriptions();
  } catch {
    location.assign(safeAppleUrl(el("deleteAppleBillingLink").href));
  }
}

function errorMessage(error, fallback) {
  if (error?.code === "network") return error.message;
  if (error?.status === 429) return "Too many attempts. Please wait and try again.";
  if (Number(error?.status) >= 500)
    return "Account email is temporarily unavailable. Please try again in a moment.";
  return error?.message || fallback;
}

function setupForgotPassword() {
  const form = el("forgotPasswordForm"),
    button = el("recoverySubmit"),
    message = el("recoveryMessage"),
    success = el("recoverySuccess"),
    email = el("recoveryEmail");
  form.addEventListener("input", () => clearMessage(message));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.submitting === "true") return;
    clearMessage(message);
    setBusy(form, button, true);
    try {
      await readJson("/api/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value }),
      });
      email.value = "";
      form.hidden = true;
      success.hidden = false;
      requestAnimationFrame(() => success.focus({ preventScroll: false }));
    } catch (error) {
      showMessage(
        message,
        errorMessage(error, "Could not request a password-reset link. Please try again."),
      );
    } finally {
      setBusy(form, button, false);
    }
  });
  if (new URLSearchParams(location.search).get("sent") === "1") {
    form.hidden = true;
    success.hidden = false;
  }
}

async function setupResetPassword() {
  const token = bearerToken();
  const form = el("resetPasswordForm"),
    button = el("resetSubmit"),
    message = el("resetMessage"),
    unavailable = el("resetUnavailable"),
    success = el("resetSuccess"),
    state = el("resetState"),
    intro = el("resetIntro");
  const password = el("newPassword"),
    confirmation = el("confirmPassword");
  setupPasswordToggle("newPassword", "newPasswordToggle", "new password");
  setupPasswordToggle("confirmPassword", "confirmPasswordToggle", "password confirmation");
  function unavailableState() {
    form.hidden = true;
    unavailable.hidden = false;
    state.classList.add("bad");
    state.querySelector("span").textContent = "This reset link cannot be used.";
    requestAnimationFrame(() => unavailable.focus({ preventScroll: false }));
  }
  if (!token) {
    unavailableState();
    return;
  }
  el("resetToken").value = token;
  try {
    const status = await readJson("/api/password-reset/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (status.active !== true) {
      unavailableState();
      return;
    }
    form.hidden = false;
    state.classList.add("good");
    state.querySelector("span").textContent = "Your one-time reset link is ready.";
    intro.textContent = `Choose a new password for ${status.maskedEmail || "your registered account"}.`;
    requestAnimationFrame(() => password.focus({ preventScroll: false }));
  } catch (error) {
    if (error.status === 400) {
      unavailableState();
      return;
    }
    state.classList.add("warn");
    state.querySelector("span").textContent =
      "The link could not be checked yet. You can still try it below.";
    form.hidden = false;
  }
  form.addEventListener("input", () => {
    clearMessage(message);
    password.removeAttribute("aria-invalid");
    confirmation.removeAttribute("aria-invalid");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.submitting === "true") return;
    clearMessage(message);
    if (password.value.length < 10 || password.value.length > 128) {
      showFieldMessage(message, password, "Use a password of 10–128 characters.");
      return;
    }
    if (password.value !== confirmation.value) {
      showFieldMessage(message, confirmation, "The two password entries do not match.");
      return;
    }
    setBusy(form, button, true);
    try {
      await readJson("/api/password-reset/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: password.value, confirmation: confirmation.value }),
      });
      password.value = "";
      confirmation.value = "";
      el("resetToken").value = "";
      form.hidden = true;
      unavailable.hidden = true;
      success.hidden = false;
      state.classList.remove("warn", "bad");
      state.classList.add("good");
      state.querySelector("span").textContent = "Your password was updated securely.";
      requestAnimationFrame(() => success.focus({ preventScroll: false }));
    } catch (error) {
      if (String(error.code || "").includes("INVALID_RESET_LINK")) {
        unavailableState();
        return;
      }
      showMessage(message, errorMessage(error, "Could not reset the password. Please try again."));
    } finally {
      setBusy(form, button, false);
    }
  });
}

async function setupDeleteAccount() {
  const token = bearerToken();
  const form = el("deleteAccountForm"),
    button = el("deleteSubmit"),
    message = el("deleteMessage"),
    unavailable = el("deleteUnavailable"),
    success = el("deleteSuccess"),
    state = el("deleteState"),
    confirmation = el("deleteConfirmation");
  function unavailableState(text = "This deletion link cannot be used.") {
    form.hidden = true;
    unavailable.hidden = false;
    state.classList.add("bad");
    state.querySelector("span").textContent = text;
    requestAnimationFrame(() => unavailable.focus({ preventScroll: false }));
  }
  if (new URLSearchParams(location.search).get("deleted") === "1") {
    form.hidden = true;
    unavailable.hidden = true;
    success.hidden = false;
    state.classList.add("good");
    state.querySelector("span").textContent = "The account was permanently deleted.";
    try {
      sessionStorage.clear();
    } catch {}
    requestAnimationFrame(() => success.focus({ preventScroll: false }));
    return;
  }
  if (!token) {
    unavailableState();
    return;
  }
  el("deleteToken").value = token;
  el("deleteAppleBillingLink")?.addEventListener(
    "click",
    (event) => void openAppleSubscriptions(event),
  );
  try {
    const status = await readJson("/api/account/delete/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (status.active !== true) {
      unavailableState();
      return;
    }
    showAppleBilling(status);
    form.hidden = false;
    state.classList.add("warn");
    state.querySelector("span").textContent =
      `Deletion is awaiting confirmation for ${status.maskedEmail || "your account"}.`;
    requestAnimationFrame(() => confirmation.focus({ preventScroll: false }));
  } catch (error) {
    if (error.status === 400) {
      unavailableState();
      return;
    }
    state.classList.add("warn");
    state.querySelector("span").textContent =
      "The link could not be checked yet. You can still submit it below.";
    form.hidden = false;
  }
  confirmation.addEventListener("input", () => {
    confirmation.value = confirmation.value
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 6);
    clearMessage(message);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (form.dataset.submitting === "true") return;
    clearMessage(message);
    if (confirmation.value !== "DELETE") {
      showMessage(message, "Type DELETE exactly to confirm permanent account deletion.");
      confirmation.focus();
      return;
    }
    setBusy(form, button, true);
    try {
      const result = await readJson("/api/account/delete/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, confirmation: "DELETE" }),
      });
      showAppleBilling(result);
      confirmation.value = "";
      el("deleteToken").value = "";
      form.hidden = true;
      unavailable.hidden = true;
      success.hidden = false;
      state.classList.remove("warn", "bad");
      state.classList.add("good");
      state.querySelector("span").textContent = "The account was permanently deleted.";
      try {
        sessionStorage.clear();
      } catch {}
      requestAnimationFrame(() => success.focus({ preventScroll: false }));
    } catch (error) {
      if (String(error.code || "").includes("INVALID_DELETE_LINK")) {
        unavailableState();
        return;
      }
      showMessage(
        message,
        errorMessage(error, "Could not delete the account. Nothing was removed; please try again."),
      );
    } finally {
      setBusy(form, button, false);
    }
  });
}

if (typeof globalThis.fetch === "function") {
  if (page === "forgot-password") setupForgotPassword();
  if (page === "reset-password") void setupResetPassword();
  if (page === "delete-account") void setupDeleteAccount();
}
