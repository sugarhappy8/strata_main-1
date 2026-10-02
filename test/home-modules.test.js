"use strict";

const test = require("node:test");
const { frontendBudget, lineCount } = require("./support/size-budget");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const Logic = require("../public/scripts/home-logic");
const State = require("../public/scripts/home-state");
const Api = require("../public/scripts/home-api");
const Render = require("../public/scripts/home-render");
const Events = require("../public/scripts/home-events");
const catalog = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "public/data/exercises.json"), "utf8"),
);

test("homepage modules expose one-way boundaries and keep the composition root small", () => {
  assert.equal(typeof Logic.normalizeCatalog, "function");
  assert.equal(typeof State.createState, "function");
  assert.equal(typeof Api.createClient, "function");
  assert.equal(typeof Render.createRenderer, "function");
  assert.equal(typeof Events.bindHomeEvents, "function");
  const appLines = lineCount(
    fs.readFileSync(path.join(PROJECT_ROOT, "public/scripts/app.js"), "utf8"),
  );
  assert.ok(appLines <= frontendBudget("app.js"), `homepage composition root is ${appLines} lines`);
});

test("homepage logic validates, filters, and ranks a catalog without DOM state", () => {
  const exercises = Logic.normalizeCatalog(catalog);
  assert.equal(exercises.length, catalog.length);
  const chest = Logic.filterExercises(exercises, {
    group: "chest",
    sub: "all",
    equipment: "Dumbbells",
    level: "all",
    query: "press",
    sort: "score",
  });
  assert.ok(chest.length > 0);
  assert.ok(
    chest.every(
      (exercise) =>
        exercise.group === "chest" &&
        exercise.equipment === "Dumbbells" &&
        `${exercise.name} ${exercise.pattern}`.toLowerCase().includes("press"),
    ),
  );
  assert.deepEqual(
    chest.map((exercise) => exercise.score),
    [...chest].map((exercise) => exercise.score).sort((left, right) => right - left),
  );
  assert.throws(
    () =>
      Logic.normalizeCatalog([{ ...catalog[0], metrics: { ...catalog[0].metrics, range: 101 } }]),
    /invalid range score/,
  );
});

test("homepage state owns catalog, filter, and account transitions", () => {
  const state = State.createState();
  State.setCatalog(state, catalog);
  assert.equal(state.catalogStatus, "ready");
  assert.equal(state.exercises.length, catalog.length);
  assert.equal(State.selectGroup(state, "legs"), true);
  assert.equal(state.group, "legs");
  assert.equal(State.selectSubfilter(state, "Quadriceps"), true);
  assert.equal(State.selectSubfilter(state, "Upper chest"), false);
  State.setAccount(state, { id: "u1", name: "Sam", discovery: { active: true } });
  assert.equal(state.accountStatus, "authenticated");
  State.beginAccountRecheck(state);
  assert.equal(state.accountStatus, "rechecking");
  assert.equal(state.user, null);
  State.setAccount(
    state,
    { id: "u1", name: "Sam", discovery: { active: true } },
    { verifiedAt: 100 },
  );
  assert.equal(state.accountStatus, "authenticated");
  assert.equal(state.accountVerifiedAt, 100);
  State.setAccount(state, null);
  assert.equal(state.accountStatus, "anonymous");
  assert.equal(state.accountVerifiedAt, 0);
  State.setAccountUnavailable(state);
  assert.equal(state.accountStatus, "unavailable");
  assert.equal(state.user, null);
  State.failCatalog(state);
  assert.equal(state.catalogStatus, "error");
  assert.deepEqual(state.exercises, []);
});

test("homepage pure logic safely counts known guest-plan entries", () => {
  const exercises = Logic.normalizeCatalog(catalog),
    known = exercises[0].id;
  const raw = JSON.stringify({
    days: {
      Monday: [{ exerciseId: known }, { exerciseId: "retired" }],
      Tuesday: [{ exerciseId: known }],
    },
  });
  assert.equal(Logic.guestPlanCount(raw, exercises), 2);
  assert.equal(Logic.guestPlanCount("not-json", exercises), 0);
});

test("homepage API normalizes transport and HTTP failures", async () => {
  const ok = Api.createClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ready: true }) }),
  });
  assert.deepEqual(await ok.request("/status"), { ready: true });
  const denied = Api.createClient({
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "Denied", code: "NOPE" }),
    }),
  });
  await assert.rejects(
    denied.request("/private"),
    (error) => error.status === 403 && error.code === "NOPE" && error.message === "Denied",
  );
  const offline = Api.createClient({
    fetchImpl: async () => {
      throw new TypeError("offline");
    },
  });
  await assert.rejects(offline.request("/status"), (error) => error.code === "NETWORK_ERROR");
});

test("homepage rendering escapes preview content at its boundary", () => {
  const html = Render.previewResultMarkup({
    rank: 1,
    match: 97,
    officialScore: 94,
    reasons: ["<reason>"],
    tradeoffText: 'safe "tradeoff"',
    exercise: { name: "<script>", sub: "Chest", equipment: "Cable", why: "<b>why</b>" },
  });
  assert.doesNotMatch(html, /<\s*script\s*>|<\s*b\s*>\s*why\s*<\s*\/b\s*>|<\s*reason\s*>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;reason&gt;/);
});
