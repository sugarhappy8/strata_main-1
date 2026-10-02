"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { sanitizeWorkout, summarizeWorkout, createWorkoutService } = require("../src/workouts");
const { workoutFixture } = require("./support/workout-fixtures");

const NOW = 1767603600000;
test("workouts preserve explicit zero load, canonicalize text, and ignore server-owned fields", () => {
  const value = workoutFixture();
  value.title = "  Strength  ";
  value.revision = 50;
  value.updatedAt = 1;
  value.entries[0].sets[0] = { reps: 1, weight: 0, seconds: null, completed: true };
  const workout = sanitizeWorkout(value, NOW);
  assert.equal(workout.title, "Strength");
  assert.equal(workout.revision, undefined);
  assert.equal(workout.updatedAt, undefined);
  assert.equal(workout.entries[0].sets[0].weight, 0);
  assert.equal(workout.entries[0].note, "");
  assert.equal(workout.entries[0].effortType, "none");
  assert.equal(workout.entries[0].sets[0].effort, null);
});

test("workouts preserve bounded notes, optional effort, grouping and replacement provenance", () => {
  const value = workoutFixture();
  const entry = value.entries[0];
  entry.planInstanceId = "plan-entry-1";
  entry.note = "Bench notch 3\nKeep elbows controlled";
  entry.effortType = "rpe";
  entry.supersetGroup = "superset-1";
  entry.replacedFromExerciseId = "incline-dumbbell-press";
  entry.sets[0].effort = 8.5;
  const workout = sanitizeWorkout(value, NOW);
  assert.equal(workout.entries[0].note, entry.note);
  assert.equal(workout.entries[0].effortType, "rpe");
  assert.equal(workout.entries[0].sets[0].effort, 8.5);
  assert.equal(workout.entries[0].supersetGroup, "superset-1");
  assert.equal(workout.entries[0].replacedFromExerciseId, "incline-dumbbell-press");
});

const invalidCases = [
  [
    "unknown exercise",
    (w) => {
      w.entries[0].exerciseId = "invented-exercise";
    },
  ],
  [
    "duplicate entry IDs",
    (w) => {
      w.entries.push(structuredClone(w.entries[0]));
    },
  ],
  [
    "too many entries",
    (w) => {
      w.entries = Array.from({ length: 31 }, (_, i) => ({ ...w.entries[0], id: `entry-${i}` }));
    },
  ],
  [
    "too many sets",
    (w) => {
      w.entries[0].sets = Array(11).fill(w.entries[0].sets[0]);
    },
  ],
  [
    "empty workout",
    (w) => {
      w.entries = [];
    },
  ],
  [
    "fractional repetitions",
    (w) => {
      w.entries[0].sets[0].reps = 1.5;
    },
  ],
  [
    "numeric string repetitions",
    (w) => {
      w.entries[0].sets[0].reps = "10";
    },
  ],
  [
    "unbounded repetitions",
    (w) => {
      w.entries[0].sets[0].reps = 1001;
    },
  ],
  [
    "NaN weight",
    (w) => {
      w.entries[0].sets[0].weight = NaN;
    },
  ],
  [
    "negative weight",
    (w) => {
      w.entries[0].sets[0].weight = -1;
    },
  ],
  [
    "weight precision",
    (w) => {
      w.entries[0].sets[0].weight = 20.123;
    },
  ],
  [
    "weight bound",
    (w) => {
      w.entries[0].sets[0].weight = 1000.01;
    },
  ],
  [
    "no completion flag",
    (w) => {
      delete w.entries[0].sets[0].completed;
    },
  ],
  [
    "zero completed reps",
    (w) => {
      w.entries[0].sets[0].completed = true;
      w.entries[0].sets[0].reps = 0;
    },
  ],
  [
    "missing completed external load",
    (w) => {
      w.entries[0].sets[0].completed = true;
      w.entries[0].sets[0].weight = null;
    },
  ],
  [
    "missing completed assistance",
    (w) => {
      w.entries[0].loadType = "assisted";
      w.entries[0].sets[0].completed = true;
      w.entries[0].sets[0].weight = null;
    },
  ],
  [
    "ambiguous reps and time",
    (w) => {
      w.entries[0].sets[0].seconds = 30;
    },
  ],
  [
    "unknown unit",
    (w) => {
      w.entries[0].unit = "stone";
    },
  ],
  [
    "invalid calendar date",
    (w) => {
      w.date = "2026-02-30";
    },
  ],
  [
    "impossibly old date",
    (w) => {
      w.date = "1800-01-01";
    },
  ],
  [
    "future start",
    (w) => {
      w.startedAt = NOW + 300001;
    },
  ],
  [
    "noninteger elapsed time",
    (w) => {
      w.elapsedSeconds = 1.5;
    },
  ],
  [
    "elapsed limit",
    (w) => {
      w.elapsedSeconds = 604801;
    },
  ],
  [
    "rest before workout",
    (w) => {
      w.restEndsAt = w.startedAt - 1;
    },
  ],
  [
    "unbounded rest",
    (w) => {
      w.restEndsAt = NOW + 3600001;
    },
  ],
  [
    "active completion time",
    (w) => {
      w.completedAt = NOW;
    },
  ],
  [
    "missing completion time",
    (w) => {
      w.status = "completed";
    },
  ],
  [
    "finish with no completed sets",
    (w) => {
      w.status = "completed";
      w.completedAt = NOW;
    },
  ],
  [
    "title controls",
    (w) => {
      w.title = "Strength\nmalformed";
    },
  ],
  [
    "invalid ID",
    (w) => {
      w.id = "../owner";
    },
  ],
  [
    "oversized exercise note",
    (w) => {
      w.entries[0].note = "x".repeat(501);
    },
  ],
  [
    "note control characters",
    (w) => {
      w.entries[0].note = "safe\u0000unsafe";
    },
  ],
  [
    "invalid effort scale",
    (w) => {
      w.entries[0].effortType = "feel";
    },
  ],
  [
    "effort without a scale",
    (w) => {
      w.entries[0].sets[0].effort = 8;
    },
  ],
  [
    "out-of-range RIR",
    (w) => {
      w.entries[0].effortType = "rir";
      w.entries[0].sets[0].effort = 10.5;
    },
  ],
  [
    "fractional RPE precision",
    (w) => {
      w.entries[0].effortType = "rpe";
      w.entries[0].sets[0].effort = 8.25;
    },
  ],
  [
    "invalid superset group",
    (w) => {
      w.entries[0].supersetGroup = "group one";
    },
  ],
  [
    "unknown replacement provenance",
    (w) => {
      w.entries[0].replacedFromExerciseId = "invented-exercise";
    },
  ],
];
for (const [name, mutate] of invalidCases)
  test(`workout validation rejects ${name}`, () => {
    const value = workoutFixture();
    mutate(value);
    assert.throws(
      () => sanitizeWorkout(value, NOW),
      (error) => error.status === 400 && error.code === "INVALID_WORKOUT",
    );
  });

