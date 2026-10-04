"use strict";

(() => {
  const installButton = document.getElementById("installButton");
  const installStatus = document.getElementById("installStatus");
  const pwa = window.StrataPWA;

  function currentPlatform() {
    const agent = navigator.userAgent.toLowerCase();
    const ios =
      /iphone|ipad|ipod/.test(agent) || (/macintosh/.test(agent) && navigator.maxTouchPoints > 1);
    if (ios) return "ios";
    if (/android/.test(agent)) return "android";
    if (/edg\//.test(agent)) return "desktop-edge";
    if (/(?:chrome|chromium)\//.test(agent) && !/(?:opr|opera)\//.test(agent))
      return "desktop-chrome";
    return "";
  }

  const platform = currentPlatform();
  const platformCard = document.querySelector(`[data-platform="${platform}"]`);
  const platformLink = document.querySelector(`[data-platform-link="${platform}"]`);
  if (platformCard) {
    platformCard.classList.add("recommended");
    const badge = platformCard.querySelector(".device-match");
    if (badge) badge.hidden = false;
  }
  if (platformLink) platformLink.setAttribute("aria-current", "true");

  function fallbackMessage() {
    if (platform === "ios")
      return "On iPhone or iPad, use Safari’s Share menu and choose Add to Home Screen.";
    if (platform === "android")
      return "If the install button is not available, use Chrome’s menu and choose Install app or Add to Home screen.";
    if (platform === "desktop-edge")
      return "In Edge, open the menu and choose Apps, then Install this site as an app.";
    if (platform === "desktop-chrome")
      return "In Chrome, use the install icon in the address bar or the browser menu.";
    return "Look in your browser menu for Install app or Add to Home Screen. If neither appears, open STRATA in Chrome or Edge.";
  }

  function updateInstallState() {
    if (pwa?.isInstalled()) {
      installButton.hidden = false;
      installButton.disabled = true;
      installButton.textContent = "STRATA is installed ✓";
      installStatus.textContent = "STRATA is already running as an installed app on this device.";
      return;
    }
    if (pwa?.canPrompt()) {
      installButton.hidden = false;
      installButton.disabled = false;
      StrataHtml.setHtml(
        installButton,
        StrataHtml.html`Install STRATA <span aria-hidden="true">→</span>`,
      );
      installStatus.textContent =
        "This browser can install STRATA now. Use the button or follow the steps for your device.";
      return;
    }
    installButton.hidden = true;
    installButton.disabled = false;
    installStatus.textContent = fallbackMessage();
  }

  window.addEventListener("strata:install-state", updateInstallState);
  installButton.addEventListener("click", async () => {
    installButton.disabled = true;
    installStatus.textContent = "Opening your browser’s install prompt…";
    const result = await pwa?.promptInstall();
    if (result?.outcome === "accepted")
      installStatus.textContent = "Installation started. STRATA will appear with your other apps.";
    else if (result?.outcome === "dismissed")
      installStatus.textContent =
        "Installation was canceled. You can try again whenever you are ready.";
    updateInstallState();
  });

  updateInstallState();
})();
