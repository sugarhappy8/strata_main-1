"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// These floors are deliberately based on the Build 6.9.9.007 Node 24
// server/core baseline (91.33% lines, 78.91% branches, 85.47% functions).
// Keep a small
// buffer for useful refactors, while still making a material regression fail.
const COVERAGE_THRESHOLDS = Object.freeze({
  lines: 90,
  branches: 78,
  functions: 85,
});

const args = [
  "--test",
  "--test-concurrency=1",
  "--experimental-test-coverage",
  `--test-coverage-lines=${COVERAGE_THRESHOLDS.lines}`,
  `--test-coverage-branches=${COVERAGE_THRESHOLDS.branches}`,
  `--test-coverage-functions=${COVERAGE_THRESHOLDS.functions}`,
  "--test-coverage-include=server.js",
  "--test-coverage-include=src/**/*.js",
  "--test-coverage-include=public/scripts/discovery-core.js",
  "--test-coverage-include=public/scripts/monthly-plan-core.js",
  "--test-coverage-include=public/scripts/workout-core.js",
  "--test-coverage-include=public/scripts/onboarding-core.js",
  "--test-coverage-include=public/scripts/preview-core.js",
  "--test-coverage-include=public/scripts/activation-core.js",
  "--test-coverage-include=public/scripts/plan-insights-core.js",
  "--test-coverage-include=public/scripts/training-block-core.js",
];

// Browser domain, state, and transport leaves belong in the measured
// denominator. Render/event modules execute in VM and real-browser realms,
// where Node's process-level collector cannot measure them faithfully; their
// behavior is instead required by focused runtime and E2E tests.
const frontendPolicy = JSON.parse(
  readFileSync(join(__dirname, "..", "frontend-architecture-policy.json"), "utf8"),
);
for (const page of Object.values(frontendPolicy.pages || {})) {
  for (const module of page.modules || []) {
    if (!["logic", "state", "api"].includes(module.role)) continue;
    const include = `--test-coverage-include=${module.file}`;
    if (!args.includes(include)) args.push(include);
  }
}

function runCoverage() {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (require.main === module) process.exitCode = runCoverage();

module.exports = { COVERAGE_THRESHOLDS, args, runCoverage };
