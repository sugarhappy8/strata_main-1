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
  directory = mkdtempSync(join(ROOT, "test-runtime", "training-server-"));
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
      () => reject(new Error(`Training server startup timed out: ${errors}`)),
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
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Training server exited ${code}: ${errors}`)));
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
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      ...(account ? { Cookie: account.cookie, "X-CSRF-Token": account.csrfToken } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    headers: response.headers,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function requestWithoutOrigin(path, account, method = "POST", body = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: account.cookie,
      "X-CSRF-Token": account.csrfToken,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
async function account(suffix, { plus = true } = {}) {
  const created = await request("/api/signup", null, "POST", {
    name: `Training ${suffix}`,
    email: `training-${suffix}@example.test`,
    password: "strong-training-password-123",
  });
  assert.equal(created.status, 201);
  const me = await request("/api/me", { cookie: created.cookie, csrfToken: "" }),
    member = { cookie: created.cookie, csrfToken: me.data.csrfToken, id: me.data.user.id };
  if (plus) grantStrataPlus(directory, member.id);
  return member;
}
function completed(id, startedAt, reps = 10) {
  const workout = workoutFixture(id);
  workout.startedAt = startedAt;
  workout.date = new Date(startedAt).toISOString().slice(0, 10);
  workout.status = "completed";
  workout.completedAt = startedAt + 60000;
  workout.entries[0].sets = Array.from({ length: 3 }, () => ({
    reps,
    weight: 40,
    seconds: null,
    completed: true,
  }));
  return workout;
}
async function savePressPlan(member) {
  const current = await request("/api/plan", member),
    plan = structuredClone(current.data.plan);
  plan.restDays = [];
  plan.restDay = null;
  plan.days.Monday = [
    { instanceId: "training-press", exerciseId: "flat-dumbbell-press", sets: 3, reps: "8–12" },
  ];
  const saved = await request("/api/plan", member, "PUT", {
    plan,
    expectedPlanUpdatedAt: current.data.planUpdatedAt,
  });
  assert.equal(saved.status, 200);
  return saved.data;
}
test.before(startServer);
test.after(stopServer);

test("training APIs require Strata+, preserve owner isolation, CSRF, JSON, completion, and bounded check-ins", async () => {
  const owner = await account("guards-owner"),
    other = await account("guards-other"),
    free = await account("guards-free", { plus: false });
  assert.equal((await request("/api/training")).status, 401);
  assert.equal((await request("/api/training", free)).status, 402);
  const active = workoutFixture("active-check-in");
  assert.equal((await request("/api/workouts", owner, "POST", { workout: active })).status, 201);
  assert.equal(
    (
      await request(`/api/workouts/${active.id}/check-in`, owner, "POST", {
        checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 4 },
      })
    ).status,
    409,
  );
  active.status = "completed";
  active.completedAt = active.startedAt + 1000;
  active.restEndsAt = null;
  active.entries[0].sets[0].completed = true;
  assert.equal(
    (
      await request(`/api/workouts/${active.id}`, owner, "PUT", {
        workout: active,
        expectedRevision: 1,
      })
    ).status,
    200,
  );
  const path = `/api/workouts/${active.id}/check-in`,
    valid = { checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 4 } };
  const missingOrigin = await requestWithoutOrigin(path, owner, "POST", valid);
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.data.code, "TRAINING_ORIGIN_REQUIRED");
  assert.equal((await request(path, owner, "POST", valid, { Origin: "null" })).status, 403);
  assert.equal(
    (await request(path, owner, "POST", valid, { Origin: "https://foreign.example" })).status,
    403,
  );
  assert.equal(
    (await request(path, owner, "POST", valid, { "X-CSRF-Token": "wrong" })).status,
    403,
  );
  assert.equal(
    (await request(path, owner, "POST", JSON.stringify(valid), { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await request(path, owner, "POST", { checkIn: { ...valid.checkIn, comfort: 0 } })).status,
    400,
  );
  assert.equal((await request(path, other)).status, 404);
  assert.equal((await request(path, other, "POST", valid)).status, 404);
  const saved = await request(path, owner, "POST", valid);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.checkIn.workoutId, active.id);
  const loaded = await request(path, owner);
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.data.checkIn, saved.data.checkIn);
  const unsupported = await request(path, owner, "DELETE", {});
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "GET, POST");
});

test("comparable performance, explicit check-in, and user-approved adaptation form a deterministic loop", async () => {
  const member = await account("progression");
  const planState = await savePressPlan(member);
  const prior = completed("prior-comparable", 1767600000000, 9),
    current = completed("current-comparable", 1768204800000, 10);
  assert.equal((await request("/api/workouts", member, "POST", { workout: prior })).status, 201);
  assert.equal((await request("/api/workouts", member, "POST", { workout: current })).status, 201);
  const beforeCheckIn = await request(`/api/workouts/${current.id}/progression`, member);
  assert.equal(beforeCheckIn.data.progression.suggestions[0].action, "increase_reps");
  assert.equal(beforeCheckIn.data.progression.suggestions[0].target.reps, 11);
  const progressed = await request(`/api/workouts/${current.id}/check-in`, member, "POST", {
    checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 4 },
  });
  assert.equal(progressed.status, 200);
  assert.equal(progressed.data.adaptation, null);
  assert.equal(progressed.data.progression.suggestions[0].action, "increase_reps");
  assert.equal(progressed.data.progression.suggestions[0].target.reps, 11);

  const difficult = completed("difficult-session", 1768809600000, 10);
  assert.equal(
    (await request("/api/workouts", member, "POST", { workout: difficult })).status,
    201,
  );
  const checked = await request(`/api/workouts/${difficult.id}/check-in`, member, "POST", {
    checkIn: { difficulty: 5, energy: 3, comfort: 4, enjoyment: 3 },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.progression.suggestions[0].action, "repeat");
  const proposal = checked.data.adaptation;
  assert.equal(proposal.kind, "reduce_sets");
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.change.fromSets, 3);
  assert.equal(proposal.change.toSets, 2);
  const olderCheckIn = await request(`/api/workouts/${current.id}/check-in`, member);
  assert.equal(
    olderCheckIn.data.adaptation,
    null,
    "an older workout must not display another session's proposal",
  );
  const unchanged = await request("/api/plan", member);
  assert.equal(
    unchanged.data.plan.days.Monday[0].sets,
    3,
    "a check-in may propose but never silently apply a plan change",
  );
  assert.equal(proposal.expectedPlanUpdatedAt, planState.planUpdatedAt);
  assert.equal(
    (
      await request(
        `/api/training/adaptations/${proposal.id}`,
        member,
        "POST",
        { decision: "accept", expectedPlanUpdatedAt: proposal.expectedPlanUpdatedAt },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  const accepted = await request(`/api/training/adaptations/${proposal.id}`, member, "POST", {
    decision: "accept",
    expectedPlanUpdatedAt: proposal.expectedPlanUpdatedAt,
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.adaptation.status, "accepted");
  assert.equal(accepted.data.plan.days.Monday[0].sets, 2);
  assert.ok(accepted.data.planUpdatedAt > proposal.expectedPlanUpdatedAt);
  const replay = await request(`/api/training/adaptations/${proposal.id}`, member, "POST", {
    decision: "accept",
    expectedPlanUpdatedAt: proposal.expectedPlanUpdatedAt,
  });
  assert.equal(replay.status, 409);
  assert.equal(replay.data.code, "ADAPTATION_RESOLVED");
  const dashboard = await request("/api/training", member);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.data.adaptation, null);
  assert.equal(dashboard.data.progression.workoutId, difficult.id);
});

test("training blocks expose 4–8 week metadata and exact revision conflicts", async () => {
  const member = await account("blocks"),
    other = await account("blocks-other");
  const block = {
    title: "Focused six",
    goal: "strength",
    weeks: 6,
    currentWeek: 1,
    lightWeek: 5,
    startDate: "2026-09-07",
    status: "active",
    progressionRule: "reps-then-load",
    milestones: [
      { week: 1, label: "Baseline" },
      { week: 5, label: "Lighter week" },
      { week: 6, label: "Review" },
    ],
  };
  assert.equal(
    (
      await request(
        "/api/training-block",
        member,
        "PUT",
        { block, expectedRevision: 0 },
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/training-block", member, "PUT", {
        block: { ...block, weeks: 9 },
        expectedRevision: 0,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/training-block", member, "PUT", {
        block,
        expectedRevision: 0,
        expectedUserId: other.id,
      })
    ).data.code,
    "TRAINING_ACCOUNT_CHANGED",
  );
  const created = await request("/api/training-block", member, "PUT", {
    block,
    expectedRevision: 0,
    expectedUserId: member.id,
  });
  assert.equal(created.status, 200);
  assert.equal(created.data.block.revision, 1);
  const stale = await request("/api/training-block", member, "PUT", {
    block: { ...block, currentWeek: 2 },
    expectedRevision: 0,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.block.revision, 1);
  const updated = await request("/api/training-block", member, "PUT", {
    block: { ...block, currentWeek: 2 },
    expectedRevision: 1,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.block.currentWeek, 2);
  assert.equal(updated.data.block.revision, 2);
  assert.equal(
    (await request("/api/training-block", other)).data.block,
    null,
    "training blocks stay private to their owner",
  );
});

test("only an active block governs progression and its selected lighter week suppresses increases", async () => {
  const member = await account("block-progression");
  const prior = completed("block-prior", 1767600000000, 12),
    current = completed("block-current", 1768204800000, 12);
  assert.equal((await request("/api/workouts", member, "POST", { workout: prior })).status, 201);
  assert.equal((await request("/api/workouts", member, "POST", { workout: current })).status, 201);
  const block = {
    title: "Six-week cycle",
    goal: "strength",
    weeks: 6,
    currentWeek: 2,
    lightWeek: 2,
    startDate: "2026-09-07",
    status: "active",
    progressionRule: "reps-only",
    milestones: [
      { week: 1, label: "Baseline" },
      { week: 2, label: "Lighter week" },
      { week: 6, label: "Review" },
    ],
  };
  assert.equal(
    (await request("/api/training-block", member, "PUT", { block, expectedRevision: 0 })).status,
    200,
  );
  const checked = await request(`/api/workouts/${current.id}/check-in`, member, "POST", {
    checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 4 },
  });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.progression.progressionRule, "reps-only");
  assert.equal(checked.data.progression.suggestions[0].action, "repeat");
  assert.equal(checked.data.progression.suggestions[0].basis, "lighter-week");
  const completedBlock = await request("/api/training-block", member, "PUT", {
    block: { ...block, currentWeek: 6, status: "completed" },
    expectedRevision: 1,
  });
  assert.equal(completedBlock.status, 200);
  const after = await request(`/api/workouts/${current.id}/progression`, member);
  assert.equal(after.status, 200);
  assert.equal(after.data.progression.progressionRule, "reps-then-load");
  assert.equal(after.data.progression.suggestions[0].action, "increase_load");
});

test("editing the source check-in retires its obsolete proposal without changing the plan", async () => {
  const member = await account("changed-check-in");
  await savePressPlan(member);
  const workout = completed("changed-check-in-workout", 1767600000000, 10);
  assert.equal((await request("/api/workouts", member, "POST", { workout })).status, 201);
  const first = await request(`/api/workouts/${workout.id}/check-in`, member, "POST", {
    checkIn: { difficulty: 5, energy: 3, comfort: 4, enjoyment: 3 },
  });
  assert.equal(first.status, 200);
  assert.ok(first.data.adaptation);
  const proposal = first.data.adaptation;
  const edited = await request(`/api/workouts/${workout.id}/check-in`, member, "POST", {
    checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 4 },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.adaptation, null);
  assert.equal(
    (await request(`/api/workouts/${workout.id}/check-in`, member)).data.adaptation,
    null,
  );
  assert.equal(
    (await request("/api/training", member)).data.adaptation,
    null,
    "a retired proposal must leave the latest pending slot",
  );
  const result = await request(`/api/training/adaptations/${proposal.id}`, member, "POST", {
    decision: "accept",
    expectedPlanUpdatedAt: proposal.expectedPlanUpdatedAt,
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, "ADAPTATION_RESOLVED");
  assert.equal((await request("/api/plan", member)).data.plan.days.Monday[0].sets, 3);
});
