"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Activation = require("../public/scripts/activation-core");

class MemoryStorage {
  constructor(entries = []) {
    this.values = new Map(entries);
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

function week(id = "device-entry", exerciseId = "dumbbell-bench-press") {
  return {
    version: 1,
    restDay: "Sunday",
    restDays: ["Sunday"],
    days: Object.fromEntries(
      Activation.DAYS.map((day) => [
        day,
        day === "Monday" ? [{ instanceId: id, exerciseId, sets: 3, reps: "8–12" }] : [],
      ]),
    ),
  };
}
function profile() {
  return {
    version: 1,
    goal: "hypertrophy",
    level: "Intermediate",
    minutes: 35,
    equipment: ["Dumbbells"],
    availability: ["Monday", "Wednesday", "Friday"],
    preferences: ["simple-setup"],
    limitations: [],
    focusGroup: "chest",
  };
}

test("activation intent keeps a complete validated profile and exact generated week on the device", () => {
  const storage = new MemoryStorage(),
    plan = week();
  const saved = Activation.writeIntent(
    storage,
    { source: "homepage", profile: profile(), plan },
    1_700_000_000_000,
  );
  assert.equal(saved.format, "strata-activation-intent");
  assert.deepEqual(saved.plan, plan);
  assert.deepEqual(Activation.readIntent(storage), saved);
  plan.days.Monday[0].reps = "1";
  assert.equal(
    Activation.readIntent(storage).plan.days.Monday[0].reps,
    "8–12",
    "the stored candidate is isolated from later caller mutations",
  );
});

test("malformed, oversized, and internally conflicting device weeks are ignored", () => {
  const valid = week();
  assert.equal(Activation.normalizePlan({ ...valid, restDay: "Saturday" }), null);
  assert.equal(
    Activation.normalizePlan({
      ...valid,
      days: {
        ...valid.days,
        Monday: Array.from({ length: 31 }, (_, index) => ({
          instanceId: `entry-${index}`,
          exerciseId: "bench-press",
          sets: 3,
          reps: "8",
        })),
      },
    }),
    null,
  );
  assert.equal(
    Activation.normalizePlan({ ...valid, days: { ...valid.days, Sunday: valid.days.Monday } }),
    null,
  );
  assert.equal(
    Activation.normalizePlan({
      ...valid,
      days: { ...valid.days, Monday: [valid.days.Monday[0], valid.days.Monday[0]] },
    }),
    null,
  );
  assert.equal(Activation.normalizePlan({ ...valid, restDays: ["Sunday", "Notaday"] }), null);
  assert.equal(
    Activation.normalizePlan({
      ...valid,
      days: { ...valid.days, Monday: [{ ...valid.days.Monday[0], sets: "3" }] },
    }),
    null,
  );
  const storage = new MemoryStorage([[Activation.INTENT_KEY, "{broken"]]);
  assert.equal(Activation.readIntent(storage), null);
});

test("homepage and free-planner candidates remain separate unless their exact weeks match", () => {
  const storage = new MemoryStorage();
  Activation.writeIntent(storage, { profile: profile(), plan: week("home-entry") }, 100);
  storage.setItem(
    Activation.GUEST_PLAN_KEY,
    JSON.stringify(week("guest-entry", "incline-dumbbell-press")),
  );
  assert.deepEqual(
    Activation.deviceCandidates(storage).map((candidate) => candidate.id),
    ["homepage", "guest"],
  );
  storage.setItem(Activation.GUEST_PLAN_KEY, JSON.stringify(week("home-entry")));
  assert.deepEqual(
    Activation.deviceCandidates(storage).map((candidate) => candidate.id),
    ["homepage"],
    "identical local copies do not create a fake choice",
  );
});

test("claim and keep decisions are revision and content scoped", () => {
  const storage = new MemoryStorage(),
    account = week("account-entry", "barbell-row"),
    candidate = { source: "homepage", plan: week(), profile: profile() };
  const offer = { userId: "user / 1", accountRevision: 11, accountPlan: account, candidate };
  assert.equal(Activation.shouldOffer(storage, offer), true);
  Activation.acknowledge(storage, { ...offer, decision: "kept-account" }, 200);
  assert.equal(Activation.shouldOffer(storage, offer), false);
  assert.equal(
    Activation.shouldOffer(storage, { ...offer, accountRevision: 12 }),
    true,
    "a newer server revision must be compared again",
  );
  assert.equal(
    Activation.shouldOffer(storage, {
      ...offer,
      candidate: { ...candidate, plan: week("changed-entry", "cable-row") },
    }),
    true,
    "a changed device week must be compared again",
  );
  assert.equal(
    Activation.shouldOffer(storage, { ...offer, userId: "another-user" }),
    true,
    "one account's decision cannot suppress another account's choice",
  );
});

test("a local safety backup captures both versions before replacement without deleting either source", () => {
  const account = week("account-entry", "barbell-row"),
    device = week(),
    storage = new MemoryStorage([[Activation.GUEST_PLAN_KEY, JSON.stringify(device)]]),
    candidate = { source: "guest", plan: device };
  const before = storage.getItem(Activation.GUEST_PLAN_KEY);
  const result = Activation.backup(
    storage,
    { userId: "user-1", accountRevision: 42, accountPlan: account, candidate, reason: "claim" },
    300,
  );
  assert.match(result.key, /^strata_activation_backup_v1:user-1:300-/);
  assert.deepEqual(result.value.accountPlan, account);
  assert.deepEqual(result.value.devicePlan, device);
  assert.equal(result.value.accountRevision, 42);
  assert.equal(
    storage.getItem(Activation.GUEST_PLAN_KEY),
    before,
    "backing up never consumes the free device week",
  );
});

test("local safety backups keep only the newest three per account", () => {
  class ListedStorage extends MemoryStorage {
    get length() {
      return this.values.size;
    }
    key(index) {
      return [...this.values.keys()][index] ?? null;
    }
  }
  const storage = new ListedStorage([["strata_activation_backup_v1:user-2:5-other", "{}"]]),
    account = week("account-entry", "barbell-row"),
    candidate = { source: "guest", plan: week() };
  for (const stamp of [100, 400, 200, 300, 500])
    Activation.backup(
      storage,
      { userId: "user-1", accountPlan: account, candidate, reason: "claim" },
      stamp,
    );
  const kept = [...storage.values.keys()]
    .filter((key) => key.startsWith("strata_activation_backup_v1:user-1:"))
    .map((key) => Number.parseInt(key.split(":")[2], 10))
    .sort((a, b) => a - b);
  assert.deepEqual(kept, [300, 400, 500]);
  assert.equal(
    storage.getItem("strata_activation_backup_v1:user-2:5-other"),
    "{}",
    "another account's backup is untouched",
  );
});
