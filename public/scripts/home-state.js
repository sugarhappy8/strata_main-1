/* global module, require */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports ? require("./home-logic") : root.StrataHomeLogic,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataHomeState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (logic) {
  "use strict";

  function createState() {
    return {
      group: "chest",
      sub: "all",
      query: "",
      equipment: "all",
      level: "all",
      sort: "score",
      showAll: false,
      exercises: [],
      user: null,
      accountStatus: "loading",
      accountVerifiedAt: 0,
      catalogStatus: "loading",
    };
  }

  function setCatalog(state, catalog) {
    state.exercises = logic.normalizeCatalog(catalog);
    state.catalogStatus = "ready";
    return state.exercises;
  }
  function failCatalog(state) {
    state.exercises = [];
    state.catalogStatus = "error";
  }
  function selectGroup(state, group) {
    if (!logic.GROUPS[group]) return false;
    state.group = group;
    state.sub = "all";
    state.showAll = false;
    return true;
  }
  function selectSubfilter(state, sub) {
    if (sub !== "all" && !logic.GROUPS[state.group]?.subs.includes(sub)) return false;
    state.sub = sub;
    return true;
  }
  function resetFilters(state) {
    state.sub = "all";
    state.equipment = "all";
    state.level = "all";
    state.query = "";
  }
  // A recheck hides the signed-in view until /api/me answers again, so nothing private outlives a changed session.
  function beginAccountRecheck(state) {
    state.user = null;
    state.accountStatus = "rechecking";
    state.accountVerifiedAt = 0;
  }
  function setAccount(state, user, { verifiedAt = Date.now() } = {}) {
    const next = user || null;
    state.user = next;
    state.accountStatus = next ? "authenticated" : "anonymous";
    state.accountVerifiedAt = next ? Number(verifiedAt) || Date.now() : 0;
  }
  function setAccountUnavailable(state) {
    state.user = null;
    state.accountStatus = "unavailable";
    state.accountVerifiedAt = 0;
  }

  return {
    beginAccountRecheck,
    createState,
    failCatalog,
    resetFilters,
    selectGroup,
    selectSubfilter,
    setAccount,
    setAccountUnavailable,
    setCatalog,
  };
});
