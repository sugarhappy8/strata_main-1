"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { spawn } = require("node:child_process"),
  { mkdirSync, mkdtempSync, rmSync } = require("node:fs"),
  { join } = require("node:path");
const { workoutFixture } = require("./support/workout-fixtures");
const { grantStrataPlus } = require("./support/strata-plus-access");

const ROOT = join(__dirname, "..");
let server, directory, base;
async function startServer() {
  mkdirSync(join(ROOT, "test-runtime"), { recursive: true });
  directory = mkdtempSync(join(ROOT, "test-runtime", "workouts-"));
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "test",
      ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true",
      STRATA_DATA_DIR: directory,
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
      EMAIL_VERIFICATION_ENABLED: "false",
      PADDLE_CHECKOUT_ENABLED: "false",
      PADDLE_CLIENT_TOKEN: "",
      PADDLE_API_KEY: "",
      PADDLE_WEBHOOK_SECRET: "",
      PADDLE_PRICE_ID: "",
      PADDLE_PRODUCT_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    let output = "",
      errors = "";
    const timer = setTimeout(
      () => reject(new Error(`Workout server startup timed out: ${errors}`)),
      5000,
    );
    server.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
      const match = output.match(/Strata running at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    server.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-4096);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Workout server exited ${code}: ${errors}`));
    });
  });
}
async function stopServer() {
  if (server && server.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill("SIGTERM");
    });
  if (directory) rmSync(directory, { recursive: true, force: true });
}
async function request(path, account, method = "GET", body, extra = {}) {
  const headers = Object.fromEntries(
    Object.entries({
      Origin: base,
      "Content-Type": "application/json",
      ...(account ? { Cookie: account.cookie, "X-CSRF-Token": account.csrfToken } : {}),
      ...extra,
    }).filter(([, value]) => value !== null),
  );
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function account(suffix, { plus = true } = {}) {
  const result = await request("/api/signup", null, "POST", {
    name: `Workout ${suffix}`,
    email: `workout-${suffix}@example.test`,
    password: "strong-workout-password-123",
  });
  assert.equal(result.status, 201);
  const me = await request("/api/me", { cookie: result.cookie, csrfToken: "" });
  const member = { cookie: result.cookie, csrfToken: me.data.csrfToken, id: me.data.user.id };
  if (plus) grantStrataPlus(directory, member.id);
  return member;
}
test.before(startServer);
test.after(stopServer);

test("workout API requires authentication, a STRATA origin, CSRF, valid bounded input, and JSON", async () => {
  const member = await account("guards"),
    workout = workoutFixture("guarded-workout");
  assert.equal((await request("/api/workouts")).status, 401);
  // A write from another site, or with no Origin at all, is refused even with a valid session and CSRF token.
  for (const origin of ["https://outside.example", "null"])
    assert.equal(
      (await request("/api/workouts", member, "POST", { workout }, { Origin: origin })).status,
      403,
    );
  const unsigned = await request("/api/workouts", member, "POST", { workout }, { Origin: null });
  assert.deepEqual([unsigned.status, unsigned.data.code], [403, "ORIGIN_REQUIRED"]);
  assert.equal(
    (
      await request(
        "/api/workouts/guarded-workout",
        member,
        "PUT",
        { expectedRevision: 1, workout },
        { Origin: null },
      )
    ).data.code,
    "ORIGIN_REQUIRED",
  );
  assert.equal(
    (
      await request(
        "/api/workouts/guarded-workout",
        member,
        "DELETE",
        { expectedRevision: 1 },
        { Origin: null },
      )
    ).data.code,
    "ORIGIN_REQUIRED",
  );
  assert.equal(
    (await request("/api/workouts", member, "GET", undefined, { Origin: null })).status,
    200,
    "reads need no origin check",
  );
  assert.equal(
    (await request("/api/workouts", member)).data.workouts.length,
    0,
    "nothing refused was saved",
  );
  assert.equal(
    (await request("/api/workouts", member, "POST", { workout }, { "X-CSRF-Token": "wrong" }))
      .status,
    403,
  );
  assert.equal(
    (await request("/api/workouts", member, "POST", { workout }, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await request("/api/workouts", member, "POST", "{")).status, 400);
  const invalid = structuredClone(workout);
  invalid.entries[0].exerciseId = "not-an-exercise";
  assert.equal((await request("/api/workouts", member, "POST", { workout: invalid })).status, 400);
  for (const query of [
    "limit=101",
    "limit=-1",
    "offset=-1",
    "offset=10001",
    "offset=abc",
    "memory=0",
  ])
    assert.equal((await request(`/api/workouts?${query}`, member)).status, 400);
  assert.equal((await request("/api/workouts", member, "PATCH", {})).status, 405);
  assert.equal((await request("/api/workouts/invalid/path", member)).status, 404);
  assert.equal((await request("/api/workouts", member)).data.workouts.length, 0);
});

test("Strata+ workout logging is idempotent, resumes saved state, and rejects stale edits and deletes", async () => {
  const owner = await account("owner"),
    other = await account("other"),
    workout = workoutFixture("logged-session"),
    url = `/api/workouts/${workout.id}`;
  const initial = await request("/api/workouts", owner, "POST", {
    workout,
    userId: "untrusted-owner",
  });
  assert.equal(initial.status, 201);
  assert.equal(initial.data.workout.revision, 1);
  const identical = await request("/api/workouts", owner, "POST", { workout });
  assert.equal(identical.status, 200);
  assert.deepEqual(identical.data, initial.data);
  const different = await request("/api/workouts", owner, "POST", {
    workout: { ...workout, title: "Overwrite attempt" },
  });
  assert.equal(different.status, 409);
  assert.equal(different.data.code, "WORKOUT_CONFLICT");
  assert.equal(different.data.workout.title, workout.title);
  assert.equal((await request(url, other)).status, 404);
  assert.equal((await request("/api/workouts", other)).data.workouts.length, 0);
  assert.equal((await request(url, other, "PUT", { workout, expectedRevision: 1 })).status, 404);
  assert.equal((await request(url, other, "DELETE", { expectedRevision: 1 })).status, 404);
  assert.equal((await request(url, owner, "PUT", { workout })).status, 400);
  assert.equal((await request(url, owner, "PUT", { workout, expectedRevision: "1" })).status, 400);
  assert.equal(
    (
      await request(url, owner, "PUT", {
        workout: { ...workout, startedAt: workout.startedAt + 1 },
        expectedRevision: 1,
      })
    ).status,
    400,
  );
  const logged = structuredClone(workout);
  logged.entries[0].sets[0].completed = true;
  logged.elapsedSeconds = 60;
  logged.restEndsAt = Date.now() + 60000;
  const writes = await Promise.all([
    request(url, owner, "PUT", { workout: logged, expectedRevision: 1 }),
    request(url, owner, "PUT", { workout: { ...logged, title: "Other tab" }, expectedRevision: 1 }),
  ]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  const winner = writes.find((r) => r.status === 200).data.workout;
  assert.equal(winner.revision, 2);
  assert.ok(winner.updatedAt > initial.data.workout.updatedAt);
  const resumed = await request(url, owner);
  assert.deepEqual(resumed.data.workout, winner);
  assert.equal(resumed.data.csrfToken, owner.csrfToken);
  const delayedCreate = await request("/api/workouts", owner, "POST", { workout });
  assert.equal(delayedCreate.status, 200);
  assert.deepEqual(delayedCreate.data.workout, winner);
  const completed = {
    ...winner,
    status: "completed",
    completedAt: Date.now(),
    elapsedSeconds: 600,
    restEndsAt: null,
  };
  const finished = await request(url, owner, "PUT", { workout: completed, expectedRevision: 2 });
  assert.equal(finished.status, 200);
  assert.equal(finished.data.workout.revision, 3);
  const history = await request("/api/workouts", owner);
  assert.equal(history.data.workouts.length, 1);
  assert.equal(history.data.hasMore, false);
  const summary = history.data.workouts[0];
  assert.equal(summary.completedSets, 1);
  assert.equal(summary.totalSets, 2);
  assert.equal(summary.entries, undefined);
  assert.equal(summary.exerciseSummaries[0].volume, 200);
  assert.equal(summary.exerciseSummaries[0].setValues, undefined, "ordinary history stays compact");
  const memory = await request("/api/workouts?memory=1", owner);
  assert.deepEqual(
    memory.data.workouts[0].exerciseSummaries[0].setValues,
    [{ reps: 10, weight: 20, seconds: null, effort: null, effortType: "none" }],
    "Workout Memory is included only when requested by the training surface",
  );
  assert.equal((await request(url, owner, "DELETE", { expectedRevision: 2 })).status, 409);
  assert.equal((await request(url, owner, "DELETE", { expectedRevision: 3 })).status, 200);
  assert.equal((await request(url, owner)).status, 404);
});

test("concurrent workout starts keep one active session and return the session to resume", async () => {
  const member = await account("single-active"),
    first = workoutFixture("active-tab-one"),
    second = workoutFixture("active-tab-two");
  second.startedAt += 1;
  const starts = await Promise.all([
    request("/api/workouts", member, "POST", { workout: first }),
    request("/api/workouts", member, "POST", { workout: second }),
  ]);
  assert.deepEqual(starts.map((result) => result.status).sort(), [201, 409]);
  const created = starts.find((result) => result.status === 201),
    conflict = starts.find((result) => result.status === 409);
  assert.equal(conflict.data.code, "ACTIVE_WORKOUT_EXISTS");
  assert.equal(
    conflict.data.error,
    "You already have a workout in progress. Resume it before starting another.",
  );
  assert.deepEqual(
    conflict.data.workout,
    created.data.workout,
    "the conflict includes the complete resumable workout",
  );
  assert.ok(Array.isArray(conflict.data.workout.entries));
  const history = await request("/api/workouts", member);
  assert.equal(history.data.workouts.filter((workout) => workout.status === "active").length, 1);

  const archived = workoutFixture("reactivation-conflict");
  archived.status = "completed";
  archived.completedAt = archived.startedAt + 1000;
  archived.entries[0].sets[0].completed = true;
  const archivedCreate = await request("/api/workouts", member, "POST", { workout: archived });
  assert.equal(archivedCreate.status, 201);
  const reactivated = structuredClone(archivedCreate.data.workout);
  reactivated.status = "active";
  reactivated.completedAt = null;
  const reactivation = await request(`/api/workouts/${reactivated.id}`, member, "PUT", {
    workout: reactivated,
    expectedRevision: reactivated.revision,
  });
  assert.equal(reactivation.status, 409);
  assert.equal(reactivation.data.code, "ACTIVE_WORKOUT_EXISTS");
  assert.deepEqual(reactivation.data.workout, created.data.workout);

  const completed = structuredClone(created.data.workout);
  completed.status = "completed";
  completed.completedAt = completed.startedAt + 1000;
  completed.elapsedSeconds = 1;
  completed.restEndsAt = null;
  completed.entries[0].sets[0].completed = true;
  const finish = await request(`/api/workouts/${completed.id}`, member, "PUT", {
    workout: completed,
    expectedRevision: completed.revision,
  });
  assert.equal(finish.status, 200);
  const next = created.data.workout.id === first.id ? second : first;
  assert.equal(
    (await request("/api/workouts", member, "POST", { workout: next })).status,
    201,
    "finishing the active workout permits the next start",
  );
});

test("workout history pages newest first across active and completed sessions and logout revokes access", async () => {
  const member = await account("history");
  for (let i = 0; i < 3; i++) {
    const workout = workoutFixture(`history-${i}`);
    workout.startedAt += i;
    if (i < 2) {
      workout.status = "completed";
      workout.completedAt = workout.startedAt + 1000;
      workout.entries[0].sets[0].completed = true;
    }
    assert.equal((await request("/api/workouts", member, "POST", { workout })).status, 201);
  }
  const first = await request("/api/workouts?limit=2", member),
    second = await request("/api/workouts?limit=2&offset=2", member);
  assert.deepEqual(
    first.data.workouts.map((w) => w.id),
    ["history-2", "history-1"],
  );
  assert.equal(first.data.hasMore, true);
  assert.deepEqual(
    second.data.workouts.map((w) => w.id),
    ["history-0"],
  );
  assert.equal(second.data.hasMore, false);
  assert.equal((await request("/api/logout", member, "POST", {})).status, 200);
  assert.equal((await request("/api/workouts", member)).status, 401);
});

test("weekly setup saves its plan and matching profile atomically with both revision boundaries", async () => {
  const member = await account("setup-boundaries"),
    initial = await request("/api/setup", member);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.planUpdatedAt, 0);
  assert.equal(initial.data.preferencesUpdatedAt, 0);
  assert.equal(initial.data.preferences.goal, "hypertrophy");
  assert.equal(initial.data.preferences.days, 4);
  const plan = structuredClone(initial.data.plan);
  plan.days.Monday = [
    { instanceId: "setup-monday", exerciseId: "flat-dumbbell-press", sets: 3, reps: "8–12" },
  ];
  const preferences = {
    ...initial.data.preferences,
    goal: "strength",
    level: "Beginner",
    days: 1,
    preferences: ["compound"],
  };
  const payload = {
    plan,
    preferences,
    expectedPlanUpdatedAt: 0,
    expectedPreferencesUpdatedAt: 0,
    expectedUserId: member.id,
  };
  assert.equal(
    (await request("/api/setup", member, "PUT", payload, { "X-CSRF-Token": "wrong" })).status,
    403,
  );
  assert.equal(
    (await request("/api/setup", member, "PUT", payload, { Origin: "https://outside.example" }))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/setup", member, "PUT", JSON.stringify(payload), {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
  assert.equal(
    (await request("/api/setup", member, "PUT", { ...payload, expectedUserId: "another-user" }))
      .status,
    409,
  );
  const saved = await request("/api/setup", member, "PUT", payload);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.plan, plan);
  assert.deepEqual(saved.data.preferences, preferences);
  assert.equal(saved.data.planUpdatedAt, saved.data.preferencesUpdatedAt);
  const replayed = await request("/api/setup", member, "PUT", payload);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.data.reused, true);
  assert.equal(replayed.data.planUpdatedAt, saved.data.planUpdatedAt);
  const mismatchedPlan = structuredClone(plan);
  mismatchedPlan.days.Tuesday = [
    { instanceId: "setup-tuesday", exerciseId: "neutral-pulldown", sets: 3, reps: "8–12" },
  ];
  const mismatch = await request("/api/setup", member, "PUT", {
    plan: mismatchedPlan,
    preferences,
    expectedPlanUpdatedAt: saved.data.planUpdatedAt,
    expectedPreferencesUpdatedAt: saved.data.preferencesUpdatedAt,
    expectedUserId: member.id,
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.code, "SETUP_PROFILE_MISMATCH");
  const profileChanged = await request("/api/preferences", member, "PUT", {
    preferences: { ...preferences, goal: "balanced" },
  });
  assert.equal(profileChanged.status, 200);
  const stale = await request("/api/setup", member, "PUT", {
    ...payload,
    plan: mismatchedPlan,
    preferences: { ...preferences, days: 2 },
    expectedPlanUpdatedAt: saved.data.planUpdatedAt,
    expectedPreferencesUpdatedAt: saved.data.preferencesUpdatedAt,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "SETUP_CHANGED");
  const current = await request("/api/setup", member);
  assert.deepEqual(
    current.data.plan,
    plan,
    "a stale profile revision must not partially replace the plan",
  );
  assert.equal(
    current.data.preferences.goal,
    "balanced",
    "a stale setup save must not overwrite the newer profile",
  );
  assert.ok(current.data.preferencesUpdatedAt > saved.data.preferencesUpdatedAt);
});

test("free plans stay editable while every workout route and setup page requires Strata+", async () => {
  const member = await account("free-access", { plus: false }),
    workout = workoutFixture("paid-only");
  for (const [path, method, body] of [
    ["/api/workouts", "GET"],
    ["/api/workouts/paid-only", "GET"],
    ["/api/workouts", "POST", { workout }],
    ["/api/workouts/paid-only", "PUT", { workout, expectedRevision: 1 }],
    ["/api/workouts/paid-only", "DELETE", { expectedRevision: 1 }],
  ]) {
    const response = await request(path, member, method, body);
    assert.equal(response.status, 402);
    assert.equal(response.data.code, "DISCOVERY_ACCESS_REQUIRED");
  }
  assert.equal((await request("/api/setup", member)).status, 402);
  assert.equal((await request("/api/setup", member, "PUT", {})).status, 402);
  for (const page of ["workout.html", "onboarding.html"]) {
    const anonymous = await fetch(`${base}/${page}?day=Monday&guest=1`, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get("location"), /account.html/);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    if (page === "workout.html")
      assert.equal(
        new URL(anonymous.headers.get("location"), base).searchParams.get("next"),
        "/workout.html?day=Monday",
      );
    const denied = await fetch(`${base}/${page}?guest=1`, {
      headers: { Cookie: member.cookie },
      redirect: "manual",
    });
    assert.equal(denied.status, 302);
    assert.match(denied.headers.get("location"), /^\/pricing/);
  }
  assert.equal((await fetch(`${base}/planner.html`)).status, 200);
  let current = (await request("/api/plan", member)).data;
  for (const restDays of [
    ["Wednesday", "Sunday"],
    [],
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  ]) {
    const plan = { ...current.plan, restDays, restDay: restDays[0] ?? null };
    const saved = await request("/api/plan", member, "PUT", {
      plan,
      expectedPlanUpdatedAt: current.planUpdatedAt,
    });
    assert.equal(saved.status, 200);
    current = (await request("/api/plan", member)).data;
    assert.deepEqual(current.plan.restDays, restDays);
  }
});

test("Strata+ expiry closes private pages and API access while retaining logged sessions", async () => {
  const member = await account("expiry"),
    workout = workoutFixture("retained-session");
  assert.equal((await request("/api/workouts", member, "POST", { workout })).status, 201);
  for (const page of ["workout.html", "onboarding.html"]) {
    const response = await fetch(`${base}/${page}`, {
      headers: { Cookie: member.cookie },
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  const { DatabaseSync } = require("node:sqlite"),
    db = new DatabaseSync(join(directory, "strata.sqlite"));
  try {
    db.prepare(
      "UPDATE admin_account_controls SET grant_starts_at=?,grant_expires_at=? WHERE user_id=?",
    ).run(Date.now() - 20000, Date.now() - 1000, member.id);
  } finally {
    db.close();
  }
  assert.equal((await request("/api/workouts", member)).status, 402);
  assert.equal(
    (
      await fetch(`${base}/workout.html`, {
        headers: { Cookie: member.cookie },
        redirect: "manual",
      })
    ).status,
    302,
  );
  const check = new DatabaseSync(join(directory, "strata.sqlite"), { readOnly: true });
  try {
    assert.equal(
      check.prepare("SELECT count(*) AS count FROM workouts WHERE user_id=?").get(member.id).count,
      1,
    );
  } finally {
    check.close();
  }
  assert.equal((await request("/api/plan", member)).status, 200);
});
