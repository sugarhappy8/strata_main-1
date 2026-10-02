"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const Core = require("../public/scripts/discovery-core");
const exercises = require("../public/data/exercises.json");
const profile = {
  goal: "balanced",
  level: "Intermediate",
  days: 4,
  equipment: [...new Set(exercises.map((exercise) => exercise.equipment))],
  preferences: [],
  limitations: [],
};
const now = new Date(2026, 8, 10, 12),
  byId = (id) => exercises.find((exercise) => exercise.id === id);
const week = (ids = []) => ({
  days: Object.fromEntries(
    Core.WEEKDAYS.map((day, index) => [
      day,
      ids
        .filter((_, position) => position % 7 === index)
        .map((exerciseId) => ({ exerciseId, sets: 3 })),
    ]),
  ),
});
const options = {
  exercises,
  preferences: profile,
  focus: "full",
  minutes: 35,
  now,
  weeklyPlan: week(),
};
const ids = (session) => session.items.map((item) => item.exerciseId);
const seeded = (initial) => {
  let state = initial;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};
const workout = (id, date, rows, status = "completed") => ({
  id,
  date,
  status,
  completedAt: 1,
  exerciseSummaries: rows.map(([exerciseId, completedSets, extra = {}]) => ({
    exerciseId,
    completedSets,
    ...extra,
  })),
});
const chestOptions = { ...options, muscleGroup: "chest", minutes: 20 };

test("all four modes preserve unique, feasible roles, focus, equipment and constraints", () => {
  const constrained = {
    ...profile,
    equipment: ["Dumbbells", "Machine", "Cables"],
    limitations: ["no-overhead", "no-floor", "no-unilateral"],
  };
  for (const selectionMode of Object.keys(Core.SESSION_SELECTION_MODES))
    for (const focus of ["full", "upper", "lower", "push", "pull"]) {
      const session = Core.buildSession({
        ...options,
        preferences: constrained,
        selectionMode,
        focus,
        random: seeded(3),
      });
      assert.equal(session.items.length, 4);
      assert.equal(new Set(ids(session)).size, 4);
      assert.equal(session.selectionLabel, Core.SESSION_SELECTION_MODES[selectionMode].label);
      assert.ok(session.selectionNote);
      session.items.forEach((item, index) => {
        assert.equal(
          Core.personalResult(item.exercise, constrained).eligible,
          true,
          item.exerciseId,
        );
        assert.equal(
          Core.sessionRoleMatches(item.exercise, Core.SESSION_FOCUSES[focus].slots[index]),
          true,
          item.exerciseId,
        );
        assert.equal(Core.sessionFocusMatches(item.exercise, focus), true, item.exerciseId);
        assert.ok(item.reasons.length >= 2);
      });
    }
});

test("Random uses injectable randomness and does not inherit week or popularity ranking", () => {
  const input = { ...options, selectionMode: "random", minutes: 50 },
    first = Core.buildSession({ ...input, random: seeded(9) });
  assert.deepEqual(ids(first), ids(Core.buildSession({ ...input, random: seeded(9) })));
  const variants = new Set(
    Array.from({ length: 8 }, (_, index) =>
      JSON.stringify(ids(Core.buildSession({ ...input, random: seeded(index + 1) }))),
    ),
  );
  assert.ok(variants.size > 1, "rebuilding should shuffle choices");
  assert.deepEqual(
    ids(first),
    ids(
      Core.buildSession({
        ...input,
        weeklyPlan: week(ids(first)),
        userRatings: new Map([[first.items[0].exerciseId, { overall: 1 }]]),
        random: seeded(9),
      }),
    ),
  );
  assert.ok(
    first.items.every((item) => item.reasons.some((reason) => /randomly selected/.test(reason))),
  );
});

test("Not in my week excludes every weekday, and an exhausted pool never adds repeats", () => {
  const planned = exercises
      .filter((exercise, index) => index % 3 === 0)
      .map((exercise) => exercise.id),
    plan = week(planned),
    before = JSON.stringify(plan);
  const session = Core.buildSession({
    ...options,
    selectionMode: "not-in-week",
    weeklyPlan: plan,
    random: seeded(4),
  });
  assert.ok(session.items.every((item) => !planned.includes(item.exerciseId)));
  assert.equal(JSON.stringify(plan), before);
  assert.throws(
    () =>
      Core.buildSession({
        ...options,
        selectionMode: "not-in-week",
        weeklyPlan: week(exercises.map((exercise) => exercise.id)),
      }),
    { code: "SESSION_POOL_TOO_SMALL", message: /Only 0.*no repeats were added/ },
  );
  assert.throws(
    () => Core.buildSession({ ...options, selectionMode: "not-in-week", weeklyPlan: null }),
    { code: "SESSION_WEEK_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      Core.buildSession({
        ...options,
        selectionMode: "not-in-week",
        weeklyPlan: { days: { Monday: [] } },
      }),
    { code: "SESSION_WEEK_UNAVAILABLE" },
  );
  assert.match(
    Core.buildSession({ ...options, selectionMode: "not-in-week" }).selectionNote,
    /plan is empty/,
  );
});

