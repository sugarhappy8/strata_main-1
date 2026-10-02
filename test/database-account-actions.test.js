"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");
const PRICE_ID = "pri_account_action_test";
const PRODUCT_ID = "pro_account_action_test";

function testDirectory(prefix) {
  mkdirSync(TEST_RUNTIME, { recursive: true });
  return mkdtempSync(join(TEST_RUNTIME, prefix));
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
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function user(suffix, now, overrides = {}) {
  return {
    id: `user-${suffix}`,
    name: `Account ${suffix}`,
    email: `${suffix}@example.test`,
    passwordHash: `password-hash-${suffix}`,
    passwordSalt: `password-salt-${suffix}`,
    createdAt: now,
    emailVerifiedAt: now,
    ...overrides,
  };
}

function session(suffix, userId, now, authVersion = 1) {
  return {
    tokenHash: `session-token-${suffix}`,
    userId,
    csrfToken: `csrf-${suffix}`,
    expiresAt: now + 60 * 60 * 1000,
    createdAt: now,
    authVersion,
  };
}

function action(suffix, userId, purpose, now, overrides = {}) {
  return {
    requestId: `request-${suffix}`,
    userId,
    purpose,
    tokenHash: `action-token-${suffix}`,
    expiresAt: now + 30 * 60 * 1000,
    deliveryState: "sent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function verification(suffix, userId, email, now) {
  return {
    challengeId: `challenge-${suffix}`,
    browserTokenHash: `browser-token-${suffix}`,
    userId,
    purpose: "login",
    email,
    name: "",
    passwordHash: "",
    passwordSalt: "",
    codeDigest: `code-digest-${suffix}`,
    generation: 1,
    attemptsUsed: 0,
    sendCount: 1,
    lastSentAt: now,
    expiresAt: now + 10 * 60 * 1000,
    hardExpiresAt: now + 24 * 60 * 60 * 1000,
    deliveryState: "sent",
    createdAt: now,
    updatedAt: now,
  };
}

function purchase(suffix, userId, now, status = "ready") {
  return {
    transactionId: `txn-${suffix}`,
    userId,
    priceId: PRICE_ID,
    productId: PRODUCT_ID,
    paddleStatus: status,
    createdAt: now,
    updatedAt: now,
  };
}

function inspectDatabase(root, inspect) {
  const db = new DatabaseSync(join(root, "strata.sqlite"), { enableForeignKeyConstraints: true });
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

test(
  "account action requests rotate safely, bind delivery updates, rate-limit sends, and clean up",
  { concurrency: false },
  async () => {
    const { root, store, close } = await fixture("account-actions-");
    const now = 1_810_000_000_000;
    const account = user("store", now);
    try {
      await store.insertUser(account);

      await assert.rejects(
        store.upsertAccountAction(action("invalid", account.id, "email_change", now)),
        /purpose must be password_reset or account_delete/i,
      );

      const first = await store.upsertAccountAction(
        action("reset-one", account.id, "password_reset", now, { deliveryState: "sending" }),
      );
      assert.deepEqual(first, {
        request_id: "request-reset-one",
        user_id: account.id,
        purpose: "password_reset",
        token_hash: "action-token-reset-one",
        expires_at: now + 30 * 60 * 1000,
        delivery_state: "sending",
        consumed_at: null,
        created_at: now,
        updated_at: now,
      });
      assert.equal((await store.accountActionByTokenHash(first.token_hash)).email, account.email);
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).request_id,
        first.request_id,
      );
      assert.equal(
        await store.markAccountActionDelivery(first.request_id, "wrong-token", "sent", now + 1),
        false,
      );
      assert.equal(
        await store.markAccountActionDelivery("wrong-request", first.token_hash, "sent", now + 1),
        false,
      );
      assert.equal(
        await store.markAccountActionDelivery(first.request_id, first.token_hash, "sent", now + 1),
        true,
      );
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).delivery_state,
        "sent",
      );

      const replacement = await store.upsertAccountAction(
        action("reset-two", account.id, "password_reset", now + 2),
      );
      assert.equal(
        await store.accountActionByTokenHash(first.token_hash),
        null,
        "rotating a request must invalidate its old token",
      );
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).request_id,
        replacement.request_id,
      );

      const failedStage = action("reset-failed-delivery", account.id, "password_reset", now + 3);
      await store.stageAccountAction(failedStage);
      assert.equal(
        await store.discardStagedAccountAction(failedStage.requestId, failedStage.tokenHash),
        true,
      );
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).request_id,
        replacement.request_id,
        "a failed replacement delivery must preserve the prior working link",
      );

      const stagedInput = action("reset-staged", account.id, "password_reset", now + 4);
      const staged = await store.stageAccountAction(stagedInput);
      assert.equal(staged.request_id, stagedInput.requestId);
      assert.equal(
        await store.accountActionByTokenHash(stagedInput.tokenHash),
        null,
        "an undelivered token must never be active",
      );
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).request_id,
        replacement.request_id,
        "staging must preserve the last delivered link",
      );
      const activated = await store.activateAccountAction(
        stagedInput.requestId,
        stagedInput.tokenHash,
        now + 5,
      );
      assert.equal(activated.delivery_state, "sent");
      assert.equal(
        (await store.accountActionForUser(account.id, "password_reset")).request_id,
        stagedInput.requestId,
      );
      assert.equal(
        await store.activateAccountAction(stagedInput.requestId, stagedInput.tokenHash, now + 6),
        null,
        "staged delivery activation is one-time",
      );

      const slower = action("reset-slower", account.id, "password_reset", now + 6);
      const newer = action("reset-newer", account.id, "password_reset", now + 7);
      await store.stageAccountAction(slower);
      await store.stageAccountAction(newer);
      assert.equal(
        await store.activateAccountAction(slower.requestId, slower.tokenHash, now + 8),
        null,
        "an older email response must not displace a newer request",
      );
      assert.equal(
        (await store.activateAccountAction(newer.requestId, newer.tokenHash, now + 9)).request_id,
        newer.requestId,
      );

      const deletion = await store.upsertAccountAction(
        action("delete", account.id, "account_delete", now + 10),
      );
      assert.deepEqual(await store.activeAccountDeletion(account.id, now + 8), {
        request_id: deletion.request_id,
        expires_at: deletion.expires_at,
      });
      const stagedDeletion = action("delete-in-flight", account.id, "account_delete", now + 8);
      await store.stageAccountAction(stagedDeletion);
      assert.equal(await store.cancelAccountDeletion(account.id), true);
      assert.equal(
        await store.activateAccountAction(
          stagedDeletion.requestId,
          stagedDeletion.tokenHash,
          now + 9,
        ),
        null,
        "canceling deletion must also invalidate an email still in flight",
      );
      assert.equal(await store.cancelAccountDeletion(account.id), false);
      assert.equal(await store.activeAccountDeletion(account.id, now + 4), null);

      const emailHash = "account-store-email-hash";
      const resetClaims = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.claimAccountActionSend(
            {
              id: `reset-send-${index}`,
              emailHash,
              purpose: "password_reset",
              sentAt: now + index,
            },
            now - 1,
            3,
          ),
        ),
      );
      assert.equal(resetClaims.filter(Boolean).length, 3);
      assert.equal(await store.countAccountActionSends(emailHash, "password_reset", now - 1), 3);
      assert.equal(
        await store.claimAccountActionSend(
          {
            id: "delete-send",
            emailHash,
            purpose: "account_delete",
            sentAt: now + 20,
          },
          now - 1,
          3,
        ),
        true,
        "send limits are intentionally separate by action purpose",
      );
      await assert.rejects(
        store.claimAccountActionSend(
          { id: "bad-send", emailHash, purpose: "login", sentAt: now },
          now - 1,
          3,
        ),
        /purpose must be password_reset or account_delete/i,
      );

      await store.upsertAccountAction(
        action("expired", account.id, "account_delete", now - 1000, { expiresAt: now - 1 }),
      );
      assert.equal(
        await store.claimAccountActionSend(
          {
            id: "old-action-send",
            emailHash: "old-email-hash",
            purpose: "account_delete",
            sentAt: now - 100,
          },
          now - 1000,
          3,
        ),
        true,
      );
      assert.equal(
        await store.claimAccountActionSend(
          {
            id: "new-action-send",
            emailHash: "new-email-hash",
            purpose: "account_delete",
            sentAt: now + 100,
          },
          now - 1000,
          3,
        ),
        true,
      );
      assert.deepEqual(await store.deleteOldAccountActionData(now, now), { actions: 1, sends: 1 });
      assert.equal(await store.accountActionForUser(account.id, "account_delete"), null);
      assert.equal(
        inspectDatabase(
          root,
          (db) =>
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM account_action_sends WHERE send_id='new-action-send'",
              )
              .get().count,
        ),
        1,
      );
    } finally {
      await close();
    }
  },
);

