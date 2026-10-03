// @ts-check
"use strict";

// Account deletion that completes where the member is (App Review Guideline 5.1.1(v): App Review cannot open an
// email). A signed-in member re-enters the account password and types DELETE; nothing is mailed. The emailed link
// (auth.js) and this route share deleteProtectedAccount, so both refuse the same accounts and remove an account
// through the same store path: the store consumes an account_delete action either way. An account created with
// Google has no STRATA password; a sign-in within the last 15 minutes stands in for it.
const { createHash, randomBytes } = require("node:crypto");

const ROUTE = "/api/account/delete/now";
const MAX_ATTEMPTS = 5;
const RECENT_SIGN_IN_MS = 15 * 60 * 1000;
const RECENT_SIGN_IN =
  "For your security, sign out, sign in again with Google, then delete your account within 15 minutes.";
const ADMIN_PROTECTED =
  "The primary administrator account cannot be deleted while it owns site management.";
const CHECKOUT_PREPARING =
  "A Strata+ checkout is still being prepared. Nothing was deleted; please try again later.";
const PURCHASE_PENDING =
  "A Strata+ payment is still being processed. Nothing was deleted; please try again later.";

/**
 * @param {import("./domain-types").AppleDeletionNotice|null} appleBilling
 * @param {import("./domain-types").StoreDeletionNotice|null} [googlePlayBilling]
 */
function deletedMessage(appleBilling, googlePlayBilling = null) {
  const notices = [appleBilling, googlePlayBilling]
    .filter(Boolean)
    .map((notice) => ` ${notice?.message}`);
  return `Your STRATA account was permanently deleted.${notices.join("")}`;
}

/**
 * @param {import("./domain-types").AccountDeletionDependencies} dependencies
 * @returns {import("./domain-types").AccountDeletion}
 */
