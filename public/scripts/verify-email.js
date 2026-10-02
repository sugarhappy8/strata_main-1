"use strict";

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function safeNext(raw, exerciseId) {
  const addIsSafe = Boolean(exerciseId && /^[a-z0-9-]{2,80}$/.test(exerciseId));
  if (raw === "planner" || raw === "/planner.html")
    return addIsSafe ? `/planner.html?add=${encodeURIComponent(exerciseId)}` : "/planner.html";
  if (/^\/planner\.html\?add=[a-z0-9-]{2,80}$/.test(raw || "")) return raw;
  if (raw === "pricing" || raw === "/pricing" || raw === "/pricing.html") return "/pricing";
  if (raw === "discover" || raw === "/discover.html") return "/discover.html";
  if (raw === "admin" || raw === "/admin" || raw === "/admin.html") return "/admin";
  if (
    /^\/workout\.html\?day=(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(
      raw || "",
    )
  )
    return raw;
  if (raw === "workout" || raw === "/workout.html") return "/workout.html";
  if (raw === "onboarding" || raw === "/onboarding.html") return "/onboarding.html";
  if (raw === "ai" || raw === "/ai" || raw === "/ai.html") return "/ai";
  return "/planner.html";
}

function accountLocation(destination, mode = "signup") {
  const query = new URLSearchParams({ mode: mode === "login" ? "login" : "signup" });
  if (destination === "/pricing") query.set("next", "pricing");
  else if (destination === "/discover.html") query.set("next", "discover");
  else if (destination === "/admin") query.set("next", "admin");
  else if (destination.startsWith("/workout.html"))
    query.set("next", destination === "/workout.html" ? "workout" : destination);
  else if (destination === "/onboarding.html") query.set("next", "onboarding");
  else if (destination === "/ai") query.set("next", "ai");
  else {
    query.set("next", "planner");
    const add = new URL(destination, "https://strata.local").searchParams.get("add");
    if (add && /^[a-z0-9-]{2,80}$/.test(add)) query.set("add", add);
  }
  return `/account.html?${query}`;
}

const next = safeNext(params.get("next"), params.get("add"));
const form = el("verificationForm"),
  codeInput = el("verificationCode"),
  verifyButton = el("verificationSubmit");
const resendForm = el("resendForm"),
  resendButton = el("resendSubmit");
const messageNode = el("verificationMessage"),
  statusNode = el("verificationStatus"),
  stateNode = el("verificationState");
const endedNode = el("verificationSessionEnded"),
  endedMessageNode = el("verificationEndedMessage");
let resendTimer = 0;
let verificationLocked = false;
let verificationSessionEnded = false;
let verificationNavigating = false;
let verificationBusy = false;
let verificationPurpose = "signup";

el("verificationNext").value = next;
el("resendNext").value = next;

function normalizedCode(value) {
  return String(value || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 6);
}

function rememberedMaskedEmail() {
  try {
    return String(globalThis.sessionStorage?.getItem("strata.verification.maskedEmail") || "")
      .trim()
      .slice(0, 254);
  } catch {
    return "";
  }
}

function rememberedPurpose() {
  try {
    return globalThis.sessionStorage?.getItem("strata.verification.purpose") === "login"
      ? "login"
      : "signup";
  } catch {
    return "signup";
  }
}

function setVerificationPurpose(value) {
  verificationPurpose = value === "login" ? "login" : "signup";
  try {
    globalThis.sessionStorage?.setItem("strata.verification.purpose", verificationPurpose);
  } catch {}
  el("verificationPurpose").value = verificationPurpose;
  el("resendPurpose").value = verificationPurpose;
  el("verificationBack").href = accountLocation(next, verificationPurpose);
  el("verificationBack").textContent =
    verificationPurpose === "login" ? "← Back to sign in" : "← Back to signup";
  el("verificationRestart").href = accountLocation(next, verificationPurpose);
  el("verificationRestart").innerHTML =
    verificationPurpose === "login"
      ? 'Start sign-in again <span aria-hidden="true">→</span>'
      : 'Restart signup <span aria-hidden="true">→</span>';
  el("verificationSignIn").href = accountLocation(next, "login");
  el("verificationSignIn").innerHTML =
    verificationPurpose === "login"
      ? 'Use another account <span aria-hidden="true">→</span>'
      : 'Sign in instead <span aria-hidden="true">→</span>';
}

function rememberMaskedEmail(value) {
  const masked = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 254);
  try {
    if (masked) globalThis.sessionStorage?.setItem("strata.verification.maskedEmail", masked);
  } catch {}
  if (masked) el("verificationEmail").textContent = masked;
}