test(
  "password reset is atomic, one-time, bumps auth version, and revokes every session",
  { concurrency: false },
  async () => {
    const { root, store, close } = await fixture("password-reset-");
    const now = 1_810_100_000_000;
    const account = user("reset", now, { emailVerifiedAt: null });
    const reset = action("atomic-reset", account.id, "password_reset", now);
    const deletion = action("sibling-delete", account.id, "account_delete", now + 1);
    try {
      await store.insertUser(account);
      assert.equal(await store.insertSession(session("one", account.id, now)), true);
      assert.equal(await store.insertSession(session("two", account.id, now + 1)), true);
      await store.upsertAccountAction(reset);
      await store.upsertAccountAction(deletion);

      inspectDatabase(root, (db) =>
        db.exec(`CREATE TRIGGER force_reset_rollback
      BEFORE DELETE ON sessions
      BEGIN
        SELECT RAISE(ABORT,'forced session revocation failure');
      END;`),
      );

      await assert.rejects(
        store.completePasswordReset(
          reset.tokenHash,
          "new-password-hash",
          "new-password-salt",
          now + 100,
        ),
        /forced session revocation failure/i,
      );
      const rolledBack = await store.userByEmail(account.email);
      assert.equal(rolledBack.password_hash, account.passwordHash);
      assert.equal(rolledBack.password_salt, account.passwordSalt);
      assert.equal(rolledBack.email_verified_at, null);
      assert.equal(rolledBack.auth_version, 1);
      assert.equal((await store.accountActionByTokenHash(reset.tokenHash)).consumed_at, null);
      assert.ok(await store.session("session-token-one", now + 101));
      assert.ok(await store.session("session-token-two", now + 101));

      inspectDatabase(root, (db) => db.exec("DROP TRIGGER force_reset_rollback"));
      const completedAt = now + 200;
      const completed = await store.completePasswordReset(
        reset.tokenHash,
        "new-password-hash",
        "new-password-salt",
        completedAt,
      );
      assert.equal(completed.auth_version, 2);
      assert.equal(
        completed.email_verified_at,
        completedAt,
        "a reset link proves control of an unverified legacy address",
      );
      const updated = await store.userByEmail(account.email);
      assert.equal(updated.password_hash, "new-password-hash");
      assert.equal(updated.password_salt, "new-password-salt");
      assert.equal(updated.auth_version, 2);
      assert.equal(await store.session("session-token-one", completedAt), null);
      assert.equal(await store.session("session-token-two", completedAt), null);
      assert.equal(await store.accountActionByTokenHash(reset.tokenHash), null);
      assert.equal(
        await store.accountActionByTokenHash(deletion.tokenHash),
        null,
        "reset completion invalidates every outstanding account-action link",
      );
      assert.equal(
        await store.completePasswordReset(
          reset.tokenHash,
          "replay-hash",
          "replay-salt",
          completedAt + 1,
        ),
        null,
      );
      assert.equal((await store.userByEmail(account.email)).password_hash, "new-password-hash");

      assert.equal(
        await store.insertSession(session("stale-version", account.id, completedAt + 2, 1)),
        false,
      );
      assert.equal(
        await store.insertSession(session("fresh-version", account.id, completedAt + 3, 2)),
        true,
      );
      assert.ok(await store.session("session-token-fresh-version", completedAt + 4));
    } finally {
      await close();
    }
  },
);

