"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");

test("strict checkJs covers provider, transport, storage, and service composition boundaries", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "tsconfig.boundaries.json"), "utf8"));
  assert.equal(config.compilerOptions.allowJs, true);
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.strict, true);
  assert.equal(config.compilerOptions.noEmit, true);
  assert.equal(config.compilerOptions.exactOptionalPropertyTypes, true);
  assert.equal(config.compilerOptions.noUncheckedIndexedAccess, true);
  for (const file of [
    "src/domain-types.d.ts",
    "src/http.js",
    "src/paddle-catalog.js",
    "src/payments.js",
    "src/plans.d.ts",
    "src/product-signals.js",
    "src/store-contract.js",
    "src/coaching-core.js",
    "src/energy-activity-core.js",
    "src/energy-planning-core.js",
    "src/meal-planning-core.js",
    "src/coaching-schema.js",
    "src/coaching-store.js",
    "src/coaching.js",
    "src/service-composition.js",
    "src/setup.js",
    "src/training-loop-schema.js",
    "src/training-loop-store.js",
    "src/training.js",
    "src/workouts.d.ts",
  ])
    assert.ok(config.include.includes(file), `${file} must remain in the strict boundary program`);
});

test("production service composition covers all three typed factories and their cross-service cycle", () => {
  const fixture = readFileSync(join(ROOT, "src", "service-composition.js"), "utf8");
  const server = readFileSync(join(ROOT, "src", "server.js"), "utf8");
  for (const factory of ["createAuthService", "createAdminService", "createSupportService"]) {
    assert.match(fixture, new RegExp(`${factory}\\(\\{`));
    assert.match(server, new RegExp(`\\b${factory}\\b`));
  }
  assert.match(
    fixture,
    /claimAdminForLogin:\s*async\s*\(user\)\s*=>\s*\(?admin\s*\?\s*admin\.maybeClaimAdminForLogin\(user\)\s*:\s*user\)?/,
  );
  assert.match(
    fixture,
    /http\s*:\s*\{\s*json\s*:\s*http\s*\.json\s*,\s*bodyJson\s*:\s*http\s*\.bodyJson\s*[;,]?\s*\}/,
  );
  assert.match(server, /composeServices\(\{/);
});

test("service factories publish declared dependency and return contracts", () => {
  for (const [file, dependencyType, serviceType] of [
    ["auth.js", "AuthServiceDependencies", "AuthService"],
    ["admin.js", "AdminServiceDependencies", "AdminService"],
    ["support.js", "SupportServiceDependencies", "SupportService"],
    ["setup.js", "SetupServiceDependencies", "SetupService"],
    ["product-signals.js", "ProductSignalsServiceDependencies", "ProductSignalsService"],
    ["training.js", "TrainingServiceDependencies", "TrainingService"],
    ["coaching.js", "CoachingServiceDependencies", "CoachingService"],
  ]) {
    const source = readFileSync(join(ROOT, "src", file), "utf8");
    assert.match(
      source,
      new RegExp(`@param \\{import\\("\\./domain-types"\\)\\.${dependencyType}\\} dependencies`),
    );
    assert.match(
      source,
      new RegExp(`@returns \\{import\\("\\./domain-types"\\)\\.${serviceType}\\}`),
    );
  }
});
