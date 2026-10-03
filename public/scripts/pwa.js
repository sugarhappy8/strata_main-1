"use strict";

(() => {
  let installPrompt = null;
  let installed = false;

  function isStandalone() {
    // Inside the STRATA iOS app (app-shell.js) the site is already installed.
    return (
      installed ||
      Boolean(window.StrataApp) ||
      window.matchMedia?.("(display-mode: standalone)")?.matches ||
      navigator.standalone === true
    );
  }

  function announce() {
    window.dispatchEvent(
      new CustomEvent("strata:install-state", {
        detail: { installed: isStandalone(), canPrompt: Boolean(installPrompt) },
      }),
    );
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    announce();
  });

  window.addEventListener("appinstalled", () => {
    installed = true;
    installPrompt = null;
    announce();
  });

  window.StrataPWA = Object.freeze({
    isInstalled: isStandalone,
    canPrompt: () => Boolean(installPrompt),
    async promptInstall() {
      if (!installPrompt) return { outcome: "unavailable" };
      const prompt = installPrompt;
      installPrompt = null;
      announce();
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === "accepted") installed = true;
      announce();
      return choice || { outcome: "dismissed" };
    },
  });

  // Install lives in the footer and on Profile, not in the main navigation. From a person's second visit (a new
  // browser session), a small dismissible note suggests it once per visit until they install or say "Not now".
  const VISITS = "strata-visits",
    COUNTED = "strata-visit-counted",
    DISMISSED = "strata-install-hint-dismissed";
  function storage(kind) {
    try {
      return window[kind] || null;
    } catch {
      return null;
    }
  }
  function countVisit() {
    const local = storage("localStorage"),
      session = storage("sessionStorage");
    if (!local || !session) return 0;
    try {
      let visits = Number(local.getItem(VISITS)) || 0;
      if (!session.getItem(COUNTED)) {
        visits += 1;
        local.setItem(VISITS, String(visits));
        session.setItem(COUNTED, "1");
      }
      return local.getItem(DISMISSED) ? 0 : visits;
    } catch {
      return 0;
    }
  }
  function suggestInstall() {
    if (isStandalone() || /^\/(?:install|offline)(?:\.html)?\/?$/.test(location.pathname)) return;
    if (countVisit() < 2 || document.getElementById("installHint")) return;
    if (document.getElementById("productSignalsConsent")) return;
    const hint = document.createElement("aside");
    hint.id = "installHint";
    hint.className = "install-hint";
    hint.setAttribute("aria-label", "Install STRATA");
    const text = document.createElement("p");
    text.textContent = "Open STRATA from your home screen, like an app.";
    const install = document.createElement("a");
    install.href = "/install.html";
    install.className = "install-hint-action";
    install.textContent = "Install";
    install.addEventListener("click", async (event) => {
      if (!installPrompt) return;
      event.preventDefault();
      const choice = await window.StrataPWA.promptInstall();
      if (choice.outcome === "accepted") hint.remove();
    });
    const later = document.createElement("button");
    later.type = "button";
    later.className = "install-hint-dismiss";
    later.textContent = "Not now";
    later.addEventListener("click", () => {
      try {
        storage("localStorage")?.setItem(DISMISSED, "1");
      } catch {}
      hint.remove();
    });
    hint.append(text, install, later);
    document.body.append(hint);
    window.addEventListener("strata:install-state", (event) => {
      if (event.detail?.installed) hint.remove();
    });
  }

  const page = globalThis.document;
  if (page?.readyState === "loading")
    page.addEventListener("DOMContentLoaded", suggestInstall, { once: true });
  else if (page) suggestInstall();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      void navigator.serviceWorker
        .register("/service-worker.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    });
  }
})();
