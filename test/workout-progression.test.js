"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const W = require("../public/scripts/workout-core");
const Progression = require("../public/scripts/workout-progression");
const History = require("../public/scripts/workout-history");
const Render = require("../public/scripts/workout-render");

const timestamp = (date) => Date.parse(`${date}T09:00:00Z`);
const actual = (weight = 40, reps = 12) => ({ reps, weight, seconds: null, effort: null });
function entry(id = "press") {
  return {
    id: `active-${id}`,
    exerciseId: id,
    measurement: "reps",
    loadType: "external",
    unit: "kg",
    prescribedReps: "8–12",
    effortType: "none",
    note: "",
    sets: [W.blankSet(), W.blankSet()],
  };
}
function response(sourceId = "prior", exerciseId = "press", changes = {}) {
  return {
    progression: {
      workoutId: sourceId,
      suggestions: [
        {
          exerciseId,
          entryId: `previous-${exerciseId}`,
          measurement: "reps",
          loadType: "external",
          unit: "kg",
          prescribedReps: "8–12",
          setCount: 2,
          sourceDate: "2026-09-03",
          sourceStartedAt: timestamp("2026-09-03"),
          action: "increase_load",
          basis: "comparable-progression",
          target: { weight: 42.5, reps: 8, seconds: null },
          targetSets: [actual(42.5, 8), actual(42.5, 8)],
          timing: "Next time you train this exercise",
          explanation: "Try 42.5 kg for 8 reps next time.",
          ...changes,
        },
      ],
    },
  };
}
function setup({ entries = [entry()], read, date = "2026-09-10" } = {}) {
  const state = {
    user: { id: "member-one" },
    blocked: false,
    memoryReady: true,
    workout: { id: "active", date, startedAt: timestamp(date), status: "active", entries },
  };
  const memories = new Map(
    entries.map((item) => [
      item.exerciseId,
      { workoutId: "prior", date: "2026-09-03", sets: [actual(), actual()] },
    ]),
  );
  const calls = [],
    renders = [];
  const api = Progression.create({
    state,
    workout: W,
    memoryFor: (item) => memories.get(item.exerciseId) || null,
    accountRead: async (path) => {
      calls.push(path);
      return read ? read(path) : response();
    },
    renderSession: () => renders.push(state.workout?.id),
  });
  return { state, memories, calls, renders, api, entry: entries[0] };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("workout progression exposes its browser module without CommonJS", () => {
  const context = {};
  runInNewContext(
    readFileSync(join(__dirname, "../public/scripts/workout-progression.js"), "utf8"),
    context,
  );
  assert.equal(typeof context.StrataWorkoutProgression.create, "function");
});

test("next-session target uses the exact previous exercise across weekdays and leaves actuals untouched", async () => {
  const fixture = setup(),
    before = structuredClone(fixture.state.workout);
  assert.equal(fixture.api.targetFor(fixture.entry).status, "loading");
  await fixture.api.load("active");
  const result = fixture.api.targetFor(fixture.entry);
  assert.equal(result.status, "ready");
  assert.equal(result.sourceDate, "2026-09-03");
  assert.equal(result.suggestion.action, "increase_load");
  assert.deepEqual(result.sets, [actual(42.5, 8), actual(42.5, 8)]);
  assert.deepEqual(fixture.state.workout, before);
  assert.deepEqual(fixture.calls, ["/api/workouts/prior/progression"]);
  assert.deepEqual(fixture.renders, ["active"]);
  result.sets[0].weight = 900;
  assert.equal(
    fixture.api.targetFor(fixture.entry).sets[0].weight,
    42.5,
    "Returned sets must not alter cached guidance",
  );
});

test("target hydration changes only its card and preserves live input and disclosure nodes", () => {
  const fixture = setup();
  fixture.state.catalog = [{ id: "press", name: "Press" }];
  fixture.state.memoryHistory = [];
  const target = { outerHTML: "Loading" },
    orphan = { outerHTML: "Unchanged" },
    input = { value: "1e", focused: true },
    details = { open: true };
  const card = {
    dataset: { entry: fixture.entry.id },
    input,
    details,
    querySelector: (selector) => {
      assert.equal(selector, ".memory-target");
      return target;
    },
  };
  const container = {
    querySelectorAll: (selector) => {
      assert.equal(selector, "[data-entry]");
      return [card, { dataset: { entry: "removed-entry" }, querySelector: () => orphan }];
    },
    set innerHTML(_) {
      assert.fail("Target hydration must never replace the live set logger");
    },
  };
  const view = Render.create({
    state: fixture.state,
    workout: W,
    nextTarget: () => ({
      status: "ready",
      sets: [actual(42.5, 8), actual(42.5, 8)],
      suggestion: { action: "increase_load" },
      explanation: "Try the earned increase.",
      sourceDate: "2026-09-03",
    }),
  });
  view.refreshTargets(container);
  assert.match(target.outerHTML, /Increase weight/);
  assert.match(target.outerHTML, /42\.5 kg/);
  assert.equal(orphan.outerHTML, "Unchanged");
  assert.equal(card.input, input);
  assert.deepEqual(input, { value: "1e", focused: true });
  assert.equal(card.details, details);
  assert.equal(details.open, true);
});

test("memory-discovered older sources are fetched per exercise rather than using latest workout guidance", async () => {
  const fixture = setup({
    entries: [entry("press"), entry("row"), entry("curl")],
    read: (path) =>
      path.includes("older-125")
        ? response("older-125", "press")
        : {
            progression: {
              workoutId: "recent",
              suggestions: [
                response("recent", "row").progression.suggestions[0],
                response("recent", "curl").progression.suggestions[0],
              ],
            },
          },
  });
  fixture.memories.get("press").workoutId = "older-125";
  fixture.memories.get("row").workoutId = "recent";
  fixture.memories.get("curl").workoutId = "recent";
  await fixture.api.load("active");
  assert.deepEqual(fixture.calls.sort(), [
    "/api/workouts/older-125/progression",
    "/api/workouts/recent/progression",
  ]);
  for (const item of fixture.state.workout.entries)
    assert.equal(fixture.api.targetFor(item).status, "ready");
});

test("pending and completed requests coalesce without a render-fetch loop", async () => {
  const waiting = deferred(),
    fixture = setup({ read: () => waiting.promise });
  const loading = fixture.api.load("active");
  await fixture.api.load("active");
  assert.equal(fixture.calls.length, 1);
  waiting.resolve(response());
  await loading;
  await fixture.api.load("active");
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.renders.length, 1);
});

