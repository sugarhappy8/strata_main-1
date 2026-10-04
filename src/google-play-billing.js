// @ts-check
"use strict";

// Strata+ bought in the STRATA Android app through Google Play Billing. The app sends each purchase token to STRATA,
// which reads the subscription from Google Play (src/google-play-api.js), checks that it is Strata+ for this app and was
// bought by the signed-in account (Play carries the STRATA user id as obfuscatedExternalAccountId), stores Google's
// state, and acknowledges it. Google Play stays the source of truth: a Real-time developer notification only says
// which token changed, so it is answered by reading that token again, and a background refresh re-reads subscriptions
// near their expiry, not acknowledged yet, or not checked for a day. Test purchases (Play's license testers) unlock
// Strata+ in production only for the accounts in GOOGLE_PLAY_TEST_ACCOUNTS, as Sandbox purchases do for Apple.
const { timingSafeEqual } = require("node:crypto");
const { MAX_WEBHOOK_BYTES, bodyBuffer } = require("./http");
const { parseServiceAccount } = require("./google-play-api");

const DEFAULT_PACKAGE_NAME = "online.stratafitness.app";
const DEFAULT_PRODUCT_IDS = Object.freeze(["online.stratafitness.app.plus"]);
const MANAGE_SUBSCRIPTIONS_URL = "https://play.google.com/store/account/subscriptions";
const DELETION_NOTICE =
  "Deleting your STRATA account does not cancel a Strata+ subscription bought through Google Play. Google keeps billing your Google Account until you cancel it in Google Play › Payments & subscriptions › Subscriptions.";
const MAX_PURCHASES = 20;
const PURCHASE_REQUESTS_PER_WINDOW = 30;
const NOTIFICATIONS_PER_WINDOW = 600;
const MAX_PURCHASE_TOKEN = 1024;
// Renewal reaches STRATA by notification or by the refresh below; until then an active, auto-renewing subscription keeps
// Strata+ for a short while past the expiry STRATA last saw, so a renewal never shows as a lapse.
const RENEWAL_MARGIN_MS = 2 * 60 * 60 * 1000;
const REFRESH_AHEAD_MS = 60 * 60 * 1000;
const RECHECK_MS = 24 * 60 * 60 * 1000;
const REFRESH_BATCH = 25;
// A subscription Google keeps failing on waits longer before the next try (30 minutes, doubling up to a day), so it
// never holds up the others in the oldest-first queue.
const RETRY_FIRST_MS = 30 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;
const RETRY_TRACKED = 1000;
const STORE_IDENTIFIER = /^[a-z0-9][a-z0-9._]{0,149}$/;
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const BASE_PLAN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Google's subscriptionState, stored without its prefix.
const STATES = new Set([
  "PENDING",
  "ACTIVE",
  "PAUSED",
  "IN_GRACE_PERIOD",
  "ON_HOLD",
  "CANCELED",
  "EXPIRED",
  "PENDING_PURCHASE_CANCELED",
]);
// Entitled while paid through a future expiry: active, in its grace period (Google extends the expiry), or canceled but
// not yet run out. Paused, on hold, pending, and expired subscriptions are not.
const ENTITLED_STATES = new Set(["ACTIVE", "IN_GRACE_PERIOD", "CANCELED"]);
const ENDED_STATES = new Set(["EXPIRED", "PENDING_PURCHASE_CANCELED"]);

/**
 * A base plan whose id names a year ("yearly", "annual") is the yearly plan; every other one monthly.
 * @param {unknown} basePlanId @returns {"monthly"|"yearly"}
 */
function googlePlayPlan(basePlanId) {
  return /year|annual/i.test(String(basePlanId || "")) ? "yearly" : "monthly";
}

/** @param {string} message @param {number} status @param {string} code */
function playError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

