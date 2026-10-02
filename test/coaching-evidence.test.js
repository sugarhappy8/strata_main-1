"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalProfile,
  compatibleWeek,
  readCoachingEvidence,
  readCoachingDiary,
} = require("../src/coaching-evidence");
const { addDays, sanitizeCoachingProfile } = require("../src/coaching-core");
const { summarizeWorkout } = require("../src/workouts");

const WEEK = "2026-09-14",
  OWNER = "current-owner";
function profile(overrides = {}) {
  return {
    ...sanitizeCoachingProfile({
      version: 4,
      measurementSystem: "metric",
      preferredLoadUnit: "kg",
      age: 32,
      heightCm: 178,
      weightKg: 82,
      bodyFatPercent: null,
      sexForEquation: "male",
      goal: "maintenance",
      goalPace: "moderate",
      experience: "intermediate",
      dailyMovement: "mostly_seated",
      additionalActivityMinutesPerWeek: 0,
      additionalActivityIntensity: "moderate",
      workoutDays: ["Monday", "Wednesday", "Friday"],
      sessionMinutes: 60,
      usualExercises: [],
      availableEquipment: [],
      movementLimitations: [],
      caloriePattern: "steady",
      flexibleDay: null,
      macroPreference: "balanced",
      timeZone: "Asia/Dubai",
    }),
    revision: 2,
    updatedAt: 1000,
    ...overrides,
  };
}
function snapshot(start = WEEK, inputs = profile(), calories = 2400) {
  return {
    weekStart: start,
    planKey: `key-${start}`,
    profileRevision: inputs.revision,
    inputs,
    nutrition: {
      dailyTargets: Array.from({ length: 7 }, (_, i) => ({
        date: addDays(start, i),
        calories,
        macros: { proteinG: 150, carbsG: 300, fatG: 66 },
        kind: "standard",
      })),
    },
  };
}
function row(week) {
  return {
    week_start: week.weekStart,
    plan_key: week.planKey,
    profile_revision: week.profileRevision,
    snapshot_json: JSON.stringify(week),
  };
}
function completed(date = "2026-09-11", id = `workout-${date}`) {
  return {
    id,
    title: "Recorded workout",
    planDay: "Friday",
    date,
    status: "completed",
    startedAt: Date.parse(`${date}T12:00:00Z`),
    completedAt: Date.parse(`${date}T13:00:00Z`),
    elapsedSeconds: 3600,
    entries: [
      {
        id: `entry-${date}`,
        exerciseId: "flat-dumbbell-press",
        measurement: "reps",
        loadType: "external",
        unit: "kg",
        prescribedReps: "6–12",
        effortType: "rir",
        sets: Array.from({ length: 3 }, () => ({
          reps: 12,
          weight: 40,
          seconds: null,
          effort: 3,
          completed: true,
        })),
      },
    ],
  };
}
function store(overrides = {}) {
  const calls = [];
  const defaults = {
    coachingDailyLogs: [],
    coachingWeek: null,
    workouts: [],
    workout: null,
    workoutCheckIn: null,
  };
  return {
    calls,
    ...Object.fromEntries(
      Object.entries(defaults).map(([name, fallback]) => [
        name,
        async (...args) => {
          calls.push([name, ...args]);
          assert.equal(args[0], OWNER, "every read must retain the authenticated owner");
          return typeof overrides[name] === "function"
            ? overrides[name](...args)
            : (overrides[name] ?? fallback);
        },
      ]),
    ),
  };
}
function workoutStore(workouts, overrides = {}) {
  return store({
    workouts: workouts.map((workout) => ({
      summary_json: JSON.stringify(summarizeWorkout(workout)),
      revision: 1,
    })),
    workout: (_owner, id) => {
      const workout = workouts.find((value) => value.id === id);
      return workout ? { workout_json: JSON.stringify(workout), revision: 1 } : null;
    },
    ...overrides,
  });
}

