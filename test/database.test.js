"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { createStore, plainRow, probeConnection } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");

async function checkoutClaimFixture() {
  const runtimeRoot = join(PROJECT_ROOT, "test-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const root = mkdtempSync(join(runtimeRoot, "claim-cas-"));
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    tursoUrl: process.env.TURSO_DATABASE_URL,
    tursoToken: process.env.TURSO_AUTH_TOKEN,
    dataDir: process.env.STRATA_DATA_DIR,
  };
  process.env.NODE_ENV = "test";
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.STRATA_DATA_DIR;
  const store = await createStore(root);
  await store.insertUser({
    id: "claim-cas-user",
    name: "Claim CAS Tester",
    email: "claim-cas@example.test",
    passwordHash: "claim-cas-password-hash",
    passwordSalt: "claim-cas-password-salt",
    createdAt: 1_000,
  });
  return {
    store,
    async close() {
      await store.close();
      rmSync(root, { recursive: true, force: true });
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
    },
  };
}

test("Turso array rows are mapped with their result-set columns", () => {
  const row = [42n, "Test Lifter", "test@example.test"];
  Object.defineProperties(row, {
    id: { value: 42n, enumerable: false },
    name: { value: "Test Lifter", enumerable: false },
    email: { value: "test@example.test", enumerable: false },
  });

  assert.deepEqual(plainRow(row, ["id", "name", "email"]), {
    id: 42,
    name: "Test Lifter",
    email: "test@example.test",
  });
});

test("ordinary local database rows remain supported", () => {
  assert.deepEqual(plainRow({ id: "user-1", created_at: 123n }), {
    id: "user-1",
    created_at: 123,
  });
});

test("column mapping preserves SQL nulls and the first duplicate name", () => {
  assert.deepEqual(plainRow([null, "later"], ["value", "value"]), { value: null });

  const objectShapedRow = { id: "named-value" };
  assert.deepEqual(plainRow(objectShapedRow, ["id"]), { id: "named-value" });
});

test("database health depends on query success, not returned row shape", async () => {
  assert.equal(await probeConnection(async () => ({ rows: [[1]] })), true);
  assert.equal(await probeConnection(async () => ({ rows: [{ ok: 1 }] })), true);
});

test("database health propagates query failures", async () => {
  await assert.rejects(
    probeConnection(async () => {
      throw new Error("database unavailable");
    }),
    /database unavailable/,
  );
});

test("checkout claim compare-and-swap preserves an attached transaction", async () => {
  const { store, close } = await checkoutClaimFixture();
  try {
    const claim = await store.claimCheckoutCreation({
      userId: "claim-cas-user",
      priceId: "price-one",
      claimId: "claim-one",
      expiresAt: 2_000,
      now: 1_000,
    });
    assert.equal(claim.transaction_id, null);
    const recorded = await store.recordCheckoutCreationTransaction(
      "claim-cas-user",
      "claim-one",
      "txn_attached",
      1_500,
    );
    assert.equal(recorded.transaction_id, "txn_attached");

    assert.equal(await store.releaseCheckoutCreation("claim-cas-user", "claim-one"), false);
    assert.equal(
      await store.releaseCheckoutCreation("claim-cas-user", "claim-one", "txn_other"),
      false,
    );
    assert.equal(
      await store.claimCheckoutCreation({
        userId: "claim-cas-user",
        priceId: "price-two",
        claimId: "claim-two",
        expiresAt: 3_000,
        now: 2_000,
      }),
      null,
      "expiry alone must not replace a claim after its provider transaction is recorded",
    );
    assert.deepEqual(await store.checkoutCreationForUser("claim-cas-user"), recorded);

    assert.equal(
      await store.releaseCheckoutCreation("claim-cas-user", "claim-one", "txn_attached"),
      true,
    );
    const unbound = await store.claimCheckoutCreation({
      userId: "claim-cas-user",
      priceId: "price-one",
      claimId: "claim-three",
      expiresAt: 4_000,
      now: 3_000,
    });
    assert.equal(unbound.transaction_id, null);
    const replacement = await store.claimCheckoutCreation({
      userId: "claim-cas-user",
      priceId: "price-two",
      claimId: "claim-four",
      expiresAt: 5_000,
      now: 4_000,
    });
    assert.equal(
      replacement.claim_id,
      "claim-four",
      "an expired transaction-less claim remains replaceable",
    );
    assert.equal(await store.releaseCheckoutCreation("claim-cas-user", "claim-four"), true);
  } finally {
    await close();
  }
});
