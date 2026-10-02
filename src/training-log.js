// @ts-check
"use strict";

// The Training Log read model: every workout in one schema, whatever its source. Workouts the member logs
// in Train are "manual"; sessions recorded by Polar are "polar"; days the saved plan schedules carry the
// plan's own source. A Polar session that matches a logged workout is linked to it and shown once, and a
// Polar session on a planned day with nothing logged completes that planned day instead of adding a row.

const { DAYS } = require("./plans");

const PROVIDER = "polar";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 92;
// Same-day matching (no time overlap) only applies to sessions a watch records for gym training.
const GYM_SPORT = /strength|weight|gym|circuit|crossfit|functional|core|pump|other indoor/i;

/** @param {unknown} value */
const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
/** @param {string} date @param {number} days */
const addDays = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** @param {string} date */
const weekdayOf = (date) => DAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
/** @param {string} date */
const mondayOf = (date) => addDays(date, -DAYS.indexOf(weekdayOf(date)));
/** @param {unknown} value */
const isDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A stored workout summary, or null when it cannot be read safely. @param {any} row */
function summaryOf(row) {
  try {
    const value = JSON.parse(String(row?.summary_json));
    return value &&
      typeof value.id === "string" &&
      value.id &&
      isDate(value.date) &&
      ["active", "completed"].includes(value.status)
      ? value
      : null;
  } catch {
    return null;
  }
}
/** A stored Polar session in log form. @param {any} row */
function sessionOf(row) {
  const startedAt = num(row?.started_at),
    duration = num(row?.duration_seconds),
    externalId = String(row?.external_id || "");
  if (startedAt === null || !externalId || !isDate(String(row?.local_date))) return null;
  return {
    externalId,
    startedAt,
    endsAt: startedAt + Math.max(0, duration || 0) * 1000,
    date: String(row.local_date),
    durationSeconds: duration,
    sport: String(row.sport || "Workout"),
    calories: num(row.calories),
    hrAvg: num(row.hr_avg),
    hrMax: num(row.hr_max),
    cardioLoad: num(row.cardio_load),
  };
}
/** @param {any} workout */
function spanOf(workout) {
  const start = Number(workout.startedAt),
    end =
      Number.isFinite(workout.completedAt) && workout.completedAt >= start
        ? Number(workout.completedAt)
        : start + Math.max(0, Number(workout.elapsedSeconds) || 0) * 1000;
  return [start, end];
}

/**
 * Links each Polar session to at most one completed STRATA workout, and each workout to at most one session.
 * First by the largest overlap between the logged time and the recorded session; then, for a gym-type session
 * that overlaps nothing, to the only completed workout that day when it is also the day's only session.
 * Pure and deterministic.
 * @param {any[]} workouts summaries @param {ReturnType<typeof sessionOf>[]} sessions
 * @returns {Array<{provider:string,externalId:string,workoutId:string,method:"time_overlap"|"same_day"}>}
 */
function matchSessions(workouts, sessions) {
  const completed = workouts.filter(
      (workout) => workout?.status === "completed" && Number.isFinite(workout.startedAt),
    ),
    ordered = /** @type {NonNullable<ReturnType<typeof sessionOf>>[]} */ (
      sessions.filter(Boolean)
    ).sort((a, b) => a.startedAt - b.startedAt || a.externalId.localeCompare(b.externalId));
  const taken = new Set(),
    links =
      /** @type {Array<{provider:string,externalId:string,workoutId:string,method:"time_overlap"|"same_day"}>} */ ([]);
  for (const session of ordered) {
    let best = null,
      bestOverlap = 0;
    for (const workout of completed) {
      if (taken.has(workout.id)) continue;
      const [start, end] = spanOf(workout),
        overlap = Math.min(end, session.endsAt) - Math.max(start, session.startedAt);
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap && overlap > 0 && best && String(workout.id) < String(best.id))
      ) {
        best = workout;
        bestOverlap = overlap;
      }
    }
    if (best) {
      taken.add(best.id);
      links.push({
        provider: PROVIDER,
        externalId: session.externalId,
        workoutId: String(best.id),
        method: "time_overlap",
      });
    }
  }
  for (const session of ordered) {
    if (
      links.some((link) => link.externalId === session.externalId) ||
      !GYM_SPORT.test(session.sport)
    )
      continue;
    const daySessions = ordered.filter((other) => other.date === session.date),
      dayWorkouts = completed.filter((workout) => workout.date === session.date);
    if (daySessions.length === 1 && dayWorkouts.length === 1 && !taken.has(dayWorkouts[0].id)) {
      taken.add(dayWorkouts[0].id);
      links.push({
        provider: PROVIDER,
        externalId: session.externalId,
        workoutId: String(dayWorkouts[0].id),
        method: "same_day",
      });
    }
  }
  return links;
}

