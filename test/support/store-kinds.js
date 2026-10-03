"use strict";

// Runs a test against both storage adapters: the local SQLite store and the Turso store, the latter over an in-memory
// SQLite database that answers like the libSQL client (rows as column arrays, batches in one transaction).
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStore } = require("../../src/database");

const ROOT = join(__dirname, "..", "..");
const RUNTIME = join(ROOT, "test-runtime");
const KINDS = Object.freeze(["local", "turso"]);

function fakeTursoClient() {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  async function execute(statement) {
    const sql = typeof statement === "string" ? statement : statement.sql,
      args = typeof statement === "string" ? [] : statement.args || [];
    const prepared = database.prepare(sql);
    if (/^\s*(?:SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const objects = prepared.all(...args),
        columns = prepared.columns().map((column) => column.name);
      return {
        columns,
        rows: objects.map((row) => columns.map((column) => row[column])),
        rowsAffected: 0,
      };
    }
    const result = prepared.run(...args);
    return { columns: [], rows: [], rowsAffected: Number(result.changes) };
  }
  return {
    execute,
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await execute(statement));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}

/** @param {"local"|"turso"} kind @param {string} label @param {(store:any)=>Promise<void>} run */
async function withStore(kind, label, run) {
  mkdirSync(RUNTIME, { recursive: true });
  const directory = mkdtempSync(join(RUNTIME, `${label}-`));
  const keys = ["NODE_ENV", "STRATA_DATA_DIR", "TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let store;
  try {
    process.env.NODE_ENV = "test";
    if (kind === "turso") {
      delete process.env.STRATA_DATA_DIR;
      process.env.TURSO_DATABASE_URL = `https://${label}.invalid`;
      process.env.TURSO_AUTH_TOKEN = `${label}-token`;
      store = await createStore(ROOT, { tursoClientFactory: fakeTursoClient });
    } else {
      process.env.STRATA_DATA_DIR = directory;
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_AUTH_TOKEN;
      store = await createStore(ROOT);
    }
    await run(store);
  } finally {
    await store?.close();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { KINDS, fakeTursoClient, withStore };
