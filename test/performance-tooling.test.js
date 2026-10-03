"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  PERFORMANCE_BUDGETS,
  PAGE_WEIGHT_BUDGETS,
  STORAGE_FIXTURE_ACCOUNTS,
  percentile,
  assess,
  assessPageWeight,
  pageAssets,
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

test("page weight budgets hold a phone's first paint of the homepage and Plan", () => {
  assert.deepEqual(Object.keys(PAGE_WEIGHT_BUDGETS), ["page.home", "page.planner"]);
  const home = PAGE_WEIGHT_BUDGETS["page.home"],
    planner = PAGE_WEIGHT_BUDGETS["page.planner"];
  assert.equal(home.path, "/");
  assert.ok(home.assets.includes("/images/hero-training-960.avif"), "a phone gets the phone frame");
  assert.ok(
    !home.assets.some((asset) => asset.includes("exercises.json")),
    "the homepage's first paint has no exercise catalog",
  );
  assert.equal(planner.path, "/planner.html");
  assert.ok(planner.assets.includes("/exercise-library.json"), "Plan opens on the library");
  assert.ok(!planner.assets.some((asset) => asset.includes("exercises.json")));
  // The 9.6 homepage sent 692,887 gzip bytes (1,156,535 decoded) and Plan 165,068 (681,254).
  assert.ok(home.transferredBytes <= 200_000 && home.decodedBytes <= 400_000);
  assert.ok(planner.transferredBytes <= 125_000 && planner.decodedBytes <= 460_000);

  const markup = `<link rel="manifest" href="/manifest.webmanifest" /><link rel="icon" href="/icons/strata-icon.svg" />
    <link rel="stylesheet" href="/fonts.css?v=1" /><link rel="stylesheet" href="planner.css?v=1" />
    <script src="/html.js?v=1"></script><script>inline()</script><script src="planner.js?v=1"></script>`;
  assert.deepEqual(pageAssets(markup, "https://strata.test/planner.html"), [
    "https://strata.test/fonts.css?v=1",
    "https://strata.test/planner.css?v=1",
    "https://strata.test/html.js?v=1",
    "https://strata.test/planner.js?v=1",
  ]);

  const [within, heavy, swollen] = assessPageWeight([
    { name: "page.home", transferredBytes: home.transferredBytes, decodedBytes: home.decodedBytes },
    { name: "page.home", transferredBytes: home.transferredBytes + 1, decodedBytes: 1 },
    { name: "page.planner", transferredBytes: 1, decodedBytes: planner.decodedBytes + 1 },
  ]);
  assert.equal(within.passed, true);
  assert.equal(heavy.passed, false);
  assert.equal(swollen.passed, false);
  assert.equal(swollen.budgetDecodedBytes, planner.decodedBytes);
});
