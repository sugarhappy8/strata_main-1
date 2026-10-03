"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { extname, join, relative, sep } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");
const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const SRC_ROOT = join(PROJECT_ROOT, "src");
const slash = (value) => value.split(sep).join("/");

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    assert.equal(
      entry.isSymbolicLink(),
      false,
      `${slash(relative(PROJECT_ROOT, absolute))} must not be a symlink`,
    );
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

test("keeps root, private server, and public browser files separated", () => {
  for (const required of [
    "server.js",
    "src/server.js",
    "src/account-deletion.js",
    "src/account-export.js",
    "src/account-self-service.js",
    "src/account-self-service-schema.js",
    "src/account-self-service-store.js",
    "src/admin.js",
    "src/auth.js",
    "src/billing-store.js",
    "src/database.js",
    "src/domain-types.d.ts",
    "src/email.js",
    "src/http.js",
    "src/paddle-catalog.js",
    "src/paddle-checkout-retirement.js",
    "src/paddle-webhooks.js",
    "src/payments.js",
    "src/plans.d.ts",
    "src/plans.js",
    "src/product-signals-schema.js",
    "src/product-signals.js",
    "src/progression.js",
    "src/schema.js",
    "src/service-composition.js",
    "src/setup.js",
    "src/store-contract.js",
    "src/support.js",
    "src/training-loop-schema.js",
    "src/training-loop-store.js",
    "src/training.js",
    "src/workouts.d.ts",
    "src/data/discovery-data.json",
    "public/pages/index.html",
    "public/pages/forgot-password.html",
    "public/pages/reset-password.html",
    "public/pages/delete-account.html",
    "public/pages/admin.html",
    "public/scripts/admin.js",
    "public/styles/admin.css",
    "public/scripts/app.js",
    "public/scripts/account-recovery.js",
    "public/styles/styles.css",
    "public/data/exercises.json",
    "public/fonts/manrope-latin.woff2",
    "public/fonts/dm-mono-400-latin.woff2",
    "public/fonts/dm-mono-500-latin.woff2",
    "public/images/hero-training-960.avif",
    "public/images/hero-training-960.webp",
    "public/images/hero-training-960.jpg",
    "public/images/hero-training-1600.avif",
    "public/images/hero-training-1600.webp",
    "public/images/hero-training-1600.jpg",
    "public/styles/fonts.css",
    "public/service-worker.js",
    "public/manifest.webmanifest",
  ])
    assert.ok(existsSync(join(PROJECT_ROOT, required)), `${required} must exist`);

  assert.deepEqual(readdirSync(PUBLIC_ROOT).sort(), [
    "data",
    "fonts",
    "icons",
    "images",
    "manifest.webmanifest",
    "pages",
    "scripts",
    "service-worker.js",
    "styles",
  ]);
  assert.deepEqual(readdirSync(SRC_ROOT).sort(), [
    "access-controls-schema.js",
    "access-controls-store.js",
    "access-controls.js",
    "account-deletion.js",
    "account-export.js",
    "account-self-service-schema.js",
    "account-self-service-store.js",
    "account-self-service.js",
    "admin-metrics.js",
    "admin-user-actions.js",
    "admin.js",
    "ai-catalog.js",
    "ai-context.js",
    "ai-core.js",
    "ai-daily-brief.js",
    "ai-plan-edits.js",
    "ai-plan-fallback.js",
    "ai-provider.js",
    "ai-quota.js",
    "ai-response-schema.js",
    "ai-schema.js",
    "ai-settings.js",
    "ai-store.js",
    "ai.js",
    "apple-billing-schema.js",
    "apple-billing-store.js",
    "apple-billing.js",
    "apple-jws.js",
    "athlete-profile.js",
    "auth.js",
    "billing-schema.js",
    "billing-store.js",
    "billing.js",
    "checkout-reconciliation.js",
    "coaching-core.js",
    "coaching-evidence.js",
    "coaching-prescription-core.js",
    "coaching-schema.js",
    "coaching-store.js",
    "coaching-training-core.js",
    "coaching.js",
    "daily-snapshot.js",
    "data",
    "data-layer-schema.js",
    "data-layer-store.js",
    "data-service.js",
    "database.js",
    "devices-config.js",
    "devices-crypto.js",
    "devices-schema.js",
    "devices-store.js",
    "devices-sync.js",
    "devices.js",
    "domain-types.d.ts",
    "email.js",
    "energy-activity-core.js",
    "energy-calibration-core.js",
    "energy-planning-core.js",
    "energy-scenarios-core.js",
    "entitlements.js",
    "events.js",
    "google-play-api.js",
    "google-play-billing-schema.js",
    "google-play-billing-store.js",
    "google-play-billing.js",
    "http.js",
    "meal-planning-core.js",
    "metrics-schema.js",
    "metrics-store.js",
    "metrics.js",
    "migrations.js",
    "observability.js",
    "paddle-catalog.js",
    "paddle-checkout-retirement.js",
    "paddle-subscriptions.js",
    "paddle-webhooks.js",
    "payments.js",
    "plans.d.ts",
    "plans.js",
    "polar-client.js",
    "polar-mapping.js",
    "product-signals-schema.js",
    "product-signals.js",
    "progression.js",
    "router.js",
    "schema.js",
    "server-state-schema.js",
    "server-state-store.js",
    "server.js",
    "service-composition.js",
    "session-renewal.js",
    "setup.js",
    "single-instance.js",
    "social-auth-client.js",
    "social-auth-config.js",
    "social-auth-messages.js",
    "social-auth-schema.js",
    "social-auth-store.js",
    "social-auth.js",
    "static-assets.js",
    "store-contract.js",
    "support.js",
    "training-log.js",
    "training-loop-schema.js",
    "training-loop-store.js",
    "training.js",
    "wellness-core.js",
    "workouts.d.ts",
    "workouts.js",
  ]);

  const rootFiles = readdirSync(PROJECT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert.deepEqual(rootFiles.filter((name) => name.endsWith(".js")).sort(), ["server.js"]);
  assert.deepEqual(
    rootFiles.filter((name) => /\.(?:html|css|webmanifest|jpe?g|png|svg)$/.test(name)),
    [],
  );
  assert.deepEqual(
    walk(SRC_ROOT)
      .map((file) => slash(relative(SRC_ROOT, file)))
      .filter((name) => /\.(?:html|css|webmanifest|jpe?g|png|svg)$/.test(name)),
    [],
  );
  assert.match(
    readFileSync(join(PROJECT_ROOT, "server.js"), "utf8"),
    /require\("\.\/src\/server"\);/,
  );
});

test("keeps credentials, databases, and private modules out of public", () => {
  const allowedExtensions = new Set([
    ".html",
    ".css",
    ".js",
    ".json",
    ".webmanifest",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".woff2",
  ]);
  const forbiddenNames = new Set([
    "auth.js",
    "database.js",
    "discovery-data.json",
    "email.js",
    "http.js",
    "package-lock.json",
    "package.json",
    "payments.js",
    "plans.js",
    "progression.js",
    "render.yaml",
    "schema.js",
    "server.js",
    "service-composition.js",
    "store-contract.js",
    "support.js",
    "training-loop-schema.js",
    "training-loop-store.js",
    "training.js",
    "workouts.js",
  ]);
  const textExtensions = new Set([".html", ".css", ".js", ".json", ".webmanifest", ".svg"]);

  for (const file of walk(PUBLIC_ROOT)) {
    const name = slash(relative(PUBLIC_ROOT, file)),
      base = name.split("/").at(-1),
      extension = extname(base).toLowerCase();
    assert.ok(allowedExtensions.has(extension), `${name} has an unexpected public file type`);
    assert.ok(!forbiddenNames.has(base), `${name} is server-only`);
    assert.doesNotMatch(
      name,
      /(?:^|\/)(?:\.env(?:\..*)?|data\/.*\.(?:sqlite(?:-(?:shm|wal))?|db)|.*\.(?:pem|key))$/i,
    );
    if (textExtensions.has(extension)) {
      const body = readFileSync(file, "utf8");
      assert.doesNotMatch(
        body,
        /\b(?:ADMIN_EMAIL|SUPPORT_EMAIL|PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET|TURSO_AUTH_TOKEN|TURSO_DATABASE_URL|STRATA_DATA_DIR|RESEND_API_KEY|EMAIL_VERIFICATION_SECRET)\b/,
        `${name} references a server-only environment variable`,
      );
      assert.doesNotMatch(
        body,
        /pdl_(?:live|sandbox|sdbx)_apikey_[A-Za-z0-9_-]{16,}|pdl_ntfset_[A-Za-z0-9_-]{16,}/i,
        `${name} contains a Paddle secret`,
      );
      assert.doesNotMatch(
        body,
        /-----BEGIN\s*(?:RSA\s*|EC\s*|OPENSSH\s*)?PRIVATE\s*KEY-----/,
        `${name} contains a private key`,
      );
    }
  }
});

test("serves only explicitly mapped files from the public tree", () => {
  const source = readFileSync(join(SRC_ROOT, "server.js"), "utf8");
  const block = source.match(/const STATIC_FILES = new Map\(\[([\s\S]*?)\]\);\nconst PAGE_ALIASES/);
  assert.ok(block, "src/server.js must declare a literal STATIC_FILES allowlist");
  const targets = [...block[1].matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"\s*\]/g)]
    .map((match) => match[1])
    .sort();
  const publicFiles = walk(PUBLIC_ROOT)
    .map((file) => slash(relative(PUBLIC_ROOT, file)))
    .sort();
  assert.deepEqual(
    targets,
    publicFiles,
    "every public file must be explicitly mapped, with no unmapped clutter",
  );
  assert.match(
    source,
    /if\s*\(\s*!\s*STATIC_FILES\s*\.has\s*\(\s*requested\s*,?\s*\)\s*,?\s*\)\s*\{\s*notFound\s*\(\s*req\s*,\s*res\s*,?\s*\)/,
  );
  assert.match(
    source,
    /const\s*publicFile\s*=\s*STATIC_FILES\s*\.get\s*\(\s*requested\s*,?\s*\)\s*;\s*[\s\S]*?join\s*\(\s*PUBLIC_ROOT\s*,\s*publicFile\s*,?\s*\)/,
  );
  assert.doesNotMatch(source, /join\s*\(\s*PROJECT_ROOT\s*,\s*\s*(?:requested|url\s*\.pathname)/);
});