test("canonical compatibility preserves normalized legacy defaults and rejects mismatched snapshot identity", () => {
  const p = profile(),
    week = snapshot(WEEK, p),
    saved = row(week);
  assert.equal(canonicalProfile({ ...p, revision: 99, updatedAt: 999 }), canonicalProfile(p));
  assert.deepEqual(compatibleWeek(saved, p), week);
  const legacy = structuredClone(week);
  delete legacy.inputs.trainingGoal;
  assert.ok(compatibleWeek(row(legacy), p));
  assert.equal(canonicalProfile({ ...p, sessionsPerWeek: 6 }), null);
  assert.equal(canonicalProfile({ ...p, untrusted: true }), null);
  assert.equal(canonicalProfile([]), null);
  for (const change of [
    { week_start: "2026-09-07" },
    { plan_key: "other" },
    { profile_revision: 3 },
    { snapshot_json: "not-json" },
  ])
    assert.equal(compatibleWeek({ ...saved, ...change }, p), null);
  assert.equal(compatibleWeek(saved, { ...p, revision: 3 }), null);
  assert.equal(compatibleWeek(saved, { ...p, weightKg: 83 }), null);
  const tuesday = { ...week, weekStart: "2026-09-15" };
  assert.equal(compatibleWeek(row(tuesday), p), null);
});

test("evidence reads owner-filtered bounded windows and preserves full completed sets with check-in provenance", async () => {
  const workout = completed(),
    previous = snapshot("2026-09-07"),
    db = workoutStore([workout], {
      coachingDailyLogs: [
        { log_date: "2026-09-13", calories: 2500, intake_complete: 1, morning_weight_kg: 81 },
        { log_date: WEEK, calories: 8000 },
        { log_date: "2026-01-01", calories: 8000 },
      ],
      coachingWeek: (_owner, date) => (date === previous.weekStart ? row(previous) : null),
      workoutCheckIn: {
        workout_id: workout.id,
        difficulty: 3,
        energy: 4,
        comfort: 4,
        enjoyment: 4,
        updated_at: Date.parse("2026-09-11T14:00:00Z"),
      },
    });
  const result = await readCoachingEvidence(db, OWNER, WEEK, profile());
  assert.equal(result.limited, false);
  assert.deepEqual(result.workouts, [workout]);
  assert.equal(result.checkIns[0].updatedAt, Date.parse("2026-09-11T14:00:00Z"));
  assert.equal(result.previousWeek.weekStart, "2026-09-07");
  assert.deepEqual(result.dailyLogs, [
    { date: "2026-09-13", calories: 2500, complete: true, morningWeightKg: 81 },
  ]);
  assert.ok(
    db.calls.some(
      (call) =>
        JSON.stringify(call) ===
        JSON.stringify(["coachingDailyLogs", OWNER, "2026-08-03", "2026-09-13"]),
    ),
  );
  assert.ok(
    db.calls.some((call) => JSON.stringify(call) === JSON.stringify(["workouts", OWNER, 100, 0])),
  );
  assert.equal(db.calls.filter((call) => call[0] === "coachingWeek").length, 6);
});

test("future, active and stale summaries do not become completed training evidence", async () => {
  const active = { ...completed("2026-09-10"), status: "active", completedAt: null },
    db = workoutStore([completed("2026-09-15"), completed("2026-07-01"), active]);
  const result = await readCoachingEvidence(db, OWNER, WEEK, profile());
  assert.deepEqual(result.workouts, []);
  assert.equal(result.limited, false);
  assert.equal(db.calls.filter((call) => call[0] === "workout").length, 0);
});

test("malformed, missing, partial, changed-date and concurrently changed records create a conservative history barrier", async () => {
  const workout = completed(),
    summary = { summary_json: JSON.stringify(summarizeWorkout(workout)), revision: 1 };
  const variants = [
    null,
    { workout_json: "broken", revision: 1 },
    { workout_json: JSON.stringify({ ...workout, date: "2026-09-10" }), revision: 1 },
    { workout_json: JSON.stringify({ ...workout, entries: [] }), revision: 1 },
    {
      workout_json: JSON.stringify({ ...workout, entries: [{ ...workout.entries[0], sets: [] }] }),
      revision: 1,
    },
    { workout_json: JSON.stringify(workout), revision: 2 },
  ];
  for (const raw of variants) {
    const db = store({ workouts: [summary], workout: () => raw }),
      result = await readCoachingEvidence(db, OWNER, WEEK, profile());
    assert.equal(result.limited, true);
    assert.deepEqual(result.workouts, []);
  }
  for (const summary_json of [
    "broken",
    JSON.stringify({ id: workout.id, date: "2026-02-30", status: "completed" }),
    JSON.stringify({ ...summarizeWorkout(workout), exerciseCount: 2 }),
  ]) {
    const db = workoutStore([workout], { workouts: [{ summary_json, revision: 1 }] }),
      result = await readCoachingEvidence(db, OWNER, WEEK, profile());
    assert.equal(result.limited, true);
    assert.deepEqual(result.workouts, []);
  }
});