test(
  "account deletion cascades private data and precisely cleans non-FK email records",
  { concurrency: false },
  async () => {
    const { root, store, close } = await fixture("account-delete-");
    const now = 1_810_200_000_000;
    const target = user("delete-target", now);
    const survivor = user("delete-survivor", now + 1);
    const targetEmailHash = "target-email-hash";
    const targetVerification = verification("target", target.id, target.email, now);
    const survivorVerification = verification("survivor", survivor.id, survivor.email, now + 1);
    const reset = action("target-reset", target.id, "password_reset", now);
    const deletion = action("target-delete", target.id, "account_delete", now + 1);
    try {
      await store.insertUser(target);
      await store.insertUser(survivor);
      await store.insertSession(session("delete-target", target.id, now));
      await store.upsertPlan(target.id, JSON.stringify({ days: ["push"] }), now, 0);
      await store.upsertMonthlyPlan(target.id, JSON.stringify({ days: ["month"] }), now);
      await store.upsertPreferences(target.id, JSON.stringify({ units: "metric" }), now);
      await store.upsertRating(
        target.id,
        "bench-press",
        {
          comfort: 4,
          pump: 5,
          enjoyment: 4,
          stability: 4,
          setup: 3,
          overall: 4,
        },
        now,
        now,
      );
      await store.insertVerification(targetVerification);
      await store.insertVerification(survivorVerification);
      await store.recordVerificationSend({
        id: "verification-send-target",
        emailHash: targetEmailHash,
        challengeId: targetVerification.challengeId,
        generation: 1,
        sentAt: now,
      });
      await store.recordVerificationSend({
        id: "verification-send-survivor",
        emailHash: "survivor-email-hash",
        challengeId: survivorVerification.challengeId,
        generation: 1,
        sentAt: now,
      });
      await store.claimAccountActionSend(
        {
          id: "action-send-target-reset",
          emailHash: targetEmailHash,
          purpose: "password_reset",
          sentAt: now,
        },
        now - 1,
        5,
      );
      await store.claimAccountActionSend(
        {
          id: "action-send-target-delete",
          emailHash: targetEmailHash,
          purpose: "account_delete",
          sentAt: now + 1,
        },
        now - 1,
        5,
      );
      await store.claimAccountActionSend(
        {
          id: "action-send-survivor",
          emailHash: "survivor-email-hash",
          purpose: "account_delete",
          sentAt: now + 1,
        },
        now - 1,
        5,
      );
      await store.insertPendingPurchase(purchase("completed", target.id, now));
      await store.completePurchase("txn-completed", {
        customerId: "ctm-delete",
        completedAt: now + 10,
        updatedAt: now + 10,
      });
      await store.upsertAdjustment({
        adjustmentId: "adj-delete",
        transactionId: "txn-completed",
        action: "refund",
        type: "full",
        status: "pending_approval",
        occurredAt: now + 20,
        updatedAt: now + 20,
      });
      await store.upsertAccountAction(reset);
      await store.upsertAccountAction(deletion);

      assert.deepEqual(await store.deleteAccount(deletion.tokenHash, now + 100, targetEmailHash), {
        status: "deleted",
        user: { id: target.id, email: target.email },
      });
      assert.equal(await store.userById(target.id), null);
      assert.equal(await store.session("session-token-delete-target", now + 101), null);
      assert.equal(await store.plan(target.id), null);
      assert.equal(await store.monthlyPlan(target.id), null);
      assert.equal(await store.preferences(target.id), null);
      assert.deepEqual(await store.ratingsForUser(target.id), []);
      assert.equal(await store.purchaseByTransaction("txn-completed"), null);
      assert.equal(await store.adjustmentById("adj-delete"), null);
      assert.equal(await store.verificationByTokenHash(targetVerification.browserTokenHash), null);
      assert.equal(await store.accountActionByTokenHash(reset.tokenHash), null);
      assert.equal(await store.accountActionByTokenHash(deletion.tokenHash), null);
      assert.deepEqual(await store.deleteAccount(deletion.tokenHash, now + 101, targetEmailHash), {
        status: "invalid",
      });

      const counts = inspectDatabase(root, (db) => ({
        targetVerificationSends: db
          .prepare("SELECT COUNT(*) AS count FROM email_verification_sends WHERE email_hash=?")
          .get(targetEmailHash).count,
        targetActionSends: db
          .prepare("SELECT COUNT(*) AS count FROM account_action_sends WHERE email_hash=?")
          .get(targetEmailHash).count,
        survivorVerificationSends: db
          .prepare(
            "SELECT COUNT(*) AS count FROM email_verification_sends WHERE email_hash='survivor-email-hash'",
          )
          .get().count,
        survivorActionSends: db
          .prepare(
            "SELECT COUNT(*) AS count FROM account_action_sends WHERE email_hash='survivor-email-hash'",
          )
          .get().count,
      }));
      assert.deepEqual(counts, {
        targetVerificationSends: 0,
        targetActionSends: 0,
        survivorVerificationSends: 1,
        survivorActionSends: 1,
      });
      assert.equal((await store.userById(survivor.id)).email, survivor.email);
      assert.ok(await store.verificationByTokenHash(survivorVerification.browserTokenHash));
    } finally {
      await close();
    }
  },
);

