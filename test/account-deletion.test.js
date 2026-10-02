"use strict";

// The in-app deletion route and the protections it shares with the emailed deletion link, with every collaborator
// faked: the order of the checks, what each refusal says, and that nothing is removed unless every check passes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ROUTE, createAccountDeletion, deletedMessage } = require("../src/account-deletion");
const { routeHarness } = require("./support/route-harness");

const NOW = 1_800_000_000_000;
const APPLE = {
  message:
    "Deleting your STRATA account does not cancel a Strata+ subscription bought through Apple. Apple keeps billing your Apple Account until you cancel it in Settings > Apple ID > Subscriptions.",
  manageUrl: "https://apps.apple.com/account/subscriptions",
};
const SESSION = {
  id: "member-1",
  name: "Ari",
  email: "ari@example.test",
  token_hash: "session-hash",
  csrf_token: "csrf-token",
  expires_at: NOW + 60_000,
};

function harness({
  session = SESSION,
  csrf = true,
  origin = true,
  rate = () => true,
  password = "correct horse battery",
  principal = null,
  checkout = 0,
  purchases = 0,
  apple = null,
  removal = { status: "deleted", user: { id: "member-1", email: "ari@example.test" } },
  credentials = {
    id: "member-1",
    email: "ari@example.test",
    password_hash: "h",
    password_salt: "s",
  },
  storeFailure = null,
} = {}) {
  const calls = { passwords: [], removed: [], audits: [], rates: [], reconcile: [], errors: [] };
  const store = {
    async adminPrincipal() {
      return principal;
    },
    async accountCredentialsById(id) {
      if (storeFailure) throw storeFailure;
      return id === credentials?.id ? credentials : null;
    },
    async deleteAccountForUser(userId, tokenHash, deletedAt, emailHash) {
      calls.removed.push({ userId, tokenHash, deletedAt, emailHash });
      return typeof removal === "function" ? removal() : removal;
    },
  };
  const responses = new Map();
  const json = (res, status, data, headers = {}) => responses.set(res, { status, data, headers });
  const deletion = createAccountDeletion({
    store,
    http: {
      json,
      async bodyJson(req) {
        return req.body;
      },
    },
    rateAllowed(req, key, limit) {
      calls.rates.push({ key, limit });
      return rate(key);
    },
    async passwordMatches(value, user) {
      calls.passwords.push({ value, user });
      return value === password;
    },
    accountEmailHash: (email) => `hash:${email}`,
    accountActionError: (message, status, code) =>
      Object.assign(new Error(message), { status, code }),
    storageUnavailable: (error) => {
      calls.errors.push(error);
      return Object.assign(
        new Error("Account storage is temporarily unavailable. Please try again."),
        { status: 503 },
      );
    },
    audit: (event, details) => calls.audits.push({ event, ...details }),
    clearCookies: () => ["strata_session=; Max-Age=0", "strata_signup=; Max-Age=0"],
    async reconcileCheckoutCreationBeforeDeletion(userId) {
      calls.reconcile.push(["checkout", userId]);
      return checkout;
    },
    async reconcileUnsettledPurchases(userId) {
      calls.reconcile.push(["purchases", userId]);
      if (purchases instanceof Error) throw purchases;
      return purchases;
    },
    async appleDeletionNotice() {
      return apple;
    },
    now: () => NOW,
  });
  const routed = routeHarness(deletion.routes, {
    json,
    async requireSession(req, res) {
      if (!session) {
        json(res, 401, { error: "Sign in required." });
        return null;
      }
      return session;
    },
    validCsrf: () => csrf,
    trustedOrigin: () => origin,
  });
  async function post(body, { method = "POST", path = ROUTE } = {}) {
    const res = {};
    const handled = await routed.handleApi(
      { method, body },
      res,
      new URL(`https://strata.test${path}`),
    );
    return { handled, ...responses.get(res) };
  }
  return { deletion, calls, post };
}

