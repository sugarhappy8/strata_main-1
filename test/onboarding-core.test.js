"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const core = require("../public/scripts/onboarding-core"),
  discovery = require("../public/scripts/discovery-core"),
  exercises = require("../public/data/exercises.json");
const base = {
  goal: "balanced",
  level: "Beginner",
  minutes: 35,
  equipment: [...new Set(exercises.map((e) => e.equipment))],
  availability: ["Monday", "Wednesday", "Friday"],
  limitations: [],
};
test("starter setup needs only an equipment choice before a useful three-day preview", () => {
  const starter = core.starterProfile();
  assert.deepEqual(starter, {
    goal: "balanced",
    level: "Beginner",
    equipment: [],
    availability: ["Monday", "Wednesday", "Friday"],
    preferences: ["simple-setup"],
    limitations: [],
    recoveryAdjusted: false,
  });
  assert.equal(core.trainingSnapshot({ ...starter, minutes: 35 }).ready, false);
  const selected = { ...starter, minutes: 35, equipment: ["Bodyweight"] },
    result = core.buildWeek(selected, exercises, discovery);
  assert.equal(core.trainingSnapshot(selected).ready, true);
  assert.equal(result.sessions.length, 3);
  assert.ok(result.sessions.every((session) => session.items.length === 4));
});
test("first week honors availability, valid plan limits, and distinct session movements", () => {
  const result = core.buildWeek(base, exercises, discovery);
  assert.equal(result.plan.days.Tuesday.length, 0);
  assert.equal(result.plan.days.Sunday.length, 0);
  assert.equal(result.sessions.length, 3);
  for (const session of result.sessions)
    assert.equal(new Set(session.items.map((item) => item.exerciseId)).size, session.items.length);
  const { sanitizePlan } = require("../src/plans");
  assert.deepEqual(sanitizePlan(result.plan), result.plan);
});
test("three-plus-day starter weeks repeat bounded anchors so Training Memory appears", () => {
  const threeDay = core.buildWeek(base, exercises, discovery),
    firstAnchors = threeDay.sessions[0].items.slice(0, 2).map((item) => item.exerciseId);
  for (const session of threeDay.sessions.slice(1)) {
    assert.deepEqual(session.anchorExerciseIds, firstAnchors);
    assert.equal(new Set(session.items.map((item) => item.exerciseId)).size, session.items.length);
  }
  const fourDay = core.buildWeek(
    { ...base, availability: ["Monday", "Tuesday", "Thursday", "Friday"] },
    exercises,
    discovery,
  );
  assert.equal(fourDay.sessions[2].anchorExerciseIds.length, 1);
  assert.equal(fourDay.sessions[3].anchorExerciseIds.length, 1);
  assert.ok(
    fourDay.sessions[2].anchorExerciseIds.every((id) =>
      fourDay.sessions[0].items.some((item) => item.exerciseId === id),
    ),
  );
  assert.ok(
    fourDay.sessions[3].anchorExerciseIds.every((id) =>
      fourDay.sessions[1].items.some((item) => item.exerciseId === id),
    ),
  );
  assert.equal(
    new Set(fourDay.sessions.flatMap((session) => session.anchorExerciseIds || [])).size,
    2,
    "upper/lower weeks should expose only two stable Training Memory anchors",
  );
  const planIds = core.DAYS.flatMap((day) => fourDay.plan.days[day].map((item) => item.instanceId));
  assert.equal(
    new Set(planIds).size,
    planIds.length,
    "every repeated exercise instance still needs a unique plan identity",
  );
});
test("starter weeks recover from duplicate custom instance IDs", () => {
  const result = core.buildWeek(base, exercises, discovery, () => "same-id"),
    ids = core.DAYS.flatMap((day) => result.plan.days[day].map((item) => item.instanceId));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9_-]{6,100}$/.test(id)));
});
test("first week filters equipment and movement limitations without silently relaxing them", () => {
  const profile = {
    ...base,
    minutes: 20,
    equipment: ["Dumbbells", "Bodyweight"],
    limitations: ["no-overhead"],
  };
  const result = core.buildWeek(profile, exercises, discovery);
  for (const session of result.sessions)
    for (const item of session.items) {
      assert.ok(profile.equipment.includes(item.exercise.equipment));
      assert.equal(discovery.personalResult(item.exercise, result.preferences).eligible, true);
    }
});
test("unavailable movement roles produce actionable errors and never invent exercises", () => {
  assert.throws(
    () => core.buildWeek({ ...base, equipment: ["Nonexistent"] }, exercises, discovery),
    /equipment/,
  );
  assert.throws(
    () => core.buildWeek({ ...base, equipment: ["Cable"] }, [], discovery),
    /equipment/,
  );
});
test("availability keeps recovery and rejects invalid profiles", () => {
  for (const availability of [[], core.DAYS])
    assert.throws(
      () => core.buildWeek({ ...base, availability }, exercises, discovery),
      /one to six/,
    );
  assert.throws(
    () => core.buildWeek({ ...base, minutes: 90 }, exercises, discovery),
    /20, 35, or 50/,
  );
  assert.throws(
    () => core.buildWeek({ ...base, level: "Expert" }, exercises, discovery),
    /experience/,
  );
});
test("four-day setup alternates upper and lower and never mutates its inputs", () => {
  const profile = { ...base, availability: ["Monday", "Tuesday", "Thursday", "Friday"] },
    before = JSON.stringify(profile);
  const result = core.buildWeek(profile, exercises, discovery);
  assert.deepEqual(
    result.sessions.map((s) => s.focus),
    ["upper", "lower", "upper", "lower"],
  );
  assert.equal(JSON.stringify(profile), before);
});

