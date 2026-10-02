(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataOnboarding = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const PREFERENCE_OPTIONS = ["stable", "long-range", "simple-setup", "compound", "isolation"];
  const LIMITATION_OPTIONS = [
    "no-overhead",
    "no-deep-knee",
    "no-unsupported-hinge",
    "no-floor",
    "no-unilateral",
  ];
  const DEFAULT_AVAILABILITY = {
    1: ["Monday"],
    2: ["Monday", "Thursday"],
    3: ["Monday", "Wednesday", "Friday"],
    4: ["Monday", "Tuesday", "Thursday", "Friday"],
    5: ["Monday", "Tuesday", "Wednesday", "Friday", "Saturday"],
    6: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    7: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  };
  function starterProfile() {
    return {
      goal: "balanced",
      level: "Beginner",
      equipment: [],
      availability: ["Monday", "Wednesday", "Friday"],
      preferences: ["simple-setup"],
      limitations: [],
      recoveryAdjusted: false,
    };
  }
  function uniqueAllowed(values, allowed) {
    return [...new Set(Array.isArray(values) ? values : [])].filter((value) =>
      allowed.includes(value),
    );
  }
  function profileFromSaved(preferences, plan) {
    const scheduled = DAYS.filter(
      (day) => Array.isArray(plan?.days?.[day]) && plan.days[day].length > 0,
    );
    const requestedDays = Math.max(1, Math.min(7, Math.round(Number(preferences?.days) || 4))),
      recoveryAdjusted = scheduled.length > 6 || (!scheduled.length && requestedDays > 6);
    return {
      goal: preferences?.goal || "hypertrophy",
      level: preferences?.level || "Intermediate",
      equipment: [...(Array.isArray(preferences?.equipment) ? preferences.equipment : [])],
      availability: scheduled.length
        ? scheduled.slice(0, 6)
        : [...DEFAULT_AVAILABILITY[requestedDays]],
      preferences: uniqueAllowed(preferences?.preferences, PREFERENCE_OPTIONS),
      limitations: uniqueAllowed(preferences?.limitations, LIMITATION_OPTIONS),
      recoveryAdjusted,
    };
  }
  function trainingSnapshot(profile, week = null) {
    const availability = uniqueAllowed(profile?.availability, DAYS);
    const equipment = [
      ...new Set(Array.isArray(profile?.equipment) ? profile.equipment : []),
    ].filter(Boolean);
    const minutes = [20, 35, 50].includes(Number(profile?.minutes)) ? Number(profile.minutes) : 0;
    const sessions = Array.isArray(week?.sessions) ? week.sessions : [];
    const movementCount = sessions.reduce(
      (total, session) => total + (Array.isArray(session?.items) ? session.items.length : 0),
      0,
    );
    const workingSets = sessions.reduce(
      (total, session) =>
        total +
        (Array.isArray(session?.items)
          ? session.items.reduce(
              (sets, item) => sets + (Number.isFinite(Number(item?.sets)) ? Number(item.sets) : 0),
              0,
            )
          : 0),
      0,
    );
    let message = "Your preview will stay editable until you choose to save it.";
    if (!availability.length) message = "Choose at least one training day.";
    else if (availability.length > 6) message = "Keep at least one day open for recovery.";
    else if (!equipment.length) message = "Choose the equipment you can reliably access.";
    else if (!minutes) message = "Choose a session length.";
    else
      message = `${availability.length} training day${availability.length === 1 ? "" : "s"}, ${DAYS.length - availability.length} recovery day${DAYS.length - availability.length === 1 ? "" : "s"}, and ${availability.length * minutes} planned minutes each week.`;
    return {
      trainingDays: availability.length,
      recoveryDays: Math.max(0, DAYS.length - availability.length),
      minutes,
      weeklyMinutes: availability.length * minutes,
      equipmentCount: equipment.length,
      movementCount,
      workingSets,
      ready:
        availability.length >= 1 && availability.length <= 6 && equipment.length > 0 && minutes > 0,
      message,
    };
  }
  function uniqueInstanceId(day, index, exerciseId, used, makeId) {
    const requested =
        typeof makeId === "function" ? String(makeId(exerciseId, index, day) || "") : "",
      stem = `setup-${day}-${index}-${exerciseId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 92);
    let candidate =
        /^[a-zA-Z0-9_-]{6,100}$/.test(requested) && !used.has(requested) ? requested : stem,
      suffix = 2;
    while (used.has(candidate))
      candidate = `${stem.slice(0, 96 - String(suffix).length)}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }
  function buildWeek(profile, exercises, discovery, makeId) {
    const days = DAYS.filter((day) => profile?.availability?.includes(day));
    if (days.length < 1 || days.length > 6)
      throw new Error("Choose one to six training days, leaving at least one recovery day.");
    const equipment = [...new Set(profile.equipment || [])].filter((value) =>
      exercises.some((exercise) => exercise.equipment === value),
    );
    if (!equipment.length) throw new Error("Choose the equipment you can actually use.");
    if (
      !["hypertrophy", "strength", "balanced", "time-efficient"].includes(profile.goal) ||
      !["Beginner", "Intermediate", "Advanced"].includes(profile.level)
    )
      throw new Error("Choose a goal and experience level.");
    const minutes = Number(profile.minutes);
    if (![20, 35, 50].includes(minutes))
      throw new Error("Choose 20, 35, or 50 minutes per session.");
    const preferences = {
      version: 1,
      goal: profile.goal,
      level: profile.level,
      days: days.length,
      equipment,
      preferences: uniqueAllowed(profile.preferences, PREFERENCE_OPTIONS),
      limitations: uniqueAllowed(profile.limitations, LIMITATION_OPTIONS),
    };
    const plan = {
      version: 1,
      restDay: DAYS.find((day) => !days.includes(day)) ?? null,
      restDays: DAYS.filter((day) => !days.includes(day)),
      days: Object.fromEntries(DAYS.map((day) => [day, []])),
    };
    const sessions = [],
      anchorsByFocus = new Map(),
      usedInstanceIds = new Set(),
      anchorLimit = minutes === 20 || days.length >= 4 ? 1 : 2;
    for (const [index, day] of days.entries()) {
      const focus = days.length >= 4 ? (index % 2 === 0 ? "upper" : "lower") : "full";
      let session = discovery.buildSession({
        exercises,
        preferences,
        focus,
        minutes,
        weeklyPlan: plan,
      });
      if (days.length >= 3) {
        const anchors = anchorsByFocus.get(focus);
        if (anchors?.length)
          session = discovery.repeatSessionAnchors(session, anchors, anchorLimit);
        else anchorsByFocus.set(focus, session.items.slice(0, anchorLimit));
      }
      plan.days[day] = session.items.map((item, i) => ({
        instanceId: uniqueInstanceId(day, i, item.exerciseId, usedInstanceIds, makeId),
        exerciseId: item.exerciseId,
        sets: item.sets,
        reps: item.reps,
      }));
      sessions.push({ day, ...session });
    }
    return { plan, sessions, preferences };
  }
  return { DAYS, buildWeek, profileFromSaved, starterProfile, trainingSnapshot };
});