test("completed summaries exclude unfinished sets, bodyweight and assistance from lifted-volume records", () => {
  const workout = workoutFixture();
  workout.status = "completed";
  workout.completedAt = NOW;
  workout.elapsedSeconds = 1800;
  workout.entries[0].sets = [
    { reps: 10, weight: 20, seconds: null, completed: true },
    { reps: 8, weight: 22.5, seconds: null, completed: true },
    { reps: 1000, weight: 1000, seconds: null, completed: false },
  ];
  workout.entries.push({
    ...structuredClone(workout.entries[0]),
    id: "bodyweight",
    loadType: "bodyweight",
    sets: [{ reps: 15, weight: null, seconds: null, completed: true }],
  });
  workout.entries.push({
    ...structuredClone(workout.entries[0]),
    id: "assisted",
    loadType: "assisted",
    sets: [{ reps: 12, weight: 40, seconds: null, completed: true }],
  });
  workout.entries.push({
    ...structuredClone(workout.entries[0]),
    id: "timed",
    measurement: "timed",
    loadType: "bodyweight",
    sets: [
      { reps: null, weight: null, seconds: 60, completed: true },
      { reps: null, weight: null, seconds: 120, completed: false },
    ],
  });
  const summary = summarizeWorkout(sanitizeWorkout(workout, NOW));
  assert.equal(summary.totalSets, 7);
  assert.equal(summary.completedSets, 5);
  assert.equal(summary.exerciseCount, 4);
  const [external, bodyweight, assisted, timed] = summary.exerciseSummaries;
  assert.deepEqual(
    {
      reps: external.totalReps,
      maxReps: external.maxReps,
      maxWeight: external.maxWeight,
      minAssistance: external.minAssistance,
      volume: external.volume,
    },
    { reps: 18, maxReps: 10, maxWeight: 22.5, minAssistance: null, volume: 380 },
  );
  for (const item of [bodyweight, assisted, timed]) {
    assert.equal(item.volume, 0);
    assert.equal(item.maxWeight, null);
  }
  assert.equal(assisted.minAssistance, 40);
  assert.equal(bodyweight.minAssistance, null);
  assert.equal(timed.minAssistance, null);
  assert.equal(bodyweight.totalReps, 15);
  assert.equal(assisted.totalReps, 12);
  assert.equal(timed.totalSeconds, 60);
  assert.equal(timed.maxSeconds, 60);
  assert.equal(timed.maxReps, null);
  assert.deepEqual(external.setValues, [
    { reps: 10, weight: 20, seconds: null, effort: null, effortType: "none" },
    { reps: 8, weight: 22.5, seconds: null, effort: null, effortType: "none" },
  ]);
  assert.deepEqual(timed.setValues, [
    { reps: null, weight: null, seconds: 60, effort: null, effortType: "none" },
  ]);
});
test("summary groups keep kilograms and pounds and load types separate", () => {
  const workout = workoutFixture();
  workout.entries[0].sets[0].completed = true;
  workout.entries.push({ ...structuredClone(workout.entries[0]), id: "pounds", unit: "lb" });
  workout.entries.push({ ...structuredClone(workout.entries[0]), id: "same-kg" });
  const summary = summarizeWorkout(sanitizeWorkout(workout, NOW));
  assert.equal(summary.exerciseSummaries.length, 2);
  assert.equal(summary.exerciseSummaries[0].completedSets, 2);
  assert.equal(summary.exerciseSummaries[0].volume, 400);
});
test("workout service rejects incomplete dependencies", () => {
  assert.throws(() => createWorkoutService({}), /requires store/);
});