test("generated weeks retain the canonical preference profile instead of replacing it with setup defaults", () => {
  const profile = {
    ...base,
    preferences: ["compound", "long-range", "compound"],
    limitations: ["no-floor"],
  };
  const result = core.buildWeek(profile, exercises, discovery);
  assert.deepEqual(result.preferences.preferences, ["compound", "long-range"]);
  assert.deepEqual(result.preferences.limitations, ["no-floor"]);
  assert.equal(result.preferences.days, profile.availability.length);
});

test("saved profiles prefill real plan days and produce a valid recovery-day default when the plan is empty", () => {
  const preferences = {
    version: 1,
    goal: "strength",
    level: "Advanced",
    days: 7,
    equipment: ["Barbell / Smith"],
    preferences: ["compound"],
    limitations: ["no-floor"],
  };
  const plan = {
    days: Object.fromEntries(
      core.DAYS.map((day) => [
        day,
        day === "Tuesday" || day === "Friday" ? [{ exerciseId: "fixture" }] : [],
      ]),
    ),
  };
  const existing = core.profileFromSaved(preferences, plan);
  assert.deepEqual(existing.availability, ["Tuesday", "Friday"]);
  assert.equal(existing.goal, "strength");
  assert.equal(existing.level, "Advanced");
  assert.deepEqual(existing.equipment, ["Barbell / Smith"]);
  assert.deepEqual(existing.preferences, ["compound"]);
  assert.deepEqual(existing.limitations, ["no-floor"]);
  const empty = core.profileFromSaved(preferences, {
    days: Object.fromEntries(core.DAYS.map((day) => [day, []])),
  });
  assert.equal(
    empty.availability.length,
    6,
    "a seven-day profile must still open setup in a valid one-to-six-day state",
  );
  assert.equal(empty.availability.includes("Sunday"), false);
  assert.equal(
    empty.recoveryAdjusted,
    true,
    "reducing an empty saved seven-day profile must be disclosed",
  );
  const everyDay = core.profileFromSaved(preferences, {
    days: Object.fromEntries(core.DAYS.map((day) => [day, [{ exerciseId: `fixture-${day}` }]])),
  });
  assert.deepEqual(
    everyDay.availability,
    core.DAYS.slice(0, 6),
    "a saved seven-day week must not preselect an invalid setup state",
  );
  assert.equal(
    everyDay.recoveryAdjusted,
    true,
    "setup must disclose that it restored a recovery day",
  );
});

test("training snapshots explain readiness and summarize only generated work", () => {
  assert.deepEqual(core.trainingSnapshot({ ...base, equipment: [] }), {
    trainingDays: 3,
    recoveryDays: 4,
    minutes: 35,
    weeklyMinutes: 105,
    equipmentCount: 0,
    movementCount: 0,
    workingSets: 0,
    ready: false,
    message: "Choose the equipment you can reliably access.",
  });
  const result = core.buildWeek(base, exercises, discovery);
  const snapshot = core.trainingSnapshot(base, result);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.trainingDays, 3);
  assert.equal(snapshot.recoveryDays, 4);
  assert.equal(snapshot.weeklyMinutes, 105);
  assert.equal(
    snapshot.movementCount,
    result.sessions.reduce((total, session) => total + session.items.length, 0),
  );
  assert.equal(
    snapshot.workingSets,
    result.sessions
      .flatMap((session) => session.items)
      .reduce((total, item) => total + item.sets, 0),
  );
  assert.match(snapshot.message, /3 training days, 4 recovery days, and 105 planned minutes/);
  assert.match(
    core.trainingSnapshot({ ...base, availability: core.DAYS }).message,
    /at least one day open/,
  );
});
