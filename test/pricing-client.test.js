"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = [
  "entitlements.js",
  "pricing-logic.js",
  "pricing-state.js",
  "pricing-api.js",
  "pricing-render.js",
  "pricing-events.js",
  "pricing.js",
]
  .map((name) => fs.readFileSync(path.join(__dirname, "../public/scripts", name), "utf8"))
  .join("\n");
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
};
const response = (status, data) => ({ ok: status < 400, status, json: async () => data });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function runtime({
  checkoutFailure = false,
  configFailure = false,
  userOverride = null,
  meResponse = null,
  checkoutResponse = null,
  search = "",
} = {}) {
  const nodes = new Map(),
    listeners = {},
    documentListeners = {},
    checkout = {};
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        hidden: false,
        disabled: false,
        textContent: "",
        innerHTML: "",
        attrs: {},
        classList: { toggle() {} },
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        removeAttribute(k) {
          delete this.attrs[k];
          delete this[k];
        },
        focus() {},
        addEventListener(type, fn) {
          this[type] = fn;
        },
      });
    return nodes.get(id);
  };
  let accountUser = userOverride || {
    id: "member",
    discovery: { active: false, accessType: null, subscription: null },
  };
  let accountResponder = meResponse;
  const config = {
    enabled: true,
    environment: "live",
    clientToken: "live_fixture",
    productId: `pro_${"a".repeat(26)}`,
    priceId: `pri_${"b".repeat(26)}`,
    price: { amount: "2.99", currency: "USD", interval: "month", frequency: 1 },
  };
  const document = {
    visibilityState: "visible",
    getElementById: node,
    addEventListener(type, fn) {
      documentListeners[type] = fn;
    },
  };
  const context = {
    document,
    location: { search, assign() {} },
    navigator: { onLine: true },
    URLSearchParams,
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    window: {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
    },
    Paddle: {
      Initialize(options) {
        checkout.event = options.eventCallback;
      },
      Checkout: {
        open() {
          checkout.open = true;
        },
        close() {
          checkout.open = false;
          checkout.closeCalls = (checkout.closeCalls || 0) + 1;
        },
      },
    },
    fetch: async (url) => {
      let data,
        status = 200;
      if (url === "/api/me" && accountResponder) return accountResponder();
      if (url === "/api/me") {
        status = accountUser ? 200 : 401;
        data = accountUser ? { user: accountUser, csrfToken: "csrf" } : { error: "Not signed in." };
      } else if (url === "/api/billing/config") {
        status = configFailure ? 503 : 200;
        data = configFailure ? { error: "Checkout temporarily unavailable." } : config;
      } else if (url === "/api/billing/checkout" && checkoutResponse) return checkoutResponse();
      else if (url === "/api/billing/checkout") {
        status = checkoutFailure ? 503 : 200;
        data = checkoutFailure
          ? { error: "Payment provider unavailable. Try again." }
          : { transactionId: `txn_${"c".repeat(26)}` };
      } else throw new Error(`Unexpected request ${url}`);
      return response(status, data);
    },
  };
  vm.runInNewContext(source, context, { filename: "pricing.js" });
  return {
    node,
    listeners,
    checkout,
    emitVisibility(value) {
      document.visibilityState = value;
      documentListeners.visibilitychange?.();
    },
    emitWindow(type, event = {}) {
      listeners[type]?.(event);
    },
    setAccountUser(user) {
      accountResponder = null;
      accountUser = user;
    },
  };
}
test("checkout failures remain visible after render for members without Strata+", async () => {
  const r = runtime({ checkoutFailure: true });
  await flush();
  r.node("buyDiscovery").click();
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /Payment provider unavailable/);
  assert.equal(r.node("purchaseStatus").attrs.role, "alert");
  r.listeners.online();
  assert.match(r.node("purchaseStatus").textContent, /Payment provider unavailable/);
});
test("an open checkout disables a second checkout and provider errors are announced", async () => {
  const r = runtime();
  await flush();
  r.node("buyDiscovery").click();
  await flush();
  assert.equal(r.checkout.open, true);
  assert.equal(r.node("buyDiscovery").disabled, true);
  assert.match(r.node("purchaseStatus").textContent, /checkout is open/);
  r.checkout.event({ name: "checkout.error" });
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /Paddle could not complete checkout/);
  assert.equal(r.node("buyDiscovery").disabled, false);
});
test("checkout completion cannot confirm access from a different signed-in account", async () => {
  const r = runtime();
  await flush();
  r.node("buyDiscovery").click();
  await flush();
  r.setAccountUser({
    id: "other-member",
    discovery: {
      active: true,
      accessType: "paid",
      subscription: { id: "sub_other", active: true, status: "active" },
    },
  });
  r.emitWindow("focus");
  await flush();
  r.checkout.event({
    name: "checkout.completed",
    data: { transaction_id: `txn_${"c".repeat(26)}` },
  });
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /no longer signed in to that account/i);
  assert.doesNotMatch(
    r.node("purchaseStatus").textContent,
    /Subscription\s*confirmed|now\s*unlocked/i,
  );
  assert.equal(r.node("purchaseStatus").attrs.role, "status");
});

