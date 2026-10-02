"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  adaptationForFeedback,
  planWithAdaptation,
  progressionForWorkout,
  sanitizeCheckIn,
  sanitizeTrainingBlock,
} = require("../src/training");
const { defaultPlan } = require("../src/plans");
const { workoutFixture } = require("./support/workout-fixtures");
const { routeHarness } = require("./support/route-harness");

function completed(id, startedAt, reps = 10, weight = 40) {
  const workout = workoutFixture(id);
  startedAt = Date.UTC(2026, 0, 1) + startedAt * 86400;
  workout.startedAt = startedAt;
  workout.date = new Date(startedAt).toISOString().slice(0, 10);
  workout.status = "completed";
  workout.completedAt = startedAt + 60000;
  workout.entries[0].sets = workout.entries[0].sets.map(() => ({
    reps,
    weight,
    seconds: null,
    completed: true,
  }));
  return workout;
}
function timed(id, startedAt, seconds = 40) {
  const workout = completed(id, startedAt);
  workout.entries[0].measurement = "timed";
  workout.entries[0].loadType = "bodyweight";
  workout.entries[0].prescribedReps = "30–45 sec";
  workout.entries[0].sets = workout.entries[0].sets.map(() => ({
    reps: null,
    weight: null,
    seconds,
    completed: true,
  }));
  return workout;
}
function assisted(id, startedAt, reps = 12, weight = 40) {
  const workout = completed(id, startedAt, reps, weight);
  workout.entries[0].loadType = "assisted";
  return workout;
}

test("post-workout check-ins and 4–8 week block state use bounded explicit fields", () => {
  assert.deepEqual(sanitizeCheckIn({ difficulty: 3, energy: 4, comfort: 5, enjoyment: 4 }), {
    difficulty: 3,
    energy: 4,
    comfort: 5,
    enjoyment: 4,
  });
  for (const input of [
    null,
    {},
    { difficulty: 0, energy: 4, comfort: 5, enjoyment: 4 },
    { difficulty: 3, energy: 4, comfort: 5, enjoyment: 4.5 },
  ]) {
    assert.throws(() => sanitizeCheckIn(input));
  }
  const block = sanitizeTrainingBlock({
    title: "Strength foundation",
    goal: "strength",
    weeks: 6,
    currentWeek: 1,
    lightWeek: 5,
    startDate: "2026-09-07",
    status: "active",
    progressionRule: "reps-then-load",
  });
  assert.equal(block.weeks, 6);
  assert.equal(block.lightWeek, 5);
  assert.deepEqual(
    block.milestones.map((item) => item.week),
    [1, 5, 6],
  );
  assert.throws(() => sanitizeTrainingBlock({ ...block, weeks: 3 }), /4 to 8/);
  assert.throws(() => sanitizeTrainingBlock({ ...block, status: "completed" }), /final week/);
  assert.throws(
    () =>
      sanitizeTrainingBlock({
        ...block,
        milestones: [
          { week: 2, label: "A" },
          { week: 2, label: "B" },
        ],
      }),
    /different week/,
  );
});

