"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const { adminGrantState, grantExpiry } = require("../src/access-controls");
const W = require("../public/scripts/workout-core");
test("complimentary grants honor exact expiry, revocation, future starts and indefinite access", () => {
  const now = Date.UTC(2026, 8, 10),
    row = { grant_starts_at: now - 100, grant_expires_at: now + 100, grant_revoked_at: null };
  assert.equal(adminGrantState(row, now).active, true);
  assert.equal(adminGrantState(row, now + 100).active, false);
  assert.equal(adminGrantState({ ...row, grant_revoked_at: now }, now).active, false);
  assert.equal(adminGrantState({ ...row, grant_starts_at: now + 1 }, now).active, false);
  assert.equal(adminGrantState({ ...row, grant_expires_at: null }, now + 1e9).active, true);
  assert.equal(adminGrantState(null, now).active, false);
  for (const expiry of [now, now - 1, "bad", undefined])
    assert.equal(
      W.offlineAccessUntil(
        { active: true, accessType: "grant", adminGrant: { active: true, expiresAt: expiry } },
        now,
      ),
      0,
    );
  assert.equal(
    W.offlineAccessUntil(
      { active: true, accessType: "grant", adminGrant: { active: true, expiresAt: now + 100 } },
      now,
    ),
    now + 100,
  );
  assert.equal(
    W.offlineAccessUntil(
      { active: true, accessType: "grant", adminGrant: { active: true, expiresAt: null } },
      now,
    ),
    now + 86400000,
  );
  assert.equal(
    W.offlineAccessUntil(
      { active: true, accessType: "grant", adminGrant: { active: false, expiresAt: null } },
      now,
    ),
    0,
  );
});
test("grant durations support calendar month ends and reject malformed or past values", () => {
  const now = Date.UTC(2028, 0, 31, 12);
  for (const [unit, multiplier] of Object.entries({
    minutes: 60000,
    hours: 3600000,
    days: 86400000,
    weeks: 604800000,
  }))
    assert.equal(grantExpiry({ unit, amount: 2 }, now), now + 2 * multiplier);
  assert.equal(grantExpiry({ unit: "months", amount: 1 }, now), Date.UTC(2028, 1, 29, 12));
  assert.equal(
    grantExpiry({ unit: "years", amount: 1 }, Date.UTC(2028, 1, 29)),
    Date.UTC(2029, 1, 28),
  );
  assert.equal(grantExpiry({ unit: "indefinite" }, now), null);
  assert.equal(
    grantExpiry({ unit: "until", expiresAt: "2030-01-01T00:00:00Z" }, now),
    Date.UTC(2030, 0, 1),
  );
  for (const value of [
    null,
    {},
    { unit: "days", amount: true },
    { unit: "days", amount: "2" },
    { unit: "days", amount: 0 },
    { unit: "days", amount: -1 },
    { unit: "days", amount: 0.5 },
    { unit: "years", amount: 9999999 },
    { unit: "never", amount: 1 },
    { unit: "until", expiresAt: "bad" },
    { unit: "until", expiresAt: new Date(now).toISOString() },
  ])
    assert.throws(() => grantExpiry(value, now), { code: "INVALID_GRANT_DURATION" });
});
