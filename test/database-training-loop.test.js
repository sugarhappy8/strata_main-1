"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");
const { defaultPlan } = require("../src/plans");
const { sanitizeWorkout, summarizeWorkout } = require("../src/workouts");
const { fakeTursoFactory, workoutFixture } = require("./support/workout-fixtures");

const ROOT = join(__dirname, ".."),
  RUNTIME = join(ROOT, "test-runtime");

async function fixture(t, kind, { disableForeignKeys = false, capture = () => {} } = {}) {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, `training-${kind}-`));
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  let store, database;
  try {
    Object.assign(process.env, {
      NODE_ENV: "test",
      STRATA_DATA_DIR: directory,
      TURSO_DATABASE_URL: kind === "turso" ? "https://training.invalid" : "",
      TURSO_AUTH_TOKEN: kind === "turso" ? "test-token" : "",
    });
    store = await createStore(
      ROOT,
      kind === "turso"
        ? {
            tursoClientFactory: fakeTursoFactory((db) => {
              database = db;
            }),
          }
        : {},
    );
    if (disableForeignKeys && database) database.exec("PRAGMA foreign_keys=OFF");
    capture({ database, directory });
  } finally {
    for (const [key, value] of Object.entries(previous))
      value === undefined ? delete process.env[key] : (process.env[key] = value);
  }
  t.after(async () => {
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

async function seed(store, userId = "training-owner") {
  await store.insertUser({
    id: userId,
    name: "Training Owner",
    email: `${userId}@example.test`,
    passwordHash: "hash",
    passwordSalt: "salt",
    createdAt: 1,
    emailVerifiedAt: 1,
  });
  const workout = workoutFixture("completed-session");
  workout.status = "completed";
  workout.completedAt = workout.startedAt + 1000;
  workout.entries[0].sets[0].completed = true;
  const clean = sanitizeWorkout(workout);
  await store.insertWorkout({
    userId,
    id: clean.id,
    workoutJson: JSON.stringify(clean),
    summaryJson: JSON.stringify(summarizeWorkout(clean)),
    createHash: "training-hash",
    startedAt: clean.startedAt,
    updatedAt: 100,
  });
  const plan = defaultPlan();
  plan.restDays = [];
  plan.restDay = null;
  plan.days.Monday = [
    { instanceId: "monday-press", exerciseId: "flat-dumbbell-press", sets: 3, reps: "8–12" },
  ];
  const savedPlan = await store.upsertPlan(userId, JSON.stringify(plan), 200, 0);
  return { workout: clean, plan, planUpdatedAt: Number(savedPlan.updated_at) };
}

for (const kind of ["local", "turso"]) {
  test(
    `${kind} training storage keeps check-ins and blocks owner-scoped with exact revisions`,
    { concurrency: false },
    async (t) => {
      const store = await fixture(t, kind),
        { workout } = await seed(store);
      await store.insertUser({
        id: "other",
        name: "Other",
        email: `other-${kind}@example.test`,
        passwordHash: "hash",
        passwordSalt: "salt",
        createdAt: 1,
        emailVerifiedAt: 1,
      });
      const checkIn = {
        userId: "training-owner",
        workoutId: workout.id,
        difficulty: 3,
        energy: 4,
        comfort: 5,
        enjoyment: 4,
        createdAt: 300,
        updatedAt: 300,
      };
      assert.equal(
        await store.upsertWorkoutCheckIn({ ...checkIn, userId: "other" }),
        null,
        "another account cannot attach feedback to the owner's workout",
      );
      const saved = await store.upsertWorkoutCheckIn(checkIn);
      assert.equal(saved.workout_id, workout.id);
      assert.equal(saved.difficulty, 3);
      const edited = await store.upsertWorkoutCheckIn({
        ...checkIn,
        difficulty: 4,
        createdAt: 999,
        updatedAt: 301,
      });
      assert.equal(edited.difficulty, 4);
      assert.equal(edited.created_at, 300, "edits preserve the original creation time");
      assert.equal(await store.workoutCheckIn("other", workout.id), null);

      const active = workoutFixture("active-session"),
        activeClean = sanitizeWorkout(active);
      await store.insertWorkout({
        userId: "training-owner",
        id: active.id,
        workoutJson: JSON.stringify(activeClean),
        summaryJson: JSON.stringify(summarizeWorkout(activeClean)),
        createHash: "active-hash",
        startedAt: active.startedAt,
        updatedAt: 101,
      });
      assert.equal(
        await store.upsertWorkoutCheckIn({ ...checkIn, workoutId: active.id }),
        null,
        "active workouts cannot receive a post-workout check-in",
      );

      const block = {
        version: 1,
        title: "Six-week block",
        goal: "strength",
        weeks: 6,
        currentWeek: 1,
        lightWeek: 5,
        startDate: "2026-09-07",
        status: "active",
        progressionRule: "reps-then-load",
        milestones: [
          { week: 1, label: "Baseline" },
          { week: 6, label: "Review" },
        ],
      };
      assert.equal(
        await store.upsertTrainingBlock(
          { userId: "other", blockJson: JSON.stringify(block), updatedAt: 399 },
          7,
        ),
        null,
        "an update revision cannot create a missing block",
      );
      const created = await store.upsertTrainingBlock(
        { userId: "training-owner", blockJson: JSON.stringify(block), updatedAt: 400 },
        0,
      );
      assert.equal(created.revision, 1);
      assert.equal(
        await store.upsertTrainingBlock(
          { userId: "training-owner", blockJson: "{}", updatedAt: 401 },
          0,
        ),
        null,
        "create revision cannot overwrite an existing block",
      );
      const updated = await store.upsertTrainingBlock(
        {
          userId: "training-owner",
          blockJson: JSON.stringify({ ...block, currentWeek: 2 }),
          updatedAt: 401,
        },
        1,
      );
      assert.equal(updated.revision, 2);
      assert.equal(JSON.parse(updated.block_json).currentWeek, 2);
      assert.equal(
        await store.upsertTrainingBlock(
          { userId: "training-owner", blockJson: "{}", updatedAt: 402 },
          1,
        ),
        null,
        "stale block revisions cannot overwrite current state",
      );
      assert.equal(await store.trainingBlock("other"), null);
    },
  );

  test(
    `${kind} accepts a proposal iff its plan CAS succeeds and never partially mutates`,
    { concurrency: false },
    async (t) => {
      const store = await fixture(t, kind),
        { workout, plan, planUpdatedAt } = await seed(store);
      const checkIn = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 3,
          energy: 4,
          comfort: 4,
          enjoyment: 4,
          createdAt: 300,
          updatedAt: 300,
        }),
        checkInUpdatedAt = Number(checkIn.updated_at);
      const proposed = structuredClone(plan);
      proposed.days.Monday[0].sets = 2;
      const adaptation = (id, revision = planUpdatedAt) => ({
        userId: "training-owner",
        id,
        workoutId: workout.id,
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: {
            day: "Monday",
            instanceId: "monday-press",
            exerciseId: "flat-dumbbell-press",
            fromSets: 3,
            toSets: 2,
          },
          expectedPlanUpdatedAt: revision,
          checkInUpdatedAt,
        }),
        planUpdatedAt: revision,
        createdAt: 500,
        checkInUpdatedAt,
      });
      await store.upsertTrainingAdaptation(adaptation("stale-proposal"));
      assert.equal(
        Object.hasOwn(
          JSON.parse(
            (await store.trainingAdaptation("training-owner", "stale-proposal")).adaptation_json,
          ),
          "proposedPlan",
        ),
        false,
        "proposal metadata must not contain a weekly-plan snapshot",
      );
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: "stale-proposal",
          planJson: JSON.stringify(proposed),
          expectedPlanUpdatedAt: planUpdatedAt + 1,
          expectedCheckInUpdatedAt: checkInUpdatedAt,
          resolvedAt: 600,
        }),
        null,
      );
      assert.equal(
        (await store.trainingAdaptation("training-owner", "stale-proposal")).status,
        "pending",
      );
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].sets,
        3,
        "failed CAS must leave the plan unchanged",
      );

      const dismissed = await store.dismissTrainingAdaptation(
        "training-owner",
        "stale-proposal",
        601,
      );
      assert.equal(dismissed.status, "dismissed");
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: "stale-proposal",
          planJson: JSON.stringify(proposed),
          expectedPlanUpdatedAt: planUpdatedAt,
          expectedCheckInUpdatedAt: checkInUpdatedAt,
          resolvedAt: 602,
        }),
        null,
      );
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].sets,
        3,
        "a dismissed proposal cannot mutate the plan",
      );

      await store.upsertTrainingAdaptation(adaptation("superseded-plan"));
      const newerPlan = structuredClone(plan);
      newerPlan.days.Monday[0].reps = "6–10";
      const newer = await store.upsertPlan(
        "training-owner",
        JSON.stringify(newerPlan),
        650,
        planUpdatedAt,
      );
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: "superseded-plan",
          planJson: JSON.stringify(proposed),
          expectedPlanUpdatedAt: planUpdatedAt,
          expectedCheckInUpdatedAt: checkInUpdatedAt,
          resolvedAt: 651,
        }),
        null,
      );
      assert.equal(
        (await store.trainingAdaptation("training-owner", "superseded-plan")).status,
        "pending",
      );
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].reps,
        "6–10",
        "a proposal cannot overwrite a newer plan",
      );
      await store.dismissTrainingAdaptation("training-owner", "superseded-plan", 652);

      const currentRevision = Number(newer.updated_at),
        currentProposal = structuredClone(newerPlan);
      currentProposal.days.Monday[0].sets = 2;
      await store.upsertTrainingAdaptation({
        ...adaptation("accepted-proposal", currentRevision),
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: {
            day: "Monday",
            instanceId: "monday-press",
            exerciseId: "flat-dumbbell-press",
            fromSets: 3,
            toSets: 2,
          },
          expectedPlanUpdatedAt: currentRevision,
          checkInUpdatedAt,
        }),
      });
      const accepted = await store.acceptTrainingAdaptation({
        userId: "training-owner",
        id: "accepted-proposal",
        planJson: JSON.stringify(currentProposal),
        expectedPlanUpdatedAt: currentRevision,
        expectedCheckInUpdatedAt: checkInUpdatedAt,
        resolvedAt: 700,
      });
      assert.equal(accepted.adaptation.status, "accepted");
      assert.equal(JSON.parse(accepted.plan.plan_json).days.Monday[0].sets, 2);
      assert.equal(
        (await store.trainingAdaptation("training-owner", "accepted-proposal")).status,
        "accepted",
      );
      const acceptedRevision = Number(accepted.plan.updated_at);
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: "accepted-proposal",
          planJson: JSON.stringify(plan),
          expectedPlanUpdatedAt: currentRevision,
          expectedCheckInUpdatedAt: checkInUpdatedAt,
          resolvedAt: 701,
        }),
        null,
      );
      assert.equal(
        Number((await store.plan("training-owner")).updated_at),
        acceptedRevision,
        "a resolved proposal cannot replay",
      );
    },
  );

  test(
    `${kind} proposal lifecycle is gated by the current check-in without mutating the plan`,
    { concurrency: false },
    async (t) => {
      const store = await fixture(t, kind),
        { workout, plan, planUpdatedAt } = await seed(store);
      const first = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 5,
          energy: 3,
          comfort: 4,
          enjoyment: 3,
          createdAt: 300,
          updatedAt: 300,
        }),
        firstRevision = Number(first.updated_at);
      const proposed = structuredClone(plan);
      proposed.days.Monday[0].sets = 2;
      const record = {
        userId: "training-owner",
        id: "check-in-proposal",
        workoutId: workout.id,
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: {
            day: "Monday",
            instanceId: "monday-press",
            exerciseId: "flat-dumbbell-press",
            fromSets: 3,
            toSets: 2,
          },
          expectedPlanUpdatedAt: planUpdatedAt,
          checkInUpdatedAt: firstRevision,
        }),
        planUpdatedAt,
        createdAt: 400,
        checkInUpdatedAt: firstRevision,
      };
      assert.ok(await store.upsertTrainingAdaptation(record));
      const edited = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 3,
          energy: 4,
          comfort: 4,
          enjoyment: 4,
          createdAt: 300,
          updatedAt: 401,
        }),
        editedRevision = Number(edited.updated_at);
      assert.equal(
        await store.upsertTrainingAdaptation({ ...record, createdAt: 402 }),
        null,
        "a stale request cannot recreate or refresh a proposal after a newer check-in",
      );
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: record.id,
          planJson: JSON.stringify(proposed),
          expectedPlanUpdatedAt: planUpdatedAt,
          expectedCheckInUpdatedAt: firstRevision,
          resolvedAt: 403,
        }),
        null,
        "an edited check-in must fail the atomic acceptance predicate",
      );
      assert.equal(
        await store.dismissTrainingAdaptation("training-owner", record.id, 404, firstRevision),
        null,
        "a stale request cannot dismiss a proposal for a newer check-in state",
      );
      const retired = await store.dismissTrainingAdaptation(
        "training-owner",
        record.id,
        405,
        editedRevision,
      );
      assert.equal(retired.status, "dismissed");
      assert.equal(await store.latestTrainingAdaptation("training-owner"), null);
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].sets,
        3,
        "proposal retirement cannot mutate the plan",
      );
    },
  );

  test(
    `${kind} workout deletion removes check-ins and proposals${kind === "turso" ? " with foreign keys disabled" : " atomically"}`,
    { concurrency: false },
    async (t) => {
      const store = await fixture(t, kind, { disableForeignKeys: kind === "turso" }),
        { workout, planUpdatedAt } = await seed(store);
      const checkIn = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 5,
          energy: 3,
          comfort: 4,
          enjoyment: 3,
          createdAt: 300,
          updatedAt: 300,
        }),
        checkInUpdatedAt = Number(checkIn.updated_at);
      await store.upsertTrainingAdaptation({
        userId: "training-owner",
        id: "delete-workout-proposal",
        workoutId: workout.id,
        adaptationJson: JSON.stringify({ kind: "reduce_sets", checkInUpdatedAt }),
        planUpdatedAt,
        createdAt: 400,
        checkInUpdatedAt,
      });
      assert.equal(await store.deleteWorkout("training-owner", workout.id, 1), true);
      assert.equal(await store.workoutCheckIn("training-owner", workout.id), null);
      assert.equal(
        await store.trainingAdaptation("training-owner", "delete-workout-proposal"),
        null,
      );
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].sets,
        3,
      );
    },
  );

  test(
    `${kind} orphan proposal cannot mutate its owner's plan`,
    { concurrency: false },
    async (t) => {
      let rawInfo;
      const store = await fixture(t, kind, {
          disableForeignKeys: kind === "turso",
          capture: (info) => {
            rawInfo = info;
          },
        }),
        { workout, plan, planUpdatedAt } = await seed(store);
      const checkIn = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 5,
          energy: 3,
          comfort: 4,
          enjoyment: 3,
          createdAt: 300,
          updatedAt: 300,
        }),
        checkInUpdatedAt = Number(checkIn.updated_at),
        proposed = structuredClone(plan);
      proposed.days.Monday[0].sets = 2;
      await store.upsertTrainingAdaptation({
        userId: "training-owner",
        id: "orphan-proposal",
        workoutId: workout.id,
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: {
            day: "Monday",
            instanceId: "monday-press",
            exerciseId: "flat-dumbbell-press",
            fromSets: 3,
            toSets: 2,
          },
          expectedPlanUpdatedAt: planUpdatedAt,
          checkInUpdatedAt,
        }),
        planUpdatedAt,
        createdAt: 400,
        checkInUpdatedAt,
      });
      const raw = rawInfo.database || new DatabaseSync(join(rawInfo.directory, "strata.sqlite"));
      raw.exec("PRAGMA foreign_keys=OFF");
      raw
        .prepare("DELETE FROM workouts WHERE user_id=? AND id=?")
        .run("training-owner", workout.id);
      if (!rawInfo.database) raw.close();
      assert.ok(
        await store.trainingAdaptation("training-owner", "orphan-proposal"),
        "the fixture must retain a genuine orphan",
      );
      assert.equal(
        await store.acceptTrainingAdaptation({
          userId: "training-owner",
          id: "orphan-proposal",
          planJson: JSON.stringify(proposed),
          expectedPlanUpdatedAt: planUpdatedAt,
          expectedCheckInUpdatedAt: checkInUpdatedAt,
          resolvedAt: 500,
        }),
        null,
      );
      assert.equal(
        JSON.parse((await store.plan("training-owner")).plan_json).days.Monday[0].sets,
        3,
        "an orphan proposal cannot change the plan",
      );
    },
  );

  test(
    `${kind} account deletion removes all training-loop state`,
    { concurrency: false },
    async (t) => {
      const store = await fixture(t, kind, { disableForeignKeys: kind === "turso" }),
        { workout, planUpdatedAt } = await seed(store, "delete-training-owner");
      const checkIn = await store.upsertWorkoutCheckIn({
        userId: "delete-training-owner",
        workoutId: workout.id,
        difficulty: 3,
        energy: 3,
        comfort: 3,
        enjoyment: 3,
        createdAt: 300,
        updatedAt: 300,
      });
      await store.upsertTrainingBlock(
        {
          userId: "delete-training-owner",
          blockJson: JSON.stringify({ weeks: 4 }),
          updatedAt: 400,
        },
        0,
      );
      await store.upsertTrainingAdaptation({
        userId: "delete-training-owner",
        id: "delete-proposal",
        workoutId: workout.id,
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: {
            day: "Monday",
            instanceId: "monday-press",
            exerciseId: "flat-dumbbell-press",
            fromSets: 3,
            toSets: 2,
          },
        }),
        planUpdatedAt,
        createdAt: 500,
        checkInUpdatedAt: Number(checkIn.updated_at),
      });
      await store.upsertAccountAction({
        requestId: "delete-training",
        userId: "delete-training-owner",
        purpose: "account_delete",
        tokenHash: "delete-training-token",
        expiresAt: 1000,
        deliveryState: "sent",
        createdAt: 600,
        updatedAt: 600,
      });
      assert.equal(
        (await store.deleteAccount("delete-training-token", 700, "email-hash")).status,
        "deleted",
      );
      assert.equal(await store.workoutCheckIn("delete-training-owner", workout.id), null);
      assert.equal(await store.trainingBlock("delete-training-owner"), null);
      assert.equal(
        await store.trainingAdaptation("delete-training-owner", "delete-proposal"),
        null,
      );
    },
  );
}

