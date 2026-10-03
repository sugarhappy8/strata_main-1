/* global module, require */
/* The STRATA iOS app's chrome. Only the app loads this file (app-shell.js writes it into <head> when the user agent
   carries "StrataApp/<n>"), so browsers never see any of it. It runs before the body exists and:
   - draws one persistent top bar (title, Back on child screens) and bottom tab bar the moment <body> appears, so they
     are part of the first frame and of every view transition snapshot; website headers, footers, and navs are hidden
     by app-mode.css;
   - turns the homepage into Rankings / a free-week preview / a welcome screen, and sends signed-in members to Dashboard;
   - marks each navigation as a tab switch, a push, or Back so app-mode.css can pick the matching transition;
   - talks to the native StrataNative plugin (haptics, printing, screen awake, rest alerts, Calendar, App Store
     transactions) when the app build has it, and keeps Strata+ in sync: every StoreKit transaction update and, once
     per launch, the current entitlements are sent to STRATA, and a transaction is finished only after STRATA accepted
     it. */
(function (root, factory) {
  const StrataHtml =
    typeof module === "object" && module.exports ? require("./html") : root.StrataHtml;
  const api = factory(root, StrataHtml);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataAppMode = api;
  if (root.StrataApp && root.document) api.start();
})(typeof globalThis !== "undefined" ? globalThis : this, function (root, StrataHtml) {
  "use strict";

  const NAV_KEY = "strata-app-nav",
    SYNC_KEY = "strata-app-entitlements-synced",
    MAX_TRANSACTIONS = 20;
  const { html } = StrataHtml;
  const svg = (body) =>
    html`<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const ICONS = Object.freeze({
    rankings: svg(html`<path d="M5 20v-6M12 20V5M19 20v-9"/><path d="M3 20h18"/>`),
    dashboard: svg(
      html`<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>`,
    ),
    train: svg(html`<path d="M6.5 7v10M17.5 7v10M3.5 9.5v5M20.5 9.5v5M6.5 12h11"/>`),
    recovery: svg(html`<path d="M20 12.8A8 8 0 1 1 11.2 4a6.2 6.2 0 0 0 8.8 8.8Z"/>`),
    profile: svg(html`<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>`),
    signin: svg(
      html`<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="m9.5 16 4-4-4-4M13.5 12H4"/>`,
    ),
    plan: svg(
      html`<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17M8 14h3M8 17h6"/>`,
    ),
    plus: svg(html`<path d="M12 3.5 14 9l5.5 2-5.5 2-2 5.5-2-5.5-5.5-2L10 9Z"/>`),
    back: svg(html`<path d="m14.5 5-7 7 7 7"/>`),
  });
  // The tabs are the website's navigation for who is here (site-experience.css reads the same data-audience): a visitor
  // sees what they can use, a signed-in member plans the week, and a Strata+ member has the Strata+ Dashboard.
  const TAB = Object.freeze({
    rankings: { id: "rankings", label: "Rankings", href: "/rankings", section: "rankings" },
    plan: { id: "plan", label: "Plan", href: "/planner.html", section: "week" },
    dashboard: { id: "dashboard", label: "Dashboard", href: "/dashboard", section: "week" },
    plus: { id: "plus", label: "Strata+", href: "/pricing", section: "plus" },
    train: { id: "train", label: "Train", href: "/workout.html", section: "train" },
    recovery: { id: "recovery", label: "Recovery", href: "/recovery", section: "recovery" },
    profile: { id: "profile", label: "Profile", href: "/account.html", section: "profile" },
    signin: {
      id: "signin",
      label: "Sign in",
      href: "/account.html?mode=login",
      section: "profile",
    },
  });
  const TAB_SETS = Object.freeze({
    visitor: Object.freeze([TAB.rankings, TAB.plan, TAB.plus, TAB.signin]),
    member: Object.freeze([TAB.rankings, TAB.plan, TAB.train, TAB.recovery, TAB.profile]),
    plus: Object.freeze([TAB.rankings, TAB.dashboard, TAB.train, TAB.recovery, TAB.profile]),
  });
  const TABS = TAB_SETS.plus;
  /** Who is here, as app-shell.js read it from the strata_nav cookie; anything unknown is a visitor. */
  const audienceOf = (value) => (Object.hasOwn(TAB_SETS, value) ? value : "visitor");
  // Every page in the app: its title, the tab it belongs to, and for a child screen the screen Back returns to.
  // Pages with no chrome keep their own layout (offline pages cannot reach the tabs; admin is a desk tool).
  const SCREENS = Object.freeze([
    { paths: ["/", "/index.html"], id: "home", tab: "rankings", title: "Rankings" },
    {
      paths: ["/dashboard", "/dashboard.html", "/my-week"],
      id: "dashboard",
      tab: "dashboard",
      title: "Dashboard",
    },
    { paths: ["/planner", "/planner.html"], id: "planner", tab: "dashboard", title: "Weekly plan" },
    { paths: ["/discover.html"], id: "studio", tab: "dashboard", title: "Strata+" },
    {
      paths: ["/ai", "/ai.html"],
      id: "ai",
      tab: "dashboard",
      title: "Strata AI",
      parent: "/discover.html",
    },
    {
      paths: ["/onboarding.html"],
      id: "onboarding",
      tab: "dashboard",
      title: "Weekly setup",
      parent: "/dashboard",
    },
    { paths: ["/workout.html"], id: "train", tab: "train", title: "Train" },
    { paths: ["/account.html"], id: "profile", tab: "profile", title: "Profile" },
    {
      paths: ["/pricing", "/pricing.html"],
      id: "pricing",
      tab: "profile",
      title: "Strata+",
      parent: "/account.html",
    },
    {
      paths: ["/contact", "/contact.html"],
      id: "contact",
      tab: "profile",
      title: "Contact",
      parent: "/account.html",
    },
    {
      paths: ["/policies", "/policies.html"],
      id: "policies",
      tab: "profile",
      title: "Policies",
      parent: "/account.html",
    },
    {
      paths: ["/terms", "/terms.html"],
      id: "terms",
      tab: "profile",
      title: "Terms",
      parent: "/policies",
    },
    {
      paths: ["/privacy", "/privacy.html"],
      id: "privacy",
      tab: "profile",
      title: "Privacy",
      parent: "/policies",
    },
    {
      paths: ["/refunds", "/refunds.html"],
      id: "refunds",
      tab: "profile",
      title: "Refunds",
      parent: "/policies",
    },
    {
      paths: ["/delete-account", "/delete-account.html"],
      id: "delete-account",
      tab: "profile",
      title: "Delete account",
      parent: "/account.html",
    },
    {
      paths: ["/verify-email", "/verify-email.html"],
      id: "verify-email",
      tab: "profile",
      title: "Verify email",
      parent: "/account.html",
    },
    {
      paths: ["/forgot-password", "/forgot-password.html"],
      id: "forgot-password",
      tab: "profile",
      title: "Forgot password",
      parent: "/account.html?mode=login",
    },
    {
      paths: ["/reset-password", "/reset-password.html"],
      id: "reset-password",
      tab: "profile",
      title: "Reset password",
      parent: "/account.html?mode=login",
    },
    {
      paths: ["/offline.html", "/workout-offline.html", "/admin", "/admin.html"],
      id: "plain",
      chrome: "none",
    },
  ]);
  const HOME_VIEWS = Object.freeze({
    rankings: "Rankings",
    method: "FitScore",
    sources: "Sources",
    preview: "Free week",
  });
  const STUDIO_TITLES = Object.freeze({ rankings: "Rankings", recovery: "Recovery" });

  const clean = (pathname) => {
    const path = String(pathname || "/");
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  };

  // Pure: which screen a URL is, and which of this audience's tabs it belongs to. A homepage without a section is
  // "start" until the page says who is signed in.
  function resolveScreen({ pathname = "/", hash = "", search = "" } = {}, audience = "visitor") {
    const who = audienceOf(audience),
      reason = new URLSearchParams(search).get("reason");
    const path = clean(pathname),
      found = SCREENS.find((screen) => screen.paths.includes(path));
    const screen = { id: "page", tab: "", title: "STRATA", parent: "", chrome: "tabs", ...found };
    delete screen.paths;
    const section = String(hash || "").replace(/^#/, "");
    if (screen.id === "home") {
      screen.view = Object.hasOwn(HOME_VIEWS, section) ? section : "start";
      screen.title = HOME_VIEWS[screen.view] || "STRATA";
    }
    if (screen.id === "studio") {
      screen.tab =
        section === "exerciseExplorer"
          ? "rankings"
          : section === "recoveryWorkspace"
            ? "recovery"
            : "dashboard";
      screen.title = STUDIO_TITLES[screen.tab] || "Strata+";
    }
    // The weekly plan is the Plan tab; for Strata+ members it is one of Dashboard's destinations.
    if (screen.id === "planner") screen.tab = who === "plus" ? "dashboard" : "plan";
    // A visitor's Profile is the Sign in tab.
    if (screen.tab === "profile" && who === "visitor") screen.tab = "signin";
    if (screen.id === "pricing") {
      // Strata+ is a visitor's own tab; for a member it is the root of the tab that led to it (Recovery, or Train for
      // a Strata+ feature), and otherwise one of Profile's pages.
      const root = (tab) => {
        screen.tab = tab;
        screen.parent = "";
      };
      if (who === "visitor") root("plus");
      else if (reason === "recovery") root("recovery");
      else if (reason === "discovery-required" && who === "member") root("train");
      else if (reason === "ai" && who === "plus") {
        screen.tab = "dashboard";
        screen.parent = "/discover.html";
      }
    }
    return screen;
  }

  // On the Strata+ studio, Rankings and Recovery are panels of the same page, so their tabs switch panels in place
  // and carry data-section: the studio's own navigation then keeps aria-current on the right tab.
  function tabBarHtml(screen, audience = "visitor") {
    const studio = screen.id === "studio";
    const items = TAB_SETS[audienceOf(audience)].map((tab) => {
      const href =
        studio && tab.id === "rankings"
          ? "#exerciseExplorer"
          : studio && tab.id === "recovery"
            ? "#recoveryWorkspace"
            : tab.href;
      const current = tab.id === screen.tab ? html` aria-current="page"` : "";
      return html`<a class="app-tab" href="${href}" data-app-tab="${tab.id}"${studio ? html` data-section="${tab.section}"` : ""}${current}><span class="app-tab-icon">${ICONS[tab.id]}</span><span class="app-tab-label">${tab.label}</span></a>`;
    });
    return html`<nav class="app-tabbar" aria-label="Primary navigation">${items}</nav>`;
  }

  function topBarHtml(screen) {
    const back = screen.parent
      ? html`<a class="app-back" href="${screen.parent}" data-app-back>${ICONS.back}<span>Back</span></a>`
      : "";
    return html`<header class="app-topbar"><div class="app-topbar-inner">${back}<p class="app-title" data-app-title>${screen.title}</p><div class="app-topbar-status" data-app-status></div></div></header>`;
  }

  function welcomeHtml() {
    return html`<section class="app-welcome" aria-labelledby="appWelcomeTitle"><div class="app-welcome-brand"><span class="app-welcome-mark" aria-hidden="true"><i></i><i></i><i></i></span><span>STRATA</span></div><h1 id="appWelcomeTitle">Your next workout. <em>Ready.</em></h1><p>Build a week around your equipment and your time, log every set, and see what you did last time.</p><div class="app-welcome-actions"><a class="app-button app-button-primary" href="/account.html?mode=signup">Create account</a><a class="app-button" href="/account.html?mode=login">Sign in</a></div><nav class="app-welcome-explore" aria-label="Explore without an account"><a href="/#rankings"><strong>Explore the exercise rankings</strong><span>Every movement scored and explained</span></a><a href="/#preview"><strong>Preview a free week</strong><span>No account needed</span></a></nav></section>`;
  }

  function moreHtml(build) {
    const links = [
      ["/pricing", "Strata+", "What it includes"],
      ["/contact", "Contact & support", "Questions, bugs, and billing help"],
      ["/policies", "Policies", "How STRATA works and is run"],
      ["/terms", "Terms of Service", ""],
      ["/privacy", "Privacy Policy", ""],
    ];
    return html`<section class="app-more" aria-labelledby="appMoreTitle"><h2 id="appMoreTitle">More</h2><ul class="app-list">${links.map(([href, label, detail]) => html`<li><a href="${href}"><span>${label}</span>${detail ? html`<small>${detail}</small>` : ""}</a></li>`)}</ul>${build ? html`<p class="app-more-build">${build}</p>` : ""}</section>`;
  }

  // Native bridge. Every call is optional: an older app build has no StrataNative plugin and nothing may break.
  const plugin = () => root.Capacitor?.Plugins?.StrataNative || null;
  function haptic(style = "light") {
    const native = plugin();
    if (typeof native?.haptic !== "function") return;
    try {
      Promise.resolve(native.haptic({ style })).catch(() => {});
    } catch {
      /* Haptics are a nicety; a failure changes nothing. */
    }
  }
  async function print(options = {}) {
    const native = plugin();
    if (typeof native?.print !== "function") return false;
    await native.print(options);
    return true;
  }
  // Newer app builds add methods; has() tells a page whether this build has one. Each wrapper resolves to null (or
  // false) when it does not, and the niceties (screen awake, rest alerts, info) also swallow a native refusal. The
  // calendar sheet passes a refusal on, so its caller can fall back to the .ics download.
  // Capacitor exports each method a build has as an own property of the plugin object.
  const withMethod = (method) => {
    const native = plugin();
    return native && Object.hasOwn(native, method) && typeof native[method] === "function"
      ? native
      : null;
  };
  const has = (method) => Boolean(withMethod(method));
  async function call(method, options = {}, { quiet = true } = {}) {
    const native = withMethod(method);
    if (!native) return null;
    try {
      return (await native[method](options)) || {};
    } catch (error) {
      if (quiet) return null;
      throw error;
    }
  }
  const keepAwake = (enabled) => call("keepAwake", { enabled: enabled === true }).then(Boolean);
  const scheduleRestAlert = ({ endsAt, title = "", body = "" } = {}) =>
    call("scheduleRestAlert", { endsAt: Number(endsAt), title: String(title), body: String(body) });
  const cancelRestAlert = () => call("cancelRestAlert").then(Boolean);
  const addWeeklyToCalendar = (options) => call("addWeeklyToCalendar", options, { quiet: false });
  const info = () => call("info");
  // Keeps the screen-awake flag and the one pending rest alert in step with what a workout page reports, calling the
  // app only when that changes, so a page may report as often as it likes (the workout page does every second).
  // The app lets the screen sleep again whenever it goes to the background, so the first report after a long gap (the
  // page was suspended) asks again. A rest that has run out cancels its alert, which also clears it once seen.
  const RESUME_GAP = 15_000;
  function createWorkoutBridge({ title = "Rest is over", body = "Time for your next set." } = {}) {
    let awake = false,
      alertAt = 0,
      reportedAt = 0;
    function sync({ keepAwake: wantAwake = false, restEndsAt = 0, now = Date.now() } = {}) {
      const want = Boolean(wantAwake),
        resumed = now - reportedAt > RESUME_GAP;
      reportedAt = now;
      if (want !== awake || (want && resumed)) {
        awake = want;
        void keepAwake(awake);
      }
      const requested = Number(restEndsAt) || 0,
        endsAt = requested > now ? requested : 0;
      if (endsAt === alertAt) return;
      // A rest that simply ran out keeps its alert: it has fired (or is firing) while STRATA was in the background, and
      // cancelling would also clear the delivered notification. Only a paused, skipped, replaced, or finished rest cancels.
      if (!endsAt && requested && requested === alertAt) {
        alertAt = 0;
        return;
      }
      alertAt = endsAt;
      if (endsAt) void scheduleRestAlert({ endsAt, title, body });
      else void cancelRestAlert();
    }
    return Object.freeze({ sync });
  }

  function createBilling({
    fetchImpl = (...args) => root.fetch(...args),
    dispatch = (name, detail) => root.dispatchEvent?.(new root.CustomEvent(name, { detail })),
    storage = () => root.sessionStorage,
  } = {}) {
    let accountRequest = null;
    async function requestJson(path, options = {}) {
      let response;
      try {
        response = await fetchImpl(path, {
          ...options,
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.headers || {}),
          },
        });
      } catch (cause) {
        throw Object.assign(
          new Error("Could not reach STRATA. Check your connection and try again."),
          { code: "NETWORK_ERROR", cause },
        );
      }
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw Object.assign(new Error(data?.error || "The request could not be completed."), {
          status: response.status,
          code: data?.code || "REQUEST_FAILED",
        });
      return data && typeof data === "object" ? data : {};
    }
    function account({ fresh = false } = {}) {
      if (fresh || !accountRequest) {
        accountRequest = requestJson("/api/me").then(
          (data) => {
            // A visitor's /api/me is 200 { user: null }; like a 401 it is not kept, so a sign-in is seen next time.
            if (!data.user) accountRequest = null;
            return { user: data.user || null, csrfToken: String(data.csrfToken || "") };
          },
          (error) => {
            accountRequest = null;
            if (error.status === 401) return { user: null, csrfToken: "" };
            throw error;
          },
        );
      }
      return accountRequest;
    }
    async function post(chunk, retried = false) {
      const { user, csrfToken } = await account({ fresh: retried });
      if (!user?.id)
        throw Object.assign(new Error("Sign in to STRATA first."), {
          status: 401,
          code: "SIGN_IN_REQUIRED",
        });
      try {
        return await requestJson("/api/billing/apple/transactions", {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken, "X-Strata-User": String(user.id) },
          body: JSON.stringify({ signedTransactions: chunk }),
        });
      } catch (error) {
        if (!retried && error.code === "INVALID_CSRF") return post(chunk, true);
        throw error;
      }
    }
    // Sends App Store signed transactions to STRATA in batches the server accepts. Returns the newest discovery
    // state and every transaction id STRATA accepted; throws (and finishes nothing) when STRATA rejects them.
    async function submit(signedTransactions) {
      const list = [
        ...new Set(
          (signedTransactions || []).filter((value) => typeof value === "string" && value),
        ),
      ];
      const accepted = [];
      let discovery = null;
      for (let index = 0; index < list.length; index += MAX_TRANSACTIONS) {
        const result = await post(list.slice(index, index + MAX_TRANSACTIONS));
        if (result.discovery && typeof result.discovery === "object") discovery = result.discovery;
        if (Array.isArray(result.accepted)) accepted.push(...result.accepted.map(String));
      }
      if (discovery) dispatch("strata:app-billing", { discovery });
      return { discovery, accepted };
    }
    // A StoreKit update (renewal, Ask to Buy approval, refund, purchase made elsewhere) is finished only once STRATA
    // accepted it. Anything else stays unfinished, so StoreKit delivers it again on the next launch.
    async function handleUpdate(event) {
      const native = plugin(),
        transactionId = String(event?.transactionId || ""),
        signed = event?.signedTransaction;
      if (!native || !transactionId || typeof signed !== "string") return false;
      try {
        const { accepted } = await submit([signed]);
        if (!accepted.includes(transactionId)) return false;
        await native.finishTransaction({ transactionId });
        return true;
      } catch {
        return false;
      }
    }
    function flag() {
      try {
        return storage()?.getItem(SYNC_KEY) === "1";
      } catch {
        return false;
      }
    }
    function setFlag() {
      try {
        storage()?.setItem(SYNC_KEY, "1");
      } catch {
        /* Without storage, the next page simply syncs again. */
      }
    }
    let syncing = null;
    // Once per app launch (sessionStorage lives as long as the web view), a signed-in member's current App Store
    // entitlements are sent so renewals and restores made outside the app reach STRATA.
    function syncEntitlements() {
      if (syncing) return syncing;
      syncing = (async () => {
        const native = plugin();
        if (flag() || typeof native?.currentEntitlements !== "function") return "skipped";
        const { user } = await account();
        if (!user?.id) return "signed-out";
        const { signedTransactions = [] } = (await native.currentEntitlements()) || {};
        if (!signedTransactions.length) {
          setFlag();
          return "empty";
        }
        try {
          await submit(signedTransactions);
          setFlag();
          return "synced";
        } catch (error) {
          if (error.status) setFlag();
          return "rejected";
        }
      })()
        .catch(() => "failed")
        .finally(() => {
          syncing = null;
        });
      return syncing;
    }
    return { account, requestJson, submit, handleUpdate, syncEntitlements };
  }

  const billing = createBilling();

  function readNav() {
    try {
      const value = root.sessionStorage?.getItem(NAV_KEY) || "";
      root.sessionStorage?.removeItem(NAV_KEY);
      return value;
    } catch {
      return "";
    }
  }
  function markNav(kind) {
    try {
      root.sessionStorage?.setItem(NAV_KEY, kind);
    } catch {
      /* Without storage every navigation slides in. */
    }
  }

  function start() {
    const document = root.document,
      html = document.documentElement,
      location = root.location,
      audience = audienceOf(html.dataset.audience);
    let screen = resolveScreen(location, audience);
    html.dataset.appChrome = screen.chrome;
    html.dataset.appScreen = screen.id;
    if (screen.view) html.dataset.appHome = screen.view;
    // :active press feedback only fires on iOS when a touch listener exists.
    document.addEventListener("touchstart", () => {}, { passive: true });
    // The new page decides how it arrives: a tab switch cross-fades, Back slides from the left, anything else
    // pushes in from the right. Swipe-back is animated by the web view itself, so it gets no second animation.
    root.addEventListener("pagereveal", (event) => {
      const kind = readNav(),
        traverse =
          root.navigation?.activation?.navigationType === "traverse" ||
          root.performance?.getEntriesByType?.("navigation")?.[0]?.type === "back_forward";
      html.dataset.appNav = kind || "push";
      if (!kind && traverse) event.viewTransition?.skipTransition?.();
    });
    root.addEventListener("pageshow", (event) => {
      if (event.persisted) html.dataset.appNav = "none";
    });
    if (screen.chrome === "none") return;

    let tabBar = null,
      title = null;
    function setTitle(text) {
      if (title) title.textContent = text;
    }
    function mountChrome() {
      StrataHtml.insertHtml(document.body, "afterbegin", [
        topBarHtml(screen),
        tabBarHtml(screen, audience),
      ]);
      tabBar = document.body.querySelector(".app-tabbar");
      title = document.body.querySelector("[data-app-title]");
      tabBar.addEventListener("click", (event) => {
        const tab = event.target.closest?.("[data-app-tab]");
        if (!tab) return;
        haptic("selection");
        if (tab.getAttribute("aria-current") === "page") {
          // Tapping the tab you are on scrolls back to its top, as in any iOS app.
          event.preventDefault();
          const reduce = root.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
          root.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
          return;
        }
        if (!tab.getAttribute("href").startsWith("#")) markNav("tab");
      });
      document.body.querySelector("[data-app-back]")?.addEventListener("click", (event) => {
        markNav("back");
        let sameOrigin = false;
        try {
          sameOrigin =
            Boolean(document.referrer) && new URL(document.referrer).origin === location.origin;
        } catch {
          /* No usable referrer. */
        }
        if (sameOrigin && root.history.length > 1) {
          event.preventDefault();
          root.history.back();
        }
      });
      // The studio moves aria-current between its panels; the title follows the tab it lands on.
      if (screen.id === "studio")
        new root.MutationObserver(() => {
          const current = tabBar.querySelector('[aria-current="page"]')?.dataset.appTab;
          setTitle(STUDIO_TITLES[current] || "Strata+");
        }).observe(tabBar, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    }
    if (document.body) mountChrome();
    else {
      const observer = new root.MutationObserver(() => {
        if (!document.body) return;
        observer.disconnect();
        mountChrome();
      });
      observer.observe(html, { childList: true });
    }

    function setHomeView(view) {
      html.dataset.appHome = view;
      setTitle(HOME_VIEWS[view] || "STRATA");
    }

    function ready() {
      // Screen readers and keyboards meet the content before the tab bar, as in a native app.
      if (tabBar) document.body.append(tabBar);
      if (screen.id === "home") {
        // The app opens on "/": members continue to Dashboard, everyone else meets a welcome screen instead of the
        // marketing homepage. The server marks a signed-in homepage's account button.
        const signedIn = Boolean(
          document.getElementById("accountButton")?.classList.contains("signed-in"),
        );
        const openHome = () => {
          if (signedIn && !new URLSearchParams(location.search).has("signin")) {
            markNav("tab");
            location.replace("/dashboard");
            return false;
          }
          setHomeView("welcome");
          return true;
        };
        if (screen.view === "start" && !openHome()) return;
        const main = document.querySelector("main");
        if (main) StrataHtml.insertHtml(main, "afterbegin", welcomeHtml());
        root.addEventListener("hashchange", () => {
          screen = resolveScreen(location, audience);
          if (screen.view === "start") {
            if (!openHome()) return;
          } else setHomeView(screen.view);
          root.scrollTo({ top: 0, behavior: "auto" });
        });
        // "Explore this muscle" scrolls to the rankings, which the app shows as its own screen.
        document.getElementById("quickPreviewRankings")?.addEventListener("click", () => {
          location.hash = "rankings";
        });
      }
      if (screen.id === "planner") {
        const status = document.querySelector(".planner-header .header-center"),
          slot = document.querySelector("[data-app-status]");
        if (status && slot) slot.append(status);
      }
      if (screen.id === "profile") {
        const build = document.querySelector("body > footer > span")?.textContent?.trim() || "";
        const accountPage = document.getElementById("accountPage");
        if (accountPage) StrataHtml.insertHtml(accountPage, "beforeend", moreHtml(build));
        // Support asks which app build someone runs; newer builds can say.
        void info().then((app) => {
          const line = document.querySelector(".app-more-build");
          if (line && app?.appVersion)
            line.textContent = `${build} · App ${app.appVersion}${app.build ? ` (${app.build})` : ""}`;
        });
      }
      if (screen.id === "pricing") {
        const script = document.createElement("script");
        script.src = "/app-paywall.js?v=10.0.0";
        document.head.append(script);
      }
      const native = plugin();
      if (native) {
        root.Capacitor?.addListener?.("StrataNative", "transactionUpdated", (event) => {
          void billing.handleUpdate(event);
        });
        const sync = () =>
          root.setTimeout(() => {
            void billing.syncEntitlements();
          }, 800);
        if (document.readyState === "complete") sync();
        else root.addEventListener("load", sync, { once: true });
      }
    }
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", ready, { once: true });
    else ready();
  }

  return Object.freeze({
    TABS,
    TAB_SETS,
    SCREENS,
    ICONS,
    resolveScreen,
    tabBarHtml,
    topBarHtml,
    welcomeHtml,
    moreHtml,
    plugin,
    haptic,
    print,
    has,
    keepAwake,
    scheduleRestAlert,
    cancelRestAlert,
    addWeeklyToCalendar,
    info,
    createWorkoutBridge,
    createBilling,
    billing,
    start,
    NAV_KEY,
    SYNC_KEY,
  });
});
