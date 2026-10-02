/* global module, require */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataPlannerTemplates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (StrataHtml) {
  "use strict";

  const TEMPLATE_PREFIX = "strata_week_template_v1:";
  const MAX_TEMPLATES = 12;

  function createController({
    state,
    el,
    storage,
    days,
    makeId,
    validateWeekPlan,
    planConflictSummary,
    firstTrainingDay,
    persistSelectedDay,
    renderWeek,
    renderLibrary,
    queueSave,
    renderUndo,
    showToast,
    focusSoon,
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
    function weekTemplates() {
      return storageEntries(`${TEMPLATE_PREFIX}${storageScope()}:`)
        .filter(
          (entry) =>
            entry.data?.format === "strata-week-template" &&
            entry.data.version === 1 &&
            typeof entry.data.name === "string",
        )
        .sort((a, b) => (Number(b.data.updatedAt) || 0) - (Number(a.data.updatedAt) || 0));
    }
    function renderTemplates() {
      const templates = weekTemplates();
      StrataHtml.setHtml(
        el("weekTemplateSelect"),
        '<option value="">Choose a saved week</option>' +
          templates
            .map(
              (entry) => StrataHtml.html`<option value="${entry.key}">${entry.data.name}</option>`,
            )
            .join(""),
      );
      el("weekTemplateSelect").value = "";
      el("previewWeekTemplate").disabled = true;
      el("templateStatus").textContent = templates.length
        ? `${templates.length} of ${MAX_TEMPLATES} templates saved for this ${state.guest ? "guest" : "account"} on this device.`
        : "No saved templates yet. Name your current week to reuse it later.";
    }
    function openTemplates() {
      if (!state.ready || state.conflictDraft) return false;
      state.templatePreview = null;
      el("templatePreview").hidden = true;
      el("weekTemplateName").value = "";
      el("templateFile").value = "";
      renderTemplates();
      el("weekTemplatesDialog").showModal();
      focusSoon("#weekTemplateName");
      return true;
    }
    function saveWeekTemplate() {
      if (!state.ready || state.conflictDraft) return false;
      const name = el("weekTemplateName").value.trim();
      if (!name || name.length > 60) {
        el("templateStatus").textContent = "Give your template a name using 1–60 characters.";
        el("weekTemplateName").focus();
        return false;
      }
      const templates = weekTemplates();
      if (templates.length >= MAX_TEMPLATES) {
        el("templateStatus").textContent =
          `You have ${MAX_TEMPLATES} templates. Export and delete one before saving another.`;
        return false;
      }
      if (templates.some((entry) => entry.data.name.toLowerCase() === name.toLowerCase())) {
        el("templateStatus").textContent =
          "That name is already saved. Choose a different name to preserve both weeks.";
        return false;
      }
      try {
        const plan = validateWeekPlan(state.plan),
          key = `${TEMPLATE_PREFIX}${storageScope()}:${makeId()}`;
        storage.setItem(
          key,
          JSON.stringify({
            format: "strata-week-template",
            version: 1,
            name,
            updatedAt: Date.now(),
            plan,
          }),
        );
        renderTemplates();
        el("weekTemplateSelect").value = key;
        el("previewWeekTemplate").disabled = false;
        el("templateStatus").textContent =
          `“${name}” saved on this device. Export the week to keep a portable copy.`;
        return true;
      } catch (error) {
        el("templateStatus").textContent =
          error.message || "The browser could not save this template.";
        return false;
      }
    }
    function previewTemplate(plan, name, key = "") {
      try {
        state.templatePreview = {
          plan: validateWeekPlan(plan),
          name: String(name).slice(0, 60),
          key,
          revision: state.revision,
        };
        el("templatePreviewTitle").textContent = state.templatePreview.name;
        StrataHtml.setHtml(
          el("templatePreviewSummary"),
          planConflictSummary(state.templatePreview.plan),
        );
        el("confirmUseTemplate").checked = false;
        el("applyWeekTemplate").disabled = true;
        el("deleteWeekTemplate").hidden = !key;
        el("deleteWeekTemplate").textContent = "Delete saved template";
        el("templatePreview").hidden = false;
        el("templateStatus").textContent =
          "Review this week. Using it replaces the current editable week; it does not create a calendar entry.";
        return true;
      } catch (error) {
        state.templatePreview = null;
        el("templatePreview").hidden = true;
        el("templateStatus").textContent = error.message;
        return false;
      }
    }
    async function importWeekTemplate(file) {
      if (!file) return false;
      state.templatePreview = null;
      el("templatePreview").hidden = true;
      if (file.size > 512000) {
        el("templateStatus").textContent = "Choose a STRATA JSON week smaller than 500 KB.";
        return false;
      }
      try {
        const parsed = JSON.parse(await file.text());
        if (
          !["strata-weekly-plan", "strata-week-template"].includes(parsed?.format) ||
          parsed.version !== 1
        )
          throw new Error("Choose a supported STRATA weekly-plan JSON export.");
        return previewTemplate(parsed.plan, parsed.name || file.name.replace(/\.json$/i, ""));
      } catch (error) {
        el("templateStatus").textContent = error.message || "This file could not be imported.";
        return false;
      }
    }
    function useWeekTemplate() {
      const preview = state.templatePreview;
      if (!preview || !el("confirmUseTemplate").checked || !state.ready || state.conflictDraft)
        return false;
      if (state.revision !== preview.revision) {
        el("templateStatus").textContent =
          "Your current week changed after the preview opened. Preview the template again before replacing it.";
        return false;
      }
      const plan = validateWeekPlan(preview.plan);
      for (const day of days) for (const item of plan.days[day]) item.instanceId = makeId();
      state.plan = plan;
      state.undoRemoval = null;
      state.templatePreview = null;
      state.selectedDay = firstTrainingDay(plan);
      persistSelectedDay();
      el("weekTemplatesDialog").close();
      renderWeek();
      renderLibrary();
      queueSave();
      renderUndo();
      showToast("Template copied into your editable week. Changes follow your usual save status.");
      return true;
    }
    function deleteWeekTemplate() {
      const preview = state.templatePreview;
      if (!preview?.key) return false;
      if (el("deleteWeekTemplate").textContent !== "Confirm delete template") {
        el("deleteWeekTemplate").textContent = "Confirm delete template";
        return false;
      }
      try {
        storage.removeItem(preview.key);
        state.templatePreview = null;
        el("templatePreview").hidden = true;
        renderTemplates();
        return true;
      } catch {
        el("templateStatus").textContent = "This browser could not delete the template.";
        return false;
      }
    }

    return {
      weekTemplates,
      renderTemplates,
      openTemplates,
      saveWeekTemplate,
      previewTemplate,
      importWeekTemplate,
      useWeekTemplate,
      deleteWeekTemplate,
    };
  }

  return { TEMPLATE_PREFIX, MAX_TEMPLATES, createController };
});
