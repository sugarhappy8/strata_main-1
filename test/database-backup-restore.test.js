"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, copyFileSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DatabaseSync, backup } = require("node:sqlite");
const { createHash } = require("node:crypto");
const { createStore } = require("../src/database");
const { defaultPlan, sanitizePlan } = require("../src/plans");
const { sanitizeWorkout, summarizeWorkout } = require("../src/workouts");
const { workoutFixture } = require("./support/workout-fixtures");

async function openLocalStore(directory) {
  const changes = {
    NODE_ENV: "test",
    STRATA_DATA_DIR: directory,
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "",
  };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, changes);
    return await createStore(join(__dirname, ".."));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function workoutRecord(userId, workout, updatedAt) {
  const clean = sanitizeWorkout(workout),
    workoutJson = JSON.stringify(clean);
  return {
    userId,
    id: clean.id,
    workoutJson,
    summaryJson: JSON.stringify(summarizeWorkout(clean)),
    createHash: createHash("sha256").update(workoutJson).digest("hex"),
    startedAt: clean.startedAt,
    updatedAt,
  };
}

function verifyIntegrity(file) {
  const database = new DatabaseSync(file, { readOnly: true, enableForeignKeyConstraints: true });
  try {
    assert.deepEqual(
      database
        .prepare("PRAGMA quick_check")
        .all()
        .map((row) => row.quick_check),
      ["ok"],
    );
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
  }
}

test(
  "SQLite online backup restores accounts, plans and logged workouts into a clean directory",
  { concurrency: false, timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "strata-backup-restore-"));
    const sourceDir = join(root, "source"),
      restoreDir = join(root, "restore"),
      backupFile = join(root, "snapshot.sqlite");
    let source, restored, backupConnection;
    try {
      source = await openLocalStore(sourceDir);
      for (const id of ["backup-owner", "backup-other"]) {
        await source.insertUser({
          id,
          name: id,
          email: `${id}@example.test`,
          passwordHash: `hash-${id}`,
          passwordSalt: `salt-${id}`,
          createdAt: 1000,
          emailVerifiedAt: 1000,
        });
        const plan = defaultPlan();
        plan.days.Monday = [
          {
            exerciseId: id === "backup-owner" ? "flat-dumbbell-press" : "machine-chest-press",
            sets: 3,
            reps: "8–12",
          },
        ];
        assert.ok(await source.upsertPlan(id, JSON.stringify(sanitizePlan(plan)), 2000, 0));
      }
      const workout = workoutFixture("backup-workout");
      assert.ok(await source.insertWorkout(workoutRecord("backup-owner", workout, 3000)));
      workout.status = "completed";
      workout.completedAt = workout.startedAt + 600000;
      workout.elapsedSeconds = 600;
      workout.entries[0].sets[0].completed = true;
      assert.equal(
        (await source.updateWorkout(workoutRecord("backup-owner", workout, 4000), 1)).revision,
        2,
      );
      const otherWorkout = workoutFixture("other-workout");
      otherWorkout.title = "Other account session";
      assert.ok(await source.insertWorkout(workoutRecord("backup-other", otherWorkout, 3000)));
      const expected = {};
      for (const id of ["backup-owner", "backup-other"])
        expected[id] = {
          user: await source.accountCredentialsById(id),
          plan: await source.plan(id),
          history: await source.workouts(id, 20, 0),
        };
      const expectedWorkout = await source.workout("backup-owner", workout.id),
        expectedOtherWorkout = await source.workout("backup-other", otherWorkout.id);

      // The online backup reads the live SQLite database, including committed WAL pages.
      // Copying only the source .sqlite file while it is open would be unsafe.
      backupConnection = new DatabaseSync(join(sourceDir, "strata.sqlite"), { readOnly: true });
      assert.equal(backupConnection.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      await backup(backupConnection, backupFile);
      backupConnection.close();
      backupConnection = null;
      verifyIntegrity(backupFile);

      // A later source mutation must not appear in the completed backup snapshot.
      workout.title = "Changed after backup";
      assert.equal(
        (await source.updateWorkout(workoutRecord("backup-owner", workout, 5000), 2)).revision,
        3,
      );
      assert.ok(await source.upsertPlan("backup-owner", JSON.stringify(defaultPlan()), 5000, 2000));
      await source.close();
      source = null;

      mkdirSync(restoreDir);
      copyFileSync(backupFile, join(restoreDir, "strata.sqlite"));
      assert.deepEqual(
        readdirSync(restoreDir),
        ["strata.sqlite"],
        "restore starts without stale WAL or SHM sidecars",
      );
      restored = await openLocalStore(restoreDir);
      for (const id of ["backup-owner", "backup-other"]) {
        assert.deepEqual(await restored.accountCredentialsById(id), expected[id].user);
        assert.deepEqual(await restored.plan(id), expected[id].plan);
        assert.deepEqual(await restored.workouts(id, 20, 0), expected[id].history);
      }
      assert.deepEqual(await restored.workout("backup-owner", "backup-workout"), expectedWorkout);
      assert.deepEqual(
        await restored.workout("backup-other", "other-workout"),
        expectedOtherWorkout,
      );
      assert.equal(await restored.workout("backup-other", "backup-workout"), null);
      assert.equal(await restored.workout("backup-owner", "other-workout"), null);
      assert.equal(await restored.deleteWorkout("backup-other", "backup-workout", 2), false);
      assert.equal(
        await restored.updateWorkout(workoutRecord("backup-other", workout, 6000), 2),
        null,
      );
      assert.equal(await restored.workoutCount("backup-owner"), 1);
      assert.equal(await restored.workoutCount("backup-other"), 1);
      const resumed = JSON.parse(expectedWorkout.workout_json);
      resumed.title = "Edited after restore";
      assert.equal(
        (await restored.updateWorkout(workoutRecord("backup-owner", resumed, 6000), 2)).revision,
        3,
      );
      assert.deepEqual(
        await restored.workout("backup-other", "other-workout"),
        expectedOtherWorkout,
      );
      await restored.close();
      restored = null;
      verifyIntegrity(join(restoreDir, "strata.sqlite"));
    } finally {
      backupConnection?.close();
      await source?.close();
      await restored?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
