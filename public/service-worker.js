"use strict";

const BUILD="8.8.5";
const CACHE_PREFIX="strata-static-";
// Every release refreshes this complete versioned set before the worker takes control.
const STATIC_CACHE=`${CACHE_PREFIX}${BUILD}`;
const PRECACHE_URLS=[
  "/experience.css?v=8.8.5",
  "/site-experience.css?v=8.8.5",
  "/fonts.css?v=8.8.5",
  "/product-signals.css?v=8.8.5",
  "/product-signals.js?v=8.8.5",
  "/motion.js?v=8.8.5",
  "/offline.html",
  "/workout-offline.html",
  "/install.html",
  "/pricing.html",
  "/contact.html",
  "/policies.html",
  "/terms.html",
  "/privacy.html",
  "/refunds.html",
  "/planner.html",
  "/workout.css?v=8.8.5",
  "/workout.js?v=8.8.5",
  "/workout-core.js?v=8.8.5",
  "/workout-state.js?v=8.8.5",
  "/workout-api.js?v=8.8.5",
  "/workout-calendar.js?v=8.8.5",
  "/workout-progression.js?v=8.8.5",
  "/workout-render.js?v=8.8.5",
  "/workout-context.js?v=8.8.5",
  "/workout-guidance.js?v=8.8.5",
  "/workout-history.js?v=8.8.5",
  "/workout-events.js?v=8.8.5",
  "/workout-offline.css?v=8.8.5",
  "/workout-offline.js?v=8.8.5",
  "/onboarding.css?v=8.8.5",
  "/product-nav.css?v=8.8.5",
  "/onboarding.js?v=8.8.5",
  "/onboarding-core.js?v=8.8.5",
  "/activation-core.js?v=8.8.5",
  "/activation-handoff.js?v=8.8.5",
  "/activation-home.js?v=8.8.5",
  "/plan-insights-core.js?v=8.8.5",
  "/install.css?v=8.8.5",
  "/install.js?v=8.8.5",
  "/offline.js?v=8.8.5",
  "/site-info.css?v=8.8.5",
  "/pricing-logic.js?v=8.8.5",
  "/pricing-state.js?v=8.8.5",
  "/pricing-api.js?v=8.8.5",
  "/pricing-render.js?v=8.8.5",
  "/pricing-events.js?v=8.8.5",
  "/pricing.js?v=8.8.5",
  "/contact.js?v=8.8.5",
  "/pwa.js?v=8.8.5",
  "/styles.css?v=8.8.5",
  "/home-logic.js?v=8.8.5",
  "/home-state.js?v=8.8.5",
  "/home-api.js?v=8.8.5",
  "/home-render.js?v=8.8.5",
  "/home-events.js?v=8.8.5",
  "/app.js?v=8.8.5",
  "/account.css?v=8.8.5",
  "/account-logic.js?v=8.8.5",
  "/account-state.js?v=8.8.5",
  "/account-api.js?v=8.8.5",
  "/account-render.js?v=8.8.5",
  "/account-events.js?v=8.8.5",
  "/account.js?v=8.8.5",
  "/account-recovery.js?v=8.8.5",
  "/planner.css?v=8.8.5",
  "/planner-logic.js?v=8.8.5",
  "/planner-state.js?v=8.8.5",
  "/planner-api.js?v=8.8.5",
  "/planner-render.js?v=8.8.5",
  "/planner-conflicts.js?v=8.8.5",
  "/planner-templates.js?v=8.8.5",
  "/planner-sharing.js?v=8.8.5",
  "/planner-activation.js?v=8.8.5",
  "/planner-events.js?v=8.8.5",
  "/planner.js?v=8.8.5",
  "/discover.css?v=8.8.5",
  "/discover-coaching-meals.css?v=8.8.5",
  "/session-selection-core.js?v=8.8.5",
  "/discovery-core.js?v=8.8.5",
  "/preview-core.js?v=8.8.5",
  "/monthly-plan-core.js?v=8.8.5",
  "/personal-training-energy-ui-core.js?v=8.8.5",
  "/personal-training-ui-core.js?v=8.8.5",
  "/personal-training-diary-ui.js?v=8.8.5",
  "/personal-training-meals-ui-core.js?v=8.8.5",
  "/discover-state.js?v=8.8.5",
  "/discover-api.js?v=8.8.5",
  "/discover-navigation.js?v=8.8.5",
  "/discover-progress.js?v=8.8.5",
  "/discover-render.js?v=8.8.5",
  "/discover-coaching-render.js?v=8.8.5",
  "/discover-coaching-trend.js?v=8.8.5",
  "/discover-catalog.js?v=8.8.5",
  "/discover-detail.js?v=8.8.5",
  "/discover-community.js?v=8.8.5",
  "/discover-session.js?v=8.8.5",
  "/discover-sharing.js?v=8.8.5",
  "/discover-events.js?v=8.8.5",
  "/discover-coaching.js?v=8.8.5",
  "/discover-coaching-meals.js?v=8.8.5",
  "/discover.js?v=8.8.5",
  "/training-block-core.js?v=8.8.5",
  "/ai.css?v=8.8.5",
  "/ai-logic.js?v=8.8.5",
  "/ai-state.js?v=8.8.5",
  "/ai-api.js?v=8.8.5",
  "/ai-render.js?v=8.8.5",
  "/ai-events.js?v=8.8.5",
  "/ai.js?v=8.8.5",
  "/exercises.json?v=8.8.5",
  "/fonts/manrope-latin.woff2",
  "/fonts/dm-mono-400-latin.woff2",
  "/fonts/dm-mono-500-latin.woff2",
  "/images/hero-training.jpg",
  "/images/training-story.jpg",
  "/manifest.webmanifest",
  "/icons/strata-icon.svg",
  "/icons/strata-192.png",
  "/icons/strata-512.png",
  "/icons/strata-maskable-512.png",
  "/icons/apple-touch-icon.png"
];
const PUBLIC_ASSET_URLS=new Set(PRECACHE_URLS.map((entry) => new URL(entry,self.location.origin).href));
const PRIVATE_HTML_PATHS=new Set(["/","/index.html","/account.html","/verify-email","/verify-email.html","/forgot-password","/forgot-password.html","/reset-password","/reset-password.html","/delete-account","/delete-account.html","/discover.html","/workout.html","/onboarding.html","/ai","/ai.html","/admin","/admin.html"]);
const PUBLIC_HTML_FALLBACKS=new Map([
  ["/install","/install.html"],
  ["/pricing","/pricing.html"],
  ["/contact","/contact.html"],
  ["/policies","/policies.html"],
  ["/terms","/terms.html"],
  ["/privacy","/privacy.html"],
  ["/refunds","/refunds.html"],
  ["/planner","/planner.html"]
]);

