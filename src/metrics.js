// @ts-check
"use strict";

const { PLANS } = require("./paddle-catalog");

// Investor metrics from account-scoped records. The store supplies plain rows; this module turns them into weekly,
// cohort, revenue, and Strata AI figures and one CSV. It reads nothing itself, so every figure is reproducible from
// its input. Days are UTC day numbers (days since 1970-01-01) and weeks start on Monday, as in the rest of STRATA.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = 12;
const MONTHS = 6;
const AI_MONTHS = 3;
// Strata AI usage is kept this many days (src/ai-quota.js cleanup), so a month is shown only while all of it is kept.
const AI_USAGE_DAYS = 90;
const ACTIVATION_DAYS = 7;
const RETENTION_WEEKS = Object.freeze([4, 8]);
/**
 * What one subscription brings in per month at list price, and after the provider's fee per charge: Paddle 5% +
 * $0.50, Apple 15% (Small Business Program). A yearly plan is spread over twelve months. App Store subscriptions are
 * valued at the monthly plan's US price.
 * @param {"monthly"|"yearly"} planKey @param {"paddle"|"apple"} provider
 */
function monthlyValue(planKey, provider) {
  const plan = planKey === "yearly" ? PLANS.yearly : PLANS.monthly,
    amount = Number(plan.amount),
    months = plan.interval === "year" ? 12 : 1,
    net = provider === "apple" ? amount * 0.85 : amount - (amount * 0.05 + 0.5);
  return { list: amount / months, net: net / months };
}
const ENDED_PADDLE_STATUSES = Object.freeze(["canceled", "paused"]);

/**
 * @typedef {{id:string,createdAt:number,method:"email"|"google",fullWeekAt:number|null}} MetricsAccount
 * @typedef {{userId:string,day:number,plus:boolean}} MetricsActiveDay
 * @typedef {{userId:string,status:string,startedAt:number,changedAt:number,plan:"monthly"|"yearly"}} MetricsPaddleSubscription
 * @typedef {{userId:string,startedAt:number,endsAt:number,revokedAt:number|null}} MetricsAppleSubscription
 * @typedef {{userId:string,month:string,requests:number,tokens:number}} MetricsAiUsage
 * @typedef {{accounts:MetricsAccount[],activeDays:MetricsActiveDay[],paddle:MetricsPaddleSubscription[],
 *   apple:MetricsAppleSubscription[],lifetimeUserIds:string[],aiUsage:MetricsAiUsage[],activationSince:number|null,
 *   internalAccounts:number}} MetricsSource
 * @typedef {{provider:"paddle"|"apple",plan:"monthly"|"yearly",userId:string,start:number,end:number|null}} PaidInterval
 */

/** @param {number} ms */
const dayOf = (ms) => Math.floor(ms / DAY_MS);
/** @param {number} day */
const weekOf = (day) => Math.floor((day + 3) / 7);
/** @param {number} week */
const weekStartDay = (week) => week * 7 - 3;
/** @param {number} day */
const isoDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** @param {number} ms */
const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7);
/** @param {number} part @param {number} whole */
const ratio = (part, whole) => (whole > 0 ? part / whole : null);
/** @param {number} value */
const cents = (value) => Math.round(value * 100) / 100;

/**
 * The first day of the oldest week and month any figure reads, so the store can bound its activity query.
 * @param {number} now
 */
function metricsSince(now) {
  const oldestWeek = weekStartDay(weekOf(dayOf(now)) - (WEEKS - 1)) * DAY_MS,
    [oldestMonth] = aiMonths(now);
  return Math.min(oldestWeek, oldestMonth ? oldestMonth.start : oldestWeek);
}

/** Calendar months, oldest first, ending with the current one. @param {number} now @param {number} count */
function recentMonths(now, count) {
  const date = new Date(now),
    year = date.getUTCFullYear(),
    month = date.getUTCMonth();
  return Array.from({ length: count }, (_, index) => {
    const start = Date.UTC(year, month - (count - 1 - index), 1),
      next = Date.UTC(year, month - (count - 2 - index), 1);
    return { key: monthKey(start), start, end: Math.min(next, now), complete: next <= now };
  });
}

