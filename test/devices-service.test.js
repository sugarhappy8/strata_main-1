"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { devicesSettings, keyId, tokenKey } = require("../src/devices-config");
const { open, sha256 } = require("../src/devices-crypto");
const { POLAR_SCOPES, parsePolarCredentials } = require("../src/polar-client");
const { CONSENT_VERSION, createDevicesService, publicConnection } = require("../src/devices");

const KEY = randomBytes(32).toString("base64"),
  NOW = Date.parse("2026-09-28T09:00:00Z");
const SETTINGS = devicesSettings({
  POLAR_CLIENT_ID: "client",
  POLAR_CLIENT_SECRET: "secret",
  DEVICE_TOKEN_KEY: KEY,
  APP_BASE_URL: "https://strata.test",
});
const KEYS = [{ id: keyId(tokenKey(KEY)), key: tokenKey(KEY) }];
const STATE = "s".repeat(43);

function response() {
  return { status: 0, body: null, headers: {}, location: "" };
}
const http = {
  json: (res, status, body, headers = {}) => {
    res.status = status;
    res.body = body;
    res.headers = headers;
  },
  redirect: (res, location, headers = {}) => {
    res.status = 303;
    res.location = location;
    res.headers = headers;
  },
  bodyJson: async (req) => req.body || {},
  bodyBuffer: async (req) => Buffer.from(req.raw || ""),
};
function request(method, { headers = {}, ...overrides } = {}) {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    session: { id: "member", token_hash: "session-hash", csrf_token: "csrf" },
    ...overrides,
  };
}
function harness({
  store = {},
  polar = {},
  sync = {},
  settings = SETTINGS,
  rate = () => true,
  plus = true,
  unique,
} = {}) {
  const calls = [];
  const fakeStore = {
    async deviceConnection() {
      return null;
    },
    async deviceConnectionByProviderUser() {
      return null;
    },
    async insertDeviceConnectState(record) {
      calls.push(["state", record]);
      return true;
    },
    async readDeviceConnectState() {
      return { used_at: null, expires_at: NOW + 60000 };
    },
    async discardDeviceConnectState() {},
    async consumeDeviceConnectState() {
      return { provider: "polar", redirect_uri: "https://strata.test/api/devices/polar/callback" };
    },
    async upsertDeviceConnection(record) {
      calls.push(["upsert", record]);
      return {
        user_id: record.userId,
        provider: "polar",
        status: "active",
        settings_json: record.settingsJson,
        connected_at: record.connectedAt,
        revision: 1,
      };
    },
    async deleteDeviceData() {
      calls.push(["delete"]);
      return { provider_user_id: "old-local-id", token_sealed: "sealed" };
    },
    async updateDeviceSettings() {
      return null;
    },
    async wellnessNights() {
      return [];
    },
    async wellnessDays() {
      return [];
    },
    async wellnessWorkouts() {
      return [];
    },
    async workouts() {
      return null;
    },
    ...store,
  };
  const grant = {
    version: 4,
    accessToken: "new-access",
    refreshToken: "new-refresh",
    expiresAt: NOW + 12 * 60 * 60 * 1000,
    scopes: [...POLAR_SCOPES],
  };
  const fakePolar = {
    authorizeUrl: ({ state }) => `https://auth.polar.test/?state=${state}`,
    exchangeCode: async () => grant,
    ...polar,
  };
  const fakeSync = {
    syncConnection: async () => ({ status: "synced" }),
    started: 0,
    stopped: 0,
    start() {
      this.started += 1;
    },
    stop() {
      this.stopped += 1;
    },
    ...sync,
  };
  const logs = [];
  const service = createDevicesService({
    store: fakeStore,
    settings,
    http,
    polar: fakePolar,
    sync: fakeSync,
    now: () => NOW,
    auth: {
      requireSession: async (req, res) => {
        if (!req.session) {
          http.json(res, 401, { error: "Sign in required." });
          return null;
        }
        return req.session;
      },
      validCsrf: (req) => req.headers["x-csrf-token"] !== "wrong",
    },
    requireAccess: async (req, res) => {
      if (!plus) {
        http.json(res, 402, { code: "DISCOVERY_ACCESS_REQUIRED" });
        return null;
      }
      return req.session;
    },
    trustedOrigin: (req) => req.headers.origin !== "https://evil.test",
    rateAllowed: (req, key, max, windowMs) => rate(key, max, windowMs),
    hasAccess: async () => plus,
    logger: {
      info: (name) => logs.push(name),
      warn: (name) => logs.push(name),
      error: (name) => logs.push(name),
    },
    ...(unique ? { isUniqueViolation: unique } : {}),
  });
  return { service, calls, logs, sync: fakeSync, grant };
}
async function call(service, method, path, overrides = {}) {
  const res = response(),
    handled = await service.handleApi(
      request(method, overrides),
      res,
      new URL(`https://strata.test${path}`),
    );
  return { ...res, handled };
}