function bypassNetwork(pathname) {
  return pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname==="/healthz" || pathname==="/livez" || pathname==="/readyz";
}

self.addEventListener("install",(event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate",(event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key!==STATIC_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function navigationResponse(request,url) {
  try {
    return await fetch(request);
  } catch {
    const cache=await caches.open(STATIC_CACHE);
    const normalizedPath=url.pathname.length>1?url.pathname.replace(/\/+$/g,""):url.pathname;
    const pageKey=normalizedPath.endsWith(".html")?normalizedPath.slice(0,-5):normalizedPath;
    // Paddle appends `_ptxn` to the default payment-link URL. Never serve a
    // cached checkout landing page for that request: the transaction needs a
    // live connection to Paddle and STRATA's server.
    if (pageKey==="/pricing" && url.searchParams.has("_ptxn")) {
      const offline=await cache.match("/offline.html");
      return offline || new Response("STRATA is offline.",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}});
    }
    // This is a generic shell, never the personalized workout page. It can
    // read only a previously authorized, account-scoped device draft and must
    // re-check identity/access before handing the draft back for server sync.
    if (pageKey==="/workout") {
      const workout=await cache.match("/workout-offline.html");
      if (workout) return workout;
    }
    const publicFallback=PUBLIC_HTML_FALLBACKS.get(pageKey);
    if (publicFallback) {
      const page=await cache.match(publicFallback);
      if (page) return page;
    }
    const offline=await cache.match("/offline.html");
    return offline || new Response("STRATA is offline.",{status:503,headers:{"Content-Type":"text/plain; charset=utf-8"}});
  }
}

async function publicAssetResponse(request) {
  const cached=await caches.match(request);
  if (cached) return cached;
  const response=await fetch(request);
  if (response.ok && response.type==="basic") {
    const cache=await caches.open(STATIC_CACHE);
    await cache.put(request,response.clone());
  }
  return response;
}

self.addEventListener("fetch",(event) => {
  const request=event.request;
  if (request.method!=="GET") return;
  const url=new URL(request.url);
  if (url.origin!==self.location.origin || bypassNetwork(url.pathname)) return;
  if (request.mode==="navigate") {
    event.respondWith(navigationResponse(request,url));
    return;
  }
  if (PRIVATE_HTML_PATHS.has(url.pathname) || !PUBLIC_ASSET_URLS.has(url.href)) return;
  event.respondWith(publicAssetResponse(request));
});
