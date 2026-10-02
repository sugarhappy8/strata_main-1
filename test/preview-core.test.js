"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Preview = require("../public/scripts/preview-core");
const Discovery = require("../public/scripts/discovery-core");
const exercises = require("../public/data/exercises.json");

function profile(overrides = {}) {
  return {
    goal: "balanced",
    group: "chest",
    equipment: "Dumbbells",
    level: "Intermediate",
    ...overrides,
  };
}

test("guest preview is deterministic, target-specific, and transparent", () => {
  const input = profile(),
    before = JSON.stringify(input);
  const first = Preview.buildPreview({ exercises, profile: input, discovery: Discovery });
  const second = Preview.buildPreview({ exercises, profile: input, discovery: Discovery });
  assert.equal(JSON.stringify(input), before, "preview must not mutate the visitor's choices");
  assert.deepEqual(first, second);
  assert.equal(first.items.length, 3);
  assert.match(first.summary, /Balanced training · Chest · Dumbbells · Intermediate/);
  assert.deepEqual(
    first.items.map((item) => item.rank),
    [1, 2, 3],
  );
  assert.ok(
    first.items.every(
      ({ exercise }) => exercise.group === "chest" && exercise.equipment === "Dumbbells",
    ),
  );
  assert.ok(
    first.items.every(
      (item) => item.reasons.length === 3 && item.reasons[0] === "Dumbbells available",
    ),
  );
  assert.ok(first.items.every((item) => item.tradeoffText.endsWith(`${item.tradeoff.value}/100`)));
  assert.ok(
    first.items.every(
      (item) =>
        item.match >= 0 && item.match <= 99 && item.officialScore >= 0 && item.officialScore <= 100,
    ),
  );
});

test("preview explains a real goal signal and the lowest scored trade-off", () => {
  for (const goal of Object.keys(Preview.GOALS)) {
    const result = Preview.buildPreview({
      exercises,
      profile: profile({ goal }),
      discovery: Discovery,
      limit: 1,
    });
    const item = result.items[0],
      expectedTradeoff = Math.min(
        ...Object.keys(Preview.FACTORS).map((key) => Number(item.exercise.metrics[key])),
      );
    assert.equal(item.tradeoff.value, expectedTradeoff, goal);
    assert.match(item.tradeoffText, /lowest scored factor/);
    assert.ok(item.signal.value >= 0 && item.signal.value <= 100, goal);
    assert.ok(item.reasons[2].includes(`${item.signal.value}/100`), goal);
  }
});

test("every offered group-equipment pair can produce an honest sample", () => {
  for (const group of Object.keys(Preview.GROUPS)) {
    const equipment = [
      ...new Set(
        exercises
          .filter((exercise) => exercise.group === group)
          .map((exercise) => exercise.equipment),
      ),
    ];
    for (const item of equipment) {
      const result = Preview.buildPreview({
        exercises,
        profile: profile({ group, equipment: item, level: "Beginner" }),
        discovery: Discovery,
      });
      assert.ok(result.items.length >= 1 && result.items.length <= 3, `${group} / ${item}`);
      assert.ok(
        result.items.every(
          ({ exercise }) => exercise.group === group && exercise.equipment === item,
        ),
        `${group} / ${item}`,
      );
    }
  }
});

test("preview rejects incomplete inputs and unavailable catalog combinations", () => {
  assert.throws(
    () =>
      Preview.buildPreview({
        exercises,
        profile: profile({ goal: "magic" }),
        discovery: Discovery,
      }),
    { code: "INVALID_PREVIEW_GOAL" },
  );
  assert.throws(
    () =>
      Preview.buildPreview({
        exercises,
        profile: profile({ group: "unknown" }),
        discovery: Discovery,
      }),
    { code: "INVALID_PREVIEW_GROUP" },
  );
  assert.throws(
    () =>
      Preview.buildPreview({
        exercises,
        profile: profile({ equipment: "" }),
        discovery: Discovery,
      }),
    { code: "INVALID_PREVIEW_EQUIPMENT" },
  );
  assert.throws(() => Preview.buildPreview({ exercises, profile: profile(), discovery: null }), {
    code: "PREVIEW_ENGINE_UNAVAILABLE",
  });
  assert.throws(
    () => Preview.buildPreview({ exercises: [], profile: profile(), discovery: Discovery }),
    { code: "PREVIEW_LIBRARY_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      Preview.buildPreview({
        exercises,
        profile: profile({ equipment: "Kettlebells" }),
        discovery: Discovery,
      }),
    { code: "PREVIEW_NO_MATCH" },
  );
});
