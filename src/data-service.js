// @ts-check
"use strict";

// The shared data layer's front door. Features and Strata AI read shared facts through these read models
// (Athlete Profile, Training Log, Daily Snapshots, Rankings Signals, plan history) instead of querying another
// feature's tables, and the listeners here keep derived records in step through the event bus.

const { createAthleteProfileSync } = require("./athlete-profile");
const { RETENTION_DAYS, createDailySnapshots } = require("./daily-snapshot");
const { addDays, createTrainingLog, isDate } = require("./training-log");

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAINED_WINDOW_DAYS = 56;

/** @param {number} time */
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);
/** The calendar date at `time` in an IANA time zone; throws for an unknown zone. @param {number} time @param {string} timeZone */
const zonedDate = (time, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join("-");
};
/** @param {any} value */
const parsed = (value) => {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
};

/**
 * @param {{store:any,events:import("./domain-types").EventBus,getPlan:(userId:string)=>Promise<any>,coachingProfile:(userId:string)=>Promise<any>,
 *   requireSession:(req:any,res:any)=>Promise<any>,requireFeature:(feature:string)=>(req:any,res:any)=>Promise<any>,http:{json:Function},logger?:any,now?:()=>number}} dependencies
 */
function createDataService({
  store,
  events,
  getPlan,
  coachingProfile,
  requireSession,
  requireFeature,
  http,
  logger = null,
  now = Date.now,
}) {
  const { json } = http;
  // "Today" is the member's own calendar date (the time zone in their coaching profile), else UTC. A UTC-only today
  // dropped the current day for members east of UTC between their midnight and UTC midnight.
  /** @param {string} userId @returns {Promise<string>} */
  async function todayFor(userId) {
    const zone = await coachingProfile(userId).then(
      (payload) => String(payload?.timeZone || ""),
      () => "",
    );
    if (zone) {
      try {
        return zonedDate(now(), zone);
      } catch {
        /* an unknown zone falls back to UTC */
      }
    }
    return isoDate(now());
  }
  const athleteProfile = createAthleteProfileSync({ store, logger, now });
  const trainingLog = createTrainingLog({ store, getPlan, logger, now });
  const snapshots = createDailySnapshots({ store, trainingLog, events, logger, now });
  athleteProfile.subscribe(events);
  trainingLog.subscribe(events, todayFor);
  snapshots.subscribe(events, todayFor);
  // Where each saved week came from, so the Training Log and Strata AI can tell an accepted AI week from the member's own edit.
  events.on(
    "plan.updated",
    async (payload) => {
      const updatedAt = Number(payload.updatedAt);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 1) return;
      const source = ["manual", "ai", "system"].includes(String(payload.source))
        ? String(payload.source)
        : "manual";
      await store.insertPlanChange(String(payload.userId), {
        planUpdatedAt: updatedAt,
        source,
        detail: String(payload.detail || "plan-edit").slice(0, 40),
        createdAt: now(),
      });
    },
    "plan_changes.record",
  );
  // Derived rows go with the device data they came from.
  events.on(
    "polar.data_deleted",
    async (payload) => {
      const userId = String(payload.userId);
      await store.deleteTrainingLinksForProvider(userId, String(payload.provider));
      await store.deleteUserDailySnapshots(userId);
    },
    "derived.polar_deleted",
  );

  /**
   * What rankings and recommendations can learn from the member: their ranking lens, their own ratings, and
   * the exercises they actually trained in the last eight weeks.
   * @param {string} userId
   */
  async function rankingsSignals(userId) {
    const [preferencesRow, ratingRows, workoutRows] = await Promise.all([
      store.preferences(userId),
      store.ratingsForUser(userId),
      store.workouts(userId, 200, 0),
    ]);
    const since = isoDate(now() - TRAINED_WINDOW_DAYS * DAY_MS),
      trained = new Map();
    for (const row of workoutRows) {
      const summary = parsed(row.summary_json);
      if (
        !summary ||
        summary.status !== "completed" ||
        !isDate(summary.date) ||
        summary.date < since
      )
        continue;
      for (const item of Array.isArray(summary.exerciseSummaries)
        ? summary.exerciseSummaries
        : []) {
        if (!item?.exerciseId || !item.completedSets) continue;
        const current = trained.get(item.exerciseId) || {
          exerciseId: String(item.exerciseId),
          sessions: 0,
          completedSets: 0,
          lastDate: summary.date,
        };
        current.sessions += 1;
        current.completedSets += Number(item.completedSets) || 0;
        if (summary.date > current.lastDate) current.lastDate = summary.date;
        trained.set(item.exerciseId, current);
      }
    }
    return {
      lens: parsed(preferencesRow?.preferences_json),
      ratings: ratingRows.map((/** @type {any} */ row) => ({
        exerciseId: String(row.exercise_id),
        overall: Number(row.overall) || null,
        updatedAt: Number(row.updated_at),
      })),
      trained: [...trained.values()].sort(
        (a, b) =>
          b.sessions - a.sessions ||
          b.lastDate.localeCompare(a.lastDate) ||
          a.exerciseId.localeCompare(b.exerciseId),
      ),
      windowDays: TRAINED_WINDOW_DAYS,
    };
  }
  /** @param {URL} url @param {number} days @param {string} userId */
  async function range(url, days, userId) {
    const today = await todayFor(userId),
      to = String(url.searchParams.get("to") || today),
      from = String(url.searchParams.get("from") || addDays(isDate(to) ? to : today, -(days - 1)));
    return { from, to, today };
  }
  /** @param {any} res @param {any} error */
  function failed(res, error) {
    if (!error?.status) throw error;
    json(res, error.status, { error: error.message, code: error.code || "DATA_REQUEST_FAILED" });
  }

  /** @param {any} req @param {any} res @param {URL} url */
  async function handleApi(req, res, url) {
    const routes = ["/api/profile", "/api/training-log", "/api/snapshots"];
    if (!routes.includes(url.pathname)) return false;
    if (req.method !== "GET") {
      json(res, 405, { error: "Method not allowed." }, { Allow: "GET" });
      return true;
    }
    const headers = { "Cache-Control": "private, no-store" };
    if (url.pathname === "/api/profile") {
      // One Athlete Profile for every client: the ranking lens for everyone, body/energy/food when a coaching profile exists.
      const session = await requireSession(req, res);
      if (!session) return true;
      json(
        res,
        200,
        {
          profile: await athleteProfile.read(session.id, await coachingProfile(session.id)),
          csrfToken: session.csrf_token,
        },
        headers,
      );
      return true;
    }
    if (url.pathname === "/api/training-log") {
      const session = await requireFeature("plus.train")(req, res);
      if (!session) return true;
      try {
        const window = await range(url, 28, session.id);
        json(
          res,
          200,
          { from: window.from, to: window.to, entries: await trainingLog.read(session.id, window) },
          headers,
        );
      } catch (error) {
        failed(res, error);
      }
      return true;
    }
    const session = await requireFeature("plus.progress")(req, res);
    if (!session) return true;
    try {
      const window = await range(url, 7, session.id);
      json(
        res,
        200,
        { from: window.from, to: window.to, snapshots: await snapshots.read(session.id, window) },
        headers,
      );
    } catch (error) {
      failed(res, error);
    }
    return true;
  }

  return {
    handleApi,
    athleteProfile,
    trainingLog,
    snapshots,
    rankingsSignals,
    /** @param {string} userId @param {number} [limit] */
    planChanges: (userId, limit = 10) => store.planChanges(userId, limit),
    async cleanup() {
      await snapshots.cleanup(isoDate(now() - RETENTION_DAYS * DAY_MS));
    },
  };
}

module.exports = { TRAINED_WINDOW_DAYS, createDataService };
