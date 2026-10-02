"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EVENT_NAMES, MAX_ATTEMPTS, backoff, createEventBus } = require("../src/events");

test("the event bus awaits handlers in order, isolates failures, and rejects unknown names", async () => {
  const logged = [],
    bus = createEventBus({
      logger: { error: (name, detail) => logged.push([name, detail.event]) },
    });
  const seen = [];
  bus.on("plan.updated", async (payload) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(["first", payload.userId, payload.event]);
  });
  bus.on("plan.updated", () => {
    throw new Error("boom");
  });
  const off = bus.on("plan.updated", (payload) => seen.push(["third", payload.userId]));
  assert.equal(
    await bus.emit("plan.updated", { userId: "u1" }),
    2,
    "two handlers delivered, one failed",
  );
  assert.deepEqual(seen, [
    ["first", "u1", "plan.updated"],
    ["third", "u1"],
  ]);
  assert.deepEqual(logged, [["event.handler_failed", "plan.updated"]]);
  off();
  assert.equal(await bus.emit("plan.updated", { userId: "u2" }), 1);
  assert.equal(await bus.emit("workout.saved", {}), 0, "an event nobody listens to is still fine");
  assert.throws(() => bus.on("made.up", () => {}), /Unknown event/);
  await assert.rejects(() => bus.emit("made.up"), /Unknown event/);
  assert.throws(() => bus.on("plan.updated", "nope"), TypeError);
  assert.deepEqual(
    [...EVENT_NAMES],
    [
      "plan.updated",
      "workout.saved",
      "workout.completed",
      "preferences.saved",
      "coaching.profile_saved",
      "coaching.log_saved",
      "polar.sync.finished",
      "polar.data_deleted",
      "snapshot.ready",
    ],
  );
  assert.ok(Object.isFrozen(bus));
});

/** The outbox contract in memory, with the same lease, due, and spacing rules as the database. */
function memoryOutbox() {
  const rows = new Map();
  const view = (row) => ({
    id: row.id,
    event_name: row.eventName,
    handler_key: row.handlerKey,
    user_id: row.userId,
    payload_json: row.payloadJson,
    attempts: row.attempts,
  });
  return {
    rows,
    async addOutboxEvent(record) {
      rows.set(record.id, { ...record, leaseUntil: 0, gaveUpAt: null });
    },
    async dueOutboxEvents(now, limit) {
      return [...rows.values()]
        .filter((row) => row.gaveUpAt === null && row.nextAttemptAt <= now && row.leaseUntil <= now)
        .slice(0, limit)
        .map(view);
    },
    async userOutboxEvents(userId, now, attemptedBefore, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.userId === userId &&
            row.gaveUpAt === null &&
            row.leaseUntil <= now &&
            row.attemptedAt <= attemptedBefore,
        )
        .slice(0, limit)
        .map(view);
    },
    async claimOutboxEvent(id, now, leaseUntil) {
      const row = rows.get(id);
      if (!row || row.gaveUpAt !== null || row.leaseUntil > now) return false;
      row.leaseUntil = leaseUntil;
      return true;
    },
    async completeOutboxEvent(id) {
      rows.delete(id);
    },
    async failOutboxEvent(id, failure) {
      Object.assign(rows.get(id), failure, { leaseUntil: 0 });
    },
    async deleteOldOutboxEvents(before) {
      for (const [id, row] of rows)
        if (row.gaveUpAt !== null && row.gaveUpAt < before) rows.delete(id);
    },
  };
}

test("a failed reaction is kept in the outbox and retried with backoff until it succeeds", async () => {
  let time = 1_000_000,
    failures = 2,
    ids = 0;
  const outbox = memoryOutbox(),
    logged = [],
    calls = [];
  const bus = createEventBus({
    outbox,
    now: () => time,
    makeId: () => `row-${++ids}`,
    logger: {
      error: (name) => logged.push(name),
      warn: (name) => logged.push(name),
      info: (name) => logged.push(name),
    },
  });
  bus.on(
    "workout.completed",
    (payload) => {
      calls.push(payload.userId);
      if (failures-- > 0)
        throw Object.assign(new Error("database is locked for member@example.test"), {
          code: "SQLITE_BUSY",
        });
    },
    "snapshots.workout_completed",
  );
  bus.on("workout.completed", () => {}, "training_log.workout_completed");
  assert.equal(
    await bus.emit("workout.completed", { userId: "u1", workout: { date: "2030-01-01" } }),
    1,
  );
  assert.equal(outbox.rows.size, 1, "only the failed handler is queued, not the whole event");
  const [row] = outbox.rows.values();
  assert.deepEqual(
    {
      key: row.handlerKey,
      user: row.userId,
      attempts: row.attempts,
      next: row.nextAttemptAt - time,
      error: row.lastError,
    },
    {
      key: "snapshots.workout_completed",
      user: "u1",
      attempts: 1,
      next: 30_000,
      error: "SQLITE_BUSY",
    },
    "the error is stored by code, never by its message",
  );
  assert.equal(await bus.retryDue(), 0, "nothing is retried before its backoff passes");
  time += 30_000;
  assert.equal(await bus.retryDue(), 0);
  assert.deepEqual(
    { attempts: row.attempts, next: row.nextAttemptAt - time },
    { attempts: 2, next: 60_000 },
    "each failure doubles the wait",
  );
  time += 60_000;
  assert.equal(await bus.retryDue(), 1);
  assert.equal(outbox.rows.size, 0, "a reaction that succeeds leaves the outbox");
  assert.deepEqual(calls, ["u1", "u1", "u1"]);
  assert.deepEqual(logged, ["event.handler_failed", "event.retry_failed", "event.retry_succeeded"]);
  assert.deepEqual([backoff(1), backoff(2), backoff(20)], [30_000, 60_000, 6 * 60 * 60 * 1000]);
});