test(
  "pending purchases and active checkout claims block deletion while active deletion links block checkout",
  { concurrency: false },
  async () => {
    const { store, close } = await fixture("account-delete-purchase-race-");
    const now = 1_810_300_000_000;
    const pendingUser = user("pending-purchase", now);
    const deletingUser = user("deleting", now + 1);
    const checkoutUser = user("checkout-in-flight", now + 2);
    try {
      await store.insertUser(pendingUser);
      await store.insertSession(session("pending-purchase", pendingUser.id, now));
      await store.insertPendingPurchase(purchase("already-pending", pendingUser.id, now));
      const pendingDeletion = await store.upsertAccountAction(
        action("pending-purchase-delete", pendingUser.id, "account_delete", now + 1),
      );

      assert.equal(await store.pendingPurchasesForUser(pendingUser.id), 1);
      assert.deepEqual(
        await store.deleteAccount(pendingDeletion.token_hash, now + 2, "pending-user-hash"),
        { status: "purchase_pending" },
      );
      assert.ok(await store.userById(pendingUser.id));
      assert.ok(await store.session("session-token-pending-purchase", now + 3));
      assert.ok(await store.accountActionByTokenHash(pendingDeletion.token_hash));
      assert.ok(await store.purchaseByTransaction("txn-already-pending"));

      await store.updatePurchaseStatus("txn-already-pending", "past_due", now + 3);
      assert.equal(
        await store.pendingPurchasesForUser(pendingUser.id),
        1,
        "every nonterminal Paddle status must remain deletion-blocking",
      );
      assert.equal(
        (await store.discoveryAccessSummary(pendingUser.id)).pendingPurchaseCount,
        1,
        "account UI must expose nonterminal payment state",
      );

      await store.updatePurchaseStatus("txn-already-pending", "completed", now + 4);
      assert.equal(
        await store.pendingPurchasesForUser(pendingUser.id),
        1,
        "completed status without a confirmed completion timestamp must remain deletion-blocking",
      );
      assert.equal((await store.discoveryAccessSummary(pendingUser.id)).pendingPurchaseCount, 1);

      await store.completePurchase("txn-already-pending", {
        customerId: "ctm-pending",
        completedAt: now + 5,
        updatedAt: now + 5,
      });
      assert.equal(
        (await store.deleteAccount(pendingDeletion.token_hash, now + 6, "pending-user-hash"))
          .status,
        "deleted",
      );

      await store.insertUser(checkoutUser);
      const checkoutClaim = await store.claimCheckoutCreation({
        userId: checkoutUser.id,
        priceId: PRICE_ID,
        claimId: "claim-in-flight",
        expiresAt: now + 60_000,
        now: now + 10,
      });
      assert.equal(checkoutClaim.claim_id, "claim-in-flight");
      const checkoutDeletion = await store.upsertAccountAction(
        action("checkout-in-flight-delete", checkoutUser.id, "account_delete", now + 11),
      );
      assert.deepEqual(
        await store.deleteAccount(checkoutDeletion.token_hash, now + 12, "checkout-user-hash"),
        { status: "checkout_pending" },
      );
      assert.ok(
        await store.userById(checkoutUser.id),
        "an active checkout claim must preserve the account",
      );
      assert.equal(await store.releaseCheckoutCreation(checkoutUser.id, "wrong-claim"), false);
      assert.deepEqual(
        await store.deleteAccount(checkoutDeletion.token_hash, now + 13, "checkout-user-hash"),
        { status: "checkout_pending" },
      );
      assert.equal(await store.releaseCheckoutCreation(checkoutUser.id, "claim-in-flight"), true);
      assert.equal(
        (await store.deleteAccount(checkoutDeletion.token_hash, now + 14, "checkout-user-hash"))
          .status,
        "deleted",
      );

      await store.insertUser(deletingUser);
      const deletion = await store.upsertAccountAction(
        action("blocks-checkout", deletingUser.id, "account_delete", now + 10),
      );
      assert.equal(
        await store.insertPendingPurchase(purchase("blocked", deletingUser.id, now + 11)),
        null,
      );
      assert.equal(
        await store.claimCheckoutCreation({
          userId: deletingUser.id,
          priceId: PRICE_ID,
          claimId: "blocked-claim",
          expiresAt: now + 60_000,
          now: now + 11,
        }),
        null,
      );
      assert.equal(await store.pendingPurchasesForUser(deletingUser.id), 0);
      assert.equal(await store.cancelAccountDeletion(deletingUser.id), true);
      assert.equal(
        (await store.insertPendingPurchase(purchase("after-cancel", deletingUser.id, now + 12)))
          .transaction_id,
        "txn-after-cancel",
      );
      assert.deepEqual(
        await store.deleteAccount(deletion.token_hash, now + 13, "deleting-user-hash"),
        { status: "invalid" },
      );
    } finally {
      await close();
    }
  },
);

