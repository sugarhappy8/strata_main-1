"use strict";

/** @param {import('./domain-types').AdminControlsRow|null|undefined} row @param {number} [now] */
function adminGrantState(row, now = Date.now()) {
  const startedAt = row?.grant_starts_at == null ? null : Number(row.grant_starts_at);
  const expiresAt = row?.grant_expires_at == null ? null : Number(row.grant_expires_at);
  const revokedAt = row?.grant_revoked_at == null ? null : Number(row.grant_revoked_at);
  const active =
    startedAt !== null &&
    Number.isSafeInteger(startedAt) &&
    startedAt <= now &&
    revokedAt === null &&
    (expiresAt === null ||
      (Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt > startedAt));
  return { active, startedAt, expiresAt, revokedAt };
}
/** @param {unknown} input @param {number} [now] @returns {number|null} */
function grantExpiry(input, now = Date.now()) {
  const value = /** @type {{unit?:unknown;amount?:unknown;expiresAt?:unknown}} */ (input || {});
  const invalid = () =>
    Object.assign(new Error("Choose a positive whole duration or a valid future expiry date."), {
      status: 400,
      code: "INVALID_GRANT_DURATION",
    });
  if (value.unit === "indefinite") return null;
  if (value.unit === "until") {
    const expiry = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
    if (
      !Number.isSafeInteger(expiry) ||
      expiry <= now ||
      expiry > Date.UTC(9999, 11, 31, 23, 59, 59)
    )
      throw invalid();
    return expiry;
  }
  const amount = Number(value.amount),
    unit = String(value.unit || "");
  if (
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > 10_000_000
  )
    throw invalid();
  const fixed = /** @type {Record<string,number>} */ ({
    minutes: 60000,
    hours: 3600000,
    days: 86400000,
    weeks: 604800000,
  });
  let expiry;
  if (fixed[unit]) expiry = now + amount * fixed[unit];
  else if (unit === "months" || unit === "years") {
    const date = new Date(now),
      day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + amount * (unit === "years" ? 12 : 1));
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
    expiry = date.getTime();
  } else throw invalid();
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > Date.UTC(9999, 11, 31, 23, 59, 59))
    throw invalid();
  return expiry;
}
module.exports = { adminGrantState, grantExpiry };
