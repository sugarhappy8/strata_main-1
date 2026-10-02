"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountSelfService, publicSessionId } = require("../src/account-self-service");
const { EXPORT_PAGE_SIZE, streamExport } = require("../src/account-export");
const { routeHarness } = require("./support/route-harness");

const NOW = 1_800_000_000_000;
const currentSession = {
  id: "member-1",
  name: "Ari Stone",
  email: "ari@example.test",
  created_at: 1_700_000_000_000,
  email_verified_at: 1_700_000_100_000,
  auth_version: 1,
  suspended_at: null,
  token_hash: "current-private-token-hash",
  csrf_token: "current-private-csrf",
  expires_at: NOW + 10_000,
};

function fixtureRows() {
  return {
    profile: {
      id: "member-1",
      name: "Ari Stone",
      email: "ari@example.test",
      created_at: 1,
      password_hash: "never-export-this",
      password_salt: "never-export-salt",
      email_verified_at: 2,
    },
    weeklyPlan: { plan_json: JSON.stringify({ version: 1, days: { Monday: [] } }), updated_at: 3 },
    monthlyPlan: { plan_json: JSON.stringify({ month: "September" }), updated_at: 4 },
    preferences: { preferences_json: JSON.stringify({ goal: "strength" }), updated_at: 5 },
    ratings: [
      {
        exercise_id: "squat",
        comfort: 5,
        pump: 4,
        enjoyment: 5,
        stability: 4,
        setup: 3,
        overall: 5,
        created_at: 6,
        updated_at: 7,
      },
    ],
    workouts: [
      {
        id: "workout-1",
        workout_json: JSON.stringify({ status: "completed" }),
        summary_json: JSON.stringify({ totalSets: 3 }),
        create_hash: "never-export-create-hash",
        started_at: 8,
        revision: 2,
        updated_at: 9,
      },
    ],
    checkIns: [
      {
        workout_id: "workout-1",
        difficulty: 3,
        energy: 4,
        comfort: 5,
        enjoyment: 4,
        created_at: 10,
        updated_at: 11,
      },
    ],
    trainingBlock: { block_json: JSON.stringify({ week: 2 }), revision: 3, updated_at: 12 },
    trainingAdaptations: [
      {
        id: "adapt-1",
        workout_id: "workout-1",
        adaptation_json: JSON.stringify({ summary: "Add one rep" }),
        plan_updated_at: 12,
        status: "accepted",
        created_at: 13,
        resolved_at: 14,
      },
    ],
    coachingProfile: null,
    coachingWeeks: [],
    coachingLogs: [
      {
        log_date: "2030-03-04",
        calories: 2200,
        protein_g: 160,
        carbs_g: 250,
        fat_g: 65,
        morning_weight_kg: 82.4,
        intake_complete: 1,
        revision: 2,
        updated_at: 15,
      },
      {
        log_date: "2030-03-05",
        calories: 0,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        morning_weight_kg: null,
        intake_complete: null,
        revision: 1,
        updated_at: 16,
      },
      {
        log_date: "2030-03-06",
        calories: 1800,
        protein_g: null,
        carbs_g: null,
        fat_g: null,
        morning_weight_kg: 81.9,
        intake_complete: 0,
        revision: 1,
        updated_at: 17,
      },
    ],
    purchases: [
      {
        transaction_id: "txn_1",
        price_id: "pri_1",
        product_id: "pro_1",
        subscription_id: "sub_1",
        customer_id: "never-export-customer",
        paddle_status: "completed",
        completed_at: 19,
        access_revoked_at: null,
        revocation_reason: null,
        created_at: 18,
        updated_at: 19,
      },
    ],
    subscriptions: [
      {
        subscription_id: "sub_1",
        transaction_id: "txn_1",
        customer_id: "never-export-customer",
        status: "active",
        price_id: "pri_1",
        product_id: "pro_1",
        scheduled_change_action: null,
        scheduled_change_at: null,
        current_period_ends_at: 20,
        created_at: 19,
        updated_at: 20,
      },
    ],
    adjustments: [
      {
        adjustment_id: "adj_1",
        transaction_id: "txn_1",
        action: "refund",
        type: "full",
        status: "approved",
        occurred_at: 21,
        updated_at: 22,
      },
    ],
    supportTickets: [
      {
        id: "ticket-1",
        reference: "STRATA-ONE",
        name: "Ari",
        email: "ari@example.test",
        category: "privacy",
        subject: "Export",
        reference_id: null,
        message: "Please help",
        status: "resolved",
        admin_note: "never-export-admin-note",
        last_response_at: 23,
        created_at: 22,
        updated_at: 23,
      },
    ],
  };
}

