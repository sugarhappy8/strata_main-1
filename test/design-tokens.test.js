"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");

const PUBLIC = join(__dirname, "..", "public");
const read = (path) => readFileSync(join(PUBLIC, path), "utf8");

test("every page loads the shared design tokens right after the fonts", () => {
  for (const page of readdirSync(join(PUBLIC, "pages")).filter((name) => name.endsWith(".html"))) {
    const links = [
      ...read(`pages/${page}`).matchAll(/<link rel="stylesheet" href="\/?([a-z-]+\.css)\?v=/g),
    ].map((match) => match[1]);
    assert.deepEqual(
      links.slice(0, 2),
      ["fonts.css", "tokens.css"],
      `${page} loads fonts.css, then tokens.css, before any page styles`,
    );
  }
  assert.match(
    read("service-worker.js"),
    /"\/tokens\.css\?v=[0-9.]+"/,
    "the tokens are cached for offline pages",
  );
});

test("one palette, type, radius, spacing, and motion scale live in tokens.css", () => {
  const tokens = read("styles/tokens.css");
  for (const name of [
    "--strata-ink",
    "--strata-accent",
    "--strata-green-text",
    "--strata-danger",
    "--strata-focus",
    "--strata-paper",
    "--strata-surface",
    "--strata-muted",
    "--strata-line",
    "--strata-night",
    "--strata-night-panel",
    "--strata-night-text",
    "--strata-font",
    "--strata-mono",
    "--strata-radius-control",
    "--strata-radius-surface",
    "--strata-radius-card",
    "--strata-radius-pill",
    "--strata-space-1",
    "--strata-space-8",
    "--strata-ease-out",
  ])
    assert.match(tokens, new RegExp(`${name}:`), name);
  // No other stylesheet defines a --strata-* token, so there is one source for each value.
  for (const file of readdirSync(join(PUBLIC, "styles")).filter(
    (name) => name.endsWith(".css") && name !== "tokens.css",
  ))
    assert.doesNotMatch(
      read(`styles/${file}`),
      /--strata-[a-z0-9-]+\s*:/,
      `${file} reads the tokens instead of redefining them`,
    );
});

test("the shared light palette reads the tokens, and night pages keep their own palette where it applies", () => {
  const experience = read("styles/experience.css");
  for (const [local, token] of [
    ["--paper", "--strata-paper"],
    ["--white", "--strata-surface"],
    ["--line", "--strata-line"],
    ["--muted", "--strata-muted"],
    ["--ink", "--strata-ink"],
    ["--accent", "--strata-accent"],
    ["--body", "--strata-font"],
  ])
    assert.match(
      experience,
      new RegExp(`${local}:\\s*var\\(${token}\\)`),
      `experience.css ${local}`,
    );
  // Page stylesheets that load before experience.css no longer carry copies of the light palette that never applied.
  for (const file of [
    "account.css",
    "admin.css",
    "install.css",
    "planner.css",
    "site-info.css",
    "styles.css",
  ]) {
    const root = read(`styles/${file}`).match(/(?:^|\n)\s*:root\s*\{([^}]*)\}/)?.[1] || "";
    assert.doesNotMatch(
      root,
      /--(?:paper|white|muted|line|ink|accent)\s*:/,
      `${file} leaves the light palette to the tokens`,
    );
  }
  // Setup renders at night: its palette is on the page body, where the later light palette cannot replace it.
  const onboarding = read("styles/onboarding.css");
  assert.match(
    onboarding,
    /body\s*\.setup-page\s*\{\s*[^}]*--muted\s*:\s*#b2b9aa\s*;\s*[^}]*--line\s*:\s*#383e31\s*;|body\s*\.setup-page\s*\{\s*[^}]*--line\s*:\s*#383e31\s*;\s*[^}]*--muted\s*:\s*#b2b9aa\s*;/,
  );
  assert.doesNotMatch(
    onboarding.match(/^:root \{[^}]*\}/)?.[0] || "",
    /--muted|--line|--text/,
    "setup's night palette is not on :root",
  );
});