test("connected-device routes answer only their own paths and methods", async () => {
  const { service } = harness();
  assert.equal((await call(service, "GET", "/api/other")).handled, false);
  const wrong = await call(service, "POST", "/api/wellness/today");
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.Allow, "GET");
  const head = await call(service, "HEAD", "/api/wellness/today");
  assert.equal(head.status, 200);
  const signedOut = await call(service, "GET", "/api/devices", { session: null });
  assert.equal(signedOut.status, 401);
  assert.equal(
    (await call(service, "DELETE", "/api/devices/polar", { session: null })).status,
    401,
  );
  assert.throws(() => createDevicesService({}), /Connected devices require/);
  assert.deepEqual(publicConnection(null), null);
  assert.deepEqual(
    publicConnection({
      provider: "polar",
      status: "active",
      settings_json: "not json",
      revision: "2",
      last_sync_at: null,
    }).settings,
    { recoverySuggestions: true },
  );
  assert.equal(CONSENT_VERSION, "2026-10-polar-v4");
});

test("reads and connection attempts are rate limited and fail closed when Polar is not set up", async () => {
  const limited = harness({ rate: (key) => !/devices:(read|connect)/.test(key) });
  const read = await call(limited.service, "GET", "/api/devices");
  assert.equal(read.status, 429);
  assert.equal(read.body.code, "DEVICES_RATE_LIMIT");
  assert.equal((await call(limited.service, "GET", "/api/wellness/trends")).status, 429);
  assert.equal(
    (await call(limited.service, "POST", "/api/devices/polar/connect", { body: {} })).status,
    429,
  );
  const off = harness({ settings: devicesSettings({}) });
  const connect = await call(off.service, "POST", "/api/devices/polar/connect", { body: {} });
  assert.equal(connect.status, 503);
  assert.equal(connect.body.code, "DEVICES_NOT_CONFIGURED");
  off.service.start();
  assert.equal(off.sync.started, 0, "the sync loop stays off without settings");
  off.service.stop();
  assert.equal(off.sync.stopped, 1);
  const on = harness();
  on.service.start();
  assert.equal(on.sync.started, 1);
  const suspended = harness({ store: { insertDeviceConnectState: async () => false } });
  assert.equal(
    (await call(suspended.service, "POST", "/api/devices/polar/connect", { body: {} })).body.code,
    "DEVICES_ACCOUNT_CHANGED",
  );
  const connected = await call(on.service, "POST", "/api/devices/polar/connect", { body: {} });
  assert.equal(connected.status, 200);
  assert.match(
    connected.body.authorizeUrl,
    /^https:\/\/auth\.polar\.test\/\?state=[A-Za-z0-9_-]{43}$/,
  );
  const state = on.calls.find((entry) => entry[0] === "state")[1];
  assert.equal(
    state.stateHash,
    sha256(new URL(connected.body.authorizeUrl).searchParams.get("state")),
  );
  assert.equal(state.sessionHash, "session-hash");
  assert.equal(state.redirectUri, "https://strata.test/api/devices/polar/callback");
  assert.equal(
    (
      await call(on.service, "POST", "/api/devices/polar/connect", {
        body: {},
        headers: { "x-csrf-token": "wrong" },
      })
    ).status,
    403,
  );
});

