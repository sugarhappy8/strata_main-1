"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { scryptSync, createHash } = require("node:crypto");
const { createStore } = require("../src/database");
const { createAuthService } = require("../src/auth");
const { createAdminService } = require("../src/admin");
const { routeHarness } = require("./support/route-harness");

const ROOT = join(__dirname, "..");
const EMAIL = "owner@auth-race.test";
const OLD_PASSWORD = "original-password-12345";
const NEW_PASSWORD = "replacement-password-12345";
const SALT = Buffer.alloc(16, 7).toString("base64");
const hash = (password) =>
  scryptSync(password, Buffer.from(SALT, "base64"), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64");
const OLD_HASH = hash(OLD_PASSWORD),
  NEW_HASH = hash(NEW_PASSWORD);

async function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "strata-auth-race-"));
  const environment = Object.fromEntries(
    ["NODE_ENV", "STRATA_DATA_DIR", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  let store;
  try {
    process.env.NODE_ENV = "test";
    process.env.STRATA_DATA_DIR = dir;
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    store = await createStore(ROOT);
    const now = Date.now();
    await store.insertUser({
      id: "owner",
      name: "Owner",
      email: EMAIL,
      passwordHash: OLD_HASH,
      passwordSalt: SALT,
      createdAt: now,
      emailVerifiedAt: now,
    });
    await run(store);
  } finally {
    await store?.close();
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function services(store) {
  let admin, response, input;
  const http = {
    bodyJson: async () => input,
    json: (_res, status, data, headers = {}) => {
      response = { status, data, headers };
    },
  };
  const guards = { trustedAuthOrigin: () => true, rateAllowed: () => true };
  const emailConfig = { enabled: true, requestedEnabled: true };
  const auth = createAuthService({
    store,
    emailConfig,
    http,
    ...guards,
    getUserPayload: async (user) => ({ id: user.id }),
    claimAdminForLogin: (user) => admin.maybeClaimAdminForLogin(user),
  });
  admin = createAdminService({
    store,
    auth,
    emailConfig,
    paymentConfig: {},
    adminEmail: EMAIL,
    http,
    ...guards,
    reconcileCheckoutCreationBeforeDeletion: async () => 0,
    reconcileUnsettledPurchases: async () => 0,
  });
  const routed = routeHarness(auth.routes, { json: http.json });
  return {
    auth,
    async login(password = OLD_PASSWORD) {
      input = { email: EMAIL, password };
      await routed.handleApi(
        { method: "POST", headers: {} },
        {},
        new URL("http://auth-race.test/api/login"),
      );
      return response;
    },
  };
}

async function resetPassword(store) {
  const now = Date.now();
  await store.upsertAccountAction({
    requestId: "race-reset",
    userId: "owner",
    purpose: "password_reset",
    tokenHash: "race-reset-token",
    expiresAt: now + 60000,
    deliveryState: "sent",
    createdAt: now,
    updatedAt: now,
  });
  const user = await store.completePasswordReset("race-reset-token", NEW_HASH, SALT, now);
  assert.ok(user, "The concurrent password reset must actually succeed");
  return user;
}

async function sessionForResponse(store, response) {
  const cookie = response.headers["Set-Cookie"];
  if (!cookie) return null;
  const token = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
  return store.session(createHash("sha256").update(token).digest("hex"), Date.now());
}

for (const initiallyBound of [false, true]) {
  test(`admin login preserves ${initiallyBound ? "existing ownership" : "first ownership claim"} and issues a valid session`, async () =>
    fixture(async (store) => {
      if (initiallyBound) await store.claimAdminPrincipal("owner", EMAIL, Date.now());
      const initialVersion = (await store.userById("owner")).auth_version;
      const response = await services(store).login();
      assert.equal(response.status, 200);
      const session = await sessionForResponse(store, response);
      assert.ok(session);
      assert.equal(session.auth_version, initialVersion + (initiallyBound ? 0 : 1));
      assert.equal((await store.adminPrincipal()).user_id, "owner");
    }));

  for (const resetTiming of ["before claim", "after claim", "before session insertion"]) {
    test(`old-password login is rejected after reset ${resetTiming}, with ${initiallyBound ? "existing" : "new"} admin ownership`, async () =>
      fixture(async (baseStore) => {
        if (initiallyBound) await baseStore.claimAdminPrincipal("owner", EMAIL, Date.now());
        let pendingReset = true,
          resetUser;
        const resetOnce = async () => {
          if (pendingReset) {
            pendingReset = false;
            resetUser = await resetPassword(baseStore);
          }
        };
        const store = {
          ...baseStore,
          async claimAdminPrincipal(...args) {
            if (resetTiming === "before claim") await resetOnce();
            const result = await baseStore.claimAdminPrincipal(...args);
            if (resetTiming === "after claim") await resetOnce();
            return result;
          },
          async insertSession(record) {
            if (resetTiming === "before session insertion") await resetOnce();
            return baseStore.insertSession(record);
          },
        };
        const service = services(store),
          response = await service.login();
        assert.ok(resetUser, "The reset must interleave with this login");
        assert.equal(response.status, 409);
        assert.equal(response.data.code, "AUTHENTICATION_RETRY");
        assert.equal(
          response.headers["Set-Cookie"],
          undefined,
          "Rejected stale credentials must not receive a cookie",
        );
        assert.equal(
          (await service.login()).status,
          401,
          "The old password remains invalid on retry",
        );
        const recovered = await service.login(NEW_PASSWORD);
        assert.equal(recovered.status, 200, "The replacement password can authenticate normally");
        assert.ok(await sessionForResponse(baseStore, recovered));
      }));
  }
}

test("CSRF validation binds optional client identity to the authenticated account", () => {
  const { auth } = services({});
  const session = { id: "account-b", csrf_token: "valid-token" };
  const request = (user, token = "valid-token") => ({
    headers: { "x-csrf-token": token, ...(user === undefined ? {} : { "x-strata-user": user }) },
  });
  assert.equal(
    auth.validCsrf(request(undefined), session),
    true,
    "Existing clients remain compatible",
  );
  assert.equal(auth.validCsrf(request("account-b"), session), true);
  assert.equal(
    auth.validCsrf(request("account-a"), session),
    false,
    "A draft belonging to another account cannot be submitted after account switching",
  );
  assert.equal(auth.validCsrf(request(""), session), false);
  assert.equal(auth.validCsrf(request("account-b", "wrong-token"), session), false);
  assert.equal(auth.validCsrf(request("account-b"), null), false);
});
