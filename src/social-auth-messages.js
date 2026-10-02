// @ts-check
"use strict";

// What the account page may say after a Google sign-in. auth.js shows only allowlisted messages,
// so these are shared with it; public/scripts/account-logic.js keeps the same list for the browser.
const SOCIAL_MESSAGES = Object.freeze({
  canceled: "Sign-in was canceled. Choose an option to try again.",
  expired: "That sign-in expired or was started in another browser. Please try again.",
  unavailable:
    "That sign-in option is not available right now. Use your email and password or try again later.",
  failed: "The sign-in could not be completed. Please try again.",
  noEmail:
    "Your Google account did not share a verified email address. Create an account with your email instead.",
  unverified: "An account with that email already exists. Sign in with your password to continue.",
  otherLinked: "This STRATA account is already linked to a different Google account.",
  paused: "This account is temporarily paused. Contact STRATA support for help.",
  rate: "Too many attempts. Try again later.",
  origin: "Cross-origin request rejected.",
});
const SOCIAL_PAGE_MESSAGES = Object.freeze(Object.values(SOCIAL_MESSAGES));

module.exports = { SOCIAL_MESSAGES, SOCIAL_PAGE_MESSAGES };
