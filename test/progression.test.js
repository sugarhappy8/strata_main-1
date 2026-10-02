"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  progressionForWorkout,
  findPreviousWorkout,
  prescribedRange,
} = require("../src/progression");

function session(id, date = "2026-09-08", reps = [12, 12, 12], weight = 40, overrides = {}) {
  const startedAt = Date.parse(`${date}T10:00:00Z`);
  return {
    id,
    date,
    startedAt,
    completedAt: startedAt + 3600000,
    status: "completed",
    entries: [
      {
        id: `${id}-entry`,
        exerciseId: "flat-dumbbell-press",
        measurement: "reps",
        loadType: "external",
        unit: "kg",
        prescribedReps: "8–12",
        effortType: "none",
        sets: reps.map((value) => ({
          reps: value,
          weight,
          seconds: null,
          effort: null,
          completed: true,
        })),
        ...overrides,
      },
    ],
  };
}
function suggestion(
  current = session("current"),
  prior = session("prior", "2026-09-01"),
  checkIn = null,
  rule = "reps-then-load",
  light = false,
) {
  return progressionForWorkout(current, prior ? [prior] : [], checkIn, rule, light).suggestions[0];
}
const recorded = (entry) =>
  entry.sets.map(({ reps, weight, seconds, completed }) => ({
    reps: completed ? reps : null,
    weight: completed && entry.loadType !== "bodyweight" ? weight : null,
    seconds: completed ? seconds : null,
    effort: null,
  }));

test("two complete top-of-range sessions recommend an exact modest next-exposure load", () => {
  const current = session("current"),
    prior = session("prior", "2026-09-01"),
    before = JSON.stringify([current, prior]);
  const result = suggestion(current, prior);
  assert.equal(result.action, "increase_load");
  assert.equal(result.target.weight, 42.5);
  assert.equal(result.target.reps, 8);
  assert.deepEqual(
    result.targetSets,
    Array.from({ length: 3 }, () => ({ reps: 8, weight: 42.5, seconds: null, effort: null })),
  );
  assert.equal(result.entryId, "current-entry");
  assert.equal(result.sourceDate, current.date);
  assert.equal(result.sourceStartedAt, current.startedAt);
  assert.equal(result.setCount, 3);
  assert.equal(result.prescribedReps, "8–12");
  assert.equal(result.timing, "Next time you train this exercise");
  assert.match(result.explanation, /two comparable sessions/);
  assert.match(result.explanation, /If reps felt controlled/);
  assert.equal(JSON.stringify([current, prior]), before);
  const pound = suggestion(
    session("pound", undefined, undefined, 80, { unit: "lb" }),
    session("pound-prior", "2026-09-01", undefined, 80, { unit: "lb" }),
  );
  assert.equal(pound.target.weight, 85);
});

test("baseline works without a check-in and does not increase from a best set", () => {
  const current = session("current", "2026-09-08", [12, 10, 9]),
    first = suggestion(current, null);
  assert.equal(first.action, "repeat");
  assert.equal(first.basis, "baseline");
  assert.deepEqual(first.targetSets, recorded(current.entries[0]));
  const next = suggestion(current, session("prior", "2026-09-01", [12, 10, 9]));
  assert.equal(next.action, "increase_reps");
  assert.deepEqual(
    next.targetSets.map((set) => set.reps),
    [12, 10, 10],
  );
  assert.equal(next.target.weight, 40);
  assert.equal(next.target.reps, 10);
  const firstTop = suggestion(session("top"), session("prior", "2026-09-01", [11, 11, 11]));
  assert.equal(firstTop.action, "repeat");
  assert.match(firstTop.explanation, /two comparable sessions/);
});

test("holds preserve individual values for incomplete, mixed-load, regressing, and adverse sessions", () => {
  const variants = [
    (current) => {
      current.entries[0].sets[2].completed = false;
    },
    (current) => {
      current.entries[0].sets[2].weight = 35;
    },
    (current) => {
      current.entries[0].sets[2].reps = 10;
    },
    (current) => {
      current.entries[0].effortType = "rir";
      current.entries[0].sets[1].effort = 1.5;
    },
    (current) => {
      current.entries[0].effortType = "rpe";
      current.entries[0].sets[1].effort = 8.5;
    },
  ];
  for (const mutate of variants) {
    const current = session("current");
    mutate(current);
    const result = suggestion(current);
    assert.equal(result.action, "repeat");
    assert.deepEqual(result.targetSets, recorded(current.entries[0]));
  }
  for (const checkIn of [
    { comfort: 2, energy: 4, difficulty: 3 },
    { comfort: 4, energy: 2, difficulty: 3 },
    { comfort: 4, energy: 4, difficulty: 5 },
  ]) {
    const result = suggestion(undefined, undefined, checkIn);
    assert.equal(result.action, "repeat");
    assert.equal(result.basis, "hold");
  }
  const light = suggestion(undefined, undefined, null, "reps-then-load", true);
  assert.equal(light.action, "repeat");
  assert.equal(light.basis, "lighter-week");
  assert.match(light.explanation, /review/);
});