function harness({ rateAllowed = () => true } = {}) {
  let rows = [
    {
      user_id: "member-1",
      token_hash: currentSession.token_hash,
      created_at: NOW - 2_000,
      expires_at: NOW + 10_000,
    },
    {
      user_id: "member-1",
      token_hash: "other-private-token-hash",
      created_at: NOW - 1_000,
      expires_at: NOW + 20_000,
    },
  ];
  const responses = new WeakMap(),
    calls = { revoke: 0, revokeOthers: 0, export: 0 };
  const store = {
    async accountSessions(userId, _currentHash, now) {
      return rows.filter((row) => row.user_id === userId && row.expires_at > now);
    },
    async revokeAccountSession(userId, target, current, now) {
      calls.revoke += 1;
      const before = rows.length;
      rows = rows.filter(
        (row) =>
          !(
            row.user_id === userId &&
            row.token_hash === target &&
            row.token_hash !== current &&
            row.expires_at > now
          ),
      );
      return rows.length < before;
    },
    async revokeOtherAccountSessions(userId, current, now) {
      calls.revokeOthers += 1;
      const before = rows.length;
      rows = rows.filter(
        (row) => !(row.user_id === userId && row.token_hash !== current && row.expires_at > now),
      );
      return before - rows.length;
    },
    async accountExport() {
      calls.export += 1;
      return fixtureRows();
    },
    async accountExportWorkouts(_userId, afterStartedAt, afterId, limit) {
      return fixtureRows()
        .workouts.filter(
          (row) =>
            row.started_at > afterStartedAt ||
            (row.started_at === afterStartedAt && row.id > afterId),
        )
        .slice(0, limit);
    },
  };
  const http = {
    json(res, status, data, headers = {}) {
      responses.set(res, { status, data, headers });
    },
    async bodyJson(req) {
      return req.input || {};
    },
    securityHeaders() {
      return { "X-Content-Type-Options": "nosniff" };
    },
  };
  const selfService = createAccountSelfService({
    store,
    http,
    now: () => NOW,
    rateAllowed,
    logger: { error() {} },
  });
  const service = routeHarness(selfService.routes, {
    json: http.json,
    requireSession: async (req, res) => {
      if (req.session) return req.session;
      http.json(res, 401, { error: "Sign in required." });
      return null;
    },
    validCsrf: (req, session) => req.headers["x-csrf-token"] === session.csrf_token,
  });
  async function invoke(
    path,
    method,
    { session = currentSession, csrf = currentSession.csrf_token, input = {} } = {},
  ) {
    const req = { method, headers: { "x-csrf-token": csrf }, session, input };
    let responseBody = "",
      responseStatus = 0,
      responseHeaders = {};
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead(status, headers) {
        responseStatus = status;
        responseHeaders = headers;
        this.headersSent = true;
      },
      write(chunk) {
        responseBody += String(chunk);
        return true;
      },
      end(chunk = "") {
        responseBody += String(chunk);
        this.writableEnded = true;
        responses.set(this, {
          status: responseStatus,
          data: JSON.parse(responseBody),
          headers: responseHeaders,
        });
      },
      destroy() {
        this.destroyed = true;
        this.writableEnded = true;
      },
      once() {},
      off() {},
    };
    const handled = await service.handleApi(req, res, new URL(path, "https://strata.test"));
    return { handled, ...responses.get(res) };
  }
  return { invoke, calls, rows: () => rows };
}

