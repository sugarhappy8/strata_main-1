"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const BUILD = "9.4.0";
const ROOT = join(__dirname, ".."),
  read = (path) => readFileSync(join(ROOT, path), "utf8");

test("the service worker uses a generic offline workout shell without caching private pages or APIs", () => {
  const worker = read("public/service-worker.js"),
    precache = worker.match(/const PRECACHE_URLS\s*=\s*\[([\s\S]*?)\];/)?.[1] || "";
  assert.match(precache, /"\/workout-offline\.html"/);
  assert.match(precache, new RegExp(`"/workout-offline\\.js\\?v=${BUILD.replaceAll(".", "\\.")}"`));
  assert.doesNotMatch(precache, /"\/workout\s*\.html"/);
  assert.doesNotMatch(precache, /\/api\//);
  assert.match(
    worker,
    /if\s*\(\s*pageKey\s*===\s*"\/workout"\s*,?\s*\)\s*[\s\S]*cache\s*\.match\s*\(\s*"\/workout-offline\s*\.html"\s*,?\s*\)/,
  );
  assert.match(
    worker,
    /PRIVATE_HTML_PATHS\s*=\s*new\s*Set\s*\(\s*\[\s*"\/"\s*,\s*"\/index\s*\.html"\s*,\s*"\/account\s*\.html"/,
  );
});

test("offline continuation is bound to a prior account, expiry, exact draft, and online re-verification", () => {
  const normal = ["public/scripts/workout-state.js", "public/scripts/workout.js"]
      .map(read)
      .join("\n"),
    core = read("public/scripts/workout-core.js"),
    offline = read("public/scripts/workout-offline.js"),
    html = read("public/pages/workout-offline.html");
  assert.match(normal, /OFFLINE_CONTEXT_KEY\s*=\s*"strata_workout_offline_context_v1"/);
  assert.match(normal, /W\.offlineAccessUntil\(discovery\)/);
  assert.match(core, /now\s*\+\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(core, /\[\s*"cancel"\s*,\s*"pause"\s*,?\s*\]\s*\.includes/);
  assert.match(normal, /writeOfflineContext\(state\.draftKey\)/);
  assert.match(normal, /clearOfflineContext\(\);[\s\S]*trainingRoom/);
  assert.match(offline, /context\.userId[\s\S]*context\.ownerId/);
  assert.match(offline, /authorizedUntil\s*,?\s*\)\s*<=\s*Date\s*\.now\s*\(\s*,?\s*\)/);
  assert.match(
    offline,
    /W\s*\.readDraft\s*\(\s*localStorage\s*\.getItem\s*\(\s*context\s*\.draftKey\s*,?\s*\)\s*,\s*context\s*\.ownerId\s*,?\s*\)/,
  );
  assert.match(
    offline,
    /fetch\s*\(\s*"\/api\/me"\s*,\s*\{\s*credentials\s*:\s*"same-origin"\s*,\s*cache\s*:\s*"no-store"/,
  );
  assert.match(offline, /identity\s*\.user\s*\?\.discovery\s*\?\.active\s*!==\s*true/);
  assert.match(
    offline,
    /Number\s*\(\s*latest\s*\.revision\s*,?\s*\)\s*!==\s*Number\s*\(\s*state\s*\.record\s*\.workout\s*\.revision\s*,?\s*\)/,
  );
  assert.match(offline, /"Conflict — Review"/);
  assert.match(html, /This shell contains no cached account page or private API response/);
  assert.match(html, /Saved on device/);
  assert.match(html, /Sync pending/);
});

test("the offline page exposes a usable responsive logging and recovery surface", () => {
  const html = read("public/pages/workout-offline.html"),
    css = read("public/styles/workout-offline.css");
  for (const id of [
    "offlineUnavailable",
    "offlineSession",
    "offlineEntries",
    "deviceSaveState",
    "syncState",
    "saveOnDevice",
    "syncWorkout",
    "finishOffline",
    "downloadOfflineDraft",
    "finishOfflineDialog",
  ])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-labelledby="finishOfflineTitle"/);
  assert.match(css, /min-height\s*:\s*44px/);
  assert.match(css, /@media\s*\(\s*max-width\s*:\s*420px\s*,?\s*\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*,?\s*\)/);
});

test("offline input is checked per field, completed sets are read-only, and a failed save never looks saved", () => {
  const offline = read("public/scripts/workout-offline.js"),
    html = read("public/pages/workout-offline.html");
  assert.match(
    offline,
    /validity\s*\.badInput\s*\?\s*"Enter\s*a\s*number\."\s*:\s*W\s*\.inputError\s*\(\s*entry\s*,\s*field\s*,\s*value\s*,?\s*\)/,
  );
  assert.match(
    offline,
    /if\s*\(\s*!\s*W\s*\.readDraft\s*\(\s*serialized\s*,\s*state\s*\.record\s*\.ownerId\s*,?\s*\)\s*,?\s*\)/,
    "a write that could not be read back is refused",
  );
  assert.match(
    offline,
    /W\s*\.repairDraft\s*\(\s*localStorage\s*\.getItem\s*\(\s*context\s*\.draftKey\s*,?\s*\)\s*,\s*context\s*\.ownerId\s*,?\s*\)/,
  );
  assert.match(offline, /const\s*locked\s*=\s*set\s*\.completed\s*\|\|\s*!\s*active/);
  assert.match(offline, /Complete at least one set before finishing a workout\./);
  assert.match(
    offline,
    /state\s*\.saveError\s*\?\s*"Couldn't\s*save\s*—\s*Retry"\s*:\s*"Saved\s*on\s*device"/,
  );
  assert.doesNotMatch(
    offline,
    /setStates\s*\(\s*"Saved\s*on\s*device"/,
    "no code path hard-codes a success label",
  );
  assert.match(offline, /W\.cleanNote\(event\.target\.value\)/);
  assert.match(html, /id="finishOfflineCounts"/);
  assert.match(html, /To change a completed set, uncheck Completed first\./);
});
