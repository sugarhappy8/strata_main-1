"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../public/scripts/plan-insights-core");
const exercises = require("../public/data/exercises.json");

function plan() {
  return {
    version: 1,
    restDay: "Sunday",
    restDays: ["Sunday"],
    days: Object.fromEntries(Core.DAYS.map((day) => [day, []])),
  };
}
function item(instanceId, exerciseId, sets = 3, reps = "8–12") {
  return { instanceId, exerciseId, sets, reps };
}

test("plan analysis explains actual volume, timing, coverage, equipment, and repeats", () => {
  const input = plan();
  input.days.Monday = [
    item("mon-press-1", "flat-dumbbell-press", 4),
    item("mon-row-01", "chest-supported-row", 4),
  ];
  input.days.Wednesday = [
    item("wed-press-1", "flat-dumbbell-press", 3),
    item("wed-squat-1", "high-bar-squat", 5),
  ];
  input.days.Friday = [
    item("fri-press-1", "flat-dumbbell-press", 2),
    item("fri-curl-01", "incline-curl", 3),
  ];
  const result = Core.analyzePlan(input, exercises);
  assert.deepEqual(result.metrics, {
    trainingDays: 3,
    totalExercises: 6,
    workingSets: 21,
    estimatedMinutes: 70,
  });
  assert.deepEqual(
    result.days
      .filter(({ movements }) => movements)
      .map(({ day, workingSets }) => [day, workingSets]),
    [
      ["Monday", 8],
      ["Wednesday", 8],
      ["Friday", 5],
    ],
  );
  assert.equal(result.muscles.find(({ key }) => key === "chest").sets, 9);
  assert.equal(result.muscles.find(({ key }) => key === "biceps").sets, 3);
  assert.ok(result.equipment.some(({ label }) => label === "Dumbbells"));
  assert.deepEqual(result.duplicates[0].uniqueDays, ["Monday", "Wednesday", "Friday"]);
  assert.ok(result.alerts.some(({ id }) => id === "high-frequency-repeats"));
  assert.match(result.nextAction, /Review repeated movements/);
});

test("analysis flags only observable density and never invents recovery claims", () => {
  const input = plan();
  input.restDays = [];
  input.restDay = null;
  input.days.Monday = Array.from({ length: 10 }, (_, index) =>
    item(`dense-${index}`, exercises[index].id, 3),
  );
  const result = Core.analyzePlan(input, exercises),
    serialized = JSON.stringify(result);
  assert.ok(result.alerts.some(({ id }) => id === "dense-days"));
  assert.ok(result.alerts.some(({ id }) => id === "no-rest-day"));
  assert.doesNotMatch(serialized, /readiness|injury|overtrain|fatigue\s*score/i);
});

test("copy-day previews replace or merge without mutating the saved plan", () => {
  const input = plan();
  input.days.Monday = [
    item("monday-press", "flat-dumbbell-press", 4),
    item("monday-row-1", "chest-supported-row", 3),
  ];
  input.days.Tuesday = [
    item("tuesday-press", "flat-dumbbell-press", 2),
    item("tuesday-curl", "incline-curl", 3),
  ];
  const before = JSON.stringify(input);
  const merge = Core.copyDayPreview(input, "Monday", "Tuesday", { mode: "merge" });
  assert.equal(JSON.stringify(input), before, "preview must not mutate the stored plan");
  assert.equal(merge.added, 1);
  assert.deepEqual(merge.skipped, ["flat-dumbbell-press"]);
  assert.equal(merge.plan.days.Tuesday.length, 3);
  assert.equal(
    new Set(Core.DAYS.flatMap((day) => merge.plan.days[day].map(({ instanceId }) => instanceId)))
      .size,
    5,
  );
  const replace = Core.copyDayPreview(input, "Monday", "Sunday", { mode: "replace" });
  assert.equal(replace.replaced, 0);
  assert.equal(replace.plan.days.Sunday.length, 2);
  assert.deepEqual(replace.plan.restDays, []);
  assert.equal(replace.changed, true);
});

test("copy-day previews reject ambiguous or oversized writes", () => {
  const input = plan();
  input.days.Monday = [item("monday-one", "flat-dumbbell-press")];
  assert.throws(() => Core.copyDayPreview(input, "Monday", "Monday"), /different valid/);
  assert.throws(
    () => Core.copyDayPreview(input, "Monday", "Tuesday", { mode: "append" }),
    /replace or merge/,
  );
  input.days.Monday = Array.from({ length: 30 }, (_, index) =>
    item(`source-${index}`, exercises[index].id),
  );
  input.days.Tuesday = [item("existing-one", "dead-bug")];
  assert.throws(
    () => Core.copyDayPreview(input, "Monday", "Tuesday", { mode: "merge" }),
    /exceed 30/,
  );
});
