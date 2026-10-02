/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAdminState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const USER_LIMIT = 20;
  const SUPPORT_LIMIT = 20;
  const SECTION_NAMES = new Set(["overview", "people", "support", "activity"]);
  const SUPPORT_STATES = new Set(["new", "open", "waiting", "resolved"]);
  const PRODUCT_SIGNAL_LABELS = Object.freeze({
    preview_generated: "Preview generated",
    onboarding_previewed: "Setup previewed",
    onboarding_saved: "Setup saved",
    plan_saved: "Plan saved",
    workout_started: "Workout started",
    workout_completed: "Workout completed",
    upgrade_viewed: "Pricing viewed",
    checkout_opened: "Checkout opened",
    upgrade_activated: "Paid access activated",
    recommendation_feedback_useful: "Shortlist · useful",
    recommendation_feedback_not_relevant: "Shortlist · not relevant",
    recommendation_feedback_not_clear: "Shortlist · not clear",
  });

  function createState() {
    let privateGeneration = 0;
    return {
      admin: null,
      csrfToken: "",
      authorized: false,
      activeSection: "overview",
      loaded: new Set(),
      productSignalRequest: 0,
      users: { query: "", offset: 0, total: 0, items: [], request: 0 },
      support: { status: "", offset: 0, total: 0, items: [], request: 0 },
      selectedUser: null,
      selectedTicket: null,
      pendingAction: null,
      actionTrigger: null,
      userDialogTrigger: null,
      supportDialogTrigger: null,
      capturePrivateOperation() {
        return privateGeneration;
      },
      isCurrentPrivateOperation(value) {
        return value === privateGeneration;
      },
      invalidatePrivateOperations() {
        privateGeneration += 1;
        return privateGeneration;
      },
    };
  }

  return {
    PRODUCT_SIGNAL_LABELS,
    SECTION_NAMES,
    SUPPORT_LIMIT,
    SUPPORT_STATES,
    USER_LIMIT,
    createState,
  };
});
