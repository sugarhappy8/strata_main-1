/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataDevicesCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Shared wording and calculations for connected devices on Account, Strata+, and Train. Polar's numbers are
  // shown as Polar reports them; STRATA only compares a night with the member's own usual nights.

  const DAY_MS = 24 * 60 * 60 * 1000;
  const SIGNALS = Object.freeze({
    "ans-low": "Polar’s ANS charge was below your usual",
    "hrv-low": "Heart rate variability was below your usual range",
    "heart-rate-high": "Overnight heart rate was above your usual range",
    "breathing-high": "Breathing rate was above your usual range",
  });
  const RETURNS = Object.freeze({
    "polar-return": { complete: true, error: false, message: "Finishing your Polar connection…" },
    "polar-failed": {
      complete: false,
      error: true,
      message: "Polar didn’t finish connecting. Try connecting again.",
    },
    "polar-expired": {
      complete: false,
      error: true,
      message: "That Polar connection request expired. Connect Polar again.",
    },
    "polar-declined": {
      complete: false,
      error: false,
      message: "You chose not to share your Polar data, so nothing was connected.",
    },
  });
  const SYNC_ERRORS = Object.freeze({
    POLAR_AUTH: "Polar stopped accepting STRATA’s access. Reconnect Polar to keep syncing.",
    DEVICE_KEY_MISSING: "Reconnect Polar to keep syncing.",
    DEVICE_TOKEN_UNREADABLE: "Reconnect Polar to keep syncing.",
    PLUS_INACTIVE:
      "Syncing is paused while Strata+ is inactive. Your imported data stays until you disconnect.",
    POLAR_RATE_LIMIT: "Polar asked STRATA to slow down. Syncing continues shortly.",
    POLAR_UNAVAILABLE: "Polar was unavailable at the last sync. STRATA will try again.",
    POLAR_TIMEOUT: "Polar was slow at the last sync. STRATA will try again.",
  });

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>'"]/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char],
    );
  }
  const finite = (value) =>
    value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  /** The member's own calendar date, which the server uses as "today". */
  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  function durationText(seconds) {
    if (!finite(seconds) || Number(seconds) < 0) return "—";
    const minutes = Math.round(Number(seconds) / 60),
      hours = Math.floor(minutes / 60),
      rest = minutes % 60;
    return hours ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
  }
  function numberText(value, digits = 0, unit = "") {
    return finite(value) ? `${Number(value).toFixed(digits)}${unit ? ` ${unit}` : ""}` : "—";
  }
  function ago(time, now = Date.now()) {
    if (!finite(time)) return "not yet";
    const minutes = Math.round((now - Number(time)) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  const RECOVERY_LABELS = Object.freeze([
    "Very poor",
    "Poor",
    "Compromised",
    "OK",
    "Good",
    "Very good",
  ]);
  /** Polar's name for a Nightly Recharge status, or for an average of them. */
  function recoveryName(status) {
    return finite(status) && Number(status) >= 1 && Number(status) <= 6
      ? RECOVERY_LABELS[Math.round(Number(status)) - 1]
      : "—";
  }
  function rangeLabel(from, to) {
    const day = (value) =>
      new Date(`${value}T12:00:00Z`).toLocaleDateString("en", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
    return /^\d{4}-\d{2}-\d{2}$/.test(String(from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(to))
      ? `${day(from)} – ${day(to)}`
      : "—";
  }
  function dateLabel(date) {
    const parsed = new Date(`${date}T12:00:00Z`);
    return /^\d{4}-\d{2}-\d{2}$/.test(String(date)) && Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString("en", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        })
      : "—";
  }
  /** What the Account page shows after Polar sends the member back. @param {string} search */
  function returnOutcome(search) {
    const code = new URLSearchParams(search || "").get("devices") || "";
    return Object.hasOwn(RETURNS, code) ? { code, ...RETURNS[code] } : null;
  }
  function syncErrorText(code) {
    return code ? SYNC_ERRORS[code] || "The last sync didn’t finish. STRATA will try again." : "";
  }

  /**
   * The Account card for the member's Polar connection, including which actions it offers.
   * @param {{configured?:boolean,plus?:boolean,connection?:any}|null} status @param {number} [now]
   */
  function connectionView(status, now = Date.now()) {
    const connection = status?.connection || null,
      plus = status?.plus === true;
    const base = {
      visible: true,
      connect: false,
      connectLabel: "Connect Polar",
      upgrade: false,
      sync: false,
      disconnect: false,
      recovery: false,
      suggestions: false,
      facts: false,
      warning: "",
    };
    if (!connection) {
      if (!status?.configured)
        return { ...base, state: "unavailable", visible: false, badge: "", title: "", detail: "" };
      if (!plus)
        return {
          ...base,
          state: "upsell",
          upgrade: true,
          badge: "Strata+",
          title: "Connect Polar with Strata+",
          detail:
            "Strata+ members can connect a Polar Loop to see recovery, sleep, overnight stress signals, and heart rate next to their training.",
        };
      return {
        ...base,
        state: "disconnected",
        connect: true,
        badge: "Not connected",
        title: "Connect your Polar Loop",
        detail:
          "See Polar’s Nightly Recharge, sleep, overnight stress signals, and heart rate next to your training. Your Polar data is private to your account.",
      };
    }
    const facts = { facts: true, disconnect: true };
    if (connection.status === "reconnect")
      return {
        ...base,
        ...facts,
        state: "reconnect",
        connect: plus,
        connectLabel: "Reconnect Polar",
        upgrade: !plus,
        badge: "Reconnect",
        title: "Polar needs you to reconnect",
        detail: syncErrorText(connection.lastError || "POLAR_AUTH"),
      };
    if (!plus)
      return {
        ...base,
        ...facts,
        state: "paused",
        upgrade: true,
        badge: "Paused",
        title: "Polar syncing is paused",
        detail: SYNC_ERRORS.PLUS_INACTIVE,
      };
    if (connection.importing)
      return {
        ...base,
        ...facts,
        state: "importing",
        suggestions: true,
        badge: "Importing",
        title: "Importing from Polar",
        detail:
          "STRATA is reading up to 28 days of your Polar history. This usually takes under a minute.",
      };
    return {
      ...base,
      ...facts,
      state: "active",
      sync: true,
      recovery: true,
      suggestions: true,
      badge: "Connected",
      title: "Polar is connected",
      detail: `Last synced ${ago(connection.lastSyncAt, now)}. STRATA checks Polar at least once a day and sooner when Polar reports new data.`,
      warning: connection.lastError === "PLUS_INACTIVE" ? "" : syncErrorText(connection.lastError),
    };
  }

  function recoveryTone(status) {
    const value = Number(status);
    return !finite(status) ? "none" : value <= 2 ? "low" : value === 3 ? "mid" : "good";
  }
  /** Overnight stress signals in plain words. @param {{level:string,nights?:number,needed?:number,signals?:string[]}|null|undefined} stress */
  function stressView(stress) {
    if (!stress) return { label: "—", detail: "", tone: "none" };
    if (stress.level === "learning")
      return {
        label: "Learning your usual",
        detail: `${Number(stress.nights) || 0} of ${Number(stress.needed) || 7} nights so far. Each night is compared with your own usual nights, so the first week sets your baseline.`,
        tone: "none",
      };
    const signals = (stress.signals || []).map((code) => SIGNALS[code]).filter(Boolean);
    if (stress.level === "higher")
      return { label: "More than usual", detail: `${signals.join(". ")}.`, tone: "low" };
    if (stress.level === "lower")
      return {
        label: "Fewer than usual",
        detail: "Polar’s ANS charge was above your usual and nothing else stood out.",
        tone: "good",
      };
    return {
      label: "Within your usual",
      detail: signals.length
        ? `${signals[0]}, but nothing else stood out.`
        : "No overnight signal stood out from your usual nights.",
      tone: "mid",
    };
  }
  /** The optional lighter-session offer and its reason. @param {{offer?:boolean,reason?:string|null,note?:string|null}|null|undefined} advice */
  function lighterText(advice) {
    if (advice?.offer && advice.reason === "recovery")
      return "Last night’s Nightly Recharge was poor. You can start a lighter session: the same exercises with one set fewer each.";
    if (advice?.offer && advice.reason === "stress")
      return "Two nights in a row showed more stress signals than usual. You can start a lighter session: the same exercises with one set fewer each.";
    if (advice?.note === "compromised")
      return "Nightly Recharge was compromised. Train as planned and adjust if you need to.";
    return "";
  }
  /** Today's workout with one set fewer per exercise (never below one), marked as a recovery adjustment. @param {any} workout */
  function lighterWorkout(workout) {
    const copy = JSON.parse(JSON.stringify(workout));
    let removedSets = 0;
    for (const entry of copy.entries || [])
      if (Array.isArray(entry.sets) && entry.sets.length > 1) {
        entry.sets = entry.sets.slice(0, -1);
        removedSets += 1;
      }
    copy.adjustment = "recovery";
    return { workout: copy, removedSets };
  }
  /** The Polar workout recorded during a STRATA session, if any. @param {any} session @param {any[]} deviceWorkouts */
  function matchDeviceWorkout(session, deviceWorkouts) {
    const start = Number(session?.startedAt),
      end = finite(session?.completedAt)
        ? Number(session.completedAt)
        : start + (Number(session?.elapsedSeconds) || 0) * 1000;
    if (!finite(start)) return null;
    let best = null,
      bestOverlap = 0;
    for (const item of deviceWorkouts || []) {
      const from = Number(item.startedAt),
        to = from + (Number(item.durationSeconds) || 0) * 1000;
      const overlap = Math.min(end + 30 * 60 * 1000, to) - Math.max(start - 30 * 60 * 1000, from);
      if (finite(from) && overlap > bestOverlap) {
        best = item;
        bestOverlap = overlap;
      }
    }
    return best;
  }
  function deviceWorkoutText(item) {
    if (!item) return "";
    return [
      `Polar · ${item.sport || "Workout"}`,
      durationText(item.durationSeconds),
      finite(item.hrAvg) ? `avg ${item.hrAvg} bpm` : "",
      finite(item.calories) ? `${item.calories} kcal` : "",
    ]
      .filter((part) => part && part !== "—")
      .join(" · ");
  }

  /**
   * Coordinates for a small nightly chart: lines break where a night is missing, and the member's usual range
   * becomes a band. @param {Array<{date:string}&Record<string,any>>} series @param {string} key
   * @param {{width?:number,height?:number,pad?:number,usual?:{low:number,high:number}|null}} [options]
   */
  function chartGeometry(series, key, { width = 320, height = 120, pad = 8, usual = null } = {}) {
    const values = series.map((point) => (finite(point[key]) ? Number(point[key]) : null)),
      known = values.filter((value) => value !== null);
    if (!known.length)
      return { empty: true, segments: [], points: [], band: null, min: null, max: null };
    const low = Math.min(...known, ...(usual ? [usual.low] : [])),
      high = Math.max(...known, ...(usual ? [usual.high] : [])),
      span = high - low || 1,
      min = low - span * 0.1,
      max = high + span * 0.1;
    const x = (index) =>
        series.length < 2 ? width / 2 : pad + (index * (width - pad * 2)) / (series.length - 1),
      y = (value) =>
        Math.round((pad + ((max - value) * (height - pad * 2)) / (max - min)) * 10) / 10;
    const points = [],
      segments = [];
    let current = [];
    values.forEach((value, index) => {
      if (value === null) {
        if (current.length) segments.push(current);
        current = [];
        return;
      }
      const point = {
        x: Math.round(x(index) * 10) / 10,
        y: y(value),
        value,
        date: series[index]?.date,
      };
      points.push(point);
      current.push(`${point.x},${point.y}`);
    });
    if (current.length) segments.push(current);
    return {
      empty: false,
      segments,
      points,
      band: usual ? { y1: y(usual.high), y2: y(usual.low) } : null,
      min,
      max,
    };
  }
  /** Days since a night, from the member's own date. */
  function nightAge(date, today = localDate()) {
    return Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS,
    );
  }

  return {
    RECOVERY_LABELS,
    SIGNALS,
    ago,
    chartGeometry,
    connectionView,
    dateLabel,
    deviceWorkoutText,
    durationText,
    escapeHtml,
    lighterText,
    lighterWorkout,
    localDate,
    matchDeviceWorkout,
    nightAge,
    numberText,
    rangeLabel,
    recoveryName,
    recoveryTone,
    returnOutcome,
    stressView,
    syncErrorText,
  };
});
