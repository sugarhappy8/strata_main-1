(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlanInsights = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DAYS = Object.freeze([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  const MUSCLE_LABELS = Object.freeze({
    chest: "Chest",
    back: "Back",
    shoulders: "Shoulders",
    biceps: "Biceps",
    triceps: "Triceps",
    forearms: "Forearms",
    legs: "Legs",
    glutes: "Glutes",
    calves: "Calves",
    core: "Core",
    other: "Other",
  });
  const MAX_DAY_ITEMS = 30,
    MAX_WEEK_ITEMS = 140;

  function record(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function integer(value, min = 0, max = 10_000) {
    const parsed = Math.round(Number(value) || 0);
    return Math.max(min, Math.min(max, parsed));
  }
  function restDays(plan) {
    const raw = Array.isArray(plan?.restDays)
      ? plan.restDays
      : plan?.restDay == null
        ? []
        : [plan.restDay];
    return DAYS.filter((day) => raw.includes(day));
  }
  function muscleKey(exercise) {
    const group = String(exercise?.group || "").toLowerCase(),
      sub = String(exercise?.sub || "").toLowerCase();
    if (group === "arms") {
      if (sub.includes("triceps")) return "triceps";
      if (sub.includes("forearm")) return "forearms";
      return "biceps";
    }
    return Object.hasOwn(MUSCLE_LABELS, group) ? group : "other";
  }
  function estimateMinutes(items) {
    const list = Array.isArray(items) ? items : [],
      sets = list.reduce((sum, item) => sum + integer(item?.sets, 0, 10), 0);
    return list.length
      ? Math.max(10, Math.round((5 + sets * 2.25 + list.length * 1.5) / 5) * 5)
      : 0;
  }
  function safePlan(plan) {
    if (!record(plan) || !record(plan.days) || !DAYS.every((day) => Array.isArray(plan.days[day])))
      throw new TypeError("A complete weekly Plan is required.");
    return plan;
  }
  function analyzePlan(plan, exercises = []) {
    safePlan(plan);
    const catalog = new Map(
      (Array.isArray(exercises) ? exercises : [])
        .filter((exercise) => record(exercise) && exercise.id)
        .map((exercise) => [String(exercise.id), exercise]),
    );
    const muscles = new Map(),
      patterns = new Map(),
      occurrences = new Map(),
      equipment = new Map(),
      daySummaries = [];
    let totalExercises = 0,
      workingSets = 0;
    for (const day of DAYS) {
      const items = plan.days[day],
        daySets = items.reduce((sum, item) => sum + integer(item?.sets, 0, 10), 0),
        dayEquipment = new Set(),
        dayMuscles = new Set();
      totalExercises += items.length;
      workingSets += daySets;
      for (const item of items) {
        const exercise = catalog.get(String(item?.exerciseId || "")) || {},
          sets = integer(item?.sets, 0, 10),
          muscle = muscleKey(exercise),
          pattern = String(exercise.pattern || "Unclassified"),
          equipmentName = String(exercise.equipment || "Unspecified");
        const muscleEntry = muscles.get(muscle) || {
          key: muscle,
          label: MUSCLE_LABELS[muscle] || MUSCLE_LABELS.other,
          sets: 0,
          movements: 0,
          days: new Set(),
        };
        muscleEntry.sets += sets;
        muscleEntry.movements += 1;
        muscleEntry.days.add(day);
        muscles.set(muscle, muscleEntry);
        dayMuscles.add(muscle);
        const patternEntry = patterns.get(pattern) || { label: pattern, sets: 0, movements: 0 };
        patternEntry.sets += sets;
        patternEntry.movements += 1;
        patterns.set(pattern, patternEntry);
        equipment.set(equipmentName, (equipment.get(equipmentName) || 0) + sets);
        dayEquipment.add(equipmentName);
        const id = String(item?.exerciseId || ""),
          entry = occurrences.get(id) || {
            exerciseId: id,
            name: String(exercise.name || id || "Unknown exercise"),
            days: [],
            sets: 0,
          };
        entry.days.push(day);
        entry.sets += sets;
        occurrences.set(id, entry);
      }
      daySummaries.push({
        day,
        movements: items.length,
        workingSets: daySets,
        estimatedMinutes: estimateMinutes(items),
        equipment: [...dayEquipment],
        muscles: [...dayMuscles],
      });
    }
    const trainingDays = daySummaries.filter(({ movements }) => movements > 0).length,
      estimatedMinutes = daySummaries.reduce((sum, day) => sum + day.estimatedMinutes, 0),
      alerts = [];
    const denseDays = daySummaries.filter(
      (day) => day.movements >= 10 || day.workingSets >= 30 || day.estimatedMinutes >= 90,
    );
    if (denseDays.length)
      alerts.push({
        id: "dense-days",
        tone: "attention",
        title: "Review dense training days",
        detail: `${denseDays.map(({ day }) => day).join(", ")} ${denseDays.length === 1 ? "has" : "have"} at least 10 movements, 30 working sets, or a 90-minute planning estimate.`,
        action: "Spread or trim the day",
      });
    const duplicates = [...occurrences.values()]
      .filter(({ days }) => days.length > 1)
      .map((entry) => ({ ...entry, uniqueDays: [...new Set(entry.days)] }))
      .sort(
        (left, right) =>
          right.days.length - left.days.length ||
          right.sets - left.sets ||
          left.name.localeCompare(right.name),
      );
    const repeatedSameDay = duplicates.filter(
      (entry) => entry.uniqueDays.length < entry.days.length,
    );
    if (repeatedSameDay.length)
      alerts.push({
        id: "same-day-duplicates",
        tone: "attention",
        title: "Check duplicate entries",
        detail: `${repeatedSameDay
          .slice(0, 3)
          .map(({ name }) => name)
          .join(
            ", ",
          )} ${repeatedSameDay.length === 1 ? "appears" : "appear"} more than once on the same day.`,
        action: "Keep both or remove a duplicate",
      });
    const repeatedAcrossWeek = duplicates.filter((entry) => entry.uniqueDays.length >= 3);
    if (repeatedAcrossWeek.length)
      alerts.push({
        id: "high-frequency-repeats",
        tone: "review",
        title: "Confirm high-frequency repeats",
        detail: `${repeatedAcrossWeek
          .slice(0, 3)
          .map(({ name, uniqueDays }) => `${name} (${uniqueDays.length} days)`)
          .join(", ")}. Repeating can be intentional; confirm it matches your plan.`,
        action: "Review repeated movements",
      });
    if (!trainingDays)
      alerts.push({
        id: "empty-week",
        tone: "start",
        title: "Your week is empty",
        detail: "Add one repeatable training day before tuning distribution.",
        action: "Add the first movement",
      });
    if (trainingDays && !restDays(plan).length)
      alerts.push({
        id: "no-rest-day",
        tone: "review",
        title: "No recovery day is marked",
        detail:
          "Every day is currently available for training. Mark a rest day if that is not intentional.",
        action: "Review recovery days",
      });
    const muscleDistribution = [...muscles.values()]
      .map((entry) => ({ ...entry, days: [...entry.days] }))
      .sort((left, right) => right.sets - left.sets || left.label.localeCompare(right.label));
    const patternDistribution = [...patterns.values()].sort(
      (left, right) => right.sets - left.sets || left.label.localeCompare(right.label),
    );
    const equipmentDistribution = [...equipment]
      .map(([label, sets]) => ({ label, sets }))
      .sort((left, right) => right.sets - left.sets || left.label.localeCompare(right.label));
    return {
      metrics: { trainingDays, totalExercises, workingSets, estimatedMinutes },
      days: daySummaries,
      muscles: muscleDistribution,
      patterns: patternDistribution,
      equipment: equipmentDistribution,
      duplicates,
      alerts,
      nextAction: alerts[0]?.action || "Review the week, then start training",
    };
  }

  function uniqueInstanceId(existing, sourceId, target, index) {
    const stem =
      `copy-${target.toLowerCase()}-${String(sourceId || index + 1).replace(/[^A-Za-z0-9_-]/g, "-")}`.slice(
        0,
        92,
      ) || `copy-${target.toLowerCase()}-${index + 1}`;
    let candidate = stem,
      suffix = 2;
    while (existing.has(candidate))
      candidate = `${stem.slice(0, 96 - String(suffix).length)}-${suffix++}`;
    existing.add(candidate);
    return candidate;
  }
  function copyDayPreview(plan, sourceDay, targetDay, { mode = "replace" } = {}) {
    safePlan(plan);
    if (!DAYS.includes(sourceDay) || !DAYS.includes(targetDay) || sourceDay === targetDay)
      throw new TypeError("Choose two different valid Plan days.");
    if (!["replace", "merge"].includes(mode))
      throw new TypeError("Copy mode must be replace or merge.");
    const next = JSON.parse(JSON.stringify(plan)),
      source = plan.days[sourceDay],
      before = next.days[targetDay],
      existingIds = new Set(
        DAYS.flatMap((day) => next.days[day].map((item) => String(item.instanceId || ""))).filter(
          Boolean,
        ),
      );
    const existingExercises = new Set(
        mode === "merge" ? before.map((item) => String(item.exerciseId)) : [],
      ),
      skipped = [];
    const copied = [];
    source.forEach((item, index) => {
      if (existingExercises.has(String(item.exerciseId))) {
        skipped.push(String(item.exerciseId));
        return;
      }
      copied.push({
        ...item,
        instanceId: uniqueInstanceId(existingIds, item.instanceId, targetDay, index),
      });
      existingExercises.add(String(item.exerciseId));
    });
    const result = mode === "replace" ? copied : [...before, copied].flat();
    if (result.length > MAX_DAY_ITEMS)
      throw new Error(`${targetDay} would exceed ${MAX_DAY_ITEMS} movements.`);
    const currentTotal = DAYS.reduce((sum, day) => sum + next.days[day].length, 0),
      nextTotal = currentTotal - before.length + result.length;
    if (nextTotal > MAX_WEEK_ITEMS)
      throw new Error(`The copied week would exceed ${MAX_WEEK_ITEMS} movements.`);
    next.days[targetDay] = result;
    const rests = restDays(next).filter((day) => day !== targetDay);
    next.restDays = rests;
    next.restDay = rests[0] ?? null;
    return {
      plan: next,
      sourceDay,
      targetDay,
      mode,
      added: copied.length,
      replaced: mode === "replace" ? before.length : 0,
      skipped,
      changed:
        JSON.stringify(before) !== JSON.stringify(result) || restDays(plan).includes(targetDay),
    };
  }

  return { DAYS, MUSCLE_LABELS, analyzePlan, copyDayPreview, estimateMinutes, muscleKey, restDays };
});
