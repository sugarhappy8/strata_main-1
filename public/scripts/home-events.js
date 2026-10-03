/* global module */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataHomeEvents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function bindHomeEvents({ document, window, state, groupOrder, actions }) {
    if (!document || !state || !actions)
      throw new TypeError("Homepage events require document, state, and actions.");
    const el = (id) => document.getElementById(id),
      frame = (callback) => (globalThis.requestAnimationFrame || setTimeout)(callback);
    const recheckAccount = () => {
      if (!document.visibilityState || document.visibilityState === "visible")
        void actions.recheckAccount();
    };

    document.addEventListener("click", (event) => {
      const groupButton = event.target.closest("[data-group]"),
        subButton = event.target.closest("[data-sub]"),
        detailButton = event.target.closest("[data-detail]"),
        addButton = event.target.closest("[data-add-planner]"),
        closeButton = event.target.closest("[data-close-dialog]");
      if (groupButton) actions.selectGroup(groupButton.dataset.group);
      else if (subButton) actions.selectSubfilter(subButton.dataset.sub);
      else if (detailButton) actions.openDetail(detailButton.dataset.detail);
      else if (addButton) actions.addToPlanner(addButton.dataset.addPlanner);
      else if (closeButton)
        actions.closeModal(document.getElementById(closeButton.dataset.closeDialog));
    });

    el("groupTabs").addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const currentButton = event.target.closest("[data-group]");
      if (!currentButton) return;
      event.preventDefault();
      const current = groupOrder.indexOf(currentButton.dataset.group);
      let next = current;
      if (event.key === "ArrowRight") next = (current + 1) % groupOrder.length;
      if (event.key === "ArrowLeft") next = (current - 1 + groupOrder.length) % groupOrder.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = groupOrder.length - 1;
      actions.selectGroup(groupOrder[next]);
    });

    el("searchInput").addEventListener("input", (event) => {
      state.query = event.target.value;
      actions.renderExercises();
    });
    el("equipmentFilter").addEventListener("change", (event) => {
      state.equipment = event.target.value;
      actions.renderExercises();
    });
    el("levelFilter").addEventListener("change", (event) => {
      state.level = event.target.value;
      actions.renderExercises();
    });
    el("sortSelect").addEventListener("change", (event) => {
      state.sort = event.target.value;
      actions.renderExercises();
    });
    el("showAllExercises")?.addEventListener("click", () => {
      state.showAll = true;
      actions.renderExercises();
      el("exerciseList").querySelectorAll("[data-detail]")[10]?.focus();
    });
    el("clearFilters").addEventListener("click", actions.resetFilters);
    el("resetActiveFilters").addEventListener("click", actions.resetFilters);
    el("quickPreviewForm").addEventListener("submit", (event) => {
      event.preventDefault();
      actions.generateQuickPreview();
    });
    for (const button of document.querySelectorAll("[data-preview-starter]"))
      button.addEventListener("click", () =>
        actions.applyPreviewStarter(button.dataset.previewStarter),
      );
    el("quickPreviewForm").addEventListener("change", (event) => {
      if (
        [
          "quickPreviewGoal",
          "quickPreviewGroup",
          "quickPreviewLevel",
          "quickPreviewDays",
          "quickPreviewMinutes",
        ].includes(event.target.id)
      )
        actions.updatePreviewEquipmentOptions({
          announce: event.target.id === "quickPreviewGroup",
        });
      actions.previewPlaceholder("Your choices changed. Generate again to refresh this shortlist.");
      el("quickPreviewStatus").textContent = "Choices updated. Show your shortlist to apply them.";
    });
    el("quickPreviewRankings").addEventListener("click", () => {
      actions.selectGroup(actions.previewGroup(), false);
      const target = el("rankings");
      target.scrollIntoView?.({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      frame(() => target.focus?.({ preventScroll: true }));
    });
    for (const dialog of actions.dialogs) {
      dialog.addEventListener("close", () => {
        actions.syncDialogState();
        actions.restoreModalFocus(dialog);
      });
      dialog.addEventListener("click", (event) => {
        const rect = dialog.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          actions.closeModal(dialog);
      });
    }
    document.addEventListener?.("visibilitychange", recheckAccount);
    window?.addEventListener?.("focus", recheckAccount);
    window?.addEventListener?.("pageshow", (event) => {
      if (event.persisted) recheckAccount();
    });
  }

  // The exercise catalog is the homepage's largest download and only the free-week preview and the rankings use
  // it, so it waits until one of them is needed: a link names one (linked), one is on screen, or the visitor
  // starts scrolling down from the hero. Without IntersectionObserver it loads straight away.
  function watchCatalogDemand({ window, location, sections, linked, onDemand }) {
    let demanded = false,
      observer = null;
    const demand = () => {
      if (demanded) return;
      demanded = true;
      observer?.disconnect();
      onDemand();
    };
    if (linked(location?.hash) || typeof window?.IntersectionObserver !== "function") {
      demand();
      return demand;
    }
    observer = new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) demand();
    });
    for (const section of sections) if (section) observer.observe(section);
    window.addEventListener("hashchange", () => {
      if (linked(location?.hash)) demand();
    });
    window.addEventListener("scroll", demand, { once: true, passive: true });
    return demand;
  }

  return { bindHomeEvents, watchCatalogDemand };
});
