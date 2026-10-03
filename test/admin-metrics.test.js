"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminMetricsService, trainingDays } = require("../src/admin-metrics");

const NOW = Date.parse("2026-10-03T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function plan(days) {
  const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  return {
    version: 1,
    restDay: "Sunday",
    restDays: ["Sunday"],
    days: Object.fromEntries(
      names.map((name, index) => [name, index < days ? [{ exerciseId: "squat", sets: 3 }] : []]),
    ),
  };
}

function fakeStore({ preferences = null, rows } = {}) {
  const recorded = [],
    reads = [];
  return {
    recorded,
    reads,
    async preferences() {
      return preferences;
    },
    async recordFullWeek(userId, at) {
      recorded.push([userId, at]);
    },
    async investorMetricsRows(since, internalEmails) {
      reads.push({ since, internalEmails });
      return rows;
    },
  };
}

function captureJson() {
  const sent = [];
  return { sent, http: { json: (res, status, body) => sent.push({ status, body }) } };
}

function bus() {
  const handlers = [];
  return {
    handlers,
    on(name, handler, key) {
      handlers.push({ name, handler, key });
      return () => {};
    },
  };
}

test("the metrics service needs its store and JSON helper", () => {
  assert.throws(() => createAdminMetricsService({}), /incomplete/);
  assert.throws(() => createAdminMetricsService({ store: fakeStore(), http: {} }), /incomplete/);
});

test("a saved week is full once it has as many training days as the member chose", async () => {
  const cases = [
    { preferences: { preferences_json: JSON.stringify({ days: 3 }) }, days: 3, recorded: true },
    { preferences: { preferences_json: JSON.stringify({ days: 3 }) }, days: 2, recorded: false },
    { preferences: null, days: 3, recorded: false, label: "no profile: the default target is 4" },
    { preferences: null, days: 4, recorded: true },
    { preferences: { preferences_json: "not json" }, days: 4, recorded: true },
  ];
  for (const item of cases) {
    const store = fakeStore({ preferences: item.preferences }),
      events = bus(),
      { http } = captureJson();
    createAdminMetricsService({ store, http }).subscribe(events);
    assert.equal(events.handlers.length, 1);
    assert.equal(events.handlers[0].name, "plan.updated");
    assert.equal(events.handlers[0].key, "metrics.full_week");
    await events.handlers[0].handler({ userId: "u1", updatedAt: 1234, plan: plan(item.days) });
    assert.deepEqual(store.recorded, item.recorded ? [["u1", 1234]] : [], item.label);
  }
  const store = fakeStore(),
    events = bus();
  createAdminMetricsService({ store, http: captureJson().http }).subscribe(events);
  for (const payload of [
    {},
    { userId: "u1", updatedAt: 0, plan: plan(7) },
    { updatedAt: 5, plan: plan(7) },
  ])
    await events.handlers[0].handler(payload);
  assert.deepEqual(store.recorded, [], "a payload without a member or revision records nothing");
  assert.equal(trainingDays(null), 0);
  assert.equal(trainingDays(plan(2)), 2, "counted as the planner counts workout days");
  assert.equal(
    trainingDays({ days: { Monday: [1], Tuesday: "x" } }),
    0,
    "an unsaved shape is empty",
  );
  // Once an account's first full week is recorded, later saves skip the profile read and the write.
  const once = fakeStore({ preferences: { preferences_json: JSON.stringify({ days: 2 }) } }),
    onceEvents = bus();
  let reads = 0;
  const read = once.preferences;
  once.preferences = async (...args) => {
    reads += 1;
    return read(...args);
  };
  createAdminMetricsService({ store: once, http: captureJson().http }).subscribe(onceEvents);
  await onceEvents.handlers[0].handler({ userId: "u1", updatedAt: 10, plan: plan(0) });
  assert.equal(reads, 0, "a week with no training days needs no profile");
  await onceEvents.handlers[0].handler({ userId: "u1", updatedAt: 20, plan: plan(2) });
  await onceEvents.handlers[0].handler({ userId: "u1", updatedAt: 30, plan: plan(3) });
  assert.equal(reads, 1);
  assert.deepEqual(once.recorded, [["u1", 20]]);
});

