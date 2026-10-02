// @ts-check
"use strict";

const { DAYS, EXERCISES } = require("./plans");

const EXERCISE_BY_ID = new Map(EXERCISES.map((/** @type {any} */ item) => [String(item.id), item]));
const SET_TARGETS = new Map([
  [30, 10],
  [45, 16],
  [60, 22],
  [75, 28],
  [90, 34],
]);
/** @param {any} plan */
function activeDays(plan) {
  return DAYS.filter((day) => Array.isArray(plan?.days?.[day]) && plan.days[day].length);
}
/** @param {any[]} items */
function totalSets(items) {
  return items.reduce((sum, item) => sum + item.sets, 0);
}
/** @param {any[]} items @param {any[]} candidates */
function addExercise(items, candidates) {
  const used = new Set(items.map((item) => item.exerciseId)),
    next = candidates.find((item) => !used.has(String(item.id)));
  if (!next) return false;
  items.push({ exerciseId: String(next.id), sets: 1, reps: String(next.reps || "8–12") });
  return true;
}
/** @param {any[]} source @param {number|null} target @param {any[]} candidates */
function tuneDay(source, target, candidates) {
  const seen = new Set(),
    items = source
      .map((item) => ({
        exerciseId: String(item.exerciseId),
        sets: Math.max(1, Math.min(6, Math.round(Number(item.sets) || 3))),
        reps: String(item.reps || "8–12"),
      }))
      .filter((item) => {
        if (!EXERCISE_BY_ID.has(item.exerciseId) || seen.has(item.exerciseId)) return false;
        seen.add(item.exerciseId);
        return true;
      })
      .slice(0, 8);
  while (items.length < 2 && items.length < 8) if (!addExercise(items, candidates)) return null;
  if (target != null) {
    while (totalSets(items) < target) {
      let changed = false;
      for (const item of items)
        if (item.sets < 6 && totalSets(items) < target) {
          item.sets += 1;
          changed = true;
        }
      if (!changed) {
        if (items.length >= 8 || !addExercise(items, candidates)) return null;
      }
    }
    while (totalSets(items) > target) {
      let changed = false;
      for (const item of [...items].reverse())
        if (item.sets > 1 && totalSets(items) > target) {
          item.sets -= 1;
          changed = true;
        }
      if (!changed) return null;
    }
  }
  return items;
}

/** A narrow, validated last resort for measurable edits when a local model cannot format its plan. @param {{basePlan:any,contract:any,candidates:any[]}} input */
function fallbackPlanResponse({ basePlan, contract, candidates }) {
  if (!contract?.fallbackSafe) return null;
  const base = activeDays(basePlan),
    selected =
      Array.isArray(contract.targetTrainingDays) && contract.targetTrainingDays.length
        ? contract.targetTrainingDays
        : contract.preserveDays
          ? base
          : null;
  if (!selected?.length) return null;
  const available = [...new Map(candidates.map((item) => [String(item.id), item])).values()],
    defaultSource = available
      .slice(0, 3)
      .map((item) => ({ exerciseId: String(item.id), sets: 3, reps: String(item.reps || "8–12") }));
  if (!base.length && defaultSource.length < 2) return null;
  const target =
      contract.sessionMinutes == null
        ? null
        : (SET_TARGETS.get(Number(contract.sessionMinutes)) ?? null),
    days = [];
  for (const [index, day] of selected.entries()) {
    const fallbackDay = base[index % base.length],
      source = base.includes(day)
        ? basePlan.days[day]
        : fallbackDay
          ? basePlan.days[fallbackDay]
          : defaultSource,
      items = tuneDay(source, target, available);
    if (!items) return null;
    days.push({
      day,
      name: `${day} training`,
      exercises: items.map((item) => [
        EXERCISE_BY_ID.get(item.exerciseId)?.name ||
          available.find((candidate) => String(candidate.id) === item.exerciseId)?.name ||
          item.exerciseId,
        item.sets,
        item.reps,
      ]),
    });
  }
  return {
    reply: "Your requested weekly-plan change is ready.",
    week: { title: "Updated weekly plan", focus: "balanced", days },
    nutrition: null,
    suggestions: [],
    search: [],
  };
}

module.exports = { fallbackPlanResponse };