test("failed source stays honestly unavailable until reset explicitly enables retry", async () => {
  let fail = true;
  const fixture = setup({
    read: () => {
      if (fail) throw new Error("offline");
      return response();
    },
  });
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  fail = false;
  await fixture.api.load("active");
  assert.equal(fixture.calls.length, 1);
  fixture.api.reset();
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(fixture.entry).status, "ready");
  assert.equal(fixture.calls.length, 2);
});

test("refreshing history retries failed progression while loading another page preserves its cache", async () => {
  let fail = true,
    historyFails = false;
  const fixture = setup({
    read: () => {
      if (fail) throw new Error("offline");
      return response();
    },
  });
  await fixture.api.load("active");
  fail = false;
  Object.assign(fixture.state, {
    history: [],
    recoveries: [],
    offset: 0,
    historyBusy: false,
    hasMore: false,
  });
  const controls = new Map(),
    pending = [];
  let resets = 0;
  const history = History.create({
    $: (id) => {
      if (!controls.has(id))
        controls.set(id, { value: "", hidden: false, disabled: false, innerHTML: "" });
      return controls.get(id);
    },
    state: fixture.state,
    workout: W,
    view: {},
    number: String,
    exercise: (id) => ({ name: id }),
    formatLabel: () => "",
    saveError: (error) => error.message,
    blockSession: () => {},
    renderPlan: () => {},
    mergeMemory: () => {},
    memoryReadyFor: () => true,
    accountRead: async () => {
      if (historyFails) throw new Error("History failed");
      return { workouts: [], hasMore: false };
    },
    renderSession: () => pending.push(fixture.api.load("active")),
    resetProgression: () => {
      resets++;
      fixture.api.reset();
    },
    locationLike: {},
    historyLike: {},
  });
  await history.load({ more: true });
  await Promise.all(pending.splice(0));
  assert.equal(resets, 0);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  historyFails = true;
  await history.load();
  assert.equal(resets, 0, "A failed history refresh cannot discard known progression state");
  historyFails = false;
  await history.load();
  await Promise.all(pending);
  assert.equal(resets, 1);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.api.targetFor(fixture.entry).status, "ready");
});

test("account changes, access blocking and workout switches discard in-flight responses", async () => {
  for (const change of [
    (fixture) => {
      fixture.state.user.id = "member-two";
    },
    (fixture) => {
      fixture.state.blocked = true;
    },
    (fixture) => {
      fixture.state.workout.id = "different";
    },
    (fixture) => {
      fixture.state.workout.status = "completed";
    },
  ]) {
    const waiting = deferred(),
      fixture = setup({ read: () => waiting.promise }),
      loading = fixture.api.load("active");
    change(fixture);
    waiting.resolve(response());
    await loading;
    assert.notEqual(fixture.api.targetFor(fixture.entry).status, "ready");
    assert.equal(fixture.renders.length, 0);
  }
});