function forgetMaskedEmail() {
  try {
    globalThis.sessionStorage?.removeItem("strata.verification.maskedEmail");
    globalThis.sessionStorage?.removeItem("strata.verification.purpose");
  } catch {}
}

function renderState(kind, text) {
  stateNode.classList.remove("good", "warn", "bad");
  if (kind) stateNode.classList.add(kind);
  stateNode.querySelector("span").textContent = text;
}

function clearError() {
  messageNode.hidden = true;
  messageNode.textContent = "";
  codeInput.removeAttribute("aria-invalid");
}

function showError(text, { focus = true, markCode = true } = {}) {
  messageNode.textContent = text;
  messageNode.hidden = false;
  if (markCode) codeInput.setAttribute("aria-invalid", "true");
  if (focus) requestAnimationFrame(() => messageNode.focus({ preventScroll: false }));
}

function statusText(text) {
  statusNode.textContent = text;
}

function setButtonBusy(button, busy, label = "") {
  if (!button) return;
  if (busy) {
    button.dataset.busy = "true";
    if (label) button.setAttribute("aria-label", label);
  } else {
    delete button.dataset.busy;
    button.removeAttribute("aria-label");
  }
}

function errorCode(error) {
  return String(error?.code || "")
    .trim()
    .toUpperCase();
}

function noActiveChallenge(error) {
  const code = errorCode(error);
  return (
    code.includes("NO_ACTIVE") ||
    code.includes("CHALLENGE_NOT_FOUND") ||
    code.includes("CONSUMED") ||
    code === "VERIFICATION_EXPIRED" ||
    code === "VERIFICATION_SESSION_EXPIRED" ||
    code === "VERIFICATION_HARD_EXPIRED" ||
    code === "VERIFICATION_SEND_LIMIT"
  );
}

function inactiveVerificationMessage(expired = false) {
  if (verificationPurpose === "login")
    return expired
      ? "This sign-in verification expired. Start sign-in again to receive a new code."
      : "This sign-in verification is no longer active. Start sign-in again to receive a new code.";
  return expired
    ? "This signup verification expired. Restart signup to receive a new code."
    : "This signup verification is no longer active. Restart signup to receive a new code.";
}

function friendlyError(error, action) {
  const code = errorCode(error);
  if (error?.code === "network")
    return "Could not reach STRATA. Check your connection and try again.";
  if (code.includes("EXPIRED") || error?.status === 410)
    return "That code has expired. Send another code and try again.";
  if (
    code.includes("ATTEMPT") ||
    code.includes("LOCKED") ||
    code.includes("RATE_LIMIT") ||
    (action === "verify" && error?.status === 429)
  )
    return "Too many attempts. Wait a moment or send a new code to continue.";
  if (code.includes("COOLDOWN") || (action === "resend" && error?.status === 429))
    return "Please wait before requesting another code.";
  if (code.includes("INVALID") || error?.status === 400 || error?.status === 401)
    return "That code is incorrect. Check the email and try again.";
  if (code.includes("PROVIDER") || code.includes("DELIVERY") || Number(error?.status) >= 500) {
    return action === "resend"
      ? "We could not send another email right now. Please try again in a moment."
      : "Email verification is temporarily unavailable. Please try again in a moment.";
  }
  return action === "resend"
    ? "Could not send another code. Please try again."
    : "Could not verify that code. Please try again.";
}