test("an open Paddle overlay closes when foreground identity changes", async () => {
  const r = runtime();
  await flush();
  r.node("buyDiscovery").click();
  await flush();
  assert.equal(r.checkout.open, true);
  r.setAccountUser({ id: "other-member", discovery: { active: false, accessType: null } });
  r.emitWindow("focus");
  await flush();
  assert.equal(r.checkout.open, false);
  assert.equal(r.checkout.closeCalls, 1);
  assert.match(
    r.node("purchaseStatus").textContent,
    /checkout belongs to another signed-in session/i,
  );
  assert.equal(
    r.node("checkAccess").hidden,
    false,
    "the original transaction remains available for safe confirmation after signing back into its account",
  );
});

test("pricing never offers or requests the retired free trial", async () => {
  const r = runtime();
  await flush();
  assert.equal(
    r.node("buyDiscovery").hidden,
    false,
    "a signed-in member without Strata+ sees one subscribe action",
  );
  assert.equal(r.node("buyDiscovery").disabled, false);
  assert.match(r.node("buyDiscovery").textContent, /^Subscribe to Strata\+/);
  assert.equal(r.node("openDiscovery").hidden, true);
  assert.match(r.node("purchaseStatus").textContent, /ready for secure Paddle checkout/i);
  assert.doesNotMatch(r.node("purchaseStatus").textContent, /trial/i);
});

test("a delayed checkout response stays pending for its initiator and cannot open for a switched account", async () => {
  const delayed = deferred(),
    r = runtime({ checkoutResponse: () => delayed.promise });
  await flush();
  r.node("buyDiscovery").click();
  r.setAccountUser({ id: "other-member", discovery: { active: false, accessType: null } });
  r.emitWindow("focus");
  await flush();
  delayed.resolve(response(200, { transactionId: `txn_${"c".repeat(26)}` }));
  await flush();
  assert.equal(r.checkout.open, undefined);
  assert.match(
    r.node("purchaseStatus").textContent,
    /checkout belongs to another signed-in session/i,
  );
  assert.equal(
    r.node("checkAccess").hidden,
    false,
    "the A-owned checkout remains pending instead of becoming B's checkout",
  );
});

test("pricing focus clears account UI and restores the same canceling account with one paired recheck", async () => {
  const same = deferred(),
    member = {
      id: "member",
      email: "member@example.test",
      discovery: {
        active: true,
        accessType: "paid",
        subscription: {
          id: "sub_cancel",
          active: true,
          status: "active",
          scheduledChange: { action: "cancel", effectiveAt: Date.now() + 86400000 },
          currentPeriodEndsAt: Date.now() + 86400000,
        },
      },
    };
  let calls = 0;
  const responses = [response(200, { user: member, csrfToken: "csrf" }), same.promise];
  const r = runtime({
    meResponse: () => {
      calls += 1;
      return responses.shift();
    },
  });
  await flush();
  assert.equal(r.node("openDiscovery").hidden, false);
  r.emitWindow("focus");
  r.emitVisibility("visible");
  assert.equal(calls, 2, "focus and visibility share one in-flight recheck");
  assert.equal(r.node("purchaseSignup").hidden, false);
  assert.match(r.node("purchaseStatus").textContent, /Checking which account/i);
  same.resolve(response(200, { user: member, csrfToken: "csrf-next" }));
  await flush();
  assert.equal(r.node("purchaseSignup").hidden, true);
  assert.equal(r.node("openDiscovery").hidden, false);
  assert.match(
    r.node("purchaseStatus").textContent,
    /remains active until[\s\S]*cancellation takes effect/i,
  );
  assert.equal(
    r.node("buyDiscovery").hidden,
    true,
    "an active subscription cannot buy a second one",
  );
});