test("the immediately preceding exposure cannot be skipped for an older successful session", () => {
  for (const mutate of [
    (prior) => {
      prior.entries[0].sets[2].completed = false;
    },
    (prior) => {
      prior.entries[0].sets = [];
    },
    (prior) => {
      prior.entries[0].sets.pop();
    },
    (prior) => {
      prior.entries[0].prescribedReps = "6–10";
    },
    (prior) => {
      for (const set of prior.entries[0].sets) set.weight = 35;
    },
    (prior) => {
      prior.entries[0].sets[1].weight = 35;
    },
    (prior) => {
      prior.entries[0].sets[1].reps = 6;
    },
    (prior) => {
      prior.entries[0].effortType = "rpe";
      prior.entries[0].sets[1].effort = "8";
    },
    (prior) => {
      prior.entries[0].sets[1].seconds = 30;
    },
    (prior) => {
      prior.entries.push({ ...prior.entries[0], id: "duplicate" });
    },
    (prior) => {
      prior.entries[0].effortType = "rir";
      prior.entries[0].sets[2].effort = 1;
    },
  ]) {
    const current = session("current"),
      prior = session("prior", "2026-09-07");
    mutate(prior);
    const result = progressionForWorkout(current, [session("old", "2026-09-01"), prior], null)
      .suggestions[0];
    assert.equal(result.action, "repeat");
    assert.deepEqual(result.targetSets, recorded(current.entries[0]));
  }
});

test("matching requires measurement, load type, units, prescription, and a different earlier day", () => {
  const current = session("current");
  const histories = [
    session("same-day", "2026-09-08"),
    session("future", "2026-09-10"),
    session("pounds", "2026-09-07", undefined, 80, { unit: "lb" }),
    session("assisted", "2026-09-06", undefined, 40, { loadType: "assisted" }),
    session("timed", "2026-09-05", undefined, 40, { measurement: "timed" }),
    { id: "summary", status: "completed", startedAt: 1, exerciseSummaries: [] },
    null,
    { ...session("invalid-date", "2026-09-01"), date: "2026-02-30" },
  ];
  histories[0].startedAt -= 600000;
  histories[0].completedAt = histories[0].startedAt + 10000;
  assert.equal(suggestion(current, null).action, "repeat");
  assert.equal(findPreviousWorkout(current, histories, current.entries[0]), null);
  const good = session("good", "2026-09-01", undefined, 40, { prescribedReps: "8-12 reps" });
  assert.equal(
    progressionForWorkout(current, [...histories, good], null).suggestions[0].action,
    "increase_load",
  );
  const overlaps = session("overlap", "2026-09-07");
  overlaps.completedAt = current.startedAt + 1;
  assert.equal(findPreviousWorkout(current, [overlaps], current.entries[0]), null);
});

test("duplicate formats stay separate and cannot receive a merged best-set recommendation", () => {
  const current = session("current");
  current.entries.push({
    ...current.entries[0],
    id: "second",
    sets: [{ reps: 8, weight: 30, seconds: null, completed: true }],
  });
  const results = progressionForWorkout(
    current,
    [session("prior", "2026-09-01")],
    null,
  ).suggestions;
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.entryId),
    ["current-entry", "second"],
  );
  assert.ok(results.every((result) => result.action === "repeat" && result.basis === "ambiguous"));
  assert.equal(results[1].targetSets[0].weight, 30);
});

test("low loads and upper numeric bounds hold rather than inventing available increments", () => {
  for (const weight of [0, 2, 10, 20, 998, 1000]) {
    const result = suggestion(
      session("current", undefined, undefined, weight),
      session("prior", "2026-09-01", undefined, weight),
    );
    assert.equal(result.action, "repeat");
    assert.equal(result.target.weight, weight);
    assert.equal(result.basis, "smaller-increment");
    assert.match(result.explanation, /smaller available increment/);
  }
  assert.equal(
    suggestion(
      session("current", undefined, undefined, 25),
      session("prior", "2026-09-01", undefined, 25),
    ).target.weight,
    27.5,
  );
});

test("assistance decreases only after two qualifying exposures and is never described as lifted load", () => {
  const options = { loadType: "assisted" },
    result = suggestion(
      session("current", undefined, undefined, 40, options),
      session("prior", "2026-09-01", undefined, 40, options),
    );
  assert.equal(result.action, "reduce_assistance");
  assert.equal(result.target.weight, 37.5);
  assert.equal(result.target.reps, 8);
  assert.match(result.explanation, /37.5 kg of assistance/);
  const small = suggestion(
    session("current", undefined, undefined, 2, options),
    session("prior", "2026-09-01", undefined, 2, options),
  );
  assert.equal(small.action, "repeat");
  assert.equal(small.target.weight, 2);
});