test(
  "training schema migration removes legacy embedded plan snapshots",
  { concurrency: false },
  async () => {
    mkdirSync(RUNTIME, { recursive: true });
    const directory = mkdtempSync(join(RUNTIME, "training-privacy-migration-")),
      previous = {
        NODE_ENV: process.env.NODE_ENV,
        STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
        TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
        TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
      };
    let store;
    try {
      Object.assign(process.env, {
        NODE_ENV: "test",
        STRATA_DATA_DIR: directory,
        TURSO_DATABASE_URL: "",
        TURSO_AUTH_TOKEN: "",
      });
      store = await createStore(ROOT);
      const { workout, plan, planUpdatedAt } = await seed(store),
        checkIn = await store.upsertWorkoutCheckIn({
          userId: "training-owner",
          workoutId: workout.id,
          difficulty: 5,
          energy: 3,
          comfort: 4,
          enjoyment: 3,
          createdAt: 300,
          updatedAt: 300,
        });
      await store.upsertTrainingAdaptation({
        userId: "training-owner",
        id: "legacy-plan-snapshot",
        workoutId: workout.id,
        adaptationJson: JSON.stringify({
          kind: "reduce_sets",
          change: { day: "Monday" },
          proposedPlan: plan,
        }),
        planUpdatedAt,
        createdAt: 400,
        checkInUpdatedAt: Number(checkIn.updated_at),
      });
      assert.ok(
        JSON.parse(
          (await store.trainingAdaptation("training-owner", "legacy-plan-snapshot"))
            .adaptation_json,
        ).proposedPlan,
      );
      await store.close();
      store = null;
      store = await createStore(ROOT);
      assert.equal(
        Object.hasOwn(
          JSON.parse(
            (await store.trainingAdaptation("training-owner", "legacy-plan-snapshot"))
              .adaptation_json,
          ),
          "proposedPlan",
        ),
        false,
      );
    } finally {
      await store?.close();
      for (const [key, value] of Object.entries(previous))
        value === undefined ? delete process.env[key] : (process.env[key] = value);
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