test("reset generation prevents old requests from replacing a newer request for the same workout", async () => {
  const old = deferred(),
    newer = deferred();
  let requests = 0;
  const fixture = setup({ read: () => (++requests === 1 ? old.promise : newer.promise) }),
    first = fixture.api.load("active");
  fixture.api.reset();
  const second = fixture.api.load("active");
  newer.resolve(response("prior", "press", { targetSets: [actual(45, 8), actual(45, 8)] }));
  await second;
  old.resolve(response());
  await first;
  assert.equal(fixture.api.targetFor(fixture.entry).sets[0].weight, 45);
  assert.equal(fixture.renders.length, 1);
});

test("source changes while loading select only the new source and do not apply stale exercise data", async () => {
  const old = deferred(),
    fixture = setup({
      read: (path) =>
        path.includes("new-source")
          ? response("new-source", "press", { targetSets: [actual(47.5, 8), actual(47.5, 8)] })
          : old.promise,
    });
  const loading = fixture.api.load("active");
  fixture.memories.get("press").workoutId = "new-source";
  await fixture.api.load("active");
  old.resolve(response());
  await loading;
  assert.equal(fixture.api.targetFor(fixture.entry).sets[0].weight, 47.5);
});

test("changed range, set count or per-side instruction cannot apply a previous prescription", async () => {
  for (const change of [
    (item) => {
      item.prescribedReps = "5";
    },
    (item) => {
      item.sets.push(W.blankSet());
    },
    (item) => {
      item.prescribedReps = "8–12 / side";
    },
  ]) {
    const fixture = setup();
    await fixture.api.load("active");
    change(fixture.entry);
    const result = fixture.api.targetFor(fixture.entry);
    assert.equal(result.status, "mismatch");
    assert.equal(result.sets, undefined);
  }
});

test("equivalent numeric ranges preserve a target across punctuation and unit wording", async () => {
  const fixture = setup();
  fixture.entry.prescribedReps = "8 - 12 repetitions";
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(fixture.entry).status, "ready");
  fixture.entry.prescribedReps = "eight to twelve";
  assert.equal(fixture.api.targetFor(fixture.entry).status, "mismatch");
});

test("format changes never borrow kilograms, assistance or repetitions from a different logging format", async () => {
  for (const changes of [
    { unit: "lb" },
    { loadType: "assisted" },
    { measurement: "timed" },
    { exerciseId: "other" },
  ]) {
    const fixture = setup();
    await fixture.api.load("active");
    Object.assign(fixture.entry, changes);
    assert.notEqual(fixture.api.targetFor(fixture.entry).status, "ready");
  }
});

test("assistance and timed bodyweight targets keep their actual logging semantics", async () => {
  const assisted = setup({
    read: () =>
      response("prior", "press", {
        loadType: "assisted",
        action: "reduce_assistance",
        targetSets: [actual(37.5, 8), actual(37.5, 8)],
      }),
  });
  assisted.entry.loadType = "assisted";
  await assisted.api.load("active");
  assert.equal(assisted.api.targetFor(assisted.entry).sets[0].weight, 37.5);
  const timed = setup({
    read: () =>
      response("prior", "press", {
        measurement: "timed",
        loadType: "bodyweight",
        prescribedReps: "1–2 minutes",
        targetSets: [
          { reps: null, weight: null, seconds: 65 },
          { reps: null, weight: null, seconds: 65 },
        ],
      }),
  });
  Object.assign(timed.entry, {
    measurement: "timed",
    loadType: "bodyweight",
    prescribedReps: "60–120 sec",
  });
  await timed.api.load("active");
  assert.deepEqual(timed.api.targetFor(timed.entry).sets, [
    { reps: null, weight: null, seconds: 65, effort: null },
    { reps: null, weight: null, seconds: 65, effort: null },
  ]);
});