test("Not in my week reports role shortages after excluding all planned substitutes", () => {
  const allBack = exercises
    .filter((exercise) => exercise.group === "back")
    .map((exercise) => exercise.id);
  assert.throws(
    () =>
      Core.buildSession({ ...options, selectionMode: "not-in-week", weeklyPlan: week(allBack) }),
    { code: "SESSION_ROLE_UNAVAILABLE", message: /upper-body pull.*no repeats were added/ },
  );
});

test("muscle and exact subtarget filters produce full targeted sessions without unrelated roles", () => {
  assert.ok(
    Core.sessionMuscleTargets(exercises, "push", "arms").every((target) =>
      target.includes("Triceps"),
    ),
  );
  assert.deepEqual(Core.sessionMuscleTargets(exercises, "pull", "chest"), []);
  for (const minutes of [20, 35, 50])
    for (const selectionMode of Object.keys(Core.SESSION_SELECTION_MODES)) {
      const session = Core.buildSession({
        ...options,
        minutes,
        selectionMode,
        muscleGroup: "chest",
        random: seeded(minutes),
      });
      assert.equal(session.items.length, Core.SESSION_LENGTHS[minutes].count);
      assert.ok(session.items.every((item) => item.exercise.group === "chest"));
      assert.equal(new Set(ids(session)).size, session.items.length);
    }
  const exact = Core.buildSession({
    ...chestOptions,
    selectionMode: "random",
    muscleTarget: "Upper chest",
    random: seeded(2),
  });
  assert.equal(exact.items.length, 3);
  assert.ok(exact.items.every((item) => item.exercise.sub === "Upper chest"));
  assert.equal(exact.focusLabel, "Upper chest");
  assert.throws(
    () =>
      Core.buildSession({
        ...options,
        selectionMode: "random",
        focus: "pull",
        muscleGroup: "chest",
      }),
    { code: "INVALID_SESSION_MUSCLE_GROUP" },
  );
  assert.throws(
    () => Core.buildSession({ ...chestOptions, selectionMode: "random", muscleTarget: "Biceps" }),
    { code: "INVALID_SESSION_MUSCLE_TARGET" },
  );
  const onlyTwo = exercises.filter((exercise) => exercise.sub === "Upper chest").slice(0, 2);
  assert.throws(
    () =>
      Core.buildSession({
        ...chestOptions,
        exercises: onlyTwo,
        selectionMode: "random",
        muscleTarget: "Upper chest",
      }),
    { code: "SESSION_POOL_TOO_SMALL", message: /Only 2.*broader muscle target/ },
  );
});

test("Needs focus prioritizes fewer completed subtarget sets within the last 28 calendar days", () => {
  const workouts = [
    workout("recent", "2026-09-10", [
      ["incline-dumbbell-press", 12],
      ["cable-serratus-punch", 12],
    ]),
    workout("old", "2026-08-13", [["flat-dumbbell-press", 300]]),
    workout("active", "2026-09-10", [["flat-dumbbell-press", 300]], "active"),
    workout("skips", "2026-09-10", [
      ["flat-dumbbell-press", 300, { skipped: true }],
      ["flat-dumbbell-press", 300, { status: "skipped" }],
      ["flat-dumbbell-press", 0],
    ]),
    workout("future", "2026-09-11", [["flat-dumbbell-press", 300]]),
    workout("bad-date", "2026-02-30", [["flat-dumbbell-press", 300]]),
  ];
  const result = Core.buildSession({
    ...chestOptions,
    selectionMode: "needs-focus",
    workouts,
    workoutHistoryAvailable: true,
  });
  assert.equal(result.items[0].exercise.sub, "Mid / lower chest");
  assert.ok(
    result.items[0].reasons.some((reason) => /0 completed sets logged for mid/.test(reason)),
  );
  assert.match(result.selectionNote, /28 calendar days/);
  const boundary = Core.buildSession({
    ...chestOptions,
    selectionMode: "needs-focus",
    workouts: [...workouts, workout("boundary", "2026-08-14", [["flat-dumbbell-press", 20]])],
    workoutHistoryAvailable: true,
  });
  assert.notEqual(
    boundary.items[0].exercise.sub,
    "Mid / lower chest",
    "today minus 27 days must still count",
  );
});