test("progression uses full completed sessions and supports optional check-ins", () => {
  const current = completed("current", 2000, 10),
    prior = completed("prior", 1000, 9);
  const first = progressionForWorkout(current, [], null).suggestions[0];
  assert.equal(first.action, "repeat");
  assert.equal(first.basis, "baseline");
  assert.match(first.explanation, /baseline/i);
  const noCheckIn = progressionForWorkout(current, [prior], null).suggestions[0];
  assert.equal(noCheckIn.action, "increase_reps");
  assert.equal(noCheckIn.target.reps, 11);
  assert.match(noCheckIn.explanation, /if reps felt controlled/i);
  assert.deepEqual(
    noCheckIn.targetSets.map((set) => set.reps),
    [11, 10],
  );
  for (const checkIn of [
    { difficulty: 3, energy: 4, comfort: 2, enjoyment: 4 },
    { difficulty: 3, energy: 2, comfort: 4, enjoyment: 4 },
    { difficulty: 5, energy: 4, comfort: 4, enjoyment: 4 },
  ]) {
    const held = progressionForWorkout(current, [prior], checkIn).suggestions[0];
    assert.equal(held.action, "repeat");
    assert.equal(held.basis, "hold");
  }
  const increase = progressionForWorkout(current, [prior], {
    difficulty: 3,
    energy: 4,
    comfort: 4,
    enjoyment: 4,
  }).suggestions[0];
  assert.equal(increase.action, "increase_reps");
  assert.equal(increase.target.reps, 11);
  assert.equal(increase.basis, "comparable-progression");
  const top = completed("top", 3000, 12),
    topPrior = completed("top-prior", 2000, 12);
  const load = progressionForWorkout(top, [topPrior], null).suggestions[0];
  assert.equal(load.action, "increase_load");
  assert.equal(load.target.weight, 42.5);
  assert.equal(load.target.reps, 8);
  const lighterWeek = progressionForWorkout(top, [topPrior], null, "reps-then-load", true)
    .suggestions[0];
  assert.equal(lighterWeek.action, "repeat");
  assert.equal(lighterWeek.basis, "lighter-week");
  assert.match(lighterWeek.explanation, /lighter week/i);
  assert.match(lighterWeek.explanation, /review/i);
  const repsOnly = progressionForWorkout(top, [topPrior], null, "reps-only");
  assert.equal(repsOnly.progressionRule, "reps-only");
  assert.equal(repsOnly.suggestions[0].action, "repeat");
  assert.equal(repsOnly.suggestions[0].target.reps, 12);
  const timedRule = progressionForWorkout(current, [prior], null, "time").suggestions[0];
  assert.equal(timedRule.action, "repeat");
  assert.equal(timedRule.basis, "block-rule");
  const time = progressionForWorkout(
    timed("timed", 5000),
    [timed("timed-prior", 4000)],
    null,
    "time",
  ).suggestions[0];
  assert.equal(time.action, "increase_time");
  assert.equal(time.target.seconds, 45);
  const belowPrior = progressionForWorkout(completed("below", 3000, 8), [current], null)
    .suggestions[0];
  assert.equal(belowPrior.action, "repeat");
  assert.equal(belowPrior.basis, "repeat-comparable");
});

test("assisted progression lowers assistance only after two complete top-of-range sessions", () => {
  const current = assisted("assisted-current", 3000),
    prior = assisted("assisted-prior", 2000);
  const suggestion = progressionForWorkout(current, [prior], {
    difficulty: 3,
    energy: 4,
    comfort: 4,
    enjoyment: 4,
  }).suggestions[0];
  assert.equal(suggestion.action, "reduce_assistance");
  assert.equal(suggestion.basis, "comparable-progression");
  assert.deepEqual(suggestion.completed, { reps: 12, weight: 40, seconds: null });
  assert.deepEqual(suggestion.previous, { reps: 12, weight: 40, seconds: null });
  assert.deepEqual(suggestion.target, { reps: 8, weight: 37.5, seconds: null });
  assert.ok(suggestion.target.weight < suggestion.completed.weight);
});