/**
 * Up to three calendar months of Strata AI use, oldest first: only months whose every day is still kept, so the oldest
 * month is dropped near a month's end rather than shown with its first days missing.
 * @param {number} now
 */
function aiMonths(now) {
  const kept = (dayOf(now) - AI_USAGE_DAYS) * DAY_MS;
  // The current month always qualifies: it began less than 90 days ago.
  return recentMonths(now, AI_MONTHS).filter((month) => month.start >= kept);
}

/** @param {MetricsActiveDay[]} activeDays */
function daysByUser(activeDays) {
  /** @type {Map<string,Set<number>>} */
  const days = new Map();
  for (const { userId, day } of activeDays) {
    const set = days.get(userId) || new Set();
    set.add(day);
    days.set(userId, set);
  }
  return days;
}

/** @param {MetricsSource} source @param {number} currentWeek */
function weeklyRows(source, currentWeek) {
  /** @type {Map<number,Set<string>>} */
  const active = new Map();
  for (const { userId, day } of source.activeDays) {
    const week = weekOf(day),
      set = active.get(week) || new Set();
    set.add(userId);
    active.set(week, set);
  }
  return Array.from({ length: WEEKS }, (_, index) => {
    const week = currentWeek - (WEEKS - 1) + index,
      signups = source.accounts.filter((account) => weekOf(dayOf(account.createdAt)) === week);
    return {
      weekStart: isoDay(weekStartDay(week)),
      complete: week < currentWeek,
      activeMembers: active.get(week)?.size || 0,
      signups: signups.length,
      emailSignups: signups.filter((account) => account.method === "email").length,
      googleSignups: signups.filter((account) => account.method === "google").length,
    };
  });
}

/**
 * Activation: a full week saved within seven days of sign-up, counted once the seven days have passed and only for
 * accounts created after STRATA began recording it. Week N retention: any activity on days 7N to 7N+6 after sign-up,
 * counted once that window has ended.
 * @param {MetricsSource} source @param {number} now @param {number} currentWeek
 */
function cohortRows(source, now, currentWeek) {
  const activity = daysByUser(source.activeDays),
    today = dayOf(now),
    since = source.activationSince;
  return Array.from({ length: WEEKS }, (_, index) => {
    const week = currentWeek - (WEEKS - 1) + index,
      cohort = source.accounts.filter((account) => weekOf(dayOf(account.createdAt)) === week),
      activationEligible = cohort.filter(
        (account) =>
          since !== null &&
          account.createdAt >= since &&
          account.createdAt + ACTIVATION_DAYS * DAY_MS <= now,
      ),
      activated = activationEligible.filter(
        (account) =>
          account.fullWeekAt !== null &&
          account.fullWeekAt - account.createdAt <= ACTIVATION_DAYS * DAY_MS,
      ).length;
    const retention = RETENTION_WEEKS.map((number) => {
      const eligible = cohort.filter(
        (account) => today > dayOf(account.createdAt) + 7 * number + 6,
      );
      const retained = eligible.filter((account) => {
        const first = dayOf(account.createdAt) + 7 * number,
          days = activity.get(account.id);
        return Boolean(days) && [0, 1, 2, 3, 4, 5, 6].some((offset) => days?.has(first + offset));
      }).length;
      return {
        week: number,
        eligible: eligible.length,
        retained,
        rate: ratio(retained, eligible.length),
      };
    });
    return {
      weekStart: isoDay(weekStartDay(week)),
      signups: cohort.length,
      activation: {
        eligible: activationEligible.length,
        activated,
        rate: ratio(activated, activationEligible.length),
      },
      retention,
    };
  });
}

/**
 * Each recurring subscription as the interval it paid for; a paused or canceled one ends at its last change.
 * @param {MetricsSource} source @param {number} now @returns {PaidInterval[]}
 */
function paidIntervals(source, now) {
  return [
    ...source.paddle.map((row) => ({
      provider: /** @type {"paddle"} */ ("paddle"),
      plan: row.plan,
      userId: row.userId,
      start: row.startedAt,
      end: ENDED_PADDLE_STATUSES.includes(row.status) ? row.changedAt : null,
    })),
    ...source.apple.map((row) => ({
      provider: /** @type {"apple"} */ ("apple"),
      plan: /** @type {"monthly"} */ ("monthly"),
      userId: row.userId,
      start: row.startedAt,
      end: row.revokedAt ?? (row.endsAt <= now ? row.endsAt : null),
    })),
  ];
}