test("deletes the signed-in account with the right password and DELETE, then clears both cookies", async () => {
  const { post, calls } = harness();
  const result = await post({ password: "correct horse battery", confirmation: "DELETE" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    ok: true,
    message: "Your STRATA account was permanently deleted.",
  });
  assert.deepEqual(result.headers, {
    "Set-Cookie": ["strata_session=; Max-Age=0", "strata_signup=; Max-Age=0"],
  });
  assert.equal(calls.removed.length, 1);
  const [removed] = calls.removed;
  assert.equal(removed.userId, "member-1");
  assert.equal(removed.deletedAt, NOW);
  assert.equal(removed.emailHash, "hash:ari@example.test");
  assert.match(
    removed.tokenHash,
    /^[0-9a-f]{64}$/,
    "the internal action is a random hash nobody holds",
  );
  assert.deepEqual(calls.audits, [
    { event: "account_deleted", purpose: "account_delete_in_app", email: "ari@example.test" },
  ]);
  assert.deepEqual(calls.reconcile, [
    ["checkout", "member-1"],
    ["purchases", "member-1"],
  ]);
  assert.deepEqual(calls.rates, [
    { key: "account-delete-now", limit: 5 },
    { key: "identity:account-delete-now:member-1", limit: 5 },
  ]);
  // A second request never reuses the first internal action.
  const again = harness();
  await again.post({ password: "correct horse battery", confirmation: "DELETE" });
  assert.notEqual(again.calls.removed[0].tokenHash, removed.tokenHash);
});

test("checks DELETE before the password, and a wrong password reveals nothing more", async () => {
  const missing = harness();
  for (const confirmation of [undefined, "", "delete", "DELETE NOW"]) {
    const result = await missing.post({ password: "correct horse battery", confirmation });
    assert.equal(result.status, 400);
    assert.equal(result.data.code, "DELETE_CONFIRMATION_REQUIRED");
  }
  assert.equal(missing.calls.passwords.length, 0, "the password is not checked without DELETE");
  assert.equal(
    (await missing.post({ password: "correct horse battery", confirmation: "  DELETE " })).status,
    200,
    "surrounding spaces are ignored, as on the emailed link",
  );

  const wrong = harness();
  for (const password of ["wrong password", "", undefined, 42, "x".repeat(129)]) {
    const result = await wrong.post({ password, confirmation: "DELETE" });
    assert.equal(result.status, 401);
    assert.deepEqual(result.data, {
      error: "That password is incorrect.",
      code: "PASSWORD_INCORRECT",
    });
    assert.equal(result.headers["Set-Cookie"], undefined);
  }
  assert.equal(
    wrong.calls.passwords.length,
    1,
    "only a plausible password reaches the scrypt comparison",
  );
  assert.equal(wrong.calls.removed.length, 0);
  assert.equal(wrong.calls.audits.length, 0);
  assert.equal(
    wrong.calls.reconcile.length,
    0,
    "billing is not touched before the password is proven",
  );
  assert.equal((await wrong.post(null)).data.code, "DELETE_CONFIRMATION_REQUIRED");
});

