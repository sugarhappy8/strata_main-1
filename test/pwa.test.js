"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const PROJECT_ROOT=path.join(__dirname,"..");
const PUBLIC_ROOT=path.join(PROJECT_ROOT,"public");
const read=(name)=>fs.readFileSync(path.join(PUBLIC_ROOT,name),"utf8");
const readProject=(name)=>fs.readFileSync(path.join(PROJECT_ROOT,name),"utf8");
const RELEASE=JSON.parse(readProject("package.json"));
const BUILD=RELEASE.strataBuild||RELEASE.version;
const escapeRegExp=(value)=>String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

function pngDimensions(file) {
  const body=fs.readFileSync(path.join(PUBLIC_ROOT,file));
  assert.deepEqual([...body.subarray(0,8)],[137,80,78,71,13,10,26,10],`${file} must be a PNG`);
  assert.equal(body.subarray(12,16).toString("ascii"),"IHDR",`${file} must start with an IHDR chunk`);
  return {width:body.readUInt32BE(16),height:body.readUInt32BE(20)};
}

function serviceWorkerHarness({cacheKeys=[]}={}) {
  const listeners={},precache=[],deletedCaches=[],cachePuts=[],lifecycle={claimed:false,skipped:false},offlineResponse={kind:"offline"};
  const networkResponse={kind:"network",ok:true,type:"basic",clone(){return this;}};
  const pageResponses=new Map(["install","pricing","contact","policies","terms","privacy","refunds","planner","workout-offline"].map((name)=>[`/${name}.html`,{kind:name}]));
  let networkFails=false;
  const cache={
    async addAll(urls){precache.push(...urls);},
    async match(request){
      const value=typeof request==="string"?request:new URL(request.url).pathname;
      return value==="/offline.html"?offlineResponse:pageResponses.get(value);
    },
    async put(request,response){cachePuts.push({request,response});}
  };
  const context={
    URL,Response,
    self:{
      location:{origin:"https://strata.test"},
      addEventListener(type,handler){listeners[type]=handler;},
      async skipWaiting(){lifecycle.skipped=true;},
      clients:{async claim(){lifecycle.claimed=true;}}
    },
    caches:{
      async open(){return cache;},
      async match(request){return cache.match(request);},
      async keys(){return [...cacheKeys];},
      async delete(key){deletedCaches.push(key);return true;}
    },
    async fetch(){if(networkFails)throw new Error("offline");return networkResponse;}
  };
  vm.createContext(context);
  vm.runInContext(read("service-worker.js"),context,{filename:"service-worker.js"});
  return {listeners,precache,deletedCaches,cachePuts,lifecycle,offlineResponse,networkResponse,pageResponses,setOffline(value){networkFails=value;}};
}

function dispatchServiceWorkerFetch(handler,pathName,{method="GET",mode="same-origin",origin="https://strata.test"}={}) {
  let response;
  handler({
    request:{method,mode,url:`${origin}${pathName}`},
    respondWith(value){response=Promise.resolve(value);}
  });
  return response;
}

function browserHarness(scriptName,{userAgent="Mozilla/5.0",maxTouchPoints=0,pwa}={}) {
  const listeners={};
  const window={
    listeners,
    addEventListener(type,handler){(listeners[type]||=[]).push(handler);},
    dispatchEvent(event){for(const handler of listeners[event.type]||[])handler(event);return true;},
    matchMedia(){return {matches:false};}
  };
  const registrations=[];
  const navigator={
    userAgent,maxTouchPoints,standalone:false,
    serviceWorker:{async register(...args){registrations.push(args);return {scope:"https://strata.test/"};}}
  };
  if(pwa)window.StrataPWA=pwa;
  const context={window,navigator,location:{protocol:"https:"},console};
  context.CustomEvent=class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail;}};
  return {context,window,navigator,listeners,registrations,run(){vm.createContext(context);vm.runInContext(read(`scripts/${scriptName}`),context,{filename:scriptName});}};
}

