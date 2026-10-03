// @ts-check
"use strict";

const { METRICS_SQL, ACTIVATION_MIGRATION_ID } = require("./metrics-schema");

/**
 * Reads every row the investor metrics need in one call. `since` bounds the activity rows (ms); internal accounts are
 * flagged here and left out by the caller.
 * @param {(name:keyof typeof METRICS_SQL,args:unknown[])=>Promise<any[]>} query
 * @param {number} since @param {string[]} internalEmails
 * @returns {Promise<import("./domain-types").InvestorMetricsRows>}
 */
async function readMetricsRows(query, since, internalEmails) {
  const sinceDate = new Date(since).toISOString().slice(0, 10);
  const [accounts, activeDays, paddle, apple, googlePlay, lifetime, aiUsage, ledger] =
    await Promise.all([
      query("metricsAccounts", [JSON.stringify(internalEmails)]),
      query("metricsActiveDays", [since, since, since, sinceDate, since, sinceDate]),
      query("metricsPaddleSubscriptions", []),
      query("metricsAppleSubscriptions", []),
      query("metricsGooglePlaySubscriptions", []),
      query("metricsLifetimePurchases", []),
      query("metricsAiUsage", [sinceDate]),
      query("metricsActivationSince", [ACTIVATION_MIGRATION_ID]),
    ]);
  return {
    accounts,
    activeDays,
    paddle,
    apple,
    googlePlay,
    lifetime,
    aiUsage,
    activationSince: ledger[0]?.applied_at ?? null,
  };
}

/**
 * @param {{statements:Record<string,import("./domain-types").PreparedStatementLike>,plainRow:(row:any)=>any}} dependencies
 * @returns {import("./domain-types").MetricsStore}
 */
function createLocalMetricsMethods({ statements, plainRow }) {
  /** @param {string} name */
  const statement = (name) => {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing metrics statement: ${name}`);
    return prepared;
  };
  return {
    async recordFullWeek(userId, at) {
      statement("recordFullWeek").run(at, userId);
    },
    async accountMilestone(userId) {
      return plainRow(statement("accountMilestone").get(userId));
    },
    investorMetricsRows: (since, internalEmails) =>
      readMetricsRows(
        async (name, args) =>
          statement(name)
            .all(...args)
            .map((row) => plainRow(row)),
        since,
        internalEmails,
      ),
  };
}

/**
 * @param {{first:(sql:string,args:any[])=>Promise<any>,all:(sql:string,args:any[])=>Promise<any[]>,run:(sql:string,args:any[])=>Promise<any>}} dependencies
 * @returns {import("./domain-types").MetricsStore}
 */
function createTursoMetricsMethods({ first, all, run }) {
  return {
    async recordFullWeek(userId, at) {
      await run(METRICS_SQL.recordFullWeek, [at, userId]);
    },
    accountMilestone: (userId) => first(METRICS_SQL.accountMilestone, [userId]),
    investorMetricsRows: (since, internalEmails) =>
      readMetricsRows((name, args) => all(METRICS_SQL[name], args), since, internalEmails),
  };
}

module.exports = { createLocalMetricsMethods, createTursoMetricsMethods };
