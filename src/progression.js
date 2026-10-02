// @ts-check
"use strict";

const { EXERCISES } = require("./plans");
const EXERCISE_BY_ID = new Map(EXERCISES.map((exercise) => [exercise.id, exercise]));
/** @typedef {Record<string,any>} RecordValue */
/** @typedef {{reps:number|null,weight:number|null,seconds:number|null,effort:null}} TargetSet */
/** @typedef {{difficulty:number,energy:number,comfort:number,enjoyment:number}} CheckIn */
/** @param {RecordValue} entry */
function formatKey(entry) {
  return JSON.stringify([entry.exerciseId, entry.measurement, entry.loadType, entry.unit]);
}
/** @param {RecordValue} entry */
function prescribedRange(entry) {
  const match = String(entry.prescribedReps || "")
    .trim()
    .match(/^(\d{1,4})(?:\s*(?:[-–—]|to)\s*(\d{1,4}))?\s*(?:reps?|sec(?:onds?)?|s)?$/i);
  if (!match) return null;
  const low = Number(match[1]),
    high = Number(match[2] || match[1]),
    max = entry.measurement === "timed" ? 3600 : 1000;
  return low > 0 && high >= low && high <= max ? { low, high } : null;
}
/** @param {unknown} value @returns {value is RecordValue} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @param {number} max @param {boolean} [whole] @returns {number|null} */
function bounded(value, max, whole = true) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max &&
    (whole ? Number.isInteger(value) : Math.abs(value * 100 - Math.round(value * 100)) < 0.0000001)
    ? value
    : null;
}
/** @param {unknown} value */
function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
/** @param {RecordValue} workout */
function validWorkout(workout) {
  return (
    workout.status === "completed" &&
    validDate(workout.date) &&
    bounded(workout.startedAt, Number.MAX_SAFE_INTEGER) !== null &&
    bounded(workout.completedAt, Number.MAX_SAFE_INTEGER) !== null &&
    workout.completedAt >= workout.startedAt &&
    Array.isArray(workout.entries)
  );
}
/**
 * The latest exposure is authoritative, even when its sets cannot support an increase.
 * Never skip an intervening changed prescription or unfinished exercise.
 * @param {RecordValue} workout @param {RecordValue[]} histories @param {RecordValue} entry
 * @returns {{workout:RecordValue,entry:RecordValue,ambiguous:boolean}|null}
 */
function findPreviousWorkout(workout, histories, entry) {
  if (!validWorkout(workout)) return null;
  const candidates = histories
    .filter(
      (prior) =>
        record(prior) &&
        validWorkout(prior) &&
        prior.id !== workout.id &&
        prior.startedAt < workout.startedAt &&
        prior.completedAt <= workout.startedAt &&
        prior.date < workout.date,
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const prior of candidates) {
    const matches = prior.entries.filter(
      (/** @type {RecordValue} */ candidate) =>
        record(candidate) && formatKey(candidate) === formatKey(entry),
    );
    if (matches[0]) return { workout: prior, entry: matches[0], ambiguous: matches.length !== 1 };
  }
  return null;
}
/** @param {RecordValue} entry @returns {TargetSet[]} */
function recordedSets(entry) {
  return (Array.isArray(entry.sets) ? entry.sets.slice(0, 10) : []).map(
    (/** @type {unknown} */ value) => {
      const set = record(value) && value.completed === true ? value : {};
      return {
        reps: entry.measurement === "reps" ? bounded(set.reps, 1000) : null,
        weight: entry.loadType === "bodyweight" ? null : bounded(set.weight, 1000, false),
        seconds: entry.measurement === "timed" ? bounded(set.seconds, 3600) : null,
        effort: null,
      };
    },
  );
}
/** @param {RecordValue} entry @param {TargetSet[]} sets */
function fullyCompleted(entry, sets) {
  return (
    ["reps", "timed"].includes(entry.measurement) &&
    ["external", "assisted", "bodyweight"].includes(entry.loadType) &&
    ["kg", "lb"].includes(entry.unit) &&
    sets.length > 0 &&
    sets.length === entry.sets.length &&
    sets.every((set, index) => {
      const raw = entry.sets[index],
        effort = raw?.effort;
      const validEffort =
        effort == null ||
        (["rir", "rpe"].includes(entry.effortType) &&
          bounded(effort, 10, false) !== null &&
          effort * 2 === Math.round(effort * 2) &&
          (entry.effortType !== "rpe" || effort >= 1));
      return (
        raw?.completed === true &&
        validEffort &&
        (entry.measurement === "timed"
          ? set.seconds !== null && set.seconds > 0 && raw.reps == null
          : set.reps !== null && set.reps > 0 && raw.seconds == null) &&
        (entry.loadType === "bodyweight" || set.weight !== null)
      );
    })
  );
}
/** @param {RecordValue} entry */
function highEffort(entry) {
  return (
    Array.isArray(entry.sets) &&
    entry.sets.some(
      (/** @type {RecordValue} */ set) =>
        record(set) &&
        typeof set.effort === "number" &&
        ((entry.effortType === "rir" && set.effort < 2) ||
          (entry.effortType === "rpe" && set.effort > 8)),
    )
  );
}
/** @param {TargetSet[]} sets */
function sameLoad(sets) {
  return sets.length > 0 && sets.every((set) => set.weight === sets[0]?.weight);
}
/** @param {TargetSet[]} sets */
function weakest(sets) {
  return sets.reduce(
    (lowest, set, index) =>
      Number(set.reps ?? set.seconds ?? 0) <
      Number(sets[lowest]?.reps ?? sets[lowest]?.seconds ?? 0)
        ? index
        : lowest,
    0,
  );
}
/** @param {TargetSet[]} sets */
function summary(sets) {
  const set = sets[weakest(sets)];
  return {
    reps: set?.reps ?? null,
    weight: sameLoad(sets) ? (set?.weight ?? null) : null,
    seconds: set?.seconds ?? null,
  };
}
/** @param {RecordValue} entry @param {RecordValue} prior */
function samePrescription(entry, prior) {
  const range = prescribedRange(entry),
    previousRange = prescribedRange(prior);
  return range && previousRange
    ? range.low === previousRange.low && range.high === previousRange.high
    : String(entry.prescribedReps || "").trim() === String(prior.prescribedReps || "").trim();
}
/** @param {RecordValue} entry @param {TargetSet[]} current @param {TargetSet[]} prior */
function underperformed(entry, current, prior) {
  const metric = entry.measurement === "timed" ? "seconds" : "reps",
    range = prescribedRange(entry);
  return current.some(
    (set, index) =>
      Number(set[metric]) < Number(prior[index]?.[metric]) ||
      (range && (Number(set[metric]) < range.low || Number(prior[index]?.[metric]) < range.low)),
  );
}
/**
 * Two complete comparable exposures are an app heuristic, not a predicted training outcome.
 * Full per-set history is required; summaries and a single best set never authorize increases.
 * @param {RecordValue} workout @param {RecordValue[]} histories @param {CheckIn|null} checkIn
 * @param {"reps-then-load"|"reps-only"|"time"} [progressionRule] @param {boolean} [lighterWeek]
 */
