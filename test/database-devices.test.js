"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");

const ROOT = join(__dirname, ".."),
  RUNTIME = join(ROOT, "test-runtime");
const NOW = Date.parse("2026-09-28T09:00:00Z"),
  DAY = 24 * 60 * 60 * 1000;

function fakeTursoClientFactory() {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  async function execute(statement) {
    const sql = typeof statement === "string" ? statement : statement.sql,
      args = typeof statement === "string" ? [] : statement.args || [],
      prepared = database.prepare(sql),
      returns = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (returns) {
      const rows = prepared.all(...args),
        columns = prepared.columns().map((column) => column.name);
      return {
        columns,
        rows: rows.map((row) => columns.map((column) => row[column])),
        rowsAffected: Number(database.prepare("SELECT changes() AS count").get().count),
      };
    }
    const result = prepared.run(...args);
    return { columns: [], rows: [], rowsAffected: Number(result.changes) };
  }
  return {
    execute,
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await execute(statement));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

async function stores() {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, "devices-parity-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  process.env.NODE_ENV = "test";
  process.env.STRATA_DATA_DIR = directory;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  const local = await createStore(ROOT);
  delete process.env.STRATA_DATA_DIR;
  process.env.TURSO_DATABASE_URL = "https://devices-parity.invalid";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const turso = await createStore(ROOT, { tursoClientFactory: fakeTursoClientFactory });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return {
    local,
    turso,
    async close() {
      await Promise.all([local.close(), turso.close()]);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const night = (date, overrides = {}) => ({
  nightDate: date,
  recoveryStatus: 4,
  ansCharge: 1.5,
  ansChargeStatus: 3,
  sleepCharge: 3,
  heartRateAvg: 52,
  hrvAvg: 61,
  breathingRateAvg: 14.2,
  sleepScore: 81,
  sleepStart: "2026-09-27T23:00:00+03:00",
  sleepEnd: "2026-09-28T06:30:00+03:00",
  asleepSeconds: 25000,
  lightSeconds: 14000,
  deepSeconds: 5000,
  remSeconds: 6000,
  interruptionSeconds: 900,
  updatedAt: NOW,
  ...overrides,
});
const day = (date, overrides = {}) => ({
  dayDate: date,
  restingHr: 48,
  minHr: 46,
  avgHr: 70,
  maxHr: 150,
  samples: 1200,
  bucketsJson: JSON.stringify(Array(48).fill(60)),
  updatedAt: NOW,
  ...overrides,
});
const workout = (id, startedAt, overrides = {}) => ({
  externalId: id,
  startedAt,
  localDate: new Date(startedAt).toISOString().slice(0, 10),
  durationSeconds: 1800,
  sport: "Running",
  calories: 300,
  hrAvg: 140,
  hrMax: 170,
  cardioLoad: 60,
  updatedAt: NOW,
  ...overrides,
});
const connection = (userId, providerUserId, overrides = {}) => ({
  userId,
  provider: "polar",
  providerUserId,
  memberRef: `ref-${providerUserId}`,
  tokenSealed: `sealed-${providerUserId}`,
  tokenExpiresAt: null,
  settingsJson: JSON.stringify({ recoverySuggestions: true }),
  consentVersion: "2026-10-polar-v4",
  connectedAt: NOW,
  nextSyncAt: NOW + 600000,
  updatedAt: NOW,
  ...overrides,
});

async function scenario(store, suffix) {
  const user = (id) => ({
    id: `${id}-${suffix}`,
    name: "Device Member",
    email: `${id}-${suffix}@example.test`,
    passwordHash: "hash",
    passwordSalt: "salt",
    createdAt: NOW - DAY,
    emailVerifiedAt: NOW - DAY,
  });
  const a = user("a"),
    b = user("b");
  await store.insertUser(a);
  await store.insertUser(b);
  const result = {};

  const state = (hash, userId, expiresAt = NOW + 600000) =>
    store.insertDeviceConnectState({
      stateHash: hash,
      userId,
      provider: "polar",
      sessionHash: "session-a",
      redirectUri: "https://strata.test/api/devices/polar/callback",
      createdAt: NOW,
      expiresAt,
    });
  result.states = {
    saved: await state("s1", a.id),
    unknownUser: await state("s-ghost", "nobody"),
    read: await store.readDeviceConnectState("s1"),
    wrongUser: await store.consumeDeviceConnectState("s1", b.id, "session-a", NOW),
    wrongSession: await store.consumeDeviceConnectState("s1", a.id, "session-b", NOW),
    consumed: await store.consumeDeviceConnectState("s1", a.id, "session-a", NOW + 1),
    reused: await store.consumeDeviceConnectState("s1", a.id, "session-a", NOW + 2),
  };
  await state("s2", a.id, NOW - 1);
  result.states.expired = await store.consumeDeviceConnectState("s2", a.id, "session-a", NOW);
  await state("s3", a.id);
  await store.discardDeviceConnectState("s3", NOW + 5);
  result.states.discarded = Number((await store.readDeviceConnectState("s3")).used_at);

  const first = await store.upsertDeviceConnection(connection(a.id, "111"));
  result.connection = {
    revision: Number(first.revision),
    status: first.status,
    syncedThrough: first.synced_through,
    nextSyncAt: Number(first.next_sync_at),
    settings: JSON.parse(first.settings_json),
  };
  result.connection.duplicate = await store.upsertDeviceConnection(connection(b.id, "111")).then(
    () => "stored",
    (error) => (/UNIQUE/i.test(String(error.message)) ? "unique" : String(error.message)),
  );
  result.connection.byProvider =
    (await store.deviceConnectionByProviderUser("polar", "111")).user_id === a.id;
  result.connection.ghost = await store.upsertDeviceConnection(connection("nobody", "999"));

  const ownerA = { userId: a.id, provider: "polar", providerUserId: "111" },
    stranger = { ...ownerA, providerUserId: "999" };
  result.token = {
    updated: await store.updateDeviceToken({
      ...ownerA,
      tokenSealed: "sealed-rotated",
      tokenExpiresAt: NOW + DAY,
      updatedAt: NOW + 1,
    }),
    stranger: await store.updateDeviceToken({
      ...stranger,
      tokenSealed: "stolen",
      tokenExpiresAt: NOW + DAY,
      updatedAt: NOW + 1,
    }),
  };
  const rotated = await store.deviceConnection(a.id, "polar");
  result.token.value = [rotated.token_sealed, Number(rotated.token_expires_at)];
  await store.upsertWellnessNight(ownerA, night("2026-09-27"));
  await store.upsertWellnessNight(
    ownerA,
    night("2026-09-27", { recoveryStatus: 5, hrvAvg: null, sleepScore: null, updatedAt: NOW + 1 }),
  );
  await store.upsertWellnessNight(ownerA, night("2026-09-28", { ansCharge: 13.4 }));
  await store.upsertWellnessNight(stranger, night("2026-09-26"));
  await store.upsertWellnessDay(ownerA, day("2026-09-28"));
  await store.upsertWellnessDay(ownerA, day("2026-09-28", { restingHr: 50 }));
  await store.upsertWellnessDay(stranger, day("2026-09-27"));
  await store.upsertWellnessWorkout(ownerA, workout("w1", NOW - 2 * 60 * 60 * 1000));
  await store.upsertWellnessWorkout(
    ownerA,
    workout("w1", NOW - 2 * 60 * 60 * 1000, { calories: 320 }),
  );
  await store.upsertWellnessWorkout(stranger, workout("w2", NOW));
  const nights = await store.wellnessNights(a.id, "polar", "2026-09-01", "2026-09-30");
  result.wellness = {
    nights: nights.map((row) => [
      row.night_date,
      Number(row.recovery_status),
      Number(row.ans_charge),
      Number(row.hrv_avg),
      Number(row.sleep_score),
      Number(row.updated_at),
    ]),
    windowed: (await store.wellnessNights(a.id, "polar", "2026-09-28", "2026-09-28")).length,
    days: (await store.wellnessDays(a.id, "polar", "2026-09-01", "2026-09-30")).map((row) => [
      row.day_date,
      Number(row.resting_hr),
      JSON.parse(row.buckets_json).length,
    ]),
    workouts: (await store.wellnessWorkouts(a.id, "polar", NOW - DAY, NOW + DAY)).map((row) => [
      row.external_id,
      Number(row.calories),
      row.sport,
    ]),
  };

  result.sync = {
    recorded: await store.recordDeviceSync({
      ...ownerA,
      status: "active",
      syncedThrough: "2026-09-28",
      lastSyncAt: NOW,
      lastError: null,
      nextSyncAt: NOW + 20 * 60 * 60 * 1000,
      failures: 0,
      updatedAt: NOW,
    }),
    strangerRecorded: await store.recordDeviceSync({
      ...stranger,
      status: "active",
      syncedThrough: "2026-09-28",
      lastSyncAt: NOW,
      lastError: null,
      nextSyncAt: NOW,
      failures: 0,
      updatedAt: NOW,
    }),
    dueBefore: (await store.dueDeviceConnections(NOW + 60000, 10)).length,
    marked:
      (await store.markDeviceConnectionDue("polar", "111", NOW + 60000, NOW))?.user_id === a.id,
    markedLater: Boolean(await store.markDeviceConnectionDue("polar", "999", NOW + 60000, NOW)),
  };
  await store.markDeviceConnectionDue("polar", "111", NOW + 30 * 60000, NOW);
  const due = await store.dueDeviceConnections(NOW + 60000, 10);
  result.sync.due = due.map((row) => [
    row.user_id === a.id,
    Number(row.next_sync_at),
    row.synced_through,
    Number(row.last_sync_at),
  ]);
  result.sync.limited = (await store.dueDeviceConnections(NOW + 60000, 0)).length;

  const saved = await store.updateDeviceSettings(
    a.id,
    "polar",
    JSON.stringify({ recoverySuggestions: false }),
    1,
    NOW + 10,
  );
  result.settings = {
    revision: Number(saved.revision),
    settings: JSON.parse(saved.settings_json),
    stale: await store.updateDeviceSettings(a.id, "polar", "{}", 1, NOW + 11),
  };
  const same = await store.upsertDeviceConnection(
    connection(a.id, "111", {
      tokenSealed: "sealed-new",
      connectedAt: NOW + 20,
      updatedAt: NOW + 20,
    }),
  );
  result.reconnect = {
    revision: Number(same.revision),
    syncedThrough: same.synced_through,
    settings: JSON.parse(same.settings_json),
    token: same.token_sealed,
  };

  const exported = await store.accountExport(a.id);
  result.exported = {
    connections: exported.deviceConnections.map((row) => Object.keys(row).sort().join(",")),
    nights: exported.wellnessNights.length,
    days: exported.wellnessDays.length,
    workouts: exported.wellnessWorkouts.length,
    buckets: exported.wellnessDays[0].buckets_json !== null,
  };

  const removed = await store.deleteDeviceData(a.id, "polar");
  result.disconnect = {
    removed: { providerUserId: removed.provider_user_id, token: removed.token_sealed },
    again: await store.deleteDeviceData(a.id, "polar"),
    connection: await store.deviceConnection(a.id, "polar"),
    nights: (await store.wellnessNights(a.id, "polar", "2000-01-01", "2100-01-01")).length,
    days: (await store.wellnessDays(a.id, "polar", "2000-01-01", "2100-01-01")).length,
    workouts: (await store.wellnessWorkouts(a.id, "polar", 0, NOW * 2)).length,
  };

  // A different Polar account starts a fresh history.
  await store.upsertDeviceConnection(connection(a.id, "121"));
  await store.recordDeviceSync({
    userId: a.id,
    provider: "polar",
    providerUserId: "121",
    status: "active",
    syncedThrough: "2026-09-28",
    lastSyncAt: NOW,
    lastError: null,
    nextSyncAt: NOW,
    failures: 0,
    updatedAt: NOW,
  });
  result.replaced = (await store.upsertDeviceConnection(connection(a.id, "122"))).synced_through;

  // Deleting an account removes the connection, its wellness data, and any pending connect state.
  await store.upsertDeviceConnection(connection(b.id, "333"));
  await store.upsertWellnessNight(
    { userId: b.id, provider: "polar", providerUserId: "333" },
    night("2026-09-28"),
  );
  await state("s4", b.id);
  await store.upsertAccountAction({
    requestId: `delete-${suffix}`,
    userId: b.id,
    purpose: "account_delete",
    tokenHash: `delete-token-${suffix}`,
    expiresAt: NOW + 1000,
    deliveryState: "sent",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const deletion = await store.deleteAccount(`delete-token-${suffix}`, NOW + 10, "email-hash");
  result.accountDeletion = {
    status: deletion.status,
    connection: await store.deviceConnectionByProviderUser("polar", "333"),
    nights: (await store.wellnessNights(b.id, "polar", "2000-01-01", "2100-01-01")).length,
    state: await store.readDeviceConnectState("s4"),
  };

  // Cleanup keeps 13 months of wellness data and 28 days of heart-rate detail.
  const ownerNew = { userId: a.id, provider: "polar", providerUserId: "122" };
  await store.upsertWellnessNight(ownerNew, night("2025-08-01"));
  await store.upsertWellnessNight(ownerNew, night("2026-09-20"));
  await store.upsertWellnessDay(ownerNew, day("2025-08-01"));
  await store.upsertWellnessDay(ownerNew, day("2026-08-01"));
  await store.upsertWellnessDay(ownerNew, day("2026-09-20"));
  await store.upsertWellnessWorkout(ownerNew, workout("old", Date.parse("2025-08-01T08:00:00Z")));
  await store.upsertWellnessWorkout(ownerNew, workout("new", Date.parse("2026-09-20T08:00:00Z")));
  await store.deleteExpiredDeviceData(NOW);
  result.cleanup = {
    nights: (await store.wellnessNights(a.id, "polar", "2000-01-01", "2100-01-01")).map(
      (row) => row.night_date,
    ),
    days: (await store.wellnessDays(a.id, "polar", "2000-01-01", "2100-01-01")).map((row) => [
      row.day_date,
      row.buckets_json === null,
    ]),
    workouts: (await store.wellnessWorkouts(a.id, "polar", 0, NOW * 2)).map(
      (row) => row.external_id,
    ),
    recentState: Boolean(await store.readDeviceConnectState("s2")),
  };
  await store.deleteExpiredDeviceData(NOW + 2 * 60 * 60 * 1000);
  result.cleanup.laterState = await store.readDeviceConnectState("s2");
  return result;
}

test("device storage behaves identically on SQLite and Turso", async () => {
  const { local, turso, close } = await stores();
  try {
    const localResult = await scenario(local, "local"),
      tursoResult = await scenario(turso, "turso");
    assert.deepEqual(tursoResult, localResult);
    const result = localResult;
    assert.equal(result.states.saved, true);
    assert.equal(result.states.unknownUser, false);
    assert.equal(result.states.read.used_at, null);
    assert.equal(result.states.wrongUser, null);
    assert.equal(
      result.states.wrongSession,
      null,
      "a connect state only completes in the sign-in that started it",
    );
    assert.deepEqual(
      { ...result.states.consumed },
      { provider: "polar", redirect_uri: "https://strata.test/api/devices/polar/callback" },
    );
    assert.equal(result.states.reused, null);
    assert.equal(result.states.expired, null);
    assert.equal(result.states.discarded, NOW + 5);
    assert.deepEqual(result.connection, {
      revision: 1,
      status: "active",
      syncedThrough: null,
      nextSyncAt: NOW + 600000,
      settings: { recoverySuggestions: true },
      duplicate: "unique",
      byProvider: true,
      ghost: null,
    });
    assert.deepEqual(result.token, {
      updated: true,
      stranger: false,
      value: ["sealed-rotated", NOW + DAY],
    });
    assert.deepEqual(
      result.wellness.nights,
      [
        ["2026-09-27", 5, 1.5, 61, 81, NOW + 1],
        ["2026-09-28", 4, 13.4, 61, 81, NOW],
      ],
      "a later partial read keeps values it does not include",
    );
    assert.equal(result.wellness.windowed, 1);
    assert.deepEqual(result.wellness.days, [["2026-09-28", 50, 48]]);
    assert.deepEqual(result.wellness.workouts, [["w1", 320, "Running"]]);
    assert.deepEqual(result.sync, {
      recorded: true,
      strangerRecorded: false,
      dueBefore: 0,
      marked: true,
      markedLater: false,
      due: [[true, NOW + 60000, "2026-09-28", NOW]],
      limited: 0,
    });
    assert.deepEqual(result.settings, {
      revision: 2,
      settings: { recoverySuggestions: false },
      stale: null,
    });
    assert.deepEqual(result.reconnect, {
      revision: 3,
      syncedThrough: "2026-09-28",
      settings: { recoverySuggestions: false },
      token: "sealed-new",
    });
    assert.deepEqual(result.exported, {
      connections: [
        "connected_at,consent_version,last_sync_at,provider,settings_json,status,synced_through",
      ],
      nights: 2,
      days: 1,
      workouts: 1,
      buckets: true,
    });
    assert.deepEqual(result.disconnect, {
      removed: { providerUserId: "111", token: "sealed-new" },
      again: null,
      connection: null,
      nights: 0,
      days: 0,
      workouts: 0,
    });
    assert.equal(result.replaced, null);
    assert.equal(result.accountDeletion.status, "deleted");
    assert.equal(result.accountDeletion.connection, null);
    assert.equal(result.accountDeletion.nights, 0);
    assert.equal(result.accountDeletion.state, null);
    assert.deepEqual(
      result.cleanup,
      {
        nights: ["2026-09-20"],
        days: [
          ["2026-08-01", true],
          ["2026-09-20", false],
        ],
        workouts: ["new"],
        recentState: true,
        laterState: null,
      },
      "connect states are kept for an hour after they expire",
    );
  } finally {
    await close();
  }
});
