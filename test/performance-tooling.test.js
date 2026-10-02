"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  PERFORMANCE_BUDGETS,
  STORAGE_FIXTURE_ACCOUNTS,
  percentile,
  assess,
  isolatedServerEnvironment,
} = require("../scripts/performance-check");

test("performance evidence tracks important HTTP and storage boundaries", () => {
  assert.deepEqual(Object.keys(PERFORMANCE_BUDGETS), [
    "endpoint.health",
    "endpoint.status",
    "endpoint.authenticatedPlan",
    "endpoint.authenticatedPlanSave",
    "storage.sessionLookup",
    "storage.planLookup",
    "storage.planCompareAndSwap",
  ]);
  assert.equal(STORAGE_FIXTURE_ACCOUNTS, 500);
  const runner = readFileSync(join(__dirname, "..", "scripts", "performance-check.js"), "utf8");
  for (const field of [
    "process.version",
    "process.platform",
    "process.arch",
    "storageFixtureAccounts",
  ]) {
    assert.match(
      runner,
      new RegExp(field.replace(".", "\\.")),
      `${field} must identify captured evidence`,
    );
  }
});

test("performance server configuration cannot inherit behavior-changing ambient settings", () => {
  const environment = isolatedServerEnvironment("/isolated/performance-data");
  assert.equal(environment.STRATA_DATA_DIR, "/isolated/performance-data");
  assert.equal(environment.NODE_ENV, "test");
  assert.equal(environment.TZ, "UTC");
  assert.equal(environment.ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS, "true");
  for (const key of [
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    "APP_BASE_URL",
    "EMAIL_VERIFICATION_SECRET",
    "EMAIL_FROM",
    "EMAIL_REPLY_TO",
    "SUPPORT_EMAIL",
    "RESEND_API_KEY",
    "RESEND_API_BASE",
    "ADMIN_EMAIL",
    "PADDLE_CLIENT_TOKEN",
    "PADDLE_API_KEY",
    "PADDLE_WEBHOOK_SECRET",
    "PADDLE_PRODUCT_ID",
    "PADDLE_PRICE_ID",
    "PADDLE_API_BASE",
  ])
    assert.equal(environment[key], "", `${key} must be cleared`);
  for (const key of [
    "TRUST_PROXY",
    "SECURE_COOKIES",
    "EMAIL_VERIFICATION_ENABLED",
    "PADDLE_CHECKOUT_ENABLED",
    "PADDLE_ENFORCE_IP_ALLOWLIST",
  ]) {
    assert.equal(environment[key], "false", `${key} must be disabled explicitly`);
  }
  assert.equal(Object.hasOwn(environment, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(environment, "PATH"), false);
});

test("percentiles and budgets fail a measured regression", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  const [medianRegression, p95Regression] = assess([
    {
      name: "endpoint.health",
      samples: 40,
      medianMs: PERFORMANCE_BUDGETS["endpoint.health"].medianMs + 0.001,
      p95Ms: 1,
    },
    {
      name: "endpoint.status",
      samples: 40,
      medianMs: 1,
      p95Ms: PERFORMANCE_BUDGETS["endpoint.status"].p95Ms + 0.001,
    },
  ]);
  assert.equal(medianRegression.passed, false);
  assert.equal(p95Regression.passed, false);
});