async function readJson(path, options = {}) {
  let response;
  try {
    if (typeof globalThis.fetch !== "function") throw new TypeError("Fetch is unavailable.");
    response = await globalThis.fetch(path, {
      ...options,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(options.headers || {}) },
    });
  } catch (cause) {
    throw Object.assign(new Error("Could not reach STRATA."), { code: "network", cause });
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  const data = contentType.includes("json") ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const retryAfter = data?.retryAfter ?? response.headers?.get?.("retry-after") ?? null;
    throw Object.assign(new Error(data?.error || "Request failed."), {
      status: response.status,
      code: data?.code,
      retryAfter,
      attemptsRemaining: Number.isFinite(Number(data?.attemptsRemaining))
        ? Number(data.attemptsRemaining)
        : null,
      purpose: data?.purpose === "login" ? "login" : data?.purpose === "signup" ? "signup" : "",
      maskedEmail: data?.maskedEmail,
      expiresAt: data?.expiresAt,
      resendAfter: data?.resendAfter,
      deliveryState: ["sent", "failed", "pending"].includes(data?.deliveryState)
        ? data.deliveryState
        : "",
    });
  }
  if (!data || typeof data !== "object")
    throw Object.assign(new Error("Unexpected response."), {
      code: "invalid-response",
      status: 502,
    });
  return data;
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && value.trim() && !/^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  if (number > 1e12) return number;
  if (number > 1e9) return number * 1000;
  return Date.now() + number * 1000;
}

