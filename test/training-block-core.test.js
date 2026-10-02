"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const context = { Intl, Date };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  readFileSync(join(__dirname, "..", "public", "scripts", "training-block-core.js"), "utf8"),
  context,
  { filename: "training-block-core.js" },
);
const Block = context.StrataTrainingBlock;

const plan = {
  days: {
    Monday: [
      { exerciseId: "press", sets: 3 },
      { exerciseId: "fly", sets: 2 },
    ],
    Tuesday: [],
    Wednesday: [{ exerciseId: "row", sets: 4 }],
    Thursday: [],
    Friday: [],
    Saturday: [],
    Sunday: [],
  },
};
const exercises = [
  { id: "press", group: "chest" },
  { id: "fly", group: "chest" },
  { id: "row", group: "back" },
];
const workout = (id, date, pressWeight, { replaced = false, skipped = false } = {}) => ({
  id,
  date,
  status: "completed",
  startedAt: Date.parse(`${date}T12:00:00Z`),
  ...(replaced ? { replacedCount: 1 } : {}),
  ...(skipped ? { skippedCount: 1 } : {}),
  exerciseSummaries: [
    {
      exerciseId: "press",
      measurement: "reps",
      loadType: "external",
      unit: "kg",
      completedSets: 3,
      maxWeight: pressWeight,
      maxReps: 8,
    },
  ],
});

test("calendar-derived block week is bounded before, during, and after the saved date range", () => {
  const block = { weeks: 6, startDate: "2026-09-01", status: "active" };
  assert.deepEqual(JSON.parse(JSON.stringify(Block.deriveWeek(block, "2026-08-20"))), {
    valid: true,
    weeks: 6,
    week: 1,
    startDate: "2026-09-01",
    weekStart: "2026-09-01",
    weekEnd: "2026-09-07",
    blockEnd: "2026-10-12",
    beforeStart: true,
    afterEnd: false,
  });
  assert.equal(Block.deriveWeek(block, "2026-09-07").week, 1);
  assert.equal(Block.deriveWeek(block, "2026-09-08").week, 2);
  const ended = Block.deriveWeek(block, "2027-01-01");
  assert.equal(ended.week, 6);
  assert.equal(ended.afterEnd, true);
});

test("weekly review separates planned and completed work and uses catalog muscles", () => {
  const block = {
    weeks: 6,
    startDate: "2026-09-01",
    status: "active",
    lightWeek: null,
    milestones: [],
  };
  const review = Block.weekReview({
    block,
    weeklyPlan: plan,
    exercises,
    workouts: [
      workout("prior", "2026-08-25", 20),
      workout("one", "2026-09-02", 22.5, { replaced: true }),
      workout("two", "2026-09-04", 22.5, { skipped: true }),
    ],
    today: "2026-09-04",
  });
  assert.equal(review.plannedWorkouts, 2);
  assert.equal(review.completedWorkouts, 2);
  assert.equal(review.plannedSets, 9);
  assert.equal(review.completedSets, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(review.muscles)), [
    { key: "chest", label: "Chest", planned: 5, completed: 6 },
    { key: "back", label: "Back", planned: 4, completed: 0 },
  ]);
  assert.equal(review.replaced.available, true);
  assert.equal(review.replaced.count, 1);
  assert.equal(review.skipped.available, true);
  assert.equal(review.skipped.count, 1);
});

test("performance and skip or replacement claims appear only with comparable or explicit evidence", () => {
  const block = {
    weeks: 4,
    startDate: "2026-09-01",
    status: "active",
    lightWeek: null,
    milestones: [],
  };
  const first = Block.weekReview({
    block,
    weeklyPlan: plan,
    exercises,
    workouts: [workout("one", "2026-09-02", 20)],
    today: "2026-09-02",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(first.performance)), {
    improvements: [],
    records: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(first.skipped)), { available: false, count: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(first.replaced)), { available: false, count: 0 });
  const improved = Block.weekReview({
    block,
    weeklyPlan: plan,
    exercises,
    workouts: [workout("prior", "2026-08-28", 20), workout("current", "2026-09-02", 25)],
    today: "2026-09-02",
  });
  assert.equal(improved.performance.improvements.length, 1);
  assert.equal(improved.performance.records.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(improved.performance.records[0])), {
    exerciseId: "press",
    date: "2026-09-02",
    before: "20 kg",
    after: "25 kg",
  });
});

test("review actions change block metadata only and never receive or mutate the weekly Plan", () => {
  const block = {
    title: "Six weeks",
    goal: "strength",
    weeks: 6,
    currentWeek: 1,
    lightWeek: null,
    startDate: "2026-09-01",
    status: "active",
    progressionRule: "reps-then-load",
    milestones: [{ week: 1, label: "Baseline" }],
    revision: 4,
    updatedAt: 10,
  };
  const original = JSON.parse(JSON.stringify(block));
  const carry = Block.actionProposal(block, "carry", "2026-09-10");
  assert.equal(carry.block.currentWeek, 2);
  assert.equal(carry.block.status, "active");
  const lighter = Block.actionProposal(block, "lighter", "2026-09-10");
  assert.equal(lighter.block.lightWeek, 3);
  assert.match(lighter.description, /does not reduce, remove, or replace/i);
  const finish = Block.actionProposal(block, "finish", "2026-09-10");
  assert.equal(finish.block.status, "completed");
  assert.equal(finish.block.currentWeek, 6);
  assert.equal(Object.hasOwn(carry.block, "revision"), false);
  assert.equal(Object.hasOwn(carry.block, "updatedAt"), false);
  assert.deepEqual(block, original);
});

test("next decision stays singular and avoids readiness or injury claims", () => {
  const block = { weeks: 6, startDate: "2026-09-01", status: "active", lightWeek: null };
  const review = Block.weekReview({
    block,
    weeklyPlan: plan,
    exercises,
    workouts: [],
    today: "2026-09-02",
  });
  assert.match(review.nextDecision, /next planned workout/i);
  assert.doesNotMatch(review.nextDecision, /readiness|recovered|injury/i);
  assert.equal(review.actions.carry, true);
  assert.equal(review.actions.finish, true);
});
