"use strict";

const test = require("node:test"),
  assert = require("node:assert/strict");
const { scryptSync } = require("node:crypto");
const { createAuthService } = require("../src/auth");
const salt = Buffer.alloc(16, 8).toString("base64"),
  password = "navigation-password-123";
const user = {
  id: "navigation-user",
  email: "navigation@example.test",
  email_verified_at: Date.now(),
  auth_version: 1,
  password_salt: salt,
  password_hash: scryptSync(password, Buffer.from(salt, "base64"), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("base64"),
};
const destinations = [
  ["discover", "/discover.html"],
  ["/discover.html", "/discover.html"],
  ["workout", "/workout.html"],
  ["/workout.html", "/workout.html"],
  ["onboarding", "/onboarding.html"],
  ["/onboarding.html", "/onboarding.html"],
  ["https://outside.test/workout.html", "/planner.html"],
  ["//outside.test/onboarding.html", "/planner.html"],
  ["/workout.html?day=Monday", "/workout.html?day=Monday"],
  ["/workout.html?day=Funday", "/planner.html"],
  ["/workout.html?day=Monday&next=//outside.test", "/planner.html"],
  ["/workout.html?next=//outside.test", "/planner.html"],
  ["/onboarding.html/../../outside", "/planner.html"],
  ["\\\\outside.test\\workout.html", "/planner.html"],
];

function fixture() {
  let input,
    redirect,
    allowOrigin = true;
  const auth = createAuthService({
    store: { userByEmail: async () => user, insertSession: async () => true },
    emailConfig: { enabled: true, requestedEnabled: true },
    trustedAuthOrigin: () => allowOrigin,
    rateAllowed: () => true,
    getUserPayload: async () => ({ id: user.id }),
    http: {
      json() {},
      bodyForm: async () => input,
      redirect: (_res, location) => {
        redirect = location;
      },
    },
  });
  return {
    auth,
    async submit(path, next, { trusted = true } = {}) {
      input = { email: user.email, password, next };
      allowOrigin = trusted;
      await auth.handleForm(
        { method: "POST", headers: {} },
        {},
        new URL(path, "https://strata.test"),
      );
      return redirect;
    },
  };
}

test("native account and verification pages render exact new internal destinations and reject redirects", () => {
  const { auth } = fixture();
  for (const [requested, destination] of destinations) {
    const url = new URL(`https://strata.test/account.html?next=${encodeURIComponent(requested)}`);
    const account = auth.renderAccountFallbacks(
      '<input id="signupNext" value=""><input id="loginNext" value="">',
      url,
    );
    assert.equal(
      account,
      `<input id="signupNext" value="${destination}"><input id="loginNext" value="${destination}">`,
    );
    const verification = auth.renderVerificationFallbacks(
      '<input id="verificationNext" value=""><input id="resendNext" value="">',
      url,
    );
    assert.equal(
      verification,
      `<input id="verificationNext" value="${destination}"><input id="resendNext" value="${destination}">`,
    );
  }
});

test("native successful login returns to new workflows without enabling external redirects", async () => {
  const form = fixture();
  for (const [requested, destination] of destinations)
    assert.equal(await form.submit("/auth/login", requested), destination);
});

test("native authentication failures carry new destinations across account and verification forms", async () => {
  const form = fixture();
  for (const [requested, destination] of destinations)
    for (const path of [
      "/auth/login",
      "/auth/signup",
      "/auth/verify-email",
      "/auth/resend-verification",
    ]) {
      const location = new URL(
        await form.submit(path, requested, { trusted: false }),
        "https://strata.test",
      );
      assert.equal(location.origin, "https://strata.test");
      assert.equal(
        location.pathname,
        path.includes("verification") || path === "/auth/verify-email"
          ? "/verify-email.html"
          : "/account.html",
      );
      assert.equal(
        location.searchParams.get("next"),
        destination.includes("?") ? destination : destination.slice(1, -5),
      );
    }
});
