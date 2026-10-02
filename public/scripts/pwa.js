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

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      void navigator.serviceWorker
        .register("/service-worker.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    });
  }
})();
