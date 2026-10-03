/* global module, require */
(function (root, factory) {
  const entitlements =
    typeof module === "object" && module.exports
      ? require("./entitlements")
      : root.StrataEntitlements;
  const api = factory(entitlements);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataHomeLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (entitlements) {
  "use strict";

  const GROUPS = {
    chest: {
      name: "Chest",
      description: "Pressing, adduction, and protraction across the pectorals and serratus.",
      subs: ["Upper chest", "Mid / lower chest", "Serratus anterior"],
    },
    back: {
      name: "Back",
      description:
        "Vertical and horizontal pulling for lats, scapular retractors, and spinal extensors.",
      subs: ["Latissimus dorsi", "Upper back", "Spinal erectors"],
    },
    shoulders: {
      name: "Shoulders",
      description: "Raise, press, and rotate through all three deltoid regions and the cuff.",
      subs: ["Front delts", "Side delts", "Rear delts", "Rotator cuff"],
    },
    arms: {
      name: "Arms",
      description: "Elbow flexion and extension for biceps, brachialis, triceps, and forearms.",
      subs: ["Biceps", "Brachialis", "Triceps long head", "Triceps lateral / medial", "Forearms"],
    },
    legs: {
      name: "Legs",
      description: "Knee- and hip-dominant patterns for thighs and adductors.",
      subs: ["Quadriceps", "Hamstrings", "Adductors"],
    },
    glutes: {
      name: "Glutes",
      description: "Hip extension and abduction for glute max, medius, and minimus.",
      subs: ["Glute max", "Glute med / min"],
    },
    calves: {
      name: "Lower leg",
      description: "Straight- and bent-knee plantar flexion plus active dorsiflexion.",
      subs: ["Gastrocnemius", "Soleus", "Tibialis anterior"],
    },
    core: {
      name: "Core",
      description: "Spinal flexion plus anti-extension and anti-rotation trunk control.",
      subs: ["Rectus abdominis", "Obliques", "Deep core"],
    },
  };
  const GROUP_ORDER = Object.keys(GROUPS);
  const METRIC_WEIGHTS = {
    stimulus: 0.3,
    stability: 0.2,
    progression: 0.2,
    range: 0.2,
    fatigue: 0.1,
  };
  const METRIC_LABELS = {
    stimulus: "Stimulus",
    stability: "Stability",
    progression: "Progression",
    range: "Useful range",
    fatigue: "Low fatigue",
  };
  const PLAN_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const GUEST_PLAN_KEY = "strata_guest_plan_v1";
  const PREVIEW_STARTERS = {
    dumbbells: { equipment: "Dumbbells", level: "Intermediate", minutes: 35, goal: "balanced" },
    bodyweight: { equipment: "Bodyweight", level: "Intermediate", minutes: 20, goal: "balanced" },
    barbell: { equipment: "Barbell / Smith", level: "Intermediate", minutes: 50, goal: "strength" },
  };

  function normalizeExercise(exercise) {
    if (!exercise || typeof exercise !== "object" || !GROUPS[exercise.group])
      throw new Error("The exercise catalog contains an unsupported entry.");
    const metrics = {};
    for (const key of Object.keys(METRIC_WEIGHTS)) {
      const value = Number(exercise.metrics?.[key]);
      if (!Number.isFinite(value) || value < 0 || value > 100)
        throw new Error(`The exercise catalog contains an invalid ${key} score.`);
      metrics[key] = value;
    }
    const score = Number(exercise.score);
    if (!exercise.id || !exercise.name || !Number.isFinite(score) || score < 0 || score > 100)
      throw new Error("The exercise catalog contains incomplete scoring data.");
    const weightedBaseline = Math.round(
      Object.entries(METRIC_WEIGHTS).reduce(
        (total, [key, weight]) => total + metrics[key] * weight,
        0,
      ),
    );
    return {
      ...exercise,
      score,
      metrics,
      youtube:
        exercise.youtube ||
        `https://www.youtube.com/results?search_query=${encodeURIComponent(`${exercise.name} exercise form tutorial`)}`,
      weightedBaseline,
      editorialAdjustment: score - weightedBaseline,
    };
  }

  function normalizeCatalog(catalog) {
    if (!Array.isArray(catalog) || catalog.length === 0)
      throw new Error("The exercise catalog is empty or unavailable.");
    const normalized = catalog.map(normalizeExercise),
      ids = new Set(normalized.map((exercise) => exercise.id));
    if (ids.size !== normalized.length)
      throw new Error("The exercise catalog contains duplicate IDs.");
    return normalized;
  }

  function filterExercises(exercises, state) {
    const query = String(state.query || "")
        .trim()
        .toLowerCase(),
      metric = state.sort === "score" ? "score" : state.sort;
    return exercises
      .filter((exercise) => exercise.group === state.group)
      .filter((exercise) => state.sub === "all" || exercise.sub === state.sub)
      .filter((exercise) => state.equipment === "all" || exercise.equipment === state.equipment)
      .filter((exercise) => state.level === "all" || exercise.level === state.level)
      .filter(
        (exercise) =>
          !query ||
          `${exercise.name} ${exercise.sub} ${exercise.equipment} ${exercise.pattern}`
            .toLowerCase()
            .includes(query),
      )
      .sort((left, right) =>
        state.sort === "score"
          ? right.score - left.score
          : right.metrics[metric] - left.metrics[metric],
      );
  }

  function equipmentOptions(exercises, group) {
    return [
      ...new Set(
        exercises
          .filter((exercise) => exercise.group === group)
          .map((exercise) => exercise.equipment),
      ),
    ].sort();
  }
  function validPreviewGroup(value) {
    return GROUPS[value] ? value : "chest";
  }
  function previewProfile(values = {}) {
    return {
      goal: values.goal || "balanced",
      group: validPreviewGroup(values.group),
      equipment: values.equipment || "",
      level: values.level || "Intermediate",
      days: Math.max(2, Math.min(5, Number(values.days) || 3)),
      minutes: [20, 35, 50].includes(Number(values.minutes)) ? Number(values.minutes) : 35,
    };
  }
  function previewStarter(name) {
    return Object.hasOwn(PREVIEW_STARTERS, name) ? { ...PREVIEW_STARTERS[name] } : null;
  }
  function adjustmentLabel(value) {
    return value === 0 ? "0" : `${value > 0 ? "+" : ""}${value}`;
  }
  function plannerUrl(exerciseId = null) {
    return exerciseId ? `/planner.html?add=${encodeURIComponent(exerciseId)}` : "/planner.html";
  }

  function guestPlanCount(rawPlan, exercises = null) {
    try {
      const plan = typeof rawPlan === "string" ? JSON.parse(rawPlan || "null") : rawPlan;
      const knownIds = Array.isArray(exercises)
        ? new Set(exercises.map((exercise) => exercise.id))
        : null;
      return PLAN_DAYS.reduce((total, day) => {
        const items = Array.isArray(plan?.days?.[day]) ? plan.days[day].slice(0, 40) : [];
        return (
          total +
          items.filter((item) => {
            const exerciseId =
              item && typeof item === "object" ? String(item.exerciseId || "") : "";
            return Boolean(exerciseId) && (!knownIds || knownIds.has(exerciseId));
          }).length
        );
      }, 0);
    } catch {
      return 0;
    }
  }

  function nextGroupForKey(current, key) {
    const index = Math.max(0, GROUP_ORDER.indexOf(current));
    if (key === "Home") return GROUP_ORDER[0];
    if (key === "End") return GROUP_ORDER.at(-1);
    if (key === "ArrowRight") return GROUP_ORDER[(index + 1) % GROUP_ORDER.length];
    if (key === "ArrowLeft")
      return GROUP_ORDER[(index - 1 + GROUP_ORDER.length) % GROUP_ORDER.length];
    return current;
  }

  function hasPlus(user) {
    return entitlements.can(user, "plus.studio");
  }
  return {
    GROUPS,
    GROUP_ORDER,
    METRIC_WEIGHTS,
    METRIC_LABELS,
    PLAN_DAYS,
    GUEST_PLAN_KEY,
    PREVIEW_STARTERS,
    adjustmentLabel,
    equipmentOptions,
    filterExercises,
    guestPlanCount,
    hasPlus,
    nextGroupForKey,
    normalizeCatalog,
    normalizeExercise,
    plannerUrl,
    previewProfile,
    previewStarter,
    validPreviewGroup,
  };
});