/**
 * One list for a date range: logged workouts, Polar sessions, and this week's planned days. The saved plan is
 * the current week's plan, so planned rows are never projected onto earlier weeks.
 * @param {{workouts:any[],sessions:any[],links:any[],plan:any,planSource?:string,from:string,to:string,today:string}} input
 */
function composeTrainingLog({
  workouts,
  sessions,
  links,
  plan,
  planSource = "manual",
  from,
  to,
  today,
}) {
  const linkBySession = new Map(
      links.map((link) => [String(link.externalId ?? link.external_id), link]),
    ),
    deviceByWorkout = new Map();
  for (const session of sessions) {
    const link = linkBySession.get(session.externalId);
    if (link)
      deviceByWorkout.set(String(link.workoutId ?? link.workout_id), {
        ...session,
        linkMethod: String(link.method),
      });
  }
  const planned = (/** @type {string} */ date) => {
    const items = Array.isArray(plan?.days?.[weekdayOf(date)]) ? plan.days[weekdayOf(date)] : [];
    return items;
  };
  const entries = [];
  for (const workout of workouts) {
    if (workout.date < from || workout.date > to) continue;
    entries.push({
      id: `workout:${workout.id}`,
      kind: "workout",
      source: "manual",
      status: workout.status === "completed" ? "completed" : "active",
      date: workout.date,
      title: String(workout.title || "Workout"),
      startedAt: num(workout.startedAt),
      completedAt: num(workout.completedAt),
      durationSeconds: num(workout.elapsedSeconds),
      exerciseCount: num(workout.exerciseCount),
      completedSets: num(workout.completedSets),
      totalSets: num(workout.totalSets),
      planDay: workout.planDay ? String(workout.planDay) : null,
      device: deviceByWorkout.get(String(workout.id)) || null,
    });
  }
  const currentWeek = mondayOf(today);
  for (const session of sessions) {
    if (linkBySession.has(session.externalId) || session.date < from || session.date > to) continue;
    const fulfils =
      session.date >= currentWeek &&
      planned(session.date).length > 0 &&
      GYM_SPORT.test(session.sport) &&
      !entries.some((entry) => entry.kind === "workout" && entry.date === session.date);
    entries.push({
      id: `polar:${session.externalId}`,
      kind: "device_session",
      source: "polar",
      status: "completed",
      date: session.date,
      title: session.sport,
      startedAt: session.startedAt,
      completedAt: session.endsAt,
      durationSeconds: session.durationSeconds,
      exerciseCount: null,
      completedSets: null,
      totalSets: null,
      planDay: fulfils ? weekdayOf(session.date) : null,
      device: session,
    });
  }
  for (let date = from > currentWeek ? from : currentWeek; date <= to; date = addDays(date, 1)) {
    const items = planned(date);
    if (!items.length) continue;
    const done = entries.some(
      (entry) =>
        entry.date === date &&
        ((entry.kind === "workout" && entry.status === "completed") ||
          (entry.kind === "device_session" && entry.planDay)),
    );
    if (done) continue;
    entries.push({
      id: `planned:${date}`,
      kind: "planned",
      source: planSource,
      status: date < today ? "not_logged" : "planned",
      date,
      title: `${weekdayOf(date)} plan`,
      startedAt: null,
      completedAt: null,
      durationSeconds: null,
      exerciseCount: items.length,
      completedSets: null,
      totalSets: items.reduce(
        (/** @type {number} */ sum, /** @type {any} */ item) => sum + (Number(item?.sets) || 0),
        0,
      ),
      planDay: weekdayOf(date),
      device: null,
    });
  }
  return entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}

