"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PROJECT_ROOT = join(__dirname, "..");
let app;
let runtimeDir;
let BASE;

async function startApp() {
  mkdirSync(join(PROJECT_ROOT, "test-runtime"), { recursive: true });
  runtimeDir = mkdtempSync(join(PROJECT_ROOT, "test-runtime", "server-ratings-"));
  app = spawn(process.execPath, ["server.js"], {
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
      errors = "",
      settled = false;
    const timer = setTimeout(() => finish(new Error(`Server startup timed out. ${errors}`)), 5000);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    app.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, `http://127.0.0.1:${match[1]}`);
    });
    app.stderr.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-4096);
    });
    app.once("error", finish);
    app.once("exit", (code, signal) =>
      finish(new Error(`Server exited before startup (${code ?? signal ?? "unknown"}). ${errors}`)),
    );
  });
}

async function stopApp() {
  const child = app;
  app = undefined;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      let timer;
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
      timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    });
  }
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = undefined;
  BASE = undefined;
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, data, cookie: response.headers.get("set-cookie")?.split(";")[0] || "" };
}

async function signup(suffix) {
  const result = await request("/api/signup", {
    method: "POST",
    headers: { Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `Rating ${suffix}`,
      email: `rating-${suffix.toLowerCase()}@example.test`,
      password: `rating-password-${suffix.toLowerCase()}-123`,
    }),
  });
  assert.equal(result.response.status, 201);
  const me = await request("/api/me", { headers: { Cookie: result.cookie } });
  assert.equal(me.response.status, 200);
  assert.ok(me.data.csrfToken);
  return { cookie: result.cookie, csrfToken: me.data.csrfToken, user: me.data.user };
}

function grantStrataPlus(accounts) {
  const database = new DatabaseSync(join(runtimeDir, "strata.sqlite"));
  const statement = database.prepare(
    "INSERT INTO paddle_purchases(transaction_id,user_id,price_id,product_id,paddle_status,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const now = Date.now();
  for (const [index, account] of accounts.entries())
    statement.run(
      `txn_rating_${index}`,
      account.user.id,
      "pri_rating_test",
      "pro_rating_test",
      "completed",
      now,
      now,
      now,
    );
  database.close();
}

function putRating(account, rating, { origin = BASE, csrf = account.csrfToken } = {}) {
  const headers = { Cookie: account.cookie, "Content-Type": "application/json" };
  if (origin !== null) headers.Origin = origin;
  if (csrf !== null) headers["X-CSRF-Token"] = csrf;
  return request("/api/ratings/flat-dumbbell-press", {
    method: "PUT",
    headers,
    body: JSON.stringify({ rating }),
  });
}

function aggregateFor(payload) {
  return payload.aggregates.find((item) => item.exercise_id === "flat-dumbbell-press");
}

test.before(startApp);
test.after(stopApp);

test("Strata+ ratings are private, CSRF-protected, and globally aggregated across accounts", async () => {
  const unpaid = await signup("Unpaid");
  const unpaidAggregates = await request("/api/ratings/aggregates", {
    headers: { Cookie: unpaid.cookie },
  });
  assert.equal(unpaidAggregates.response.status, 402);
  assert.equal(unpaidAggregates.data.code, "DISCOVERY_ACCESS_REQUIRED");
  const unpaidWrite = await putRating(
    unpaid,
    { comfort: 5, pump: 5, enjoyment: 5, stability: 5, setup: 5, overall: 5 },
    { csrf: null },
  );
  assert.equal(
    unpaidWrite.response.status,
    402,
    "access is checked before accepting a rating or its CSRF credential",
  );
  assert.equal(unpaidWrite.data.code, "DISCOVERY_ACCESS_REQUIRED");

  const first = await signup("First");
  const second = await signup("Second");
  grantStrataPlus([first, second]);

  const discovery = await request("/api/discovery", { headers: { Cookie: first.cookie } });
  assert.equal(discovery.response.status, 200);
  assert.equal(
    discovery.data.csrfToken,
    first.csrfToken,
    "the paid client receives the CSRF credential needed to rate",
  );

  const before = await request("/api/ratings/aggregates", { headers: { Cookie: second.cookie } });
  assert.equal(before.response.status, 200);
  assert.equal(before.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(before.data).sort(), ["aggregates", "updatedAt"]);
  assert.deepEqual(before.data.aggregates, []);
  assert.ok(Number.isSafeInteger(before.data.updatedAt));

  const rating = { comfort: 5, pump: 4, enjoyment: 3, stability: 2, setup: 1, overall: 5 };
  const missingOrigin = await putRating(first, rating, { origin: null });
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.data.code, "RATING_ORIGIN_REQUIRED");
  const missingCsrf = await putRating(first, rating, { csrf: null });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.data.code, "INVALID_CSRF");
  const wrongCsrf = await putRating(first, rating, { csrf: "incorrect-csrf-token" });
  assert.equal(wrongCsrf.response.status, 403);
  assert.equal(wrongCsrf.data.code, "INVALID_CSRF");
  const crossOrigin = await putRating(first, rating, { origin: "https://attacker.invalid" });
  assert.equal(crossOrigin.response.status, 403);
  assert.equal(
    (await request("/api/ratings/aggregates", { headers: { Cookie: first.cookie } })).data
      .aggregates.length,
    0,
    "rejected writes do not affect community ratings",
  );

  const firstSave = await putRating(first, rating);
  assert.equal(firstSave.response.status, 200);
  assert.deepEqual(firstSave.data.aggregate, {
    exercise_id: "flat-dumbbell-press",
    rating_count: 1,
    ...rating,
  });

  const visibleToSecond = await request("/api/ratings/aggregates", {
    headers: { Cookie: second.cookie },
  });
  assert.equal(visibleToSecond.response.status, 200);
  assert.deepEqual(aggregateFor(visibleToSecond.data), {
    exercise_id: "flat-dumbbell-press",
    rating_count: 1,
    ...rating,
  });
  assert.doesNotMatch(
    JSON.stringify(visibleToSecond.data),
    /rating-first|example\s*\.test|user_id|csrf/i,
    "aggregate refreshes never disclose the voter or a session credential",
  );

  const replacement = { comfort: 4, pump: 4, enjoyment: 2, stability: 2, setup: 4, overall: 4 };
  const firstUpdate = await putRating(first, replacement);
  assert.equal(firstUpdate.response.status, 200);
  assert.deepEqual(
    firstUpdate.data.aggregate,
    { exercise_id: "flat-dumbbell-press", rating_count: 1, ...replacement },
    "one account replaces its prior vote instead of increasing the count",
  );

  const secondRating = { comfort: 2, pump: 4, enjoyment: 4, stability: 4, setup: 2, overall: 2 };
  const secondSave = await putRating(second, secondRating);
  assert.equal(secondSave.response.status, 200);
  assert.deepEqual(secondSave.data.aggregate, {
    exercise_id: "flat-dumbbell-press",
    rating_count: 2,
    comfort: 3,
    pump: 4,
    enjoyment: 3,
    stability: 3,
    setup: 3,
    overall: 3,
  });

  const finalForFirst = await request("/api/ratings/aggregates", {
    headers: { Cookie: first.cookie },
  });
  assert.deepEqual(
    aggregateFor(finalForFirst.data),
    secondSave.data.aggregate,
    "every paid account sees the same count and average",
  );
});