test("the owner, App Store review, and listed internal accounts are left out of every figure", async () => {
  const rows = {
    accounts: [
      {
        id: "owner",
        created_at: NOW - 30 * DAY,
        first_full_week_at: null,
        method: "email",
        internal: 1,
      },
      {
        id: "customer",
        created_at: NOW - 30 * DAY,
        first_full_week_at: NOW - 29 * DAY,
        method: "google",
        internal: 0,
      },
    ],
    activeDays: [
      { user_id: "owner", day: Math.floor((NOW - 8 * DAY) / DAY), plus: 1 },
      { user_id: "customer", day: Math.floor((NOW - 8 * DAY) / DAY), plus: 1 },
      { user_id: "deleted", day: Math.floor((NOW - 8 * DAY) / DAY), plus: 1 },
    ],
    paddle: [
      {
        user_id: "owner",
        status: "active",
        created_at: NOW - 20 * DAY,
        changed_at: NOW - 20 * DAY,
      },
      {
        user_id: "customer",
        status: "active",
        created_at: NOW - 20 * DAY,
        changed_at: NOW - 20 * DAY,
      },
    ],
    apple: [
      { user_id: "owner", started_at: NOW - 5 * DAY, ends_at: NOW + 5 * DAY, revoked_at: null },
    ],
    lifetime: [{ user_id: "owner" }],
    aiUsage: [
      { user_id: "owner", month: "2026-10", requests: 9, tokens: 9000 },
      { user_id: "customer", month: "2026-09", requests: 1, tokens: 500 },
    ],
    activationSince: NOW - 60 * DAY,
  };
  const store = fakeStore({ rows }),
    { sent, http } = captureJson();
  const service = createAdminMetricsService({
    store,
    http,
    adminEmail: "Owner@Example.test",
    environment: {
      APPLE_SANDBOX_ACCOUNTS: "review@example.test, owner@example.test",
      STRATA_INTERNAL_ACCOUNTS: "demo@example.test,not-an-email",
      STRATA_AI_USD_PER_MILLION_TOKENS: "0.4",
    },
    now: () => NOW,
  });
  assert.deepEqual(
    service.routes.map((route) => [route.method, route.path, route.auth]),
    [["GET", "/api/admin/metrics", "admin"]],
  );
  await service.routes[0].handler({ res: {} });
  assert.deepEqual(store.reads[0].internalEmails, [
    "owner@example.test",
    "review@example.test",
    "demo@example.test",
  ]);
  assert.equal(new Date(store.reads[0].since).toISOString(), "2026-07-13T00:00:00.000Z");
  const [{ status, body }] = sent;
  assert.equal(status, 200);
  assert.equal(body.metrics.internalAccountsExcluded, 1);
  assert.equal(body.metrics.revenue.accounts, 1);
  assert.equal(body.metrics.revenue.payingMembers, 1);
  assert.equal(body.metrics.revenue.appStoreSubscriptions, 0);
  assert.equal(body.metrics.revenue.lifetimeMembers, 0);
  assert.equal(body.metrics.weekly.find((row) => row.weekStart === "2026-09-21").activeMembers, 1);
  assert.equal(body.metrics.ai.usdPerMillionTokens, 0.4);
  assert.equal(
    body.metrics.ai.months.at(-1).tokens,
    0,
    "the owner's own AI use is not a customer's",
  );
  assert.equal(body.csv.filename, "strata-metrics-2026-10-03.csv");
  assert.match(body.csv.text, /^STRATA investor metrics\r\n/);
});

test("the AI token rate is optional and must be a non-negative number", async () => {
  const rows = {
    accounts: [],
    activeDays: [],
    paddle: [],
    apple: [],
    lifetime: [],
    aiUsage: [],
    activationSince: null,
  };
  for (const [value, expected] of [
    [undefined, null],
    ["", null],
    ["  ", null],
    ["abc", null],
    ["-1", null],
    ["0", 0],
    [" 0.59 ", 0.59],
  ]) {
    const { sent, http } = captureJson();
    const service = createAdminMetricsService({
      store: fakeStore({ rows }),
      http,
      environment: { STRATA_AI_USD_PER_MILLION_TOKENS: value },
      now: () => NOW,
    });
    await service.routes[0].handler({ res: {} });
    assert.equal(sent[0].body.metrics.ai.usdPerMillionTokens, expected, String(value));
    assert.equal(sent[0].body.metrics.activationRecordedSince, null);
  }
});