test("the redirect back from Polar is rate limited and never links anything by itself", async () => {
  const limited = harness({ rate: (key) => key !== "devices:callback" });
  assert.equal(
    (
      await call(limited.service, "GET", `/api/devices/polar/callback?state=${STATE}&code=abc`, {
        session: null,
      })
    ).location,
    "/account.html?devices=polar-failed#connectedDevices",
  );
  const used = harness({
    store: { readDeviceConnectState: async () => ({ used_at: NOW - 1, expires_at: NOW + 1000 }) },
  });
  assert.equal(
    (
      await call(used.service, "GET", `/api/devices/polar/callback?state=${STATE}&code=abc`, {
        session: null,
      })
    ).location,
    "/account.html?devices=polar-expired#connectedDevices",
  );
  const expired = harness({
    store: { readDeviceConnectState: async () => ({ used_at: null, expires_at: NOW }) },
  });
  assert.equal(
    (
      await call(expired.service, "GET", `/api/devices/polar/callback?state=${STATE}&code=abc`, {
        session: null,
      })
    ).location,
    "/account.html?devices=polar-expired#connectedDevices",
  );
  const failed = harness();
  assert.equal(
    (
      await call(
        failed.service,
        "GET",
        `/api/devices/polar/callback?state=${STATE}&error=server_error`,
        { session: null },
      )
    ).location,
    "/account.html?devices=polar-failed#connectedDevices",
  );
  assert.equal(
    (
      await call(
        failed.service,
        "GET",
        `/api/devices/polar/callback?state=${STATE}&code=${"x".repeat(600)}`,
        { session: null },
      )
    ).location,
    "/account.html?devices=polar-failed#connectedDevices",
  );
  const ok = await call(
    failed.service,
    "GET",
    `/api/devices/polar/callback?state=${STATE}&code=abc`,
    { session: null },
  );
  assert.match(
    ok.headers["Set-Cookie"],
    /^strata_device_return=s{43}\.abc; Path=\/api\/devices\/polar\/complete; HttpOnly; SameSite=Lax; Max-Age=600$/,
  );
  const secure = harness({
    settings: devicesSettings({
      POLAR_CLIENT_ID: "client",
      POLAR_CLIENT_SECRET: "secret",
      DEVICE_TOKEN_KEY: KEY,
      SECURE_COOKIES: "true",
    }),
  });
  assert.match(
    (
      await call(secure.service, "GET", `/api/devices/polar/callback?state=${STATE}&code=abc`, {
        session: null,
      })
    ).headers["Set-Cookie"],
    /; Secure$/,
  );
});

test("completing a connection maps Polar failures, replaces local data, and handles races", async () => {
  const cookie = { cookie: `other=1; strata_device_return=${STATE}.the-code` };
  const complete = (service, extra = {}) =>
    call(service, "POST", "/api/devices/polar/complete", {
      body: {},
      headers: { ...cookie, ...extra },
    });
  const unreadable = await complete(harness().service, { cookie: "strata_device_return=%E0%A4%A" });
  assert.equal(unreadable.body.code, "DEVICES_CONNECT_EXPIRED");
  const rejected = harness({
    polar: {
      exchangeCode: async () => {
        throw Object.assign(new Error("Polar did not accept this sign-in."), {
          code: "POLAR_CODE_REJECTED",
        });
      },
    },
  });
  const answer = await complete(rejected.service);
  assert.equal(answer.status, 400);
  assert.match(answer.headers["Set-Cookie"], /Max-Age=0/);
  const down = harness({
    polar: {
      exchangeCode: async () => {
        throw Object.assign(new Error("401"), { code: "POLAR_AUTH", status: 401 });
      },
    },
  });
  const unavailable = await complete(down.service);
  assert.equal(
    unavailable.status,
    503,
    "a Polar sign-in problem is never reported as the member's own session",
  );
  assert.equal(unavailable.body.code, "POLAR_AUTH");
  const bug = harness({
    polar: {
      exchangeCode: async () => {
        throw new TypeError("bug");
      },
    },
  });
  await assert.rejects(complete(bug.service), /bug/);

  const replacing = harness({
    store: {
      deviceConnection: async () => ({
        provider_user_id: "old-local-id",
        settings_json: '{"recoverySuggestions":false}',
      }),
    },
  });
  const replaced = await complete(replacing.service);
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.connection.importing, true);
  assert.deepEqual(
    replacing.calls.filter((entry) => entry[0] === "delete"),
    [["delete"]],
    "the previous authorization and imported data are removed locally",
  );
  const record = replacing.calls.find((entry) => entry[0] === "upsert")[1];
  assert.equal(
    record.settingsJson,
    JSON.stringify({ recoverySuggestions: false }),
    "the member's recovery preference survives a reconnect",
  );
  assert.match(record.providerUserId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(parsePolarCredentials(open(KEYS, record.tokenSealed)), replacing.grant);
  assert.equal(record.tokenExpiresAt, replacing.grant.expiresAt);
  assert.equal(record.consentVersion, CONSENT_VERSION);

  const same = harness({
    store: {
      deviceConnection: async () => ({
        provider_user_id: "another-local-id",
        settings_json: '{"recoverySuggestions":false}',
      }),
    },
  });
  await complete(same.service);
  assert.equal(
    same.calls.find((entry) => entry[0] === "upsert")[1].settingsJson,
    '{"recoverySuggestions":false}',
    "reconnecting keeps the member's settings",
  );
  const race = harness({
    store: {
      upsertDeviceConnection: async () => {
        throw new Error(
          "UNIQUE constraint failed: device_connections.provider, device_connections.provider_user_id",
        );
      },
    },
  });
  assert.equal((await complete(race.service)).body.code, "DEVICES_CONNECT_CONFLICT");
  const customRace = harness({
    unique: () => true,
    store: {
      upsertDeviceConnection: async () => {
        throw new Error("duplicate");
      },
    },
  });
  assert.equal((await complete(customRace.service)).body.code, "DEVICES_CONNECT_CONFLICT");
  const broken = harness({
    store: {
      upsertDeviceConnection: async () => {
        throw new Error("disk full");
      },
    },
  });
  await assert.rejects(complete(broken.service), /disk full/);
  const gone = harness({ store: { upsertDeviceConnection: async () => null } });
  assert.equal((await complete(gone.service)).body.code, "DEVICES_ACCOUNT_CHANGED");
  const failingImport = harness({
    sync: {
      syncConnection: async () => {
        throw new Error("sync crashed");
      },
    },
  });
  assert.equal((await complete(failingImport.service)).status, 200);
  await new Promise(setImmediate);
  assert.ok(failingImport.logs.includes("device.sync_start_failed"));
});

