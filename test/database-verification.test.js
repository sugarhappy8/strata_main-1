"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore, isUniqueViolation } = require("../src/database");
const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");

function testDirectory(prefix) {
  mkdirSync(TEST_RUNTIME, { recursive: true });
  return mkdtempSync(join(TEST_RUNTIME, prefix));
}

function candidate(suffix, now, overrides = {}) {
  return {
    challengeId: `challenge-${suffix}`,
    browserTokenHash: `browser-token-hash-${suffix}`,
    userId: `user-${suffix}`,
    email: "pending@example.test",
    name: `Pending ${suffix}`,
    passwordHash: `password-hash-${suffix}`,
    passwordSalt: `password-salt-${suffix}`,
    codeDigest: `code-digest-${suffix}`,
    generation: 1,
    attemptsUsed: 0,
    sendCount: 1,
    lastSentAt: now,
    expiresAt: now + 10 * 60 * 1000,
    hardExpiresAt: now + 24 * 60 * 60 * 1000,
    deliveryState: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function session(suffix, now, userId) {
  return {
    tokenHash: `session-token-hash-${suffix}`,
    csrfToken: `csrf-token-${suffix}`,
    expiresAt: now + 60 * 60 * 1000,
    createdAt: now,
    ...(userId ? { userId } : {}),
  };
}

function createLegacyDatabase(root, now) {
  const db = new DatabaseSync(join(root, "strata.sqlite"));
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE signup_verifications (
    challenge_id TEXT PRIMARY KEY,
    browser_token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    code_digest TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    attempts_used INTEGER NOT NULL DEFAULT 0 CHECK(attempts_used >= 0),
    send_count INTEGER NOT NULL DEFAULT 0 CHECK(send_count >= 0),
    last_sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hard_expires_at INTEGER NOT NULL,
    delivery_state TEXT NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(expires_at <= hard_expires_at)
  );
  CREATE UNIQUE INDEX signup_verifications_user_id ON signup_verifications(user_id);`);
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    "legacy-schema-user",
    "Legacy Schema",
    "legacy-schema@example.test",
    "legacy-hash",
    "legacy-salt",
    now,
  );
  const pending = candidate("legacy-schema", now, {
    userId: "legacy-pending-user",
    email: "legacy-pending@example.test",
  });
  db.prepare(
    "INSERT INTO signup_verifications(challenge_id,browser_token_hash,user_id,email,name,password_hash,password_salt,code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,delivery_state,consumed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)",
  ).run(
    pending.challengeId,
    pending.browserTokenHash,
    pending.userId,
    pending.email,
    pending.name,
    pending.passwordHash,
    pending.passwordSalt,
    pending.codeDigest,
    pending.generation,
    pending.attemptsUsed,
    pending.sendCount,
    pending.lastSentAt,
    pending.expiresAt,
    pending.hardExpiresAt,
    pending.deliveryState,
    pending.createdAt,
    pending.updatedAt,
  );
  db.close();
}

test("verification storage rotates, limits, consumes, and records verified signup users", async () => {
  const root = testDirectory("verification-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_000_000_000;
  try {
    await store.insertUser({
      id: "legacy-user",
      name: "Legacy",
      email: "legacy@example.test",
      passwordHash: "legacy-hash",
      passwordSalt: "legacy-salt",
      createdAt: now - 1000,
    });
    assert.equal((await store.userByEmail("legacy@example.test")).id, "legacy-user");

    const first = await store.insertVerification(candidate("one", now));
    const second = await store.insertVerification(
      candidate("two", now, { email: "PENDING@example.test" }),
    );
    assert.equal(first.generation, 1);
    assert.equal(first.purpose, "signup");
    assert.equal(second.email, "PENDING@example.test");
    assert.equal(
      (await store.verificationByTokenHash(first.browser_token_hash)).challenge_id,
      first.challenge_id,
    );

    const failedOnce = await store.claimVerificationAttempt(first.challenge_id, 1, now + 1, 2);
    const failedTwice = await store.claimVerificationAttempt(first.challenge_id, 1, now + 2, 2);
    assert.equal(failedOnce.attempts_used, 1);
    assert.equal(failedTwice.attempts_used, 2);
    assert.equal(await store.claimVerificationAttempt(first.challenge_id, 1, now + 3, 2), null);

    const rotated = await store.rotateVerification(first.challenge_id, 1, {
      codeDigest: "rotated-code-digest",
      lastSentAt: now + 60_000,
      expiresAt: now + 11 * 60 * 1000,
      deliveryState: "sending",
      updatedAt: now + 60_000,
    });
    assert.equal(rotated.generation, 2);
    assert.equal(rotated.attempts_used, 0);
    assert.equal(rotated.send_count, 2);
    assert.equal(
      await store.rotateVerification(first.challenge_id, 1, {
        codeDigest: "stale",
        lastSentAt: now,
        expiresAt: now + 1,
        deliveryState: "sending",
        updatedAt: now,
      }),
      null,
    );
    assert.equal(
      await store.markVerificationDelivery(first.challenge_id, 1, "sent", now + 60_001),
      false,
    );
    assert.equal(
      await store.markVerificationDelivery(first.challenge_id, 2, "sent", now + 60_001),
      true,
    );

    assert.equal(await store.countVerificationSends("email-hash", now - 1), 0);
    await store.recordVerificationSend({
      id: "send-1",
      emailHash: "email-hash",
      challengeId: first.challenge_id,
      generation: 2,
      sentAt: now,
    });
    await store.recordVerificationSend({
      id: "send-2",
      emailHash: "email-hash",
      challengeId: second.challenge_id,
      generation: 1,
      sentAt: now + 10,
    });
    assert.equal(await store.countVerificationSends("email-hash", now - 1), 2);
    assert.equal(await store.countVerificationSends("email-hash", now + 1), 1);

    const completedAt = now + 90_000;
    const user = await store.completeSignup(
      first.challenge_id,
      2,
      completedAt,
      session("completed", completedAt),
    );
    assert.deepEqual(user, {
      id: "user-one",
      name: "Pending one",
      email: "pending@example.test",
      created_at: completedAt,
      email_verified_at: completedAt,
      auth_version: 1,
      suspended_at: null,
    });
    assert.equal((await store.userByEmail("pending@example.test")).email_verified_at, completedAt);
    const consumed = await store.verificationByTokenHash(first.browser_token_hash);
    assert.equal(consumed.consumed_at, completedAt);
    assert.equal(consumed.delivery_state, "consumed");
    assert.equal(consumed.code_digest, "");
    assert.equal(consumed.password_hash, "");
    assert.equal(consumed.password_salt, "");
    assert.equal(
      await store.completeSignup(
        first.challenge_id,
        2,
        completedAt + 1,
        session("duplicate", completedAt + 1),
      ),
      null,
    );

    await assert.rejects(
      () =>
        store.completeSignup(
          second.challenge_id,
          1,
          completedAt + 2,
          session("conflict", completedAt + 2),
        ),
      (error) => isUniqueViolation(error),
    );
    assert.equal(
      (await store.verificationByTokenHash(second.browser_token_hash)).consumed_at,
      null,
    );

    const cleanup = await store.deleteOldVerificationData(now + 26 * 60 * 60 * 1000, now + 1);
    assert.equal(cleanup.verifications, 2);
    assert.equal(cleanup.sends, 1);
  } finally {
    await store.close();
    const db = new DatabaseSync(join(root, "strata.sqlite"));
    const userColumns = db
      .prepare("PRAGMA table_info(users)")
      .all()
      .map((row) => row.name);
    db.close();
    assert.deepEqual(userColumns, [
      "id",
      "name",
      "email",
      "password_hash",
      "password_salt",
      "created_at",
      "email_verified_at",
      "auth_version",
      "suspended_at",
    ]);
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy SQLite schemas migrate email verification columns and indexes idempotently", async () => {
  const root = testDirectory("verification-migration-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const now = 1_800_050_000_000;
  let store;
  try {
    createLegacyDatabase(root, now);
    store = await createStore(root);

    assert.equal((await store.userByEmail("legacy-schema@example.test")).email_verified_at, null);
    assert.equal(
      (await store.verificationByTokenHash("browser-token-hash-legacy-schema")).purpose,
      "signup",
    );

    await store.insertVerification(
      candidate("legacy-login-one", now, {
        purpose: "login",
        userId: "legacy-schema-user",
        email: "legacy-schema@example.test",
        name: "",
        passwordHash: "",
        passwordSalt: "",
      }),
    );
    await store.insertVerification(
      candidate("legacy-login-two", now + 1, {
        purpose: "login",
        userId: "legacy-schema-user",
        email: "legacy-schema@example.test",
        name: "",
        passwordHash: "",
        passwordSalt: "",
      }),
    );
    await assert.rejects(
      () =>
        store.insertVerification(
          candidate("bad-purpose", now, {
            purpose: "password-reset",
            email: "bad-purpose@example.test",
          }),
        ),
      /purpose must be signup or login/i,
    );

    await store.close();
    store = await createStore(root);
    assert.equal((await store.userByEmail("legacy-schema@example.test")).email_verified_at, null);

    const db = new DatabaseSync(join(root, "strata.sqlite"));
    const userColumns = db
      .prepare("PRAGMA table_info(users)")
      .all()
      .map((row) => row.name);
    const verificationColumns = db
      .prepare("PRAGMA table_info(signup_verifications)")
      .all()
      .map((row) => row.name);
    const verificationIndexes = db.prepare("PRAGMA index_list(signup_verifications)").all();
    db.close();
    assert.ok(userColumns.includes("email_verified_at"));
    assert.ok(verificationColumns.includes("purpose"));
    assert.equal(
      verificationIndexes.some((index) => index.name === "signup_verifications_user_id"),
      false,
    );
    assert.equal(
      verificationIndexes.find((index) => index.name === "signup_verifications_user_id_idx")
        ?.unique,
      0,
    );
  } finally {
    if (store) await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification attempts are claimed atomically at the configured cap", async () => {
  const root = testDirectory("attempt-claims-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_200_000_000;
  try {
    const verification = await store.insertVerification(
      candidate("attempt-cap", now, { email: "attempt-cap@example.test" }),
    );
    const claims = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.claimVerificationAttempt(
          verification.challenge_id,
          verification.generation,
          now + index + 1,
          5,
        ),
      ),
    );
    const successful = claims.filter(Boolean);

    assert.equal(successful.length, 5);
    assert.deepEqual(
      successful.map((row) => row.attempts_used).sort((left, right) => left - right),
      [1, 2, 3, 4, 5],
    );
    assert.equal(
      (await store.verificationByTokenHash(verification.browser_token_hash)).attempts_used,
      5,
    );
    assert.equal(
      await store.claimVerificationAttempt(
        verification.challenge_id,
        verification.generation,
        now + 100,
        5,
      ),
      null,
    );
  } finally {
    await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("verification email sends are reserved atomically per address", async () => {
  const root = testDirectory("send-claims-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_300_000_000;
  const emailHash = "same-recipient-hash";
  try {
    const reservations = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.claimVerificationSend(
          {
            id: `send-claim-${index}`,
            emailHash,
            challengeId: `send-challenge-${index}`,
            generation: 1,
            sentAt: now + index,
          },
          now - 1,
          5,
        ),
      ),
    );

    assert.equal(reservations.filter(Boolean).length, 5);
    assert.equal(await store.countVerificationSends(emailHash, now - 1), 5);
    assert.equal(
      await store.claimVerificationSend(
        {
          id: "send-claim-over-cap",
          emailHash,
          challengeId: "send-challenge-over-cap",
          generation: 1,
          sentAt: now + 100,
        },
        now - 1,
        5,
      ),
      false,
    );

    assert.equal(
      await store.claimVerificationSend(
        {
          id: "recoverable-send-slot",
          emailHash: "recoverable-recipient-hash",
          challengeId: "recoverable-challenge",
          generation: 2,
          sentAt: now + 200,
        },
        now - 1,
        5,
      ),
      true,
    );
    assert.deepEqual(
      await store.verificationSendByChallengeGeneration("recoverable-challenge", 2),
      {
        send_id: "recoverable-send-slot",
        email_hash: "recoverable-recipient-hash",
        challenge_id: "recoverable-challenge",
        generation: 2,
        sent_at: now + 200,
      },
    );
  } finally {
    await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("signup completion atomically creates one session and rolls back session failures", async () => {
  const root = testDirectory("atomic-signup-session-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_400_000_000;
  try {
    const concurrent = await store.insertVerification(
      candidate("concurrent-complete", now, { email: "concurrent-complete@example.test" }),
    );
    const results = await Promise.all([
      store.completeSignup(
        concurrent.challenge_id,
        1,
        now + 100,
        session("concurrent-a", now + 100),
      ),
      store.completeSignup(
        concurrent.challenge_id,
        1,
        now + 100,
        session("concurrent-b", now + 100),
      ),
    ]);
    assert.equal(results.filter(Boolean).length, 1);

    const db = new DatabaseSync(join(root, "strata.sqlite"));
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE email=?")
        .get("concurrent-complete@example.test").count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id=?").get(concurrent.user_id)
        .count,
      1,
    );

    await store.insertUser({
      id: "session-owner",
      name: "Session Owner",
      email: "session-owner@example.test",
      passwordHash: "hash",
      passwordSalt: "salt",
      createdAt: now,
    });
    await store.insertSession({
      tokenHash: "duplicate-session-token",
      userId: "session-owner",
      csrfToken: "owner-csrf",
      expiresAt: now + 60_000,
      createdAt: now,
    });
    const rollback = await store.insertVerification(
      candidate("session-rollback", now, { email: "session-rollback@example.test" }),
    );
    await assert.rejects(
      () =>
        store.completeSignup(rollback.challenge_id, 1, now + 200, {
          tokenHash: "duplicate-session-token",
          csrfToken: "rollback-csrf",
          expiresAt: now + 60_000,
          createdAt: now + 200,
        }),
      /UNIQUE|constraint/i,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE email=?")
        .get("session-rollback@example.test").count,
      0,
    );
    const stillPending = db
      .prepare(
        "SELECT consumed_at,password_hash,code_digest FROM signup_verifications WHERE challenge_id=?",
      )
      .get(rollback.challenge_id);
    assert.equal(stillPending.consumed_at, null);
    assert.ok(stillPending.password_hash);
    assert.ok(stillPending.code_digest);
    db.close();
  } finally {
    await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("login verification atomically verifies an existing user, consumes its challenge, and creates a session", async () => {
  const root = testDirectory("atomic-login-verification-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_450_000_000;
  try {
    await store.insertUser({
      id: "login-user",
      name: "Login User",
      email: "login@example.test",
      passwordHash: "hash",
      passwordSalt: "salt",
      createdAt: now,
    });
    await store.insertSession(session("legacy-login", now, "login-user"));
    const login = await store.insertVerification(
      candidate("existing-login", now, {
        purpose: "login",
        userId: "login-user",
        email: "login@example.test",
        name: "",
        passwordHash: "",
        passwordSalt: "",
      }),
    );
    const sibling = await store.insertVerification(
      candidate("existing-login-sibling", now + 1, {
        purpose: "login",
        userId: "login-user",
        email: "login@example.test",
        name: "",
        passwordHash: "",
        passwordSalt: "",
      }),
    );
    assert.equal(
      await store.completeSignup(
        login.challenge_id,
        1,
        now + 100,
        session("wrong-purpose", now + 100),
      ),
      null,
    );

    const verifiedAt = now + 200;
    const verified = await store.completeLoginVerification(
      login.challenge_id,
      1,
      verifiedAt,
      session("verified-login", verifiedAt),
    );
    assert.deepEqual(verified, {
      id: "login-user",
      name: "Login User",
      email: "login@example.test",
      created_at: now,
      email_verified_at: verifiedAt,
      auth_version: 1,
      suspended_at: null,
    });
    assert.equal((await store.userById("login-user")).email_verified_at, verifiedAt);
    assert.equal(
      (await store.session("session-token-hash-verified-login", verifiedAt)).email_verified_at,
      verifiedAt,
    );
    assert.equal(
      await store.session("session-token-hash-legacy-login", verifiedAt),
      null,
      "pre-verification sessions must be revoked",
    );
    const consumed = await store.verificationByTokenHash(login.browser_token_hash);
    assert.equal(consumed.consumed_at, verifiedAt);
    assert.equal(consumed.delivery_state, "consumed");
    assert.equal(consumed.code_digest, "");
    assert.equal(
      await store.completeLoginVerification(
        login.challenge_id,
        1,
        verifiedAt + 1,
        session("duplicate-login", verifiedAt + 1),
      ),
      null,
    );
    assert.equal(
      await store.completeLoginVerification(
        sibling.challenge_id,
        1,
        verifiedAt,
        session("sibling-login", verifiedAt),
      ),
      null,
      "only the first active login challenge may verify an account",
    );
    assert.ok(
      await store.session("session-token-hash-verified-login", verifiedAt),
      "a stale sibling challenge must not revoke the winning session",
    );

    await store.insertUser({
      id: "rollback-login-user",
      name: "Rollback User",
      email: "rollback-login@example.test",
      passwordHash: "hash",
      passwordSalt: "salt",
      createdAt: now,
    });
    const rollback = await store.insertVerification(
      candidate("rollback-login", now, {
        purpose: "login",
        userId: "rollback-login-user",
        email: "rollback-login@example.test",
        name: "",
        passwordHash: "",
        passwordSalt: "",
      }),
    );
    await assert.rejects(
      () =>
        store.completeLoginVerification(rollback.challenge_id, 1, now + 300, {
          tokenHash: "session-token-hash-verified-login",
          csrfToken: "rollback-csrf",
          expiresAt: now + 60_000,
          createdAt: now + 300,
        }),
      /UNIQUE|constraint/i,
    );
    assert.equal((await store.userById("rollback-login-user")).email_verified_at, null);
    const stillPending = await store.verificationByTokenHash(rollback.browser_token_hash);
    assert.equal(stillPending.consumed_at, null);
    assert.ok(stillPending.code_digest);
  } finally {
    await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired or explicitly consumed verification cannot create an account", async () => {
  const root = testDirectory("expired-verification-");
  const prior = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  process.env.STRATA_DATA_DIR = root;
  const store = await createStore(root);
  const now = 1_800_100_000_000;
  try {
    const expired = await store.insertVerification(
      candidate("expired", now, {
        email: "expired@example.test",
        expiresAt: now + 1000,
        hardExpiresAt: now + 2000,
      }),
    );
    assert.equal(
      await store.completeSignup(
        expired.challenge_id,
        1,
        now + 1001,
        session("expired", now + 1001),
      ),
      null,
    );
    assert.equal(await store.userByEmail("expired@example.test"), null);

    const stopped = await store.insertVerification(
      candidate("stopped", now, { email: "stopped@example.test" }),
    );
    assert.ok(await store.consumeVerification(stopped.challenge_id, 1, now + 10));
    assert.equal(
      await store.completeSignup(stopped.challenge_id, 1, now + 20, session("stopped", now + 20)),
      null,
    );
    assert.equal(await store.userByEmail("stopped@example.test"), null);
  } finally {
    await store.close();
    if (prior.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.nodeEnv;
    if (prior.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = prior.tursoUrl;
    if (prior.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
    else process.env.STRATA_DATA_DIR = prior.dataDir;
    rmSync(root, { recursive: true, force: true });
  }
});
