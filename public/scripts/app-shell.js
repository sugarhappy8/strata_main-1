/* The STRATA iOS app (mobile/) is a native shell around this site. Its web view appends "StrataApp/<shell version>"
   to the user agent (mobile/capacitor.config.json). This script runs in <head>, before the page paints, so pages can
   adapt with `:root[data-app="ios"]` styles. Installing the site makes no sense inside the installed app, so Install
   links and the install page are removed there. */
(() => {
  "use strict";
  const match = /\bStrataApp\/(\d+)\b/.exec(navigator.userAgent || "");
  if (!match) return;
  document.documentElement.dataset.app = "ios";
  window.StrataApp = Object.freeze({ platform: "ios", shellVersion: Number(match[1]) });

  if (/^\/install(?:\.html)?\/?$/.test(location.pathname)) {
    location.replace("/");
    return;
  }

  function removeInstallLinks() {
    for (const link of document.querySelectorAll('a[href^="/install"]')) {
      // Footers separate links with " · "; drop the separator that belonged to the removed link.
      const before = link.previousSibling;
      if (before && before.nodeType === Node.TEXT_NODE && /^\s*·\s*$/.test(before.textContent || "")) before.remove();
      link.remove();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", removeInstallLinks, { once: true });
  else removeInstallLinks();
})();