test("a reaction that keeps failing gives up after the last attempt and is cleaned up later", async () => {
  let time = 0;
  const outbox = memoryOutbox(),
    logged = [];
  const bus = createEventBus({
    outbox,
    now: () => time,
    logger: { error: (name) => logged.push(name), warn() {}, info() {} },
  });
  bus.on(
    "plan.updated",
    () => {
      throw new Error("always");
    },
    "plan_changes.record",
  );
  await bus.emit("plan.updated", { userId: "u1" });
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    time += backoff(attempt);
    await bus.retryDue();
  }
  const [row] = outbox.rows.values();
  assert.equal(row.attempts, MAX_ATTEMPTS);
  assert.equal(row.gaveUpAt, time);
  assert.equal(logged.at(-1), "event.retry_gave_up");
  time += 7 * 24 * 60 * 60 * 1000;
  assert.equal(await bus.retryDue(), 0, "a given-up reaction is not retried");
  await bus.cleanup();
  assert.equal(outbox.rows.size, 1, "kept for a while for inspection");
  time += 30 * 24 * 60 * 60 * 1000;
  await bus.cleanup();
  assert.equal(outbox.rows.size, 0);
});

test("a member's read retries only that member's queued reactions, at most once per spacing interval", async () => {
  let time = 0,
    healthy = false;
  const outbox = memoryOutbox(),
    seen = [];
  const bus = createEventBus({ outbox, now: () => time });
  bus.on(
    "coaching.log_saved",
    (payload) => {
      seen.push(payload.userId);
      if (!healthy) throw new Error("down");
    },
    "snapshots.coaching_log",
  );
  await bus.emit("coaching.log_saved", { userId: "u1", date: "2030-01-01" });
  await bus.emit("coaching.log_saved", { userId: "u2", date: "2030-01-01" });
  assert.equal(await bus.retryFor("u1"), 0, "just failed: too soon to try again on a read");
  time += 15_000;
  healthy = true;
  assert.equal(await bus.retryFor("u1"), 1);
  assert.deepEqual(
    seen,
    ["u1", "u2", "u1"],
    "the other member's reaction waits for its own read or the timer",
  );
  assert.deepEqual(
    [...outbox.rows.values()].map((row) => row.userId),
    ["u2"],
  );
});

test("a lease lets only one retry run a reaction, and a reaction whose handler is gone is dropped", async () => {
  const time = 100_000;
  const outbox = memoryOutbox();
  let running = 0,
    peak = 0;
  const bus = createEventBus({ outbox, now: () => time });
  await outbox.addOutboxEvent({
    id: "a",
    eventName: "plan.updated",
    handlerKey: "slow",
    userId: "u1",
    payloadJson: "{}",
    attempts: 1,
    attemptedAt: 0,
    nextAttemptAt: 0,
    lastError: "x",
    createdAt: 0,
  });
  await outbox.addOutboxEvent({
    id: "b",
    eventName: "plan.updated",
    handlerKey: "removed.in.this.build",
    userId: "u1",
    payloadJson: "{}",
    attempts: 1,
    attemptedAt: 0,
    nextAttemptAt: 0,
    lastError: "x",
    createdAt: 0,
  });
  bus.on(
    "plan.updated",
    async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    },
    "slow",
  );
  const results = await Promise.all([bus.retryDue(), bus.retryDue(), bus.retryFor("u1")]);
  assert.equal(
    results.reduce((sum, value) => sum + value, 0),
    1,
    "the reaction ran once",
  );
  assert.equal(peak, 1);
  assert.equal(outbox.rows.size, 0);
  assert.throws(() => bus.on("plan.updated", () => {}, "slow"), /already registered/);
});