test("pricing persisted pageshow revalidates logout but ordinary pageshow does not", async () => {
  let calls = 0;
  const responses = [
    response(200, {
      user: { id: "member", discovery: { active: true, accessType: "paid" } },
      csrfToken: "csrf",
    }),
    response(401, { error: "Not signed in." }),
  ];
  const r = runtime({
    meResponse: () => {
      calls += 1;
      return responses.shift();
    },
  });
  await flush();
  r.emitWindow("pageshow", { persisted: false });
  await flush();
  assert.equal(calls, 1);
  r.emitWindow("pageshow", { persisted: true });
  await flush();
  assert.equal(calls, 2);
  assert.equal(r.node("purchaseSignup").hidden, false);
  assert.match(r.node("purchaseStatus").textContent, /Create an account or sign in/i);
});

test("pricing ignores a stale initial identity after a newer focus account switch", async () => {
  const stale = deferred(),
    fresh = deferred(),
    responses = [stale.promise, fresh.promise];
  const r = runtime({ meResponse: () => responses.shift() });
  await flush();
  r.emitWindow("focus");
  fresh.resolve(
    response(200, {
      user: { id: "fresh", discovery: { active: false, accessType: null } },
      csrfToken: "fresh-csrf",
    }),
  );
  await flush();
  stale.resolve(
    response(200, {
      user: { id: "stale", discovery: { active: true, accessType: "paid" } },
      csrfToken: "stale-csrf",
    }),
  );
  await flush();
  assert.equal(r.node("buyDiscovery").hidden, false);
  assert.equal(r.node("openDiscovery").hidden, true);
  assert.match(r.node("purchaseStatus").textContent, /ready for secure Paddle checkout/i);
});

