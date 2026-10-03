/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataDiscoverBrief = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";

  // The Overview's Daily Brief: Strata AI's note for today, stored on today's Daily Snapshot so opening the page
  // never calls the model. Plan adjustments are suggestions; nothing changes until the member edits the plan.

  const LEVELS = Object.freeze({
    ready: "Ready to train",
    steady: "Steady",
    take_it_easy: "Take it easy",
    unknown: "No recovery reading yet",
  });
  const FRESH_MS = 5 * 60 * 1000;

  function createController({ element, api, state, core, getGeneration }) {
    let brief = null,
      loadedAt = 0,
      loading = null;
    const text = (id, value) => {
      const node = element(id);
      if (node) {
        node.textContent = value || "";
        node.hidden = !value;
      }
    };
    function render() {
      const card = element("todayBrief");
      if (!card) return;
      if (!brief) {
        card.hidden = true;
        return;
      }
      element("todayBriefLevel").textContent = LEVELS[brief.readiness?.level] || "Daily Brief";
      element("todayBriefTitle").textContent = brief.recommendation?.title || "";
      text("todayBriefReadiness", brief.readiness?.summary);
      text("todayBriefDetail", brief.recommendation?.detail);
      text("todayBriefInsight", brief.insight);
      text("todayBriefCare", brief.careNote);
      const list = element("todayBriefAdjustments"),
        items = Array.isArray(brief.planAdjustments) ? brief.planAdjustments : [];
      StrataHtml.setHtml(
        list,
        items.map(
          (item) =>
            StrataHtml.html`<li><strong>${item.day}</strong> ${item.change}<small>${item.reason}</small></li>`,
        ),
      );
      list.hidden = !items.length;
      card.dataset.level = String(brief.readiness?.level || "unknown");
      card.hidden = false;
    }
    async function load({ force = false } = {}) {
      if (!state.user) return;
      if (!force && loadedAt && Date.now() - loadedAt < FRESH_MS) {
        render();
        return;
      }
      if (loading) return loading;
      const generation = getGeneration(),
        date = core.localDate();
      loading = (async () => {
        try {
          const result = await api(`/api/snapshots?from=${date}&to=${date}`);
          if (generation !== getGeneration()) return;
          brief = (result?.snapshots || []).find((item) => item?.date === date)?.brief || null;
          loadedAt = Date.now();
        } catch (error) {
          if (error?.redirecting || error?.stale) return;
          brief = null;
        } finally {
          loading = null;
        }
        if (generation === getGeneration()) render();
      })();
      return loading;
    }
    function activate(name) {
      if (name === "today") void load();
    }
    function reset() {
      brief = null;
      loadedAt = 0;
      loading = null;
      const card = element("todayBrief");
      if (card) card.hidden = true;
    }
    return { activate, load, reset };
  }

  return { LEVELS, createController };
});
