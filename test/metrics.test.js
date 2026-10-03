"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  AI_USAGE_DAYS,
  DAY_MS,
  buildInvestorMetrics,
  csvCell,
  metricsCsv,
  metricsSince,
  monthlyValue,
} = require("../src/metrics");

const at = (iso) => Date.parse(iso);
const day = (iso) => Math.floor(at(iso) / DAY_MS);
// Saturday 3 October 2026; the current week starts Monday 28 September.
const NOW = at("2026-10-03T12:00:00Z");

function source(overrides = {}) {
  return {
    accounts: [
      {
        id: "A",
        createdAt: at("2026-07-27T10:00:00Z"),
        method: "email",
        fullWeekAt: at("2026-07-29T10:00:00Z"),
      },
      { id: "B", createdAt: at("2026-07-28T09:00:00Z"), method: "google", fullWeekAt: null },
      {
        id: "C",
        createdAt: at("2026-09-30T08:00:00Z"),
        method: "email",
        fullWeekAt: at("2026-09-30T09:00:00Z"),
      },
      { id: "D", createdAt: at("2026-07-14T08:00:00Z"), method: "email", fullWeekAt: null },
    ],
    activeDays: [
      { userId: "A", day: day("2026-07-28"), plus: false },
      { userId: "A", day: day("2026-08-25"), plus: true },
      { userId: "A", day: day("2026-09-22"), plus: true },
      { userId: "A", day: day("2026-10-02"), plus: true },
      { userId: "B", day: day("2026-07-28"), plus: false },
    ],
    paddle: [
      {
        userId: "A",
        status: "active",
        plan: "yearly",
        startedAt: at("2026-08-10T00:00:00Z"),
        changedAt: at("2026-09-10T00:00:00Z"),
      },
      {
        userId: "B",
        status: "canceled",
        plan: "monthly",
        startedAt: at("2026-08-15T00:00:00Z"),
        changedAt: at("2026-09-15T00:00:00Z"),
      },
    ],
    apple: [
      {
        userId: "D",
        startedAt: at("2026-09-02T00:00:00Z"),
        endsAt: at("2026-10-30T00:00:00Z"),
        revokedAt: null,
      },
    ],
    lifetimeUserIds: ["C"],
    aiUsage: [
      { userId: "A", month: "2026-10", requests: 10, tokens: 1_000_000 },
      { userId: "A", month: "2026-09", requests: 2, tokens: 200_000 },
    ],
    activationSince: at("2026-07-20T00:00:00Z"),
    internalAccounts: 2,
    ...overrides,
  };
}

test("weekly rows cover twelve Monday weeks, the last one still running", () => {
  const { weekly, summary } = buildInvestorMetrics(source(), { now: NOW });
  assert.equal(weekly.length, 12);
  assert.equal(weekly[0].weekStart, "2026-07-13");
  assert.deepEqual(weekly.at(-1), {
    weekStart: "2026-09-28",
    complete: false,
    activeMembers: 1,
    signups: 1,
    emailSignups: 1,
    googleSignups: 0,
  });
  assert.deepEqual(
    weekly.find((row) => row.weekStart === "2026-07-27"),
    {
      weekStart: "2026-07-27",
      complete: true,
      activeMembers: 2,
      signups: 2,
      emailSignups: 1,
      googleSignups: 1,
    },
  );
  assert.equal(
    summary.weeklyActiveMembers,
    1,
    "the summary reads the last complete week (21 September)",
  );
});

test("cohorts count activation only once its seven days have passed and only after recording began", () => {
  const { cohorts } = buildInvestorMetrics(source(), { now: NOW });
  const july27 = cohorts.find((row) => row.weekStart === "2026-07-27");
  assert.deepEqual(july27.activation, { eligible: 2, activated: 1, rate: 0.5 });
  assert.deepEqual(july27.retention, [
    { week: 4, eligible: 2, retained: 1, rate: 0.5 },
    { week: 8, eligible: 2, retained: 1, rate: 0.5 },
  ]);
  const july13 = cohorts.find((row) => row.weekStart === "2026-07-13");
  assert.deepEqual(
    july13.activation,
    { eligible: 0, activated: 0, rate: null },
    "D signed up before recording",
  );
  assert.deepEqual(july13.retention[0], { week: 4, eligible: 1, retained: 0, rate: 0 });
  const current = cohorts.at(-1);
  assert.equal(current.signups, 1);
  assert.deepEqual(
    current.activation,
    { eligible: 0, activated: 0, rate: null },
    "C's seven days are not over",
  );
  assert.deepEqual(current.retention, [
    { week: 4, eligible: 0, retained: 0, rate: null },
    { week: 8, eligible: 0, retained: 0, rate: null },
  ]);
  const unrecorded = buildInvestorMetrics(source({ activationSince: null }), { now: NOW });
  assert.equal(unrecorded.activationRecordedSince, null);
  assert.ok(unrecorded.cohorts.every((row) => row.activation.eligible === 0));
});