/** @param {PaidInterval[]} intervals @param {number} at */
function payingAt(intervals, at) {
  return intervals.filter((item) => item.start <= at && (item.end === null || item.end > at));
}

/** @param {PaidInterval[]} intervals */
function recurringRevenue(intervals) {
  const values = intervals.map((item) => monthlyValue(item.plan, item.provider));
  return {
    list: cents(values.reduce((sum, value) => sum + value.list, 0)),
    afterFees: cents(values.reduce((sum, value) => sum + value.net, 0)),
  };
}

/**
 * Monthly churn: subscriptions paying when the month began that ended during it, over those paying at its start.
 * @param {PaidInterval[]} intervals @param {number} now
 */
function monthlyRows(intervals, now) {
  return recentMonths(now, MONTHS).map((month) => {
    const atStart = payingAt(intervals, month.start),
      ended = atStart.filter((item) => item.end !== null && item.end <= month.end).length,
      atEnd = payingAt(intervals, month.end);
    return {
      month: month.key,
      complete: month.complete,
      payingAtStart: atStart.length,
      started: intervals.filter((item) => item.start > month.start && item.start <= month.end)
        .length,
      ended,
      churnRate: ratio(ended, atStart.length),
      payingAtEnd: atEnd.length,
      mrrAtEnd: recurringRevenue(atEnd).list,
    };
  });
}

/** @param {MetricsSource} source @param {number} now @param {number|null} usdPerMillionTokens */
function aiRows(source, now, usdPerMillionTokens) {
  return aiMonths(now).map((month) => {
    const usage = source.aiUsage.filter((row) => row.month === month.key),
      tokens = usage.reduce((sum, row) => sum + row.tokens, 0),
      members = new Set(
        source.activeDays
          .filter((row) => row.plus && monthKey(row.day * DAY_MS) === month.key)
          .map((row) => row.userId),
      ).size,
      cost = usdPerMillionTokens === null ? null : (tokens / 1_000_000) * usdPerMillionTokens;
    return {
      month: month.key,
      complete: month.complete,
      activePlusMembers: members,
      requests: usage.reduce((sum, row) => sum + row.requests, 0),
      tokens,
      tokensPerMember: members ? Math.round(tokens / members) : null,
      estimatedCost: cost === null ? null : cents(cost),
      costPerMember:
        cost === null || !members ? null : Math.round((cost / members) * 10000) / 10000,
    };
  });
}

/**
 * @param {MetricsSource} source
 * @param {{now:number,usdPerMillionTokens?:number|null}} options
 */
function buildInvestorMetrics(source, { now, usdPerMillionTokens = null }) {
  const currentWeek = weekOf(dayOf(now)),
    accountIds = new Set(source.accounts.map((account) => account.id)),
    intervals = paidIntervals(source, now),
    paying = payingAt(intervals, now),
    payingUsers = new Set(paying.map((item) => item.userId)),
    everPaid = new Set(intervals.map((item) => item.userId).filter((id) => accountIds.has(id))),
    weekly = weeklyRows(source, currentWeek),
    lastComplete = weekly.filter((row) => row.complete).at(-1);
  return {
    generatedAt: new Date(now).toISOString(),
    internalAccountsExcluded: source.internalAccounts,
    activationRecordedSince:
      source.activationSince === null ? null : new Date(source.activationSince).toISOString(),
    prices: { monthly: Number(PLANS.monthly.amount), yearly: Number(PLANS.yearly.amount) },
    summary: {
      weeklyActiveMembers: lastComplete?.activeMembers ?? 0,
      payingMembers: payingUsers.size,
      mrr: recurringRevenue(paying),
      conversionRate: ratio(everPaid.size, accountIds.size),
    },
    weekly,
    cohorts: cohortRows(source, now, currentWeek),
    revenue: {
      accounts: accountIds.size,
      everPaid: everPaid.size,
      conversionRate: ratio(everPaid.size, accountIds.size),
      payingMembers: payingUsers.size,
      paddleSubscriptions: paying.filter((item) => item.provider === "paddle").length,
      yearlySubscriptions: paying.filter((item) => item.plan === "yearly").length,
      appStoreSubscriptions: paying.filter((item) => item.provider === "apple").length,
      lifetimeMembers: new Set(source.lifetimeUserIds.filter((id) => !payingUsers.has(id))).size,
      mrr: recurringRevenue(paying),
    },
    monthly: monthlyRows(intervals, now),
    ai: { usdPerMillionTokens, months: aiRows(source, now, usdPerMillionTokens) },
  };
}

