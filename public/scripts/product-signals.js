"use strict";

(() => {
  const root = globalThis;
  const STORAGE_KEY = "strata_product_signals_v1";
  const PREFERENCE_KEY = "strata_product_signals_preference_v1";
  const SHARE_PREFERENCE_KEY = "strata_product_signals_share_v1";
  const MAX_COUNT = 999;
  const MILESTONES = Object.freeze([
    "preview_generated",
    "onboarding_previewed",
    "onboarding_saved",
    "plan_saved",
    "workout_started",
    "workout_completed",
    "upgrade_viewed",
    "checkout_opened",
    "upgrade_activated",
  ]);
  const MILESTONE_SET = new Set(MILESTONES);
  const FEEDBACK = Object.freeze(["useful", "not_relevant", "not_clear"]);
  const FEEDBACK_SET = new Set(FEEDBACK);
  const SERVER_FEEDBACK = Object.freeze({
    useful: "recommendation_feedback_useful",
    not_relevant: "recommendation_feedback_not_relevant",
    not_clear: "recommendation_feedback_not_clear",
  });
  const SERVER_EVENT_SET = new Set([...MILESTONES, ...Object.values(SERVER_FEEDBACK)]);
  const PROMPT_EVENT_SET = new Set(MILESTONES.filter((name) => name !== "upgrade_viewed"));
  const pending = [];
  let deferred = false;
  const LABELS = Object.freeze({
    preview_generated: "Preview generated",
    onboarding_previewed: "Setup week previewed",
    onboarding_saved: "Setup week saved",
    plan_saved: "Weekly plan saved",
    workout_started: "Workout started",
    workout_completed: "Workout completed",
    upgrade_viewed: "Strata+ access viewed",
    checkout_opened: "Secure checkout opened",
    upgrade_activated: "Paid Strata+ access activated",
  });

  function privacySignal() {
    const navigator = root.navigator || {};
    return (
      navigator.globalPrivacyControl === true ||
      String(navigator.doNotTrack || root.doNotTrack || "") === "1"
    );
  }

  function storage() {
    try {
      const target = root.localStorage || null;
      if (target) target.getItem(PREFERENCE_KEY);
      return target;
    } catch {
      return null;
    }
  }

  function preference(key) {
    try {
      const value = storage()?.getItem(key);
      return value === "off" ? false : value === "on" ? true : null;
    } catch {
      return null;
    }
  }

  function storedPreference() {
    return preference(PREFERENCE_KEY);
  }
  function sharingPreference() {
    return preference(SHARE_PREFERENCE_KEY);
  }
  function enabled() {
    return Boolean(storage()) && !privacySignal() && storedPreference() !== false;
  }
  function sharingEnabled() {
    return enabled() && sharingPreference() === true && typeof root.fetch === "function";
  }
  function empty() {
    return { version: 1, milestones: {}, recommendationFeedback: null };
  }
  function day(value = new Date()) {
    try {
      return value.toISOString().slice(0, 10);
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }
  function safeDay(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : day();
  }
  function safeCount(value) {
    return Math.min(MAX_COUNT, Math.max(1, Math.round(Number(value) || 1)));
  }

  function normalize(input) {
    const output = empty();
    if (!input || typeof input !== "object" || Array.isArray(input)) return output;
    for (const name of MILESTONES) {
      const entry = input.milestones?.[name];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      output.milestones[name] = {
        count: safeCount(entry.count),
        firstDay: safeDay(entry.firstDay),
        lastDay: safeDay(entry.lastDay),
      };
    }
    const response = input.recommendationFeedback?.response;
    if (FEEDBACK_SET.has(response))
      output.recommendationFeedback = { response, day: safeDay(input.recommendationFeedback.day) };
    return output;
  }

  function snapshot() {
    try {
      return normalize(JSON.parse(storage()?.getItem(STORAGE_KEY) || "null"));
    } catch {
      return empty();
    }
  }

  function write(value) {
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(STORAGE_KEY, JSON.stringify(normalize(value)));
      return true;
    } catch {
      return false;
    }
  }

  function dismissConsent() {
    root.document?.getElementById?.("productSignalsConsent")?.remove?.();
  }

  function announceChange() {
    try {
      root.dispatchEvent?.(new root.CustomEvent("strata:signals-change"));
    } catch {
      /* Optional signals stay quiet in limited browsers. */
    }
    render();
  }

  // A signed-in count carries the session and its security token; a signed-out one carries no credentials at all.
  let securityToken = null;
  function signedInToken() {
    securityToken ||= root
      .fetch("/api/me", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
      .then(async (response) =>
        response?.ok ? String((await response.json())?.csrfToken || "") : "",
      )
      .catch(() => "");
    return securityToken;
  }

  async function transmit(name) {
    if (!sharingEnabled() || !SERVER_EVENT_SET.has(name)) return false;
    try {
      const token = await signedInToken();
      const response = await root.fetch("/api/product-signals", {
        method: "POST",
        credentials: token ? "same-origin" : "omit",
        referrerPolicy: "no-referrer",
        keepalive: true,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { "X-CSRF-Token": token } : {}),
        },
        body: JSON.stringify({ event: name }),
      });
      if (response?.status === 403 && token) securityToken = null;
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  }

  function showConsent() {
    const document = root.document;
    if (
      !document?.body ||
      deferred ||
      document.getElementById?.("productSignalsConsent") ||
      privacySignal() ||
      sharingPreference() !== null ||
      !storage()
    )
      return;
    const panel = document.createElement("aside");
    panel.id = "productSignalsConsent";
    panel.className = "signal-consent";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-labelledby", "productSignalsConsentTitle");
    panel.setAttribute("aria-live", "polite");
    panel.innerHTML =
      '<div><p class="signal-consent-kicker">Optional product activity</p><h2 id="productSignalsConsentTitle">Share aggregate action counts?</h2><p>STRATA would receive only an allowlisted action name; the server adds the current UTC day. No URL, exercise, plan, or workout detail is sent. If you are signed in, your sign-in is checked so the count is marked signed in, but no account is stored with it. Each action counts once per day; counts are not unique people or conversion cohorts.</p></div><div class="signal-consent-actions"><button type="button" data-signal-consent="share">Share counts</button><button type="button" data-signal-consent="local">Keep on this device</button><button type="button" data-signal-consent="later">Not now</button><a href="/privacy#localProductSignals">Read privacy details</a></div>';
    const host =
      document.querySelector?.("[data-product-signals-consent-host]") ||
      document.querySelector?.("main") ||
      document.body;
    host.append(panel);
  }

  function shareOrInvite(name, { prompt = true } = {}) {
    if (!SERVER_EVENT_SET.has(name) || !enabled()) return;
    if (sharingEnabled()) {
      void transmit(name);
      return;
    }
    if (sharingPreference() !== null || privacySignal() || !prompt) return;
    pending.splice(0, pending.length, name);
    showConsent();
  }

  function record(name) {
    if (!enabled() || !MILESTONE_SET.has(name)) return false;
    const value = snapshot(),
      today = day(),
      previous = value.milestones[name];
    value.milestones[name] = {
      count: Math.min(MAX_COUNT, (previous?.count || 0) + 1),
      firstDay: previous?.firstDay || today,
      lastDay: today,
    };
    const saved = write(value);
    if (saved) {
      announceChange();
      shareOrInvite(name, { prompt: PROMPT_EVENT_SET.has(name) });
    }
    return saved;
  }

  function feedback(response) {
    if (!enabled() || !FEEDBACK_SET.has(response)) return false;
    const value = snapshot();
    value.recommendationFeedback = { response, day: day() };
    const saved = write(value);
    if (saved) {
      announceChange();
      shareOrInvite(SERVER_FEEDBACK[response]);
    }
    return saved;
  }

  function clear() {
    try {
      const target = storage();
      if (!target) return false;
      target.removeItem(STORAGE_KEY);
      announceChange();
      return true;
    } catch {
      return false;
    }
  }

  function setEnabled(value) {
    if (value && privacySignal()) return false;
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(PREFERENCE_KEY, value ? "on" : "off");
      if (!value) {
        target.removeItem(STORAGE_KEY);
        target.setItem(SHARE_PREFERENCE_KEY, "off");
        pending.length = 0;
        dismissConsent();
      }
      announceChange();
      return true;
    } catch {
      return false;
    }
  }

  function setSharing(value) {
    if (value && (!enabled() || privacySignal() || typeof root.fetch !== "function")) return false;
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(SHARE_PREFERENCE_KEY, value ? "on" : "off");
      if (!value) pending.length = 0;
      dismissConsent();
      announceChange();
      return true;
    } catch {
      return false;
    }
  }

  function summary(value = snapshot()) {
    const lines = ["STRATA device product-signal summary", `Generated: ${day()}`];
    const recorded = MILESTONES.filter((name) => value.milestones[name]);
    if (!recorded.length) lines.push("Milestones: none");
    else {
      lines.push("Milestones:");
      for (const name of recorded) {
        const entry = value.milestones[name];
        lines.push(
          `- ${LABELS[name]}: ${entry.count} (first ${entry.firstDay}; latest ${entry.lastDay})`,
        );
      }
    }
    lines.push(`Recommendation feedback: ${value.recommendationFeedback?.response || "none"}`);
    const share = sharingPreference();
    lines.push(
      `Future aggregate count sharing: ${share === true ? "on" : share === false ? "off" : "not chosen"}`,
    );
    lines.push(
      "No exercise IDs, plan contents, workout details, URLs, account identifiers, or contact details are included.",
    );
    return lines.join("\n");
  }

  function statusMessage() {
    if (privacySignal())
      return "Off because your browser is sending a privacy signal. No product milestones are being stored or shared.";
    if (!storage()) return "Unavailable because this browser has blocked local storage.";
    if (!enabled())
      return "Off. Existing local product signals were cleared and no new milestones will be stored or shared.";
    return "On. Only coarse milestones and your latest recommendation answer are stored in this browser.";
  }

  function sharingStatusMessage() {
    if (privacySignal())
      return "Off because your browser is sending Global Privacy Control or Do Not Track.";
    if (!storage() || typeof root.fetch !== "function") return "Unavailable in this browser.";
    if (!enabled()) return "Off because device product insights are off.";
    const value = sharingPreference();
    if (value === true)
      return "On for future actions. STRATA receives only an allowlisted action name; its server adds the UTC day and counts each action once per day.";
    if (value === false) return "Off. Future product actions stay on this device.";
    return "Not chosen. Nothing has been sent; STRATA will ask after a relevant action.";
  }

  function render() {
    const document = root.document;
    if (!document) return;
    const value = snapshot(),
      isEnabled = enabled(),
      blocked = privacySignal();
    const toggle = document.getElementById?.("localSignalsToggle"),
      status = document.getElementById?.("localSignalsStatus"),
      output = document.getElementById?.("localSignalsSummary");
    const shareToggle = document.getElementById?.("aggregateSignalsToggle"),
      shareStatus = document.getElementById?.("aggregateSignalsStatus");
    if (toggle) {
      toggle.checked = isEnabled;
      toggle.disabled = blocked || !storage();
    }
    if (status) status.textContent = statusMessage();
    if (output) output.textContent = summary(value);
    if (shareToggle) {
      shareToggle.checked = sharingEnabled();
      shareToggle.disabled =
        blocked || !storage() || !isEnabled || typeof root.fetch !== "function";
    }
    if (shareStatus) shareStatus.textContent = sharingStatusMessage();
    document.querySelectorAll?.("[data-recommendation-feedback]").forEach((button) => {
      const selected =
        value.recommendationFeedback?.response === button.dataset.recommendationFeedback;
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !isEnabled;
    });
    const feedbackStatus = document.getElementById?.("recommendationFeedbackStatus");
    if (feedbackStatus) {
      const response = value.recommendationFeedback?.response,
        share = sharingPreference();
      feedbackStatus.textContent = !isEnabled
        ? "Device product insights are off. You can manage them in the Privacy Policy."
        : response
          ? share === true
            ? "Saved here. Aggregate sharing sends only this answer category as a count."
            : share === null
              ? "Saved here. Choose whether to share an aggregate answer-category count."
              : "Saved only on this device."
          : "No answer saved yet.";
    }
  }

  async function copySummary() {
    const status = root.document?.getElementById?.("localSignalsActionStatus");
    try {
      if (!root.navigator?.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await root.navigator.clipboard.writeText(summary());
      if (status) status.textContent = "Copied. You decide where to share this device summary.";
      return true;
    } catch {
      if (status)
        status.textContent =
          "Couldn’t copy automatically. Select the summary text and copy it manually.";
      return false;
    }
  }

  function handleClick(event) {
    const target = event.target?.closest?.(
      "[data-recommendation-feedback],[data-signal-consent],#clearLocalSignals,#copyLocalSignals",
    );
    if (!target) return;
    if (target.matches?.("[data-recommendation-feedback]")) {
      const saved = feedback(target.dataset.recommendationFeedback);
      if (!saved) render();
    } else if (target.dataset?.signalConsent) {
      if (target.dataset.signalConsent === "later") {
        deferred = true;
        pending.length = 0;
        dismissConsent();
        return;
      }
      const queued = pending.splice(0),
        share = target.dataset.signalConsent === "share";
      if (setSharing(share) && share) for (const name of queued) void transmit(name);
    } else if (target.id === "clearLocalSignals") {
      const status = root.document?.getElementById?.("localSignalsActionStatus");
      if (clear()) {
        if (status)
          status.textContent =
            "Local product signals cleared from this browser. Previously received aggregate counts cannot identify this device and expire within 90 days.";
      } else if (status)
        status.textContent = "This browser did not allow the local product signals to be cleared.";
    } else if (target.id === "copyLocalSignals") void copySummary();
  }

  function initialize() {
    const document = root.document;
    if (!document) return;
    document.addEventListener?.("click", handleClick);
    document.getElementById?.("localSignalsToggle")?.addEventListener?.("change", (event) => {
      const changed = setEnabled(Boolean(event.target.checked));
      const status = document.getElementById?.("localSignalsActionStatus");
      if (status)
        status.textContent = changed
          ? event.target.checked
            ? "Device product insights enabled."
            : "Device product insights disabled, cleared, and aggregate sharing stopped."
          : "This preference could not be saved in this browser.";
      render();
    });
    document.getElementById?.("aggregateSignalsToggle")?.addEventListener?.("change", (event) => {
      const changed = setSharing(Boolean(event.target.checked));
      const status = document.getElementById?.("localSignalsActionStatus");
      if (status)
        status.textContent = changed
          ? event.target.checked
            ? "Future aggregate action-count sharing enabled."
            : "Future aggregate action-count sharing stopped."
          : "This sharing preference could not be saved in this browser.";
      render();
    });
    const initial = document.body?.dataset?.strataMilestone;
    if (initial) record(initial);
    render();
  }

  root.StrataSignals = Object.freeze({
    STORAGE_KEY,
    PREFERENCE_KEY,
    SHARE_PREFERENCE_KEY,
    MILESTONES,
    FEEDBACK,
    enabled,
    sharingEnabled,
    sharingPreference,
    record,
    feedback,
    snapshot,
    summary,
    clear,
    setEnabled,
    setSharing,
  });
  root.addEventListener?.("strata:milestone", (event) => record(event?.detail?.name));
  if (root.document?.readyState === "loading")
    root.document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
