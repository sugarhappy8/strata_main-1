// @ts-check
"use strict";

const { createHmac, randomBytes } = require("node:crypto");

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
// Per actor and in total, per 15 minutes. Anonymous traffic has its own total, so it can never use up the members' one.
const LIMITS = Object.freeze({ member: 60, memberTotal: 5000, network: 60, anonymousTotal: 1000 });
/** @type {readonly import("./domain-types").ProductSignalEvent[]} */
const EVENTS = Object.freeze([
  "preview_generated",
  "onboarding_previewed",
  "onboarding_saved",
  "plan_saved",
  "workout_started",
  "workout_completed",
  "upgrade_viewed",
  "checkout_opened",
  "upgrade_activated",
  "recommendation_feedback_useful",
  "recommendation_feedback_not_relevant",
  "recommendation_feedback_not_clear",
]);
const EVENT_SET = /** @type {ReadonlySet<string>} */ (new Set(EVENTS));

/** @param {number} [timestamp] */
function utcDay(timestamp = Date.now()) {
  const value = Number(timestamp),
    date = new Date(Number.isFinite(value) ? value : Date.now());
  return date.toISOString().slice(0, 10);
}

/** @param {number} timestamp @param {number} days */
function dayBefore(timestamp, days) {
  return utcDay(Number(timestamp) - Math.max(0, days) * DAY_MS);
}

/**
 * Typed boundary for aggregate activity counts and the elevated readout. A signed-in request proves its session and
 * CSRF token; an anonymous one is limited per network. Each action counts once per account or network per UTC day,
 * and signed-in and anonymous counts are kept apart so product decisions rest on the signed-in ones.
 * @param {import("./domain-types").ProductSignalsServiceDependencies} dependencies
 * @returns {import("./domain-types").ProductSignalsService}
 */
function createProductSignalsService({
  store,
  requestAddress,
  rateKeyAllowed,
  http,
  now = Date.now,
}) {
  if (
    !store ||
    typeof requestAddress !== "function" ||
    typeof rateKeyAllowed !== "function" ||
    !http?.json ||
    !http?.bodyJson
  ) {
    throw new TypeError("Product-signal service dependencies are incomplete.");
  }
  // Never stored: keys made with it cannot be traced back to an account or address once the process ends.
  const salt = randomBytes(32);
  const clock = typeof now === "function" ? now : Date.now;

  /** @param {string} value */
  const oneWay = (value) => createHmac("sha256", salt).update(value).digest("hex");
  /** @param {import("./domain-types").HttpRequest} req */
  const networkKey = (req) => oneWay(`network:${String(requestAddress(req) || "unknown")}`);

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  /**
   * Visitors and members both share counts; a member's write has passed the CSRF check in src/router.js.
   * @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res
   * @param {import("./domain-types").SessionRow|null} session
   */
  async function accept(req, res, session) {
    const actor = session ? `member:${session.id}` : networkKey(req);
    const allowed = session
      ? (await rateKeyAllowed(`signal:${oneWay(actor)}`, LIMITS.member, RATE_WINDOW_MS)) &&
        (await rateKeyAllowed("product-signals:global", LIMITS.memberTotal, RATE_WINDOW_MS))
      : (await rateKeyAllowed(`signal:${actor}`, LIMITS.network, RATE_WINDOW_MS)) &&
        (await rateKeyAllowed("product-signals:anonymous", LIMITS.anonymousTotal, RATE_WINDOW_MS));
    if (!allowed) {
      http.json(res, 429, {
        error: "Too many product activity updates. Wait and try again.",
        code: "PRODUCT_SIGNAL_RATE_LIMIT",
      });
      return;
    }
    const input = /** @type {Record<string,unknown>} */ (await http.bodyJson(req)),
      keys = Object.keys(input);
    if (
      keys.length !== 1 ||
      keys[0] !== "event" ||
      typeof input.event !== "string" ||
      !EVENT_SET.has(input.event)
    ) {
      http.json(res, 400, {
        error: "Unknown product activity event.",
        code: "PRODUCT_SIGNAL_INVALID",
      });
      return;
    }
    const day = utcDay(clock()),
      event = /** @type {import("./domain-types").ProductSignalEvent} */ (input.event);
    // A repeat on the same day is accepted the same way, so the response never says whether it counted.
    await store.recordProductSignal(
      day,
      event,
      oneWay(`${day}:${actor}`),
      session ? "member" : "anonymous",
    );
    http.json(res, 202, { accepted: true });
  }

  /**
   * @param {URL} url
   * @param {import("./domain-types").HttpResponse} res
   */
  async function readAggregate(url, res) {
    // Number(null) and Number("") are 0, so a missing or blank range must be
    // recognized before conversion to keep the intended 30-day default.
    const rawDays = url.searchParams.get("days")?.trim() || "",
      requested = rawDays ? Number(rawDays) : Number.NaN;
    const days = Number.isSafeInteger(requested)
      ? Math.max(1, Math.min(RETENTION_DAYS, requested))
      : 30;
    const timestamp = Number(clock()),
      throughDay = utcDay(timestamp),
      sinceDay = dayBefore(timestamp, days - 1);
    const rows = await store.productSignalCounts(sinceDay, throughDay);
    /** @param {unknown} value */
    const count = (value) => Math.max(0, Number(value) || 0);
    const counts = rows
      .map((row) => ({
        day: String(row.event_day),
        name: String(row.event_name),
        count: count(row.event_count),
        members: count(row.member_count),
        anonymous: count(row.anonymous_count),
      }))
      .filter((entry) => EVENT_SET.has(entry.name));
    const zero = () =>
      /** @type {Record<string,number>} */ (Object.fromEntries(EVENTS.map((name) => [name, 0])));
    // "totals" are the signed-in counts that product decisions use; anonymous counts are reported beside them.
    const totals = zero(),
      anonymousTotals = zero();
    for (const entry of counts) {
      totals[entry.name] = (totals[entry.name] || 0) + entry.members;
      anonymousTotals[entry.name] = (anonymousTotals[entry.name] || 0) + entry.anonymous;
    }
    http.json(res, 200, {
      scope: {
        days,
        sinceDay,
        throughDay,
        retentionDays: RETENTION_DAYS,
        measure: "daily_action_counts",
        uniquePeople: false,
        countedOncePerDay: "member_or_network",
        decisionTotals: "signed_in",
      },
      totals,
      anonymousTotals,
      counts,
    });
  }

  /** @type {import("./domain-types").ApiRoute[]} */
  const routes = [
    {
      method: "POST",
      path: "/api/product-signals",
      auth: "optional",
      handler: ({ req, res, session }) => accept(req, res, session),
    },
    {
      method: "GET",
      path: "/api/admin/product-signals",
      auth: "admin",
      handler: ({ url, res }) => readAggregate(url, res),
    },
  ];

  // Daily keys are only needed for the current UTC day; counts are kept for the retention window.
  /** @param {number} [timestamp] */
  async function cleanup(timestamp = clock()) {
    await store.deleteProductSignalActors(utcDay(Number(timestamp)));
    return store.deleteOldProductSignals(dayBefore(Number(timestamp), RETENTION_DAYS - 1));
  }

  return Object.freeze({ routes, cleanup });
}

module.exports = { EVENTS, RETENTION_DAYS, utcDay, createProductSignalsService };
