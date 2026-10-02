/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const GROUPS = ["all", "chest", "back", "shoulders", "arms", "legs", "glutes", "calves", "core"];
  const MAX_DAY_ITEMS = 30;
  const MAX_WEEK_ITEMS = 140;

  function copyPlan(plan) {
    return JSON.parse(JSON.stringify(plan));
  }
  function restDays(plan) {
    return Array.isArray(plan?.restDays)
      ? DAYS.filter((day) => plan.restDays.includes(day))
      : DAYS.includes(plan?.restDay)
        ? [plan.restDay]
        : [];
  }
  function isRestDay(plan, day) {
    return restDays(plan).includes(day);
  }
  function updateRestDays(plan, days) {
    plan.restDays = DAYS.filter((day) => days.includes(day));
    plan.restDay = plan.restDays[0] ?? null;
    return plan;
  }
  function emptyPlan() {
    return {
      version: 1,
      restDay: "Sunday",
      restDays: ["Sunday"],
      days: Object.fromEntries(DAYS.map((day) => [day, []])),
    };
  }
  function planMovementCount(plan) {
    return DAYS.reduce(
      (total, day) => total + (Array.isArray(plan?.days?.[day]) ? plan.days[day].length : 0),
      0,
    );
  }
  function isEmptyPlan(plan) {
    return planMovementCount(plan) === 0;
  }
  function isDefaultPlan(plan) {
    const recovery = restDays(plan);
    return isEmptyPlan(plan) && recovery.length === 1 && recovery[0] === "Sunday";
  }

  function nextScheduledDay(plan, now = new Date()) {
    const todayIndex = (now.getDay() + 6) % 7;
    const ordered = [...DAYS.slice(todayIndex), ...DAYS.slice(0, todayIndex)];
    const day = ordered.find(
      (name) => Array.isArray(plan?.days?.[name]) && plan.days[name].length > 0,
    );
    return day
      ? { day, movements: plan.days[day].length, isToday: day === DAYS[todayIndex] }
      : null;
  }

  function filterExercises(exercises, { group = "all", query = "" } = {}) {
    const normalized = String(query).trim().toLowerCase();
    return (Array.isArray(exercises) ? exercises : [])
      .filter((exercise) => group === "all" || exercise.group === group)
      .filter(
        (exercise) =>
          !normalized ||
          `${exercise.name} ${exercise.sub} ${exercise.equipment}`
            .toLowerCase()
            .includes(normalized),
      )
      .sort((left, right) => right.score - left.score);
  }

  function validateWeekPlan(plan, knownExerciseIds, { limits = true } = {}) {
    if (!plan || plan.version !== 1 || !plan.days || typeof plan.days !== "object")
      throw new Error("This file does not contain a supported STRATA week.");
    const raw = Object.hasOwn(plan, "restDays")
      ? plan.restDays
      : plan.restDay === null
        ? []
        : [plan.restDay];
    if (
      !Array.isArray(raw) ||
      raw.length > 7 ||
      raw.some((day) => !DAYS.includes(day)) ||
      new Set(raw).size !== raw.length
    )
      throw new Error("Choose valid, unique rest days.");
    if (
      Object.hasOwn(plan, "restDays") &&
      Object.hasOwn(plan, "restDay") &&
      plan.restDay !== (restDays(plan)[0] ?? null)
    )
      throw new Error("The week contains conflicting rest-day fields.");
    const known =
        knownExerciseIds instanceof Set ? knownExerciseIds : new Set(knownExerciseIds || []),
      seen = new Set();
    let total = 0;
    for (const day of DAYS) {
      const items = plan.days[day];
      if (!Array.isArray(items)) throw new Error(`The week is missing ${day}.`);
      if (limits && items.length > MAX_DAY_ITEMS)
        throw new Error(`${day} exceeds the ${MAX_DAY_ITEMS}-exercise limit.`);
      total += items.length;
      for (const item of items) {
        if (!item || !known.has(item.exerciseId))
          throw new Error("The week contains an exercise that is unavailable in this library.");
        if (
          typeof item.instanceId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(item.instanceId) ||
          seen.has(item.instanceId)
        )
          throw new Error("The week contains a missing or repeated exercise entry ID.");
        seen.add(item.instanceId);
        if (
          !Number.isInteger(item.sets) ||
          item.sets < 1 ||
          item.sets > 10 ||
          typeof item.reps !== "string" ||
          !item.reps.trim() ||
          item.reps.length > 20
        )
          throw new Error("The week contains an invalid set or repetition prescription.");
      }
    }
    if (total > (limits ? MAX_WEEK_ITEMS : 2000))
      throw new Error(`The week exceeds the ${limits ? MAX_WEEK_ITEMS : 2000}-exercise limit.`);
    if (limits && restDays(plan).some((day) => plan.days[day].length))
      throw new Error("Clear the recovery day before saving or using a week template.");
    return updateRestDays(copyPlan(plan), restDays(plan));
  }

  function saveErrorMessage(error) {
    if (error?.code === "GUEST_PLAN_CHANGED")
      return "Your free device week changed in another tab. This draft is still unsaved. Export this week, then reload to compare the saved copy; retry will not overwrite it.";
    if (error?.code === "NETWORK_ERROR")
      return "STRATA is offline. Your changes are still unsaved; check your connection and retry.";
    if (error?.status === 401)
      return "Your session ended before the plan was saved. Sign in again, then retry.";
    if (error?.status === 403)
      return "The secure save token expired. Refresh this page, review your plan, and retry.";
    if (error?.status === 413)
      return "This plan is too large to save. Remove a few movements, then retry.";
    if ([400, 422].includes(error?.status) && error?.message && error.message !== "Request failed.")
      return error.message;
    if (Number(error?.status) >= 500)
      return "STRATA could not save right now. Your changes are still here; retry in a moment.";
    return error?.message && error.message !== "Request failed."
      ? error.message
      : "Your plan was not saved. Review your changes and retry.";
  }

  function selectedDayHandoff(plan, selectedDay) {
    const day = DAYS.includes(selectedDay) ? selectedDay : "Monday";
    const count = Array.isArray(plan?.days?.[day]) ? plan.days[day].length : 0;
    return {
      day,
      count,
      addLabel: `Add to ${day}`,
      viewLabel: `View ${day} · ${count} exercise${count === 1 ? "" : "s"}`,
    };
  }

  return {
    DAYS,
    GROUPS,
    MAX_DAY_ITEMS,
    MAX_WEEK_ITEMS,
    copyPlan,
    restDays,
    isRestDay,
    updateRestDays,
    emptyPlan,
    planMovementCount,
    isEmptyPlan,
    isDefaultPlan,
    nextScheduledDay,
    filterExercises,
    validateWeekPlan,
    saveErrorMessage,
    selectedDayHandoff,
  };
});
