/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataDiscoverCatalog = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";

  const { html } = StrataHtml;
  function createCatalog({
    state,
    core,
    labels,
    preferenceOptions,
    limitationOptions,
    movementBoardLimit,
    desktopPageSize,
    mobilePageSize,
    ratingsRefreshInterval,
    document,
    window,
    element,
    exerciseById,
    titleCase,
    personalResult,
    aggregateFor,
    api,
    getGeneration,
    saveMovementBoard,
    showToast,
    openDetail,
    openComparison,
  }) {
    function communitySummary(id) {
      const item = aggregateFor(id),
        count = Math.max(0, Number.parseInt(item?.rating_count, 10) || 0),
        overall = Number(item?.overall);
      if (!count || !Number.isFinite(overall))
        return {
          count: 0,
          hasRatings: false,
          score: "",
          label: "Not rated yet",
          attribution: "No Strata+ ratings yet",
        };
      const score = (Math.min(5, Math.max(1, overall)) * 2).toFixed(1);
      return {
        count,
        hasRatings: true,
        score,
        label: `${score}/10 · ${count} rating${count === 1 ? "" : "s"}`,
        attribution: `Rated by ${count} Strata+ user${count === 1 ? "" : "s"}`,
      };
    }
    function communityLabel(id) {
      return communitySummary(id).label;
    }
    function ratingAverage(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(1) : "—";
    }
    function profileReason(result) {
      return result.reasons.length ? result.reasons.join(", ") : "strong all-around fit";
    }
    function buildRecommendations() {
      state.recommendations = state.exercises
        .map((exercise) => ({ exercise, result: personalResult(exercise) }))
        .filter((item) => item.result.eligible)
        .sort((a, b) => b.result.match - a.result.match || b.exercise.score - a.exercise.score)
        .slice(0, 8);
    }
    function personalLabel(result, { long = false } = {}) {
      return result.eligible
        ? `${result.match}% personal match`
        : long
          ? `Profile mismatch — ${profileReason(result)}`
          : "Profile mismatch";
    }
    function choiceMarkup(name, value, label, checked) {
      return html`<label class="choice-pill"><input type="checkbox" name="${name}" value="${value}" ${checked ? "checked" : ""}/><span>${label}</span></label>`;
    }
    function renderProfile() {
      element("goalSelect").value = state.preferences.goal;
      element("levelSelect").value = state.preferences.level;
      element("daysInput").value = state.preferences.days;
      const equipment = [...new Set(state.exercises.map((exercise) => exercise.equipment))];
      StrataHtml.setHtml(
        element("equipmentChoices"),
        equipment.map((value) =>
          choiceMarkup("equipment", value, value, state.preferences.equipment.includes(value)),
        ),
      );
      StrataHtml.setHtml(
        element("preferenceChoices"),
        Object.entries(preferenceOptions).map(([value, label]) =>
          choiceMarkup("preferences", value, label, state.preferences.preferences.includes(value)),
        ),
      );
      StrataHtml.setHtml(
        element("limitationChoices"),
        Object.entries(limitationOptions).map(([value, label]) =>
          choiceMarkup("limitations", value, label, state.preferences.limitations.includes(value)),
        ),
      );
      element("profileStatus").textContent = "Saved";
      renderRankingLens();
    }
    function scoreButton(exercise) {
      return html`<button class="score-button" data-open-detail="${exercise.id}" type="button" aria-label="Open transparent FitScore for ${exercise.name}"><strong>${exercise.score}</strong><span>FitScore</span></button>`;
    }
    function compareButton(exercise) {
      const active = state.compare.includes(exercise.id);
      return html`<button class="${active ? "active" : ""}" data-toggle-compare="${exercise.id}" type="button" aria-pressed="${active}" aria-label="${active ? "Remove" : "Add"} ${exercise.name} ${active ? "from" : "to"} comparison">${active ? "Selected ✓" : "Compare +"}</button>`;
    }
    function movementBoardButton(exercise, { compact = false } = {}) {
      const active = state.shortlist.includes(exercise.id),
        label = active ? "Saved" : "Save";
      return html`<button class="movement-save${active ? " is-saved" : ""}${compact ? " is-compact" : ""}" data-toggle-shortlist="${exercise.id}" type="button" aria-pressed="${active}" aria-label="${active ? "Remove" : "Save"} ${exercise.name} ${active ? "from" : "to"} your decision board"><span aria-hidden="true">${active ? "✓" : "+"}</span><b>${label}</b></button>`;
    }
    function renderRankingLens() {
      if (!state.preferences || !element("rankingLensItems")) return;
      const goal =
          {
            hypertrophy: "Hypertrophy",
            strength: "Strength",
            balanced: "Balanced",
            "time-efficient": "Time-efficient",
          }[state.preferences.goal] || titleCase(state.preferences.goal),
        constraints = state.preferences.limitations?.length
          ? `${state.preferences.limitations.length} constraint${state.preferences.limitations.length === 1 ? "" : "s"}`
          : "No exclusions";
      StrataHtml.setHtml(
        element("rankingLensItems"),
        [
          goal,
          state.preferences.level,
          `${state.preferences.days} days`,
          `${state.preferences.equipment.length} equipment types`,
          constraints,
        ].map((item) => html`<li>${item}</li>`),
      );
    }
    function renderMovementBoard({ message = "" } = {}) {
      if (!element("savedActions")) return;
      state.shortlist = core.normalizeShortlist(
        state.shortlist,
        state.exercises,
        movementBoardLimit,
      );
      const count = state.shortlist.length;
      element("savedCollectionLabel").textContent = `Saved · ${count}`;
      element("clearMovementBoard").hidden = !count;
      element("compareMovementBoard").disabled = count < 2;
      element("savedActions").hidden = state.collection !== "saved";
      element("movementBoardStatus").textContent =
        message ||
        (count === 0
          ? "Nothing saved yet. Save an exercise from a recommendation, the library, or its detail view."
          : count === 1
            ? "One movement saved. Add another to compare."
            : `${count} of ${movementBoardLimit} movements saved. Ready to compare.`);
    }
    function renderRecommendations() {
      buildRecommendations();
      const goal =
        {
          hypertrophy: "Hypertrophy selection",
          strength: "Strength skill",
          balanced: "Balanced",
          "time-efficient": "Time-efficient setup",
        }[state.preferences.goal] || titleCase(state.preferences.goal);
      element("recommendationSummary").textContent =
        `Rules-based ${goal.toLowerCase()} ranking · ${state.preferences.equipment.length} equipment types · ${state.preferences.days} days`;
      StrataHtml.setHtml(
        element("recommendationGrid"),
        state.recommendations.length
          ? state.recommendations.map(
              ({ exercise, result }, index) =>
                html`<article class="recommend-card" data-rank="${String(index + 1).padStart(2, "0")}"><div class="card-topline"><span class="match-pill">${result.match}% personal match</span><div class="card-tools">${movementBoardButton(exercise, { compact: true })}${scoreButton(exercise)}</div></div><h3>${exercise.name}</h3><span class="target">${labels[exercise.group]} / ${exercise.sub}</span><p>${profileReason(result)}. ${exercise.why}</p><div class="mini-meta"><span>${exercise.equipment}</span><span>${exercise.level}</span></div><div class="community-line"><span>Community rating</span><strong>${communityLabel(exercise.id)}</strong></div><div class="mini-actions"><button data-open-detail="${exercise.id}" type="button" aria-label="Why ${exercise.name} ranks here">Why it ranks</button>${compareButton(exercise)}<a href="/planner.html?add=${encodeURIComponent(exercise.id)}" aria-label="Add ${exercise.name} to weekly plan">Add to plan</a></div></article>`,
            )
          : html`<div class="loading-card recommendation-empty"><p>No exercise matches all saved equipment and constraints.</p><a class="small-button" href="#profile" data-feature-target="profile">Tune my ranking →</a></div>`,
      );
    }
    function populateFilters() {
      const groups = [...new Set(state.exercises.map((exercise) => exercise.group))],
        equipment = [...new Set(state.exercises.map((exercise) => exercise.equipment))],
        patterns = [...new Set(state.exercises.map((exercise) => exercise.pattern))];
      StrataHtml.setHtml(
        element("groupFilter"),
        html`<option value="all">All muscles</option>${groups.map((value) => html`<option value="${value}">${labels[value] || titleCase(value)}</option>`)}`,
      );
      StrataHtml.setHtml(
        element("equipmentFilter"),
        html`<option value="all">All equipment</option>${equipment.map((value) => html`<option value="${value}">${value}</option>`)}`,
      );
      StrataHtml.setHtml(
        element("patternFilter"),
        html`<option value="all">All patterns</option>${patterns.map((value) => html`<option value="${value}">${value}</option>`)}`,
      );
    }
    function discoveryResults() {
      return core.filterExercises(
        state.exercises,
        {
          collection: state.collection,
          saved: state.shortlist,
          query: state.query,
          group: state.group,
          equipment: state.equipment,
          pattern: state.pattern,
          level: state.level,
          sort: state.sort,
        },
        state.preferences,
        aggregateFor,
      );
    }
    function explorerPageSize() {
      return window.matchMedia?.("(max-width: 680px)")?.matches ? mobilePageSize : desktopPageSize;
    }
    function resetExplorerWindow() {
      state.explorerLimit = explorerPageSize();
    }
    function renderExplorer() {
      const items = discoveryResults(),
        visibleItems = items.slice(0, state.explorerLimit),
        remaining = Math.max(0, items.length - visibleItems.length),
        nextCount = Math.min(explorerPageSize(), remaining);
      element("resultCount").textContent = items.length;
      element("resultNoun").textContent = items.length === 1 ? "exercise" : "exercises";
      element("exerciseGrid").hidden = !items.length;
      element("emptyState").hidden = Boolean(items.length);
      const savedEmpty = !items.length && state.collection === "saved" && !state.shortlist.length;
      element("emptyStateTitle").textContent = savedEmpty
        ? "Nothing saved yet."
        : "No exercise matches every filter.";
      element("emptyStateDetail").textContent = savedEmpty
        ? "Save up to four movements from recommendations or the library, then return here to review them together."
        : "Try clearing the search or one of the exercise filters.";
      StrataHtml.setHtml(
        element("exerciseGrid"),
        html`${visibleItems.map((exercise, index) => {
          const personal = personalResult(exercise);
          return html`<article class="exercise-card" data-result-index="${index}"><div class="card-topline"><span class="match-pill ${personal.eligible ? "" : "is-excluded"}">${personalLabel(personal)}</span><div class="card-tools">${movementBoardButton(exercise, { compact: true })}${scoreButton(exercise)}</div></div><h3>${exercise.name}</h3><span class="target">${labels[exercise.group] || titleCase(exercise.group)} / ${exercise.sub}</span><p>${exercise.why}</p><div class="mini-meta"><span>${exercise.equipment}</span><span>${exercise.pattern}</span><span>${exercise.level}</span></div><div class="community-line"><span>Community rating</span><strong>${communityLabel(exercise.id)}</strong></div><div class="mini-actions"><button data-open-detail="${exercise.id}" type="button" aria-label="Inspect ${exercise.name}">Inspect</button>${compareButton(exercise)}<a href="/planner.html?add=${encodeURIComponent(exercise.id)}" aria-label="Add ${exercise.name} to weekly plan">Add to plan</a></div></article>`;
        })}${
          !remaining
            ? ""
            : html`<div class="explorer-load-more"><p>Showing ${visibleItems.length} of ${items.length} matching exercises</p><button data-load-more-exercises type="button" aria-controls="exerciseGrid">Load ${nextCount} more <span aria-hidden="true">↓</span></button></div>`
        }`,
      );
    }
    function renderCommunityViews() {
      if (!state.exercises.length || !state.preferences || state.ratingSaving.size) return;
      renderRecommendations();
      renderExplorer();
      if (state.activeExercise && element("detailDialog")?.open) openDetail(state.activeExercise);
      if (state.compare.length >= 2 && !element("battleResults")?.hidden) openComparison();
    }
    async function refreshCommunityRatings({ force = false } = {}) {
      if (!state.user || !state.exercises.length) return false;
      if (state.ratingsRefreshPromise) return state.ratingsRefreshPromise;
      if (!force && Date.now() - state.ratingsRefreshedAt < ratingsRefreshInterval) return false;
      const generation = getGeneration(),
        refresh = api("/api/ratings/aggregates").then((data) => {
          if (generation !== getGeneration()) return false;
          const aggregates = Array.isArray(data.aggregates)
            ? data.aggregates
            : Array.isArray(data.ratings?.aggregates)
              ? data.ratings.aggregates
              : [];
          state.aggregate = new Map(aggregates.map((item) => [item.exercise_id, item]));
          state.ratingsRefreshedAt = Date.now();
          renderCommunityViews();
          return true;
        });
      state.ratingsRefreshPromise = refresh;
      try {
        return await refresh;
      } finally {
        if (state.ratingsRefreshPromise === refresh) state.ratingsRefreshPromise = null;
      }
    }
    function renderCompareTray() {
      const exercises = state.compare.map(exerciseById).filter(Boolean);
      element("compareTray").hidden = !exercises.length;
      element("compareCount").textContent = `${exercises.length}/4`;
      element("openCompare").disabled = exercises.length < 2;
      element("compareNames").textContent = exercises.length
        ? exercises.map((exercise) => exercise.name).join(" vs. ")
        : "Choose 2–4 exercises";
      renderBattleBuilder();
    }
    function battleOptions(selected) {
      return html`<option value="">Choose an exercise…</option>${Object.keys(labels).map(
        (group) =>
          html`<optgroup label="${labels[group]}">${state.exercises
            .filter((exercise) => exercise.group === group)
            .sort((a, b) => b.score - a.score)
            .map(
              (exercise) =>
                html`<option value="${exercise.id}" ${exercise.id === selected ? "selected" : ""}>${exercise.name} — ${exercise.score}</option>`,
            )}</optgroup>`,
      )}`;
    }
    function renderBattleBuilder() {
      if (!state.exercises.length) return;
      StrataHtml.setHtml(
        element("battleSelects"),
        [0, 1, 2, 3].map(
          (index) =>
            html`<label class="battle-slot">Exercise ${index + 1}${index < 2 ? " (required)" : " (optional)"}<select data-battle-slot="${index}" ${index < 2 ? "required" : ""}>${battleOptions(state.compare[index] || "")}</select></label>`,
        ),
      );
      const count = state.compare.length;
      element("battleStatus").textContent =
        count < 2
          ? `${count}/4 selected · choose at least two`
          : `${count}/4 selected · ready to compare`;
    }
    function readBattleBuilder() {
      state.compare = [
        ...new Set(
          [...document.querySelectorAll("[data-battle-slot]")]
            .map((select) => select.value)
            .filter((id) => exerciseById(id)),
        ),
      ].slice(0, 4);
      const count = state.compare.length;
      element("battleStatus").textContent =
        count < 2
          ? `${count}/4 selected · choose at least two`
          : `${count}/4 selected · ready to compare`;
      element("compareTray").hidden = !count;
      element("compareCount").textContent = `${count}/4`;
      element("openCompare").disabled = count < 2;
      element("compareNames").textContent = count
        ? state.compare.map((id) => exerciseById(id).name).join(" vs. ")
        : "Choose 2–4 exercises";
    }
    function toggleCompare(id) {
      if (state.compare.includes(id)) state.compare = state.compare.filter((item) => item !== id);
      else if (state.compare.length < 4) state.compare.push(id);
      else {
        showToast("Comparison is limited to four exercises.");
        return;
      }
      element("battleResults").hidden = true;
      renderCompareTray();
      renderRecommendations();
      renderExplorer();
    }
    function toggleMovementBoard(id) {
      const exercise = exerciseById(id);
      if (!exercise) return false;
      const index = state.shortlist.indexOf(id),
        removing = index >= 0;
      if (removing) state.shortlist.splice(index, 1);
      else if (state.shortlist.length >= movementBoardLimit) {
        showToast(
          `You can save ${movementBoardLimit} movements. Remove one before saving another.`,
        );
        return false;
      } else state.shortlist.push(id);
      const persisted = saveMovementBoard(),
        message = removing
          ? `${exercise.name} removed from your saved movements.`
          : `${exercise.name} saved${persisted ? " on this device" : " for this visit"}.`;
      renderMovementBoard({ message });
      renderRecommendations();
      renderExplorer();
      if (state.activeExercise === id && element("detailDialog")?.open) openDetail(id);
      showToast(message);
      return true;
    }
    return {
      buildRecommendations,
      communityLabel,
      communitySummary,
      compareButton,
      discoveryResults,
      explorerPageSize,
      movementBoardButton,
      personalLabel,
      profileReason,
      populateFilters,
      ratingAverage,
      readBattleBuilder,
      refreshCommunityRatings,
      renderBattleBuilder,
      renderCommunityViews,
      renderCompareTray,
      renderExplorer,
      renderMovementBoard,
      renderProfile,
      renderRankingLens,
      renderRecommendations,
      resetExplorerWindow,
      scoreButton,
      toggleCompare,
      toggleMovementBoard,
    };
  }

  return { createCatalog };
});