function createAccountDeletion({
  store,
  http,
  rateAllowed,
  passwordMatches,
  accountEmailHash,
  accountActionError,
  storageUnavailable,
  audit,
  clearCookies,
  reconcileCheckoutCreationBeforeDeletion,
  reconcileUnsettledPurchases,
  appleDeletionNotice,
  googlePlayDeletionNotice = async () => null,
  now = Date.now,
}) {
  const { json, bodyJson } = http;

  /** @param {import("./domain-types").ProtectedAccountDeletion} request */
  async function deleteProtectedAccount({ userId, email, purpose, remove, invalid }) {
    const principal = await store.adminPrincipal();
    if (principal?.user_id === userId)
      throw accountActionError(ADMIN_PROTECTED, 409, "ADMIN_ACCOUNT_PROTECTED");
    if ((await reconcileCheckoutCreationBeforeDeletion(userId)) > 0)
      throw accountActionError(CHECKOUT_PREPARING, 409, "CHECKOUT_PREPARING");
    // A Paddle subscription that has not ended refuses here (409 SUBSCRIPTION_ACTIVE) on both paths.
    if ((await reconcileUnsettledPurchases(userId)) > 0)
      throw accountActionError(PURCHASE_PENDING, 409, "PURCHASE_PENDING");
    // An app-store subscription never blocks deletion (App Review 5.1.1(v), Google Play's account deletion policy);
    // the member is told Apple or Google keeps billing.
    const [appleBilling, googlePlayBilling] = await Promise.all([
      appleDeletionNotice(userId),
      googlePlayDeletionNotice(userId),
    ]);
    const result = await remove(now(), accountEmailHash(email));
    if (result.status === "purchase_pending")
      throw accountActionError(PURCHASE_PENDING, 409, "PURCHASE_PENDING");
    if (result.status === "checkout_pending")
      throw accountActionError(CHECKOUT_PREPARING, 409, "CHECKOUT_PREPARING");
    if (result.status !== "deleted") throw invalid();
    audit("account_deleted", { purpose, email });
    return { user: result.user, appleBilling, googlePlayBilling };
  }

  /** @param {import("./domain-types").SessionRow} session @param {unknown} input */
  async function deleteSignedInAccount(session, input) {
    const body = /** @type {{confirmation?:unknown;password?:unknown}|null} */ (
      input && typeof input === "object" ? input : null
    );
    if (String(body?.confirmation || "").trim() !== "DELETE")
      throw accountActionError(
        "Type DELETE exactly to confirm permanent account deletion.",
        400,
        "DELETE_CONFIRMATION_REQUIRED",
      );
    const password = typeof body?.password === "string" ? body.password : "";
    try {
      const credentials = await store.accountCredentialsById(session.id);
      if (credentials && credentials.password_hash === "") {
        if (!(now() - Number(session.session_created_at) <= RECENT_SIGN_IN_MS))
          throw accountActionError(RECENT_SIGN_IN, 401, "RECENT_SIGN_IN_REQUIRED");
      } else {
        // The same constant-time scrypt comparison sign-in uses. No STRATA password is empty or longer than 128.
        const matches =
          Boolean(credentials) &&
          password.length > 0 &&
          password.length <= 128 &&
          (await passwordMatches(
            password,
            /** @type {import("./domain-types").CredentialUserRow} */ (credentials),
          ));
        if (!credentials || !matches)
          throw accountActionError("That password is incorrect.", 401, "PASSWORD_INCORRECT");
      }
      const email = String(credentials.email || session.email),
        internalTokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      return await deleteProtectedAccount({
        userId: session.id,
        email,
        purpose: "account_delete_in_app",
        remove: (deletedAt, emailHash) =>
          store.deleteAccountForUser(session.id, internalTokenHash, deletedAt, emailHash),
        invalid: () =>
          accountActionError(
            "Your account changed while it was being deleted. Nothing was deleted; refresh and try again.",
            409,
            "ACCOUNT_CHANGED",
          ),
      });
    } catch (error) {
      if (/** @type {{status?:unknown}} */ (error)?.status) throw error;
      throw storageUnavailable(error);
    }
  }

  /**
   * The in-app "Delete account" with the password. src/router.js has checked the session, origin, CSRF, and JSON.
   * @param {{req:import("./domain-types").HttpRequest,res:import("./domain-types").HttpResponse,
   *   session:import("./domain-types").SessionRow}} context
   */
  async function deleteNow({ req, res, session }) {
    // Password guesses are limited per account (every session of it, from any network) and per network.
    if (
      !(await rateAllowed(req, "account-delete-now", MAX_ATTEMPTS)) ||
      !(await rateAllowed(req, `identity:account-delete-now:${session.id}`, MAX_ATTEMPTS))
    ) {
      json(
        res,
        429,
        {
          error: "Too many deletion attempts. Wait 15 minutes and try again.",
          code: "ACCOUNT_DELETE_RATE_LIMIT",
        },
        { "Retry-After": "900" },
      );
      return;
    }
    const input = await bodyJson(req);
    try {
      const { appleBilling, googlePlayBilling } = await deleteSignedInAccount(session, input);
      json(
        res,
        200,
        {
          ok: true,
          message: deletedMessage(appleBilling, googlePlayBilling),
          ...(appleBilling ? { appleBilling } : {}),
          ...(googlePlayBilling ? { googlePlayBilling } : {}),
        },
        { "Set-Cookie": clearCookies() },
      );
    } catch (error) {
      const failure = /** @type {{status:number;message:string;code?:string}} */ (error);
      json(res, failure.status, {
        error: failure.message,
        code: failure.code || "ACCOUNT_DELETE_FAILED",
      });
    }
  }

  /** @type {import("./domain-types").ApiRoute[]} */
  const routes = [{ method: "POST", path: ROUTE, handler: deleteNow }];

  return Object.freeze({ routes, deleteProtectedAccount, deleteSignedInAccount });
}

module.exports = { ROUTE, createAccountDeletion, deletedMessage };