/** @param {unknown} value @returns {number|null} */
function time(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** @param {unknown} value @param {number} max */
function text(value, max) {
  return typeof value === "string" && value && value.length <= max && !/[\s\0]/.test(value)
    ? value
    : null;
}

/**
 * Google Play settings from the environment. Purchases can be checked once GOOGLE_PLAY_SERVICE_ACCOUNT holds the Play
 * Console service account's key; without it the routes answer that Google Play is not set up.
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {import("./domain-types").GooglePlayBillingSettings}
 */
function googlePlayBillingSettings(environment = process.env) {
  const packageName =
    String(environment.GOOGLE_PLAY_PACKAGE_NAME || "").trim() || DEFAULT_PACKAGE_NAME;
  const listed = [
    ...new Set(
      String(environment.GOOGLE_PLAY_PRODUCT_IDS || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  const productIds = listed.length ? listed : [...DEFAULT_PRODUCT_IDS];
  if (!PACKAGE_NAME.test(packageName) || productIds.some((id) => !STORE_IDENTIFIER.test(id)))
    throw new TypeError(
      "GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_PLAY_PRODUCT_IDS must be Google Play identifiers.",
    );
  const notificationToken = String(environment.GOOGLE_PLAY_NOTIFICATION_TOKEN || "").trim();
  if (notificationToken && !/^[A-Za-z0-9_-]{32,256}$/.test(notificationToken))
    throw new TypeError(
      "GOOGLE_PLAY_NOTIFICATION_TOKEN must be 32 to 256 letters, digits, - or _.",
    );
  const serviceAccount = parseServiceAccount(environment.GOOGLE_PLAY_SERVICE_ACCOUNT);
  return Object.freeze({
    packageName,
    productIds: Object.freeze(productIds),
    serviceAccount,
    configured: serviceAccount !== null,
    notificationToken,
    allowTestPurchases: environment.NODE_ENV !== "production",
    testAccounts: new Set(
      String(environment.GOOGLE_PLAY_TEST_ACCOUNTS || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  });
}

/**
 * Google's SubscriptionPurchaseV2 for one purchase token, as STRATA keeps it, when it is a Strata+ subscription.
 * @param {Record<string,any>} data @param {string} purchaseToken
 * @param {import("./domain-types").GooglePlayBillingSettings} settings
 * @returns {{ok:true,purchase:import("./domain-types").GooglePlayPurchase}|{ok:false,reason:string}}
 */
function validateGooglePlaySubscription(data, purchaseToken, settings) {
  const items = Array.isArray(data?.lineItems) ? data.lineItems : [];
  const item = items.find(
    (line) => typeof line?.productId === "string" && settings.productIds.includes(line.productId),
  );
  if (!item) return { ok: false, reason: "product" };
  const state = String(data.subscriptionState || "").replace(/^SUBSCRIPTION_STATE_/, "");
  if (!STATES.has(state)) return { ok: false, reason: "state" };
  const basePlanId = text(item.offerDetails?.basePlanId, 63);
  const account = String(data.externalAccountIdentifiers?.obfuscatedExternalAccountId || "")
    .trim()
    .toLowerCase();
  const renewing = item.autoRenewingPlan;
  return {
    ok: true,
    purchase: {
      purchaseToken,
      productId: item.productId,
      basePlanId: basePlanId && BASE_PLAN.test(basePlanId) ? basePlanId : null,
      state,
      testPurchase: data.testPurchase !== undefined && data.testPurchase !== null,
      linkedPurchaseToken: text(data.linkedPurchaseToken, MAX_PURCHASE_TOKEN),
      latestOrderId: text(data.latestOrderId ?? item.latestSuccessfulOrderId, 200),
      startedAt: time(data.startTime),
      expiresAt: time(item.expiryTime),
      autoRenew:
        renewing && typeof renewing === "object" ? renewing.autoRenewEnabled === true : null,
      acknowledged: data.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      accountId: UUID.test(account) ? account : null,
    },
  };
}

/**
 * Whether a stored subscription is paid up now. With an account and settings it also answers whether it unlocks
 * Strata+ for that account: a test purchase does so in production only for a listed account with a verified email.
 * @param {import("./domain-types").GooglePlaySubscriptionRow} row @param {number} now
 * @param {{email?:string|null,emailVerified?:boolean}|null} [user] @param {import("./domain-types").GooglePlayTestPolicy|null} [settings]
 */
function googlePlayRowActive(row, now, user = null, settings = null) {
  const listed =
    user?.emailVerified === true &&
    Boolean(settings?.testAccounts.has(String(user?.email || "").toLowerCase()));
  if (Number(row.test_purchase) === 1 && settings && !settings.allowTestPurchases && !listed)
    return false;
  const expires = Number(row.expires_at || 0);
  return (
    ENTITLED_STATES.has(String(row.state)) &&
    (expires > now ||
      (row.state === "ACTIVE" && Number(row.auto_renew) === 1 && expires + RENEWAL_MARGIN_MS > now))
  );
}

/**
 * The member-facing summary for /api/me "discovery.googlePlay": the subscription giving access, else the latest one.
 * @param {import("./domain-types").GooglePlaySubscriptionRow[]} rows @param {number} now
 * @param {{email?:string|null,emailVerified?:boolean}|null} [user] @param {import("./domain-types").GooglePlayTestPolicy|null} [settings]
 * @returns {import("./domain-types").GooglePlaySubscriptionSummary|null}
 */
function googlePlaySubscriptionSummary(rows, now, user = null, settings = null) {
  /** @param {import("./domain-types").GooglePlaySubscriptionRow} row */
  const active = (row) => googlePlayRowActive(row, now, user, settings);
  /** @param {import("./domain-types").GooglePlaySubscriptionRow} row */
  const open = (row) => !ENDED_STATES.has(String(row.state));
  // The subscription giving access, else one still in progress (pending, on hold, paused), else the latest that ended.
  const row = [...rows].sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      Number(open(b)) - Number(open(a)) ||
      Number(b.expires_at || 0) - Number(a.expires_at || 0) ||
      Number(b.updated_at) - Number(a.updated_at),
  )[0];
  if (!row) return null;
  const state = String(row.state);
  return {
    active: active(row),
    productId: String(row.product_id),
    plan: googlePlayPlan(row.base_plan_id),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    autoRenew: row.auto_renew == null ? null : Number(row.auto_renew) === 1,
    state: /** @type {import("./domain-types").GooglePlayState} */ (state),
    inGracePeriod: state === "IN_GRACE_PERIOD",
    onHold: state === "ON_HOLD",
    paused: state === "PAUSED",
    pending: state === "PENDING",
    testPurchase: Number(row.test_purchase) === 1,
  };
}

/**
 * @param {import("./domain-types").GooglePlayPurchase} purchase
 * @param {{userId:string,checkedAt:number,now:number,existing:import("./domain-types").GooglePlaySubscriptionRow|null}} input
 * @returns {import("./domain-types").GooglePlaySubscriptionWrite}
 */
function googlePlayRecord(purchase, { userId, checkedAt, now, existing }) {
  return {
    purchaseToken: purchase.purchaseToken,
    userId,
    productId: purchase.productId,
    basePlanId: purchase.basePlanId,
    state: purchase.state,
    testPurchase: purchase.testPurchase,
    linkedPurchaseToken: purchase.linkedPurchaseToken,
    latestOrderId: purchase.latestOrderId,
    startedAt: purchase.startedAt,
    expiresAt: purchase.expiresAt,
    autoRenew: purchase.autoRenew,
    acknowledged: purchase.acknowledged || Number(existing?.acknowledged) === 1,
    checkedAt,
    createdAt: existing ? Number(existing.created_at) : now,
    updatedAt: now,
  };
}

/** @param {string} supplied @param {string} expected */
function sameSecret(supplied, expected) {
  const a = Buffer.from(String(supplied)),
    b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {import("./domain-types").GooglePlayBillingServiceDependencies} dependencies
 * @returns {import("./domain-types").GooglePlayBillingService}
 */
function createGooglePlayBillingService({
  store,
  settings,
  api,
  getUserPayload,
  rateAllowed,
  http,
  logger,
  now = Date.now,
}) {
  if (
    !store ||
    !settings ||
    typeof getUserPayload !== "function" ||
    !rateAllowed ||
    !http ||
    !logger
  )
    throw new TypeError(
      "Google Play billing requires storage, settings, account policy, request guards, HTTP helpers, and a logger.",
    );
  const { json } = http;

  function requireApi() {
    if (!api || !settings.configured)
      throw playError(
        "Google Play purchases can't be checked right now. Try again later.",
        503,
        "GOOGLE_PLAY_NOT_CONFIGURED",
      );
    return api;
  }

  /** @param {import("./domain-types").HttpRequest} req @returns {Promise<Record<string,any>>} */
  async function readJson(req) {
    const raw = await bodyBuffer(req, MAX_WEBHOOK_BYTES);
    try {
      const value = JSON.parse(raw.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      /* Reported below as an invalid body. */
    }
    throw playError("Invalid JSON.", 400, "INVALID_JSON");
  }

  /** Google's current answer for a token, checked against this app's Strata+ products. @param {string} purchaseToken */
  async function lookup(purchaseToken) {
    const checkedAt = now();
    let data;
    try {
      data = await requireApi().subscription(settings.packageName, purchaseToken);
    } catch (error) {
      // A refused service account (GOOGLE_PLAY_NOT_CONFIGURED) or an outage would otherwise show only as a 503.
      logger.warn("google_play.lookup_failed", {
        code: String(/** @type {any} */ (error)?.code || "UNKNOWN"),
      });
      throw error;
    }
    const result = validateGooglePlaySubscription(data, purchaseToken, settings);
    if (!result.ok)
      throw playError(
        "This Google Play purchase is not a Strata+ subscription for this app.",
        400,
        "GOOGLE_PLAY_PURCHASE_INVALID",
      );
    return { purchase: result.purchase, checkedAt };
  }

  // A subscription stays with the account that bought it. It moves only once it no longer grants access and the
  // account Google names is another one (a new purchase on the same token after a long lapse never happens on Play,
  // but a resubscription carries the old token as linkedPurchaseToken).
  /** @param {import("./domain-types").GooglePlaySubscriptionRow|null} existing @param {string} userId */
  function ownership(existing, userId) {
    if (!existing || existing.user_id === userId) return { allowed: true, replaceOwnerId: null };
    return googlePlayRowActive(existing, now())
      ? { allowed: false, replaceOwnerId: null }
      : { allowed: true, replaceOwnerId: existing.user_id };
  }

  /**
   * Stores Google's answer, unless an answer read later is already stored. @returns {Promise<"applied"|"stale"|"conflict">}
   * @param {import("./domain-types").GooglePlayPurchase} purchase @param {string} userId @param {number} checkedAt
   */
  async function apply(purchase, userId, checkedAt) {
    const existing = await store.googlePlaySubscription(purchase.purchaseToken);
    const owner = ownership(existing, userId);
    if (!owner.allowed) return "conflict";
    const record = googlePlayRecord(purchase, { userId, checkedAt, now: now(), existing });
    if (await store.upsertGooglePlaySubscription(record, owner.replaceOwnerId)) return "applied";
    const stored = await store.googlePlaySubscription(purchase.purchaseToken);
    return stored && stored.user_id !== userId ? "conflict" : "stale";
  }

  // Google refunds a purchase that is not acknowledged within three days. A failure here is retried by refreshDue.
  /** @param {import("./domain-types").GooglePlayPurchase} purchase */
  async function acknowledge(purchase) {
    if (purchase.acknowledged || !ENTITLED_STATES.has(purchase.state)) return;
    try {
      await requireApi().acknowledge(
        settings.packageName,
        purchase.productId,
        purchase.purchaseToken,
      );
      await store.markGooglePlayAcknowledged(purchase.purchaseToken, now());
    } catch (error) {
      logger.warn("google_play.acknowledge_failed", {
        code: String(/** @type {any} */ (error)?.code || "UNKNOWN"),
      });
    }
  }

  /** The STRATA account a purchase belongs to: the one Google names, else the owner of the purchase it replaced. */
  /** @param {import("./domain-types").GooglePlayPurchase} purchase */
  async function accountFor(purchase) {
    if (purchase.accountId) return purchase.accountId;
    const linked = purchase.linkedPurchaseToken
      ? await store.googlePlaySubscription(purchase.linkedPurchaseToken)
      : null;
    return linked ? String(linked.user_id).toLowerCase() : null;
  }

  // A subscription bought for a STRATA account that has since been deleted keeps billing the same Google Account. Its
  // purchase token only reaches a phone signed in to that Google Account, so the member restoring it there may attach it
  // to their new STRATA account, as long as no other account holds it.
  /** @param {string} token @param {string} account */
  async function claimable(token, account) {
    if (await store.userById(account)) return false;
    const existing = await store.googlePlaySubscription(token);
    return !existing || !(await store.userById(String(existing.user_id)));
  }

  /**
   * @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res
   * @param {import("./domain-types").SessionRow} session
   */
  async function acceptPurchases(req, res, session) {
    if (
      !(await rateAllowed(
        req,
        `identity:google-play-purchases:${session.id}`,
        PURCHASE_REQUESTS_PER_WINDOW,
      ))
    ) {
      json(res, 429, {
        error: "Too many purchase updates. Try again in a few minutes.",
        code: "GOOGLE_PLAY_RATE_LIMIT",
      });
      return;
    }
    const list = (await readJson(req)).purchases;
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > MAX_PURCHASES ||
      !list.every((item) => text(item?.purchaseToken, MAX_PURCHASE_TOKEN))
    )
      throw playError(
        `Send between 1 and ${MAX_PURCHASES} Google Play purchases.`,
        400,
        "GOOGLE_PLAY_PURCHASE_INVALID",
      );
    const userId = String(session.id).toLowerCase(),
      tokens = [...new Set(list.map((item) => String(item.purchaseToken)))];
    const checked = [];
    for (const token of tokens) {
      const { purchase, checkedAt } = await lookup(token);
      const account = await accountFor(purchase);
      if (!account)
        throw playError(
          "This Google Play purchase is not linked to a STRATA account.",
          400,
          "GOOGLE_PLAY_PURCHASE_INVALID",
        );
      if (account !== userId && !(await claimable(token, account)))
        throw playError(
          "This Google Play purchase belongs to a different STRATA account.",
          403,
          "GOOGLE_PLAY_ACCOUNT_MISMATCH",
        );
      if (!ownership(await store.googlePlaySubscription(token), session.id).allowed)
        throw playError(
          "This Google Play subscription is already linked to another STRATA account.",
          409,
          "GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT",
        );
      checked.push({ purchase, checkedAt });
    }
    /** @type {string[]} */
    const accepted = [];
    for (const { purchase, checkedAt } of checked) {
      if ((await apply(purchase, session.id, checkedAt)) === "conflict")
        throw playError(
          "This Google Play subscription is already linked to another STRATA account.",
          409,
          "GOOGLE_PLAY_PURCHASE_OTHER_ACCOUNT",
        );
      await acknowledge(purchase);
      accepted.push(purchase.purchaseToken);
    }
    logger.info("google_play.purchases_accepted", { count: accepted.length });
    const user = await getUserPayload(session);
    json(
      res,
      200,
      { discovery: user.discovery, accepted },
      { "Cache-Control": "private, no-store" },
    );
  }

  /**
   * Reads one token from Google again and stores the answer for the account that owns it (or the account Google names,
   * for a purchase STRATA has not seen). @param {string} purchaseToken @returns {Promise<string>}
   */
  async function refresh(purchaseToken) {
    const { purchase, checkedAt } = await lookup(purchaseToken);
    const existing = await store.googlePlaySubscription(purchaseToken);
    let userId = existing ? String(existing.user_id) : "";
    if (!userId) {
      const account = await accountFor(purchase);
      const owner = account ? await store.userById(account) : null;
      userId = owner ? String(owner.id) : "";
    }
    if (!userId) return "ignored:unlinked";
    const outcome = await apply(purchase, userId, checkedAt);
    if (outcome === "applied") await acknowledge(purchase);
    return outcome;
  }

  // Pub/Sub pushes each Real-time developer notification here. The push URL carries GOOGLE_PLAY_NOTIFICATION_TOKEN as
  // ?token=, so only the subscription STRATA set up can call it; whatever it says, STRATA asks Google itself.
  /**
   * @param {import("./domain-types").HttpRequest} req @param {import("./domain-types").HttpResponse} res
   * @param {URL} url
   */
  async function handleNotification(req, res, url) {
    if (!(await rateAllowed(req, "google-play-notifications", NOTIFICATIONS_PER_WINDOW))) {
      json(res, 429, { error: "Too many notifications. Retry later." });
      return;
    }
    const supplied = url.searchParams.get("token");
    if (!settings.notificationToken || !sameSecret(supplied || "", settings.notificationToken)) {
      json(res, 403, { error: "Not allowed." });
      return;
    }
    const envelope = await readJson(req);
    /** @type {Record<string,any>|null} */
    let payload = null;
    try {
      payload = JSON.parse(
        Buffer.from(String(envelope.message?.data || ""), "base64").toString("utf8"),
      );
    } catch {
      payload = null;
    }
    const token = text(payload?.subscriptionNotification?.purchaseToken, MAX_PURCHASE_TOKEN);
    let outcome = "ignored:malformed";
    if (payload?.testNotification) outcome = "test";
    else if (payload && payload.packageName !== settings.packageName) outcome = "ignored:package";
    else if (token) {
      try {
        outcome = await refresh(token);
      } catch (error) {
        const status = Number(/** @type {any} */ (error)?.status) || 500;
        // Google could not answer: ask Pub/Sub to deliver it again. Anything else will not get better by retrying.
        if (status >= 500) throw error;
        outcome = `ignored:${String(/** @type {any} */ (error)?.code || "invalid").toLowerCase()}`;
      }
    } else if (payload) outcome = "ignored:type";
    logger.info("google_play.notification", { outcome });
    json(res, 200, {});
  }

  // Background check (src/server.js runs it every few minutes): subscriptions near or past their expiry, ones not
  // acknowledged yet, and every other open one once a day.
  /** @type {Map<string, {attempts:number,retryAt:number}>} */
  const retries = new Map();
  /** @param {string} token @param {number} timestamp */
  function retryLater(token, timestamp) {
    const attempts = (retries.get(token)?.attempts || 0) + 1;
    retries.delete(token);
    retries.set(token, {
      attempts,
      retryAt: timestamp + Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS),
    });
    if (retries.size > RETRY_TRACKED) retries.delete(String(retries.keys().next().value));
  }

  async function refreshDue() {
    if (!api || !settings.configured) return { checked: 0, failed: 0 };
    const timestamp = now();
    const due = (
      await store.googlePlaySubscriptionsDue(
        timestamp + REFRESH_AHEAD_MS,
        timestamp - RECHECK_MS,
        REFRESH_BATCH * 4,
      )
    )
      .filter((row) => !(Number(retries.get(String(row.purchase_token))?.retryAt) > timestamp))
      .slice(0, REFRESH_BATCH);
    let failed = 0;
    for (const row of due) {
      const token = String(row.purchase_token);
      try {
        await refresh(token);
        retries.delete(token);
      } catch (error) {
        failed += 1;
        retryLater(token, timestamp);
        logger.warn("google_play.refresh_failed", {
          code: String(/** @type {any} */ (error)?.code || "UNKNOWN"),
        });
      }
    }
    return { checked: due.length, failed };
  }

  /** @type {import("./domain-types").ApiRoute[]} */
  const routes = [
    {
      method: "POST",
      path: "/api/billing/google/purchases",
      handler: ({ req, res, session }) => acceptPurchases(req, res, session),
    },
    {
      method: "POST",
      path: "/api/billing/google/notifications",
      webhook: true,
      handler: ({ req, res, url }) => handleNotification(req, res, url),
    },
  ];

  /** @param {string} userId @param {{email?:unknown,email_verified_at?:unknown}|null} [account] */
  async function subscriptionForUser(userId, account = null) {
    return googlePlaySubscriptionSummary(
      await store.googlePlaySubscriptionsForUser(userId),
      now(),
      {
        email: account?.email == null ? null : String(account.email),
        emailVerified: account?.email_verified_at != null,
      },
      settings,
    );
  }

  // Google bills until the member cancels with Google, so deletion says so while a subscription is live or renewing.
  /** @param {string} userId @returns {Promise<import("./domain-types").StoreDeletionNotice|null>} */
  async function deletionNotice(userId) {
    const timestamp = now(),
      rows = await store.googlePlaySubscriptionsForUser(userId);
    const billing = rows.some(
      (row) =>
        googlePlayRowActive(row, timestamp) ||
        (Number(row.auto_renew) === 1 &&
          ["ACTIVE", "IN_GRACE_PERIOD", "ON_HOLD", "PAUSED"].includes(String(row.state))),
    );
    return billing ? { message: DELETION_NOTICE, manageUrl: MANAGE_SUBSCRIPTIONS_URL } : null;
  }

  return Object.freeze({ routes, refresh, refreshDue, subscriptionForUser, deletionNotice });
}

module.exports = {
  DEFAULT_PRODUCT_IDS,
  DELETION_NOTICE,
  MANAGE_SUBSCRIPTIONS_URL,
  RENEWAL_MARGIN_MS,
  createGooglePlayBillingService,
  googlePlayBillingSettings,
  googlePlayPlan,
  googlePlayRowActive,
  googlePlaySubscriptionSummary,
  validateGooglePlaySubscription,
};