class FakeElement {
  constructor(){this.hidden=true;this.disabled=false;this.textContent="";this.innerHTML="";this.listeners={};this.attributes={};this.classList={values:new Set(),add:(name)=>this.classList.values.add(name),contains:(name)=>this.classList.values.has(name)};}
  addEventListener(type,handler){(this.listeners[type]||=[]).push(handler);}
  async emit(type){for(const handler of this.listeners[type]||[])await handler({type});}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
}

test("release version, cache keys, asset URLs, and catalog claims stay aligned",()=>{
  const exercises=JSON.parse(read("data/exercises.json"));
  const version=BUILD,versionPattern=escapeRegExp(version);
  const serviceWorker=read("service-worker.js");
  const pages=["index.html","account.html","verify-email.html","forgot-password.html","reset-password.html","delete-account.html","admin.html","planner.html","discover.html","onboarding.html","workout.html","workout-offline.html","install.html","offline.html","pricing.html","contact.html","policies.html","terms.html","privacy.html","refunds.html"];

  assert.equal(version,"8.5.0");
  assert.match(serviceWorker,new RegExp(`const BUILD="${versionPattern}";`));
  assert.match(serviceWorker,/const CACHE_PREFIX="strata-static-";/);
  assert.match(serviceWorker,/const STATIC_CACHE=`\$\{CACHE_PREFIX\}\$\{BUILD\}`;/);
  assert.match(serviceWorker,new RegExp(`"/exercises\\.json\\?v=${versionPattern}"`));
  assert.doesNotMatch(serviceWorker,/"\/exercises\.json"/);

  for(const page of pages){
    const html=read(`pages/${page}`);
    if(page!=="admin.html")assert.match(html,new RegExp(`Build ${versionPattern}`,"i"),`${page} visible build label`);
    const localAssets=[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)]
      .map((match)=>new URL(match[1],"https://strata.test"))
      .filter((url)=>url.origin==="https://strata.test");
    assert.ok(localAssets.length>0,`${page} must load a local versioned script or stylesheet`);
    for(const asset of localAssets)assert.equal(asset.searchParams.get("v"),version,`${page} ${asset.pathname} version`);
  }

  for(const entry of [...serviceWorker.matchAll(/"(\/[^"]+\.(?:js|css)(?:\?[^"]*)?)"/g)].map((match)=>match[1])){
    assert.equal(new URL(entry,"https://strata.test").searchParams.get("v"),version,`service-worker precache ${entry}`);
  }
  for(const [file,source] of [["app.js",read("scripts/app.js")],["planner.js",read("scripts/planner.js")]]){
    assert.match(source,new RegExp(`"/exercises\\.json\\?v=${versionPattern}"`),`${file} catalog version`);
    assert.doesNotMatch(source,/"\/exercises\.json"/,`${file} must not request an unversioned catalog`);
  }

  assert.equal(exercises.length,320);
  assert.equal(new Set(exercises.map((exercise)=>exercise.group)).size,8);
  assert.equal(new Set(exercises.map((exercise)=>exercise.sub)).size,26);
  assert.equal(exercises.filter((exercise)=>exercise.equipment==="Bodyweight").length,71);
  const perGroup=Object.values(exercises.reduce((counts,exercise)=>{
    counts[exercise.group]=(counts[exercise.group]||0)+1;
    return counts;
  },{}));
  assert.ok(perGroup.length===8&&perGroup.every((count)=>count>=32));

  assert.match(read("pages/index.html"),/STRATA — Your Next Workout, Ready/i);
  assert.match(read("pages/index.html"),/id="catalogTotal">320</);
  assert.match(read("pages/discover.html"),/id="catalogTotal">320</);
  assert.match(read("pages/planner.html"),/id="libraryCount">320</);
  assert.match(readProject("README.md"),/320 resistance-training exercises—including 71 bodyweight options—across 8 muscle groups and 26 sub-muscle targets/);
});

