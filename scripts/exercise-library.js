#!/usr/bin/env node
"use strict";

// The planner needs every exercise for its first paint (library, search, week cards, drag and drop) but none of
// the long-form guidance, which only its setup guide shows. It loads public/data/exercise-library.json, this
// script's copy of public/data/exercises.json without those fields, and fetches the full catalog when a guide
// first opens. Run `node scripts/exercise-library.js` after editing exercises.json; `--check` reports a stale copy.

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const SOURCE = join(ROOT, "public", "data", "exercises.json");
const TARGET = join(ROOT, "public", "data", "exercise-library.json");
// The planner derives the tutorial link from the name, as the homepage already can.
const GUIDANCE_FIELDS = Object.freeze(["why", "caution", "cues", "youtube"]);

/** @param {Array<Record<string, unknown>>} exercises */
function libraryCatalog(exercises) {
  if (!Array.isArray(exercises) || exercises.length === 0)
    throw new Error("The exercise catalog is empty.");
  return exercises.map((exercise) =>
    Object.fromEntries(Object.entries(exercise).filter(([key]) => !GUIDANCE_FIELDS.includes(key))),
  );
}

/** @param {Array<Record<string, unknown>>} exercises */
function libraryJson(exercises) {
  return `${JSON.stringify(libraryCatalog(exercises))}\n`;
}

function run(argv = process.argv.slice(2)) {
  const expected = libraryJson(JSON.parse(readFileSync(SOURCE, "utf8")));
  if (argv.includes("--check")) {
    if (readFileSync(TARGET, "utf8") === expected) return 0;
    console.error(
      "public/data/exercise-library.json is stale. Run: node scripts/exercise-library.js",
    );
    return 1;
  }
  writeFileSync(TARGET, expected);
  console.log(`Wrote public/data/exercise-library.json (${Buffer.byteLength(expected)} bytes).`);
  return 0;
}

if (require.main === module) process.exitCode = run();

module.exports = { GUIDANCE_FIELDS, SOURCE, TARGET, libraryCatalog, libraryJson, run };
