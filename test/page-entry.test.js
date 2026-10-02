"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { moduleImports } = require("../scripts/frontend-architecture-report");
const { pageScripts } = require("./support/page-scripts");
const { strataBuild, version } = require("../package.json");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const BUILD = strataBuild || version;

test("Strata+ loads one module entry after the three scripts that must run before paint", () => {
  const html = read("public/pages/discover.html");
  const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(tags, [
    `<script src="/html.js?v=${BUILD}">`,
    `<script src="/app-shell.js?v=${BUILD}">`,
    `<script src="/motion.js?v=${BUILD}">`,
    `<script type="module" src="/discover-page.js?v=${BUILD}">`,
  ]);

  const entry = read("public/scripts/discover-page.js");
  const specifiers = [...entry.matchAll(/^import\s+"([^"]+)";$/gm)].map((match) => match[1]);
  assert.equal(specifiers.length, moduleImports(entry).length);
  assert.ok(specifiers.length >= 30);
  for (const specifier of specifiers)
    assert.match(
      specifier,
      new RegExp(`^\\./[a-z0-9-]+\\.js\\?v=${BUILD.replaceAll(".", "\\.")}$`),
    );
  assert.equal(pageScripts("discover.html").at(-2), "discover.js", "the Strata+ shell runs last");

  const server = read("src/server.js"),
    worker = read("public/service-worker.js");
  for (const name of ["discover-page.js", ...moduleImports(entry)]) {
    assert.match(
      server,
      new RegExp(`\\["${name.replaceAll(".", "\\.")}", "scripts/`),
      `${name} is served`,
    );
    assert.ok(worker.includes(`"/${name}?v=${BUILD}"`), `${name} is precached`);
  }
  assert.match(read("scripts/release-version.js"), /"public\/scripts\/discover-page\.js"/);
});