test("requires a trusted origin, a session, a valid CSRF token, and stays within both rate limits", async () => {
  const crossOrigin = await harness({ origin: false }).post({
    password: "correct horse battery",
    confirmation: "DELETE",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.data.code, "ORIGIN_REQUIRED");
  const signedOut = await harness({ session: null }).post({
    password: "correct horse battery",
    confirmation: "DELETE",
  });
  assert.equal(signedOut.status, 401);
  const csrf = harness({ csrf: false });
  const badCsrf = await csrf.post({ password: "correct horse battery", confirmation: "DELETE" });
  assert.equal(badCsrf.status, 403);
  assert.equal(badCsrf.data.code, "INVALID_CSRF");
  assert.equal(csrf.calls.rates.length, 0);
  for (const blocked of ["account-delete-now", "identity:account-delete-now:member-1"]) {
    const limited = harness({ rate: (key) => key !== blocked });
    const result = await limited.post({
      password: "correct horse battery",
      confirmation: "DELETE",
    });
    assert.equal(result.status, 429);
    assert.equal(result.data.code, "ACCOUNT_DELETE_RATE_LIMIT");
    assert.equal(result.headers["Retry-After"], "900");
    assert.equal(limited.calls.passwords.length, 0);
    assert.equal(limited.calls.removed.length, 0);
  }
  const get = await harness().post(undefined, { method: "GET" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, "POST");
  assert.deepEqual(await harness().post({}, { path: "/api/account/delete/complete" }), {
    handled: false,
  });
});

test("refuses exactly what the emailed link refuses, and deletes nothing", async () => {
  const cases = [
    [{ principal: { user_id: "member-1" } }, 409, "ADMIN_ACCOUNT_PROTECTED"],
    [{ checkout: 1 }, 409, "CHECKOUT_PREPARING"],
    [{ purchases: 2 }, 409, "PURCHASE_PENDING"],
    [
      {
        purchases: Object.assign(
          new Error(
            "Your Strata+ monthly subscription has not ended. Cancel it from subscription management first. Nothing was deleted.",
          ),
          { status: 409, code: "SUBSCRIPTION_ACTIVE" },
        ),
      },
      409,
      "SUBSCRIPTION_ACTIVE",
    ],
    [{ removal: { status: "purchase_pending" } }, 409, "PURCHASE_PENDING"],
    [{ removal: { status: "checkout_pending" } }, 409, "CHECKOUT_PREPARING"],
    [{ removal: { status: "invalid" } }, 409, "ACCOUNT_CHANGED"],
    [{ storeFailure: new Error("database offline") }, 503, "ACCOUNT_DELETE_FAILED"],
  ];
  for (const [options, status, code] of cases) {
    const { post, calls } = harness(options);
    const result = await post({ password: "correct horse battery", confirmation: "DELETE" });
    assert.equal(result.status, status, code);
    assert.equal(result.data.code, code);
    assert.equal(result.headers["Set-Cookie"], undefined, `${code} keeps the member signed in`);
    assert.equal(calls.audits.length, 0, `${code} is not logged as a deletion`);
  }
  const subscription = harness({
    purchases: Object.assign(
      new Error("Your Strata+ monthly subscription has not ended. Nothing was deleted."),
      { status: 409, code: "SUBSCRIPTION_ACTIVE" },
    ),
  });
  assert.match(
    (await subscription.post({ password: "correct horse battery", confirmation: "DELETE" })).data
      .error,
    /has not ended/,
  );
  assert.equal(subscription.calls.removed.length, 0);
  const offline = harness({ storeFailure: new Error("database offline") });
  assert.equal(
    (await offline.post({ password: "correct horse battery", confirmation: "DELETE" })).data.error,
    "Account storage is temporarily unavailable. Please try again.",
  );
  assert.equal(offline.calls.errors[0].message, "database offline");
});

test("an App Store subscription never blocks deletion; the response says Apple keeps billing", async () => {
  const { post, calls } = harness({ apple: APPLE });
  const result = await post({ password: "correct horse battery", confirmation: "DELETE" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.appleBilling, APPLE);
  assert.equal(
    result.data.message,
    `Your STRATA account was permanently deleted. ${APPLE.message}`,
  );
  assert.equal(calls.removed.length, 1);
  assert.equal(deletedMessage(null), "Your STRATA account was permanently deleted.");
});

test("the emailed link uses the same protections through deleteProtectedAccount", async () => {
  const { deletion, calls } = harness({ apple: APPLE });
  const removals = [];
  const result = await deletion.deleteProtectedAccount({
    userId: "member-1",
    email: "ari@example.test",
    purpose: "account_delete",
    remove: async (deletedAt, emailHash) => {
      removals.push({ deletedAt, emailHash });
      return { status: "deleted", user: { id: "member-1", email: "ari@example.test" } };
    },
    invalid: () => new Error("invalid link"),
  });
  assert.deepEqual(result, {
    user: { id: "member-1", email: "ari@example.test" },
    appleBilling: APPLE,
  });
  assert.deepEqual(removals, [{ deletedAt: NOW, emailHash: "hash:ari@example.test" }]);
  assert.deepEqual(calls.audits, [
    { event: "account_deleted", purpose: "account_delete", email: "ari@example.test" },
  ]);
  await assert.rejects(
    deletion.deleteProtectedAccount({
      userId: "member-1",
      email: "ari@example.test",
      purpose: "account_delete",
      remove: async () => ({ status: "invalid" }),
      invalid: () =>
        Object.assign(new Error("This deletion link is invalid or expired."), {
          status: 400,
          code: "INVALID_DELETE_LINK",
        }),
    }),
    { code: "INVALID_DELETE_LINK" },
  );
});

test("an account made with Google deletes with DELETE alone, but only within 15 minutes of signing in", async () => {
  const credentials = {
    id: "member-1",
    email: "ari@example.test",
    password_hash: "",
    password_salt: "",
  };
  const fresh = harness({
    credentials,
    session: { ...SESSION, session_created_at: NOW - 14 * 60_000 },
  });
  const deleted = await fresh.post({ confirmation: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.equal(fresh.calls.removed.length, 1);
  assert.equal(fresh.calls.passwords.length, 0, "there is no password to compare");

  for (const session of [{ ...SESSION, session_created_at: NOW - 16 * 60_000 }, SESSION]) {
    const stale = harness({ credentials, session });
    const result = await stale.post({ password: "anything", confirmation: "DELETE" });
    assert.equal(result.status, 401);
    assert.equal(result.data.code, "RECENT_SIGN_IN_REQUIRED");
    assert.match(result.data.error, /sign in again with Google/);
    assert.equal(stale.calls.removed.length, 0);
  }
  const confirmation = await harness({
    credentials,
    session: { ...SESSION, session_created_at: NOW },
  }).post({});
  assert.equal(confirmation.data.code, "DELETE_CONFIRMATION_REQUIRED", "DELETE is still required");
});
