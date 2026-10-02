"use strict";

// Server state kept in the database behaves the same on SQLite and Turso: the event outbox's due, lease, spacing,
// failure, and cleanup rules, and the trigger that removes a deleted member's queued reactions.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { createStore } = require("../src/database");
const { fakeTursoFactory } = require("./support/workout-fixtures");

const ROOT = join(__dirname, ".."),
  RUNTIME = join(ROOT, "test-runtime");

async function stores() {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, "server-state-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  try {
    process.env.NODE_ENV = "test";
    process.env.STRATA_DATA_DIR = directory;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    const local = await createStore(ROOT);
    delete process.env.STRATA_DATA_DIR;
    process.env.TURSO_DATABASE_URL = "https://server-state.invalid";
    process.env.TURSO_AUTH_TOKEN = "test-token";
    const turso = await createStore(ROOT, { tursoClientFactory: fakeTursoFactory() });
    return {
      list: [local, turso],
      async close() {
        await Promise.all([local.close(), turso.close()]);
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const record = (id, extra = {}) => ({
  id,
  eventName: "workout.completed",
  handlerKey: "snapshots.workout_completed",
  userId: "outbox-user",
  payloadJson: JSON.stringify({ userId: "outbox-user" }),
  attempts: 1,
  attemptedAt: 1_000,
  nextAttemptAt: 31_000,
  lastError: "SQLITE_BUSY",
  createdAt: 1_000,
  ...extra,
});

test(
  "SQLite and Turso keep the event outbox's due, lease, spacing, and failure rules",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      for (const store of pair.list) {
        await store.insertUser({
          id: "outbox-user",
          name: "Outbox",
          email: `outbox-${store.kind}@example.test`,
          passwordHash: "hash",
          passwordSalt: "salt",
          createdAt: 1,
          emailVerifiedAt: 1,
        });
        await store.addOutboxEvent(record("first"));
        await store.addOutboxEvent(
          record("second", { createdAt: 2_000, attemptedAt: 2_000, nextAttemptAt: 32_000 }),
        );
        await store.addOutboxEvent(
          record("system", { userId: null, createdAt: 3_000, nextAttemptAt: 33_000 }),
        );
        assert.deepEqual(
          (await store.dueOutboxEvents(30_999, 10)).map((row) => row.id),
          [],
          "not before the backoff",
        );
        assert.deepEqual(
          (await store.dueOutboxEvents(32_000, 10)).map((row) => row.id),
          ["first", "second"],
        );
        assert.deepEqual(
          { ...(await store.dueOutboxEvents(31_000, 1))[0] },
          {
            id: "first",
            event_name: "workout.completed",
            handler_key: "snapshots.workout_completed",
            user_id: "outbox-user",
            payload_json: '{"userId":"outbox-user"}',
            attempts: 1,
          },
        );
        assert.deepEqual(
          (await store.userOutboxEvents("outbox-user", 5_000, 1_500, 10)).map((row) => row.id),
          ["first"],
          "a read retries only rows tried long enough ago",
        );

        assert.equal(await store.claimOutboxEvent("first", 40_000, 160_000), true);
        assert.equal(
          await store.claimOutboxEvent("first", 40_000, 160_000),
          false,
          "a leased row cannot be claimed again",
        );
        assert.deepEqual(
          (await store.dueOutboxEvents(50_000, 10)).map((row) => row.id),
          ["second", "system"],
          "nor is it due while leased",
        );
        assert.equal(
          await store.claimOutboxEvent("first", 160_000, 280_000),
          true,
          "an expired lease can be taken over",
        );

        await store.failOutboxEvent("first", {
          attempts: 2,
          attemptedAt: 160_000,
          nextAttemptAt: 220_000,
          lastError: "SQLITE_BUSY",
          gaveUpAt: null,
        });
        assert.deepEqual(
          (await store.dueOutboxEvents(219_999, 10)).map((row) => row.id),
          ["second", "system"],
        );
        assert.equal(
          (await store.dueOutboxEvents(220_000, 10)).find((row) => row.id === "first")?.attempts,
          2,
          "the failure released the lease and set the next try",
        );
        await store.failOutboxEvent("second", {
          attempts: 12,
          attemptedAt: 50_000,
          nextAttemptAt: 99_000_000,
          lastError: "Error",
          gaveUpAt: 50_000,
        });
        assert.equal(
          await store.claimOutboxEvent("second", 100_000_000, 100_100_000),
          false,
          "a given-up row is never claimed",
        );
        await store.deleteOldOutboxEvents(50_000);
        assert.equal(
          (await store.userOutboxEvents("outbox-user", 1e12, 1e12, 10)).length,
          1,
          "the given-up row is not listed",
        );
        await store.deleteOldOutboxEvents(50_001);
        await store.completeOutboxEvent("first");
        assert.deepEqual(
          (await store.dueOutboxEvents(1e12, 10)).map((row) => row.id),
          ["system"],
        );

        // Deleting the member removes their queued reactions, however the account is deleted.
        await store.addOutboxEvent(record("member-row"));
        await store.upsertAccountAction({
          requestId: `delete-${store.kind}`,
          userId: "outbox-user",
          purpose: "account_delete",
          tokenHash: `outbox-delete-${store.kind}`,
          expiresAt: 1e12,
          deliveryState: "sent",
          createdAt: 1,
          updatedAt: 1,
        });
        assert.equal(
          (await store.deleteAccount(`outbox-delete-${store.kind}`, 2, "hash")).status,
          "deleted",
        );
        assert.deepEqual(
          (await store.dueOutboxEvents(1e12, 10)).map((row) => row.id),
          ["system"],
          "only the reaction without a member remains",
        );
      }
    } finally {
      await pair.close();
    }
  },
);

test(
  "a failed snapshot rebuild waits in the outbox and is healed by the member's next read",
  { concurrency: false },
  async () => {
    const { createEventBus } = require("../src/events"),
      { createDataService } = require("../src/data-service");
    const pair = await stores();
    try {
      const [local] = pair.list;
      let time = Date.parse("2030-03-05T12:00:00Z"),
        failNext = false;
      const store = Object.create(local);
      // The snapshot write fails once, as a busy database or a dropped Turso connection would.
      store.upsertDailySnapshot = async (...args) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        }
        return local.upsertDailySnapshot(...args);
      };
      const events = createEventBus({ outbox: local, now: () => time });
      const data = createDataService({
        store,
        events,
        getPlan: async () => null,
        coachingProfile: async () => null,
        requireSession: async () => null,
        requireFeature: () => async () => null,
        http: { json() {} },
        now: () => time,
      });
      await local.insertUser({
        id: "heal-user",
        name: "Heal",
        email: "heal@example.test",
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: 1,
        emailVerifiedAt: 1,
      });
      const range = { from: "2030-03-04", to: "2030-03-04", today: "2030-03-05" };
      assert.equal(
        (await data.snapshots.read("heal-user", range))[0].nutrition,
        null,
        "yesterday is built with no diary yet",
      );

      await local.upsertCoachingDailyLog(
        {
          userId: "heal-user",
          logDate: "2030-03-04",
          calories: 2100,
          proteinG: null,
          carbsG: null,
          fatG: null,
          morningWeightKg: null,
          complete: null,
          updatedAt: time,
        },
        0,
      );
      failNext = true;
      await events.emit("coaching.log_saved", { userId: "heal-user", date: "2030-03-04" });
      assert.equal(
        (await local.userOutboxEvents("heal-user", time, time, 10)).length,
        1,
        "the failed rebuild is queued",
      );
      assert.equal(
        (await data.snapshots.read("heal-user", range))[0].nutrition,
        null,
        "straight away the row is still stale",
      );

      time += 15_000;
      assert.equal(
        (await data.snapshots.read("heal-user", range))[0].nutrition.calories,
        2100,
        "the next read retried the rebuild first",
      );
      assert.equal((await local.dueOutboxEvents(1e15, 10)).length, 0, "and it left the outbox");
    } finally {
      await pair.close();
    }
  },
);

