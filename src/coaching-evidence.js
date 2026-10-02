// @ts-check
"use strict";

const {
  addDays,
  sanitizeCoachingProfile,
  validDate,
  weekStartForDate,
} = require("./coaching-core");
const { CALIBRATION_DAYS } = require("./energy-calibration-core");

/** @param {any} value */
function parsed(value) {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
/** @param {any} value */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {any} value */
function isDate(value) {
  try {
    return validDate(value) === value;
  } catch {
    return false;
  }
}
/** A stored row's identity must agree before any of its targets can be attributed. @param {any} row */
function storedWeek(row) {
  const week = row && parsed(row.snapshot_json);
  return record(week) &&
    isDate(week.weekStart) &&
    weekStartForDate(week.weekStart) === week.weekStart &&
    week.weekStart === row.week_start &&
    typeof week.planKey === "string" &&
    week.planKey.length > 0 &&
    week.planKey === row.plan_key &&
    Number.isSafeInteger(week.profileRevision) &&
    week.profileRevision >= 1 &&
    week.profileRevision === Number(row.profile_revision)
    ? week
    : null;
}
/** @param {any} input */
function canonicalProfile(input) {
  if (!record(input)) return null;
  try {
    const copy = { ...input },
      sessions = copy.sessionsPerWeek;
    delete copy.sessionsPerWeek;
    delete copy.revision;
    delete copy.updatedAt;
    const normalized = sanitizeCoachingProfile(copy, { allowLegacyProfile: true });
    return sessions !== undefined && sessions !== normalized.sessionsPerWeek
      ? null
      : JSON.stringify(normalized);
  } catch {
    return null;
  }
}
/** A snapshot is attributable only when its stored identity and normalized profile agree.
 * @param {any} row @param {any} profile */
function compatibleWeek(row, profile) {
  const week = storedWeek(row);
  if (!week || week.profileRevision !== profile.revision) return null;
  const canonical = canonicalProfile(profile);
  return canonical && canonical === canonicalProfile(week.inputs) ? week : null;
}

/** Owner-filtered reads only; previous estimates are rate limiters, never extra observations.
 * @param {import("./domain-types").CoachingServiceDependencies["store"]} store @param {string} userId @param {string} weekStart @param {any} profile */
async function readCoachingEvidence(store, userId, weekStart, profile) {
  const [dailyRows, previousRows, summaries] = await Promise.all([
    store.coachingDailyLogs(userId, addDays(weekStart, -CALIBRATION_DAYS), addDays(weekStart, -1)),
    Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const date = addDays(weekStart, -7 * (index + 1));
        return { date, row: await store.coachingWeek(userId, date) };
      }),
    ),
    store.workouts(userId, 100, 0),
  ]);
  const previousWeek =
    previousRows
      .map(({ date, row }) => (row?.week_start === date ? compatibleWeek(row, profile) : null))
      .find(Boolean) || null;
  const dailyLogs = dailyRows
    .filter(
      (row) =>
        isDate(row.log_date) &&
        row.log_date >= addDays(weekStart, -CALIBRATION_DAYS) &&
        row.log_date < weekStart,
    )
    .map((row) => ({
      date: String(row.log_date),
      calories: Number(row.calories),
      complete: row.intake_complete == null ? null : Number(row.intake_complete) === 1,
      morningWeightKg: row.morning_weight_kg == null ? null : Number(row.morning_weight_kg),
    }));
  /** @type {any[]} */ const workouts = [],
    checkIns = [];
  let limited = summaries.length >= 100;
  const seen = new Set(),
    eligible = [];
  for (const row of summaries.slice(0, 100)) {
    const summary = parsed(row.summary_json),
      id = summary?.id;
    if (
      typeof id !== "string" ||
      !id ||
      !isDate(summary?.date) ||
      !["active", "completed"].includes(summary.status)
    ) {
      limited = true;
      continue;
    }
    if (seen.has(id)) {
      limited = true;
      continue;
    }
    seen.add(id);
    if (
      summary.status !== "completed" ||
      summary.date >= weekStart ||
      summary.date < addDays(weekStart, -56)
    )
      continue;
    eligible.push({ id, summary, revision: row.revision });
  }
  for (let start = 0; start < eligible.length; start += 8) {
    const batch = await Promise.all(
      eligible.slice(start, start + 8).map(async (candidate) => ({
        ...candidate,
        row: await store.workout(userId, candidate.id),
        checkIn: await store.workoutCheckIn(userId, candidate.id),
      })),
    );
    for (const { id, summary, revision, row, checkIn } of batch) {
      const workout = row && parsed(row.workout_json);
      if (
        !record(workout) ||
        workout.id !== id ||
        workout.date !== summary.date ||
        workout.status !== summary.status ||
        !Array.isArray(workout.entries) ||
        !workout.entries.length ||
        workout.entries.some(
          (/** @type {any} */ entry) =>
            !record(entry) ||
            typeof entry.exerciseId !== "string" ||
            !entry.exerciseId ||
            !Array.isArray(entry.sets) ||
            !entry.sets.length,
        ) ||
        Number(revision) !== Number(row?.revision) ||
        summary.startedAt !== workout.startedAt ||
        summary.completedAt !== workout.completedAt ||
        summary.exerciseCount !== workout.entries.length
      ) {
        limited = true;
        continue;
      }
      workouts.push(workout);
      if (checkIn && String(checkIn.workout_id) === id)
        checkIns.push({
          workoutId: id,
          difficulty: checkIn.difficulty,
          energy: checkIn.energy,
          comfort: checkIn.comfort,
          enjoyment: checkIn.enjoyment,
          updatedAt: Number(checkIn.updated_at),
        });
    }
  }
  return { dailyLogs, previousWeek, workouts, checkIns, limited };
}