test("feedback creates an optional plan proposal without changing the supplied plan", () => {
  const workout = completed("adapt-source", 2000),
    plan = defaultPlan();
  plan.restDays = [];
  plan.restDay = null;
  plan.days.Monday = [
    { instanceId: "monday-press", exerciseId: "flat-dumbbell-press", sets: 3, reps: "8–12" },
  ];
  const proposal = adaptationForFeedback({
    workout,
    plan,
    planUpdatedAt: 123,
    checkIn: { difficulty: 5, energy: 3, comfort: 4, enjoyment: 3 },
  });
  assert.equal(plan.days.Monday[0].sets, 3, "building a proposal must not mutate the active plan");
  assert.equal(proposal.change.fromSets, 3);
  assert.equal(proposal.change.toSets, 2);
  assert.equal(
    Object.hasOwn(proposal, "proposedPlan"),
    false,
    "proposal storage must not contain a full plan snapshot",
  );
  assert.equal(proposal.expectedPlanUpdatedAt, 123);
  const applied = planWithAdaptation(plan, proposal);
  assert.equal(applied.days.Monday[0].sets, 2);
  assert.equal(plan.days.Monday[0].sets, 3);
  assert.throws(
    () =>
      planWithAdaptation(plan, {
        ...proposal,
        change: { ...proposal.change, fromSets: 4, toSets: 3 },
      }),
    /no longer matches/i,
  );
  assert.throws(
    () => planWithAdaptation(plan, { ...proposal, change: { ...proposal.change, toSets: 1 } }),
    /invalid/i,
  );
  assert.match(proposal.explanation, /optional/i);
  assert.match(proposal.explanation, /does not diagnose/i);
  assert.equal(
    adaptationForFeedback({
      workout,
      plan,
      planUpdatedAt: 123,
      checkIn: { difficulty: 3, energy: 4, comfort: 4, enjoyment: 1 },
    }),
    null,
  );
});

async function serviceProgression(current, rows, rawWorkouts) {
  const { createTrainingService } = require("../src/training"),
    pages = [],
    reads = [];
  let response;
  const json = (_res, status, payload) => {
    response = { status, payload };
  };
  const training = createTrainingService({
    store: {
      async workout(_user, id) {
        reads.push(id);
        const workout = id === current.id ? current : rawWorkouts.get(id);
        return workout ? { workout_json: JSON.stringify(workout) } : null;
      },
      async workouts(_user, limit, offset) {
        pages.push({ limit, offset });
        return rows.slice(offset, offset + limit);
      },
      async workoutCheckIn() {
        return null;
      },
      async trainingBlock() {
        return null;
      },
    },
    rateAllowed: () => true,
    http: { json, bodyJson: async () => ({}) },
  });
  const service = routeHarness(training.routes, {
    json,
    requireFeature: () => async () => ({ id: "member", csrf_token: "token" }),
  });
  await service.handleApi(
    { method: "GET", headers: {} },
    {},
    new URL(`http://localhost/api/workouts/${current.id}/progression`),
  );
  assert.equal(response.status, 200);
  return { ...response.payload.progression, pages, reads };
}
function historyRow(workout) {
  const { summarizeWorkout } = require("../src/workouts");
  return { summary_json: JSON.stringify(summarizeWorkout(workout)) };
}

test("service progression searches beyond 100 histories without fetching unrelated full workouts", async () => {
  const current = completed("page-current", 8000, 12),
    prior = completed("page-prior", 1000, 12);
  const unrelated = Array.from({ length: 105 }, (_, index) => {
    const workout = completed(`unrelated-${index}`, 7900 - index, 12);
    workout.entries[0].exerciseId = "dumbbell-lateral-raise";
    return workout;
  });
  const rows = [current, ...unrelated, prior].map(historyRow),
    result = await serviceProgression(current, rows, new Map([[prior.id, prior]]));
  assert.equal(result.suggestions[0].action, "increase_load");
  assert.equal(result.suggestions[0].target.weight, 42.5);
  assert.deepEqual(result.pages, [
    { limit: 100, offset: 0 },
    { limit: 100, offset: 100 },
  ]);
  assert.deepEqual(result.reads, [current.id, prior.id]);
  assert.equal(result.historyLimited, false);
});

