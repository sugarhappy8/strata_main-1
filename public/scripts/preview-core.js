(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPreview = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const GOALS = Object.freeze({
    balanced: "Balanced training",
    hypertrophy: "Build muscle",
    strength: "Build strength",
    "time-efficient": "Make the most of my time",
  });
  const GROUPS = Object.freeze({
    chest: "Chest",
    back: "Back",
    shoulders: "Shoulders",
    arms: "Arms",
    legs: "Legs",
    glutes: "Glutes",
    calves: "Lower leg",
    core: "Core",
  });
  const LEVELS = Object.freeze(["Beginner", "Intermediate", "Advanced"]);
  const FACTORS = Object.freeze({
    stimulus: "target stimulus",
    range: "useful range",
    stability: "stability",
    progression: "progression",
    fatigue: "low fatigue",
  });
  const GOAL_FACTORS = Object.freeze({
    hypertrophy: ["stimulus", "range"],
    strength: ["progression", "stability"],
    balanced: ["stimulus", "range", "stability", "progression", "fatigue"],
    "time-efficient": ["fatigue", "setup"],
  });

  function previewError(message, code) {
    return Object.assign(new Error(message), { code });
  }
  function requireProfile(profile) {
    if (!profile || !Object.hasOwn(GOALS, profile.goal))
      throw previewError("Choose a training goal.", "INVALID_PREVIEW_GOAL");
    if (!Object.hasOwn(GROUPS, profile.group))
      throw previewError("Choose a muscle group.", "INVALID_PREVIEW_GROUP");
    if (!LEVELS.includes(profile.level))
      throw previewError("Choose your training experience.", "INVALID_PREVIEW_LEVEL");
    if (typeof profile.equipment !== "string" || !profile.equipment.trim())
      throw previewError("Choose equipment you can use.", "INVALID_PREVIEW_EQUIPMENT");
  }
  function metricValue(exercise, key, discovery) {
    return key === "setup" ? discovery.setupScore(exercise) : Number(exercise?.metrics?.[key] || 0);
  }
  function signalFor(exercise, goal, discovery) {
    const key = GOAL_FACTORS[goal]
      .map((factor) => ({ factor, value: metricValue(exercise, factor, discovery) }))
      .sort((a, b) => b.value - a.value)[0];
    return {
      key: key.factor,
      label: key.factor === "setup" ? "setup simplicity" : FACTORS[key.factor],
      value: key.value,
    };
  }
  function tradeoffFor(exercise) {
    const entry = Object.keys(FACTORS)
      .map((factor) => ({ factor, value: Number(exercise?.metrics?.[factor] || 0) }))
      .sort((a, b) => a.value - b.value)[0];
    return { key: entry.factor, label: FACTORS[entry.factor], value: entry.value };
  }
  function buildPreview({ exercises, profile, discovery, limit = 3 } = {}) {
    requireProfile(profile);
    if (
      !discovery ||
      typeof discovery.personalResult !== "function" ||
      typeof discovery.setupScore !== "function"
    )
      throw previewError("The recommendation engine is unavailable.", "PREVIEW_ENGINE_UNAVAILABLE");
    if (!Array.isArray(exercises) || !exercises.length)
      throw previewError("The exercise library is unavailable.", "PREVIEW_LIBRARY_UNAVAILABLE");
    const requestedLimit = Math.max(1, Math.min(5, Math.round(Number(limit) || 3)));
    const preferences = {
      version: 1,
      goal: profile.goal,
      level: profile.level,
      days: 3,
      equipment: [profile.equipment],
      preferences: [],
      limitations: [],
    };
    const candidates = exercises
      .filter(
        (exercise) =>
          exercise?.group === profile.group && exercise?.equipment === profile.equipment,
      )
      .map((exercise) => ({ exercise, result: discovery.personalResult(exercise, preferences) }))
      .filter(({ result }) => result.eligible)
      .sort(
        (a, b) =>
          b.result.match - a.result.match ||
          Number(b.exercise.score) - Number(a.exercise.score) ||
          String(a.exercise.name).localeCompare(String(b.exercise.name)),
      );
    if (!candidates.length)
      throw previewError(
        `No ${GROUPS[profile.group].toLowerCase()} movement matches ${profile.equipment.toLowerCase()} and ${profile.level.toLowerCase()} experience yet. Choose another equipment option or experience level.`,
        "PREVIEW_NO_MATCH",
      );
    const items = candidates.slice(0, requestedLimit).map(({ exercise, result }, index) => {
      const signal = signalFor(exercise, profile.goal, discovery),
        tradeoff = tradeoffFor(exercise);
      const experience = result.reasons.includes("higher skill demand")
        ? "higher skill demand factored into rank"
        : result.reasons.includes("experience match")
          ? `${profile.level.toLowerCase()} experience match`
          : "skill demand within your experience";
      return {
        rank: index + 1,
        exercise,
        match: result.match,
        officialScore: Number(exercise.score),
        reasons: [
          `${profile.equipment} available`,
          experience,
          `${signal.label} ${signal.value}/100 supports this goal`,
        ],
        tradeoffText: `${tradeoff.label} is the lowest scored factor at ${tradeoff.value}/100`,
        signal,
        tradeoff,
      };
    });
    return {
      profile: { ...profile },
      summary: `${GOALS[profile.goal]} · ${GROUPS[profile.group]} · ${profile.equipment} · ${profile.level}`,
      items,
    };
  }
  return { FACTORS, GOALS, GROUPS, LEVELS, buildPreview, signalFor, tradeoffFor };
});