test("truncation and duplicate summary identities cannot silently imply complete history", async () => {
  const workouts = Array.from({ length: 101 }, (_, index) =>
      completed("2026-09-11", `workout-${index}`),
    ),
    db = workoutStore(workouts),
    result = await readCoachingEvidence(db, OWNER, WEEK, profile());
  assert.equal(result.limited, true);
  assert.equal(result.workouts.length, 100);
  assert.equal(db.calls.filter((call) => call[0] === "workout").length, 100);
  const duplicate = workoutStore([workouts[0], workouts[0]]);
  assert.equal((await readCoachingEvidence(duplicate, OWNER, WEEK, profile())).limited, true);
  const unrelatedCheckIn = workoutStore([workouts[0]], {
    workoutCheckIn: {
      workout_id: "another-workout",
      difficulty: 3,
      energy: 4,
      comfort: 4,
      enjoyment: 4,
    },
  });
  assert.deepEqual(
    (await readCoachingEvidence(unrelatedCheckIn, OWNER, WEEK, profile())).checkIns,
    [],
  );
});

test("previous evidence accepts only the requested earlier week and an identical canonical profile", async () => {
  const wrong = snapshot("2026-09-07", profile({ weightKg: 83 })),
    older = snapshot("2026-08-31"),
    db = store({
      coachingWeek: (_owner, date) =>
        date === "2026-09-07" ? row(wrong) : date === "2026-08-31" ? row(older) : null,
    });
  assert.equal(
    (await readCoachingEvidence(db, OWNER, WEEK, profile())).previousWeek.weekStart,
    "2026-08-31",
  );
  const misrouted = store({
    coachingWeek: (_owner, date) => (date === "2026-09-21" ? row(snapshot("2026-09-07")) : null),
  });
  assert.equal(
    (await readCoachingEvidence(misrouted, OWNER, "2026-09-28", profile())).previousWeek,
    null,
  );
});

test("diary dates preserve historical targets from old profiles and never borrow today's calorie target", async () => {
  const week = snapshot(),
    old = snapshot("2026-09-07", profile({ revision: 1, weightKg: 75 }), 1900),
    db = store({
      coachingWeek: (_owner, date) => (date === old.weekStart ? row(old) : null),
      coachingDailyLogs: [
        { log_date: "2026-09-10", calories: 1850 },
        { log_date: "2026-09-17", calories: 9000 },
      ],
    });
  const result = await readCoachingDiary(db, OWNER, week, "2026-09-16"),
    byDate = new Map(result.logTargets.map((target) => [target.date, target]));
  assert.equal(result.diaryStartDate, "2026-08-05");
  assert.equal(result.diaryEndDate, "2026-09-16");
  assert.equal(result.logTargets.length, 43);
  assert.equal(byDate.get("2026-09-10").calories, 1900);
  assert.deepEqual(byDate.get("2026-09-10").macros, old.nutrition.dailyTargets[3].macros);
  assert.equal(byDate.get("2026-09-16").calories, 2400);
  assert.equal(byDate.get("2026-08-06").calories, null);
  assert.deepEqual(result.rows, [{ log_date: "2026-09-10", calories: 1850 }]);
});

test("historical snapshots cannot override dates in other weeks or contribute ambiguous target dates", async () => {
  const week = snapshot(),
    old = snapshot("2026-09-07", profile({ revision: 1 }), 1900);
  old.nutrition.dailyTargets.push(
    { date: WEEK, calories: 9999 },
    { date: "2026-09-10", calories: 9999 },
    { date: "2026-09-09", calories: "9999" },
    { date: "2026-02-30", calories: 9999 },
  );
  const db = store({ coachingWeek: (_owner, date) => (date === old.weekStart ? row(old) : null) }),
    result = await readCoachingDiary(db, OWNER, week, "2026-09-16"),
    byDate = new Map(result.logTargets.map((target) => [target.date, target]));
  assert.equal(byDate.get(WEEK).calories, 2400);
  assert.equal(byDate.get("2026-09-10").calories, null);
  assert.equal(byDate.get("2026-09-09").calories, 1900);
  for (const bad of [
    { ...row(old), profile_revision: 8 },
    { ...row(old), plan_key: "different" },
    row({ ...old, nutrition: { dailyTargets: { unexpected: true } } }),
  ]) {
    const invalid = store({
        coachingWeek: (_owner, date) => (date === old.weekStart ? bad : null),
      }),
      response = await readCoachingDiary(invalid, OWNER, week, "2026-09-16");
    assert.equal(response.logTargets.find((target) => target.date === "2026-09-09").calories, null);
  }
});