test("checkout completion remains tied to its initiator after logout", async () => {
  const r = runtime();
  await flush();
  r.node("buyDiscovery").click();
  await flush();
  r.setAccountUser(null);
  r.checkout.event({
    name: "checkout.completed",
    data: { transaction_id: `txn_${"c".repeat(26)}` },
  });
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /account that started checkout/i);
  assert.doesNotMatch(
    r.node("purchaseStatus").textContent,
    /Subscription\s*confirmed|now\s*unlocked/i,
  );
});
test("an unavailable checkout explains the problem without offering a trial", async () => {
  const r = runtime({ configFailure: true });
  await flush();
  assert.equal(r.node("buyDiscovery").disabled, true);
  assert.match(r.node("purchaseStatus").textContent, /Checkout temporarily unavailable/);
  assert.doesNotMatch(r.node("purchaseStatus").textContent, /trial/i);
});
test("paid members can see a concurrent complimentary grant and continued billing disclosure", async () => {
  const expiresAt = Date.now() + 7 * 86400000;
  const user = {
    id: "member",
    discovery: {
      active: true,
      accessType: "paid",
      adminGrant: { active: true, startedAt: Date.now(), expiresAt, revokedAt: null },
      subscription: {
        id: "sub_active",
        status: "active",
        active: true,
        currentPeriodEndsAt: Date.now() + 30 * 86400000,
      },
    },
  };
  const r = runtime({ userOverride: user });
  await flush();
  assert.match(
    r.node("purchaseStatus").textContent,
    /complimentary Strata\+[\s\S]*monthly subscription remains separate/i,
  );
  assert.equal(r.node("manageSubscription").hidden, false);
});
test("grant-only members are not told to manage nonexistent billing", async () => {
  const user = {
    id: "member",
    discovery: {
      active: true,
      accessType: "grant",
      adminGrant: { active: true, startedAt: Date.now(), expiresAt: null, revokedAt: null },
      subscription: null,
    },
  };
  const r = runtime({ userOverride: user });
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /did not create a paid subscription/i);
  assert.doesNotMatch(r.node("purchaseStatus").textContent, /manage\s*it\s*from\s*Profile/i);
  assert.equal(r.node("manageSubscription").hidden, true);
});
test("lifetime members can see a concurrent complimentary grant", async () => {
  const user = {
    id: "member",
    discovery: {
      active: true,
      accessType: "paid",
      adminGrant: {
        active: true,
        startedAt: Date.now(),
        expiresAt: Date.now() + 7 * 86400000,
        revokedAt: null,
      },
      subscription: null,
    },
  };
  const r = runtime({ userOverride: user });
  await flush();
  assert.match(
    r.node("purchaseStatus").textContent,
    /grandfathered lifetime access remains separate/i,
  );
  assert.equal(r.node("manageSubscription").hidden, true);
});
test("on the website an App Store member is told Strata+ is through the App Store, with Apple's link and no checkout", async () => {
  const expiresAt = Date.parse("2026-11-01T12:00:00Z"),
    apple = {
      active: true,
      productId: "online.stratafitness.app.plus.monthly",
      expiresAt,
      autoRenew: true,
      inGracePeriod: false,
      environment: "Production",
      revoked: false,
    };
  const member = (value = {}, extra = {}) => ({
    id: "member",
    discovery: {
      active: true,
      accessType: "apple",
      adminGrant: { active: false },
      subscription: null,
      apple: { ...apple, ...value },
      ...extra,
    },
  });
  const r = runtime({
    userOverride: member(
      {},
      { subscription: { id: "sub_old", status: "canceled", active: false } },
    ),
  });
  await flush();
  assert.match(
    r.node("purchaseStatus").textContent,
    /^Your Strata\+ is through the App Store and renews on .+\. Apple bills it, so manage or cancel it with your App Store subscriptions\.$/,
  );
  assert.equal(r.node("buyDiscovery").hidden, true, "no Paddle checkout for an App Store member");
  assert.equal(r.node("openDiscovery").hidden, false);
  const manage = r.node("manageSubscription");
  assert.equal(manage.hidden, false);
  assert.equal(manage.href, "https://apps.apple.com/account/subscriptions");
  assert.equal(manage.target, "_blank");
  assert.equal(manage.rel, "noopener noreferrer");
  r.node("buyDiscovery").click();
  await flush();
  assert.equal(
    r.checkout.open,
    undefined,
    "an active App Store member cannot open Paddle checkout",
  );
  // A later account on the same tab gets the Paddle billing link back.
  r.setAccountUser({
    id: "member-2",
    discovery: {
      active: true,
      accessType: "paid",
      adminGrant: { active: false },
      subscription: {
        id: "sub_active",
        status: "active",
        active: true,
        currentPeriodEndsAt: Date.now() + 30 * 86400000,
      },
    },
  });
  r.emitVisibility("visible");
  await flush();
  assert.equal(manage.href, "/account.html#accountBilling");
  assert.equal(manage.target, undefined);
  assert.match(r.node("purchaseStatus").textContent, /monthly subscription is active/);
  const cancelling = runtime({ userOverride: member({ autoRenew: false }) });
  await flush();
  assert.match(
    cancelling.node("purchaseStatus").textContent,
    /^Your Strata\+ is through the App Store and ends on .+\. It will not renew unless you resubscribe with Apple\.$/,
  );
  const grace = runtime({
    userOverride: member({ inGracePeriod: true, expiresAt: Date.now() - 60_000 }),
  });
  await flush();
  assert.match(
    grace.node("purchaseStatus").textContent,
    /Apple could not collect the latest payment/,
  );
  const granted = runtime({
    userOverride: member(
      {},
      { adminGrant: { active: true, startedAt: Date.now(), expiresAt: null, revokedAt: null } },
    ),
  });
  await flush();
  assert.match(
    granted.node("purchaseStatus").textContent,
    /complimentary Strata\+[\s\S]*App Store subscription remains separate/,
  );
  assert.equal(
    granted.node("manageSubscription").href,
    "https://apps.apple.com/account/subscriptions",
  );
});
test("the reason a member arrived stays visible when checkout is unavailable", async () => {
  const r = runtime({ configFailure: true });
  await flush();
  assert.match(r.node("purchaseStatus").textContent, /Checkout temporarily unavailable/);
  const ai = runtime({ configFailure: true, search: "?reason=ai" });
  await flush();
  assert.match(
    ai.node("purchaseStatus").textContent,
    /^Strata AI is included with Strata\+\. Checkout temporarily unavailable/,
  );
  const required = runtime({ search: "?reason=discovery-required" });
  await flush();
  assert.equal(
    required.node("purchaseStatus").textContent,
    "That page is part of Strata+. Subscribe to continue.",
  );
});
