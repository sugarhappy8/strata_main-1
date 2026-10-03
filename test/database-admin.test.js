"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");
const PRICE_ID = "pri_admin_database_test";
const PRODUCT_ID = "pro_admin_database_test";

function testDirectory(prefix) {
  mkdirSync(TEST_RUNTIME, { recursive: true });
  return mkdtempSync(join(TEST_RUNTIME, prefix));
}

function restoreEnvironment(previous) {
  if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous.nodeEnv;
  if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
  else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
  if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
  else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
  if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
  else process.env.STRATA_DATA_DIR = previous.dataDir;
}

async function fixture(prefix) {
  const root = testDirectory(prefix);
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    tursoToken: process.env.TURSO_AUTH_TOKEN,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  return {
    root,
    store,
    async close() {
      await store.close();
      restoreEnvironment(previous);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function user(id, createdAt, overrides = {}) {
  return {
    id,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    passwordHash: `private-password-hash-${id}`,
    passwordSalt: `private-password-salt-${id}`,
    createdAt,
    emailVerifiedAt: createdAt,
    ...overrides,
  };
}

function session(tokenHash, userId, createdAt, authVersion = 1, overrides = {}) {
  return {
    tokenHash,
    userId,
    csrfToken: `private-csrf-${tokenHash}`,
    expiresAt: createdAt + 60 * 60 * 1000,
    createdAt,
    authVersion,
    ...overrides,
  };
}

function pendingPurchase(transactionId, userId, createdAt, status = "ready") {
  return {
    transactionId,
    userId,
    priceId: PRICE_ID,
    productId: PRODUCT_ID,
    paddleStatus: status,
    createdAt,
    updatedAt: createdAt,
  };
}

function completedWorkoutRecord(userId, id, startedAt) {
  const summary = {
    id,
    title: `Workout ${id}`,
    planDay: "Monday",
    date: "2026-01-01",
    status: "completed",
    startedAt,
    completedAt: startedAt + 1000,
    elapsedSeconds: 1000,
    totalSets: 1,
    completedSets: 1,
    exerciseCount: 1,
    exerciseSummaries: [],
  };
  return {
    userId,
    id,
    workoutJson: JSON.stringify({ ...summary, entries: [{ id: `entry-${id}`, sets: [] }] }),
    summaryJson: JSON.stringify(summary),
    createHash: `create-${id}`,
    startedAt,
    updatedAt: startedAt + 1000,
  };
}

function accountAction(requestId, userId, purpose, createdAt) {
  return {
    requestId,
    userId,
    purpose,
    tokenHash: `private-action-token-${requestId}`,
    expiresAt: createdAt + 30 * 60 * 1000,
    deliveryState: "sent",
    createdAt,
    updatedAt: createdAt,
  };
}

function supportTicket(id, userId, createdAt, overrides = {}) {
  return {
    id,
    reference: `STR-2026-${id.toUpperCase()}`,
    userId,
    name: `Support ${id}`,
    email: `${id}@example.test`,
    category: "account",
    subject: `Question ${id}`,
    referenceId: null,
    message: `This is a long enough support request for ${id}.`,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function inspectDatabase(root, callback) {
  const db = new DatabaseSync(join(root, "strata.sqlite"), { enableForeignKeyConstraints: true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function createPopulated675Database(root, now) {
  const db = new DatabaseSync(join(root, "strata.sqlite"), { enableForeignKeyConstraints: true });
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        email_verified_at INTEGER,
        auth_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        auth_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE signup_verifications (
        challenge_id TEXT PRIMARY KEY,
        browser_token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'signup' CHECK(purpose IN ('signup','login')),
        email TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        code_digest TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>=1),
        attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used>=0),
        send_count INTEGER NOT NULL DEFAULT 0 CHECK(send_count>=0),
        last_sent_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hard_expires_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(expires_at<=hard_expires_at)
      );
      CREATE TABLE email_verification_sends (
        send_id TEXT PRIMARY KEY,
        email_hash TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>=1),
        sent_at INTEGER NOT NULL
      );
      CREATE TABLE account_action_requests (
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id,purpose)
      );
      CREATE TABLE account_action_deliveries (
        request_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE account_action_sends (
        send_id TEXT PRIMARY KEY,
        email_hash TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('password_reset','account_delete')),
        sent_at INTEGER NOT NULL
      );
      CREATE TABLE plans (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        plan_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        preferences_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ratings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        exercise_id TEXT NOT NULL,
        comfort INTEGER NOT NULL CHECK(comfort BETWEEN 1 AND 5),
        pump INTEGER NOT NULL CHECK(pump BETWEEN 1 AND 5),
        enjoyment INTEGER NOT NULL CHECK(enjoyment BETWEEN 1 AND 5),
        stability INTEGER NOT NULL CHECK(stability BETWEEN 1 AND 5),
        setup INTEGER NOT NULL CHECK(setup BETWEEN 1 AND 5),
        overall INTEGER NOT NULL CHECK(overall BETWEEN 1 AND 5),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,exercise_id)
      );
      CREATE TABLE paddle_purchases (
        transaction_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        price_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        customer_id TEXT,
        paddle_status TEXT NOT NULL,
        completed_at INTEGER,
        access_revoked_at INTEGER,
        revocation_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE paddle_adjustments (
        adjustment_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES paddle_purchases(transaction_id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        type TEXT,
        status TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE paddle_webhook_events (
        event_id TEXT PRIMARY KEY,
        notification_id TEXT,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        processed_at INTEGER NOT NULL
      );`);

    db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)").run(
      "legacy-675-user",
      "Legacy 6.7.5",
      "legacy-675@example.test",
      "legacy-675-hash",
      "legacy-675-salt",
      now,
      now,
      7,
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(
      "legacy-675-session",
      "legacy-675-user",
      "legacy-675-csrf",
      now + 60 * 60 * 1000,
      now,
      7,
    );
    db.prepare(
      "INSERT INTO signup_verifications VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "legacy-675-challenge",
      "legacy-675-browser",
      "legacy-675-user",
      "login",
      "legacy-675@example.test",
      "Legacy 6.7.5",
      "",
      "",
      "legacy-675-code-digest",
      2,
      1,
      2,
      now,
      now + 10 * 60 * 1000,
      now + 24 * 60 * 60 * 1000,
      "sent",
      null,
      now,
      now,
    );
    db.prepare("INSERT INTO email_verification_sends VALUES(?,?,?,?,?)").run(
      "legacy-675-verification-send",
      "legacy-675-email-hash",
      "legacy-675-challenge",
      2,
      now,
    );
    db.prepare("INSERT INTO account_action_requests VALUES(?,?,?,?,?,?,?,?,?)").run(
      "legacy-675-reset",
      "legacy-675-user",
      "password_reset",
      "legacy-675-reset-token",
      now + 30 * 60 * 1000,
      "sent",
      null,
      now,
      now,
    );
    db.prepare("INSERT INTO account_action_deliveries VALUES(?,?,?,?,?,?)").run(
      "legacy-675-delete-stage",
      "legacy-675-user",
      "account_delete",
      "legacy-675-delete-token",
      now + 30 * 60 * 1000,
      now,
    );
    db.prepare("INSERT INTO account_action_sends VALUES(?,?,?,?)").run(
      "legacy-675-action-send",
      "legacy-675-email-hash",
      "password_reset",
      now,
    );
    db.prepare("INSERT INTO plans VALUES(?,?,?)").run(
      "legacy-675-user",
      JSON.stringify({ days: ["legacy-day"] }),
      now,
    );
    db.prepare("INSERT INTO preferences VALUES(?,?,?)").run(
      "legacy-675-user",
      JSON.stringify({ units: "metric" }),
      now,
    );
    db.prepare("INSERT INTO ratings VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "legacy-675-user",
      "legacy-lift",
      5,
      4,
      5,
      4,
      3,
      5,
      now,
      now,
    );
    db.prepare("INSERT INTO paddle_purchases VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      "legacy-675-transaction",
      "legacy-675-user",
      PRICE_ID,
      PRODUCT_ID,
      "legacy-675-customer",
      "completed",
      now,
      null,
      null,
      now,
      now,
    );
    db.prepare("INSERT INTO paddle_adjustments VALUES(?,?,?,?,?,?,?)").run(
      "legacy-675-adjustment",
      "legacy-675-transaction",
      "refund",
      "partial",
      "rejected",
      now,
      now,
    );
    db.prepare("INSERT INTO paddle_webhook_events VALUES(?,?,?,?,?)").run(
      "legacy-675-event",
      "legacy-675-notification",
      "transaction.completed",
      now,
      now,
    );
  } finally {
    db.close();
  }
}

test(
  "a populated 6.7.5 database receives an additive, idempotent admin migration",
  { concurrency: false },
  async () => {
    const root = testDirectory("admin-migration-675-");
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      tursoUrl: process.env.TURSO_DATABASE_URL,
      tursoToken: process.env.TURSO_AUTH_TOKEN,
      dataDir: process.env.STRATA_DATA_DIR,
    };
    process.env.NODE_ENV = "test";
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.STRATA_DATA_DIR = root;
    const now = 1_810_500_000_000;
    let store;
    try {
      createPopulated675Database(root, now);
      store = await createStore(root);

      const migrated = await store.userByEmail("legacy-675@example.test");
      assert.equal(migrated.id, "legacy-675-user");
      assert.equal(migrated.password_hash, "legacy-675-hash");
      assert.equal(migrated.password_salt, "legacy-675-salt");
      assert.equal(migrated.auth_version, 7);
      assert.equal(migrated.suspended_at, null);
      assert.equal(
        (await store.session("legacy-675-session", now + 1)).csrf_token,
        "legacy-675-csrf",
      );
      assert.deepEqual(JSON.parse((await store.plan(migrated.id)).plan_json), {
        days: ["legacy-day"],
      });
      assert.deepEqual(JSON.parse((await store.preferences(migrated.id)).preferences_json), {
        units: "metric",
      });
      assert.equal((await store.ratingsForUser(migrated.id))[0].exercise_id, "legacy-lift");
      assert.equal(await store.hasDiscoveryAccess(migrated.id, PRICE_ID), true);
      assert.equal((await store.adjustmentById("legacy-675-adjustment")).status, "rejected");
      assert.equal(
        (await store.webhookEvent("legacy-675-event")).notification_id,
        "legacy-675-notification",
      );
      assert.equal(
        (await store.verificationByTokenHash("legacy-675-browser")).code_digest,
        "legacy-675-code-digest",
      );
      assert.equal(
        (await store.accountActionByTokenHash("legacy-675-reset-token")).request_id,
        "legacy-675-reset",
      );
      assert.equal(await store.adminPrincipal(), null);
      assert.deepEqual(await store.adminAudit(10), []);
      assert.deepEqual(await store.adminSupportTickets("", 10, 0), { tickets: [], total: 0 });

      await store.close();
      store = await createStore(root);
      assert.equal((await store.userByEmail("legacy-675@example.test")).auth_version, 7);
      assert.ok(await store.session("legacy-675-session", now + 2));

      const snapshot = inspectDatabase(root, (db) => ({
        user: db.prepare("SELECT * FROM users WHERE id='legacy-675-user'").get(),
        session: db.prepare("SELECT * FROM sessions WHERE token_hash='legacy-675-session'").get(),
        verification: db
          .prepare("SELECT * FROM signup_verifications WHERE challenge_id='legacy-675-challenge'")
          .get(),
        verificationSend: db
          .prepare(
            "SELECT * FROM email_verification_sends WHERE send_id='legacy-675-verification-send'",
          )
          .get(),
        action: db
          .prepare("SELECT * FROM account_action_requests WHERE request_id='legacy-675-reset'")
          .get(),
        delivery: db
          .prepare(
            "SELECT * FROM account_action_deliveries WHERE request_id='legacy-675-delete-stage'",
          )
          .get(),
        actionSend: db
          .prepare("SELECT * FROM account_action_sends WHERE send_id='legacy-675-action-send'")
          .get(),
        counts: Object.fromEntries(
          [
            "plans",
            "monthly_plans",
            "preferences",
            "ratings",
            "paddle_purchases",
            "paddle_adjustments",
            "paddle_webhook_events",
            "support_tickets",
            "admin_principal",
            "admin_audit_events",
          ].map((table) => [
            table,
            Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
          ]),
        ),
        tables: new Set(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all()
            .map((row) => row.name),
        ),
        foreignKeyProblems: db.prepare("PRAGMA foreign_key_check").all(),
      }));
      assert.deepEqual(
        { ...snapshot.user },
        {
          id: "legacy-675-user",
          name: "Legacy 6.7.5",
          email: "legacy-675@example.test",
          password_hash: "legacy-675-hash",
          password_salt: "legacy-675-salt",
          created_at: now,
          email_verified_at: now,
          auth_version: 7,
          suspended_at: null,
        },
      );
      assert.equal(snapshot.session.csrf_token, "legacy-675-csrf");
      assert.equal(snapshot.verification.code_digest, "legacy-675-code-digest");
      assert.equal(snapshot.verificationSend.email_hash, "legacy-675-email-hash");
      assert.equal(snapshot.action.token_hash, "legacy-675-reset-token");
      assert.equal(snapshot.delivery.token_hash, "legacy-675-delete-token");
      assert.equal(snapshot.actionSend.email_hash, "legacy-675-email-hash");
      assert.deepEqual(snapshot.counts, {
        plans: 1,
        monthly_plans: 0,
        preferences: 1,
        ratings: 1,
        paddle_purchases: 1,
        paddle_adjustments: 1,
        paddle_webhook_events: 1,
        support_tickets: 0,
        admin_principal: 0,
        admin_audit_events: 0,
      });
      for (const table of [
        "monthly_plans",
        "support_tickets",
        "support_request_events",
        "product_signal_counts",
        "admin_principal",
        "admin_audit_events",
      ])
        assert.equal(snapshot.tables.has(table), true, `${table} should be created`);
      assert.deepEqual(snapshot.foreignKeyProblems, []);
    } finally {
      if (store) await store.close();
      restoreEnvironment(previous);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "admin ownership is claimed only by a verified matching account and invalidates old sessions and recovery links",
  { concurrency: false },
  async () => {
    const { root, store, close } = await fixture("admin-principal-");
    const now = 1_810_510_000_000;
    const owner = user("owner-user", now, { email: "stratafitness.official@gmail.com" });
    const unverified = user("unverified-user", now + 1, {
      email: "pending-admin@example.test",
      emailVerifiedAt: null,
    });
    const ordinary = user("ordinary-user", now + 2);
    try {
      await store.insertUser(owner);
      await store.insertUser(unverified);
      await store.insertUser(ordinary);
      await store.insertSession(session("owner-before-claim", owner.id, now));
      await store.insertSession(session("ordinary-session", ordinary.id, now));

      for (const [target, prefix] of [
        [owner, "owner"],
        [ordinary, "ordinary"],
      ]) {
        await store.upsertAccountAction(
          accountAction(`${prefix}-active-reset`, target.id, "password_reset", now + 3),
        );
        await store.upsertAccountAction(
          accountAction(`${prefix}-active-delete`, target.id, "account_delete", now + 4),
        );
        await store.stageAccountAction(
          accountAction(`${prefix}-staged-reset`, target.id, "password_reset", now + 5),
        );
        await store.stageAccountAction(
          accountAction(`${prefix}-staged-delete`, target.id, "account_delete", now + 6),
        );
      }
      const recoveryCounts = (userId) =>
        inspectDatabase(root, (db) => ({
          active: Number(
            db
              .prepare("SELECT COUNT(*) AS count FROM account_action_requests WHERE user_id=?")
              .get(userId).count,
          ),
          staged: Number(
            db
              .prepare("SELECT COUNT(*) AS count FROM account_action_deliveries WHERE user_id=?")
              .get(userId).count,
          ),
        }));
      assert.deepEqual(recoveryCounts(owner.id), { active: 2, staged: 2 });

      assert.deepEqual(await store.claimAdminPrincipal(unverified.id, unverified.email, now + 10), {
        principal: null,
        boundNow: false,
      });
      assert.deepEqual(
        recoveryCounts(owner.id),
        { active: 2, staged: 2 },
        "an unsuccessful claim must not consume another account's links",
      );
      assert.deepEqual(
        await store.claimAdminPrincipal(owner.id, "STRATAFITNESS.OFFICIAL@GMAIL.COM", now + 11),
        {
          principal: {
            slot: "primary",
            user_id: owner.id,
            configured_email: "STRATAFITNESS.OFFICIAL@GMAIL.COM",
            bound_at: now + 11,
          },
          boundNow: true,
        },
      );
      assert.equal(
        await store.session("owner-before-claim", now + 12),
        null,
        "claiming ownership must revoke pre-admin sessions",
      );
      assert.ok(
        await store.session("ordinary-session", now + 12),
        "claiming ownership must not revoke another account",
      );
      assert.equal((await store.userById(owner.id)).auth_version, 2);
      assert.deepEqual(
        recoveryCounts(owner.id),
        { active: 0, staged: 0 },
        "admin binding must invalidate every active and staged owner recovery/deletion bearer link",
      );
      assert.deepEqual(
        recoveryCounts(ordinary.id),
        { active: 2, staged: 2 },
        "admin binding must not invalidate another account's links",
      );
      for (const token of [
        "private-action-token-owner-active-reset",
        "private-action-token-owner-active-delete",
      ]) {
        assert.equal(
          await store.accountActionByTokenHash(token),
          null,
          `${token} must stop resolving immediately after binding`,
        );
      }
      const boundAudits = await store.adminAudit(10);
      assert.equal(
        boundAudits.filter((event) => event.action === "admin-bound").length,
        1,
        "a successful first claim must record one admin-bound event",
      );
      assert.equal(boundAudits[0].action, "admin-bound");
      assert.equal(boundAudits[0].actor_id, owner.id);
      assert.equal(boundAudits[0].target_user_id, owner.id);
      assert.equal(boundAudits[0].result, "success");
      assert.equal(Number(boundAudits[0].created_at), now + 11);
      assert.doesNotMatch(
        JSON.stringify(boundAudits[0]),
        /private-action-token|password_hash|password_salt|csrf_token|code_digest/i,
      );

      assert.equal(
        await store.insertSession(session("owner-after-claim", owner.id, now + 20, 2)),
        true,
      );
      const deniedOwnerSuspension = await store.suspendUser(owner.id, now + 21, {
        id: "owner-suspension-must-not-exist",
        actorUserId: owner.id,
        targetUserId: owner.id,
        action: "suspend",
        reason: "Database-layer owner protection test.",
        result: "success",
        createdAt: now + 21,
      });
      assert.equal(
        deniedOwnerSuspension,
        null,
        "the database API must reject suspension of the bound primary administrator without relying on an HTTP precheck",
      );
      assert.deepEqual(await store.userById(owner.id), {
        id: owner.id,
        name: owner.name,
        email: owner.email,
        created_at: now,
        email_verified_at: now,
        auth_version: 2,
        suspended_at: null,
      });
      assert.ok(
        await store.session("owner-after-claim", now + 22),
        "a denied owner suspension must not revoke the owner session",
      );
      assert.equal(
        (await store.adminAudit(10)).some(
          (event) => event.id === "owner-suspension-must-not-exist",
        ),
        false,
        "a denied owner suspension must not create a success audit",
      );
      const secondClaim = await store.claimAdminPrincipal(ordinary.id, ordinary.email, now + 40);
      assert.equal(secondClaim.boundNow, false);
      assert.equal(
        secondClaim.principal.user_id,
        owner.id,
        "the primary slot must not be silently rebound",
      );
      assert.equal((await store.userById(ordinary.id)).auth_version, 1);
      assert.equal(
        (await store.adminAudit(10)).filter((event) => event.action === "admin-bound").length,
        1,
        "idempotent or rejected claims must not duplicate the binding audit",
      );

      const principal = await store.adminPrincipal();
      assert.equal(principal.user_id, owner.id);
      assert.deepEqual(
        Object.keys(principal).sort(),
        [
          "auth_version",
          "bound_at",
          "configured_email",
          "email",
          "email_verified_at",
          "name",
          "slot",
          "suspended_at",
          "user_id",
        ].sort(),
      );
      assert.doesNotMatch(JSON.stringify(principal), /password|salt|csrf|token|secret|digest/i);

      const deletion = await store.upsertAccountAction(
        accountAction("admin-delete", owner.id, "account_delete", now + 50),
      );
      await assert.rejects(
        store.deleteAccount(deletion.token_hash, now + 51, "owner-email-hash"),
        /did not remove the requested user/,
      );
      assert.ok(await store.userById(owner.id), "the primary administrator must not be deletable");
    } finally {
      await close();
    }
  },
);

test(
  "admin overview, user search, detail, and support queries are accurate and redact auth material",
  { concurrency: false },
  async () => {
    const { store, close } = await fixture("admin-queries-");
    const now = 1_810_520_000_000;
    const percent = user("user-percent", now, {
      name: "Percent % Person",
      email: "percent@example.test",
    });
    const underscore = user("user-underscore", now, {
      name: "Under_score Person",
      email: "underscore@example.test",
    });
    const slash = user("user-slash", now, {
      name: "Back\\Slash Person",
      email: "slash@example.test",
      emailVerifiedAt: null,
    });
    const paid = user("user-paid", now, { name: "Paid Person", email: "paid@example.test" });
    try {
      for (const entry of [percent, underscore, slash, paid]) await store.insertUser(entry);
      await store.insertWorkout(
        completedWorkoutRecord(percent.id, "percent-first", now - 8 * 24 * 60 * 60 * 1000),
      );
      await store.insertWorkout(completedWorkoutRecord(percent.id, "percent-second", now));
      await store.insertWorkout(completedWorkoutRecord(paid.id, "paid-first", now));
      assert.equal(await store.insertSession(session("percent-a", percent.id, now)), true);
      assert.equal(await store.insertSession(session("percent-b", percent.id, now + 1)), true);
      assert.equal(
        await store.insertSession(
          session("percent-expired", percent.id, now - 2 * 60 * 60 * 1000, 1, {
            expiresAt: now - 1,
          }),
        ),
        true,
      );

      await store.upsertPlan(percent.id, JSON.stringify({ days: ["push", "pull"] }), now, 0);
      await store.upsertRating(
        percent.id,
        "bench-press",
        { comfort: 5, pump: 4, enjoyment: 5, stability: 4, setup: 3, overall: 5 },
        now,
        now,
      );
      await store.insertPendingPurchase(pendingPurchase("txn-completed-one", percent.id, now + 1));
      await store.completePurchase("txn-completed-one", {
        customerId: "ctm-admin-query",
        completedAt: now + 2,
        updatedAt: now + 2,
      });
      await store.insertPendingPurchase(pendingPurchase("txn_SEARCHABLE_123", percent.id, now + 3));
      await store.upsertAccountAction(
        accountAction("query-delete", percent.id, "account_delete", now + 4),
      );

      await store.insertPendingPurchase(pendingPurchase("txn-paid-user", paid.id, now + 4));
      await store.completePurchase("txn-paid-user", {
        customerId: "ctm-paid",
        subscriptionId: "sub-renewed-query",
        completedAt: now + 5,
        updatedAt: now + 5,
      });
      await store.createPaddleSubscription({
        subscriptionId: "sub-renewed-query",
        userId: paid.id,
        transactionId: "txn-paid-user",
        customerId: "ctm-paid",
        status: "active",
        priceId: PRICE_ID,
        productId: PRODUCT_ID,
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        currentPeriodEndsAt: now + 64 * 24 * 60 * 60 * 1000,
        eventOccurredAt: now + 5,
        createdAt: now + 5,
        updatedAt: now + 5,
      });
      assert.ok(await store.suspendUser(paid.id, now + 6));

      await store.insertPendingPurchase(
        pendingPurchase("txn-canceled-subscription", slash.id, now + 4),
      );
      await store.completePurchase("txn-canceled-subscription", {
        customerId: "ctm-canceled",
        subscriptionId: "sub_canceled",
        completedAt: now + 5,
        updatedAt: now + 5,
      });
      await store.createPaddleSubscription({
        subscriptionId: "sub_canceled",
        userId: slash.id,
        transactionId: "txn-canceled-subscription",
        customerId: "ctm-canceled",
        status: "canceled",
        priceId: PRICE_ID,
        productId: PRODUCT_ID,
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        currentPeriodEndsAt: null,
        eventOccurredAt: now + 6,
        createdAt: now + 6,
        updatedAt: now + 6,
      });

      const firstTicket = await store.insertSupportTicket(
        supportTicket("ticket-new", percent.id, now + 7),
      );
      const resolvedTicket = await store.insertSupportTicket(
        supportTicket("ticket-resolved", null, now + 8),
      );
      await store.updateSupportTicket(resolvedTicket.id, {
        status: "resolved",
        note: "Handled without credentials.",
        responseSent: true,
        updatedAt: now + 9,
        expectedUpdatedAt: resolvedTicket.updated_at,
      });

      const all = await store.adminUsers("", 10, 0, now + 10);
      assert.equal(all.total, 4);
      assert.deepEqual(
        all.users.map((entry) => entry.id),
        ["user-underscore", "user-slash", "user-percent", "user-paid"],
        "equal timestamps must have a deterministic ID tie-breaker",
      );
      assert.equal(
        all.users.filter((entry) => entry.id === percent.id).length,
        1,
        "multiple purchases must not duplicate a user row",
      );
      const percentList = all.users.find((entry) => entry.id === percent.id);
      assert.equal(percentList.active_session_count, 2);
      assert.equal(percentList.active_purchase_count, 1);
      assert.equal(percentList.pending_purchase_count, 1);
      assert.ok(percentList.deletion_expires_at > now);
      assert.equal(
        all.users.find((entry) => entry.id === slash.id).active_purchase_count,
        0,
        "admin access counts must exclude terminal subscriptions",
      );

      assert.deepEqual(
        (await store.adminUsers("%", 10, 0, now + 10)).users.map((entry) => entry.id),
        [percent.id],
      );
      assert.deepEqual(
        (await store.adminUsers("_", 10, 0, now + 10)).users.map((entry) => entry.id),
        [underscore.id, percent.id],
      );
      assert.deepEqual(
        (await store.adminUsers("\\", 10, 0, now + 10)).users.map((entry) => entry.id),
        [slash.id],
      );
      assert.deepEqual(
        (await store.adminUsers("searchable_123", 10, 0, now + 10)).users.map((entry) => entry.id),
        [percent.id],
      );
      assert.equal((await store.adminUsers("' OR 1=1 --", 10, 0, now + 10)).total, 0);
      assert.deepEqual(
        (await store.adminUsers("", 2, 1, now + 10)).users.map((entry) => entry.id),
        ["user-slash", "user-percent"],
      );

      const detail = await store.adminUserById(percent.id, now + 10);
      assert.equal(detail.active_session_count, 2);
      assert.equal(detail.rating_count, 1);
      assert.equal(detail.purchase_count, 2);
      assert.equal(detail.active_purchase_count, 1);
      assert.equal(detail.pending_purchase_count, 1);
      assert.deepEqual(JSON.parse(detail.plan_json), { days: ["push", "pull"] });
      assert.equal(detail.deletion_request_id, "query-delete");
      assert.equal(await store.adminUserById("missing-user", now + 10), null);
      assert.equal((await store.adminUserById(slash.id, now + 10)).active_purchase_count, 0);

      const forbidden =
        /password_hash|password_salt|csrf_token|token_hash|code_digest|browser_token|secret/i;
      assert.doesNotMatch(JSON.stringify(all), forbidden);
      assert.doesNotMatch(JSON.stringify(detail), forbidden);

      assert.deepEqual(await store.adminOverview(now + 10), {
        total_users: 4,
        verified_users: 3,
        suspended_users: 1,
        active_sessions: 2,
        discovery_users: 1,
        pending_payments: 1,
        pending_deletions: 1,
        open_support: 1,
        first_workout_users: 2,
        second_workout_users: 1,
        day_eight_return_users: 1,
        paid_users: 3,
        renewed_subscriptions: 1,
      });
      assert.equal(
        (await store.adminOverview(now + 10, PRICE_ID)).renewed_subscriptions,
        0,
        "on the yearly price, a period 64 days long is the first year, not a renewal",
      );

      assert.equal(firstTicket.status, "new");
      assert.deepEqual(
        (await store.adminSupportTickets("new", 10, 0)).tickets.map((ticket) => ticket.id),
        [firstTicket.id],
      );
      assert.equal((await store.adminSupportTickets("resolved", 10, 0)).total, 1);
      const updated = await store.updateSupportTicket(firstTicket.id, {
        status: "waiting",
        note: "Waiting for the account owner.",
        responseSent: false,
        updatedAt: now + 11,
        expectedUpdatedAt: firstTicket.updated_at,
      });
      assert.equal(updated.status, "waiting");
      assert.equal(updated.admin_note, "Waiting for the account owner.");
      assert.equal(updated.last_response_at, null);
      const responded = await store.updateSupportTicket(firstTicket.id, {
        status: "open",
        note: "Safe note.",
        responseSent: true,
        updatedAt: now + 12,
        expectedUpdatedAt: updated.updated_at,
      });
      assert.equal(responded.last_response_at, now + 12);
      assert.equal(await store.supportTicketById("missing-ticket"), null);
      assert.doesNotMatch(JSON.stringify(responded), forbidden);
    } finally {
      await close();
    }
  },
);

test(
  "revocation, suspension, and restore preserve account data while closing stale-session races",
  { concurrency: false },
  async () => {
    const { store, close } = await fixture("admin-session-state-");
    const now = 1_810_530_000_000;
    const target = user("target-user", now);
    const unrelated = user("unrelated-user", now + 1);
    try {
      await store.insertUser(target);
      await store.insertUser(unrelated);
      await store.upsertPlan(target.id, JSON.stringify({ days: ["keep-me"] }), now, 0);
      await store.insertSession(session("target-a", target.id, now));
      await store.insertSession(session("target-b", target.id, now + 1));
      await store.insertSession(session("unrelated", unrelated.id, now + 2));

      const revoked = await store.revokeUserSessions(target.id, {
        id: "state-revoked",
        actorUserId: unrelated.id,
        targetUserId: target.id,
        action: "revoke-sessions",
        reason: "Close unknown sessions.",
        result: "success",
        createdAt: now + 3,
      });
      assert.equal(revoked.revoked, 2);
      assert.equal(revoked.user.auth_version, 2);
      assert.equal(await store.session("target-a", now + 3), null);
      assert.equal(await store.session("target-b", now + 3), null);
      assert.ok(await store.session("unrelated", now + 3));
      assert.equal(
        await store.insertSession(session("stale-after-revoke", target.id, now + 4, 1)),
        false,
        "a captured pre-revocation version cannot create a session",
      );
      assert.equal(
        await store.insertSession(session("fresh-after-revoke", target.id, now + 5, 2)),
        true,
      );

      const suspended = await store.suspendUser(target.id, now + 6, {
        id: "state-suspended",
        actorUserId: unrelated.id,
        targetUserId: target.id,
        action: "suspend",
        reason: "Review account access.",
        result: "success",
        createdAt: now + 6,
      });
      assert.equal(suspended.suspended_at, now + 6);
      assert.equal(suspended.auth_version, 3);
      assert.equal(await store.session("fresh-after-revoke", now + 7), null);
      assert.equal(
        await store.insertSession(session("while-suspended", target.id, now + 8, 3)),
        false,
      );
      assert.equal(
        await store.suspendUser(target.id, now + 9),
        null,
        "suspension is a guarded idempotent state transition",
      );

      const restored = await store.restoreUser(target.id, {
        id: "state-restored",
        actorUserId: unrelated.id,
        targetUserId: target.id,
        action: "restore",
        reason: "Review is complete.",
        result: "success",
        createdAt: now + 10,
      });
      assert.equal(restored.suspended_at, null);
      assert.equal(restored.auth_version, 3);
      assert.equal(
        await store.restoreUser(target.id),
        null,
        "restore is a guarded idempotent state transition",
      );
      assert.equal(
        await store.insertSession(session("stale-after-restore", target.id, now + 10, 2)),
        false,
      );
      assert.equal(
        await store.insertSession(session("fresh-after-restore", target.id, now + 11, 3)),
        true,
      );

      assert.deepEqual(JSON.parse((await store.plan(target.id)).plan_json), { days: ["keep-me"] });
      assert.equal((await store.userByEmail(target.email)).password_hash, target.passwordHash);
      assert.ok(await store.session("unrelated", now + 12));
      assert.deepEqual(
        (await store.adminAudit(10)).map((event) => event.id),
        ["state-restored", "state-suspended", "state-revoked"],
        "successful security state changes must commit their audit event with the mutation",
      );
      assert.equal(await store.revokeUserSessions("missing-user"), null);
      assert.equal(await store.suspendUser("missing-user", now + 13), null);
      assert.equal(await store.restoreUser("missing-user"), null);
    } finally {
      await close();
    }
  },
);

test(
  "admin audit ordering is stable, auth material is excluded, and target deletion keeps the security record",
  { concurrency: false },
  async () => {
    const { store, close } = await fixture("admin-audit-");
    const now = 1_810_540_000_000;
    const actor = user("audit-actor", now, { email: "owner@example.test" });
    const target = user("audit-target", now + 1, {
      passwordHash: "never-leak-audit-password",
      passwordSalt: "never-leak-audit-salt",
    });
    try {
      await store.insertUser(actor);
      await store.insertUser(target);
      assert.equal(
        await store.recordAdminAudit({
          id: "audit-a",
          actorUserId: actor.id,
          targetUserId: target.id,
          action: "revoke-sessions",
          reason: "Account owner requested a sign-out.",
          result: "success",
          createdAt: now + 10,
        }),
        true,
      );
      assert.equal(
        await store.recordAdminAudit({
          id: "audit-z",
          actorUserId: actor.id,
          targetUserId: target.id,
          action: "send-password-reset",
          reason: "Account owner requested help.",
          result: "success",
          createdAt: now + 10,
        }),
        true,
      );
      await assert.rejects(
        store.recordAdminAudit({
          id: "audit-z",
          actorUserId: actor.id,
          targetUserId: target.id,
          action: "duplicate",
          reason: "Duplicate ID.",
          result: "success",
          createdAt: now + 11,
        }),
        /unique/i,
      );

      let events = await store.adminAudit(10);
      assert.deepEqual(
        events.map((event) => event.id),
        ["audit-z", "audit-a"],
      );
      assert.deepEqual(
        Object.keys(events[0]).sort(),
        [
          "action",
          "actor_email",
          "actor_id",
          "actor_name",
          "created_at",
          "id",
          "reason",
          "result",
          "target_email",
          "target_id",
          "target_name",
          "target_user_id",
        ].sort(),
      );
      assert.doesNotMatch(
        JSON.stringify(events),
        /never-leak-audit-password|never-leak-audit-salt|csrf|token_hash|code_digest/i,
      );
      assert.equal(typeof store.updateAdminAudit, "undefined");
      assert.equal(typeof store.deleteAdminAudit, "undefined");

      const deletion = await store.upsertAccountAction(
        accountAction("audit-target-delete", target.id, "account_delete", now + 20),
      );
      assert.equal(
        (await store.deleteAccount(deletion.token_hash, now + 21, "target-email-hash")).status,
        "deleted",
      );
      events = await store.adminAudit(10);
      assert.equal(events[0].target_user_id, target.id);
      assert.equal(events[0].target_id, null);
      assert.equal(events[0].target_name, null);
      assert.equal(events[0].target_email, null);
      assert.equal(events[1].target_user_id, target.id);
      assert.ok(await store.userById(actor.id), "target deletion must not affect the audit actor");
    } finally {
      await close();
    }
  },
);

test(
  "direct admin deletion requires suspension, fails closed on billing, and commits its audit atomically",
  { concurrency: false },
  async () => {
    const { store, close } = await fixture("admin-direct-delete-");
    const now = 1_810_550_000_000;
    const actor = user("direct-delete-actor", now);
    const target = user("direct-delete-target", now + 1);
    const audit = {
      id: "direct-delete-audit",
      actorUserId: actor.id,
      targetUserId: target.id,
      action: "delete-account",
      reason: "Remove the paused test account permanently.",
      result: "success",
      createdAt: now + 8,
    };
    try {
      await store.insertUser(actor);
      await store.insertUser(target);
      await store.claimAdminPrincipal(actor.id, actor.email, now + 2);
      await store.insertSession(session("direct-delete-admin-session", actor.id, now + 3, 2));
      await store.insertSession(session("direct-delete-session", target.id, now + 2));
      await store.upsertPlan(target.id, JSON.stringify({ days: ["private"] }), now + 3, 0);
      await store.insertPendingPurchase(pendingPurchase("txn_direct_delete", target.id, now + 4));

      assert.equal(
        await store.deleteUserByAdmin(
          target.id,
          now + 5,
          target.email,
          "direct-delete-email-hash",
          "direct-delete-admin-session",
          audit,
        ),
        null,
        "an active target must be protected",
      );
      await store.suspendUser(target.id, now + 6);
      assert.equal(
        await store.deleteUserByAdmin(
          target.id,
          now + 7,
          target.email,
          "direct-delete-email-hash",
          "direct-delete-admin-session",
          audit,
        ),
        null,
        "unsettled billing must block deletion",
      );
      assert.ok(await store.userById(target.id));
      assert.equal(
        (await store.adminAudit(10)).some((event) => event.id === audit.id),
        false,
        "a blocked deletion must not write a success audit",
      );

      await store.updatePurchaseStatus("txn_direct_delete", "canceled", now + 8);
      const deleted = await store.deleteUserByAdmin(
        target.id,
        now + 9,
        target.email,
        "direct-delete-email-hash",
        "direct-delete-admin-session",
        audit,
      );
      assert.equal(deleted.id, target.id);
      assert.equal(await store.userById(target.id), null);
      assert.equal(await store.session("direct-delete-session", now + 10), null);
      assert.equal(await store.plan(target.id), null);
      const event = (await store.adminAudit(10)).find((entry) => entry.id === audit.id);
      assert.equal(event.target_user_id, target.id);
      assert.equal(event.target_email, null);
      assert.ok(await store.userById(actor.id));

      const revokedTarget = user("direct-delete-revoked-target", now + 10);
      await store.insertUser(revokedTarget);
      await store.suspendUser(revokedTarget.id, now + 11);
      await store.deleteSession("direct-delete-admin-session");
      const revokedAudit = {
        ...audit,
        id: "direct-delete-revoked-audit",
        targetUserId: revokedTarget.id,
        createdAt: now + 12,
      };
      assert.equal(
        await store.deleteUserByAdmin(
          revokedTarget.id,
          now + 12,
          revokedTarget.email,
          "revoked-target-email-hash",
          "direct-delete-admin-session",
          revokedAudit,
        ),
        null,
        "a revoked admin session must fail the final authorization check",
      );
      assert.ok(await store.userById(revokedTarget.id));
      assert.equal(
        (await store.adminAudit(20)).some((entry) => entry.id === revokedAudit.id),
        false,
      );
    } finally {
      await close();
    }
  },
);