test("session responses use opaque IDs and never expose stored authentication material", async () => {
  const { invoke } = harness(),
    result = await invoke("/api/account/sessions", "GET");
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.data.otherCount, 1);
  assert.deepEqual(result.data.sessions, [
    {
      id: publicSessionId(currentSession.token_hash),
      current: true,
      createdAt: NOW - 2_000,
      expiresAt: NOW + 10_000,
    },
    {
      id: publicSessionId("other-private-token-hash"),
      current: false,
      createdAt: NOW - 1_000,
      expiresAt: NOW + 20_000,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result.data), /private-token|csrf|token_hash|ip|fingerprint/i);
});

test("session mutations require CSRF and preserve ownership and the current session", async () => {
  const state = harness();
  const invalidCsrf = await state.invoke("/api/account/sessions/revoke", "POST", {
    csrf: "wrong",
    input: { sessionId: publicSessionId("other-private-token-hash") },
  });
  assert.equal(invalidCsrf.status, 403);
  assert.equal(state.calls.revoke, 0);
  const current = await state.invoke("/api/account/sessions/revoke", "POST", {
    input: { sessionId: publicSessionId(currentSession.token_hash) },
  });
  assert.equal(current.status, 409);
  assert.equal(current.data.code, "CURRENT_SESSION_PROTECTED");
  assert.equal(state.calls.revoke, 0);
  const foreign = await state.invoke("/api/account/sessions/revoke", "POST", {
    input: { sessionId: publicSessionId("foreign-private-token-hash") },
  });
  assert.equal(foreign.status, 404);
  assert.equal(state.calls.revoke, 0);
  const other = await state.invoke("/api/account/sessions/revoke", "POST", {
    input: { sessionId: publicSessionId("other-private-token-hash") },
  });
  assert.equal(other.status, 200);
  assert.equal(other.data.revoked, 1);
  assert.equal(state.calls.revoke, 1);
  assert.deepEqual(
    state.rows().map((row) => row.token_hash),
    [currentSession.token_hash],
  );
  const bulk = await state.invoke("/api/account/sessions/revoke-others", "POST");
  assert.equal(bulk.status, 200);
  assert.equal(bulk.data.revoked, 0);
  assert.equal(state.calls.revokeOthers, 1);
  assert.deepEqual(
    state.rows().map((row) => row.token_hash),
    [currentSession.token_hash],
  );
});

