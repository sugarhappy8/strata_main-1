// @ts-check
"use strict";

// Sign in with Google or Apple. An identity links one provider account (its stable subject) to one STRATA
// account. A sign-in state lives for ten minutes between leaving for the provider and coming back. Deleting a user
// queues any sealed Apple token for revocation inside the same delete, so every deletion path (emailed link, in-app,
// and Admin) revokes Sign in with Apple without each caller remembering to.

const PROVIDERS="'google','apple'";

const SOCIAL_AUTH_SCHEMA=Object.freeze([
  `CREATE TABLE IF NOT EXISTS account_identities (
    provider TEXT NOT NULL CHECK(provider IN (${PROVIDERS})),
    subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 255),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_sealed TEXT,
    linked_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY(provider,subject),
    UNIQUE(user_id,provider)
  )`,
  `CREATE TABLE IF NOT EXISTS social_sign_in_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN (${PROVIDERS})),
    browser_hash TEXT NOT NULL,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    intent TEXT NOT NULL CHECK(intent IN ('signup','login')),
    next_path TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code TEXT,
    profile_name TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    returned_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS sign_in_revocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK(provider IN (${PROVIDERS})),
    token_sealed TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0)
  )`,
  // Recreate this trigger on startup so older databases pick up the current cascade.
  "DROP TRIGGER IF EXISTS account_identities_on_user_delete",
  `CREATE TRIGGER account_identities_on_user_delete
    BEFORE DELETE ON users
    BEGIN
      INSERT INTO sign_in_revocations(provider,token_sealed,queued_at)
        SELECT provider,token_sealed,CAST(strftime('%s','now') AS INTEGER)*1000 FROM account_identities WHERE user_id=OLD.id AND token_sealed IS NOT NULL;
      DELETE FROM account_identities WHERE user_id=OLD.id;
    END`
]);

const ACCOUNT="u.id,u.name,u.email,u.created_at,u.email_verified_at,u.auth_version,u.suspended_at";
const STATE="provider,nonce,code_verifier,intent,next_path,redirect_uri,code,profile_name";

const SOCIAL_AUTH_SQL=Object.freeze({
  insertSocialSignInState:"INSERT INTO social_sign_in_states(state_hash,provider,browser_hash,nonce,code_verifier,intent,next_path,redirect_uri,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING state_hash",
  recordSocialSignInReturn:"UPDATE social_sign_in_states SET code=?,profile_name=?,returned_at=? WHERE state_hash=? AND provider=? AND returned_at IS NULL AND expires_at>? RETURNING intent,next_path",
  discardSocialSignInState:"DELETE FROM social_sign_in_states WHERE state_hash=? RETURNING intent,next_path",
  // Deleting is consuming: a state can finish one sign-in, from the browser that started it, and only once.
  consumeSocialSignInState:`DELETE FROM social_sign_in_states WHERE state_hash=? AND browser_hash=? AND returned_at IS NOT NULL AND expires_at>? RETURNING ${STATE}`,
  deleteExpiredSocialSignInStates:"DELETE FROM social_sign_in_states WHERE expires_at<?",
  accountIdentity:`SELECT i.provider,i.subject,i.email AS identity_email,${ACCOUNT} FROM account_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?`,
  accountIdentities:"SELECT provider,email,token_sealed,linked_at,last_used_at FROM account_identities WHERE user_id=? ORDER BY linked_at,provider",
  accountSignInMethods:"SELECT u.password_hash<>'' AS has_password,(SELECT group_concat(i.provider) FROM account_identities i WHERE i.user_id=u.id) AS providers FROM users u WHERE u.id=?",
  // Only a verified, active account can gain a sign-in; a second account of the same provider is refused.
  linkAccountIdentity:`INSERT INTO account_identities(provider,subject,user_id,email,token_sealed,linked_at,last_used_at) SELECT ?,?,u.id,?,?,?,? FROM users u WHERE u.id=? AND u.email_verified_at IS NOT NULL AND u.suspended_at IS NULL ON CONFLICT DO NOTHING RETURNING provider`,
  touchAccountIdentity:"UPDATE account_identities SET email=?,token_sealed=COALESCE(?,token_sealed),last_used_at=? WHERE provider=? AND subject=? AND user_id=? RETURNING provider",
  // A provider account has no STRATA password; the empty hash can never match a scrypt result.
  insertSocialUser:"INSERT INTO users(id,name,email,password_hash,password_salt,created_at,email_verified_at) VALUES(?,?,?,'','',?,?) RETURNING id,name,email,created_at,email_verified_at,auth_version,suspended_at",
  insertAccountIdentity:"INSERT INTO account_identities(provider,subject,user_id,email,token_sealed,linked_at,last_used_at) VALUES(?,?,?,?,?,?,?)",
  pendingSignInRevocations:"SELECT id,provider,token_sealed,queued_at,attempts FROM sign_in_revocations ORDER BY id LIMIT ?",
  completeSignInRevocation:"DELETE FROM sign_in_revocations WHERE id=?",
  retrySignInRevocation:"UPDATE sign_in_revocations SET attempts=attempts+1 WHERE id=?",
  // Give up after a week or ten tries; the member can still remove STRATA in their Apple Account settings.
  deleteStaleSignInRevocations:"DELETE FROM sign_in_revocations WHERE queued_at<? OR attempts>=10"
});

module.exports={SOCIAL_AUTH_SCHEMA,SOCIAL_AUTH_SQL};
