"use strict";
const { DatabaseSync } = require("node:sqlite");

function workoutFixture(id = "workout-session-1") {
  return {
    id,
    title: "Monday strength",
    planDay: "Monday",
    date: "2026-01-05",
    status: "active",
    startedAt: 1767600000000,
    completedAt: null,
    elapsedSeconds: 0,
    restEndsAt: null,
    entries: [
      {
        id: "entry-1",
        exerciseId: "flat-dumbbell-press",
        measurement: "reps",
        loadType: "external",
        unit: "kg",
        prescribedReps: "8–12",
        sets: [
          { reps: 10, weight: 20, seconds: null, completed: false },
          { reps: null, weight: null, seconds: null, completed: false },
        ],
      },
    ],
  };
}
function fakeTursoFactory(capture = () => {}) {
  return function factory() {
    const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    capture(database);
    async function execute(statement) {
      const sql = typeof statement === "string" ? statement : statement.sql,
        args = typeof statement === "string" ? [] : statement.args || [],
        prepared = database.prepare(sql);
      if (/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const objects = prepared.all(...args),
          columns = prepared.columns().map((column) => column.name);
        return {
          columns,
          rows: objects.map((row) => columns.map((column) => row[column])),
          rowsAffected: Number(database.prepare("SELECT changes() AS count").get().count),
        };
      }
      return { columns: [], rows: [], rowsAffected: Number(prepared.run(...args).changes) };
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
  };
}
module.exports = { workoutFixture, fakeTursoFactory };
