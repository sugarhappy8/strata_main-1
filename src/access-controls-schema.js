"use strict";
const ADMIN_CONTROLS_TABLE = `CREATE TABLE IF NOT EXISTS admin_account_controls (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  grant_starts_at INTEGER,
  grant_expires_at INTEGER,
  grant_revoked_at INTEGER,
  checkout_blocked_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at INTEGER NOT NULL,
  CHECK(grant_expires_at IS NULL OR (grant_starts_at IS NOT NULL AND grant_expires_at>grant_starts_at))
)`;
const ADMIN_ACTOR_VALID = `EXISTS (SELECT 1 FROM admin_principal ap JOIN users actor ON actor.id=ap.user_id JOIN sessions s ON s.user_id=actor.id AND s.auth_version=actor.auth_version WHERE ap.slot='primary' AND ap.user_id=? AND ap.configured_email=actor.email COLLATE NOCASE AND actor.email_verified_at IS NOT NULL AND actor.suspended_at IS NULL AND s.token_hash=? AND s.expires_at>?)`;
/** @param {string} alias @param {string} [clock] */
function activeGrant(alias, clock = "(SELECT now FROM entitlement_clock)") {
  return `${alias}.grant_starts_at IS NOT NULL AND ${alias}.grant_starts_at<=${clock} AND ${alias}.grant_revoked_at IS NULL AND (${alias}.grant_expires_at IS NULL OR ${alias}.grant_expires_at>${clock})`;
}
const CONTROL_COLUMNS =
  "ac.grant_starts_at,ac.grant_expires_at,ac.grant_revoked_at,ac.checkout_blocked_at,COALESCE(ac.revision,0) AS controls_revision";
const ACCESS_CONTROLS_SQL = {
  adminControls: "SELECT * FROM admin_account_controls WHERE user_id=?",
  activeAdminGrant: `SELECT user_id FROM admin_account_controls WHERE user_id=? AND ${activeGrant("admin_account_controls", "?")}`,
  deleteAdminControlsForDeletedUser:
    "DELETE FROM admin_account_controls WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM users WHERE id=?)",
  writeAdminControls: `INSERT INTO admin_account_controls(user_id,grant_starts_at,grant_expires_at,grant_revoked_at,checkout_blocked_at,revision,updated_at) SELECT u.id,?,?,?,?,1,? FROM users u WHERE u.id=? AND ${ADMIN_ACTOR_VALID} AND COALESCE((SELECT revision FROM admin_account_controls WHERE user_id=u.id),0)=? ON CONFLICT(user_id) DO UPDATE SET grant_starts_at=excluded.grant_starts_at,grant_expires_at=excluded.grant_expires_at,grant_revoked_at=excluded.grant_revoked_at,checkout_blocked_at=excluded.checkout_blocked_at,revision=admin_account_controls.revision+1,updated_at=excluded.updated_at RETURNING *`,
};
module.exports = {
  ADMIN_CONTROLS_TABLE,
  ADMIN_ACTOR_VALID,
  CONTROL_COLUMNS,
  activeGrant,
  ACCESS_CONTROLS_SQL,
};