test("manifest has complete install metadata and correctly sized icons",()=>{
  const manifest=JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.id,"/");
  assert.equal(manifest.name,"STRATA Fitness");
  assert.equal(manifest.short_name,"STRATA");
  assert.equal(manifest.start_url,"/");
  assert.equal(manifest.scope,"/");
  assert.match(manifest.display,/^(standalone|fullscreen|minimal-ui)$/);
  assert.match(manifest.theme_color,/^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color,/^#[0-9a-f]{6}$/i);
  assert.equal(manifest.prefer_related_applications,false);
  assert.deepEqual(manifest.shortcuts.map(({name,url})=>({name,url})),[
    {name:"Strata+ Studio",url:"/discover.html"},
    {name:"Weekly Planner",url:"/planner.html"},
    {name:"Workout Room",url:"/workout.html"},
    {name:"Exercise Rankings",url:"/#rankings"}
  ]);

  const anyIcons=manifest.icons.filter((icon)=>String(icon.purpose||"any").split(/\s+/).includes("any"));
  const maskableIcons=manifest.icons.filter((icon)=>String(icon.purpose||"").split(/\s+/).includes("maskable"));
  const icon192=anyIcons.find((icon)=>icon.sizes.split(/\s+/).includes("192x192"));
  const icon512=anyIcons.find((icon)=>icon.sizes.split(/\s+/).includes("512x512"));
  assert.ok(icon192,"manifest needs a 192×192 any-purpose icon");
  assert.ok(icon512,"manifest needs a 512×512 any-purpose icon");
  assert.ok(maskableIcons.some((icon)=>icon.sizes.split(/\s+/).includes("512x512")),"manifest needs a 512×512 maskable icon");

  for(const icon of manifest.icons) {
    assert.equal(icon.type,"image/png");
    const relative=icon.src.replace(/^\//,"");
    assert.ok(fs.existsSync(path.join(PUBLIC_ROOT,relative)),`${icon.src} must exist`);
    const declared=icon.sizes.match(/^(\d+)x(\d+)$/);
    assert.ok(declared,`${icon.src} must declare one exact size`);
    assert.deepEqual(pngDimensions(relative),{width:Number(declared[1]),height:Number(declared[2])});
  }
  assert.deepEqual(pngDimensions("icons/apple-touch-icon.png"),{width:180,height:180});
});

test("every ordinary app page exposes consistent PWA and mobile metadata",()=>{
  const appPages=["index.html","account.html","verify-email.html","forgot-password.html","planner.html","discover.html","onboarding.html","workout.html","install.html","pricing.html","contact.html","policies.html","terms.html","privacy.html","refunds.html"];
  for(const page of appPages) {
    const html=read(`pages/${page}`);
    assert.match(html,/<meta\s+name="viewport"\s+content="[^"]*width=device-width[^"]*viewport-fit=cover[^"]*"\s*\/>/i,`${page} viewport`);
    assert.match(html,/<meta\s+name="theme-color"\s+content="#[0-9a-f]{6}"\s*\/>/i,`${page} theme color`);
    assert.match(html,/<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"\s*\/>/i,`${page} iOS app mode`);
    assert.match(html,/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/>/i,`${page} manifest`);
    assert.match(html,/<link\s+rel="apple-touch-icon"\s+href="\/icons\/apple-touch-icon\.png"\s*\/>/i,`${page} Apple icon`);
    assert.match(html,/<script\s+src="\/pwa\.js\?v=[^"]+"[^>]*><\/script>/i,`${page} PWA registration`);
    if(page!=="install.html")assert.match(html,/href="\/install(?:\.html)?"/,`${page} install guide link`);
  }
  const offline=read("pages/offline.html");
  assert.match(offline,/href="\/manifest\.webmanifest"/);
  assert.match(offline,/Reconnect to sign in or sync account changes\./);
  assert.match(offline,/id="offlineRetry"[^>]*type="button"/);
  assert.match(offline,/href="\/planner\.html"[^>]*>[\s\S]*?Offline planner[\s\S]*?week kept on this device/);
  assert.match(offline,/href="\/policies"[^>]*>[\s\S]*?Cached reference/);
  assert.match(offline,new RegExp(`src="/offline\\.js\\?v=${escapeRegExp(BUILD)}"`));

  const workoutOffline=read("pages/workout-offline.html");
  assert.match(workoutOffline,/name="viewport"[^>]*viewport-fit=cover/i);
  assert.match(workoutOffline,/This shell contains no cached account page or private API response/i);
  assert.match(workoutOffline,/id="syncWorkout"[^>]*>Review &amp; sync</i);
  assert.doesNotMatch(workoutOffline,/src="\/pwa\.js/i,"the cached recovery shell must not register another worker");
});

test("bearer-link pages stay mobile friendly but do not initialize the PWA",()=>{
  for(const page of ["reset-password.html","delete-account.html"]) {
    const html=read(`pages/${page}`);
    assert.match(html,/<meta\s+name="viewport"\s+content="[^"]*width=device-width[^"]*viewport-fit=cover[^"]*"\s*\/>/i,`${page} viewport`);
    assert.match(html,/<meta\s+name="theme-color"\s+content="#[0-9a-f]{6}"\s*\/>/i,`${page} theme color`);
    assert.match(html,/<meta\s+name="referrer"\s+content="no-referrer"\s*\/>/i,`${page} referrer policy`);
    assert.doesNotMatch(html,/href="\/manifest\.webmanifest"/i,`${page} manifest`);
    assert.doesNotMatch(html,/src="\/pwa\.js/i,`${page} PWA registration`);
    assert.match(html,new RegExp(`src="/account-recovery\\.js\\?v=${escapeRegExp(BUILD)}"`),`${page} recovery script`);
  }
});

test("the private admin surface is versioned but never initialized as an offline PWA page",()=>{
  const html=read("pages/admin.html");
  assert.match(html,/<meta\s+name="viewport"\s+content="[^"]*width=device-width[^"]*viewport-fit=cover[^"]*"\s*\/>/i);
  assert.match(html,/<meta\s+name="robots"\s+content="[^"]*noindex[^"]*nofollow[^"]*"\s*\/>/i);
  assert.match(html,/<meta\s+name="referrer"\s+content="no-referrer"\s*\/>/i);
  assert.doesNotMatch(html,/href="\/manifest\.webmanifest"/i);
  assert.doesNotMatch(html,/src="\/pwa\.js/i);
  assert.match(html,new RegExp(`src="/admin\\.js\\?v=${escapeRegExp(BUILD)}"`));
  assert.match(html,new RegExp(`href="/admin\\.css\\?v=${escapeRegExp(BUILD)}"`));
});

test("service worker precaches only public assets and never handles account APIs",async()=>{
  const harness=serviceWorkerHarness();
  let installPromise;
  harness.listeners.install({waitUntil(value){installPromise=value;}});
  await installPromise;
  assert.equal(harness.lifecycle.skipped,true,"the installed worker must activate without waiting for old tabs to close");
  assert.equal(new Set(harness.precache).size,harness.precache.length,"precache entries must stay unique");
  assert.ok(harness.precache.includes("/offline.html"));
  assert.ok(harness.precache.includes("/workout-offline.html"));
  assert.ok(harness.precache.includes("/install.html"));
  assert.ok(harness.precache.includes("/manifest.webmanifest"));
  assert.ok(harness.precache.includes(`/exercises.json?v=${BUILD}`));
  for(const page of ["pricing","contact","policies","terms","privacy","refunds","planner"])assert.ok(harness.precache.includes(`/${page}.html`),`${page} must be precached`);
  assert.ok(harness.precache.includes(`/site-info.css?v=${BUILD}`));
  assert.ok(harness.precache.includes(`/product-nav.css?v=${BUILD}`));
  assert.ok(harness.precache.includes(`/pricing.js?v=${BUILD}`));
  assert.ok(harness.precache.includes(`/offline.js?v=${BUILD}`));
  assert.ok(harness.precache.includes(`/workout-offline.js?v=${BUILD}`));
  assert.ok(harness.precache.includes(`/workout-offline.css?v=${BUILD}`));
  for(const asset of ["/fonts/manrope-latin.woff2","/fonts/dm-mono-400-latin.woff2","/fonts/dm-mono-500-latin.woff2","/images/hero-training.jpg","/images/training-story.jpg"])assert.ok(harness.precache.includes(asset),`${asset} must remain self-hosted and installable`);
  assert.ok(harness.precache.some((url)=>url.includes("strata-512.png")));
  assert.ok(!harness.precache.some((url)=>url.includes("strata-layers.jpg")),"The lazy homepage artwork must not become an eager PWA install download");

  const paths=harness.precache.map((entry)=>new URL(entry,"https://strata.test").pathname);
  const privateHtml=["/","/index.html","/account.html","/verify-email","/verify-email.html","/forgot-password","/forgot-password.html","/reset-password","/reset-password.html","/delete-account","/delete-account.html","/admin","/admin.html","/discover.html","/onboarding.html","/workout.html"];
  for(const forbidden of privateHtml)assert.ok(!paths.includes(forbidden),`${forbidden} must not be precached`);
  assert.ok(!paths.some((entry)=>entry.startsWith("/api/")||entry.startsWith("/auth/")||entry==="/healthz"),"account and health routes must not be precached");

  for(const endpoint of ["/api/status","/api/me","/api/verification-status","/api/verify-email","/api/resend-verification","/api/password-reset/request","/api/password-reset/status","/api/password-reset/complete","/api/account/password-reset/request","/api/account/delete/request","/api/account/delete/cancel","/api/account/delete/status","/api/account/delete/complete","/api/admin/session","/api/admin/elevate","/api/admin/elevate/verify","/api/admin/overview","/api/admin/users","/api/admin/users/example-user/actions","/api/admin/support","/api/admin/support/example-ticket","/api/admin/audit","/api/billing/config","/api/billing/checkout","/api/paddle/webhook","/auth/login","/auth/signup","/auth/verify-email","/auth/resend-verification","/auth/password-reset/request","/auth/password-reset/complete","/auth/account-delete/complete","/healthz","/livez","/readyz"]) {
    assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,endpoint),undefined,`${endpoint} must bypass the service worker`);
  }
  for(const privatePage of ["/index.html","/account.html","/verify-email","/verify-email.html","/forgot-password","/forgot-password.html","/reset-password","/reset-password.html","/delete-account","/delete-account.html","/admin","/admin.html","/discover.html","/onboarding.html","/workout.html"]) {
    assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,privatePage),undefined,`${privatePage} must bypass runtime asset caching`);
  }
  assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,"/styles.css",{method:"POST"}),undefined,"writes must never be intercepted");
  assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,"/styles.css",{origin:"https://cdn.test"}),undefined,"cross-origin requests must never be intercepted");

  const publicAsset=dispatchServiceWorkerFetch(harness.listeners.fetch,`/styles.css?v=${BUILD}`);
  assert.equal(await publicAsset,harness.networkResponse);
  assert.equal(harness.cachePuts.length,1,"an allowlisted successful same-origin asset may enter the runtime cache");
  assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,"/styles.css?v=unexpected"),undefined,"query variants outside the release allowlist must remain network-only");
  assert.equal(dispatchServiceWorkerFetch(harness.listeners.fetch,"/unlisted.js"),undefined,"unlisted assets must remain network-only");
});

