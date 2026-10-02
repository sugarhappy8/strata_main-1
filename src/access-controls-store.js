"use strict";
const { ACCESS_CONTROLS_SQL } = require("./access-controls-schema");
function mutationArgs(userId, row, revision, token, audit) {
  if (
    !audit ||
    audit.targetUserId !== userId ||
    !["grant-plus", "revoke-plus", "close-checkouts", "enable-checkouts"].includes(audit.action)
  )
    throw new TypeError("Access controls require a matching audit event.");
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new TypeError("Access controls require a revision.");
  return [
    row.grant_starts_at ?? null,
    row.grant_expires_at ?? null,
    row.grant_revoked_at ?? null,
    row.checkout_blocked_at ?? null,
    audit.createdAt,
    userId,
    audit.actorUserId,
    token,
    audit.createdAt,
    revision,
  ];
}
function auditArgs(audit) {
  return [
    audit.id,
    audit.actorUserId,
    audit.targetUserId,
    audit.action,
    audit.reason,
    audit.result,
    audit.createdAt,
  ];
}
function createLocalAccessControlMethods({ db, statements, plainRow }) {
  return {
    async adminControls(userId) {
      return plainRow(statements.adminControls.get(userId));
    },
    async writeAdminControls(userId, row, revision, token, audit) {
      const args = mutationArgs(userId, row, revision, token, audit);
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = plainRow(statements.writeAdminControls.get(...args));
        if (result && !statements.insertAdminAuditIfChanged.get(...auditArgs(audit)))
          throw new Error("Access-control audit was not recorded.");
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
function createTursoAccessControlMethods({ client, first, plainRow, SQL }) {
  return {
    adminControls: (userId) => first(ACCESS_CONTROLS_SQL.adminControls, [userId]),
    async writeAdminControls(userId, row, revision, token, audit) {
      const args = mutationArgs(userId, row, revision, token, audit);
      const results = await client.batch(
        [
          { sql: ACCESS_CONTROLS_SQL.writeAdminControls, args },
          { sql: SQL.insertAdminAuditIfChanged, args: auditArgs(audit) },
        ],
        "write",
      );
      const result = plainRow(results[0]?.rows?.[0], results[0]?.columns);
      if (result && !plainRow(results[1]?.rows?.[0], results[1]?.columns))
        throw new Error("Access-control audit was not recorded.");
      return result;
    },
  };
}
module.exports = { createLocalAccessControlMethods, createTursoAccessControlMethods };