test("week-N retention counts an account only once its week-N window has ended", () => {
  // E signed up on 30 August: week 4 is 27 September to 3 October, the day NOW falls on.
  const withE = (activeDays = []) =>
    source({
      accounts: [
        ...source().accounts,
        { id: "E", createdAt: at("2026-08-30T10:00:00Z"), method: "email", fullWeekAt: null },
      ],
      activeDays: [...source().activeDays, ...activeDays],
    });
  const cohort = (metrics) => metrics.cohorts.find((row) => row.weekStart === "2026-08-24");
  assert.deepEqual(
    cohort(buildInvestorMetrics(withE(), { now: NOW })).retention[0],
    { week: 4, eligible: 0, retained: 0, rate: null },
    "the last day of the window is still running",
  );
  const nextDay = at("2026-10-04T08:00:00Z");
  assert.deepEqual(cohort(buildInvestorMetrics(withE(), { now: nextDay })).retention[0], {
    week: 4,
    eligible: 1,
    retained: 0,
    rate: 0,
  });
  const active = withE([{ userId: "E", day: day("2026-10-03"), plus: false }]);
  assert.deepEqual(cohort(buildInvestorMetrics(active, { now: nextDay })).retention[0], {
    week: 4,
    eligible: 1,
    retained: 1,
    rate: 1,
  });
});

test("each plan's monthly value: $4.99 a month, $29.99 a year spread over twelve, after each provider's fee", () => {
  const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
  const monthly = monthlyValue("monthly", "paddle"),
    yearly = monthlyValue("yearly", "paddle"),
    apple = monthlyValue("monthly", "apple");
  close(monthly.list, 4.99);
  close(monthly.net, 4.99 - (4.99 * 0.05 + 0.5));
  close(yearly.list, 29.99 / 12);
  close(yearly.net, (29.99 - (29.99 * 0.05 + 0.5)) / 12);
  close(apple.net, 4.99 * 0.85);
  close(monthlyValue("yearly", "apple").net, (29.99 * 0.85) / 12);
});

test("an App Store yearly subscription counts as the yearly plan", () => {
  const appleYearly = source({
    apple: [{ ...source().apple[0], plan: "yearly" }],
  });
  const monthly = buildInvestorMetrics(source(), { now: NOW }).revenue,
    yearly = buildInvestorMetrics(appleYearly, { now: NOW }).revenue;
  assert.equal(yearly.yearlySubscriptions, monthly.yearlySubscriptions + 1);
  assert.equal(
    Math.round((monthly.mrr.list - yearly.mrr.list) * 100) / 100,
    Math.round((4.99 - 29.99 / 12) * 100) / 100,
    "D's App Store subscription moves from $4.99 to $2.50 a month",
  );
});

test("revenue counts paying members, lifetime access, list MRR, and MRR after provider fees", () => {
  const { revenue, summary, prices } = buildInvestorMetrics(source(), { now: NOW });
  assert.deepEqual(prices, { monthly: 4.99, yearly: 29.99 });
  // A pays yearly through Paddle ($2.50 a month, $2.33 after fees); D pays $4.99 through Apple ($4.24 after 15%).
  assert.deepEqual(revenue, {
    accounts: 4,
    everPaid: 3,
    conversionRate: 0.75,
    payingMembers: 2,
    paddleSubscriptions: 1,
    yearlySubscriptions: 1,
    appStoreSubscriptions: 1,
    googlePlaySubscriptions: 0,
    lifetimeMembers: 1,
    mrr: { list: 7.49, afterFees: 6.57 },
  });
  assert.equal(summary.payingMembers, 2);
  assert.equal(summary.conversionRate, 0.75);
  const lapsed = buildInvestorMetrics(
    source({
      apple: [
        {
          userId: "D",
          startedAt: at("2026-09-02T00:00:00Z"),
          endsAt: at("2026-10-01T00:00:00Z"),
          revokedAt: null,
        },
      ],
      paddle: [
        {
          userId: "A",
          status: "paused",
          plan: "yearly",
          startedAt: at("2026-08-10T00:00:00Z"),
          changedAt: at("2026-09-20T00:00:00Z"),
        },
      ],
    }),
    { now: NOW },
  );
  assert.equal(lapsed.revenue.payingMembers, 0, "a paused or expired subscription no longer pays");
  assert.deepEqual(lapsed.revenue.mrr, { list: 0, afterFees: 0 });
});

test("monthly churn divides subscriptions that ended in a month by those paying when it began", () => {
  const { monthly } = buildInvestorMetrics(source(), { now: NOW });
  assert.deepEqual(
    monthly.map((row) => row.month),
    ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
  );
  const [august, september, october] = monthly.slice(-3);
  assert.deepEqual(august, {
    month: "2026-08",
    complete: true,
    payingAtStart: 0,
    started: 2,
    ended: 0,
    churnRate: null,
    payingAtEnd: 2,
    mrrAtEnd: 7.49,
  });
  assert.equal(september.payingAtStart, 2);
  assert.equal(september.started, 1);
  assert.equal(september.ended, 1);
  assert.equal(september.churnRate, 0.5);
  assert.equal(september.payingAtEnd, 2);
  assert.equal(october.complete, false);
  assert.equal(october.churnRate, 0);
});

