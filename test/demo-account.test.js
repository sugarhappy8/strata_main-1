"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { createStore } = require("../src/database");
const { hashPassword } = require("../src/auth");
const { planStats } = require("../src/plans");
const {
  HISTORY_DAYS,
  createDemoAccount,
  demoNights,
  demoPlan,
  demoWorkouts,
  parseArgs,
} = require("../scripts/demo-account");

const ROOT = join(__dirname, ".."),
  RUNTIME = join(ROOT, "test-runtime");
const NOW = Date.parse("2026-10-03T12:00:00Z");
const DEMO = "demo@example.test";

async function localStore() {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, "demo-account-"));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  };
  process.env.NODE_ENV = "test";
  process.env.STRATA_DATA_DIR = directory;
  delete process.env.TURSO_DATABASE_URL;
  const store = await createStore(ROOT);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return {
    store,
    async close() {
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the demo month is a full four-day week, progressing workouts, and one poor night", () => {
  const plan = demoPlan();
  assert.deepEqual(planStats(plan), { planCount: 18, workoutDays: 4 });
  assert.deepEqual(plan.restDays, ["Wednesday", "Saturday", "Sunday"]);
  const workouts = demoWorkouts(NOW);
  assert.equal(workouts.length, 15, "four weeks of four sessions, less one missed session");
  assert.ok(workouts.every((workout) => workout.status === "completed"));
  assert.ok(workouts.every((workout) => workout.startedAt < NOW && workout.completedAt < NOW));
  const bench = workouts
    .filter((workout) => workout.planDay === "Monday")
    .map((workout) => workout.entries[0].sets[0].weight);
  assert.deepEqual(
    bench,
    [...bench].sort((left, right) => left - right),
    "loads only go up",
  );
  assert.ok(bench.at(-1) > bench[0]);
  assert.deepEqual(demoWorkouts(NOW), workouts, "every run produces the same month");
  const nights = demoNights(NOW);
  assert.equal(nights.length, HISTORY_DAYS);
  assert.equal(nights.at(-1).nightDate, "2026-10-03", "the last night ends this morning");
  assert.equal(nights.filter((night) => night.recoveryStatus <= 2).length, 1);
});

test("the demo account is created verified, with its data and the derived records", async () => {
  const { store, close } = await localStore();
  try {
    const env = {
      STRATA_INTERNAL_ACCOUNTS: `other@example.test, ${DEMO}`,
      DEVICE_TOKEN_KEY: randomBytes(32).toString("base64"),
    };
    const result = await createDemoAccount({
      store,
      email: "Demo@Example.test",
      password: "demo-password-123",
      env,
      now: NOW,
    });
    assert.deepEqual(
      {
        email: result.email,
        workouts: result.workouts,
        nights: result.nights,
        polar: result.polar,
      },
      { email: DEMO, workouts: 15, nights: 28, polar: true },
    );
    const user = await store.userByEmail(DEMO);
    assert.ok(user.email_verified_at);
    assert.equal(
      await hashPassword("demo-password-123", user.password_salt),
      user.password_hash,
      "the demo signs in with the given password",
    );
    assert.equal(planStats(JSON.parse((await store.plan(user.id)).plan_json)).workoutDays, 4);
    const history = await store.accountExport(user.id);
    assert.equal(history.checkIns.length, 8);
    assert.equal(history.planChanges.length, 1, "the setup save is in the plan history");
    assert.ok(history.dailySnapshots.length >= 15, "the event reactions built Daily Snapshots");
    assert.equal(history.wellnessNights.length, 28);
    const connection = await store.deviceConnection(user.id, "polar");
    assert.equal(connection.status, "active");
    assert.ok(
      Number(connection.next_sync_at) > NOW + 300 * 24 * 60 * 60 * 1000,
      "never due for a sync",
    );
    await assert.rejects(
      createDemoAccount({ store, email: DEMO, password: "demo-password-123", env, now: NOW }),
      /already exists/,
    );
  } finally {
    await close();
  }
});

test("the demo script refuses any address that could be a real member", async () => {
  const { store, close } = await localStore();
  try {
    const attempt = (email, env, password = "demo-password-123") =>
      createDemoAccount({ store, email, password, env, now: NOW });
    await assert.rejects(attempt("", {}), /--email/);
    await assert.rejects(attempt(DEMO, {}), /STRATA_INTERNAL_ACCOUNTS/);
    await assert.rejects(
      attempt(DEMO, { STRATA_INTERNAL_ACCOUNTS: DEMO, ADMIN_EMAIL: "DEMO@example.test" }),
      /owner/,
    );
    await assert.rejects(
      attempt(DEMO, { STRATA_INTERNAL_ACCOUNTS: DEMO }, "short"),
      /12 characters/,
    );
    assert.equal(await store.userByEmail(DEMO), null);
    const plain = await attempt(DEMO, { STRATA_INTERNAL_ACCOUNTS: DEMO });
    assert.equal(plain.polar, false, "without DEVICE_TOKEN_KEY there are no Polar nights");
    assert.equal(plain.nights, 0);
  } finally {
    await close();
  }
});

test("the demo script reads only its own options", () => {
  assert.deepEqual(parseArgs(["--email", DEMO, "--name", "Sam", "--yes"]), {
    email: DEMO,
    name: "Sam",
    yes: true,
  });
  assert.throws(() => parseArgs(["--email"]), /needs a value/);
  assert.throws(() => parseArgs(["--email", "--yes"]), /needs a value/);
  assert.throws(() => parseArgs(["--force"]), /Unknown option/);
});
