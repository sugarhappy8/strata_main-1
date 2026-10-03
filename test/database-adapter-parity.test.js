"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");

function fakeTursoClientFactory(capture = () => {}) {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  capture(database);

  async function execute(statement) {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const args = typeof statement === "string" ? [] : statement.args || [];
    const prepared = database.prepare(sql);
    const returnsRows =
      /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (returnsRows) {
      const objectRows = prepared.all(...args);
      const columns = prepared.columns().map((column) => column.name);
      const rows = objectRows.map((row) => columns.map((column) => row[column]));
      const rowsAffected = Number(database.prepare("SELECT changes() AS count").get().count);
      return { columns, rows, rowsAffected };
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
        } catch {
          /* Preserve the statement failure. */
        }
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function stores() {
  mkdirSync(TEST_RUNTIME, { recursive: true });
  const localDirectory = mkdtempSync(join(TEST_RUNTIME, "adapter-parity-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  let local;
  let turso;
  let tursoDatabase;
  try {
    process.env.NODE_ENV = "test";
    process.env.STRATA_DATA_DIR = localDirectory;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    local = await createStore(PROJECT_ROOT);

    delete process.env.STRATA_DATA_DIR;
    process.env.TURSO_DATABASE_URL = "https://adapter-parity.invalid";
    process.env.TURSO_AUTH_TOKEN = "parity-test-token";
    turso = await createStore(PROJECT_ROOT, {
      tursoClientFactory: () =>
        fakeTursoClientFactory((database) => {
          tursoDatabase = database;
        }),
    });
  } finally {
    restoreEnvironment(previous);
  }
  return {
    local,
    turso,
    tursoDatabase,
    async close() {
      await Promise.all([local?.close(), turso?.close()]);
      rmSync(localDirectory, { recursive: true, force: true });
    },
  };
}

async function parityScenario(store) {
  const user = {
    id: "parity-user",
    name: "Parity User",
    email: "parity@example.test",
    passwordHash: "private-parity-hash",
    passwordSalt: "private-parity-salt",
    createdAt: 1_000,
    emailVerifiedAt: 1_000,
  };
  const insertUserResult = await store.insertUser(user);
  const insertedSession = await store.insertSession({
    tokenHash: "parity-session",
    userId: user.id,
    csrfToken: "private-parity-csrf",
    expiresAt: 10_000,
    createdAt: 1_100,
    authVersion: 1,
  });
  await store.insertSession({
    tokenHash: "expired-session",
    userId: user.id,
    csrfToken: "private-expired-csrf",
    expiresAt: 1_150,
    createdAt: 1_100,
    authVersion: 1,
  });
  const deleteExpiredResult = await store.deleteExpired(1_200);
  const activeSession = await store.session("parity-session", 1_200);
  const sessionAtExpiry = await store.session("parity-session", 10_000);
  const expiredSession = await store.session("expired-session", 1_200);
  await store.insertSession({
    tokenHash: "other-session-a",
    userId: user.id,
    csrfToken: "private-other-a",
    expiresAt: 10_000,
    createdAt: 1_101,
    authVersion: 1,
  });
  await store.insertSession({
    tokenHash: "other-session-b",
    userId: user.id,
    csrfToken: "private-other-b",
    expiresAt: 10_000,
    createdAt: 1_102,
    authVersion: 1,
  });
  const accountSessions = await store.accountSessions(user.id, "parity-session", 1_200);
  const currentSessionProtected = await store.revokeAccountSession(
    user.id,
    "parity-session",
    "parity-session",
    1_200,
  );
  const foreignSessionProtected = await store.revokeAccountSession(
    "not-the-owner",
    "other-session-a",
    "parity-session",
    1_200,
  );
  const revokedAccountSession = await store.revokeAccountSession(
    user.id,
    "other-session-a",
    "parity-session",
    1_200,
  );
  const revokedOtherAccountSessions = await store.revokeOtherAccountSessions(
    user.id,
    "parity-session",
    1_200,
  );
  const currentAccountSession = await store.session("parity-session", 1_200);

  const planJson = JSON.stringify({ version: 1, restDay: "Sunday", days: {} });
  const firstPlan = await store.upsertPlan(user.id, planJson, 1_300, 0);
  const stalePlan = await store.upsertPlan(user.id, JSON.stringify({ stale: true }), 1_301, 0);
  const monthlyResult = await store.upsertMonthlyPlan(user.id, JSON.stringify({ month: 1 }), 1_400);
  const preferencesResult = await store.upsertPreferences(
    user.id,
    JSON.stringify({ goal: "strength" }),
    1_500,
  );
  const setupPlanJson = JSON.stringify({
    version: 1,
    restDay: "Saturday",
    days: { Monday: [{ exerciseId: "setup" }] },
  });
  const setupPreferencesJson = JSON.stringify({ goal: "balanced", days: 1 });
  const setupResult = await store.saveTrainingSetup(
    user.id,
    setupPlanJson,
    setupPreferencesJson,
    1_200,
    1_300,
    1_500,
  );
  const staleSetup = await store.saveTrainingSetup(
    user.id,
    JSON.stringify({ staleSetup: true }),
    JSON.stringify({ goal: "stale" }),
    1_201,
    1_300,
    1_500,
  );
  const setupPlan = await store.plan(user.id),
    setupPreferences = await store.preferences(user.id);
  const ratingResult = await store.upsertRating(
    user.id,
    "parity-lift",
    {
      comfort: 5,
      pump: 4,
      enjoyment: 3,
      stability: 4,
      setup: 2,
      overall: 4,
    },
    1_600,
    1_600,
  );

  const verificationSendResult = await store.recordVerificationSend({
    id: "parity-send",
    emailHash: "parity-email-hash",
    challengeId: "parity-challenge",
    generation: 1,
    sentAt: 1_700,
  });
  const verificationSendCount = await store.countVerificationSends("parity-email-hash", 1_600);

  const pending = await store.insertPendingPurchase({
    transactionId: "txn_parity",
    userId: user.id,
    priceId: "pri_parity",
    productId: "pro_parity",
    paddleStatus: "ready",
    createdAt: 1_800,
    updatedAt: 1_800,
  });
  const completed = await store.completePurchase("txn_parity", {
    customerId: "ctm_original",
    completedAt: 1_900,
    updatedAt: 1_900,
  });
  const replayed = await store.completePurchase("txn_parity", {
    customerId: "ctm_replayed",
    completedAt: 2_000,
    updatedAt: 2_000,
  });
  const accountExport = await store.accountExport(user.id);
  await store.insertUser({
    id: "parity-subscription",
    name: "Subscription Parity",
    email: "subscription-parity@example.test",
    passwordHash: "subscription-parity-hash",
    passwordSalt: "subscription-parity-salt",
    createdAt: 2_051,
    emailVerifiedAt: 2_051,
  });
  const subscriptionPurchase = await store.insertPendingPurchase({
    transactionId: "txn_parity_subscription",
    userId: "parity-subscription",
    priceId: "pri_parity_monthly",
    productId: "pro_parity",
    paddleStatus: "ready",
    createdAt: 2_052,
    updatedAt: 2_052,
  });
  await store.completePurchase(subscriptionPurchase.transaction_id, {
    customerId: "ctm_parity_subscription",
    subscriptionId: "sub_parity_subscription",
    completedAt: 2_053,
    updatedAt: 2_053,
  });
  const createdSubscription = await store.createPaddleSubscription({
    subscriptionId: "sub_parity_subscription",
    userId: "parity-subscription",
    transactionId: "txn_parity_subscription",
    customerId: "ctm_parity_subscription",
    status: "active",
    priceId: "pri_parity_monthly",
    productId: "pro_parity",
    scheduledChangeAction: null,
    scheduledChangeAt: null,
    currentPeriodEndsAt: 9_000,
    eventOccurredAt: 2_054,
    createdAt: 2_054,
    updatedAt: 2_054,
  });
  const entitledCatalogAccess = await store.hasEntitledPaidDiscoveryAccess(
    "parity-subscription",
    "pri_parity_monthly",
    "pro_parity",
    8_999,
  );
  const entitledCatalogSummary = await store.entitledDiscoveryAccessSummary(
    "parity-subscription",
    "pri_parity_monthly",
    "pro_parity",
    8_999,
  );
  const otherCatalogAccess = await store.hasEntitledPaidDiscoveryAccess(
    "parity-subscription",
    "pri_parity_other",
    "pro_parity",
    8_999,
  );

  const revoked = await store.revokeUserSessions(user.id);
  const staleSessionAccepted = await store.insertSession({
    tokenHash: "stale-session",
    userId: user.id,
    csrfToken: "private-stale-csrf",
    expiresAt: 20_000,
    createdAt: 2_100,
    authVersion: 1,
  });
  const deleteSessionResult = await store.deleteSession("parity-session");

  await store.insertUser({
    id: "reset-user",
    name: "Reset User",
    email: "reset@example.test",
    passwordHash: "old-reset-hash",
    passwordSalt: "old-reset-salt",
    createdAt: 2_200,
    emailVerifiedAt: 2_200,
  });
  await store.insertSession({
    tokenHash: "reset-session",
    userId: "reset-user",
    csrfToken: "private-reset-csrf",
    expiresAt: 20_000,
    createdAt: 2_300,
    authVersion: 1,
  });
  await store.upsertAccountAction({
    requestId: "reset-request",
    userId: "reset-user",
    purpose: "password_reset",
    tokenHash: "reset-token-hash",
    expiresAt: 5_000,
    deliveryState: "sent",
    createdAt: 2_400,
    updatedAt: 2_400,
  });
  const resetCompleted = await store.completePasswordReset(
    "reset-token-hash",
    "new-reset-hash",
    "new-reset-salt",
    4_000,
  );
  const resetSessionAfter = await store.session("reset-session", 4_001);
  const resetActionAfter = await store.accountActionByTokenHash("reset-token-hash");
  const resetReplay = await store.completePasswordReset(
    "reset-token-hash",
    "replayed-hash",
    "replayed-salt",
    4_001,
  );
  const resetCredentials = await store.accountCredentialsById("reset-user");

  await store.insertUser({
    id: "expiry-user",
    name: "Expiry User",
    email: "expiry@example.test",
    passwordHash: "original-expiry-hash",
    passwordSalt: "original-expiry-salt",
    createdAt: 2_500,
    emailVerifiedAt: 2_500,
  });
  await store.insertSession({
    tokenHash: "expiry-session",
    userId: "expiry-user",
    csrfToken: "private-expiry-csrf",
    expiresAt: 20_000,
    createdAt: 2_600,
    authVersion: 1,
  });
  await store.upsertAccountAction({
    requestId: "expiry-request",
    userId: "expiry-user",
    purpose: "password_reset",
    tokenHash: "expiry-token-hash",
    expiresAt: 6_000,
    deliveryState: "sent",
    createdAt: 2_700,
    updatedAt: 2_700,
  });
  const resetAtExactExpiry = await store.completePasswordReset(
    "expiry-token-hash",
    "forbidden-hash",
    "forbidden-salt",
    6_000,
  );
  const expiryCredentials = await store.accountCredentialsById("expiry-user");
  const expirySessionAfter = await store.session("expiry-session", 6_000);

  const actor = (letter) => letter.repeat(64);
  const oldSignal = await store.recordProductSignal(
    "2026-06-09",
    "preview_generated",
    actor("a"),
    "member",
  );
  const firstSignal = await store.recordProductSignal(
    "2026-09-06",
    "preview_generated",
    actor("a"),
    "member",
  );
  const repeatedSignal = await store.recordProductSignal(
    "2026-09-06",
    "preview_generated",
    actor("a"),
    "member",
  );
  const anonymousSignal = await store.recordProductSignal(
    "2026-09-06",
    "preview_generated",
    actor("b"),
    "anonymous",
  );
  const workoutSignal = await store.recordProductSignal(
    "2026-09-07",
    "workout_started",
    actor("a"),
    "member",
  );
  const signalCounts = await store.productSignalCounts("2026-06-10", "2026-09-07");
  const deletedSignals = await store.deleteOldProductSignals("2026-06-10");
  const deletedSignalActors = await store.deleteProductSignalActors("2026-09-07");
  const recountedAfterCleanup = await store.recordProductSignal(
    "2026-09-07",
    "workout_started",
    actor("a"),
    "member",
  );
  const retainedSignalCounts = await store.productSignalCounts("2026-01-01", "2026-09-07");

  const deletionActor = {
    id: "parity-delete-actor",
    name: "Deletion Actor",
    email: "deletion-actor@example.test",
    passwordHash: "delete-actor-hash",
    passwordSalt: "delete-actor-salt",
    createdAt: 7_000,
    emailVerifiedAt: 7_000,
  };
  const deletionTarget = {
    id: "parity-delete-target",
    name: "Deletion Target",
    email: "deletion-target@example.test",
    passwordHash: "delete-target-hash",
    passwordSalt: "delete-target-salt",
    createdAt: 7_001,
    emailVerifiedAt: 7_001,
  };
  await store.insertUser(deletionActor);
  await store.insertUser(deletionTarget);
  await store.claimAdminPrincipal(deletionActor.id, deletionActor.email, 7_002);
  await store.insertSession({
    tokenHash: "parity-delete-admin-session",
    userId: deletionActor.id,
    csrfToken: "private-delete-admin-csrf",
    expiresAt: 20_000,
    createdAt: 7_002,
    authVersion: 2,
  });
  const activeAdminDelete = await store.deleteUserByAdmin(
    deletionTarget.id,
    7_002,
    deletionTarget.email,
    "delete-target-email-hash",
    "parity-delete-admin-session",
    {
      id: "parity-delete-audit-active",
      actorUserId: deletionActor.id,
      targetUserId: deletionTarget.id,
      action: "delete-account",
      reason: "Parity should reject an active account.",
      result: "success",
      createdAt: 7_002,
    },
  );
  await store.suspendUser(deletionTarget.id, 7_003);
  const adminDeleted = await store.deleteUserByAdmin(
    deletionTarget.id,
    7_004,
    deletionTarget.email,
    "delete-target-email-hash",
    "parity-delete-admin-session",
    {
      id: "parity-delete-audit",
      actorUserId: deletionActor.id,
      targetUserId: deletionTarget.id,
      action: "delete-account",
      reason: "Parity test permanent deletion.",
      result: "success",
      createdAt: 7_004,
    },
  );
  const deletionAudit = (await store.adminAudit(10)).find(
    (event) => event.id === "parity-delete-audit",
  );

  return {
    insertUserResult,
    insertedSession,
    deleteExpiredResult,
    activeSession,
    sessionAtExpiry,
    expiredSession,
    accountSessions,
    currentSessionProtected,
    foreignSessionProtected,
    revokedAccountSession,
    revokedOtherAccountSessions,
    currentAccountSession,
    firstPlan,
    stalePlan,
    monthlyResult,
    monthlyPlan: await store.monthlyPlan(user.id),
    preferencesResult,
    setupResult,
    staleSetup,
    setupPlan,
    setupPreferences,
    ratingResult,
    ratings: await store.ratingsForUser(user.id),
    verificationSendResult,
    verificationSendCount,
    pending,
    completed,
    replayed,
    accountExport,
    createdSubscription,
    entitledCatalogAccess,
    entitledCatalogSummary,
    otherCatalogAccess,
    paidAccess: await store.hasPaidDiscoveryAccess(user.id),
    revoked,
    staleSessionAccepted,
    deleteSessionResult,
    deletedSession: await store.session("parity-session", 2_200),
    resetCompleted,
    resetSessionAfter,
    resetActionAfter,
    resetReplay,
    resetCredentials,
    resetAtExactExpiry,
    expiryCredentials,
    expirySessionAfter,
    oldSignal,
    firstSignal,
    repeatedSignal,
    anonymousSignal,
    workoutSignal,
    signalCounts,
    deletedSignals,
    deletedSignalActors,
    recountedAfterCleanup,
    retainedSignalCounts,
    adminOverview: await store.adminOverview(8_000),
    activeAdminDelete,
    adminDeleted,
    adminDeletedUser: await store.userById(deletionTarget.id),
    deletionAudit,
  };
}

test(
  "SQLite and Turso adapters expose matching values, mutation results, and security state transitions",
  { concurrency: false },
  async () => {
    const fixture = await stores();
    try {
      assert.equal(fixture.local.kind, "local");
      assert.equal(fixture.turso.kind, "turso");
      const localResult = await parityScenario(fixture.local);
      const tursoResult = await parityScenario(fixture.turso);
      assert.deepEqual(tursoResult, localResult);
      for (const key of [
        "insertUserResult",
        "deleteExpiredResult",
        "monthlyResult",
        "preferencesResult",
        "ratingResult",
        "verificationSendResult",
        "deleteSessionResult",
      ])
        assert.equal(
          localResult[key],
          undefined,
          `${key} must have one documented void result across adapters`,
        );
      assert.equal(
        localResult.replayed,
        null,
        "a provider completion cannot replace the durable customer identity",
      );
      assert.deepEqual(
        Object.keys(localResult.adminOverview).sort(),
        [
          "active_sessions",
          "day_eight_return_users",
          "discovery_users",
          "first_workout_users",
          "open_support",
          "paid_users",
          "pending_deletions",
          "pending_payments",
          "renewed_subscriptions",
          "second_workout_users",
          "suspended_users",
          "total_users",
          "verified_users",
        ].sort(),
        "the shared owner-overview contract must expose the same activation metrics through both adapters",
      );
      assert.equal(localResult.completed.customer_id, "ctm_original");
      assert.equal(localResult.completed.completed_at, 1_900);
      assert.equal(localResult.createdSubscription.price_id, "pri_parity_monthly");
      assert.equal(localResult.entitledCatalogAccess, true);
      assert.equal(localResult.entitledCatalogSummary.activePurchaseCount, 1);
      assert.equal(localResult.otherCatalogAccess, false, "only the configured price is entitled");
      assert.equal(localResult.activeSession.expires_at, 10_000);
      assert.equal(
        localResult.sessionAtExpiry,
        null,
        "sessions must expire at the exact stored boundary",
      );
      assert.deepEqual(
        localResult.accountSessions.map(({ token_hash, created_at, expires_at }) => ({
          token_hash,
          created_at,
          expires_at,
        })),
        [
          { token_hash: "parity-session", created_at: 1_100, expires_at: 10_000 },
          { token_hash: "other-session-b", created_at: 1_102, expires_at: 10_000 },
          { token_hash: "other-session-a", created_at: 1_101, expires_at: 10_000 },
        ],
      );
      assert.equal(
        localResult.currentSessionProtected,
        false,
        "self-service cannot revoke the current session",
      );
      assert.equal(
        localResult.foreignSessionProtected,
        false,
        "self-service cannot revoke another user's session",
      );
      assert.equal(localResult.revokedAccountSession, true);
      assert.equal(localResult.revokedOtherAccountSessions, 1);
      assert.ok(
        localResult.currentAccountSession,
        "bulk revocation must preserve the current session",
      );
      const serializedExport = JSON.stringify(localResult.accountExport);
      assert.doesNotMatch(
        serializedExport,
        /private-|password_hash|password_salt|token_hash|csrf_token|customer_id|admin_note|ip_hash/i,
      );
      assert.equal(localResult.accountExport.profile.id, "parity-user");
      assert.equal(localResult.accountExport.ratings[0].exercise_id, "parity-lift");
      assert.equal(localResult.accountExport.purchases[0].transaction_id, "txn_parity");
      assert.equal(localResult.revoked.revoked, 1);
      assert.equal(localResult.staleSessionAccepted, false);
      assert.equal(localResult.resetCompleted.auth_version, 2);
      assert.equal(
        localResult.resetSessionAfter,
        null,
        "password reset must revoke every prior session",
      );
      assert.equal(
        localResult.resetActionAfter,
        null,
        "a consumed reset token must not remain reusable",
      );
      assert.equal(localResult.resetReplay, null, "password reset must be one-time");
      assert.equal(localResult.resetCredentials.password_hash, "new-reset-hash");
      assert.equal(
        localResult.resetAtExactExpiry,
        null,
        "reset tokens must expire at the exact stored boundary",
      );
      assert.equal(localResult.expiryCredentials.password_hash, "original-expiry-hash");
      assert.ok(
        localResult.expirySessionAfter,
        "an expired reset attempt must not revoke an otherwise valid session",
      );
      assert.equal(
        localResult.setupResult.updated_at,
        1_501,
        "the joint revision must advance past both stored timestamps after clock rollback",
      );
      assert.equal(localResult.setupResult.preferences_updated_at, 1_501);
      assert.equal(
        localResult.staleSetup,
        null,
        "stale setup revisions must not partially update either record",
      );
      assert.equal(
        localResult.setupPlan.plan_json,
        JSON.stringify({
          version: 1,
          restDay: "Saturday",
          days: { Monday: [{ exerciseId: "setup" }] },
        }),
      );
      assert.equal(
        localResult.setupPreferences.preferences_json,
        JSON.stringify({ goal: "balanced", days: 1 }),
      );
      assert.deepEqual(
        [
          localResult.oldSignal,
          localResult.firstSignal,
          localResult.repeatedSignal,
          localResult.anonymousSignal,
          localResult.workoutSignal,
        ],
        [true, true, false, true, true],
        "a daily key counts once",
      );
      assert.deepEqual(localResult.signalCounts, [
        {
          event_day: "2026-09-06",
          event_name: "preview_generated",
          event_count: 2,
          member_count: 1,
          anonymous_count: 1,
        },
        {
          event_day: "2026-09-07",
          event_name: "workout_started",
          event_count: 1,
          member_count: 1,
          anonymous_count: 0,
        },
      ]);
      assert.equal(localResult.deletedSignals, 1);
      assert.equal(
        localResult.deletedSignalActors,
        3,
        "daily keys from before the given day are removed",
      );
      assert.equal(localResult.recountedAfterCleanup, false, "the current day's keys are kept");
      assert.deepEqual(localResult.retainedSignalCounts, localResult.signalCounts);
      assert.equal(
        localResult.activeAdminDelete,
        null,
        "an active account cannot be deleted directly by Admin",
      );
      assert.equal(localResult.adminDeleted.id, "parity-delete-target");
      assert.equal(localResult.adminDeletedUser, null);
      assert.equal(localResult.deletionAudit.target_user_id, "parity-delete-target");
      assert.equal(
        localResult.deletionAudit.target_id,
        null,
        "the audit keeps only the deleted account identifier",
      );
    } finally {
      await fixture.close();
    }
  },
);

test("SQLite and Turso grants and payment holds enforce a live bound-owner session, revision, audit and billing isolation", async () => {
  const pair = await stores();
  try {
    for (const store of [pair.local, pair.turso]) {
      const now = Date.UTC(2026, 8, 10),
        actor = "grant-owner",
        target = "grant-member",
        token = "grant-owner-session";
      for (const id of [actor, target])
        await store.insertUser({
          id,
          name: id,
          email: `${id}@example.test`,
          passwordHash: "hash",
          passwordSalt: "salt",
          createdAt: now,
          emailVerifiedAt: now,
        });
      await store.claimAdminPrincipal(actor, `${actor}@example.test`, now);
      const base = {
        id: "grant-audit",
        actorUserId: actor,
        targetUserId: target,
        action: "grant-plus",
        reason: "Complimentary membership",
        result: "success",
        createdAt: now,
      };
      const row = {
        grant_starts_at: now,
        grant_expires_at: now + 60000,
        grant_revoked_at: null,
        checkout_blocked_at: null,
      };
      assert.equal(
        await store.writeAdminControls(target, row, 0, token, base),
        null,
        "a live owner session is mandatory at commit",
      );
      await store.insertSession({
        tokenHash: token,
        userId: actor,
        csrfToken: "csrf",
        expiresAt: now + 100000,
        createdAt: now,
        authVersion: 2,
      });
      assert.equal(
        (
          await store.writeAdminControls(actor, row, 0, token, {
            ...base,
            id: "owner-gift",
            targetUserId: actor,
          })
        ).revision,
        1,
        "owner may grant complimentary access to their own account",
      );
      const saved = await store.writeAdminControls(target, row, 0, token, base);
      assert.equal(saved.revision, 1);
      assert.equal(await store.hasDiscoveryAccess(target, null, now), true);
      assert.equal(await store.hasDiscoveryAccess(target, null, now + 60000), false);
      assert.equal(await store.hasPaidDiscoveryAccess(target, null, now), false);
      assert.equal((await store.accountExport(target)).grants.length, 1);
      assert.equal(
        await store.writeAdminControls(target, row, 0, token, { ...base, id: "stale" }),
        null,
      );
      await assert.rejects(
        store.writeAdminControls(target, { ...row, grant_expires_at: null }, 1, token, base),
        /UNIQUE/,
      );
      assert.equal(
        (await store.adminControls(target)).revision,
        1,
        "duplicate audit rolls mutation back",
      );
      const held = await store.writeAdminControls(
        target,
        { ...row, grant_expires_at: null, checkout_blocked_at: now },
        1,
        token,
        { ...base, id: "held", action: "close-checkouts" },
      );
      assert.equal(held.revision, 2);
      assert.equal(
        await store.claimCheckoutCreation({
          userId: target,
          priceId: "price",
          claimId: "held-claim",
          expiresAt: now + 10000,
          now,
        }),
        null,
      );
      const purchase = {
        transactionId: "txn_grant_held",
        userId: target,
        priceId: "price",
        productId: "product",
        paddleStatus: "ready",
        createdAt: now,
        updatedAt: now,
      };
      assert.equal(
        await store.insertPendingPurchase(purchase),
        null,
        "hold also blocks direct insertion",
      );
      assert.equal(
        await store.recordClaimedPurchase(purchase, "invented-claim"),
        null,
        "recovery requires the matching durable claim",
      );
      await store.writeAdminControls(target, { ...held, checkout_blocked_at: null }, 2, token, {
        ...base,
        id: "enable",
        action: "enable-checkouts",
      });
      await store.claimCheckoutCreation({
        userId: target,
        priceId: "price",
        claimId: "real-claim",
        expiresAt: now + 10000,
        now,
      });
      await store.recordCheckoutCreationTransaction(
        target,
        "real-claim",
        purchase.transactionId,
        now,
      );
      await store.writeAdminControls(target, { ...held, grant_revoked_at: now }, 3, token, {
        ...base,
        id: "revoke",
        action: "revoke-plus",
      });
      assert.equal(await store.hasDiscoveryAccess(target, null, now), false);
      assert.equal(
        (await store.recordClaimedPurchase(purchase, "real-claim")).transaction_id,
        purchase.transactionId,
        "hold cannot prevent recording already accepted provider work",
      );
      await store.deleteSession(token);
      assert.equal(
        await store.writeAdminControls(target, row, 4, token, { ...base, id: "expired" }),
        null,
      );
      assert.equal((await store.adminControls(target)).revision, 4);
      const expiredToken = `${token}-expired`;
      await store.insertSession({
        tokenHash: expiredToken,
        userId: actor,
        csrfToken: "csrf-expired",
        expiresAt: now + 200000,
        createdAt: now + 100000,
        authVersion: 2,
      });
      assert.equal(
        await store.writeAdminControls(target, row, 4, expiredToken, {
          ...base,
          id: "expired-by-time",
          createdAt: now + 200000,
        }),
        null,
        "an expired owner session must fail at the storage boundary",
      );
      assert.equal((await store.adminControls(target)).revision, 4);
    }
  } finally {
    await pair.close();
  }
});

test(
  "Turso account deletion explicitly removes administrator controls when foreign keys are unavailable",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      const store = pair.turso,
        database = pair.tursoDatabase,
        now = Date.UTC(2026, 8, 10),
        actor = "delete-controls-owner",
        token = "delete-controls-session";
      const directTarget = "delete-controls-direct",
        selfTarget = "delete-controls-self";
      for (const id of [actor, directTarget, selfTarget])
        await store.insertUser({
          id,
          name: id,
          email: `${id}@example.test`,
          passwordHash: "hash",
          passwordSalt: "salt",
          createdAt: now,
          emailVerifiedAt: now,
        });
      await store.claimAdminPrincipal(actor, `${actor}@example.test`, now);
      await store.insertSession({
        tokenHash: token,
        userId: actor,
        csrfToken: "csrf",
        expiresAt: now + 100000,
        createdAt: now,
        authVersion: 2,
      });
      for (const [index, target] of [directTarget, selfTarget].entries()) {
        const row = {
          grant_starts_at: now,
          grant_expires_at: now + 60000,
          grant_revoked_at: null,
          checkout_blocked_at: now,
        };
        const audit = {
          id: `delete-controls-grant-${index}`,
          actorUserId: actor,
          targetUserId: target,
          action: "grant-plus",
          reason: "Deletion cleanup regression fixture",
          result: "success",
          createdAt: now + index,
        };
        assert.ok(await store.writeAdminControls(target, row, 0, token, audit));
      }
      database.exec("PRAGMA foreign_keys=OFF");
      await store.suspendUser(directTarget, now + 10);
      const deleted = await store.deleteUserByAdmin(
        directTarget,
        now + 11,
        `${directTarget}@example.test`,
        "direct-email-hash",
        token,
        {
          id: "delete-controls-direct-audit",
          actorUserId: actor,
          targetUserId: directTarget,
          action: "delete-account",
          reason: "Verify explicit controls cleanup",
          result: "success",
          createdAt: now + 11,
        },
      );
      assert.equal(deleted.id, directTarget);
      assert.equal(await store.adminControls(directTarget), null);
      const action = await store.upsertAccountAction({
        requestId: "delete-controls-self-request",
        userId: selfTarget,
        purpose: "account_delete",
        tokenHash: "delete-controls-self-token",
        expiresAt: now + 60000,
        deliveryState: "sent",
        createdAt: now + 20,
        updatedAt: now + 20,
      });
      assert.equal(
        (await store.deleteAccount(action.token_hash, now + 21, "self-email-hash")).status,
        "deleted",
      );
      assert.equal(await store.adminControls(selfTarget), null);
    } finally {
      await pair.close();
    }
  },
);

// In-app deletion (no emailed token) consumes an internal account_delete action through the same deletion path as an
// emailed link. Both adapters must delete the same accounts, refuse the same ones, keep a live emailed link when they
// refuse, and leave no internal action behind.
async function inAppDeletionScenario(store) {
  const now = Date.UTC(2026, 8, 20),
    summary = {};
  const account = async (id) => {
    await store.insertUser({
      id,
      name: id,
      email: `${id}@example.test`,
      passwordHash: "hash",
      passwordSalt: "salt",
      createdAt: now,
      emailVerifiedAt: now,
    });
    await store.insertSession({
      tokenHash: `${id}-session`,
      userId: id,
      csrfToken: `${id}-csrf`,
      expiresAt: now + 100_000,
      createdAt: now,
      authVersion: 1,
    });
  };
  const link = (id, tokenHash) =>
    store.upsertAccountAction({
      requestId: `${id}-request`,
      userId: id,
      purpose: "account_delete",
      tokenHash,
      expiresAt: now + 60_000,
      deliveryState: "sent",
      createdAt: now,
      updatedAt: now,
    });
  const pending = (id) =>
    store.insertPendingPurchase({
      transactionId: `txn_${id}`,
      userId: id,
      priceId: "price",
      productId: "product",
      paddleStatus: "ready",
      createdAt: now,
      updatedAt: now,
    });
  const state = async (id, internal) => ({
    user: Boolean(await store.userById(id)),
    session: Boolean(await store.session(`${id}-session`, now + 5)),
    link: (await store.accountActionForUser(id, "account_delete"))?.token_hash || null,
    internal: Boolean(await store.accountActionByTokenHash(internal)),
  });

  await account("in-app-plain");
  summary.plain = await store.deleteAccountForUser(
    "in-app-plain",
    "internal-plain",
    now + 1,
    "plain-hash",
  );
  summary.plainAfter = await state("in-app-plain", "internal-plain");

  await account("in-app-linked");
  await link("in-app-linked", "emailed-linked");
  summary.linked = (
    await store.deleteAccountForUser("in-app-linked", "internal-linked", now + 2, "linked-hash")
  ).status;
  summary.linkedAfter = await state("in-app-linked", "internal-linked");

  await account("in-app-refused");
  await pending("in-app-refused");
  await link("in-app-refused", "emailed-refused");
  summary.refused = await store.deleteAccountForUser(
    "in-app-refused",
    "internal-refused",
    now + 3,
    "refused-hash",
  );
  summary.refusedAfter = await state("in-app-refused", "internal-refused");

  await account("in-app-unlinked");
  await pending("in-app-unlinked");
  summary.unlinked = await store.deleteAccountForUser(
    "in-app-unlinked",
    "internal-unlinked",
    now + 4,
    "unlinked-hash",
  );
  summary.unlinkedAfter = await state("in-app-unlinked", "internal-unlinked");
  return summary;
}

test(
  "SQLite and Turso delete an account in the app through the emailed-link deletion path",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      const local = await inAppDeletionScenario(pair.local),
        turso = await inAppDeletionScenario(pair.turso);
      assert.deepEqual(turso, local);
      assert.deepEqual(local, {
        plain: {
          status: "deleted",
          user: { id: "in-app-plain", email: "in-app-plain@example.test" },
        },
        plainAfter: { user: false, session: false, link: null, internal: false },
        linked: "deleted",
        linkedAfter: { user: false, session: false, link: null, internal: false },
        refused: { status: "purchase_pending" },
        refusedAfter: { user: true, session: true, link: "emailed-refused", internal: false },
        unlinked: { status: "purchase_pending" },
        unlinkedAfter: { user: true, session: true, link: null, internal: false },
      });
    } finally {
      await pair.close();
    }
  },
);
