/* global module */
(function (root, factory) {
  "use strict";
  const stateApi = factory();
  if (typeof module === "object" && module.exports) module.exports = stateApi;
  else root.StrataWorkoutState = stateApi;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const PREFERENCE_KEY = "strata_workout_preferences_v1";
  const OFFLINE_CONTEXT_KEY = "strata_workout_offline_context_v1";
  const REST_DURATIONS = [30, 60, 90, 120, 180, 300];

  function deepLinkedDay(locationLike, workout) {
    const search = new URLSearchParams(locationLike?.search || "");
    let requested = search.get("day") || search.get("start") || "";
    if (!requested && /^#(?:day|start)=/i.test(locationLike?.hash || "")) {
      try {
        requested = decodeURIComponent(String(locationLike.hash).replace(/^#(?:day|start)=/i, ""));
      } catch {
        requested = "";
      }
    }
    return workout.DAYS.includes(requested)
      ? requested
      : workout.dayFromSearch(locationLike?.search || "");
  }

  function create(workout, locationLike = { search: "", hash: "" }) {
    return {
      mode: "",
      user: null,
      ownerId: "",
      contextId: workout.id(),
      csrfToken: "",
      catalog: [],
      plan: null,
      planUpdatedAt: 0,
      day: deepLinkedDay(locationLike, workout),
      workout: null,
      dirty: false,
      sequence: 0,
      saving: null,
      saveTimer: null,
      blocked: false,
      conflict: null,
      pausedSeconds: null,
      timerAnnounced: false,
      draftKey: "",
      recoveries: [],
      history: [],
      offset: 0,
      hasMore: false,
      historyBusy: false,
      historyLoaded: false,
      historyLoadError: "",
      memoryHistory: [],
      memoryExhausted: false,
      memoryBusy: false,
      memoryReady: false,
      memoryError: "",
      detailBusy: false,
      loading: false,
      toastTimer: null,
      checkInBusy: false,
      adaptation: null,
      swapEntryId: "",
      swapCandidateId: "",
      swapProposal: null,
      swapBusy: false,
      swapTrigger: null,
      offlineAccessUntil: 0,
      pageHidden: false,
    };
  }

  function readPreferences(raw) {
    try {
      const saved = JSON.parse(raw || "null");
      if (!saved || saved.version !== 1) return {};
      return {
        ...(typeof saved.autoRest === "boolean" ? { autoRest: saved.autoRest } : {}),
        ...(REST_DURATIONS.includes(Number(saved.restDuration))
          ? { restDuration: Number(saved.restDuration) }
          : {}),
      };
    } catch {
      return {};
    }
  }

  function writePreferences(autoRest, restDuration) {
    return JSON.stringify({
      version: 1,
      autoRest: !!autoRest,
      restDuration: REST_DURATIONS.includes(Number(restDuration)) ? Number(restDuration) : 90,
    });
  }

  function saveError(error = {}) {
    if (error.status === 401 || error.code === "IDENTITY_CHANGED")
      return "Your account session changed. Your device draft has been kept. Reload and sign in to the original account to recover it.";
    if (error.status === 403)
      return "Your secure session could not authorize the save. Reload, then review your recovered draft before saving again.";
    if (error.code === "NETWORK_ERROR")
      return "Not saved to your account. Check your connection, then choose Save now. Your device draft is kept where storage is available.";
    return error.message || "This session could not be saved. Your changes are still here.";
  }

  return {
    PREFERENCE_KEY,
    OFFLINE_CONTEXT_KEY,
    REST_DURATIONS,
    deepLinkedDay,
    create,
    readPreferences,
    writePreferences,
    saveError,
  };
});
