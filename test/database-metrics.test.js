"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { createStore } = require("../src/database");
const { fakeTursoFactory, workoutFixture } = require("./support/workout-fixtures");

const ROOT = join(__dirname, ".."),
  RUNTIME = join(ROOT, "test-runtime");
const DAY = 24 * 60 * 60 * 1000;

async function stores() {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, "metrics-parity-"));
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
  process.env.TURSO_DATABASE_URL = "https://metrics-parity.invalid";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  const turso = await createStore(ROOT, { tursoClientFactory: fakeTursoFactory() });
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

function user(id, email, createdAt) {
  return {
    id,
    name: id,
    email,
    passwordHash: "hash",
    passwordSalt: "salt",
    createdAt,
    emailVerifiedAt: createdAt,
  };
}

async function scenario(store) {
  const now = Date.parse("2026-10-03T12:00:00Z"),
    since = Date.parse("2026-07-13T00:00:00Z");
  await store.insertUser(user("owner", "Owner@Example.test", since + DAY));
  await store.insertUser(user("member", "member@example.test", since + 2 * DAY));
  await store.createSocialAccount(
    { id: "google-member", name: "G", email: "g@example.test", createdAt: since + 3 * DAY },
    {
      provider: "google",
      subject: "subject-1",
      userId: "google-member",
      email: "g@example.test",
      at: since + 3 * DAY,
    },
  );
  // Linked later to an email account: still an email sign-up.
  await store.insertUser(user("linked", "linked@example.test", since + 4 * DAY));
  await store.linkAccountIdentity({
    provider: "google",
    subject: "subject-2",
    userId: "linked",
    email: "linked@example.test",
    at: since + 9 * DAY,
  });

  await store.recordFullWeek("member", since + 5 * DAY);
  await store.recordFullWeek("member", since + 3 * DAY);
  await store.recordFullWeek("member", since + 8 * DAY);
  await store.recordFullWeek("nobody", since);

  const workout = {
    ...workoutFixture("w-1"),
    status: "completed",
    startedAt: since + 10 * DAY + 3600_000,
    completedAt: since + 10 * DAY + 7200_000,
  };
  await store.insertWorkout({
    id: "w-1",
    userId: "member",
    workoutJson: JSON.stringify(workout),
    summaryJson: JSON.stringify({ status: "active" }),
    createHash: "hash-1",
    startedAt: workout.startedAt,
    updatedAt: workout.startedAt,
  });
  await store.insertWorkout({
    id: "w-old",
    userId: "member",
    workoutJson: JSON.stringify({ ...workoutFixture("w-old"), startedAt: since - DAY }),
    summaryJson: JSON.stringify({ status: "active" }),
    createHash: "hash-old",
    startedAt: since - DAY,
    updatedAt: since - DAY,
  });
  await store.upsertWorkoutCheckIn({
    userId: "member",
    workoutId: "w-1",
    difficulty: 3,
    energy: 3,
    comfort: 3,
    enjoyment: 3,
    createdAt: since + 11 * DAY,
    updatedAt: since + 11 * DAY,
  });
  await store.insertPlanChange("google-member", {
    planUpdatedAt: since + 3 * DAY,
    source: "manual",
    detail: "plan-edit",
    createdAt: since + 3 * DAY + 60_000,
  });
  await store.addAiUsage("2026-09-01", "member", "chat", 3, 1200);
  await store.addAiUsage("2026-09-02", "member", "brief", 1, 800);
  await store.addAiUsage("2026-09-01", "global", "chat", 3, 1200);
  await store.addAiUsage("2026-06-01", "member", "chat", 1, 50);
  const apple = (originalTransactionId, environment) => ({
    originalTransactionId,
    userId: "member",
    productId: "online.stratafitness.app.plus.monthly",
    environment,
    latestTransactionId: `${originalTransactionId}-latest`,
    purchasedAt: since + 20 * DAY,
    originalPurchasedAt: since + 15 * DAY,
    expiresAt: now + 10 * DAY,
    revokedAt: null,
    revocationReason: null,
    autoRenew: true,
    gracePeriodExpiresAt: now + 20 * DAY,
    lastSignedAt: since + 20 * DAY,
    latestSignedAt: since + 20 * DAY,
    createdAt: since + 15 * DAY,
    updatedAt: since + 20 * DAY,
  });
  await store.upsertAppleSubscription(apple("apple-production", "Production"));
  await store.upsertAppleSubscription(apple("apple-sandbox", "Sandbox"));

  const rows = await store.investorMetricsRows(since, ["owner@example.test"]);
  const milestone = await store.accountMilestone("member");
  const exported = await store.accountExport("member");
  return {
    accounts: rows.accounts
      .map((row) => ({ ...row }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    activeDays: rows.activeDays
      .map((row) => ({ ...row }))
      .sort((left, right) => left.day - right.day || left.user_id.localeCompare(right.user_id)),
    apple: rows.apple.map((row) => ({ ...row })),
    paddle: rows.paddle,
    lifetime: rows.lifetime,
    aiUsage: rows.aiUsage.map((row) => ({ ...row })),
    activationRecorded: typeof rows.activationSince === "number" && rows.activationSince > 0,
    milestone: { ...milestone },
    exportedMilestone: exported.milestones ? { ...exported.milestones } : null,
  };
}

test(
  "SQLite and Turso read the same investor-metrics rows and keep the earliest full week",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      const local = await scenario(pair.local),
        turso = await scenario(pair.turso);
      assert.deepEqual(turso, local);
      const since = Date.parse("2026-07-13T00:00:00Z");
      assert.deepEqual(local.accounts, [
        {
          id: "google-member",
          created_at: since + 3 * DAY,
          first_full_week_at: null,
          method: "google",
          internal: 0,
        },
        {
          id: "linked",
          created_at: since + 4 * DAY,
          first_full_week_at: null,
          method: "email",
          internal: 0,
        },
        {
          id: "member",
          created_at: since + 2 * DAY,
          first_full_week_at: since + 3 * DAY,
          method: "email",
          internal: 0,
        },
        {
          id: "owner",
          created_at: since + DAY,
          first_full_week_at: null,
          method: "email",
          internal: 1,
        },
      ]);
      const sinceDay = since / DAY;
      assert.deepEqual(local.activeDays, [
        { user_id: "google-member", day: sinceDay + 3, plus: 0 },
        { user_id: "member", day: sinceDay + 10, plus: 1 },
        { user_id: "member", day: sinceDay + 11, plus: 1 },
        { user_id: "member", day: Date.parse("2026-09-01") / DAY, plus: 1 },
      ]);
      assert.deepEqual(
        local.apple.map((row) => row.ends_at - Date.parse("2026-10-03T12:00:00Z")),
        [20 * DAY],
        "only the Production subscription counts, and it pays until its grace period ends",
      );
      assert.deepEqual(local.paddle, []);
      assert.deepEqual(local.lifetime, []);
      assert.deepEqual(local.aiUsage, [
        { user_id: "member", month: "2026-09", requests: 4, tokens: 2000 },
      ]);
      assert.equal(local.activationRecorded, true);
      assert.deepEqual(local.milestone, { first_full_week_at: since + 3 * DAY });
      assert.deepEqual(local.exportedMilestone, { first_full_week_at: since + 3 * DAY });
    } finally {
      await pair.close();
    }
  },
);
