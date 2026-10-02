"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA, SQL } = require("../src/schema");
const { PRODUCT_SIGNAL_TRIGGER } = require("../src/product-signals-schema");
const { createStore } = require("../src/database");

const PROJECT_ROOT = join(__dirname, "..");
const TEST_RUNTIME = join(PROJECT_ROOT, "test-runtime");

function queryPlan(database, sql, args) {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((row) => String(row.detail));
}

function uses(plan, indexName) {
  return plan.some((detail) => detail.includes(indexName));
}

test("schema indexes match the exercised authentication, entitlement, and abuse-control queries", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    for (const statement of SCHEMA) database.exec(statement);

    assert.equal(
      uses(queryPlan(database, SQL.session, ["token", 0]), "sqlite_autoindex_sessions_1"),
      true,
    );
    assert.equal(
      uses(queryPlan(database, SQL.revokeUserSessionsDelete, ["user"]), "sessions_user_id"),
      true,
    );
    assert.equal(uses(queryPlan(database, SQL.deleteExpired, [0]), "sessions_expires_at"), true);
    assert.equal(
      uses(
        queryPlan(database, SQL.countVerificationSends, ["email", 0]),
        "email_verification_sends_email_time",
      ),
      true,
    );
    assert.equal(
      uses(
        queryPlan(database, SQL.countAccountActionSends, ["email", "password_reset", 0]),
        "account_action_sends_email_time",
      ),
      true,
    );
    assert.equal(
      uses(
        queryPlan(database, SQL.purchaseByTransaction, ["transaction"]),
        "sqlite_autoindex_paddle_purchases_1",
      ),
      true,
    );
    assert.equal(
      uses(
        queryPlan(database, SQL.hasDiscoveryAccess, ["user", null, null]),
        "paddle_purchases_user_id",
      ),
      true,
    );
    assert.equal(
      uses(
        queryPlan(database, SQL.productSignalCounts, ["2026-01-01", "2026-12-31"]),
        "sqlite_autoindex_product_signal_counts_1",
      ),
      true,
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info(product_signal_counts)")
        .all()
        .map((row) => row.name),
      ["event_day", "event_name", "event_count", "member_count", "anonymous_count"],
    );
    for (const statement of PRODUCT_SIGNAL_TRIGGER) database.exec(statement);
    assert.throws(
      () =>
        database
          .prepare(SQL.recordProductSignal)
          .get("2026-09-07", "not_allowlisted", "a".repeat(64), "member"),
      /check constraint/i,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM product_signal_actors").get().count,
      0,
      "a refused count leaves no daily key behind",
    );

    const supportPlan = queryPlan(database, SQL.claimSupportRequestEvent, [
      "event",
      "ip",
      "email",
      1_000,
      "ip",
      0,
      10,
      "email",
      0,
      10,
      0,
      100,
    ]);
    for (const index of [
      "support_request_events_ip_time",
      "support_request_events_email_time",
      "support_request_events_time",
    ])
      assert.equal(uses(supportPlan, index), true, index);

    const allIndexes = database
      .prepare("SELECT name FROM sqlite_schema WHERE type='index'")
      .all()
      .map((row) => row.name);
    for (const unused of ["paddle_purchases_customer_id", "support_tickets_email"])
      assert.equal(
        allIndexes.includes(unused),
        false,
        `${unused} has no matching production query`,
      );
  } finally {
    database.close();
  }
});

test(
  "the additive SQLite migration removes superseded write-only indexes",
  { concurrency: false },
  async () => {
    mkdirSync(TEST_RUNTIME, { recursive: true });
    const directory = mkdtempSync(join(TEST_RUNTIME, "index-migration-"));
    const file = join(directory, "strata.sqlite");
    const database = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    for (const statement of SCHEMA) database.exec(statement);
    database.exec(`
    CREATE INDEX paddle_purchases_customer_id ON paddle_purchases(customer_id);
    CREATE INDEX support_tickets_email ON support_tickets(email,created_at DESC);
  `);
    database.close();

    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      STRATA_DATA_DIR: process.env.STRATA_DATA_DIR,
      TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
    };
    let store;
    try {
      process.env.NODE_ENV = "test";
      process.env.STRATA_DATA_DIR = directory;
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_AUTH_TOKEN;
      store = await createStore(PROJECT_ROOT);
      await store.close();
      store = null;

      const migrated = new DatabaseSync(file, { readOnly: true });
      const indexes = migrated
        .prepare("SELECT name FROM sqlite_schema WHERE type='index'")
        .all()
        .map((row) => row.name);
      migrated.close();
      for (const removed of ["paddle_purchases_customer_id", "support_tickets_email"])
        assert.equal(indexes.includes(removed), false, removed);
    } finally {
      if (store) await store.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
