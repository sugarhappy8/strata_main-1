// @ts-check
"use strict";

const { cleanText, defaultPreferences, planStats } = require("./plans");
const { planForPrice } = require("./paddle-catalog");
const { appleProductPlan } = require("./apple-billing");
const { buildInvestorMetrics, metricsCsv, metricsSince } = require("./metrics");

/** Comma-separated addresses, normalized as sign-in normalizes an email. @param {unknown} value */
function emailList(value) {
  return String(value || "")
    .split(",")
    .map((item) => cleanText(item, 254).toLowerCase())
    .filter((item) => item.includes("@"));
}

/** @param {unknown} value @returns {number|null} */
function tokenRate(value) {
  const text = String(value ?? "").trim(),
    rate = Number(text);
  return text && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/**
 * Days with at least one exercise, as the planner counts them. A saved plan is already sanitized; anything else counts
 * as empty.
 * @param {unknown} plan
 */
function trainingDays(plan) {
  try {
    return planStats(/** @type {any} */ (plan)).workoutDays;
  } catch {
    return 0;
  }
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
  paymentConfig = { plans: [] },
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
  // Accounts whose first full week this process has recorded. Later saves cannot move it earlier, so they skip the
  // profile read and the write (the store still keeps the earliest time if two saves race).
  const recorded = new Set();

  /** @param {{userId?:unknown,updatedAt?:unknown,plan?:unknown}} payload */
  async function fullWeekSaved(payload) {
    const userId = String(payload?.userId || ""),
      at = Number(payload?.updatedAt);
    if (!userId || !Number.isSafeInteger(at) || at < 1 || recorded.has(userId)) return;
    const days = trainingDays(payload.plan);
    if (days === 0) return;
    const row = /** @type {{preferences_json?:string}|null} */ (await store.preferences(userId));
    let target = defaultPreferences().days;
    try {
      target = Number(JSON.parse(String(row?.preferences_json || "{}")).days) || target;
    } catch {
      /* an unreadable profile keeps the default target */
    }
    if (days < target) return;
    await store.recordFullWeek(userId, at);
    recorded.add(userId);
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
          // An earlier or unknown price counts as monthly.
          plan:
            planForPrice(paymentConfig, row.price_id)?.key === "yearly"
              ? /** @type {"yearly"} */ ("yearly")
              : /** @type {"monthly"} */ ("monthly"),
        })),
        apple: rows.apple.filter(customer).map((row) => ({
          userId: String(row.user_id),
          plan: appleProductPlan(row.product_id),
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