function createPopulated671Database(root, now) {
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
        email_verified_at INTEGER
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
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
      CREATE TABLE email_verification_sends (
        send_id TEXT PRIMARY KEY,
        email_hash TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation >= 1),
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

    db.prepare(
      "INSERT INTO users(id,name,email,password_hash,password_salt,created_at,email_verified_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "legacy-671-user",
      "Legacy 6.7.1",
      "legacy-671@example.test",
      "legacy-hash",
      "legacy-salt",
      now,
      now,
    );
    db.prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)",
    ).run("legacy-671-session", "legacy-671-user", "legacy-csrf", now + 60 * 60 * 1000, now);
    db.prepare("INSERT INTO plans(user_id,plan_json,updated_at) VALUES(?,?,?)").run(
      "legacy-671-user",
      JSON.stringify({ days: ["legacy-day"] }),
      now,
    );
    db.prepare("INSERT INTO preferences(user_id,preferences_json,updated_at) VALUES(?,?,?)").run(
      "legacy-671-user",
      JSON.stringify({ units: "metric" }),
      now,
    );
    db.prepare(
      "INSERT INTO ratings(user_id,exercise_id,comfort,pump,enjoyment,stability,setup,overall,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run("legacy-671-user", "legacy-lift", 5, 4, 5, 4, 3, 5, now, now);
    db.prepare(
      "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,customer_id,paddle_status,completed_at,access_revoked_at,revocation_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)",
    ).run(
      "legacy-671-transaction",
      "legacy-671-user",
      PRICE_ID,
      PRODUCT_ID,
      "legacy-customer",
      "completed",
      now,
      now,
      now,
    );
    db.prepare(
      "INSERT INTO signup_verifications(challenge_id,browser_token_hash,user_id,purpose,email,name,password_hash,password_salt,code_digest,generation,attempts_used,send_count,last_sent_at,expires_at,hard_expires_at,delivery_state,consumed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)",
    ).run(
      "legacy-671-challenge",
      "legacy-671-browser",
      "legacy-671-user",
      "login",
      "legacy-671@example.test",
      "",
      "",
      "",
      "legacy-digest",
      1,
      0,
      1,
      now,
      now + 10 * 60 * 1000,
      now + 24 * 60 * 60 * 1000,
      "sent",
      now,
      now,
    );
  } finally {
    db.close();
  }
}