test(
  "SQLite and Turso take rate slots with one conditional write per fixed window",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      for (const store of pair.list) {
        const key = "a".repeat(64),
          other = "b".repeat(64),
          taken = [];
        for (let index = 0; index < 4; index += 1)
          taken.push(await store.takeRateSlot(key, 3, 60_000, 1_000 + index));
        assert.deepEqual(
          taken,
          [true, true, true, false],
          "the fourth request in the window is refused",
        );
        assert.equal(
          await store.takeRateSlot(other, 3, 60_000, 1_010),
          true,
          "keys are counted apart",
        );
        assert.equal(
          await store.takeRateSlot(key, 3, 60_000, 60_999),
          false,
          "still the same window",
        );
        assert.equal(
          await store.takeRateSlot(key, 3, 60_000, 61_000),
          true,
          "an expired window starts again at one",
        );
        assert.deepEqual(
          [
            await store.takeRateSlot(key, 3, 60_000, 61_001),
            await store.takeRateSlot(key, 3, 60_000, 61_002),
            await store.takeRateSlot(key, 3, 60_000, 61_003),
          ],
          [true, true, false],
        );
        await store.deleteOldRateBuckets(61_000);
        assert.equal(
          await store.takeRateSlot(other, 3, 60_000, 61_004),
          true,
          "the old bucket was removed and starts over",
        );
        await assert.rejects(
          store.takeRateSlot("raw-email@example.test", 3, 60_000, 1),
          /CHECK constraint/i,
          "only hashed keys are stored",
        );
      }
    } finally {
      await pair.close();
    }
  },
);

test(
  "SQLite and Turso give a lock to one holder until it expires or is released",
  { concurrency: false },
  async () => {
    const pair = await stores();
    try {
      for (const store of pair.list) {
        assert.equal(await store.acquireLock("polar-sync", "server-a", 10_000, 1_000), true);
        assert.equal(
          await store.acquireLock("polar-sync", "server-b", 11_000, 2_000),
          false,
          "held by another server",
        );
        assert.equal(
          await store.acquireLock("polar-sync", "server-a", 12_000, 3_000),
          true,
          "the holder renews it",
        );
        assert.equal(await store.acquireLock("polar-sync", "server-b", 13_000, 11_999), false);
        assert.equal(
          await store.acquireLock("polar-sync", "server-b", 20_000, 12_000),
          true,
          "an expired lock can be taken over",
        );
        await store.releaseLock("polar-sync", "server-a");
        assert.equal(
          await store.acquireLock("polar-sync", "server-a", 21_000, 13_000),
          false,
          "only the holder can release it",
        );
        await store.releaseLock("polar-sync", "server-b");
        assert.equal(await store.acquireLock("polar-sync", "server-a", 21_000, 13_000), true);
      }
    } finally {
      await pair.close();
    }
  },
);