/** @param {unknown} value */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // A spreadsheet runs a cell that starts with = + - or @ as a formula; quote it as text instead.
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
/** @param {number|null} value */
const percent = (value) => (value === null ? null : `${(value * 100).toFixed(1)}%`);
/** @param {boolean} value */
const yesNo = (value) => (value ? "yes" : "no");

/** @param {ReturnType<typeof buildInvestorMetrics>} metrics */
function metricsCsv(metrics) {
  const { revenue } = metrics;
  /** @type {unknown[][]} */
  const rows = [
    ["STRATA investor metrics"],
    ["Generated", metrics.generatedAt],
    ["Internal accounts excluded", metrics.internalAccountsExcluded],
    ["Activation recorded since", metrics.activationRecordedSince],
    [],
    [
      "Accounts",
      "Ever paid",
      "Free-to-paid conversion",
      "Paying members",
      "Paddle subscriptions",
    ].concat([
      "Yearly subscriptions",
      "App Store subscriptions",
      "Lifetime members",
      "MRR (USD list)",
      "MRR after fees (USD est.)",
    ]),
    [revenue.accounts, revenue.everPaid, percent(revenue.conversionRate), revenue.payingMembers]
      .concat([revenue.paddleSubscriptions, revenue.yearlySubscriptions])
      .concat([revenue.appStoreSubscriptions, revenue.lifetimeMembers])
      .concat([revenue.mrr.list.toFixed(2), revenue.mrr.afterFees.toFixed(2)]),
    [],
    [
      "Week starting",
      "Complete week",
      "Active members",
      "Sign-ups",
      "Email sign-ups",
      "Google sign-ups",
    ],
    ...metrics.weekly.map((row) => [
      row.weekStart,
      yesNo(row.complete),
      row.activeMembers,
      row.signups,
      row.emailSignups,
      row.googleSignups,
    ]),
    [],
    [
      "Sign-up week",
      "Sign-ups",
      "Activation eligible",
      "Activated within 7 days",
      "Activation rate",
    ]
      .concat(["Week 4 eligible", "Active in week 4", "Week 4 retention"])
      .concat(["Week 8 eligible", "Active in week 8", "Week 8 retention"]),
    ...metrics.cohorts.map((row) => [
      row.weekStart,
      row.signups,
      row.activation.eligible,
      row.activation.activated,
      percent(row.activation.rate),
      ...row.retention.flatMap((item) => [item.eligible, item.retained, percent(item.rate)]),
    ]),
    [],
    [
      "Month",
      "Complete month",
      "Paying at start",
      "New subscriptions",
      "Ended subscriptions",
    ].concat(["Monthly churn", "Paying at end", "MRR at end (USD list)"]),
    ...metrics.monthly.map((row) => [
      row.month,
      yesNo(row.complete),
      row.payingAtStart,
      row.started,
      row.ended,
      percent(row.churnRate),
      row.payingAtEnd,
      row.mrrAtEnd.toFixed(2),
    ]),
    [],
    ["AI month", "Complete month", "Active Strata+ members", "AI requests", "AI tokens"].concat([
      "Tokens per member",
      "Estimated AI cost (USD)",
      "AI cost per member (USD)",
    ]),
    ...metrics.ai.months.map((row) => [
      row.month,
      yesNo(row.complete),
      row.activePlusMembers,
      row.requests,
      row.tokens,
      row.tokensPerMember,
      row.estimatedCost === null ? null : row.estimatedCost.toFixed(2),
      row.costPerMember === null ? null : row.costPerMember.toFixed(4),
    ]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

module.exports = {
  AI_USAGE_DAYS,
  ACTIVATION_DAYS,
  DAY_MS,
  WEEKS,
  buildInvestorMetrics,
  csvCell,
  metricsCsv,
  metricsSince,
  monthlyValue,
};
