// @ts-check
"use strict";

/**
 * Wire the account-facing services through their narrow, typed capabilities.
 * Keeping this production composition boundary separate makes the otherwise
 * circular auth/admin relationship explicit without letting either service
 * construct or import the other.
 * @param {import("./domain-types").ServiceCompositionDependencies} dependencies
 * @returns {{auth:import("./domain-types").AuthService,admin:import("./domain-types").AdminService,support:import("./domain-types").SupportService}}
 */
function composeServices({
  store,
  emailConfig,
  paymentConfig,
  adminEmail,
  enforcePaddleIps,
  exerciseIds,
  trustedAuthOrigin,
  rateAllowed,
  requestAddress,
  http,
  getUserPayload,
  reconcileCheckoutCreationBeforeDeletion,
  reconcileUnsettledPurchases,
  isUniqueViolation,
  appleDeletionNotice,
  googlePlayDeletionNotice,
  serviceStatus,
  createAuthService,
  createAdminService,
  createSupportService,
}) {
  /** @type {import("./domain-types").AdminService|undefined} */
  let admin;
  const auth = createAuthService({
    store,
    emailConfig,
    exerciseIds,
    isUniqueViolation,
    trustedAuthOrigin,
    rateAllowed,
    http: {
      json: http.json,
      bodyJson: http.bodyJson,
      bodyForm: http.bodyForm,
      redirect: http.redirect,
      securityHeaders: http.securityHeaders,
    },
    getUserPayload,
    claimAdminForLogin: async (user) => (admin ? admin.maybeClaimAdminForLogin(user) : user),
    reconcileCheckoutCreationBeforeDeletion,
    reconcileUnsettledPurchases,
    ...(appleDeletionNotice ? { appleDeletionNotice } : {}),
    ...(googlePlayDeletionNotice ? { googlePlayDeletionNotice } : {}),
  });
  admin = createAdminService({
    store,
    adminEmail,
    auth,
    emailConfig,
    paymentConfig,
    enforcePaddleIps,
    rateAllowed,
    http: { json: http.json, bodyJson: http.bodyJson },
    reconcileCheckoutCreationBeforeDeletion,
    reconcileUnsettledPurchases,
    ...(serviceStatus ? { serviceStatus } : {}),
  });
  const support = createSupportService({
    store,
    emailConfig,
    auth,
    admin,
    requestAddress,
    rateAllowed,
    isUniqueViolation,
    http: {
      json: http.json,
      bodyJson: http.bodyJson,
      bodyForm: http.bodyForm,
      redirect: http.redirect,
    },
  });
  return { auth, admin, support };
}

module.exports = { composeServices };
