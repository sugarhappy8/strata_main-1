"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { grantStrataPlus } = require("./support/strata-plus-access");

const PROJECT_ROOT = join(__dirname, "..");
let server;
let runtimeDir;
let BASE;

async function startServer() {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "monthly-plan-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      STRATA_DATA_DIR: runtimeDir,
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRODUCT_ID: "",
      PADDLE_PRICE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  BASE = await new Promise((resolve, reject) => {
    let output = "",
      settled = false;
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 5000);
    server.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    server.once("error", reject);
  });
}

async function stopServer() {
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
  }
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  return {
    response,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}

async function account(suffix) {
  const signup = await request("/api/signup", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Monthly ${suffix}`,
      email: `monthly-${suffix}@example.test`,
      password: "monthly-plan-password-123",
    }),
  });
  assert.equal(signup.response.status, 201);
  const me = await request("/api/me", { headers: { Cookie: signup.cookie } });
  return { cookie: signup.cookie, csrfToken: me.data.csrfToken, id: me.data.user.id };
}

function grantPlus(accountFixture) {
  grantStrataPlus(runtimeDir, accountFixture.id);
}

function fixturePlan() {
  const startDate = "2026-01-05";
  const schedule = {};
  for (const day of [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]) {
    const rest = day === "Sunday";
    schedule[day] = { rest, targets: rest ? [] : ["chest", "triceps"], sourceItems: [] };
  }
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const days = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(start.getTime() + index * 86400000);
    const weekday = weekdays[date.getUTCDay()];
    const rest = schedule[weekday].rest;
    return {
      dayNumber: index + 1,
      date: date.toISOString().slice(0, 10),
      weekday,
      rest,
      targets: schedule[weekday].targets,
      exercises: rest
        ? []
        : [
            { exerciseId: "flat-dumbbell-press", sets: 3, reps: "8–12" },
            { exerciseId: "machine-chest-press", sets: 3, reps: "8–12" },
            { exerciseId: "pressdown", sets: 3, reps: "10–15" },
            { exerciseId: "overhead-triceps", sets: 3, reps: "10–15" },
          ],
    };
  });
  return {
    version: 1,
    title: "January training",
    source: "muscle-schedule",
    startDate,
    exercisesPerTarget: 2,
    schedule,
    days,
    generatedAt: 1,
  };
}

test.before(startServer);
test.after(stopServer);

test("Strata+ monthly plans are validated, isolated, stored, and returned with the weekly plan", async () => {
  const owner = await account("owner");
  const other = await account("other");

  const locked = await request("/api/monthly-plan", { headers: { Cookie: owner.cookie } });
  assert.equal(locked.response.status, 402);
  grantPlus(owner);
  grantPlus(other);

  const initial = await request("/api/monthly-plan", { headers: { Cookie: owner.cookie } });
  assert.equal(initial.response.status, 200);
  assert.equal(initial.data.monthlyPlan, null);
  assert.equal(initial.data.weeklyPlan.restDay, "Sunday");

  const monthlyPlan = fixturePlan();
  const missingCsrf = await request("/api/monthly-plan", {
    method: "PUT",
    headers: { Cookie: owner.cookie, Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ monthlyPlan }),
  });
  assert.equal(missingCsrf.response.status, 403);

  const invalid = structuredClone(monthlyPlan);
  invalid.days.pop();
  const rejected = await request("/api/monthly-plan", {
    method: "PUT",
    headers: {
      Cookie: owner.cookie,
      Origin: BASE,
      "Content-Type": "application/json",
      "X-CSRF-Token": owner.csrfToken,
    },
    body: JSON.stringify({ monthlyPlan: invalid, expectedUpdatedAt: 0 }),
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.data.error, /exactly 31 days/i);

  const saved = await request("/api/monthly-plan", {
    method: "PUT",
    headers: {
      Cookie: owner.cookie,
      Origin: BASE,
      "Content-Type": "application/json",
      "X-CSRF-Token": owner.csrfToken,
    },
    body: JSON.stringify({ monthlyPlan, userId: "someone-else", expectedUpdatedAt: 0 }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.monthlyPlan.days.length, 31);
  assert.ok(
    saved.data.monthlyPlan.generatedAt > 1,
    "the server replaces a client-provided timestamp",
  );

  const restored = await request("/api/monthly-plan", { headers: { Cookie: owner.cookie } });
  assert.deepEqual(restored.data.monthlyPlan, saved.data.monthlyPlan);
  const discovery = await request("/api/discovery", { headers: { Cookie: owner.cookie } });
  assert.deepEqual(discovery.data.monthlyPlan, saved.data.monthlyPlan);
  assert.equal(discovery.data.weeklyPlan.restDay, "Sunday");

  const isolated = await request("/api/monthly-plan", { headers: { Cookie: other.cookie } });
  assert.equal(
    isolated.data.monthlyPlan,
    null,
    "another Strata+ account cannot read the owner's plan",
  );

  const changes = ["Tab one", "Tab two"].map((title) =>
    request("/api/monthly-plan", {
      method: "PUT",
      headers: {
        Cookie: owner.cookie,
        Origin: BASE,
        "Content-Type": "application/json",
        "X-CSRF-Token": owner.csrfToken,
      },
      body: JSON.stringify({
        monthlyPlan: { ...monthlyPlan, title },
        expectedUpdatedAt: saved.data.monthlyPlan.updatedAt,
      }),
    }),
  );
  const raced = await Promise.all(changes);
  assert.deepEqual(raced.map((result) => result.response.status).sort(), [200, 409]);
  const winner = raced.find((result) => result.response.status === 200);
  assert.ok(winner.data.monthlyPlan.updatedAt > saved.data.monthlyPlan.updatedAt);
  const final = await request("/api/monthly-plan", { headers: { Cookie: owner.cookie } });
  assert.deepEqual(
    final.data.monthlyPlan,
    winner.data.monthlyPlan,
    "A stale tab must not overwrite the winner.",
  );
  const db = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  db.prepare("UPDATE monthly_plans SET plan_json='invalid-json'").run();
  db.close();
  const damaged = await request("/api/monthly-plan", { headers: { Cookie: owner.cookie } });
  assert.equal(damaged.data.monthlyPlan, null);
  assert.equal(damaged.data.monthlyPlanUpdatedAt, winner.data.monthlyPlan.updatedAt);
  const recovered = await request("/api/monthly-plan", {
    method: "PUT",
    headers: {
      Cookie: owner.cookie,
      Origin: BASE,
      "Content-Type": "application/json",
      "X-CSRF-Token": owner.csrfToken,
    },
    body: JSON.stringify({ monthlyPlan, expectedUpdatedAt: damaged.data.monthlyPlanUpdatedAt }),
  });
  assert.equal(
    recovered.response.status,
    200,
    "a corrupt legacy row remains replaceable with its revision",
  );
});
