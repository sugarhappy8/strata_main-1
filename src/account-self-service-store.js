// @ts-check
"use strict";

const {
  ACCOUNT_EXPORT_QUERIES,
  ACCOUNT_EXPORT_SINGLE_ROWS,
  ACCOUNT_SELF_SERVICE_SQL,
} = require("./account-self-service-schema");
const EXPORT_NAMES = Object.keys(ACCOUNT_EXPORT_QUERIES);
/** @param {string} name */
const statementName = (name) => `accountExport${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/** @param {string} userId @param {Array<{rows?:any[],columns?:string[]}>} results @param {(row:unknown,columns?:string[])=>any} plainRow */
function exportRows(userId, results, plainRow) {
  /** @type {Record<string,any>} */
  const output = {};
  for (let index = 0; index < EXPORT_NAMES.length; index += 1) {
    const name = EXPORT_NAMES[index];
    if (!name) continue;
    const result = results[index],
      rows = (result?.rows || []).map((row) => plainRow(row, result?.columns));
    output[name] = ACCOUNT_EXPORT_SINGLE_ROWS.has(name) ? rows[0] || null : rows;
  }
  output.workouts = [];
  return output.profile?.id === userId
    ? /** @type {import("./domain-types").AccountExportStoreRows} */ (output)
    : null;
}

/**
 * @param {import("./domain-types").LocalAccountSelfServiceStoreDependencies} dependencies
 * @returns {import("./domain-types").AccountSelfServiceStore}
 */
function createLocalAccountSelfServiceMethods({ db, statements, plainRow }) {
  /** @param {string} name */
  function statement(name) {
    const prepared = statements[name];
    if (!prepared) throw new Error(`Missing account statement: ${name}`);
    return prepared;
  }
  return {
    async accountSessions(userId, currentTokenHash, now) {
      return statement("accountSessions")
        .all(userId, now, currentTokenHash)
        .map((row) => plainRow(row));
    },
    async revokeAccountSession(userId, targetTokenHash, currentTokenHash, now) {
      return Boolean(
        plainRow(
          statement("revokeAccountSession").get(
            userId,
            targetTokenHash,
            currentTokenHash,
            now,
            userId,
            currentTokenHash,
            now,
          ),
        ),
      );
    },
    async revokeOtherAccountSessions(userId, currentTokenHash, now) {
      return statement("revokeOtherAccountSessions").all(
        userId,
        currentTokenHash,
        now,
        userId,
        currentTokenHash,
        now,
      ).length;
    },
    async accountExport(userId) {
      let open = false;
      try {
        db.exec("BEGIN");
        open = true;
        const results = EXPORT_NAMES.map((name) => ({
          rows: statement(statementName(name)).all(userId),
        }));
        db.exec("COMMIT");
        open = false;
        return exportRows(userId, results, plainRow);
      } catch (error) {
        if (open)
          try {
            db.exec("ROLLBACK");
          } catch {
            /* Preserve the original export error. */
          }
        throw error;
      }
    },
    async accountExportWorkouts(userId, afterStartedAt, afterId, limit) {
      return statement("accountExportWorkouts")
        .all(userId, afterStartedAt, afterStartedAt, afterId, limit)
        .map((row) => plainRow(row));
    },
  };
}

/**
 * @param {import("./domain-types").TursoAccountSelfServiceStoreDependencies} dependencies
 * @returns {import("./domain-types").AccountSelfServiceStore}
 */
function createTursoAccountSelfServiceMethods({ client, run, all, plainRow }) {
  const sql = /** @type {Record<string,string>} */ (ACCOUNT_SELF_SERVICE_SQL);
  /** @param {string} name */
  function exportSql(name) {
    const query = sql[statementName(name)];
    if (!query) throw new Error(`Missing account export query: ${name}`);
    return query;
  }
  return {
    accountSessions: (userId, currentTokenHash, now) =>
      all(ACCOUNT_SELF_SERVICE_SQL.accountSessions, [userId, now, currentTokenHash]),
    async revokeAccountSession(userId, targetTokenHash, currentTokenHash, now) {
      const result = await run(ACCOUNT_SELF_SERVICE_SQL.revokeAccountSession, [
        userId,
        targetTokenHash,
        currentTokenHash,
        now,
        userId,
        currentTokenHash,
        now,
      ]);
      return Boolean(plainRow(result.rows?.[0], result.columns));
    },
    async revokeOtherAccountSessions(userId, currentTokenHash, now) {
      const result = await run(ACCOUNT_SELF_SERVICE_SQL.revokeOtherAccountSessions, [
        userId,
        currentTokenHash,
        now,
        userId,
        currentTokenHash,
        now,
      ]);
      return (result.rows || []).length;
    },
    async accountExport(userId) {
      const results = await client.batch(
        EXPORT_NAMES.map((name) => ({ sql: exportSql(name), args: [userId] })),
        "read",
      );
      return exportRows(userId, results, plainRow);
    },
    accountExportWorkouts: (userId, afterStartedAt, afterId, limit) =>
      all(ACCOUNT_SELF_SERVICE_SQL.accountExportWorkouts, [
        userId,
        afterStartedAt,
        afterStartedAt,
        afterId,
        limit,
      ]),
  };
}

module.exports = {
  createLocalAccountSelfServiceMethods,
  createTursoAccountSelfServiceMethods,
  exportRows,
};
