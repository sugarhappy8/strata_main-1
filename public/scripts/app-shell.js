/* The STRATA apps for iPhone (repository sugarhappy8/strata-fitness-ios) and Android
   (sugarhappy8/strata-fitness-android) are native shells around this site. Their web views append
   "StrataApp/<shell version>" to the user agent (each app's capacitor.config.json). This script
   runs in <head>, before the page paints, so pages can adapt with `:root[data-app]` styles (data-app is "ios" or
   "android"). Installing the site makes no sense inside the installed app, so Install links and the install page are
   removed there. Only the app loads its chrome (app-mode.css and app-mode.js: tab bar, top bar, motion, and the
   app-store paywall); writing them here keeps them parser-inserted, so the stylesheet blocks first paint and the script
   runs before the body exists, on every page including ones this file is the only hook in. */
(() => {
  "use strict";
  // The navigation shows the tabs for who is here (site-experience.css). The server keeps the strata_nav cookie
  // at "member" or "plus" while a session is open and clears it when there is none, so a visitor's page never
  // flashes member tabs.
  const audience = /(?:^|;\s*)strata_nav=(member|plus)(?:;|$)/.exec(document.cookie || "");
  document.documentElement.dataset.audience = audience ? audience[1] : "visitor";

  const agent = navigator.userAgent || "",
    match = /\bStrataApp\/(\d+)\b/.exec(agent);
  if (!match) return;
  // The same shell runs on iPhone and Android; Android's web view names itself in the user agent.
  const platform = /\bAndroid\b/.test(agent) ? "android" : "ios";
  document.documentElement.dataset.app = platform;
  window.StrataApp = Object.freeze({ platform, shellVersion: Number(match[1]) });

  if (/^\/install(?:\.html)?\/?$/.test(location.pathname)) {
    location.replace("/");
    return;
  }
  document.write(
    // A constant written while the page parses (see above), not markup built from data.
    // eslint-disable-next-line no-restricted-syntax
    '<link rel="stylesheet" href="/app-mode.css?v=10.1.1" /><script src="/app-mode.js?v=10.1.1"></script>',
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
