/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerActivation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";
  const { html } = StrataHtml;

  function createController({
    state,
    el,
    storage,
    activation,
    logic,
    planMovementCount,
    validateWeekPlan,
    planConflictSummary,
    renderActivationOverview,
    flushSave,
    api,
    readSelectedDay,
    selectionContext,
    persistSelectedDay,
    clearSavedDraft,
    renderWeek,
    renderLibrary,
    setSaveStatus,
    showToast,
    focusSoon,
    signal,
  }) {
    function selectedActivationCandidate() {
      return (
        state.activationCandidates.find(
          (candidate) => candidate.id === state.activationCandidateId,
        ) ||
        state.activationCandidates[0] ||
        null
      );
    }
    function setActivationStatus(message, error = false) {
      const node = el("devicePlanStatus");
      node.textContent = message;
      node.dataset.state = error ? "error" : "";
    }
    function activationOverview(candidate) {
      return renderActivationOverview({
        candidate,
        accountCount: planMovementCount(state.plan),
        deviceCount: planMovementCount(candidate.plan),
      });
    }
    function renderActivationCandidate() {
      const candidate = selectedActivationCandidate();
      if (!candidate) return false;
      const directClaim = logic.isEmptyPlan(state.plan);
      state.activationDirectClaim = directClaim;
      el("devicePlanEyebrow").textContent = directClaim
        ? "Your first week is ready"
        : "Your preview survived";
      StrataHtml.setHtml(
        el("devicePlanTitle"),
        directClaim ? html`Save your <em>week.</em>` : html`Bring your <em>week with you.</em>`,
      );
      el("devicePlanLead").textContent = directClaim
        ? "Your account week is empty. Save this device week directly—there is no existing schedule to compare or replace."
        : "Your account and this browser have different weeks. Nothing has been copied or overwritten. Compare both, then explicitly claim the device week or keep the account week.";
      StrataHtml.setHtml(el("devicePlanOverview"), activationOverview(candidate));
      el("deviceCandidateTitle").textContent = candidate.label;
      StrataHtml.setHtml(el("deviceAccountPlanSummary"), planConflictSummary(state.plan));
      StrataHtml.setHtml(el("deviceCandidatePlanSummary"), planConflictSummary(candidate.plan));
      el("devicePlanComparison").hidden = true;
      el("devicePlanConfirmLabel").hidden = true;
      el("devicePlanConfirm").checked = false;
      el("compareDevicePlan").hidden = directClaim;
      el("keepAccountPlan").hidden = directClaim;
      el("claimDevicePlan").disabled = false;
      StrataHtml.setHtml(
        el("claimDevicePlan"),
        directClaim
          ? html`Save week to my account <span aria-hidden="true">→</span>`
          : html`Use device week <span aria-hidden="true">→</span>`,
      );
      if (!directClaim) el("claimDevicePlan").disabled = true;
      el("compareDevicePlan").setAttribute("aria-expanded", "false");
      StrataHtml.setHtml(
        el("compareDevicePlan"),
        html`Compare both weeks <span aria-hidden="true">↘</span>`,
      );
      setActivationStatus(
        directClaim
          ? "Ready to save. Your empty account week has nothing to overwrite."
          : "No decision has been made. Both copies remain unchanged.",
      );
      return true;
    }
    function hideActivationPanel() {
      state.activationCandidates = [];
      state.activationCandidateId = "";
      state.activationDirectClaim = false;
      el("devicePlanPanel").hidden = true;
    }
    function offerDevicePlan() {
      if (state.guest || !state.user?.id || !state.plan || !activation?.deviceCandidates) {
        hideActivationPanel();
        return false;
      }
      let candidates = [];
      try {
        candidates = activation
          .deviceCandidates(storage)
          .flatMap((candidate) => {
            try {
              return [{ ...candidate, plan: validateWeekPlan(candidate.plan) }];
            } catch {
              return [];
            }
          })
          .filter((candidate) =>
            activation.shouldOffer(storage, {
              userId: state.user.id,
              accountRevision: state.planUpdatedAt,
              accountPlan: state.plan,
              candidate,
            }),
          );
      } catch {
        candidates = [];
      }
      if (!candidates.length) {
        hideActivationPanel();
        return false;
      }
      state.activationCandidates = candidates;
      state.activationCandidateId = candidates[0].id;
      const source = el("devicePlanSource");
      StrataHtml.setHtml(
        source,
        candidates.map(
          (candidate) =>
            html`<option value="${candidate.id}">${candidate.label} · ${planMovementCount(candidate.plan)} movements</option>`,
        ),
      );
      source.value = state.activationCandidateId;
      el("devicePlanSourceLabel").hidden = candidates.length < 2;
      renderActivationCandidate();
      el("devicePlanPanel").hidden = false;
      focusSoon("#devicePlanTitle");
      return true;
    }
    function toggleActivationComparison() {
      if (state.activationDirectClaim) return false;
      const comparison = el("devicePlanComparison"),
        opening = comparison.hidden;
      comparison.hidden = !opening;
      el("devicePlanConfirmLabel").hidden = !opening;
      el("compareDevicePlan").setAttribute("aria-expanded", String(opening));
      StrataHtml.setHtml(
        el("compareDevicePlan"),
        opening
          ? html`Hide comparison <span aria-hidden="true">↖</span>`
          : html`Compare both weeks <span aria-hidden="true">↘</span>`,
      );
      setActivationStatus(
        opening
          ? "Comparison open. Review every day before choosing a week."
          : "Comparison hidden. No decision has been made.",
      );
      if (opening) focusSoon("#deviceCandidateTitle");
    }
    function storeActivationBackup(candidate, reason) {
      if (!activation?.backup)
        throw new Error(
          "The device-week safety tools are unavailable. Reload before choosing a week.",
        );
      return activation.backup(storage, {
        userId: state.user.id,
        accountRevision: state.planUpdatedAt,
        accountPlan: state.plan,
        candidate,
        reason,
      });
    }
    function acknowledgeActivation(candidate, decision, accountPlan = state.plan) {
      activation?.acknowledge?.(storage, {
        userId: state.user.id,
        accountRevision: state.planUpdatedAt,
        accountPlan,
        candidate,
        decision,
      });
    }
    function keepAccountActivationPlan() {
      const candidate = selectedActivationCandidate();
      if (!candidate || state.activationBusy) return false;
      try {
        storeActivationBackup(candidate, "keep-account");
        acknowledgeActivation(candidate, "kept-account");
      } catch (error) {
        setActivationStatus(
          error.message ||
            "This browser could not create the safety copy. Export your account week and try again.",
          true,
        );
        return false;
      }
      hideActivationPanel();
      showToast("Account week kept. The device week remains in a local safety copy.");
      focusSoon("#weekTitle");
      return true;
    }
    async function claimActivationPlan() {
      const candidate = selectedActivationCandidate();
      if (
        !candidate ||
        state.activationBusy ||
        (!state.activationDirectClaim && !el("devicePlanConfirm").checked)
      )
        return false;
      state.activationBusy = true;
      for (const id of [
        "compareDevicePlan",
        "keepAccountPlan",
        "claimDevicePlan",
        "devicePlanSource",
      ])
        el(id).disabled = true;
      setActivationStatus("Saving a safety copy, then checking the latest account revision…");
      try {
        const devicePlan = validateWeekPlan(candidate.plan);
        if (!(await flushSave({ silent: true })))
          throw new Error(
            "Finish saving or resolving the current account week before replacing it.",
          );
        storeActivationBackup(candidate, "claim");
        const result = await api("/api/plan", {
          method: "PUT",
          body: JSON.stringify({
            plan: devicePlan,
            expectedPlanUpdatedAt: state.planUpdatedAt,
            expectedUserId: String(state.user.id),
          }),
        });
        state.plan = validateWeekPlan(result.plan || devicePlan);
        state.planUpdatedAt = Number(result.planUpdatedAt) || state.planUpdatedAt;
        state.selectedDay = readSelectedDay(storage, selectionContext(), state.plan);
        persistSelectedDay();
        state.revision += 1;
        state.savedRevision = state.revision;
        state.lastSaveError = null;
        state.undoRemoval = null;
        clearSavedDraft();
        try {
          acknowledgeActivation(candidate, "claimed", state.plan);
        } catch {
          /* The source week remains local and equality prevents a repeated prompt. */
        }
        hideActivationPanel();
        renderWeek();
        renderLibrary();
        setSaveStatus("Saved");
        showToast(
          "Device week saved to your account. The earlier copies remain in a local safety backup.",
        );
        focusSoon("#weekTitle");
        signal("plan_saved");
        return true;
      } catch (error) {
        if (error.status === 409 && error.code === "PLAN_CHANGED")
          setActivationStatus(
            "Your account week changed in another tab or device. Nothing was overwritten. Reload to compare the latest account week before trying again.",
            true,
          );
        else
          setActivationStatus(
            error.message || "The device week could not be saved. Both copies are still available.",
            true,
          );
        return false;
      } finally {
        state.activationBusy = false;
        for (const id of ["compareDevicePlan", "keepAccountPlan", "devicePlanSource"])
          el(id).disabled = false;
        el("claimDevicePlan").disabled =
          !state.activationDirectClaim && !el("devicePlanConfirm").checked;
      }
    }

    return {
      selectedActivationCandidate,
      setActivationStatus,
      activationOverview,
      renderActivationCandidate,
      hideActivationPanel,
      offerDevicePlan,
      toggleActivationComparison,
      storeActivationBackup,
      acknowledgeActivation,
      keepAccountActivationPlan,
      claimActivationPlan,
    };
  }

  return { createController };
});
