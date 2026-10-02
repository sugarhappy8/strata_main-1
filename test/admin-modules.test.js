"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SCRIPT_ROOT = join(__dirname, "..", "public", "scripts");

test("admin modules expose the same focused interfaces in a browser context", () => {
  const context = vm.createContext({ clearTimeout, setTimeout, Date, Intl, Set, URLSearchParams });
  for (const file of [
    "admin-state.js",
    "admin-logic.js",
    "admin-api.js",
    "admin-render.js",
    "admin-session.js",
    "admin-events.js",
  ]) {
    vm.runInContext(readFileSync(join(SCRIPT_ROOT, file), "utf8"), context, { filename: file });
  }
  assert.equal(typeof context.StrataAdminState.createState, "function");
  assert.equal(typeof context.StrataAdminLogic.expectedConfirmation, "undefined");
  assert.equal(typeof context.StrataAdminApi.createClient, "function");
  assert.equal(typeof context.StrataAdminRender.createRenderer, "function");
  assert.equal(typeof context.StrataAdminSession.createSessionCoordinator, "function");
  assert.equal(typeof context.StrataAdminEvents.bindEvents, "function");
});

test("admin state instances do not leak private session or pagination data", () => {
  const { createState } = require("../public/scripts/admin-state");
  const first = createState(),
    second = createState();
  first.csrfToken = "private";
  first.loaded.add("overview");
  first.users.items.push({ id: "one" });
  assert.equal(second.csrfToken, "");
  assert.equal(second.loaded.size, 0);
  assert.deepEqual(second.users.items, []);
});

test("admin private-operation epochs invalidate every in-flight callback together", () => {
  const { createState } = require("../public/scripts/admin-state"),
    state = createState();
  const initial = state.capturePrivateOperation();
  assert.equal(state.isCurrentPrivateOperation(initial), true);
  state.invalidatePrivateOperations();
  assert.equal(state.isCurrentPrivateOperation(initial), false);
  const current = state.capturePrivateOperation();
  assert.equal(state.isCurrentPrivateOperation(current), true);
  assert.notEqual(current, initial);
});

test("admin pure logic normalizes hostile labels and supplies one-click action labels", () => {
  const logic = require("../public/scripts/admin-logic");
  const user = {
    id: "user-one",
    email: "owner\u202e@example.test",
    status: "suspended",
    discovery: { active: true },
  };
  assert.equal(logic.userEmail(user), "owner@example.test");
  assert.equal(logic.userSuspended(user), true);
  assert.equal(logic.discoveryActive(user), true);
  assert.equal(logic.ACTION_DETAILS["delete-account"].button, "Permanently delete account");
  assert.equal(
    logic.ACTION_DETAILS["close-checkouts"].button,
    "Block new and close eligible checkouts",
  );
  assert.match(
    logic.ACTION_DETAILS["close-checkouts"].description,
    /draft checkout[^.]*retires the draft/i,
  );
  assert.match(
    logic.ACTION_DETAILS["close-checkouts"].description,
    /disabling its checkout link and clearing STRATA’s checkout metadata/i,
  );
  assert.match(
    logic.ACTION_DETAILS["close-checkouts"].description,
    /Revoking STRATA sign-in sessions is separate/i,
  );
  assert.equal(logic.ACTION_DETAILS.suspend.button, "Suspend account");
  assert.equal(logic.supportState({ status: "waiting_on_user" }), "waiting");
  assert.equal(
    logic.friendlyError({ code: "INVALID_CSRF" }),
    "The security check expired. Refresh this page and try again.",
  );
  assert.match(logic.friendlyError({ code: "CHECKOUT_PREPARING" }), /in-flight checkout/i);
  assert.match(
    logic.friendlyError({ code: "CHECKOUT_PREPARING" }),
    /Blocking new payment sessions does not erase/i,
  );
  assert.match(logic.friendlyError({ code: "PURCHASE_PENDING" }), /payment or subscription link/i);
  assert.match(
    logic.friendlyError({ code: "PURCHASE_PENDING" }),
    /revoking STRATA sign-in sessions do not cancel/i,
  );
  assert.match(
    logic.friendlyError({ code: "PURCHASE_RECONCILIATION_UNAVAILABLE" }),
    /Paddle did not confirm the checkout cleanup/i,
  );
  assert.match(
    logic.friendlyError({ code: "PURCHASE_RECONCILIATION_INVALID" }),
    /safely match the Paddle checkout/i,
  );
  assert.equal(
    logic.friendlyError({
      code: "CHECKOUT_CLOSE_INCOMPLETE",
      message: "New payment sessions are blocked. Safe provider detail.",
    }),
    "New payment sessions are blocked. Safe provider detail.",
  );
  assert.notEqual(
    logic.friendlyError({ code: "CHECKOUT_PREPARING" }),
    logic.friendlyError({ code: "PURCHASE_PENDING" }),
  );
});