test("Needs focus counts completed raw sets, ignores drafts, and avoids duplicate summary counting", () => {
  const workouts = [
    workout("targets", "2026-09-10", [
      ["incline-dumbbell-press", 2],
      ["cable-serratus-punch", 2],
    ]),
    {
      id: "raw",
      date: "2026-09-10",
      status: "completed",
      entries: [
        {
          exerciseId: "flat-dumbbell-press",
          sets: [
            { completed: true },
            { completed: false },
            { completed: true, skipped: true },
            { completed: true, status: "draft" },
          ],
        },
      ],
    },
    {
      id: "draft",
      date: "2026-09-10",
      status: "active",
      entries: [{ exerciseId: "flat-dumbbell-press", sets: [{ completed: true }] }],
    },
  ];
  const result = Core.buildSession({
    ...chestOptions,
    selectionMode: "needs-focus",
    workouts: [...workouts, workouts[1]],
    workoutHistoryAvailable: true,
  });
  assert.equal(result.items[0].exercise.sub, "Mid / lower chest");
  assert.ok(result.items[0].reasons.some((reason) => /1 completed set logged/.test(reason)));
  const summaryWins = {
    ...workouts[1],
    exerciseSummaries: [{ exerciseId: "flat-dumbbell-press", completedSets: 5 }],
  };
  assert.notEqual(
    Core.buildSession({
      ...chestOptions,
      selectionMode: "needs-focus",
      workouts: [workouts[0], summaryWins],
      workoutHistoryAvailable: true,
    }).items[0].exercise.sub,
    "Mid / lower chest",
  );
});

test("Needs focus discloses unavailable, empty, irrelevant, and truncated history", () => {
  const base = { ...chestOptions, selectionMode: "needs-focus" },
    history = [workout("one", "2026-09-10", [["flat-dumbbell-press", 8]])];
  const unavailable = Core.buildSession({ ...base, workouts: history });
  assert.match(unavailable.selectionNote, /history is unavailable.*saved training profile/);
  assert.ok(
    unavailable.items.every((item) =>
      item.reasons.every((reason) => !reason.includes("completed sets logged")),
    ),
  );
  assert.match(
    Core.buildSession({ ...base, workoutHistoryAvailable: true }).selectionNote,
    /No completed sets were found/,
  );
  assert.match(
    Core.buildSession({
      ...base,
      workoutHistoryAvailable: true,
      workouts: [workout("back", "2026-09-10", [["neutral-pulldown", 8]])],
    }).selectionNote,
    /No completed sets were found for this focus/,
  );
  const partial = Core.buildSession({
    ...base,
    workouts: history,
    workoutHistoryAvailable: true,
    workoutHistoryHasMore: true,
  });
  assert.match(partial.selectionNote, /older sessions may be missing/);
  assert.ok(partial.items[0].reasons.some((reason) => reason.includes("available history")));
  const withoutDate = { ...history[0], date: undefined, completedAt: now.getTime() };
  assert.match(
    Core.buildSession({ ...base, workouts: [withoutDate], workoutHistoryAvailable: true })
      .selectionNote,
    /Prioritizes/,
  );
});

test("My preferences favors a user's own saved exercise and ratings without community signals", () => {
  const preferred = "archer-pushup",
    base = { ...chestOptions, selectionMode: "preferences" };
  assert.equal(
    Core.buildSession({ ...base, shortlist: [preferred] }).items[0].exerciseId,
    preferred,
  );
  const rated = Core.buildSession({
    ...base,
    userRatings: new Map([[preferred, { overall: 5, enjoyment: 5 }]]),
  });
  assert.equal(rated.items[0].exerciseId, preferred);
  assert.ok(rated.items[0].reasons.some((reason) => /your own.*5\/5/.test(reason)));
  const disliked = Core.buildSession({
    ...base,
    userRatings: new Map([[preferred, { overall: 1, enjoyment: 1 }]]),
  });
  assert.ok(!ids(disliked).includes(preferred));
  const baseline = Core.buildSession(base);
  assert.deepEqual(
    ids(
      Core.buildSession({
        ...base,
        aggregate: new Map([[preferred, { overall: 5, rating_count: 10000 }]]),
      }),
    ),
    ids(baseline),
  );
  assert.match(baseline.selectionNote, /No shortlist, own ratings, or repeated completed choices/);
});

test("My preferences uses repeated completed choices and names history as the evidence", () => {
  const preferred = "archer-pushup",
    history = [
      workout("one", "2026-09-10", [[preferred, 3]]),
      workout("two", "2026-09-09", [[preferred, 2]]),
    ],
    base = { ...chestOptions, selectionMode: "preferences", workoutHistoryAvailable: true };
  const result = Core.buildSession({ ...base, workouts: history, workoutHistoryHasMore: true });
  assert.equal(result.items[0].exerciseId, preferred);
  assert.ok(
    result.items[0].reasons.some((reason) =>
      reason.includes("completed in 2 of your saved sessions"),
    ),
  );
  assert.match(result.selectionNote, /older sessions may be missing/);
  assert.doesNotMatch(result.items[0].reasons.join(" "), /you\s*like|you\s*love/);
  const once = Core.buildSession({ ...base, workouts: [history[0]] });
  assert.match(once.selectionNote, /No shortlist, own ratings, or repeated completed choices/);
  const unavailable = Core.buildSession({
    ...base,
    workoutHistoryAvailable: false,
    workouts: history,
    shortlist: ["incline-dumbbell-press"],
  });
  assert.equal(unavailable.items[0].exerciseId, "incline-dumbbell-press");
  assert.match(unavailable.selectionNote, /Workout history is unavailable/);
});

