/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerConflicts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";
  const { html } = StrataHtml;

  const DRAFT_PREFIX = "strata_plan_draft_v1:";

  function createController({
    state,
    el,
    storage,
    makeId,
    copyPlan,
    validateWeekPlan,
    planMovementCount,
    planConflictSummary,
    readSelectedDay,
    persistSelectedDay,
    selectionContext,
    api,
    renderWeek,
    renderLibrary,
    renderUndo,
    setSaveStatus,
    showToast,
    focusSoon,
    offerDevicePlan,
  }) {
    function storageScope() {
      return state.guest ? "guest" : `user-${encodeURIComponent(String(state.user?.id || ""))}`;
    }
    function storageEntries(prefix) {
      const entries = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) {
            const value = storage.getItem(key);
            try {
              entries.push({ key, value, data: JSON.parse(value) });
            } catch {
              /* Ignore malformed entries without deleting them. */
            }
          }
        }
      } catch {
        /* Storage may be blocked. */
      }
      return entries;
    }
    function deleteStoredSnapshot(snapshot) {
      if (!snapshot?.key) return;
      try {
        if (storage.getItem(snapshot.key) === snapshot.value) storage.removeItem(snapshot.key);
      } catch {
        /* Keep the recoverable copy when storage is blocked. */
      }
    }
    function persistAccountDraft() {
      if (state.guest || !state.user?.id || !state.plan) return true;
      if (!state.draftKey) state.draftKey = `${DRAFT_PREFIX}${storageScope()}:${makeId()}`;
      const value = JSON.stringify({
        format: "strata-plan-draft",
        version: 1,
        userId: String(state.user.id),
        plan: state.conflictDraft || state.plan,
        baseUpdatedAt: state.planUpdatedAt,
        updatedAt: Date.now(),
      });
      try {
        storage.setItem(state.draftKey, value);
        state.draftValue = value;
        state.draftStorageError = false;
        el("draftStorageNotice").hidden = true;
        return true;
      } catch {
        state.draftStorageError = true;
        el("draftStorageNotice").hidden = false;
        return false;
      }
    }
    function clearSavedDraft() {
      deleteStoredSnapshot({ key: state.draftKey, value: state.draftValue });
      deleteStoredSnapshot(state.recoverySource);
      state.draftValue = "";
      state.recoverySource = null;
    }
    function recoveredDrafts() {
      if (state.guest) return [];
      return storageEntries(`${DRAFT_PREFIX}${storageScope()}:`)
        .filter((entry) => {
          const draft = entry.data;
          if (
            draft?.format !== "strata-plan-draft" ||
            draft.version !== 1 ||
            draft.userId !== String(state.user.id) ||
            !Number.isSafeInteger(draft.baseUpdatedAt) ||
            draft.baseUpdatedAt < 0
          )
            return false;
          try {
            validateWeekPlan(draft.plan, { limits: false });
          } catch {
            return false;
          }
          if (JSON.stringify(draft.plan) === JSON.stringify(state.plan)) {
            deleteStoredSnapshot(entry);
            return false;
          }
          return true;
        })
        .sort((a, b) => (Number(b.data.updatedAt) || 0) - (Number(a.data.updatedAt) || 0));
    }
    function renderPlanConflict() {
      const panel = el("planConflictPanel"),
        local = state.conflictDraft || (state.conflictReview && state.plan);
      if (!state.conflictLatest || !local) {
        panel.hidden = true;
        return;
      }
      StrataHtml.setHtml(el("latestPlanSummary"), planConflictSummary(state.conflictLatest));
      StrataHtml.setHtml(el("localPlanSummary"), planConflictSummary(local));
      el("reviewLocalPlan").hidden = state.conflictReview;
      el("draftRecoveryLabel").hidden = state.recoveredDrafts.length < 2 || state.conflictReview;
      StrataHtml.setHtml(
        el("draftRecoverySelect"),
        state.recoveredDrafts.map(
          (entry, index) =>
            html`<option value="${entry.key}">Draft ${index + 1} · ${new Date(entry.data.updatedAt).toLocaleString()} · ${planMovementCount(entry.data.plan)} movements</option>`,
        ),
      );
      el("draftRecoverySelect").value = state.recoverySource?.key || "";
      panel.hidden = false;
    }
    function selectRecoveredDraft(key) {
      const entry = state.recoveredDrafts.find((draft) => draft.key === key);
      if (!entry || state.conflictReview) return false;
      state.recoverySource = { key: entry.key, value: entry.value };
      state.conflictDraft = copyPlan(entry.data.plan);
      state.conflictLatest = copyPlan(state.plan);
      state.revision = Math.max(state.revision, state.savedRevision + 1);
      state.undoRemoval = null;
      el("plannerShell").inert = true;
      renderPlanConflict();
      renderUndo();
      setSaveStatus("Device draft found · choose a copy", true);
      el("planConflictMessage").textContent =
        `A recoverable draft was found on this device (${new Date(entry.data.updatedAt).toLocaleString()}). Compare it with your account plan. Reviewing does not save anything; Save reviewed changes explicitly replaces the account week and checks for newer changes again.`;
      focusSoon("#planConflictTitle");
      return true;
    }
    function offerRecoveredDraft() {
      state.recoveredDrafts = recoveredDrafts();
      return state.recoveredDrafts.length
        ? selectRecoveredDraft(state.recoveredDrafts[0].key)
        : false;
    }
    function clearPlanConflict() {
      state.conflictDraft = null;
      state.conflictLatest = null;
      state.conflictReview = false;
      el("planConflictPanel").hidden = true;
      el("plannerShell").inert = false;
    }
    async function recoverPlanConflict(error, { silent = false } = {}) {
      let latest = error.data;
      if (
        !latest?.plan?.days ||
        !Number.isSafeInteger(latest.planUpdatedAt) ||
        latest.planUpdatedAt < 0
      )
        latest = await api("/api/plan");
      if (
        !latest?.plan?.days ||
        !Number.isSafeInteger(latest.planUpdatedAt) ||
        latest.planUpdatedAt < 0
      )
        throw new Error(
          "The newer account plan could not be loaded. Refresh this page before editing again.",
        );
      persistAccountDraft();
      state.undoRemoval = null;
      state.conflictDraft = copyPlan(state.plan);
      state.conflictLatest = copyPlan(latest.plan);
      el("planConflictMessage").textContent =
        "Your account changed in another tab or device. Compare both copies, then keep the account version or review your unsaved changes before explicitly saving them.";
      state.conflictReview = false;
      state.plan = copyPlan(latest.plan);
      state.selectedDay = readSelectedDay(storage, selectionContext(), state.plan);
      persistSelectedDay();
      state.planUpdatedAt = latest.planUpdatedAt;
      state.lastSaveError = error;
      el("plannerShell").inert = true;
      renderWeek();
      renderLibrary();
      renderPlanConflict();
      setSaveStatus("Plan changed elsewhere · latest copy loaded", true);
      if (!silent)
        showToast("A newer account plan was loaded. Your unsaved changes are ready to review.");
      focusSoon("#planConflictTitle");
    }
    function reviewConflictDraft() {
      if (state.accountChanged || !state.conflictDraft) return false;
      state.plan = copyPlan(state.conflictDraft);
      state.selectedDay = readSelectedDay(storage, selectionContext(), state.plan);
      persistSelectedDay();
      state.conflictDraft = null;
      state.conflictReview = true;
      state.revision += 1;
      state.lastSaveError = null;
      persistAccountDraft();
      el("plannerShell").inert = false;
      renderWeek();
      renderLibrary();
      renderPlanConflict();
      setSaveStatus("Review recovered changes · save when ready", true);
      showToast("Your unsaved changes are restored for review. Save them when you are ready.");
      focusSoon("#weekTitle");
      return true;
    }
    function keepLatestPlan() {
      if (state.accountChanged || !state.conflictLatest) return false;
      state.plan = copyPlan(state.conflictLatest);
      state.selectedDay = readSelectedDay(storage, selectionContext(), state.plan);
      persistSelectedDay();
      state.savedRevision = state.revision;
      state.lastSaveError = null;
      clearSavedDraft();
      clearPlanConflict();
      renderWeek();
      renderLibrary();
      setSaveStatus("Saved");
      showToast("The latest account plan was kept. Your unsaved copy was discarded.");
      focusSoon("#weekTitle");
      if (!offerRecoveredDraft()) offerDevicePlan();
      return true;
    }

    return {
      persistAccountDraft,
      clearSavedDraft,
      recoveredDrafts,
      selectRecoveredDraft,
      offerRecoveredDraft,
      renderPlanConflict,
      clearPlanConflict,
      recoverPlanConflict,
      reviewConflictDraft,
      keepLatestPlan,
    };
  }

  return { DRAFT_PREFIX, createController };
});