test("AI cost per active Strata+ member uses the configured token rate, and stays empty without one", () => {
  const priced = buildInvestorMetrics(source(), { now: NOW, usdPerMillionTokens: 0.5 });
  assert.equal(priced.ai.usdPerMillionTokens, 0.5);
  assert.deepEqual(priced.ai.months.at(-1), {
    month: "2026-10",
    complete: false,
    activePlusMembers: 1,
    requests: 10,
    tokens: 1_000_000,
    tokensPerMember: 1_000_000,
    estimatedCost: 0.5,
    costPerMember: 0.5,
  });
  assert.equal(priced.ai.months[1].costPerMember, 0.1);
  const unpriced = buildInvestorMetrics(source(), { now: NOW });
  assert.equal(unpriced.ai.months.at(-1).estimatedCost, null);
  assert.equal(unpriced.ai.months.at(-1).costPerMember, null);
  const idle = buildInvestorMetrics(source({ activeDays: [], aiUsage: [] }), {
    now: NOW,
    usdPerMillionTokens: 1,
  });
  assert.equal(idle.ai.months.at(-1).tokensPerMember, null);
  assert.equal(idle.ai.months.at(-1).costPerMember, null);
});

test("Strata AI shows only months whose every day is still kept", () => {
  assert.equal(AI_USAGE_DAYS, 90);
  assert.match(
    fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8"),
    new RegExp(`aiQuota\\.cleanup\\(${AI_USAGE_DAYS}\\)`),
    "the server deletes Strata AI usage after the same number of days",
  );
  const months = (iso) =>
    buildInvestorMetrics(source(), { now: at(iso) }).ai.months.map((row) => row.month);
  assert.deepEqual(months("2026-10-03T12:00:00Z"), ["2026-08", "2026-09", "2026-10"]);
  // On 31 October usage before 2 August is gone, so August would be missing its first day.
  assert.deepEqual(months("2026-10-31T12:00:00Z"), ["2026-09", "2026-10"]);
  assert.deepEqual(months("2026-11-01T00:30:00Z"), ["2026-09", "2026-10", "2026-11"]);
});

test("an empty database reports zeros, not errors", () => {
  const empty = buildInvestorMetrics(
    {
      accounts: [],
      activeDays: [],
      paddle: [],
      apple: [],
      lifetimeUserIds: [],
      aiUsage: [],
      activationSince: null,
      internalAccounts: 0,
    },
    { now: NOW },
  );
  assert.equal(empty.summary.weeklyActiveMembers, 0);
  assert.equal(empty.summary.conversionRate, null);
  assert.deepEqual(empty.summary.mrr, { list: 0, afterFees: 0 });
  assert.ok(metricsCsv(empty).startsWith("STRATA investor metrics\r\n"));
});

test("the activity query starts at the oldest week or month a figure reads", () => {
  assert.equal(new Date(metricsSince(NOW)).toISOString(), "2026-07-13T00:00:00.000Z");
  // At the end of October August's AI usage is no longer whole, so the oldest week (10 August) bounds the query.
  assert.equal(
    new Date(metricsSince(at("2026-10-31T12:00:00Z"))).toISOString(),
    "2026-08-10T00:00:00.000Z",
  );
  // Mid-month, the oldest AI month starts first.
  assert.equal(
    new Date(metricsSince(at("2026-10-20T12:00:00Z"))).toISOString(),
    "2026-08-01T00:00:00.000Z",
  );
});

test("the CSV has one table per figure and never lets a cell run as a spreadsheet formula", () => {
  const csv = metricsCsv(buildInvestorMetrics(source(), { now: NOW, usdPerMillionTokens: 0.5 }));
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "STRATA investor metrics");
  assert.ok(lines.includes("Generated,2026-10-03T12:00:00.000Z"));
  assert.ok(lines.includes("Internal accounts excluded,2"));
  assert.ok(lines.includes("4,3,75.0%,2,1,1,1,0,1,7.49,6.57"));
  assert.ok(lines.includes("2026-07-27,yes,2,2,1,1"));
  assert.ok(lines.includes("2026-07-27,2,2,1,50.0%,2,1,50.0%,2,1,50.0%"));
  assert.ok(lines.includes("2026-09,yes,2,1,1,50.0%,2,7.49"));
  assert.ok(lines.includes("2026-10,no,1,10,1000000,1000000,0.50,0.5000"));
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("@sum"), "'@sum");
  assert.equal(csvCell("-12"), "-12", "negative numbers stay numbers");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell(null), "");
});