test("My preferences learns same-muscle choices from saved, highly rated and repeatedly trained targets", () => {
  const base = {
    ...chestOptions,
    selectionMode: "preferences",
    exercises: exercises.filter((exercise) => exercise.id !== "incline-dumbbell-press"),
  };
  // The saved/rated source stays in the catalog but is unavailable for this user's equipment.
  const machineOnly = {
    ...base,
    exercises,
    preferences: { ...profile, equipment: ["Machine", "Cables", "Bodyweight"] },
    userRatings: new Map([["incline-dumbbell-press", { overall: 5, enjoyment: 5 }]]),
  };
  const rated = Core.buildSession(machineOnly);
  assert.equal(rated.items[0].exercise.sub, "Upper chest");
  assert.ok(
    rated.items[0].reasons.some((reason) => reason.includes("targets you save or rate highly")),
  );
  assert.doesNotMatch(rated.selectionNote, /No\s*shortlist/);
  const repeated = Core.buildSession({
    ...machineOnly,
    userRatings: new Map(),
    workoutHistoryAvailable: true,
    workouts: [
      workout("one", "2026-09-09", [["incline-dumbbell-press", 3]]),
      workout("two", "2026-09-10", [["incline-dumbbell-press", 3]]),
    ],
  });
  assert.equal(repeated.items[0].exercise.sub, "Upper chest");
  assert.ok(
    repeated.items[0].reasons.some((reason) => reason.includes("targets you repeatedly train")),
  );
});

test("conflicting preference evidence never invents a shortage of alternatives", () => {
  const preferred = "chinup",
    workouts = Array.from({ length: 10 }, (_, index) =>
      workout(`repeat-${index}`, "2026-09-10", [[preferred, 3]]),
    );
  const session = Core.buildSession({
    ...options,
    selectionMode: "preferences",
    muscleGroup: "arms",
    muscleTarget: "Biceps",
    shortlist: [preferred],
    userRatings: new Map([[preferred, { overall: 1, enjoyment: 1 }]]),
    workouts,
    workoutHistoryAvailable: true,
  });
  assert.ok(exercises.filter((exercise) => exercise.sub === "Biceps").length >= 7);
  assert.equal(session.items[0].exerciseId, preferred);
  const reason = session.items[0].reasons.join(" ");
  assert.match(reason, /rating is 1\/5.*saved to your shortlist.*completed in 10/);
  assert.doesNotMatch(reason, /limited|shortage|unavailable|no\s*alternatives/);
});

test("lookahead reserves the only feasible exercise for a later required role", () => {
  const source = [
    byId("hack-squat"),
    byId("romanian-deadlift"),
    byId("machine-chest-press"),
    byId("neutral-pulldown"),
  ];
  const session = Core.buildSession({
    ...options,
    exercises: source,
    selectionMode: "random",
    random: () => 0,
  });
  assert.equal(session.items[0].exerciseId, "hack-squat");
  assert.equal(session.items[3].exerciseId, "romanian-deadlift");
  assert.equal(new Set(ids(session)).size, 4);
});

test("new modes reject invalid settings and leave source data untouched", () => {
  for (const selectionMode of ["unknown", "toString", null])
    assert.throws(() => Core.buildSession({ ...options, selectionMode }), {
      code: "INVALID_SESSION_SELECTION_MODE",
    });
  assert.throws(
    () => Core.buildSession({ ...options, selectionMode: "random", focus: "unknown" }),
    { code: "INVALID_SESSION_FOCUS" },
  );
  assert.throws(() => Core.buildSession({ ...options, selectionMode: "random", minutes: 45 }), {
    code: "INVALID_SESSION_LENGTH",
  });
  assert.throws(
    () => Core.buildSession({ ...options, selectionMode: "random", preferences: null }),
    { code: "INVALID_SESSION_PROFILE" },
  );
  const data = {
      exercises: structuredClone(exercises),
      preferences: structuredClone(profile),
      weeklyPlan: week(),
      workouts: [workout("one", "2026-09-10", [["archer-pushup", 3]])],
    },
    before = JSON.stringify(data);
  Core.buildSession({ ...data, selectionMode: "preferences", workoutHistoryAvailable: true, now });
  assert.equal(JSON.stringify(data), before);
});
