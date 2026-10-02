/* global module */
(function (root, factory) {
  "use strict";
  const progression = factory();
  if (typeof module === "object" && module.exports) module.exports = progression;
  else root.StrataWorkoutProgression = progression;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function calendarDay(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
      ? time / 86400000
      : null;
  }
  function prescription(value, measurement) {
    const match = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[–—−]/g, "-")
      .match(/^(\d+(?:\.\d+)?)(?:\s*(?:-|to)\s*(\d+(?:\.\d+)?))?\s*(.*)$/);
    if (!match) return null;
    const factor = measurement === "timed" && /\b(?:mins?|minutes?)\b/.test(match[3]) ? 60 : 1,
      low = Number(match[1]) * factor,
      high = Number(match[2] || match[1]) * factor;
    if (
      !Number.isInteger(low) ||
      !Number.isInteger(high) ||
      low < 1 ||
      high < low ||
      high > (measurement === "timed" ? 3600 : 1000)
    )
      return null;
    const qualifier = match[3]
      .replace(
        measurement === "timed"
          ? /\b(?:s|secs?|seconds?|mins?|minutes?)\b/g
          : /\b(?:reps?|repetitions?)\b/g,
        "",
      )
      .replace(/\bper\s+side\b|\/\s*side/g, "/side")
      .replace(/\s/g, "");
    return JSON.stringify([low, high, qualifier]);
  }
  function validSets(sets, entry, count) {
    if (!Array.isArray(sets) || sets.length !== count || count < 1 || count > 10) return null;
    const integer = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
    if (
      !sets.every(
        (set) =>
          set &&
          typeof set === "object" &&
          (entry.measurement === "reps"
            ? integer(set.reps, 1000) && set.seconds === null
            : integer(set.seconds, 3600) && set.reps === null) &&
          (entry.loadType === "bodyweight"
            ? set.weight === null
            : typeof set.weight === "number" &&
              Number.isFinite(set.weight) &&
              set.weight >= 0 &&
              set.weight <= 1000),
      )
    )
      return null;
    return sets.map((set) => ({
      reps: set.reps,
      weight: set.weight,
      seconds: set.seconds,
      effort: null,
    }));
  }

  function create({ state, workout: W, memoryFor, accountRead, renderSession }) {
    let generation = 0,
      context = null,
      cache = new Map();
    const unavailable = (
      explanation = "Couldn’t load a reliable next target. Enter today’s values manually; refresh history to retry.",
    ) => ({ status: "unavailable", explanation });
    function reset() {
      generation++;
      context = null;
      cache = new Map();
    }
    function active(workoutId) {
      return (
        !state.blocked &&
        state.workout?.status === "active" &&
        state.workout.id === workoutId &&
        Boolean(state.user?.id)
      );
    }
    function current(token) {
      return (
        token.generation === generation &&
        active(token.workoutId) &&
        String(state.user?.id) === token.userId
      );
    }
    function targetFor(entry) {
      if (!active(state.workout?.id) || !state.workout.entries.includes(entry))
        return unavailable();
      if (!state.memoryReady)
        return state.memoryError
          ? unavailable(
              "Saved history is unavailable. Enter today’s values manually until it can be checked.",
            )
          : {
              status: "loading",
              explanation: "Checking your saved training before choosing the next target…",
            };
      if (
        !["reps", "timed"].includes(entry.measurement) ||
        !["external", "bodyweight", "assisted"].includes(entry.loadType) ||
        !["kg", "lb"].includes(entry.unit)
      )
        return unavailable();
      const memory = memoryFor(entry);
      if (!memory)
        return {
          status: "baseline",
          explanation: "Log this exercise once to establish a baseline for your next session.",
        };
      if (!Array.isArray(memory.sets) || !memory.sets.length)
        return unavailable(
          "No sets were completed for this exercise in the latest matching session. Enter today’s values to establish a fresh baseline.",
        );
      if (
        typeof memory.workoutId !== "string" ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(memory.workoutId) ||
        memory.workoutId === state.workout.id
      )
        return unavailable();
      if (context && !current(context)) return unavailable();
      const record = cache.get(memory.workoutId);
      if (!record || record.status === "loading")
        return {
          status: "loading",
          explanation: "Checking the next target from your previous comparable session…",
        };
      if (record.status !== "ready") return unavailable();
      const candidates = record.progression.suggestions.filter(
        (item) => item && W.formatKey(item) === W.formatKey(entry),
      );
      const range = prescription(entry.prescribedReps, entry.measurement);
      const matches = candidates.filter(
        (item) =>
          range &&
          prescription(item.prescribedReps, entry.measurement) === range &&
          item.setCount === entry.sets.length,
      );
      if (!matches.length)
        return candidates.length
          ? {
              status: "mismatch",
              explanation:
                "Your rep range or number of sets changed. Review the previous performance and enter a fresh target for this prescription.",
            }
          : unavailable(
              "No next target matches this exercise’s current logging format. Enter today’s values manually.",
            );
      if (matches.length !== 1)
        return unavailable(
          "This exercise has more than one matching prescription in the previous session. Review its recorded sets and choose today’s values manually.",
        );
      const suggestion = matches[0],
        sourceDay = calendarDay(suggestion.sourceDate),
        activeDay = calendarDay(state.workout.date),
        startedAt = suggestion.sourceStartedAt;
      if (
        !Number.isSafeInteger(startedAt) ||
        !Number.isSafeInteger(state.workout.startedAt) ||
        startedAt >= state.workout.startedAt ||
        startedAt < 0 ||
        sourceDay === null ||
        activeDay === null ||
        sourceDay > activeDay ||
        suggestion.sourceDate !== memory.date
      )
        return unavailable(
          "The previous session’s timing could not be matched safely. Enter today’s values manually.",
        );
      const sets = validSets(suggestion.targetSets, entry, entry.sets.length);
      if (!sets)
        return unavailable(
          "The saved next target is incomplete or outside the supported logging range. Enter today’s values manually.",
        );
      if (activeDay - sourceDay > 28) {
        const repeated = validSets(memory.sets, entry, entry.sets.length);
        if (!repeated)
          return unavailable(
            "It has been over 28 days since this exercise, and its recorded sets do not match today’s prescription. Establish a fresh baseline manually.",
          );
        const explanation =
          "It has been over 28 days since this exercise. Use the previous values as a fresh baseline, adjust them to how you feel today, and log a comparable session before increasing.";
        const held = {
          ...suggestion,
          action: "repeat",
          basis: "returning-baseline",
          target: {
            reps: repeated[0].reps,
            weight: repeated[0].weight,
            seconds: repeated[0].seconds,
          },
          targetSets: repeated,
          explanation,
        };
        return {
          status: "ready",
          suggestion: held,
          sets: repeated,
          explanation,
          sourceDate: suggestion.sourceDate,
        };
      }
      return {
        status: "ready",
        suggestion: { ...suggestion, targetSets: sets },
        sets,
        explanation:
          typeof suggestion.explanation === "string"
            ? suggestion.explanation
            : "Review this target before training.",
        sourceDate: suggestion.sourceDate,
      };
    }
    async function load(workoutId) {
      if (!active(workoutId) || !state.memoryReady) return;
      const userId = String(state.user.id);
      if (context && (context.workoutId !== workoutId || context.userId !== userId)) reset();
      if (!context) context = { workoutId, userId, generation };
      const token = context,
        tasks = [];
      for (const entry of state.workout.entries) {
        const memory = memoryFor(entry),
          sourceId = memory?.workoutId;
        if (
          typeof sourceId !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(sourceId) ||
          sourceId === workoutId ||
          cache.has(sourceId)
        )
          continue;
        const record = { status: "loading", progression: null };
        cache.set(sourceId, record);
        tasks.push(
          (async () => {
            try {
              const result = await accountRead(
                `/api/workouts/${encodeURIComponent(sourceId)}/progression`,
              );
              if (!current(token)) return;
              if (
                result?.progression?.workoutId !== sourceId ||
                !Array.isArray(result.progression.suggestions) ||
                result.progression.suggestions.length > 100
              )
                throw new Error("Incomplete progression response");
              record.progression = result.progression;
              record.status = "ready";
            } catch {
              if (current(token)) record.status = "unavailable";
            }
          })(),
        );
      }
      if (!tasks.length) return;
      await Promise.all(tasks);
      if (current(token)) renderSession();
    }
    return { reset, load, targetFor };
  }
  return { create };
});
