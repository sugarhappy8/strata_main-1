"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOCK_MS,
  MISSES_BEFORE_WARNING,
  createSingleInstanceGuard,
} = require("../src/single-instance");

/** The locks table's rule: free, expired, or already this holder's. */
function lockStore() {
  const locks = new Map();
  return {
    locks,
    async acquireLock(name, holder, expiresAt, now) {
      const current = locks.get(name);
      if (current && current.holder !== holder && current.expiresAt > now) return false;
      locks.set(name, { holder, expiresAt });
      return true;
    },
    async releaseLock(name, holder) {
      if (locks.get(name)?.holder === holder) locks.delete(name);
    },
  };
}

test("a second server on the same database is logged after it keeps missing the heartbeat, not during a deploy's overlap", async () => {
  let time = 1_000_000;
  const store = lockStore(),
    warnings = [];
  const logger = { warn: (name) => warnings.push(name), error() {} };
  const first = createSingleInstanceGuard({ store, logger, id: "server-a", now: () => time }),
    second = createSingleInstanceGuard({ store, logger, id: "server-b", now: () => time });
  assert.equal(await first.check(), true);
  for (let miss = 1; miss < MISSES_BEFORE_WARNING; miss += 1) {
    assert.equal(await second.check(), false);
    await first.check();
  }
  assert.deepEqual(warnings, [], "a couple of misses can be a deploy");
  await second.check();
  assert.deepEqual(warnings, ["service.multiple_instances"]);
  for (let miss = 0; miss < 20; miss += 1) {
    await first.check();
    await second.check();
  }
  assert.equal(warnings.length, 1, "the warning repeats about hourly, not every minute");

  // A deploy: the old server stops and hands the heartbeat over, so the new one never warns.
  const deployWarnings = [],
    deployStore = lockStore(),
    deployLogger = { warn: (name) => deployWarnings.push(name), error() {} };
  const old = createSingleInstanceGuard({
      store: deployStore,
      logger: deployLogger,
      id: "old",
      now: () => time,
    }),
    fresh = createSingleInstanceGuard({
      store: deployStore,
      logger: deployLogger,
      id: "new",
      now: () => time,
    });
  await old.check();
  assert.equal(await fresh.check(), false);
  await old.stop();
  assert.equal(await fresh.check(), true);
  assert.deepEqual(deployWarnings, []);
  // A server that stopped without handing over is replaced once its heartbeat expires.
  const crashed = createSingleInstanceGuard({
    store: deployStore,
    logger: deployLogger,
    id: "crashed",
    now: () => time,
  });
  assert.equal(await crashed.check(), false);
  time += LOCK_MS + 1;
  assert.equal(await crashed.check(), true);
  await fresh.stop();
});
