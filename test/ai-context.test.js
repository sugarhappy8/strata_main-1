"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CONTEXT_CHARS, buildDataContext, careFlags, dayLine } = require("../src/ai-context");

function day(date, overrides = {}) {
  return {
    date,
    sleep: { asleepSeconds: 7 * 3600, score: 80 },
    recovery: { label: "Good", stress: "usual" },
    heart: { hrv: 60, resting: 50 },
    training: { status: "rest", done: [] },
    nutrition: { calories: 2100 },
    ...overrides,
  };
}
const dates = (count) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2026, 8, 20 + index)).toISOString().slice(0, 10),
  );

test("each day becomes one short line from whatever data exists", () => {
  assert.equal(
    dayLine(
      day("2026-09-28", {
        training: {
          status: "done",
          done: [
            { title: "Upper A", durationSeconds: 3000, source: "manual" },
            { title: "Running", durationSeconds: 1800, source: "polar" },
          ],
        },
      }),
    ),
    "Mon 09-28: slept 7h 00m (score 80); recovery good; HRV 60 ms, resting HR 50; trained: Upper A 50 min, Running 30 min (Polar); 2100 kcal logged",
  );
  assert.equal(
    dayLine({
      date: "2026-09-29",
      sleep: null,
      recovery: null,
      heart: null,
      training: { status: "not_logged", done: [] },
      nutrition: null,
    }),
    "Tue 09-29: planned session not logged",
  );
  assert.equal(
    dayLine({ date: "2026-09-29", training: { status: "untracked", done: [] } }),
    "",
    "a day with nothing known adds no line",
  );
});

test("care flags need three days in a row against the member's own usual, never one bad night", () => {
  const steady = dates(10).map((date) => day(date));
  assert.deepEqual(careFlags(steady), []);
  const high = steady.map((item, index) =>
    index >= 7 ? { ...item, heart: { hrv: 60, resting: 58 } } : item,
  );
  assert.match(careFlags(high).join(" "), /Resting heart rate has been more than 7 bpm above/);
  const oneNight = steady.map((item, index) =>
    index === 9
      ? {
          ...item,
          sleep: { asleepSeconds: 3 * 3600 },
          recovery: { label: "Poor", stress: "higher" },
        }
      : item,
  );
  assert.deepEqual(careFlags(oneNight), []);
  const short = dates(4).map((date) =>
    day(date, {
      sleep: { asleepSeconds: 4 * 3600 },
      recovery: { label: "Poor", stress: "higher" },
    }),
  );
  assert.deepEqual(
    careFlags(short).length,
    2,
    "sleep and stress flags need no baseline; resting HR needs five earlier days",
  );
});

test("the summary stays within budget, drops the oldest days first, and never drops care notes", () => {
  const many = dates(14).map((date, index) =>
    day(date, {
      training: {
        status: "done",
        done: [
          { title: "A very long session name ".repeat(3), durationSeconds: 3600, source: "manual" },
        ],
      },
      heart: { hrv: 60, resting: index >= 11 ? 65 : 50 },
    }),
  );
  const { text, flags } = buildDataContext({
    snapshots: many,
    entries: [],
    signals: { trained: [{ exerciseId: "barbell-back-squat", sessions: 3 }] },
    planChanges: [{ source: "ai" }],
    brief: { recommendation: { title: "Go lighter" } },
  });
  assert.ok(flags.length >= 1);
  assert.ok(text.length <= CONTEXT_CHARS + 400);
  assert.match(text, /Care notes/);
  assert.match(text, /Barbell Back Squat ×3/);
  assert.match(text, /an accepted Strata AI proposal/);
  assert.match(text, /Go lighter/);
  assert.doesNotMatch(text, /09-20/, "the oldest day goes first when over budget");
  assert.match(buildDataContext({}).text, /No recent sleep, recovery, training, or diary data/);
});