test("admin API reports network and structured server failures without losing error codes", async () => {
  const { createClient } = require("../public/scripts/admin-api");
  const offline = createClient({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(
    () => offline.identity(),
    (error) => error.code === "network",
  );
  const denied = createClient({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "Security check failed", code: "INVALID_CSRF" }),
    }),
  });
  await assert.rejects(
    () => denied.userAction("member-one", { action: "suspend" }),
    (error) =>
      error.status === 403 &&
      error.code === "INVALID_CSRF" &&
      error.message === "Security check failed",
  );
});

test("admin renderer purges hidden account, support, action, and status data", () => {
  const stateModule = require("../public/scripts/admin-state"),
    logic = require("../public/scripts/admin-logic"),
    { createRenderer } = require("../public/scripts/admin-render");
  const nodes = new Map();
  function node(id = "") {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        value: "",
        hidden: false,
        required: false,
        textContent: "",
        className: "",
        open: false,
        children: [],
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        replaceChildren(...children) {
          this.children = children;
        },
        append(...children) {
          this.children.push(...children);
        },
        setAttribute() {},
        focus() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(id);
  }
  const document = {
    getElementById: node,
    createElement: () => node(`created-${nodes.size}`),
    createDocumentFragment: () => node(`fragment-${nodes.size}`),
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => true,
    body: { classList: { toggle() {} } },
  };
  const state = stateModule.createState(),
    renderer = createRenderer({
      document,
      state,
      logic,
      productSignalLabels: stateModule.PRODUCT_SIGNAL_LABELS,
      supportStates: stateModule.SUPPORT_STATES,
      requestFrame: (callback) => callback(),
    });
  const sentinel = "PRIVATE-SENTINEL@example.test";
  renderer.renderUserDetails(
    {
      id: "private-user",
      name: sentinel,
      email: sentinel,
      createdAt: 1,
      verifiedAt: 1,
      discovery: {},
    },
    { actionsReady: false },
  );
  renderer.openSupportDialog(
    {
      id: "private-ticket",
      reference: "STR-PRIVATE",
      subject: sentinel,
      email: sentinel,
      message: sentinel,
      status: "new",
      createdAt: 1,
      updatedAt: 1,
    },
    null,
  );
  renderer.openActionConfirmation("delete-account", null, logic.ACTION_DETAILS["delete-account"]);
  for (const id of [
    "usersStatus",
    "supportStatus",
    "auditStatus",
    "overviewStatus",
    "productSignalStatus",
    "globalMessage",
  ])
    node(id).textContent = sentinel;
  renderer.clearPrivateData();
  for (const id of [
    "userDialogTitle",
    "userDialogEmail",
    "userDetailStatus",
    "supportDialogTitle",
    "supportDialogIdentity",
    "ticketMessage",
    "confirmTitle",
    "confirmDescription",
    "confirmMessage",
    "usersStatus",
    "supportStatus",
    "auditStatus",
    "overviewStatus",
    "productSignalStatus",
    "globalMessage",
  ])
    assert.equal(node(id).textContent, "", id);
  for (const id of ["userQuery", "ticketNote", "ticketResponse"])
    assert.equal(node(id).value, "", id);
  for (const id of [
    "userResults",
    "supportResults",
    "auditResults",
    "productSignalRows",
    "userFacts",
    "supportFacts",
  ])
    assert.deepEqual(node(id).children, [], id);
});