test("service worker activation removes stale STRATA caches without touching unrelated storage",async()=>{
  const active=`strata-static-${BUILD}`;
  const harness=serviceWorkerHarness({cacheKeys:["strata-static-6.0.0",active,"other-app-cache","strata-static-preview"]});
  let activationPromise;
  harness.listeners.activate({waitUntil(value){activationPromise=value;}});
  await activationPromise;
  assert.deepEqual(harness.deletedCaches.sort(),["strata-static-6.0.0","strata-static-preview"]);
  assert.equal(harness.lifecycle.claimed,true,"the current worker must claim pages after cleanup");
});

test("private navigations are network-first and use only purpose-built non-sensitive fallbacks",async()=>{
  const harness=serviceWorkerHarness();
  const online=dispatchServiceWorkerFetch(harness.listeners.fetch,"/planner.html",{mode:"navigate"});
  assert.equal(await online,harness.networkResponse);
  harness.setOffline(true);
  const offline=dispatchServiceWorkerFetch(harness.listeners.fetch,"/account.html",{mode:"navigate"});
  assert.equal(await offline,harness.offlineResponse);
  for(const page of ["/forgot-password","/reset-password","/delete-account","/admin"]) {
    const actionPage=dispatchServiceWorkerFetch(harness.listeners.fetch,page,{mode:"navigate"});
    assert.equal(await actionPage,harness.offlineResponse,`${page} must use only the non-sensitive offline fallback`);
  }
  for(const page of ["/workout","/workout/","/workout.html"]){
    const workout=dispatchServiceWorkerFetch(harness.listeners.fetch,page,{mode:"navigate"});
    assert.equal(await workout,harness.pageResponses.get("/workout-offline.html"),`${page} must use only the generic workout recovery shell`);
  }
});