function progressionForWorkout(
  workout,
  histories,
  checkIn,
  progressionRule = "reps-then-load",
  lighterWeek = false,
) {
  const suggestions = /** @type {RecordValue[]} */ ([]);
  const entries = Array.isArray(workout.entries) ? workout.entries.filter(record) : [];
  for (const entry of entries) {
    if (
      !Array.isArray(entry.sets) ||
      !entry.sets.some((/** @type {RecordValue} */ set) => record(set) && set.completed === true)
    )
      continue;
    const source = recordedSets(entry),
      targetSets = source.map((set) => ({ ...set })),
      completed = summary(source);
    const previous = findPreviousWorkout(workout, Array.isArray(histories) ? histories : [], entry),
      prior = previous ? recordedSets(previous.entry) : [];
    const range = prescribedRange(entry),
      timed = entry.measurement === "timed",
      metric = timed ? "seconds" : "reps";
    let action = "repeat",
      basis = "baseline",
      explanation =
        "Use these recorded sets as a baseline. Complete another comparable session before increasing the target.";
    let target = { ...completed };
    const hold =
      checkIn && (checkIn.comfort <= 2 || checkIn.energy <= 2 || checkIn.difficulty >= 5);
    const ambiguous =
      entries.filter((candidate) => formatKey(candidate) === formatKey(entry)).length !== 1 ||
      previous?.ambiguous;
    if (ambiguous) {
      basis = "ambiguous";
      explanation =
        "This exercise appears more than once with the same setup. Repeat its recorded sets; a separate comparable entry is needed before suggesting an increase.";
    } else if (!validWorkout(workout) || !fullyCompleted(entry, source)) {
      basis = "incomplete";
      explanation =
        "Complete every planned set with valid reps or time and a recorded load before increasing this target. Keep the recorded set values for now.";
    } else if (lighterWeek) {
      basis = "lighter-week";
      explanation =
        "This is the selected lighter week in your active block. Keep the recorded targets unchanged and review the week before progressing again.";
    } else if (hold) {
      basis = "hold";
      const reason =
        checkIn.comfort <= 2
          ? `comfort ${checkIn.comfort}/5`
          : checkIn.energy <= 2
            ? `energy ${checkIn.energy}/5`
            : `difficulty ${checkIn.difficulty}/5`;
      explanation = `You reported ${reason}. Keep the recorded targets unchanged; adjust or stop a movement if it does not feel right.`;
    } else if (highEffort(entry) || (previous && highEffort(previous.entry))) {
      basis = "hold";
      explanation =
        "A recorded set was above RPE 8 or below 2 reps in reserve. Repeat these targets before increasing the demand.";
    } else if (!sameLoad(source)) {
      basis = "mixed-load";
      explanation =
        "Your sets used different loads. Repeat each recorded set; a consistent load across all sets is needed before an increase can be suggested.";
    } else if (!previous) {
      // A first exposure is useful guidance even without a check-in.
    } else if (Date.parse(workout.date) - Date.parse(previous.workout.date) > 28 * 86400000) {
      basis = "stale-baseline";
      explanation =
        "The previous comparable session was more than 28 days earlier. Repeat these recorded sets to establish a fresh baseline before increasing the target.";
    } else if (!fullyCompleted(previous.entry, prior)) {
      basis = "incomplete";
      explanation =
        "The previous comparable session did not have every set completed with valid values. Repeat these recorded sets to establish a complete baseline.";
    } else if (
      !samePrescription(entry, previous.entry) ||
      source.length !== prior.length ||
      !sameLoad(prior) ||
      source[0]?.weight !== prior[0]?.weight
    ) {
      basis = "baseline";
      explanation =
        "The previous session used a different prescription, set count, or load. Repeat these recorded sets to establish a comparable baseline.";
    } else if (!range) {
      basis = "prescription-needed";
      explanation =
        "Review the exercise prescription and set a clear numeric rep range or a range in seconds before increasing these recorded targets.";
    } else if (underperformed(entry, source, prior)) {
      basis = "repeat-comparable";
      explanation =
        "At least one set was below the previous comparable result, or either session fell below the prescribed minimum. Repeat each recorded set before increasing the target.";
    } else if (
      (timed && progressionRule === "reps-only") ||
      (!timed && progressionRule === "time")
    ) {
      basis = "block-rule";
      explanation = `This block uses ${timed ? "repetitions-only" : "time-based"} progression, so these recorded targets stay unchanged for review.`;
    } else {
      const lowIndex = weakest(source),
        value = Number(source[lowIndex]?.[metric]),
        ceiling = range?.high ?? (timed ? 3600 : 1000);
      const bothAtTop =
        !!range &&
        source.every((set) => Number(set[metric]) >= range.high) &&
        prior.every((set) => Number(set[metric]) >= range.high);
      if (
        !timed &&
        progressionRule === "reps-then-load" &&
        bothAtTop &&
        entry.loadType !== "bodyweight"
      ) {
        const load = source[0]?.weight ?? 0,
          increment = entry.unit === "lb" ? 5 : 2.5,
          assisted = entry.loadType === "assisted";
        const next = Math.round((load + (assisted ? -increment : increment)) * 100) / 100;
        if (load <= 0 || increment > load * 0.1 || next < 0 || next > 1000) {
          basis = "smaller-increment";
          explanation = `The usual ${increment} ${entry.unit} ${assisted ? "assistance reduction" : "increase"} is too large for this recorded load. Keep these targets and use a smaller available increment before progressing.`;
        } else {
          action = assisted ? "reduce_assistance" : "increase_load";
          basis = "comparable-progression";
          for (const set of targetSets) {
            set.weight = next;
            set.reps = range.low;
          }
          target = summary(targetSets);
          explanation = `Every set reached the top of the ${range.low}–${range.high} rep range in two comparable sessions. If reps felt controlled, try ${next} ${entry.unit}${assisted ? " of assistance" : ""} for ${range.low} reps per set next time.`;
        }
      } else if (value < ceiling) {
        const selected = targetSets[lowIndex];
        if (selected) {
          selected[metric] = Math.min(ceiling, value + (timed ? 5 : 1));
          target = { reps: selected.reps, weight: selected.weight, seconds: selected.seconds };
          action = timed ? "increase_time" : "increase_reps";
          basis = "comparable-progression";
          explanation = `You completed every set and matched the previous comparable session. If ${timed ? "the holds" : "reps"} felt controlled, aim for ${selected[metric]} ${timed ? "seconds" : "reps"} on set ${lowIndex + 1}; keep the other sets unchanged.`;
        }
      } else {
        basis = "at-target";
        explanation = bothAtTop
          ? "You have reached the prescribed target. Repeat these sets or review the prescription before increasing it."
          : "Every set reached the top of the range this time. Repeat these targets; two comparable sessions at the top are needed before a load change.";
      }
    }
    suggestions.push({
      exerciseId: entry.exerciseId,
      entryId: entry.id,
      name: EXERCISE_BY_ID.get(entry.exerciseId)?.name || entry.exerciseId,
      measurement: entry.measurement,
      loadType: entry.loadType,
      unit: entry.unit,
      prescribedReps: entry.prescribedReps || "",
      setCount: source.length,
      sourceDate: workout.date,
      sourceStartedAt: workout.startedAt,
      timing: "Next time you train this exercise",
      action,
      completed,
      previous: previous ? summary(prior) : null,
      target,
      targetSets,
      basis,
      explanation,
      requiresApproval: true,
    });
  }
  return {
    workoutId: workout.id,
    generatedFrom: "recorded-performance-and-member-check-in",
    progressionRule,
    suggestions,
  };
}

module.exports = { progressionForWorkout, formatKey, prescribedRange, findPreviousWorkout };
