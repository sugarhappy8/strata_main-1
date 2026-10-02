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
  admin,
  auth,
  trustedOrigin,
  requestAddress,
  rateKeyAllowed,
  http,
  now = Date.now,
}) {
  if (
    !store ||
    !admin ||
    typeof auth?.sessionFor !== "function" ||
    typeof auth?.validCsrf !== "function" ||
    typeof trustedOrigin !== "function" ||
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

  /** @param {import("./domain-types").HttpRequest} req */
  function validJsonRequest(req) {
    return String(req.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json");
  }

  /** @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res */
  async function accept(req, res) {
    if (req.method !== "POST") {
      http.json(
        res,
        405,
        { error: "Method not allowed.", code: "PRODUCT_SIGNAL_METHOD" },
        { Allow: "POST" },
      );
      return;
    }
    if (!trustedOrigin(req)) {
      http.json(res, 403, {
        error: "Product activity sharing requires a same-origin request.",
        code: "PRODUCT_SIGNAL_ORIGIN_REQUIRED",
      });
      return;
    }
    if (!validJsonRequest(req)) {
      http.json(res, 415, {
        error: "Product activity requests must use JSON.",
        code: "JSON_REQUIRED",
      });
      return;
    }
    const session = await auth.sessionFor(req, res);
    if (session && !auth.validCsrf(req, session)) {
      http.json(res, 403, {
        error: "Security check failed. Refresh and try again.",
        code: "INVALID_CSRF",
      });
      return;
    }
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
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function readAggregate(req, res, url) {
    if (req.method !== "GET") {
      http.json(
        res,
        405,
        { error: "Method not allowed.", code: "PRODUCT_SIGNAL_ADMIN_METHOD" },
        { Allow: "GET" },
      );
      return;
    }
    const session = await admin.requireAdmin(req, res);
    if (!session) return;
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

  /**
   * @param {import("./domain-types").HttpRequest} req
   * @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function handleApi(req, res, url) {
    if (url.pathname === "/api/product-signals") {
      await accept(req, res);
      return true;
    }
    if (url.pathname === "/api/admin/product-signals") {
      await readAggregate(req, res, url);
      return true;
    }
    return false;
  }

  // Daily keys are only needed for the current UTC day; counts are kept for the retention window.
  /** @param {number} [timestamp] */
  async function cleanup(timestamp = clock()) {
    await store.deleteProductSignalActors(utcDay(Number(timestamp)));
    return store.deleteOldProductSignals(dayBefore(Number(timestamp), RETENTION_DAYS - 1));
  }

  return Object.freeze({ handleApi, cleanup });
}

module.exports = { EVENTS, RETENTION_DAYS, utcDay, createProductSignalsService };
