"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  GUIDANCE_FIELDS,
  TARGET,
  libraryCatalog,
  libraryJson,
  run,
} = require("../scripts/exercise-library");
const Logic = require("../public/scripts/planner-logic");
const Discovery = require("../public/scripts/discovery-core");

const ROOT = join(__dirname, "..");
const full = JSON.parse(readFileSync(join(ROOT, "public", "data", "exercises.json"), "utf8"));
const committed = readFileSync(TARGET, "utf8");
const library = JSON.parse(committed);

test("the planner library is the current catalog without its long-form guidance", () => {
  assert.equal(
    committed,
    libraryJson(full),
    "public/data/exercise-library.json is stale; run node scripts/exercise-library.js",
  );
  assert.equal(run(["--check"]), 0);
  assert.deepEqual(GUIDANCE_FIELDS, ["why", "caution", "cues", "youtube"]);
  assert.deepEqual(
    library.map((exercise) => exercise.id),
    full.map((exercise) => exercise.id),
  );
  for (const [index, exercise] of library.entries()) {
    for (const field of GUIDANCE_FIELDS) assert.equal(Object.hasOwn(exercise, field), false);
    for (const [key, value] of Object.entries(full[index]))
      if (!GUIDANCE_FIELDS.includes(key)) assert.deepEqual(exercise[key], value, key);
  }
  assert.ok(
    Buffer.byteLength(committed) <= 125_000,
    `the library is ${Buffer.byteLength(committed)} bytes; it must stay a fraction of the catalog`,
  );
  assert.throws(() => libraryCatalog([]), /empty/);
});

test("planner library entries rebuild tutorial links and guides exactly as the full catalog does", () => {
  const entries = Logic.libraryExercises(library);
  assert.deepEqual(
    entries.map((exercise) => exercise.youtube),
    full.map((exercise) => exercise.youtube),
    "the tutorial link is derived from the name, as the catalog's own links are",
  );
  assert.equal(Logic.libraryExercises({}), null);
  assert.deepEqual(Logic.libraryExercises([]), []);
  assert.equal(entries.some(Logic.hasGuidance), false);

  const guided = Logic.withGuidance(entries, full);
  assert.equal(guided.every(Logic.hasGuidance), true);
  assert.equal(
    Logic.withGuidance(guided, full)[0],
    guided[0],
    "guided entries are kept as they are",
  );
  for (const [index, exercise] of guided.entries())
    assert.deepEqual(
      Discovery.exerciseGuidance(exercise, guided),
      Discovery.exerciseGuidance(full[index], full),
      exercise.id,
    );
  const partial = Logic.withGuidance(entries, full.slice(1));
  assert.equal(
    Logic.hasGuidance(partial[0]),
    false,
    "an entry missing from the catalog stays as is",
  );
  assert.equal(Logic.hasGuidance(partial[1]), true);
  assert.deepEqual(Logic.withGuidance(entries, null), entries);
});
