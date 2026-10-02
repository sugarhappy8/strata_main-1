/* The STRATA iOS app (repository sugarhappy8/strata-fitness-ios) is a native shell around this site. Its web view
   appends "StrataApp/<shell version>" to the user agent (its capacitor.config.json). This script runs in <head>,
   before the page paints, so pages can adapt with `:root[data-app="ios"]` styles. Installing the site makes no
   sense inside the installed app, so Install
   links and the install page are removed there. Only the app loads its chrome (app-mode.css and app-mode.js: tab bar,
   top bar, motion, and the App Store paywall); writing them here keeps them parser-inserted, so the stylesheet blocks
   first paint and the script runs before the body exists, on every page including ones this file is the only hook in. */
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
  document.write(
    '<link rel="stylesheet" href="/app-mode.css?v=9.5.0" /><script src="/app-mode.js?v=9.5.0"></script>',
  );

  function removeInstallLinks() {
    for (const link of document.querySelectorAll('a[href^="/install"]')) {
      // Footers separate links with " · "; drop the separator that belonged to the removed link.
      const before = link.previousSibling;
      if (
        before &&
        before.nodeType === Node.TEXT_NODE &&
        /^\s*·\s*$/.test(before.textContent || "")
      )
        before.remove();
      link.remove();
    }
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", removeInstallLinks, { once: true });
  else removeInstallLinks();
})();