test("an older workout fetched for another exercise cannot revive a missing newest source", async () => {
  const current = completed("mixed-current", 8000, 12),
    latest = completed("missing-latest", 7000, 12),
    older = completed("mixed-older", 1000, 12);
  for (const workout of [current, older])
    workout.entries.push({
      ...structuredClone(workout.entries[0]),
      id: "entry-b",
      exerciseId: "dumbbell-lateral-raise",
    });
  const result = await serviceProgression(
    current,
    [current, latest, older].map(historyRow),
    new Map([[older.id, older]]),
  );
  assert.equal(result.suggestions[0].exerciseId, "flat-dumbbell-press");
  assert.equal(result.suggestions[0].action, "repeat");
  assert.equal(result.suggestions[1].exerciseId, "dumbbell-lateral-raise");
  assert.equal(result.suggestions[1].action, "increase_load");
});

test("missing or malformed summary indexes recover the newest raw exercise without skipping its incomplete sets", async () => {
  for (const index of [undefined, null, [null], []]) {
    const current = completed("index-current", 8000, 12),
      latest = completed("index-latest", 7000, 12),
      older = completed("index-older", 1000, 12);
    latest.entries[0].sets[1].completed = false;
    const row = historyRow(latest),
      summary = JSON.parse(row.summary_json);
    summary.exerciseSummaries = index;
    row.summary_json = JSON.stringify(summary);
    const result = await serviceProgression(
      current,
      [historyRow(current), row, historyRow(older)],
      new Map([
        [latest.id, latest],
        [older.id, older],
      ]),
    );
    assert.equal(result.suggestions[0].action, "repeat");
    assert.equal(result.suggestions[0].basis, "incomplete");
    assert.ok(!result.reads.includes(older.id));
  }
});

test("unrecoverable or partially missing raw histories hold instead of falling through to an older success", async () => {
  const current = completed("unrecoverable-current", 8000, 12),
    latest = completed("unrecoverable-latest", 7000, 12),
    older = completed("unrecoverable-older", 1000, 12);
  for (const raw of [null, { ...latest, entries: [] }]) {
    const result = await serviceProgression(
      current,
      [current, latest, older].map(historyRow),
      new Map([
        [latest.id, raw],
        [older.id, older],
      ]),
    );
    assert.equal(result.suggestions[0].action, "repeat");
    assert.ok(!result.reads.includes(older.id));
  }
  const corrupt = await serviceProgression(
    current,
    [historyRow(current), { summary_json: "broken" }, historyRow(older)],
    new Map([[older.id, older]]),
  );
  assert.equal(corrupt.suggestions[0].action, "repeat");
  assert.ok(!corrupt.reads.includes(older.id));
});

test("a missing summary index with unusable raw entries cannot fall back to older work", async () => {
  const current = completed("partial-current", 8000, 12),
    latest = completed("partial-latest", 7000, 12),
    older = completed("partial-older", 1000, 12);
  const row = historyRow(latest),
    summary = JSON.parse(row.summary_json);
  delete summary.exerciseSummaries;
  row.summary_json = JSON.stringify(summary);
  for (const entries of [null, [], [null], [{ exerciseId: "flat-dumbbell-press" }]]) {
    const result = await serviceProgression(
      current,
      [historyRow(current), row, historyRow(older)],
      new Map([
        [latest.id, { ...latest, entries }],
        [older.id, older],
      ]),
    );
    assert.equal(result.suggestions[0].action, "repeat");
    assert.ok(!result.reads.includes(older.id));
  }
});

test("service history traversal stops at 5,000 rows and reports the limit", async () => {
  const current = completed("limited-current", 8000, 12),
    unrelated = completed("limited-unrelated", 7000, 12);
  unrelated.entries[0].exerciseId = "dumbbell-lateral-raise";
  const result = await serviceProgression(
    current,
    Array.from({ length: 5001 }, () => historyRow(unrelated)),
    new Map(),
  );
  assert.equal(result.suggestions[0].action, "repeat");
  assert.equal(result.historyLimited, true);
  assert.equal(result.pages.length, 50);
  assert.equal(result.pages.at(-1).offset, 4900);
  assert.match(result.suggestions[0].explanation, /5,000 most recent/);
  assert.deepEqual(result.reads, [current.id]);
});
