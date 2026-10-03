// @ts-check
"use strict";

const { defaultPreferences } = require("./plans");
const { buildInvestorMetrics, metricsCsv, metricsSince } = require("./metrics");

/** @param {unknown} value */
function emailList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.includes("@"));
}

/** @param {unknown} value @returns {number|null} */
function tokenRate(value) {
  const text = String(value ?? "").trim(),
    rate = Number(text);
  return text && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/**
 * Days with at least one exercise. A saved plan is already sanitized; anything else counts as empty.
 * @param {unknown} plan
 */
function trainingDays(plan) {
  const days = /** @type {{days?:Record<string,unknown>}} */ (plan || {}).days;
  return days && typeof days === "object"
    ? Object.values(days).filter((list) => Array.isArray(list) && list.length > 0).length
    : 0;
}

/**
 * The owner's investor metrics: one read of account-scoped records turned into figures and a CSV. It also records
 * when an account first saves a full week: as many days with exercises as the training days it chose (4 by default).
 * @param {import("./domain-types").AdminMetricsServiceDependencies} dependencies
 * @returns {import("./domain-types").AdminMetricsService}
 */
function createAdminMetricsService({
  store,
  http,
  adminEmail = "",
  environment = process.env,
  now = Date.now,
}) {
  if (
    !store ||
    typeof store.investorMetricsRows !== "function" ||
    typeof store.recordFullWeek !== "function" ||
    !http?.json
  )
    throw new TypeError("Metrics service dependencies are incomplete.");
  // The owner, App Store review accounts, and the demo or test accounts the owner lists are not customers.
  const internalEmails = [
    ...new Set([
      ...emailList(adminEmail),
      ...emailList(environment.APPLE_SANDBOX_ACCOUNTS),
      ...emailList(environment.STRATA_INTERNAL_ACCOUNTS),
    ]),
  ];
  const usdPerMillionTokens = tokenRate(environment.STRATA_AI_USD_PER_MILLION_TOKENS);

  /** @param {{userId?:unknown,updatedAt?:unknown,plan?:unknown}} payload */
  async function fullWeekSaved(payload) {
    const userId = String(payload?.userId || ""),
      at = Number(payload?.updatedAt);
    if (!userId || !Number.isSafeInteger(at) || at < 1) return;
    const row = /** @type {{preferences_json?:string}|null} */ (await store.preferences(userId));
    let target = defaultPreferences().days;
    try {
      target = Number(JSON.parse(String(row?.preferences_json || "{}")).days) || target;
    } catch {
      /* an unreadable profile keeps the default target */
    }
    if (trainingDays(payload.plan) >= target) await store.recordFullWeek(userId, at);
  }

  /** @param {{res:import("./domain-types").HttpResponse}} context */
  async function read({ res }) {
    const time = now(),
      rows = await store.investorMetricsRows(metricsSince(time), internalEmails),
      customers = rows.accounts.filter((row) => !Number(row.internal)),
      ids = new Set(customers.map((row) => String(row.id)));
    /** @param {{user_id:unknown}} row */
    const customer = (row) => ids.has(String(row.user_id));
    const metrics = buildInvestorMetrics(
      {
        accounts: customers.map((row) => ({
          id: String(row.id),
          createdAt: Number(row.created_at),
          method: row.method === "google" ? "google" : "email",
          fullWeekAt: row.first_full_week_at === null ? null : Number(row.first_full_week_at),
        })),
        activeDays: rows.activeDays.filter(customer).map((row) => ({
          userId: String(row.user_id),
          day: Number(row.day),
          plus: Number(row.plus) === 1,
        })),
        paddle: rows.paddle.filter(customer).map((row) => ({
          userId: String(row.user_id),
          status: String(row.status),
          startedAt: Number(row.created_at),
          changedAt: Number(row.changed_at),
        })),
        apple: rows.apple.filter(customer).map((row) => ({
          userId: String(row.user_id),
          startedAt: Number(row.started_at),
          endsAt: Number(row.ends_at),
          revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
        })),
        lifetimeUserIds: rows.lifetime.filter(customer).map((row) => String(row.user_id)),
        aiUsage: rows.aiUsage.filter(customer).map((row) => ({
          userId: String(row.user_id),
          month: String(row.month),
          requests: Number(row.requests) || 0,
          tokens: Number(row.tokens) || 0,
        })),
        activationSince: rows.activationSince === null ? null : Number(rows.activationSince),
        internalAccounts: rows.accounts.length - customers.length,
      },
      { now: time, usdPerMillionTokens },
    );
    http.json(res, 200, {
      metrics,
      csv: {
        filename: `strata-metrics-${metrics.generatedAt.slice(0, 10)}.csv`,
        text: metricsCsv(metrics),
      },
    });
  }

  /** @type {import("./domain-types").ApiRoute[]} */
  const routes = [{ method: "GET", path: "/api/admin/metrics", auth: "admin", handler: read }];

  return Object.freeze({
    routes,
    /** @param {import("./domain-types").EventBus} events */
    subscribe(events) {
      events.on("plan.updated", fullWeekSaved, "metrics.full_week");
    },
  });
}

module.exports = { createAdminMetricsService, trainingDays };
