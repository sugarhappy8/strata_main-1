"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeFrontend,
  dependencyCycles,
  htmlScripts,
  loadPolicy,
  validateFrontend,
} = require("../scripts/frontend-architecture-report");

test("large interactive pages keep enforced logic, state, API, rendering, events, and entry boundaries", () => {
  const policy = loadPolicy(),
    analysis = analyzeFrontend(undefined, policy),
    errors = validateFrontend(analysis, policy);
  assert.deepEqual(errors, []);
  assert.equal(analysis.pages.length, 8);
  assert.deepEqual(dependencyCycles(analysis.modules), []);
  for (const page of analysis.pages) {
    assert.equal(page.modules.at(-1).role, "entry");
    assert.equal(new Set(page.modules.map((module) => module.role)).size >= 6, true);
  }
});

test("frontend checks reject missing roles, budget drift, load-order regressions, and cycles", () => {
  assert.deepEqual(htmlScripts('<script src="/a.js?v=1"></script><script src="b.js"></script>'), [
    "a.js",
    "b.js",
  ]);
  const assets = {
    "page.js": '// Entry.\nimport "./a.js?v=1";\nimport "./b.js?v=1";\n',
    "a.js": "",
    "b.js": "",
  };
  assert.deepEqual(
    htmlScripts(
      '<script src="/shell.js"></script><script type="module" src="/page.js?v=1"></script>',
      (asset) => assets[asset],
    ),
    ["shell.js", "a.js", "b.js", "page.js"],
    "a module entry stands for its imports, in order, and then itself",
  );
  const analysis = {
    definitions: [],
    modules: [
      { file: "public/scripts/entry.js", lines: 20, dependencies: ["public/scripts/state.js"] },
      { file: "public/scripts/state.js", lines: 80, dependencies: ["public/scripts/entry.js"] },
    ],
    pages: [
      {
        name: "fixture",
        html: "fixture.html",
        scripts: ["entry.js", "state.js"],
        moduleEntries: [{ asset: "page.js", source: 'import "./a.js";\nglobalThis.extra = 1;\n' }],
        modules: [
          { file: "public/scripts/entry.js", role: "entry", maxLines: 10 },
          { file: "public/scripts/state.js", role: "state", maxLines: 20 },
        ],
      },
    ],
  };
  const errors = validateFrontend(analysis, { pages: { fixture: {} } });
  assert.ok(errors.some((error) => /no logic boundary/.test(error)));
  assert.ok(errors.some((error) => /reviewed entry budget/.test(error)));
  assert.ok(errors.some((error) => /dependency direction/.test(error)));
  assert.ok(errors.some((error) => /dependency cycle/.test(error)));
  assert.ok(errors.some((error) => /page\.js must only import fixture's scripts/.test(error)));
});
