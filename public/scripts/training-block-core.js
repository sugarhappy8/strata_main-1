(function (root) {
  "use strict";

  const DAY_MS = 86_400_000;
  const DAYS = Object.freeze([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  const GROUP_LABELS = Object.freeze({
    chest: "Chest",
    back: "Back",
    shoulders: "Shoulders",
    arms: "Arms",
    legs: "Legs",
    glutes: "Glutes",
    calves: "Calves",
    core: "Core",
    other: "Other",
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
  function boundedWeeks(value) {
    return clamp(Math.round(Number(value) || 6), 4, 8);
  }
  function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[0])
      return null;
    return date;
  }
  function dateKey(value) {
    if (typeof value === "string") return parseDateKey(value)?.toISOString().slice(0, 10) || null;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
    return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  function addDays(value, amount) {
    const date = parseDateKey(value);
    if (!date) return null;
    date.setUTCDate(date.getUTCDate() + Number(amount));
    return date.toISOString().slice(0, 10);
  }
  function compareDateKeys(left, right) {
    return String(left).localeCompare(String(right));
  }
  function dateInRange(value, start, end) {
    const key = dateKey(value);
    return Boolean(key && compareDateKeys(key, start) >= 0 && compareDateKeys(key, end) <= 0);
  }
  function formatDate(value) {
    const parsed = parseDateKey(value);
    if (!parsed) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(parsed);
  }

  function deriveWeek(block, today = new Date()) {
    const weeks = boundedWeeks(block?.weeks),
      startDate = dateKey(block?.startDate),
      todayDate = dateKey(today);
    if (!startDate || !todayDate)
      return {
        valid: false,
        weeks,
        week: 1,
        startDate: startDate || "",
        weekStart: startDate || "",
        weekEnd: startDate || "",
        blockEnd: startDate || "",
        beforeStart: false,
        afterEnd: false,
      };
    const elapsedDays = Math.floor(
        (parseDateKey(todayDate).getTime() - parseDateKey(startDate).getTime()) / DAY_MS,
      ),
      rawWeek = Math.floor(elapsedDays / 7) + 1,
      week = clamp(rawWeek, 1, weeks),
      weekStart = addDays(startDate, (week - 1) * 7),
      weekEnd = addDays(weekStart, 6),
      blockEnd = addDays(startDate, weeks * 7 - 1);
    return {
      valid: true,
      weeks,
      week,
      startDate,
      weekStart,
      weekEnd,
      blockEnd,
      beforeStart: elapsedDays < 0,
      afterEnd: compareDateKeys(todayDate, blockEnd) > 0,
    };
  }

  function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  }
  function catalogIndex(exercises) {
    return new Map(
      (Array.isArray(exercises) ? exercises : [])
        .filter((exercise) => isRecord(exercise) && exercise.id)
        .map((exercise) => [String(exercise.id), exercise]),
    );
  }
  function muscleFor(exerciseId, catalog) {
    const group = String(catalog.get(String(exerciseId))?.group || "other").toLowerCase();
    return Object.hasOwn(GROUP_LABELS, group) ? group : "other";
  }
  function addSets(target, muscle, sets) {
    if (sets > 0) target.set(muscle, (target.get(muscle) || 0) + sets);
  }
  function sortedMuscles(planned, completed) {
    return [...new Set([...planned.keys(), ...completed.keys()])]
      .map((key) => ({
        key,
        label: GROUP_LABELS[key] || GROUP_LABELS.other,
        planned: planned.get(key) || 0,
        completed: completed.get(key) || 0,
      }))
      .sort(
        (a, b) =>
          b.planned + b.completed - (a.planned + a.completed) || a.label.localeCompare(b.label),
      );
  }

  function performanceMetric(summary) {
    if (!isRecord(summary) || positiveInteger(summary.completedSets) === 0) return null;
    if (summary.measurement === "timed" && Number(summary.maxSeconds) > 0)
      return {
        key: "time",
        value: Number(summary.maxSeconds),
        higher: true,
        label: `${Number(summary.maxSeconds)} sec`,
      };
    if (summary.loadType === "external" && Number(summary.maxWeight) > 0) {
      const unit = summary.unit === "lb" ? "lb" : "kg";
      return {
        key: `load:${unit}`,
        value: Number(summary.maxWeight),
        higher: true,
        label: `${Number(summary.maxWeight)} ${unit}`,
      };
    }
    if (
      summary.loadType === "assisted" &&
      summary.minAssistance != null &&
      Number.isFinite(Number(summary.minAssistance)) &&
      Number(summary.maxReps) > 0
    ) {
      const unit = summary.unit === "lb" ? "lb" : "kg";
      return {
        key: `assistance:${unit}`,
        value: Number(summary.minAssistance),
        higher: false,
        label: `${Number(summary.minAssistance)} ${unit} assistance`,
      };
    }
    if (Number(summary.maxReps) > 0)
      return {
        key: "reps",
        value: Number(summary.maxReps),
        higher: true,
        label: `${Number(summary.maxReps)} reps`,
      };
    return null;
  }
  function performanceKey(summary, metric) {
    return `${String(summary.exerciseId || "")}:${String(summary.measurement || "")}:${String(summary.loadType || "")}:${String(summary.unit || "")}:${metric.key}`;
  }
  function isBetter(metric, baseline) {
    return metric.higher ? metric.value > baseline : metric.value < baseline;
  }
  function performanceEvidence(workouts, start, end) {
    const completed = (Array.isArray(workouts) ? workouts : [])
      .filter(
        (workout) =>
          isRecord(workout) &&
          workout.status === "completed" &&
          dateKey(workout.date) &&
          Array.isArray(workout.exerciseSummaries),
      )
      .slice()
      .sort(
        (a, b) =>
          compareDateKeys(a.date, b.date) || Number(a.startedAt || 0) - Number(b.startedAt || 0),
      );
    const previous = new Map(),
      best = new Map(),
      improvements = [],
      records = [];
    for (const workout of completed) {
      for (const summary of workout.exerciseSummaries) {
        const metric = performanceMetric(summary);
        if (!metric) continue;
        const key = performanceKey(summary, metric),
          prior = previous.get(key),
          priorBest = best.get(key),
          inWindow = dateInRange(workout.date, start, end);
        if (prior && isBetter(metric, prior.value) && inWindow)
          improvements.push({
            exerciseId: String(summary.exerciseId || ""),
            date: workout.date,
            before: prior.label,
            after: metric.label,
          });
        if (priorBest && isBetter(metric, priorBest.value) && inWindow)
          records.push({
            exerciseId: String(summary.exerciseId || ""),
            date: workout.date,
            before: priorBest.label,
            after: metric.label,
          });
        previous.set(key, { value: metric.value, label: metric.label });
        if (!priorBest || isBetter(metric, priorBest.value))
          best.set(key, { value: metric.value, label: metric.label });
      }
    }
    return { improvements: improvements.slice(-4).reverse(), records: records.slice(-4).reverse() };
  }

  function explicitSignal(workout, type) {
    const countKey = `${type}Count`,
      listKey = type === "replaced" ? "replacements" : "skippedExercises";
    if (
      Object.hasOwn(workout, countKey) &&
      Number.isSafeInteger(Number(workout[countKey])) &&
      Number(workout[countKey]) >= 0
    )
      return { available: true, count: Number(workout[countKey]) };
    if (Array.isArray(workout[listKey])) return { available: true, count: workout[listKey].length };
    const summaries = Array.isArray(workout.exerciseSummaries) ? workout.exerciseSummaries : [];
    if (type === "replaced") {
      const marked = summaries.filter((summary) =>
        Object.hasOwn(summary, "replacedFromExerciseId"),
      );
      if (marked.length)
        return {
          available: true,
          count: marked.filter((summary) => Boolean(summary.replacedFromExerciseId)).length,
        };
    } else {
      const marked = summaries.filter(
        (summary) =>
          Object.hasOwn(summary, "skipped") ||
          (Object.hasOwn(summary, "status") && summary.status === "skipped"),
      );
      if (marked.length)
        return {
          available: true,
          count: marked.filter(
            (summary) => summary.skipped === true || summary.status === "skipped",
          ).length,
        };
    }
    return { available: false, count: 0 };
  }
  function combinedSignal(workouts, type) {
    const signals = workouts.map((workout) => explicitSignal(workout, type)),
      available = signals.some((signal) => signal.available);
    return {
      available,
      count: available
        ? signals.reduce((sum, signal) => sum + (signal.available ? signal.count : 0), 0)
        : 0,
    };
  }

  function nextDecision({ block, timeline, plannedWorkouts, completedWorkouts }) {
    if (block?.status === "completed")
      return "Review the finished block, then choose a new start date when you want another.";
    if (!plannedWorkouts) return "Build a weekly Plan before deciding how this block continues.";
    if (timeline.beforeStart)
      return `Keep the Plan ready for week 1, starting ${formatDate(timeline.startDate)}.`;
    if (timeline.afterEnd || timeline.week === timeline.weeks)
      return "Review the final week, then explicitly finish the block or leave it active.";
    if (block?.lightWeek === timeline.week)
      return "Review this lighter week; no working sets change unless you edit the Plan.";
    if (completedWorkouts < plannedWorkouts)
      return "Complete or reschedule the next planned workout before reviewing the week.";
    return `Review the logged week, then carry the same Plan into week ${timeline.week + 1} or schedule it lighter.`;
  }

  function weekReview({ block, weeklyPlan, workouts, exercises, today = new Date() } = {}) {
    const timeline = deriveWeek(block, today),
      catalog = catalogIndex(exercises),
      plannedSets = new Map(),
      completedSets = new Map();
    let plannedWorkouts = 0;
    for (const day of DAYS) {
      const items = Array.isArray(weeklyPlan?.days?.[day]) ? weeklyPlan.days[day] : [];
      if (items.length) plannedWorkouts += 1;
      for (const item of items)
        addSets(plannedSets, muscleFor(item?.exerciseId, catalog), positiveInteger(item?.sets));
    }
    const inWeek = (Array.isArray(workouts) ? workouts : []).filter(
      (workout) =>
        isRecord(workout) &&
        workout.status === "completed" &&
        dateInRange(workout.date, timeline.weekStart, timeline.weekEnd),
    );
    for (const workout of inWeek)
      for (const summary of Array.isArray(workout.exerciseSummaries)
        ? workout.exerciseSummaries
        : [])
        addSets(
          completedSets,
          muscleFor(summary?.exerciseId, catalog),
          positiveInteger(summary?.completedSets),
        );
    const performance = timeline.valid
        ? performanceEvidence(workouts, timeline.weekStart, timeline.weekEnd)
        : { improvements: [], records: [] },
      skipped = combinedSignal(inWeek, "skipped"),
      replaced = combinedSignal(inWeek, "replaced"),
      completedWorkouts = inWeek.length;
    return {
      timeline,
      plannedWorkouts,
      completedWorkouts,
      plannedSets: [...plannedSets.values()].reduce((sum, value) => sum + value, 0),
      completedSets: [...completedSets.values()].reduce((sum, value) => sum + value, 0),
      muscles: sortedMuscles(plannedSets, completedSets),
      performance,
      skipped,
      replaced,
      nextDecision: nextDecision({ block, timeline, plannedWorkouts, completedWorkouts }),
      actions: {
        carry: Boolean(
          block && block.status === "active" && plannedWorkouts && timeline.week < timeline.weeks,
        ),
        lighter: Boolean(block && block.status === "active"),
        finish: Boolean(block && block.status === "active"),
      },
    };
  }

  function actionProposal(block, action, today = new Date()) {
    if (!isRecord(block)) throw new Error("Save a training block before reviewing an action.");
    const timeline = deriveWeek(block, today),
      base = {
        ...block,
        currentWeek: timeline.week,
        milestones: Array.isArray(block.milestones)
          ? block.milestones.map((item) => ({ ...item }))
          : [],
      };
    delete base.revision;
    delete base.updatedAt;
    if (action === "carry") {
      if (block.status !== "active" || timeline.week >= timeline.weeks)
        throw new Error("There is no later block week to carry forward.");
      return {
        action,
        block: { ...base, status: "active" },
        title: `Carry the Plan into week ${timeline.week + 1}?`,
        description:
          "This records the current calendar-derived week and keeps your saved weekly Plan unchanged. The same Plan remains available next week.",
        confirmLabel: "Carry Plan forward",
      };
    }
    if (action === "lighter") {
      if (block.status !== "active")
        throw new Error("A completed block cannot schedule another lighter week.");
      const lightWeek = clamp(
        timeline.week < timeline.weeks ? timeline.week + 1 : timeline.week,
        2,
        timeline.weeks,
      );
      return {
        action,
        block: { ...base, status: "active", lightWeek },
        title: `Schedule week ${lightWeek} as lighter?`,
        description:
          "This saves a reminder on the training block only. It does not reduce, remove, or replace any working sets in your weekly Plan.",
        confirmLabel: "Schedule lighter week",
      };
    }
    if (action === "finish") {
      if (block.status !== "active") throw new Error("This training block is already complete.");
      return {
        action,
        block: { ...base, status: "completed", currentWeek: timeline.weeks },
        title: "Finish this training block?",
        description:
          "This marks the block complete. Your weekly Plan, logged workouts, and progress records remain unchanged.",
        confirmLabel: "Finish block",
      };
    }
    throw new Error("Choose a valid training-block action.");
  }

  root.StrataTrainingBlock = Object.freeze({
    DAYS,
    GROUP_LABELS,
    deriveWeek,
    weekReview,
    actionProposal,
    formatDate,
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
