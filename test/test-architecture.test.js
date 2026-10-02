"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { basename } = require("node:path");
const { COVERAGE_THRESHOLDS, args } = require("../scripts/coverage-check");
const { VALID_LAYERS, classifyTestFile, discoverTestLayers } = require("../scripts/run-test-layer");

test("coverage floors are enforced against the measured application baseline", () => {
  assert.deepEqual(COVERAGE_THRESHOLDS, { lines: 90, branches: 78, functions: 85 });
  for (const [metric, floor] of Object.entries(COVERAGE_THRESHOLDS)) {
    assert.ok(
      args.includes(`--test-coverage-${metric}=${floor}`),
      `${metric} must be enforced by Node's coverage runner`,
    );
  }
  assert.ok(
    args.includes("--test-concurrency=1"),
    "the recorded coverage denominator should be repeatable across runs",
  );
  assert.ok(args.includes("--test-coverage-include=server.js"));
  assert.ok(args.includes("--test-coverage-include=src/**/*.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/discovery-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/monthly-plan-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/workout-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/onboarding-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/preview-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/activation-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/plan-insights-core.js"));
  assert.ok(args.includes("--test-coverage-include=public/scripts/training-block-core.js"));
  assert.equal(
    args.some((argument) => argument.includes("public/scripts/**/*.js")),
    false,
    "untouched DOM entry scripts must not disappear from the denominator",
  );
});

test("every Node test belongs to exactly one named architecture layer", () => {
  assert.deepEqual([...VALID_LAYERS], ["unit", "integration", "contract", "e2e"]);
  const layers = discoverTestLayers();
  const nodeFiles = [...layers.unit, ...layers.integration, ...layers.contract];
  assert.equal(new Set(nodeFiles).size, nodeFiles.length, "a test cannot belong to two layers");
  assert.ok(layers.unit.length > 0);
  assert.ok(layers.integration.length > 0);
  assert.ok(layers.contract.length > 0);
  assert.ok(layers.e2e.length > 0);
  for (const file of layers.unit) assert.equal(classifyTestFile(file), "unit", basename(file));
  for (const file of layers.integration)
    assert.equal(classifyTestFile(file), "integration", basename(file));
  for (const file of layers.contract)
    assert.equal(classifyTestFile(file), "contract", basename(file));
});
