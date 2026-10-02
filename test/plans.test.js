"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAYS,
  EXERCISES,
  EXERCISE_IDS,
  defaultPlan,
  defaultPreferences,
  planStats,
  sanitizePreferences,
  sanitizeRating,
  sanitizePlan,
  expectedPlanRevision,
  sanitizeMonthlyPlan,
} = require("../src/plans");

function weeklyPlan() {
  const plan = defaultPlan();
  plan.days.Monday.push({
    instanceId: "weekly-item-1",
    exerciseId: "flat-dumbbell-press",
    sets: 3,
    reps: "8–12",
  });
  return plan;
}

function monthlyPlan() {
  const startDate = "2026-01-05";
  const schedule = Object.fromEntries(
    DAYS.map((day) => {
      const rest = day === "Sunday";
      return [day, { rest, targets: rest ? [] : ["chest", "triceps"], sourceItems: [] }];
    }),
  );
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

test("plan domain owns the catalog and returns isolated defaults", () => {
  assert.ok(EXERCISES.length > 100);
  assert.ok(EXERCISE_IDS.has("flat-dumbbell-press"));
  const first = defaultPlan(),
    second = defaultPlan();
  first.days.Monday.push({ exerciseId: "flat-dumbbell-press" });
  assert.deepEqual(second.days.Monday, []);
  assert.equal(defaultPreferences().equipment.length > 0, true);
});

test("weekly plans, preferences, and ratings keep their existing validation contracts", () => {
  const plan = weeklyPlan();
  assert.deepEqual(planStats(plan), { planCount: 1, workoutDays: 1 });
  assert.deepEqual(sanitizePlan(plan), plan);

  const damaged = structuredClone(plan);
  damaged.days.Tuesday.push({
    instanceId: "weekly-item-1",
    exerciseId: "not-in-catalog",
    sets: 0,
    reps: "",
  });
  assert.throws(() => sanitizePlan(damaged), /unknown exercise/);
  const repaired = sanitizePlan(damaged, { repair: true });
  assert.deepEqual(repaired.days.Tuesday, []);

  const preferences = sanitizePreferences({
    goal: "strength",
    level: "Advanced",
    days: 8,
    equipment: [defaultPreferences().equipment[0]],
    preferences: ["stable", "stable"],
    limitations: ["no-floor"],
  });
  assert.equal(preferences.days, 7);
  assert.deepEqual(preferences.preferences, ["stable"]);
  assert.throws(() => sanitizePreferences({ equipment: [] }), /at least one/);
  assert.deepEqual(
    sanitizeRating({ comfort: 1, pump: 2, enjoyment: 3, stability: 4, setup: 5, overall: 4 }),
    { comfort: 1, pump: 2, enjoyment: 3, stability: 4, setup: 5, overall: 4 },
  );
  assert.throws(() => sanitizeRating({}), /whole number/);
});

test("plan revisions accept zero and reject anything that is not a timestamp", () => {
  assert.equal(expectedPlanRevision(0), 0);
  assert.equal(expectedPlanRevision(12), 12);
  assert.throws(
    () => expectedPlanRevision("later"),
    (error) => error.code === "PLAN_VERSION_REQUIRED",
  );
});

test("31-day plan validation remains deterministic at the module boundary", () => {
  const input = monthlyPlan();
  const clean = sanitizeMonthlyPlan(input, { generatedAt: 123 });
  assert.equal(clean.days.length, 31);
  assert.equal(clean.generatedAt, 123);
  assert.equal(clean.days[6].rest, true);

  const unknown = structuredClone(input);
  unknown.days[0].exercises[0].exerciseId = "not-in-catalog";
  assert.throws(
    () => sanitizeMonthlyPlan(unknown),
    (error) => error.code === "INVALID_MONTHLY_PLAN" && /unknown exercise/.test(error.message),
  );
});

test("rest markers support legacy imports, independent days, and no rest days", () => {
  const legacy = { version: 1, restDay: "Sunday", days: defaultPlan().days };
  assert.deepEqual(sanitizePlan(legacy).restDays, ["Sunday"]);
  for (const restDays of [[], ["Wednesday", "Sunday"], DAYS]) {
    const plan = { ...defaultPlan(), restDays, restDay: restDays[0] ?? null };
    assert.deepEqual(sanitizePlan(plan), plan);
  }
  assert.deepEqual(sanitizePlan({ ...legacy, restDay: null }).restDays, []);
});

test("rest validation rejects malformed or conflicting markers before replacing a plan", () => {
  for (const restDays of [null, "Sunday", ["Funday"], ["Sunday", "Sunday"]])
    assert.throws(() => sanitizePlan({ ...defaultPlan(), restDays }), /rest days/);
  assert.throws(() => sanitizePlan({ ...defaultPlan(), restDays: [] }), /fields do not match/);
  assert.throws(
    () => sanitizePlan({ ...weeklyPlan(), restDay: "Monday", restDays: ["Monday", "Sunday"] }),
    /must not contain/,
  );
});

test("legacy repair preserves all seven training days instead of returning an empty default", () => {
  const plan = defaultPlan();
  for (const day of DAYS)
    plan.days[day] = [
      { instanceId: `repair-${day}`, exerciseId: "flat-dumbbell-press", sets: 3, reps: "8" },
    ];
  const repaired = sanitizePlan(plan, { repair: true });
  assert.deepEqual(repaired.days, plan.days);
  assert.deepEqual(repaired.restDays, []);
  assert.equal(repaired.restDay, null);
  assert.deepEqual(sanitizePlan(repaired), repaired);
});