test("disconnect deletes local V4 credentials and data without an unsupported provider call", async () => {
  const local = harness(),
    result = await call(local.service, "DELETE", "/api/devices/polar", { body: {} });
  assert.equal(result.body.disconnected, true);
  assert.deepEqual(
    local.calls.filter((entry) => entry[0] === "delete"),
    [["delete"]],
  );
  const csrf = await call(harness().service, "DELETE", "/api/devices/polar", {
    body: {},
    headers: { "x-csrf-token": "wrong" },
  });
  assert.equal(csrf.status, 403);
  const origin = await call(harness().service, "DELETE", "/api/devices/polar", {
    body: {},
    headers: { origin: "https://evil.test" },
  });
  assert.equal(origin.body.code, "DEVICES_ORIGIN_REQUIRED");
});

test("settings and wellness reads validate their input", async () => {
  const { service } = harness();
  for (const body of [
    { provider: "whoop", settings: { recoverySuggestions: true }, expectedRevision: 1 },
    { provider: "polar", settings: [], expectedRevision: 1 },
    { provider: "polar", settings: { recoverySuggestions: true, extra: 1 }, expectedRevision: 1 },
    { provider: "polar", settings: { recoverySuggestions: true }, expectedRevision: 0 },
  ]) {
    assert.equal(
      (await call(service, "PUT", "/api/devices/settings", { body })).status,
      400,
      JSON.stringify(body),
    );
  }
  assert.equal(
    (
      await call(service, "PUT", "/api/devices/settings", {
        body: { provider: "polar", settings: { recoverySuggestions: true }, expectedRevision: 1 },
      })
    ).body.code,
    "DEVICES_CHANGED",
  );
  const reconnect = harness({
    store: {
      deviceConnection: async () => ({
        status: "reconnect",
        provider: "polar",
        settings_json: "{}",
      }),
    },
  });
  assert.equal(
    (await call(reconnect.service, "POST", "/api/devices/polar/sync", { body: {} })).body.code,
    "DEVICES_RECONNECT",
  );
  const connected = harness({
    store: {
      deviceConnection: async () => ({
        status: "active",
        provider: "polar",
        settings_json: "{}",
        last_sync_at: NOW - 1000,
      }),
      workouts: async () => [
        { summary_json: "not json" },
        { summary_json: JSON.stringify({ status: "completed", date: "2026-09-27" }) },
      ],
    },
  });
  const trends = await call(
    connected.service,
    "GET",
    "/api/wellness/trends?weeks=12&date=2026-09-28",
  );
  assert.equal(trends.body.trends.weeks, 12);
  assert.equal(trends.body.trends.training.at(-1).strataWorkouts, 1);
  const farDate = await call(connected.service, "GET", "/api/wellness/today?date=2026-01-01");
  assert.equal(farDate.body.today, "2026-09-28", "a date far from the server's today is ignored");
  const workouts = await call(connected.service, "GET", "/api/wellness/workouts?days=500");
  assert.deepEqual(workouts.body.workouts, []);
  const lapsed = harness({ plus: false });
  assert.equal((await call(lapsed.service, "GET", "/api/wellness/today")).status, 402);
  const status = await call(lapsed.service, "GET", "/api/devices");
  assert.equal(status.status, 200);
  assert.equal(status.body.plus, false);
});
