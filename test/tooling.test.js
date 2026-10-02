"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("one check command owns the complete pre-release verification sequence", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.scripts.check.split(" && "), [
    "npm run format:check",
    "npm run release:check",
    "npm run architecture:check",
    "npm run typecheck",
    "npm run lint",
    "npm run coverage",
    "npm run qa:runtime",
    "npm run performance",
    "npm run test:e2e",
  ]);
  assert.equal(manifest.scripts.qa, "npm run check");
  assert.equal(manifest.scripts.lint, "eslint . --max-warnings=0");
  assert.equal(manifest.scripts["format:check"], "prettier --check .");
  // Prettier never rewrites the inside of a template literal, so html`` markup keeps its bytes.
  assert.deepEqual(JSON.parse(read(".prettierrc.json")), {
    printWidth: 100,
    embeddedLanguageFormatting: "off",
  });
  assert.match(read("eslint.config.mjs"), /"max-len":\s*\[\s*"error",\s*\{\s*code:\s*140,/);
  assert.match(manifest.devDependencies.eslint, /^10\./);
  for (const layer of ["unit", "integration", "contract", "e2e"]) {
    assert.equal(manifest.scripts[`test:${layer}`], `node scripts/run-test-layer.js ${layer}`);
  }

  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /npx playwright install --with-deps chromium firefox webkit/);
  assert.match(workflow, /run: npm run check/);
  assert.doesNotMatch(
    workflow,
    /run\s*:\s*npm\s*run\s*coverage/,
    "the release gate already owns coverage",
  );

  const release = read(".github/workflows/release.yml");
  assert.match(
    release,
    /tags:\s*\n\s*- "v\*\.\*\.\*"\s*\n\s*workflow_dispatch:/,
    "a version tag or a manual run publishes a release",
  );
  assert.match(release, /permissions:\s*\n\s*contents: write/);
  assert.match(
    release,
    /version="\$\(node -p 'require\("\.\/package\.json"\)\.version'\)"/,
    "the release version comes from package.json",
  );
  assert.match(release, /"\$REF_NAME" != "\$tag"/, "a pushed tag must match the package version");
  assert.match(
    release,
    /"\$REF_NAME" != "\$DEFAULT_BRANCH"/,
    "manual releases run only from the default branch",
  );
  assert.match(
    release,
    /notes="docs\/release-\$\{version\}\.md"/,
    "release notes come from the reviewed release guide",
  );
  assert.doesNotMatch(
    release.slice(release.indexOf("run: |")),
    /\$\s*\{\s*\{/,
    "the publish script reads refs from the environment, never inline expressions",
  );
});

test("coverage reports application code and enforces calibrated regression floors", () => {
  const command = JSON.parse(read("package.json")).scripts.coverage;
  assert.equal(command, "node scripts/coverage-check.js");
  const coverageRunner = read("scripts/coverage-check.js");
  assert.match(coverageRunner, /lines\s*:\s*90/);
  assert.match(coverageRunner, /branches\s*:\s*78/);
  assert.match(coverageRunner, /functions\s*:\s*85/);
  assert.match(coverageRunner, /--test-coverage-include=server\.js/);
  assert.match(coverageRunner, /--test-coverage-include=src\/\*\*\/\*\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/discovery-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/monthly-plan-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/workout-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/onboarding-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/preview-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/activation-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/plan-insights-core\.js/);
  assert.match(coverageRunner, /--test-coverage-include=public\/scripts\/training-block-core\.js/);
  assert.doesNotMatch(coverageRunner, /public\/scripts\/\s*\*\*\s*\/\s*\*\.js/);
});

test("security and architecture guidance cover the maintained trust boundaries", () => {
  const readme = read("README.md"),
    security = read("SECURITY.md"),
    architecture = read("docs/architecture.md"),
    deployment = read("docs/deployment.md");
  assert.match(readme, /docs\/architecture\.md/);
  assert.match(readme, /docs\/deployment\.md/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(security, /report a vulnerability privately/i);
  assert.match(security, /do not open a public GitHub issue/i);
  for (const boundary of [
    "src/auth.js",
    "src/admin.js",
    "src/support.js",
    "SQLite",
    "Turso",
    "Paddle",
    "Resend",
    "PWA architecture",
  ]) {
    assert.match(
      architecture,
      new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      boundary,
    );
  }
  assert.match(deployment, /PADDLE_CHECKOUT_ENABLED=false/);
  assert.match(deployment, /npm run check/);
});