test("public information pages use their cached page when offline",async()=>{
  const harness=serviceWorkerHarness();
  harness.setOffline(true);
  for(const page of ["pricing","contact","policies","terms","privacy","refunds","planner"]) {
    for(const pathName of [`/${page}`,`/${page}/`,`/${page}.html`]) {
      const response=dispatchServiceWorkerFetch(harness.listeners.fetch,pathName,{mode:"navigate"});
      assert.equal(await response,harness.pageResponses.get(`/${page}.html`),`${pathName} offline fallback`);
    }
  }
  const paddleReturn=dispatchServiceWorkerFetch(harness.listeners.fetch,"/pricing?_ptxn=txn_01m1ky8j916ybyacs836dxbz8x",{mode:"navigate"});
  assert.equal(await paddleReturn,harness.offlineResponse,"Paddle transaction links must never fall back to cached pricing");
});

test("PWA helper registers at full scope and owns the deferred install prompt",async()=>{
  const harness=browserHarness("pwa.js");
  harness.run();
  assert.ok(Object.isFrozen(harness.window.StrataPWA));
  assert.equal(harness.window.StrataPWA.isInstalled(),false);
  assert.equal(harness.window.StrataPWA.canPrompt(),false);

  for(const handler of harness.listeners.load||[])handler();
  await new Promise(setImmediate);
  assert.equal(harness.registrations.length,1);
  assert.equal(harness.registrations[0][0],"/service-worker.js");
  assert.deepEqual({...harness.registrations[0][1]},{scope:"/",updateViaCache:"none"});

  let prevented=false,prompted=0;
  const stateEvents=[];
  harness.window.addEventListener("strata:install-state",(event)=>stateEvents.push(event.detail));
  const installEvent={type:"beforeinstallprompt",preventDefault(){prevented=true;},async prompt(){prompted+=1;},userChoice:Promise.resolve({outcome:"accepted",platform:"web"})};
  harness.window.dispatchEvent(installEvent);
  assert.equal(prevented,true);
  assert.equal(harness.window.StrataPWA.canPrompt(),true);
  const result=await harness.window.StrataPWA.promptInstall();
  assert.equal(result.outcome,"accepted");
  assert.equal(prompted,1);
  assert.equal(harness.window.StrataPWA.canPrompt(),false);
  assert.equal(harness.window.StrataPWA.isInstalled(),true);
  assert.ok(stateEvents.some((state)=>state.canPrompt===true&&state.installed===false));
  assert.ok(stateEvents.some((state)=>state.canPrompt===false&&state.installed===true));
});

