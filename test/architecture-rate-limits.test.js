"use strict";

// Rate limits are decided by one database write, so the limiter returns a Promise. A Promise is always truthy: a call
// that is not awaited would turn its limit off without any error. Every call in src/ must be awaited.
const test = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const SRC = join(__dirname, "..", "src");
const LIMITERS =
  /(?<![\w.])(rateAllowed|rateKeyAllowed|accountRateAllowed|verificationRateAllowed)\(/g;

test("every rate-limit check in src/ is awaited", () => {
  const missing = [];
  let checked = 0;
  for (const file of readdirSync(SRC).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(SRC, file), "utf8");
    for (const match of source.matchAll(LIMITERS)) {
      const before = source.slice(Math.max(0, match.index - 9), match.index);
      if (before.endsWith("function ")) continue;
      checked += 1;
      if (!before.endsWith("await ")) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push(`${file}:${line} ${match[1]}`);
      }
    }
  }
  assert.ok(checked >= 40, `expected the limiter calls to be found (found ${checked})`);
  assert.deepEqual(missing, [], "a rate-limit call that is not awaited is always allowed");
});