/** @param {string} from @param {string} to */
function validRange(from, to) {
  return (
    isDate(from) &&
    isDate(to) &&
    from <= to &&
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS < MAX_RANGE_DAYS
  );
}

/**
 * @param {{store:any,getPlan:(userId:string)=>Promise<any>,logger?:{warn?:Function}|null,now?:()=>number}} dependencies
 */
function createTrainingLog({ store, getPlan, logger = null, now = Date.now }) {
  /**
   * Reads and links one range. Links are written only when they change, so reads stay cheap. A read still answers
   * when a link write fails (the next read retries it); a relink from an event throws so the bus can retry it.
   * @param {string} userId @param {string} from @param {string} to @param {string} today @param {boolean} [strict]
   */
  async function load(userId, from, to, today, strict = false) {
    const [rows, sessionRows, linkRows, plan, changes] = await Promise.all([
      store.workouts(userId, 200, 0),
      store.wellnessWorkouts(
        userId,
        PROVIDER,
        Date.parse(`${from}T00:00:00Z`) - DAY_MS,
        Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS,
      ),
      store.trainingLinks(userId),
      getPlan(userId),
      store.planChanges(userId, 1),
    ]);
    const workouts = /** @type {any[]} */ (rows.map(summaryOf).filter(Boolean)),
      sessions = /** @type {any[]} */ (sessionRows.map(sessionOf).filter(Boolean));
    const inRange = new Set(sessions.map((session) => session.externalId)),
      stored = linkRows.filter((/** @type {any} */ row) => inRange.has(String(row.external_id)));
    const matched = matchSessions(workouts, sessions),
      key = (/** @type {any} */ link) =>
        `${link.externalId ?? link.external_id}>${link.workoutId ?? link.workout_id}:${link.method}`;
    if (matched.map(key).sort().join() !== stored.map(key).sort().join()) {
      try {
        const keep = new Set(matched.map((link) => link.externalId));
        for (const row of stored)
          if (!keep.has(String(row.external_id)))
            await store.deleteTrainingLink(userId, PROVIDER, String(row.external_id));
        for (const link of matched)
          if (!stored.some((/** @type {any} */ row) => key(row) === key(link)))
            await store.upsertTrainingLink(userId, { ...link, linkedAt: now() });
      } catch (error) {
        logger?.warn?.("training_log.link_failed", { error });
        if (strict) throw error;
      }
    }
    return composeTrainingLog({
      workouts,
      sessions,
      links: matched,
      plan,
      planSource: String(changes[0]?.source || "manual"),
      from,
      to,
      today,
    });
  }
  /** Re-links the days a Polar sync or a finished workout touched. @param {string} userId @param {string} from @param {string} to @param {string} today */
  async function relink(userId, from, to, today) {
    if (validRange(from, to)) await load(userId, from, to, today, true);
  }
  return {
    /** @param {string} userId @param {{from:string,to:string,today:string}} range */
    async read(userId, { from, to, today }) {
      if (!validRange(from, to))
        throw Object.assign(new Error("Choose a range of up to 92 days."), {
          status: 400,
          code: "INVALID_TRAINING_LOG_RANGE",
        });
      return load(userId, from, to, today);
    },
    relink,
    /** @param {import("./domain-types").EventBus} events @param {(userId:string)=>string|Promise<string>} todayFor */
    subscribe(events, todayFor) {
      events.on(
        "workout.completed",
        async (payload) => {
          const userId = String(payload.userId),
            date = String(payload.workout?.date || "");
          if (isDate(date))
            await relink(userId, addDays(date, -1), addDays(date, 1), await todayFor(userId));
        },
        "training_log.workout_completed",
      );
      events.on(
        "polar.sync.finished",
        async (payload) => {
          const userId = String(payload.userId),
            from = String(payload.from || ""),
            to = String(payload.to || "");
          if (isDate(from) && isDate(to)) await relink(userId, from, to, await todayFor(userId));
        },
        "training_log.polar_sync",
      );
    },
  };
}

module.exports = {
  GYM_SPORT,
  MAX_RANGE_DAYS,
  addDays,
  composeTrainingLog,
  createTrainingLog,
  isDate,
  matchSessions,
  mondayOf,
  sessionOf,
  summaryOf,
  weekdayOf,
};
