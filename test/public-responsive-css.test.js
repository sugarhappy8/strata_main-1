"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const css = (name) => readFileSync(join(ROOT, "public", "styles", name), "utf8");
// Selectors and declarations are compared without layout whitespace, so a reformat keeps the same meaning.
const compactSelector = (text) =>
  text
    .replace(/\s*([>,+~])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
const blocksWith = (source, declaration) =>
  [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(
      ([, selector, body]) =>
        !selector.trim().startsWith("@") &&
        body.replace(/\s+/g, "").includes(declaration.replace(/\s+/g, "")),
    )
    .map(([, selector]) => compactSelector(selector))
    .join(",");

test("public layouts let dynamic text shrink and wrap inside cards", () => {
  const expectations = {
    "styles.css": [".exercise-title h3", ".results-meta p", ".preview-status", ".toast"],
    "account.css": [".storage-state span", ".account-message", ".security-status", ".build-footer"],
    "site-info.css": [".policy-content p", ".purchase-status", ".contact-email", ".support-status"],
    "install.css": [
      ".install-status",
      ".device-card li",
      ".offline-options strong",
      ".install-footer",
    ],
    "admin.css": [".global-message", ".dialog-message", ".record-primary", ".admin-footer"],
  };

  for (const [file, selectors] of Object.entries(expectations)) {
    const wrapping = blocksWith(css(file), "overflow-wrap:anywhere");
    for (const selector of selectors)
      assert.ok(wrapping.includes(compactSelector(selector)), `${file} must wrap ${selector}`);
  }
});

test("responsive grid and flex children may shrink before text is laid out", () => {
  const expectations = {
    "styles.css": [".exercise-row > *", ".exercise-title button", ".preview-output-head > *"],
    "account.css": [".auth-panel", ".account-dashboard-head>div"],
    "site-info.css": [".policy-layout > *", ".pricing-grid > *", ".support-form-actions > *"],
    "install.css": [".hero-grid > *", ".offline-options > *"],
    "admin.css": [".admin-header > *", ".record-card > button > *", ".dialog-header > *"],
  };

  for (const [file, selectors] of Object.entries(expectations)) {
    const shrinkable = blocksWith(css(file), "min-width:0");
    for (const selector of selectors)
      assert.ok(
        shrinkable.includes(compactSelector(selector)),
        `${file} must let ${selector} shrink`,
      );
  }
});

test("mobile sticky mastheads are opaque while content scrolls behind them", () => {
  assert.match(
    css("account.css"),
    /@media\s*\(\s*max-width\s*:\s*760px\s*,?\s*\)\s*\{\s*\.account-header\s*\{\s*background\s*:\s*var\s*\(\s*--ink\s*,?\s*\)\s*[;,]?\s*\}\s*[;,]?\s*\}/,
  );
  assert.match(
    css("site-info.css"),
    /@media\s*\(\s*max-width\s*:\s*800px\s*,?\s*\)\s*\{\s*\s*\.info-header\s*\{\s*background\s*:\s*var\s*\(\s*--ink\s*,?\s*\)\s*;\s*[;,]?\s*\}\s*\s*[;,]?\s*\}/,
  );
  assert.match(
    css("admin.css"),
    /@media\s*\(\s*max-width\s*:\s*900px\s*,?\s*\)\s*\{\s*\.admin-header\s*\{\s*background\s*:\s*var\s*\(\s*--ink\s*,?\s*\)\s*[;,]?\s*\}\s*[;,]?\s*\}/,
  );
});

test("multi-line public action labels grow vertically instead of clipping", () => {
  for (const [file, selector] of [
    ["account.css", ".auth-panel button"],
    ["site-info.css", ".button"],
    ["install.css", ".button"],
    ["admin.css", ".button"],
  ]) {
    const source = css(file),
      flexible = blocksWith(source, "height:auto"),
      padded = blocksWith(source, "padding-top:10px");
    assert.ok(flexible.includes(compactSelector(selector)), `${file} must let ${selector} grow`);
    assert.ok(
      padded.includes(compactSelector(selector)),
      `${file} must pad multi-line ${selector}`,
    );
  }
});