function durationLabel(milliseconds) {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function setResendAfter(value, { prefix = "Another code can be sent in" } = {}) {
  if (resendTimer) globalThis.clearTimeout(resendTimer);
  resendTimer = 0;
  if (verificationSessionEnded) {
    resendButton.disabled = true;
    return;
  }
  const unlockAt = timestamp(value),
    remaining = unlockAt - Date.now();
  if (remaining <= 0) {
    resendButton.disabled = false;
    return;
  }
  resendButton.disabled = true;
  statusText(`${prefix} about ${durationLabel(remaining)}.`);
  resendTimer = globalThis.setTimeout(
    () => {
      resendTimer = 0;
      if (!verificationSessionEnded && !verificationBusy) {
        resendButton.disabled = false;
        statusText("You can request another code now.");
      }
    },
    Math.min(remaining + 50, 2147483647),
  );
}

function describeExpiry(value) {
  const expiresAt = timestamp(value),
    remaining = expiresAt - Date.now();
  if (expiresAt && remaining <= 0) {
    markCodeExpired();
    return;
  }
  if (remaining > 0) renderState("good", `Your code expires in about ${durationLabel(remaining)}.`);
  else renderState("good", "Your verification code is ready.");
}

function setVerificationLocked(locked) {
  verificationLocked = locked === true;
  verifyButton.disabled = verificationLocked || verificationBusy;
}

function setVerificationBusy(busy) {
  verificationBusy = busy === true;
  verifyButton.disabled = verificationBusy || verificationLocked;
  resendButton.disabled = verificationBusy || verificationSessionEnded || Boolean(resendTimer);
}

function markCodeExpired() {
  setVerificationLocked(true);
  codeInput.setAttribute("aria-invalid", "true");
  renderState("bad", "This code has expired. Request another code below to continue.");
  statusText(
    resendButton.disabled
      ? "You can request another code after the resend cooldown."
      : "You can request another code now.",
  );
}

function endVerificationSession(message = "") {
  verificationSessionEnded = true;
  verificationLocked = true;
  if (resendTimer) globalThis.clearTimeout(resendTimer);
  resendTimer = 0;
  forgetMaskedEmail();
  clearError();
  codeInput.value = "";
  codeInput.disabled = true;
  verifyButton.disabled = true;
  resendButton.disabled = true;
  form.setAttribute("aria-disabled", "true");
  resendForm.setAttribute("aria-disabled", "true");
  endedMessageNode.textContent =
    message ||
    (verificationPurpose === "login"
      ? "This sign-in verification is no longer active. Start sign-in again to receive a new code."
      : "This signup verification is no longer active. Restart signup to receive a new code.");
  endedNode.hidden = false;
  renderState(
    "bad",
    "Your verification session has ended. This page did not grant account access.",
  );
  statusText(
    verificationPurpose === "login"
      ? "Start sign-in again to request a new verification code."
      : "Restart signup to request a new verification code.",
  );
  requestAnimationFrame(() => endedNode.focus({ preventScroll: false }));
}

function renderChallengeState(result) {
  const attempts = Number(result?.attemptsRemaining);
  if (Number.isFinite(attempts) && attempts <= 0) {
    setVerificationLocked(true);
    renderState("bad", "Too many incorrect attempts. Request a fresh code below to continue.");
    return;
  }
  setVerificationLocked(false);
  if (result?.deliveryState === "failed") {
    renderState(
      "warn",
      "We could not send this code. Wait for the resend control, then request another one.",
    );
    return;
  }
  if (result?.deliveryState === "pending") {
    renderState(
      "warn",
      "Your verification email is still being prepared. You can check again or resend after the cooldown.",
    );
    return;
  }
  describeExpiry(result?.expiresAt);
}

function nativeQueryMessage() {
  const queryError = String(params.get("error") || "").toLowerCase();
  if (queryError) {
    if (queryError.includes("expired"))
      showError("That code has expired. Send another code and try again.");
    else if (queryError.includes("attempt") || queryError.includes("locked"))
      showError("Too many incorrect attempts. Send a new code to continue.");
    else if (queryError.includes("send") || queryError.includes("provider"))
      showError("We could not send another email right now. Please try again in a moment.", {
        markCode: false,
      });
    else showError("That code is incorrect. Check the email and try again.");
  } else if (params.get("delivery") === "failed") {
    showError(
      "We could not send the verification email. Please wait a moment, then request another code.",
      { markCode: false },
    );
    renderState("warn", "The first email was not sent. Use the resend control after its cooldown.");
  } else if (params.get("sent") === "1")
    statusText("A fresh code was sent. Check your inbox and spam folder.");
  if (queryError || params.has("sent") || params.has("delivery")) {
    const clean = new URL(location.href);
    clean.searchParams.delete("error");
    clean.searchParams.delete("sent");
    clean.searchParams.delete("delivery");
    history.replaceState({}, "", `${clean.pathname}${clean.search}${clean.hash}`);
  }
}

async function refreshStatus() {
  try {
    const result = await readJson("/api/verification-status");
    if (result.purpose) setVerificationPurpose(result.purpose);
    if (result.active !== true) {
      endVerificationSession();
      return;
    }
    rememberMaskedEmail(result.maskedEmail);
    renderChallengeState(result);
    setResendAfter(result.resendAfter);
  } catch (error) {
    if (error.purpose) setVerificationPurpose(error.purpose);
    if (noActiveChallenge(error)) {
      endVerificationSession();
      return;
    }
    renderState(
      "warn",
      "We could not check the verification timer. You can still enter your code.",
    );
  }
}

function enhanceVerification() {
  codeInput.addEventListener("input", () => {
    const normalized = normalizedCode(codeInput.value);
    if (codeInput.value !== normalized) codeInput.value = normalized;
    clearError();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      verificationSessionEnded ||
      verificationNavigating ||
      verificationBusy ||
      form.dataset.submitting === "true"
    )
      return;
    const code = normalizedCode(codeInput.value);
    codeInput.value = code;
    clearError();
    if (!/^[0-9]{6}$/.test(code)) {
      showError("Enter all six numbers from your email.");
      requestAnimationFrame(() => codeInput.focus({ preventScroll: false }));
      return;
    }
    form.dataset.submitting = "true";
    form.setAttribute("aria-busy", "true");
    setVerificationBusy(true);
    setButtonBusy(verifyButton, true, "Verifying code, please wait");
    try {
      const result = await readJson("/api/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!result.user?.id)
        throw Object.assign(new Error("Unexpected response."), {
          code: "invalid-response",
          status: 502,
        });
      forgetMaskedEmail();
      verificationNavigating = true;
      location.assign(next);
    } catch (error) {
      if (error.purpose) setVerificationPurpose(error.purpose);
      if (errorCode(error) === "VERIFICATION_CODE_REPLACED") {
        codeInput.value = "";
        rememberMaskedEmail(error.maskedEmail);
        renderChallengeState(error);
        setResendAfter(error.resendAfter);
        showError("A newer code was sent. Use the most recent six-digit code from your email.");
        return;
      }
      if (errorCode(error) === "ACCOUNT_EXISTS") {
        endVerificationSession(
          "An account already exists for this email. Sign in instead, or restart signup with a different address.",
        );
        return;
      }
      if (noActiveChallenge(error)) {
        endVerificationSession(inactiveVerificationMessage(errorCode(error).includes("EXPIRED")));
        return;
      }
      if (errorCode(error) === "VERIFICATION_CODE_EXPIRED" || error.status === 410) {
        markCodeExpired();
        showError("That code has expired. Send another code and try again.");
        return;
      }
      if (error.attemptsRemaining === 0) {
        setVerificationLocked(true);
        renderState("bad", "Too many incorrect attempts. Request a fresh code below to continue.");
        showError("Too many incorrect attempts. Send another code to continue.");
      } else {
        if (errorCode(error).includes("EXPIRED") || error.status === 410)
          renderState("bad", "This code has expired. Request another code below.");
        showError(friendlyError(error, "verify"));
      }
    } finally {
      if (!verificationNavigating) {
        setVerificationBusy(false);
        setButtonBusy(verifyButton, false);
        delete form.dataset.submitting;
        form.removeAttribute("aria-busy");
      }
    }
  });

  resendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      verificationSessionEnded ||
      verificationBusy ||
      resendForm.dataset.submitting === "true" ||
      resendButton.disabled
    )
      return;
    resendForm.dataset.submitting = "true";
    resendForm.setAttribute("aria-busy", "true");
    setVerificationBusy(true);
    setButtonBusy(resendButton, true, "Sending another code, please wait");
    clearError();
    try {
      const result = await readJson("/api/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (result.purpose) setVerificationPurpose(result.purpose);
      if (result.active === false) {
        endVerificationSession();
        return;
      }
      rememberMaskedEmail(result.maskedEmail);
      codeInput.value = "";
      setVerificationLocked(false);
      renderState("good", "A fresh verification code is ready.");
      statusText("A fresh code was sent. Check your inbox and spam folder.");
      setResendAfter(result.resendAfter, {
        prefix: "Fresh code sent. You can request another code in",
      });
      requestAnimationFrame(() => codeInput.focus({ preventScroll: false }));
    } catch (error) {
      if (error.purpose) setVerificationPurpose(error.purpose);
      if (noActiveChallenge(error)) {
        endVerificationSession(inactiveVerificationMessage(errorCode(error).includes("EXPIRED")));
        return;
      }
      if (error.status === 429 || errorCode(error).includes("COOLDOWN"))
        setResendAfter(error.retryAfter, { prefix: "Try sending another code again in" });
      showError(friendlyError(error, "resend"), { markCode: false });
    } finally {
      setVerificationBusy(false);
      setButtonBusy(resendButton, false);
      delete resendForm.dataset.submitting;
      resendForm.removeAttribute("aria-busy");
    }
  });
}

setVerificationPurpose(params.get("purpose") || rememberedPurpose());
rememberMaskedEmail(rememberedMaskedEmail());
nativeQueryMessage();
if (globalThis.matchMedia?.("(max-width: 720px)").matches)
  requestAnimationFrame(() => el("verificationTitle").focus({ preventScroll: false }));
if (typeof globalThis.fetch === "function") {
  enhanceVerification();
  void refreshStatus();
}
