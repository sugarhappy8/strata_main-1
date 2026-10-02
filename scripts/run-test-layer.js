"use strict";

const { readdirSync } = require("node:fs");
const { join, relative } = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = join(__dirname, "..");
const TEST_ROOT = join(ROOT, "test");
const E2E_ROOT = join(ROOT, "qa", "e2e");
const VALID_LAYERS = new Set(["unit", "integration", "contract", "e2e"]);

function nodeTestFiles() {
  return readdirSync(TEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => join(TEST_ROOT, entry.name))
    .sort();
}

function e2eFiles() {
  try {
    return readdirSync(E2E_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => join(E2E_ROOT, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function classifyTestFile(file) {
  const name = relative(TEST_ROOT, file);
  if (
    name.startsWith("database") ||
    name.startsWith("architecture-") ||
    name === "project-structure.test.js"
  )
    return "contract";
  if (name.startsWith("server")) return "integration";
  return "unit";
}

function discoverTestLayers() {
  const layers = { unit: [], integration: [], contract: [], e2e: e2eFiles() };
  for (const file of nodeTestFiles()) layers[classifyTestFile(file)].push(file);
  return layers;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runLayer(layer) {
  if (!VALID_LAYERS.has(layer)) {
    throw new TypeError(`Test layer must be one of: ${[...VALID_LAYERS].join(", ")}.`);
  }
  const files = discoverTestLayers()[layer];
  if (!files.length) throw new Error(`No ${layer} tests were found.`);
  if (layer !== "e2e") return run(process.execPath, ["--test", ...files]);
  return run(process.execPath, ["--test", "--test-concurrency=1", ...files]);
}

if (require.main === module) {
  try {
    process.exitCode = runLayer(process.argv[2]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { VALID_LAYERS, classifyTestFile, discoverTestLayers, runLayer };