test("admin shows a member's App Store subscription beside the Paddle facts", () => {
  const stateModule = require("../public/scripts/admin-state"),
    logic = require("../public/scripts/admin-logic"),
    { createRenderer } = require("../public/scripts/admin-render");
  const expiresAt = Date.parse("2026-11-01T12:00:00Z"),
    summary = {
      active: true,
      productId: "online.stratafitness.app.plus.monthly",
      expiresAt,
      autoRenew: true,
      inGracePeriod: false,
      environment: "Sandbox",
      revoked: false,
    };
  const facts = (apple) => Object.fromEntries(logic.appleFacts({ discovery: { apple } }));
  assert.deepEqual(facts({ activeCount: 1, expiresAt, subscription: summary }), {
    "App Store subscription": "Active",
    "App Store environment": "Sandbox (test purchase)",
    "App Store expiry": logic.formatDate(expiresAt),
    "App Store auto-renew": "On",
    "App Store revoked": "No",
  });
  const revoked = facts({
    subscription: {
      ...summary,
      active: false,
      revoked: true,
      autoRenew: null,
      environment: "Production",
    },
  });
  assert.equal(revoked["App Store subscription"], "Revoked (refunded or Family Sharing removed)");
  assert.equal(revoked["App Store auto-renew"], "Unknown");
  assert.equal(revoked["App Store environment"], "Production");
  assert.equal(revoked["App Store revoked"], "Yes");
  assert.equal(
    facts({ subscription: { ...summary, inGracePeriod: true, expiresAt: expiresAt - 86_400_000 } })[
      "App Store subscription"
    ],
    "Active · billing grace period",
  );
  assert.equal(
    facts({ subscription: { ...summary, active: false, autoRenew: false } })[
      "App Store subscription"
    ],
    "Expired",
  );
  assert.equal(
    facts({ subscription: { ...summary, active: false, autoRenew: false } })[
      "App Store auto-renew"
    ],
    "Off",
  );
  assert.deepEqual(
    logic.appleFacts({
      discovery: { apple: { activeCount: 0, expiresAt: null, subscription: null } },
    }),
    [["App Store subscription", "None"]],
  );
  // The list row (before details load) has only a count and the latest expiry.
  assert.deepEqual(logic.appleFacts({ discovery: { apple: { activeCount: 1, expiresAt } } }), [
    ["App Store subscription", `Active · expires ${logic.formatDate(expiresAt)}`],
  ]);
  assert.deepEqual(logic.appleFacts({ discovery: { apple: { activeCount: 0, expiresAt } } }), [
    ["App Store subscription", `Expired ${logic.formatDate(expiresAt)}`],
  ]);
  assert.deepEqual(logic.appleFacts({ discovery: {} }), [["App Store subscription", "None"]]);
  assert.deepEqual(logic.appleFacts(null), [["App Store subscription", "None"]]);

  const nodes = new Map();
  function node(id = "") {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        value: "",
        hidden: false,
        required: false,
        textContent: "",
        className: "",
        open: false,
        children: [],
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {} },
        replaceChildren(...children) {
          this.children = children;
        },
        append(...children) {
          this.children.push(...children);
        },
        setAttribute() {},
        focus() {},
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
      });
    return nodes.get(id);
  }
  let created = 0;
  const document = {
    getElementById: node,
    createElement: () => node(`created-${created++}`),
    createDocumentFragment: () => node(`fragment-${created++}`),
    querySelectorAll: () => [],
    querySelector: () => null,
    contains: () => true,
    body: { classList: { toggle() {} } },
  };
  const state = stateModule.createState(),
    renderer = createRenderer({
      document,
      state,
      logic,
      productSignalLabels: stateModule.PRODUCT_SIGNAL_LABELS,
      supportStates: stateModule.SUPPORT_STATES,
      requestFrame: (callback) => callback(),
    });
  renderer.renderUserDetails({
    id: "member-one",
    name: "Member",
    email: "member@example.test",
    createdAt: 1,
    verifiedAt: 1,
    discovery: {
      active: true,
      adminGrant: { active: false },
      apple: { activeCount: 1, expiresAt, subscription: summary },
    },
  });
  const labels = node("userFacts").children.map((wrapper) => wrapper.children[0].textContent),
    rendered = Object.fromEntries(
      node("userFacts").children.map((wrapper) => [
        wrapper.children[0].textContent,
        wrapper.children[1].textContent,
      ]),
    );
  assert.equal(rendered["Strata+"], "Unlocked");
  assert.equal(rendered["App Store subscription"], "Active");
  assert.equal(rendered["App Store environment"], "Sandbox (test purchase)");
  assert.equal(rendered["App Store auto-renew"], "On");
  assert.equal(rendered["App Store revoked"], "No");
  assert.equal(rendered["App Store expiry"], logic.formatDate(expiresAt));
  assert.ok(
    labels.indexOf("Latest purchase activity") < labels.indexOf("App Store subscription"),
    "App Store facts follow the Paddle purchase facts",
  );
});