test("malformed response, ambiguous entries and invalid bounded sets never become applicable targets", async () => {
  const malformed = [
    { progression: { workoutId: "another", suggestions: [] } },
    { progression: { workoutId: "prior", suggestions: null } },
    response("prior", "press", { targetSets: [actual()] }),
    response("prior", "press", { targetSets: [actual(1001), actual()] }),
    response("prior", "press", { targetSets: [actual(-1), actual()] }),
    response("prior", "press", { targetSets: [actual(Infinity), actual()] }),
    response("prior", "press", { targetSets: [actual(42.5, 0), actual()] }),
    response("prior", "press", { targetSets: [{ ...actual(), seconds: 30 }, actual()] }),
  ];
  const ambiguous = response();
  ambiguous.progression.suggestions.push({
    ...ambiguous.progression.suggestions[0],
    entryId: "second-copy",
  });
  malformed.push(ambiguous);
  for (const payload of malformed) {
    const fixture = setup({ read: () => payload });
    await fixture.api.load("active");
    assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  }
});

test("source chronology and dates must be valid and strictly precede the active workout", async () => {
  for (const changes of [
    { sourceStartedAt: timestamp("2026-09-10") },
    { sourceStartedAt: timestamp("2026-09-11") },
    { sourceStartedAt: "earlier" },
    { sourceDate: "2026-09-11" },
    { sourceDate: "2026-02-30" },
    { sourceDate: "2026-09-02" },
  ]) {
    const fixture = setup({ read: () => response("prior", "press", changes) });
    await fixture.api.load("active");
    assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  }
});

test("over 28 calendar days repeats actual prior sets instead of carrying a stale increase", async () => {
  const fixture = setup({ date: "2026-10-02" });
  fixture.memories.get("press").sets = [actual(40, 12), actual(37.5, 10)];
  await fixture.api.load("active");
  const result = fixture.api.targetFor(fixture.entry);
  assert.equal(result.status, "ready");
  assert.equal(result.suggestion.action, "repeat");
  assert.equal(result.suggestion.basis, "returning-baseline");
  assert.match(result.explanation, /over 28 days/);
  assert.deepEqual(result.sets, [actual(40, 12), actual(37.5, 10)]);
  assert.equal(result.suggestion.target.weight, 40);
  const boundary = setup({ date: "2026-10-01" });
  await boundary.api.load("active");
  assert.equal(boundary.api.targetFor(boundary.entry).suggestion.action, "increase_load");
});

test("stale partial or incompatible recorded sets require a fresh manual baseline", async () => {
  const fixture = setup({ date: "2026-10-02" });
  fixture.memories.get("press").sets = [actual()];
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  assert.match(fixture.api.targetFor(fixture.entry).explanation, /fresh baseline/);
});

test("no history establishes a baseline but unknown or failed history cannot claim one", async () => {
  const fixture = setup();
  fixture.memories.clear();
  assert.equal(fixture.api.targetFor(fixture.entry).status, "baseline");
  await fixture.api.load("active");
  assert.equal(fixture.calls.length, 0);
  fixture.state.memoryReady = false;
  assert.equal(fixture.api.targetFor(fixture.entry).status, "loading");
  fixture.state.memoryError = "offline";
  assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
});

test("a latest session without completed sets cannot reveal or apply an older next target", async () => {
  const fixture = setup();
  fixture.memories.get("press").sets = [];
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  assert.match(fixture.api.targetFor(fixture.entry).explanation, /No sets were completed/);
  fixture.state.catalog = [{ id: "press", name: "Press" }];
  fixture.state.memoryHistory = [
    {
      id: "prior",
      date: "2026-09-03",
      status: "completed",
      startedAt: timestamp("2026-09-03"),
      exerciseSummaries: [{ ...fixture.entry, setValues: [] }],
    },
  ];
  const view = Render.create({
      state: fixture.state,
      workout: W,
      nextTarget: (item) => fixture.api.targetFor(item),
    }),
    markup = String(view.renderEntry(fixture.entry, 0));
  assert.match(markup, /No sets were completed/);
  assert.doesNotMatch(markup, /data-use-last|data-apply-target/);
});

test("invalid or self-referencing memory sources never create requests or an endless loading state", async () => {
  for (const sourceId of ["active", "invalid/source", null]) {
    const fixture = setup();
    fixture.memories.get("press").workoutId = sourceId;
    await fixture.api.load("active");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  }
});

test("completed, blocked, unknown-user and foreign entries never request or expose targets", async () => {
  for (const changes of [
    (fixture) => {
      fixture.state.blocked = true;
    },
    (fixture) => {
      fixture.state.user = null;
    },
    (fixture) => {
      fixture.state.workout.status = "completed";
    },
  ]) {
    const fixture = setup();
    changes(fixture);
    await fixture.api.load("active");
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.api.targetFor(fixture.entry).status, "unavailable");
  }
  const fixture = setup();
  await fixture.api.load("active");
  assert.equal(fixture.api.targetFor(entry()).status, "unavailable");
});
