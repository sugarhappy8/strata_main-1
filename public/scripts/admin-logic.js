/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTION_DETAILS = Object.freeze({
    "grant-plus": {
      title: "Give free Strata+?",
      button: "Give free Strata+",
      description:
        "Give this account complimentary access for the chosen period. This replaces its current grant, never charges the user, and does not cancel a paid subscription.",
    },
    "revoke-plus": {
      title: "Revoke free Strata+?",
      button: "Revoke free Strata+",
      description:
        "End the administrator's complimentary grant. Separate paid access is unchanged.",
    },
    "close-checkouts": {
      title: "Block new checkouts?",
      button: "Block new and close eligible checkouts",
      description:
        "Block new checkouts until you allow them again and ask Paddle to cancel eligible unfinished transactions. Paddle does not allow STRATA to cancel a draft checkout, so STRATA retires the draft by disabling its checkout link and clearing STRATA’s checkout metadata while Paddle retains the transaction record. Revoking STRATA sign-in sessions is separate and does not change Paddle payment state. Existing subscriptions and charges are unchanged.",
    },
    "enable-checkouts": {
      title: "Allow payment sessions?",
      button: "Allow payment sessions",
      description:
        "Allow this account to open new checkouts again. Previously canceled transactions stay canceled.",
    },
    "send-password-reset": {
      title: "Send password reset?",
      button: "Send password reset",
      description:
        "A single-use password-reset link will be emailed to the account’s registered address. The link itself will not be shown here.",
    },
    "send-delete-link": {
      title: "Send deletion link?",
      button: "Send deletion link",
      description:
        "A deletion-confirmation link will be emailed to the registered address. Opening the link alone does not delete the account.",
    },
    "cancel-deletion": {
      title: "Cancel deletion?",
      button: "Cancel deletion request",
      description:
        "The pending deletion request will be revoked and its emailed link will stop working.",
    },
    "revoke-sessions": {
      title: "Revoke all sessions?",
      button: "Revoke all sessions",
      description:
        "Every active session for this account will be signed out. The account owner can sign in again with the current password.",
    },
    suspend: {
      title: "Suspend account?",
      button: "Suspend account",
      description:
        "The account will lose signed-in access until an administrator restores it. Existing payment records must remain intact.",
    },
    restore: {
      title: "Restore account?",
      button: "Restore account",
      description:
        "Signed-in access will be restored. This does not create or change Strata+ payment entitlement.",
    },
    "delete-account": {
      title: "Permanently delete account?",
      button: "Permanently delete account",
      description:
        "This pauses the account and signs out its devices, then checks payment state before deleting data permanently. If a live subscription or unresolved payment blocks deletion, the account stays paused and can be restored. Subscriptions and refunds are separate.",
    },
  });

  function cleanString(value, fallback = "—") {
    const result = String(value ?? "")
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
      .trim();
    return result || fallback;
  }
  function firstValue(source, keys, fallback = undefined) {
    for (const key of keys)
      if (source && source[key] !== undefined && source[key] !== null) return source[key];
    return fallback;
  }
  function numberValue(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }
  function booleanValue(source, keys) {
    const value = firstValue(source, keys, undefined);
    if (value === undefined) return undefined;
    return (
      value === true ||
      value === 1 ||
      value === "true" ||
      value === "active" ||
      value === "enabled" ||
      value === "configured"
    );
  }
  function formatCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed).toLocaleString() : "—";
  }
  function formatDate(value) {
    if (value === undefined || value === null || value === "") return "—";
    const numeric = Number(value);
    const date = new Date(
      Number.isFinite(numeric) && numeric > 0 && numeric < 1e12 ? numeric * 1000 : value,
    );
    if (Number.isNaN(date.getTime())) return cleanString(value);
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
      date,
    );
  }
  function friendlyError(error) {
    if (error?.code === "network")
      return "Could not reach STRATA. Check the connection and try again.";
    if (error?.code === "ADMIN_ORIGIN_REQUIRED" || error?.code === "INVALID_CSRF")
      return "The security check expired. Refresh this page and try again.";
    if (error?.status === 401) return "Your session expired. Sign in again to continue.";
    if (error?.status === 403) return "This verified account does not have administrator access.";
    if (error?.code === "ACCOUNT_MUST_BE_SUSPENDED")
      return "Pause this account first, then reopen it to permanently delete it.";
    if (error?.code === "SUBSCRIPTION_ACTIVE")
      return "Cancel this account’s Paddle subscription and wait for its canceled status before deleting STRATA data.";
    if (error?.code === "CHECKOUT_PREPARING")
      return "A Strata+ checkout that already started is still being matched with Paddle. Blocking new payment sessions does not erase an in-flight checkout. Nothing was deleted; wait a moment and retry.";
    if (error?.code === "PURCHASE_PENDING")
      return "A Paddle payment or subscription link has not reached a deletion-safe state. Blocking new payment sessions and revoking STRATA sign-in sessions do not cancel payment processing. Nothing was deleted; wait for Paddle to settle it, then retry.";
    if (error?.code === "CHECKOUT_CLOSE_INCOMPLETE")
      return cleanString(
        error?.message,
        "New payment sessions are blocked, but Paddle did not confirm that every eligible checkout was closed. Nothing was deleted; retry shortly.",
      );
    if (error?.code === "PURCHASE_RECONCILIATION_UNAVAILABLE")
      return "Paddle did not confirm the checkout cleanup. Nothing was deleted; the account remains protected. Retry shortly.";
    if (error?.code === "PURCHASE_RECONCILIATION_INVALID")
      return "STRATA could not safely match the Paddle checkout to this account. Nothing was deleted. Review the transaction in Paddle before trying again.";
    if (error?.code === "ADMIN_STATE_CHANGED")
      return "The account or billing state changed. Nothing was deleted; refresh and try again.";
    if (error?.code === "SUPPORT_STATE_CHANGED" || error?.code === "SUPPORT_VERSION_REQUIRED")
      return "This help request changed. Close it, refresh the help desk, and try again.";
    if (error?.code === "SUPPORT_RESPONSE_DELIVERY_FAILED")
      return "The workflow was saved, but the email response was not sent. Refresh the request and try the response again.";
    if (error?.status === 429) return "Too many requests were made. Wait a moment and try again.";
    if (Number(error?.status) >= 500)
      return "The administration service is temporarily unavailable. Try again shortly.";
    return cleanString(error?.message, "The request could not be completed.");
  }

  const normalizedOverview = (data) => data?.overview || data?.stats || data || {};
  function overviewNumber(source, keys) {
    const value = firstValue(source, keys, undefined);
    return value === undefined ? "—" : formatCount(value);
  }
  const userId = (user) => cleanString(firstValue(user, ["id", "userId", "user_id"], ""), "");
  const userEmail = (user) =>
    cleanString(
      firstValue(user, ["email", "accountEmail", "account_email"], ""),
      "Email unavailable",
    );
  const userName = (user) =>
    cleanString(firstValue(user, ["name", "displayName", "display_name"], ""), "Unnamed account");
  function userVerified(user) {
    const explicit = booleanValue(user, ["verified", "emailVerified", "email_verified"]);
    return (
      explicit ??
      Boolean(firstValue(user, ["verifiedAt", "emailVerifiedAt", "email_verified_at"], null))
    );
  }
  function userSuspended(user) {
    const explicit = booleanValue(user, ["suspended", "isSuspended", "is_suspended"]);
    return (
      explicit ??
      (Boolean(firstValue(user, ["suspendedAt", "suspended_at"], null)) ||
        String(user?.status || "").toLowerCase() === "suspended")
    );
  }
  function discoveryActive(user) {
    const discovery = user?.discovery || {};
    return (
      booleanValue(discovery, ["active", "hasAccess"]) ??
      booleanValue(user, ["discoveryActive", "discovery_active", "hasDiscovery"]) ??
      numberValue(firstValue(user, ["activePurchaseCount", "active_purchase_count"], 0)) > 0
    );
  }
  function deletionPending(user) {
    const deletion = user?.accountDeletion || user?.deletion || {};
    return (
      booleanValue(deletion, ["pending", "active"]) ??
      booleanValue(user, ["deletionPending", "deletion_pending"]) ??
      Boolean(
        firstValue(
          user,
          ["deletionExpiresAt", "deletion_expires_at", "deletionRequestId", "deletion_request_id"],
          null,
        ),
      )
    );
  }
  function planSummary(user) {
    const exercises = firstValue(user, ["planCount", "plan_count", "exerciseCount"], undefined),
      days = firstValue(user, ["workoutDays", "workout_days"], undefined);
    return exercises === undefined && days === undefined
      ? "—"
      : `${formatCount(exercises ?? 0)} exercises · ${formatCount(days ?? 0)} workout days`;
  }
  // The member's App Store subscription (Strata+ bought in the iOS app) beside the Paddle facts. The detail view
  // carries discovery.apple.subscription; the list row only knows how many are active and the latest expiry.
  function appleFacts(user) {
    const apple = user?.discovery?.apple || {},
      summary = apple.subscription;
    if (summary === undefined)
      return [
        [
          "App Store subscription",
          numberValue(apple.activeCount) > 0
            ? `Active · expires ${formatDate(apple.expiresAt)}`
            : apple.expiresAt
              ? `Expired ${formatDate(apple.expiresAt)}`
              : "None",
        ],
      ];
    if (!summary || typeof summary !== "object") return [["App Store subscription", "None"]];
    const status =
      summary.revoked === true
        ? "Revoked (refunded or Family Sharing removed)"
        : summary.inGracePeriod === true
          ? "Active · billing grace period"
          : summary.active === true
            ? "Active"
            : "Expired";
    return [
      ["App Store subscription", status],
      [
        "App Store environment",
        summary.environment === "Sandbox" ? "Sandbox (test purchase)" : "Production",
      ],
      ["App Store expiry", formatDate(summary.expiresAt)],
      [
        "App Store auto-renew",
        summary.autoRenew === true ? "On" : summary.autoRenew === false ? "Off" : "Unknown",
      ],
      ["App Store revoked", summary.revoked === true ? "Yes" : "No"],
    ];
  }
  const supportId = (ticket) =>
    cleanString(firstValue(ticket, ["id", "ticketId", "ticket_id", "reference"], ""), "");
  const supportReference = (ticket) =>
    cleanString(
      firstValue(ticket, ["reference", "publicReference", "public_reference", "id"], ""),
      "Help request",
    );
  function supportState(ticket, supportStates = new Set(["new", "open", "waiting", "resolved"])) {
    const value = String(firstValue(ticket, ["status", "state"], "new"))
      .toLowerCase()
      .replace(/[_\s]+/g, "-");
    return value === "waiting-on-user" ? "waiting" : supportStates.has(value) ? value : "new";
  }
  const supportStateLabel = (value) =>
    ({ new: "New", open: "Open", waiting: "Waiting on user", resolved: "Resolved" })[value] ||
    "New";
  return {
    ACTION_DETAILS,
    appleFacts,
    booleanValue,
    cleanString,
    deletionPending,
    discoveryActive,
    firstValue,
    formatCount,
    formatDate,
    friendlyError,
    normalizedOverview,
    numberValue,
    overviewNumber,
    planSummary,
    supportId,
    supportReference,
    supportState,
    supportStateLabel,
    userEmail,
    userId,
    userName,
    userSuspended,
    userVerified,
  };
});