/** Old profile targets remain valid for their own dates; duplicate or out-of-week dates do not. @param {any} week @param {string} start @param {string} end */
function targetsForWeek(week, start, end) {
  const targets = new Map(),
    conflicts = new Set();
  if (!record(week) || !isDate(week.weekStart) || !Array.isArray(week.nutrition?.dailyTargets))
    return targets;
  for (const target of week.nutrition.dailyTargets) {
    const date = target?.date;
    if (
      !isDate(date) ||
      date < week.weekStart ||
      date > addDays(week.weekStart, 6) ||
      date < start ||
      date > end ||
      !Number.isSafeInteger(target.calories) ||
      target.calories < 0 ||
      target.calories > 20000 ||
      conflicts.has(date)
    )
      continue;
    if (targets.has(date)) {
      targets.delete(date);
      conflicts.add(date);
    } else targets.set(date, target);
  }
  return targets;
}

/** Diary history uses the original saved target, never today's target for an older date.
 * @param {import("./domain-types").CoachingStore} store @param {string} userId @param {any} week @param {string} today */
async function readCoachingDiary(store, userId, week, today) {
  const start = addDays(today, -CALIBRATION_DAYS),
    starts = [
      ...new Set(
        Array.from({ length: CALIBRATION_DAYS + 1 }, (_, index) =>
          weekStartForDate(addDays(start, index)),
        ),
      ),
    ];
  const [rawRows, priorRows] = await Promise.all([
    store.coachingDailyLogs(userId, start, today),
    Promise.all(
      starts
        .filter((date) => date !== week.weekStart)
        .map(async (date) => ({ date, row: await store.coachingWeek(userId, date) })),
    ),
  ]);
  const rows = rawRows.filter(
      (row) => isDate(row.log_date) && row.log_date >= start && row.log_date <= today,
    ),
    targets = targetsForWeek(week, start, today);
  for (const { date, row } of priorRows) {
    const saved = storedWeek(row);
    if (!saved || saved.weekStart !== date) continue;
    for (const [key, target] of targetsForWeek(saved, start, today)) targets.set(key, target);
  }
  const logTargets = Array.from({ length: CALIBRATION_DAYS + 1 }, (_, index) => {
    const date = addDays(today, -index),
      target = targets.get(date);
    return (
      target || {
        date,
        day: new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
          new Date(`${date}T12:00:00Z`),
        ),
        calories: null,
        macros: null,
        kind: "historical",
      }
    );
  });
  return { rows, logTargets, diaryStartDate: start, diaryEndDate: today };
}

module.exports = {
  canonicalProfile,
  compatibleWeek,
  readCoachingDiary,
  readCoachingEvidence,
  storedWeek,
  targetsForWeek,
};
