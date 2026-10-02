"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { aiResponseFormat } = require("../src/ai-response-schema");

test("plan contracts constrain output days and exercise codes before generation", () => {
  const format = aiResponseFormat({
      codes: ["CH1", "BK1", "CH1"],
      requireWeek: true,
      trainingDays: 5,
      trainingDayNames: ["Monday", "Tuesday", "Wednesday", "Friday", "Saturday"],
    }),
    schema = format.schema;
  assert.equal(format.type, "json_object");
  assert.equal(schema.required.length, 5);
  assert.equal(schema.properties.week.type, "object");
  assert.equal(schema.properties.week.properties.days.minItems, 5);
  assert.equal(schema.properties.week.properties.days.maxItems, 5);
  const day = schema.properties.week.properties.days.items;
  assert.deepEqual(day.properties.day.enum, [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Friday",
    "Saturday",
  ]);
  assert.deepEqual(day.properties.exercises.items.properties.code.enum, ["CH1", "BK1"]);
  assert.equal(day.properties.exercises.items.properties.sets.maximum, 6);
});

test("question-only schemas prohibit proposals and side effects", () => {
  const schema = aiResponseFormat({ answerOnly: true }).schema;
  assert.deepEqual(schema.properties.week, { const: null });
  assert.deepEqual(schema.properties.nutrition, { const: null });
  assert.deepEqual(schema.properties.suggestions, { const: [] });
  assert.deepEqual(schema.properties.search, { const: [] });
});

test("named target days determine the exact count for duration-only edits", () => {
  const days = aiResponseFormat({
    requireWeek: true,
    trainingDayNames: ["Monday", "Wednesday", "Friday"],
  }).schema.properties.week.properties.days;
  assert.equal(days.minItems, 3);
  assert.equal(days.maxItems, 3);
});