test(
  "a populated 6.7.1 database migrates additively and idempotently",
  { concurrency: false },
  async () => {
    const root = testDirectory("account-action-migration-");
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
    const now = 1_810_400_000_000;
    let store;
    try {
      createPopulated671Database(root, now);
      store = await createStore(root);

      const migratedUser = await store.userByEmail("legacy-671@example.test");
      assert.equal(migratedUser.auth_version, 1);
      assert.equal(migratedUser.password_hash, "legacy-hash");
      const migratedSession = await store.session("legacy-671-session", now + 1);
      assert.equal(migratedSession.id, "legacy-671-user");
      assert.equal(migratedSession.auth_version, 1);
      assert.deepEqual(JSON.parse((await store.plan("legacy-671-user")).plan_json), {
        days: ["legacy-day"],
      });
      assert.deepEqual(JSON.parse((await store.preferences("legacy-671-user")).preferences_json), {
        units: "metric",
      });
      assert.equal((await store.ratingsForUser("legacy-671-user"))[0].exercise_id, "legacy-lift");
      assert.equal(await store.hasDiscoveryAccess("legacy-671-user", PRICE_ID), true);
      assert.equal(
        (await store.verificationByTokenHash("legacy-671-browser")).challenge_id,
        "legacy-671-challenge",
      );

      const migratedAction = await store.upsertAccountAction(
        action("after-migration", "legacy-671-user", "password_reset", now + 2),
      );
      assert.equal(migratedAction.user_id, "legacy-671-user");
      await store.close();
      store = await createStore(root);
      assert.equal(
        (await store.accountActionByTokenHash("action-token-after-migration")).request_id,
        "request-after-migration",
      );
      assert.ok(await store.session("legacy-671-session", now + 3));

      const schema = inspectDatabase(root, (db) => ({
        userColumns: db
          .prepare("PRAGMA table_info(users)")
          .all()
          .map((row) => row.name),
        sessionColumns: db
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .map((row) => row.name),
        actionColumns: db
          .prepare("PRAGMA table_info(account_action_requests)")
          .all()
          .map((row) => row.name),
        sendColumns: db
          .prepare("PRAGMA table_info(account_action_sends)")
          .all()
          .map((row) => row.name),
        sessionVersion: db
          .prepare("SELECT auth_version FROM sessions WHERE token_hash='legacy-671-session'")
          .get().auth_version,
      }));
      assert.ok(schema.userColumns.includes("auth_version"));
      assert.ok(schema.sessionColumns.includes("auth_version"));
      assert.deepEqual(schema.actionColumns, [
        "request_id",
        "user_id",
        "purpose",
        "token_hash",
        "expires_at",
        "delivery_state",
        "consumed_at",
        "created_at",
        "updated_at",
      ]);
      assert.deepEqual(schema.sendColumns, ["send_id", "email_hash", "purpose", "sent_at"]);
      assert.equal(schema.sessionVersion, 1);
    } finally {
      if (store) await store.close();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
