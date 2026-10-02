"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createAuthService, configuredAdminEmail } = require("../src/auth");
const { createAdminService } = require("../src/admin");
const { createSupportService } = require("../src/support");

const PROJECT_ROOT = join(__dirname, "..");
const noopHttp = {
  json() {},
  async bodyJson() {
    return {};
  },
  async bodyForm() {
    return {};
  },
  redirect() {},
};

function authService(store, overrides = {}) {
  return createAuthService({
    store,
    emailConfig: { enabled: false, requestedEnabled: false },
    environment: { NODE_ENV: "test", ALLOW_UNVERIFIED_SIGNUP_FOR_TESTS: "true" },
    trustedAuthOrigin: () => true,
    rateAllowed: () => true,
    http: noopHttp,
    getUserPayload: async (user) => user,
    ...overrides,
  });
}

test("server composition keeps auth, admin, and support implementations behind module boundaries", () => {
  const server = readFileSync(join(PROJECT_ROOT, "src", "server.js"), "utf8");
  const composition = readFileSync(join(PROJECT_ROOT, "src", "service-composition.js"), "utf8");
  assert.match(server, /composeServices\(\{/);
  assert.match(composition, /createAuthService\(\{/);
  assert.match(composition, /createAdminService\(\{/);
  assert.match(composition, /createSupportService\(\{/);
  // Each service hands the server a route table; src/router.js dispatches every API request.
  const registered = server.match(/router\.add\(([\s\S]*?)\);/)?.[1] || "";
  for (const service of ["auth", "admin", "support"])
    assert.match(
      registered,
      new RegExp(`\\b${service}\\.routes\\b`),
      `${service} routes are registered`,
    );
  assert.doesNotMatch(server, /\.handleApi\s*\(/, "no service is asked to route requests itself");
  assert.doesNotMatch(
    server,
    /function\s*(?:passwordMatches|beginAccountRegistration|verifyAccountEmail|resetPassword|adminIdentity|performAdminUserAction|createSupportRequest)\b/,
  );

  for (const file of ["auth.js", "admin.js", "support.js"]) {
    const source = readFileSync(join(PROJECT_ROOT, "src", file), "utf8");
    assert.doesNotMatch(
      source,
      /require\s*\(\s*["']\.\/database["']\s*,?\s*\)/,
      `${file} must receive its store explicitly`,
    );
    assert.doesNotMatch(
      source,
      /require\s*\(\s*["']\.\/server["']\s*,?\s*\)/,
      `${file} must not depend on the application entry point`,
    );
  }
});

test("auth service hashes session cookies and compares CSRF tokens through its injected store", async () => {
  let requestedHash = "";
  const row = {
    id: "user-123",
    email: "member@example.test",
    email_verified_at: 1,
    csrf_token: "csrf-secret",
  };
  const store = {
    async session(tokenHash) {
      requestedHash = tokenHash;
      return row;
    },
    async insertSession() {
      return true;
    },
  };
  const auth = authService(store);
  const prepared = auth.prepareSession(row.id, 1000, 7);
  assert.notEqual(prepared.record.tokenHash, prepared.token);
  assert.equal(prepared.record.authVersion, 7);
  assert.equal(prepared.record.userId, row.id);
  assert.equal(auth.validCsrf({ headers: { "x-csrf-token": "csrf-secret" } }, row), true);
  assert.equal(auth.validCsrf({ headers: { "x-csrf-token": "csrf-wrong" } }, row), false);

  const session = await auth.sessionFor({
    headers: { cookie: `ignored=1; strata_session=${encodeURIComponent(prepared.token)}` },
  });
  assert.equal(session, row);
  assert.equal(requestedHash, prepared.record.tokenHash);
  assert.doesNotMatch(auth.sessionCookie(prepared.token), /Secure/);
  assert.match(auth.sessionCookie(prepared.token), /HttpOnly; SameSite=Strict/);
});

test("admin ownership requires one normalized, verified configured principal", async () => {
  const configured = "owner@example.test";
  assert.equal(configuredAdminEmail(`  ${configured.toUpperCase()}  `), configured);
  assert.equal(configuredAdminEmail("owner+alias@example.test"), "owner+alias@example.test");
  assert.equal(configuredAdminEmail("owner@example.test,other@example.test"), "");

  const session = {
    id: "owner-id",
    email: configured,
    email_verified_at: 10,
    token_hash: "session-hash",
  };
  let principal = {
    user_id: session.id,
    configured_email: configured,
    email: configured,
    email_verified_at: 10,
    suspended_at: null,
  };
  const store = {
    async adminPrincipal() {
      return principal;
    },
  };
  const auth = {
    normalizeEmail: (value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    async requireSession() {
      return session;
    },
    validCsrf: () => true,
    sessionCookie: () => "",
    passwordMatches: async () => true,
    prepareSession: () => ({ record: {}, token: "token", csrfToken: "csrf" }),
    accountEmailHash: () => "email-hash",
    requestSignedInAccountAction: async () => ({ maskedEmail: "o***@example.test" }),
  };
  const admin = createAdminService({
    store,
    adminEmail: configured,
    auth,
    emailConfig: { enabled: true },
    paymentConfig: { enabled: false },
    trustedAuthOrigin: () => true,
    rateAllowed: () => true,
    http: noopHttp,
    reconcileCheckoutCreationBeforeDeletion: async () => 0,
    reconcileUnsettledPurchases: async () => 0,
  });
  assert.equal((await admin.adminIdentity(session)).active, true);
  principal = { ...principal, email: "different@example.test" };
  assert.equal((await admin.adminIdentity(session)).active, false);
  principal = { ...principal, email: configured, email_verified_at: null };
  assert.equal((await admin.adminIdentity(session)).active, false);
});

test("service factories reject incomplete composition", () => {
  assert.throws(() => createAuthService({}), /requires store/);
  assert.throws(() => createAdminService({}), /requires store/);
  assert.throws(() => createSupportService({}), /requires store/);
});
