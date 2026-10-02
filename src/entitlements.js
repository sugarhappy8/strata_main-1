// @ts-check
"use strict";

/**
 * One place that says what a member may use. Free covers the rankings, the
 * weekly planner, the basic profile, and the account itself. Strata+ covers
 * the studio and everything inside it. Every route and every page asks
 * `can(user,feature)` instead of reading billing state, so moving a feature
 * between tiers is a one-line change here. `STRATA_AI_TIER` is the owner's
 * switch for Strata AI: "plus" (default) keeps it inside Strata+, "off"
 * hides it for everyone without touching a route.
 */
const FREE = "free",
  PLUS = "plus",
  OFF = "off";

/** @type {Readonly<Record<string,"free"|"plus">>} */
const FEATURES = Object.freeze({
  rankings: FREE,
  "plan.week": FREE,
  "profile.basic": FREE,
  account: FREE,
  "plus.studio": PLUS,
  "plus.train": PLUS,
  "plus.nutrition": PLUS,
  "plus.recovery": PLUS,
  "plus.progress": PLUS,
  "plus.library": PLUS,
  "plus.compare": PLUS,
  "plus.ai": PLUS,
});

/** @param {Record<string,string|undefined>} [env] */
function entitlementSettings(env = {}) {
  const aiTier = String(env.STRATA_AI_TIER || PLUS)
    .trim()
    .toLowerCase();
  return Object.freeze({ aiTier: aiTier === OFF ? OFF : PLUS });
}

/**
 * @param {string} feature
 * @param {{aiTier:string}} [settings]
 * @returns {"free"|"plus"|"off"|null}
 */
function tierFor(feature, settings = entitlementSettings()) {
  if (!Object.hasOwn(FEATURES, feature)) return null;
  if (feature === "plus.ai" && settings.aiTier === OFF) return OFF;
  return FEATURES[feature];
}

/**
 * The capability map travels inside `/api/me` so the browser never recomputes
 * tier rules. Unknown features are absent, so `can()` answers false for them.
 * @param {{plusActive?:boolean}} [access]
 * @param {{aiTier:string}} [settings]
 * @returns {Readonly<Record<string,boolean>>}
 */
function capabilitiesFor({ plusActive = false } = {}, settings = entitlementSettings()) {
  /** @type {Record<string,boolean>} */
  const capabilities = {};
  for (const feature of Object.keys(FEATURES)) {
    const tier = tierFor(feature, settings);
    capabilities[feature] = tier === FREE || (tier === PLUS && plusActive === true);
  }
  return Object.freeze(capabilities);
}

/** @param {{capabilities?:Record<string,boolean>|null}|null|undefined} user @param {string} feature */
function can(user, feature) {
  return user?.capabilities?.[feature] === true;
}

module.exports = { FEATURES, entitlementSettings, tierFor, capabilitiesFor, can };
