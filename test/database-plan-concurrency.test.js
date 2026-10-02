"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");

function decodeTursoValue(value) {
  if (value.type === "null") return null;
  if (value.type === "integer") return Number(value.value);
  if (value.type === "float") return value.value;
  if (value.type === "text") return value.value;
  if (value.type === "blob") return Buffer.from(value.base64, "base64");
  throw new Error(`Unsupported fake Turso value type: ${value.type}`);
}

function encodeTursoValue(value) {
  if (value == null) return { type: "null" };
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value)))
    return { type: "integer", value: String(value) };
  if (typeof value === "number") return { type: "float", value };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { type: "blob", base64: Buffer.from(value).toString("base64") };
  return { type: "text", value: String(value) };
}

function fakeTursoTransport() {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const planRequests = [];
  return {
    database,
    planRequests,
    async fetch(url, options = {}) {
      if (String(url).endsWith("/v3/pipeline")) {
        return Response.json({
          baton: null,
          results: [{ type: "ok", response: { type: "close" } }],
        });
      }
      if (!String(url).endsWith("/v3/cursor")) throw new Error(`Unexpected fake Turso URL: ${url}`);
      const request = JSON.parse(options.body);
      const output = [JSON.stringify({ baton: "fake-turso-session" })];
      for (const [stepIndex, step] of request.batch.steps.entries()) {
        const remoteStatement = step.stmt;
        if (!remoteStatement || remoteStatement.sql === "ROLLBACK") continue;
        const sql = remoteStatement.sql,
          args = (remoteStatement.args || []).map(decodeTursoValue);
        const statement = database.prepare(sql);
        const rows = statement.all(...args);
        const columns = statement
          .columns()
          .map((column) => ({ name: column.name, decltype: column.type || "" }));
        if (sql.startsWith("INSERT INTO plans(")) planRequests.push({ sql, args });
        output.push(JSON.stringify({ type: "step_begin", step: stepIndex, cols: columns }));
        for (const row of rows) {
          output.push(
            JSON.stringify({
              type: "row",
              step: stepIndex,
              row: columns.map((column) => encodeTursoValue(row[column.name])),
            }),
          );
        }
        output.push(JSON.stringify({ type: "step_end", step: stepIndex, affected_row_count: 0 }));
      }
      return new Response(`${output.join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

test(
  "weekly plan saves atomically compare the expected revision",
  { concurrency: false },
  async () => {
    mkdirSync(TEST_RUNTIME, { recursive: true });
    const root = mkdtempSync(join(TEST_RUNTIME, "plan-concurrency-"));
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      tursoUrl: process.env.TURSO_DATABASE_URL,
      tursoToken: process.env.TURSO_AUTH_TOKEN,
      dataDir: process.env.STRATA_DATA_DIR,
    };
    process.env.NODE_ENV = "test";
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.STRATA_DATA_DIR = root;
    let store;
    try {
      store = await createStore(root);
      const now = 1_900_000_000_000,
        userId = "plan-concurrency-user";
      await store.insertUser({
        id: userId,
        name: "Plan Concurrency",
        email: "plan-concurrency@example.test",
        passwordHash: "plan-concurrency-hash",
        passwordSalt: "plan-concurrency-salt",
        createdAt: now,
        emailVerifiedAt: now,
      });

      const firstPlan = JSON.stringify({ version: 1, marker: "first" });
      const first = await store.upsertPlan(userId, firstPlan, now, 0);
      assert.equal(first.plan_json, firstPlan);
      assert.equal(first.updated_at, now);
      assert.equal(
        await store.upsertPlan(userId, JSON.stringify({ marker: "duplicate-create" }), now + 1, 0),
        null,
        "revision zero only creates a missing plan",
      );

      const leftPlan = JSON.stringify({ version: 1, marker: "left-tab" });
      const rightPlan = JSON.stringify({ version: 1, marker: "right-tab" });
      const [left, right] = await Promise.all([
        store.upsertPlan(userId, leftPlan, now, first.updated_at),
        store.upsertPlan(userId, rightPlan, now, first.updated_at),
      ]);
      assert.equal(
        [left, right].filter(Boolean).length,
        1,
        "only one writer can consume an expected revision",
      );
      const winner = left || right,
        winningPlan = left ? leftPlan : rightPlan;
      assert.equal(
        winner.updated_at,
        first.updated_at + 1,
        "timestamps advance even when the supplied clock does not",
      );
      assert.equal((await store.plan(userId)).plan_json, winningPlan);

      const stale = await store.upsertPlan(
        userId,
        JSON.stringify({ marker: "stale-overwrite" }),
        now + 100,
        winner.updated_at - 1,
      );
      assert.equal(stale, null);
      assert.equal(
        (await store.plan(userId)).plan_json,
        winningPlan,
        "a stale save cannot overwrite the winning plan",
      );
    } finally {
      await store?.close();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "revision zero cannot overwrite an existing legacy zero-revision plan",
  { concurrency: false },
  async () => {
    mkdirSync(TEST_RUNTIME, { recursive: true });
    const root = mkdtempSync(join(TEST_RUNTIME, "plan-zero-revision-"));
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      tursoUrl: process.env.TURSO_DATABASE_URL,
      tursoToken: process.env.TURSO_AUTH_TOKEN,
      dataDir: process.env.STRATA_DATA_DIR,
    };
    process.env.NODE_ENV = "test";
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;
    process.env.STRATA_DATA_DIR = root;
    let store;
    try {
      store = await createStore(root);
      const userId = "legacy-zero-plan-user",
        legacyPlan = JSON.stringify({ version: 1, marker: "legacy-zero" });
      await store.insertUser({
        id: userId,
        name: "Legacy Zero Plan",
        email: "legacy-zero-plan@example.test",
        passwordHash: "legacy-zero-plan-hash",
        passwordSalt: "legacy-zero-plan-salt",
        createdAt: 1_000,
      });
      const database = new DatabaseSync(join(root, "strata.sqlite"));
      database
        .prepare("INSERT INTO plans(user_id,plan_json,updated_at) VALUES(?,?,0)")
        .run(userId, legacyPlan);
      database.close();

      const rejected = await store.upsertPlan(
        userId,
        JSON.stringify({ version: 1, marker: "must-not-win" }),
        2_000,
        0,
      );
      assert.equal(
        rejected,
        null,
        "the zero revision is an absence sentinel, not a stored-row revision",
      );
      assert.deepEqual(await store.plan(userId), { plan_json: legacyPlan, updated_at: 0 });
    } finally {
      await store?.close();
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "Turso plan upserts preserve CAS arguments and RETURNING rows",
  { concurrency: false },
  async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      tursoUrl: process.env.TURSO_DATABASE_URL,
      tursoToken: process.env.TURSO_AUTH_TOKEN,
      dataDir: process.env.STRATA_DATA_DIR,
      fetch: globalThis.fetch,
    };
    const transport = fakeTursoTransport();
    process.env.NODE_ENV = "test";
    process.env.TURSO_DATABASE_URL = "http://fake-turso.test";
    process.env.TURSO_AUTH_TOKEN = "fake-turso-token";
    delete process.env.STRATA_DATA_DIR;
    globalThis.fetch = transport.fetch;
    let store;
    try {
      store = await createStore(PROJECT_ROOT);
      assert.equal(store.kind, "turso");
      const userId = "turso-plan-user",
        firstPlan = JSON.stringify({ marker: "first" }),
        secondPlan = JSON.stringify({ marker: "second" });
      await store.insertUser({
        id: userId,
        name: "Turso Plan",
        email: "turso-plan@example.test",
        passwordHash: "turso-plan-hash",
        passwordSalt: "turso-plan-salt",
        createdAt: 1_000,
      });

      assert.deepEqual(await store.upsertPlan(userId, firstPlan, 2_000, 0), {
        plan_json: firstPlan,
        updated_at: 2_000,
      });
      assert.deepEqual(await store.upsertPlan(userId, secondPlan, 2_000, 2_000), {
        plan_json: secondPlan,
        updated_at: 2_001,
      });
      assert.equal(
        await store.upsertPlan(userId, JSON.stringify({ marker: "duplicate-create" }), 3_000, 0),
        null,
      );
      assert.deepEqual(await store.plan(userId), { plan_json: secondPlan, updated_at: 2_001 });

      const legacyUserId = "turso-legacy-zero-user",
        legacyPlan = JSON.stringify({ marker: "legacy-zero" });
      await store.insertUser({
        id: legacyUserId,
        name: "Turso Legacy Plan",
        email: "turso-legacy-plan@example.test",
        passwordHash: "turso-legacy-plan-hash",
        passwordSalt: "turso-legacy-plan-salt",
        createdAt: 1_001,
      });
      transport.database
        .prepare("INSERT INTO plans(user_id,plan_json,updated_at) VALUES(?,?,0)")
        .run(legacyUserId, legacyPlan);
      assert.equal(
        await store.upsertPlan(legacyUserId, JSON.stringify({ marker: "must-not-win" }), 3_001, 0),
        null,
      );
      assert.deepEqual(await store.plan(legacyUserId), { plan_json: legacyPlan, updated_at: 0 });

      assert.match(
        transport.planRequests[0].sql,
        /WHERE \?<>0 AND plans\.updated_at=\? RETURNING plan_json,updated_at$/,
      );
      assert.deepEqual(transport.planRequests[0].args, [firstPlan, 2_000, userId, 0, 0, 0, 0]);
      assert.deepEqual(transport.planRequests[1].args, [
        secondPlan,
        2_000,
        userId,
        2_000,
        2_000,
        2_000,
        2_000,
      ]);
    } finally {
      await store?.close();
      transport.database.close();
      globalThis.fetch = previous.fetch;
      if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous.nodeEnv;
      if (previous.tursoUrl === undefined) delete process.env.TURSO_DATABASE_URL;
      else process.env.TURSO_DATABASE_URL = previous.tursoUrl;
      if (previous.tursoToken === undefined) delete process.env.TURSO_AUTH_TOKEN;
      else process.env.TURSO_AUTH_TOKEN = previous.tursoToken;
      if (previous.dataDir === undefined) delete process.env.STRATA_DATA_DIR;
      else process.env.STRATA_DATA_DIR = previous.dataDir;
    }
  },
);