test("account export is POST plus CSRF, no-store, and explicitly omits secrets and audit internals", async () => {
  const state = harness();
  const unauthenticated = await state.invoke("/api/account/export", "POST", { session: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(state.calls.export, 0);
  const invalidCsrf = await state.invoke("/api/account/export", "POST", { csrf: "wrong" });
  assert.equal(invalidCsrf.status, 403);
  assert.equal(state.calls.export, 0);
  const result = await state.invoke("/api/account/export", "POST");
  assert.equal(result.status, 200);
  assert.equal(result.headers["Cache-Control"], "private, no-store");
  assert.match(
    result.headers["Content-Disposition"],
    /^attachment; filename="strata-account-export-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  assert.equal(result.data.format, "strata-account-export");
  assert.equal(result.data.schemaVersion, 1);
  assert.equal(result.data.weeklyPlan.data.version, 1);
  assert.equal(result.data.workouts[0].workout.status, "completed");
  assert.equal(result.data.checkIns[0].workoutId, "workout-1");
  assert.equal(result.data.training.adaptations[0].status, "accepted");
  assert.deepEqual(
    result.data.coaching.logs.map(({ morningWeightKg, complete }) => ({
      morningWeightKg,
      complete,
    })),
    [
      { morningWeightKg: 82.4, complete: true },
      { morningWeightKg: null, complete: null },
      { morningWeightKg: 81.9, complete: false },
    ],
  );
  assert.equal(result.data.access.purchases[0].transactionId, "txn_1");
  assert.equal(result.data.supportTickets[0].reference, "STRATA-ONE");
  assert.doesNotMatch(
    JSON.stringify(result.data),
    /never-export|password_hash|password_salt|token_hash|csrf_token|customer_id|admin_note|create_hash/i,
  );
});

test("account export streams the complete workout history through stable bounded keyset pages", async () => {
  const source = Array.from({ length: 121 }, (_, index) => ({
    id: `workout-${String(index).padStart(4, "0")}`,
    workout_json: JSON.stringify({ status: "completed", index }),
    summary_json: JSON.stringify({ totalSets: index % 6 }),
    create_hash: `never-export-${index}`,
    started_at: 100 + Math.floor(index / 3),
    revision: 1,
    updated_at: 1_000 + index,
  }));
  const calls = [];
  const store = {
    async accountExportWorkouts(userId, afterStartedAt, afterId, limit) {
      calls.push({ userId, afterStartedAt, afterId, limit });
      return source
        .filter(
          (row) =>
            row.started_at > afterStartedAt ||
            (row.started_at === afterStartedAt && row.id > afterId),
        )
        .slice(0, limit);
    },
  };
  let body = "",
    status = 0,
    headers = {};
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    write(chunk) {
      body += String(chunk);
      return true;
    },
    end(chunk = "") {
      body += String(chunk);
      this.writableEnded = true;
    },
    once() {},
    off() {},
  };
  await streamExport(res, store, "member-1", fixtureRows(), NOW, {
    "X-Content-Type-Options": "nosniff",
  });
  const data = JSON.parse(body);
  assert.equal(status, 200);
  assert.equal(headers["X-Strata-Export"], "account-v1");
  assert.equal(data.workouts.length, source.length);
  assert.equal(data.workouts[0].id, source[0].id);
  assert.equal(data.workouts.at(-1).id, source.at(-1).id);
  assert.deepEqual(calls, [
    { userId: "member-1", afterStartedAt: -1, afterId: "", limit: EXPORT_PAGE_SIZE },
    { userId: "member-1", afterStartedAt: 116, afterId: "workout-0049", limit: EXPORT_PAGE_SIZE },
    { userId: "member-1", afterStartedAt: 133, afterId: "workout-0099", limit: EXPORT_PAGE_SIZE },
  ]);
  assert.doesNotMatch(
    body,
    /never-export|create_hash|password_hash|token_hash|customer_id|admin_note/i,
  );
});

test("account self-service rate limits reject mutations before their side effects", async () => {
  const state = harness({ rateAllowed: () => false });
  const revoked = await state.invoke("/api/account/sessions/revoke", "POST", {
    input: { sessionId: publicSessionId("other-private-token-hash") },
  });
  assert.equal(revoked.status, 429);
  assert.equal(state.calls.revoke, 0);
  const exported = await state.invoke("/api/account/export", "POST");
  assert.equal(exported.status, 429);
  assert.equal(exported.data.code, "ACCOUNT_EXPORT_RATE_LIMIT");
  assert.equal(state.calls.export, 0);
});

test("account export waits for response backpressure before reading workout pages", async () => {
  let body = "",
    blocked = true,
    pageReads = 0;
  const listeners = new Map();
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      body += String(chunk);
      if (blocked) return false;
      return true;
    },
    end(chunk = "") {
      body += String(chunk);
      this.writableEnded = true;
    },
    once(name, listener) {
      listeners.set(name, listener);
      if (name === "drain")
        queueMicrotask(() => {
          blocked = false;
          listeners.get("drain")?.();
        });
    },
    off(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  const store = {
    async accountExportWorkouts() {
      pageReads += 1;
      assert.equal(blocked, false, "storage paging must wait until the response drains");
      return [];
    },
  };
  await streamExport(res, store, "member-1", fixtureRows(), NOW, {});
  assert.equal(pageReads, 1);
  assert.equal(JSON.parse(body).workouts.length, 0);
});