test("install guide is beginner-friendly, device-specific, and progressively enhanced",async()=>{
  const html=read("pages/install.html"),css=read("styles/install.css");
  assert.match(html,/<main\s+id="installGuide">/);
  assert.match(html,/id="installStatus"\s+role="status"\s+aria-live="polite"/);
  assert.match(html,/id="installButton"[^>]*type="button"[^>]*hidden/);
  assert.match(css,/\.install-actions \[hidden\]\s*\{\s*display:none;/,"A browser without an install prompt must not render the inactive install button");
  assert.match(html,/no App Store download/i);
  assert.match(html,/No app-store account/);
  assert.match(html,/Updates automatically/);
  assert.match(html,/account still syncs across your devices/i);
  assert.match(html,/saved changes still need an internet connection/i);
  for(const platform of ["ios","android","desktop-chrome","desktop-edge"]) {
    const card=html.match(new RegExp(`<article[^>]+data-platform="${platform}"[\\s\\S]*?<\\/article>`));
    assert.ok(card,`missing ${platform} guide`);
    assert.equal((card[0].match(/<li>/g)||[]).length,4,`${platform} guide should have four steps`);
    assert.match(html,new RegExp(`data-platform-link="${platform}"`),`missing ${platform} jump link`);
  }
  assert.match(html,/Safari[\s\S]*Share[\s\S]*Add to Home Screen/i);
  assert.match(html,/Chrome[\s\S]*Install app[\s\S]*Add to Home screen/i);
  assert.match(html,/Microsoft Edge[\s\S]*Apps[\s\S]*Install this site as an app/i);

  let canPrompt=false,installed=false,promptCount=0;
  const pwa={
    isInstalled:()=>installed,
    canPrompt:()=>canPrompt,
    async promptInstall(){promptCount+=1;installed=true;canPrompt=false;return {outcome:"accepted"};}
  };
  const button=new FakeElement(),status=new FakeElement();
  const cards=new Map(["ios","android","desktop-chrome","desktop-edge"].map((platform)=>{
    const card=new FakeElement(),badge=new FakeElement();
    card.querySelector=()=>badge;
    return [platform,{card,badge}];
  }));
  const platformLinks=new Map(["ios","android","desktop-chrome","desktop-edge"].map((platform)=>[platform,new FakeElement()]));
  const harness=browserHarness("install.js",{userAgent:"Mozilla/5.0 (Linux; Android 15) AppleWebKit Chrome/140 Mobile",pwa});
  harness.context.document={
    getElementById(id){return id==="installButton"?button:id==="installStatus"?status:null;},
    querySelector(selector){
      const cardMatch=selector.match(/^\[data-platform="([^"]+)"\]$/);
      if(cardMatch)return cards.get(cardMatch[1])?.card||null;
      const linkMatch=selector.match(/^\[data-platform-link="([^"]+)"\]$/);
      return linkMatch?platformLinks.get(linkMatch[1])||null:null;
    }
  };
  harness.run();
  assert.equal(cards.get("android").card.classList.contains("recommended"),true);
  assert.equal(cards.get("android").badge.hidden,false);
  assert.equal(platformLinks.get("android").getAttribute("aria-current"),"true");
  assert.equal([...platformLinks.entries()].filter(([platform])=>platform!=="android").every(([,link])=>link.getAttribute("aria-current")===null),true);
  assert.equal(button.hidden,true);
  assert.match(status.textContent,/Chrome.*Install app|Add to Home screen/i);

  canPrompt=true;
  harness.window.dispatchEvent({type:"strata:install-state"});
  assert.equal(button.hidden,false);
  assert.equal(button.disabled,false);
  await button.emit("click");
  assert.equal(promptCount,1);
  assert.equal(button.disabled,true);
  assert.match(button.textContent,/installed/i);
  assert.match(status.textContent,/already running as an installed app/i);

  const unknownButton=new FakeElement(),unknownStatus=new FakeElement();
  const unknownCards=new Map(["ios","android","desktop-chrome","desktop-edge"].map((platform)=>{
    const card=new FakeElement(),badge=new FakeElement();
    card.querySelector=()=>badge;
    return [platform,{card,badge}];
  }));
  const unknownHarness=browserHarness("install.js",{
    userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
    pwa:{isInstalled:()=>false,canPrompt:()=>false,async promptInstall(){return {outcome:"unavailable"};}}
  });
  unknownHarness.context.document={
    getElementById(id){return id==="installButton"?unknownButton:id==="installStatus"?unknownStatus:null;},
    querySelector(selector){const match=selector.match(/^\[data-platform="([^"]+)"\]$/);return match?unknownCards.get(match[1])?.card:null;}
  };
  unknownHarness.run();
  assert.equal([...unknownCards.values()].some(({card})=>card.classList.contains("recommended")),false);
  assert.match(unknownStatus.textContent,/browser menu.*Install app|Add to Home Screen/i);
});