test("bodyweight and block rules never fabricate load or go past explicit rep ceilings", () => {
  const options = { loadType: "bodyweight" };
  const result = suggestion(
    session("current", undefined, [10, 10, 10], null, options),
    session("prior", "2026-09-01", [10, 10, 10], null, options),
  );
  assert.equal(result.action, "increase_reps");
  assert.deepEqual(
    result.targetSets.map((set) => set.reps),
    [11, 10, 10],
  );
  assert.ok(result.targetSets.every((set) => set.weight === null));
  assert.equal(suggestion(undefined, undefined, null, "reps-only").action, "repeat");
  assert.equal(suggestion(undefined, undefined, null, "time").basis, "block-rule");
  const atTop = suggestion(
    session("current", undefined, undefined, null, options),
    session("prior", "2026-09-01", undefined, null, options),
  );
  assert.equal(atTop.action, "repeat");
  assert.equal(atTop.target.weight, null);
});

test("timed progression changes only the weakest set within its prescription", () => {
  function timed(id, date) {
    const workout = session(id, date, [40, 42, 45], null, {
      measurement: "timed",
      loadType: "bodyweight",
      prescribedReps: "30–45 sec",
    });
    for (const set of workout.entries[0].sets) {
      set.seconds = set.reps;
      set.reps = null;
    }
    return workout;
  }
  const current = timed("current", "2026-09-08"),
    prior = timed("prior", "2026-09-01"),
    result = suggestion(current, prior, null, "time");
  assert.equal(result.action, "increase_time");
  assert.deepEqual(
    result.targetSets.map((set) => set.seconds),
    [45, 42, 45],
  );
  assert.equal(suggestion(current, prior, null, "reps-only").basis, "block-rule");
  assert.deepEqual(prescribedRange(current.entries[0]), { low: 30, high: 45 });
  assert.equal(prescribedRange({ prescribedReps: "-8–12" }), null);
  assert.equal(prescribedRange({ prescribedReps: "8–1001" }), null);
});

test("invalid or partial values never become a numerical progression", () => {
  for (const value of [null, undefined, NaN, Infinity, -1, 1001, "12"]) {
    const current = session("current");
    current.entries[0].sets[0].reps = value;
    const result = suggestion(current);
    assert.equal(result.action, "repeat");
    assert.ok(result.targetSets.every((set) => set.reps === null || Number.isFinite(set.reps)));
  }
  const current = session("current");
  current.entries[0].sets[1] = null;
  assert.equal(suggestion(current).action, "repeat");
  assert.equal(progressionForWorkout({ ...current, entries: [] }, [], null).suggestions.length, 0);
});

test("unchecked draft values are never recommended as recorded targets", () => {
  const current = session("current");
  current.entries[0].sets[2] = {
    reps: 999,
    weight: 1000,
    seconds: null,
    effort: 10,
    completed: false,
  };
  const result = suggestion(current);
  assert.equal(result.action, "repeat");
  assert.equal(result.basis, "incomplete");
  assert.deepEqual(result.targetSets[0], { reps: 12, weight: 40, seconds: null, effort: null });
  assert.deepEqual(result.targetSets[2], { reps: null, weight: null, seconds: null, effort: null });
  assert.ok(!result.targetSets.some((set) => set.weight === 1000 || set.reps === 999));
});

test("a gap longer than 28 days establishes a fresh baseline", () => {
  const current = session("current", "2026-09-08"),
    old = session("old", "2026-08-10"),
    recent = session("recent", "2026-08-11");
  const result = suggestion(current, old);
  assert.equal(result.action, "repeat");
  assert.equal(result.basis, "stale-baseline");
  assert.match(result.explanation, /fresh baseline/);
  assert.deepEqual(result.targetSets, recorded(current.entries[0]));
  assert.equal(suggestion(current, recent).action, "increase_load");
  current.startedAt += 12 * 3600000;
  current.completedAt += 12 * 3600000;
  assert.equal(
    suggestion(current, recent).action,
    "increase_load",
    "28 calendar days remains comparable despite the later time of day",
  );
});

test("unrecognized prescriptions hold rather than using an invented progression ceiling", () => {
  for (const prescribedReps of ["AMRAP", "8–12 / side", "2–3 minutes", "15–30 m", ""]) {
    const current = session("current", undefined, [10, 10, 10], 40, { prescribedReps }),
      prior = session("prior", "2026-09-01", [10, 10, 10], 40, { prescribedReps });
    const result = suggestion(current, prior);
    assert.equal(result.action, "repeat");
    assert.equal(result.basis, "prescription-needed");
    assert.deepEqual(result.targetSets, recorded(current.entries[0]));
  }
  const timed = {
    measurement: "timed",
    loadType: "bodyweight",
    prescribedReps: "1–2 minutes",
    sets: [{ reps: null, weight: null, seconds: 60, completed: true }],
  };
  const result = suggestion(
    session("current", undefined, undefined, null, timed),
    session("prior", "2026-09-01", undefined, null, timed),
    null,
    "time",
  );
  assert.equal(result.action, "repeat");
  assert.equal(result.basis, "prescription-needed");
  assert.equal(result.target.seconds, 60);
});
