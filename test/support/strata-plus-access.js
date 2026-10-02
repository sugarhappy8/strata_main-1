"use strict";
// Strata+ no longer has a free trial, so tests give an account access the way
// the owner does: a complimentary grant, written straight to the local SQLite
// database that the test server is using.
const { DatabaseSync } = require("node:sqlite");
const { join } = require("node:path");

function openDatabase(dataDir) {
  return new DatabaseSync(join(dataDir, "strata.sqlite"), {
    timeout: 5000,
    enableForeignKeyConstraints: true,
  });
}

function grantStrataPlus(dataDir, userId, { startsAt = Date.now() - 1000, expiresAt = null } = {}) {
  const database = openDatabase(dataDir);
  try {
    const result = database
      .prepare(
        `INSERT INTO admin_account_controls(user_id,grant_starts_at,grant_expires_at,grant_revoked_at,checkout_blocked_at,revision,updated_at)
      SELECT id,?,?,NULL,NULL,1,? FROM users WHERE id=?
      ON CONFLICT(user_id) DO UPDATE SET grant_starts_at=excluded.grant_starts_at,grant_expires_at=excluded.grant_expires_at,grant_revoked_at=NULL,revision=admin_account_controls.revision+1,updated_at=excluded.updated_at`,
      )
      .run(startsAt, expiresAt, startsAt, userId);
    if (Number(result.changes) !== 1) throw new Error(`No account ${userId} to grant Strata+ to.`);
  } finally {
    database.close();
  }
}

module.exports = { grantStrataPlus };
