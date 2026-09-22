"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {readFileSync}=require("node:fs");
const {join}=require("node:path");

const BUILD="8.5.0";
const ROOT=join(__dirname,".."),read=(path)=>readFileSync(join(ROOT,path),"utf8");

test("the service worker uses a generic offline workout shell without caching private pages or APIs",()=>{
  const worker=read("public/service-worker.js"),precache=worker.match(/const PRECACHE_URLS=\[([\s\S]*?)\];/)?.[1]||"";
  assert.match(precache,/"\/workout-offline\.html"/);
  assert.match(precache,new RegExp(`"/workout-offline\\.js\\?v=${BUILD.replaceAll(".","\\.")}"`));
  assert.doesNotMatch(precache,/"\/workout\.html"/);
  assert.doesNotMatch(precache,/\/api\//);
  assert.match(worker,/if \(pageKey==="\/workout"\)[\s\S]*cache\.match\("\/workout-offline\.html"\)/);
  assert.match(worker,/PRIVATE_HTML_PATHS=new Set\(\["\/","\/index\.html","\/account\.html"/);
});

test("offline continuation is bound to a prior account, expiry, exact draft, and online re-verification",()=>{
  const normal=["public/scripts/workout-state.js","public/scripts/workout.js"].map(read).join("\n"),core=read("public/scripts/workout-core.js"),offline=read("public/scripts/workout-offline.js"),html=read("public/pages/workout-offline.html");
  assert.match(normal,/OFFLINE_CONTEXT_KEY="strata_workout_offline_context_v1"/);
  assert.match(normal,/W\.offlineAccessUntil\(discovery\)/);
  assert.match(core,/now\+24\*60\*60\*1000/);
  assert.match(core,/\["cancel","pause"\]\.includes/);
  assert.match(normal,/writeOfflineContext\(state\.draftKey\)/);
  assert.match(normal,/clearOfflineContext\(\);[\s\S]*trainingRoom/);
  assert.match(offline,/context\.userId[\s\S]*context\.ownerId/);
  assert.match(offline,/authorizedUntil\)<=Date\.now\(\)/);
  assert.match(offline,/W\.readDraft\(localStorage\.getItem\(context\.draftKey\),context\.ownerId\)/);
  assert.match(offline,/fetch\("\/api\/me",\{credentials:"same-origin",cache:"no-store"/);
  assert.match(offline,/identity\.user\?\.discovery\?\.active!==true/);
  assert.match(offline,/Number\(latest\.revision\)!==Number\(state\.record\.workout\.revision\)/);
  assert.match(offline,/"Conflict — Review"/);
  assert.match(html,/This shell contains no cached account page or private API response/);
  assert.match(html,/Saved on device/);
  assert.match(html,/Sync pending/);
});

test("the offline page exposes a usable responsive logging and recovery surface",()=>{
  const html=read("public/pages/workout-offline.html"),css=read("public/styles/workout-offline.css");
  for(const id of ["offlineUnavailable","offlineSession","offlineEntries","deviceSaveState","syncState","saveOnDevice","syncWorkout","finishOffline","downloadOfflineDraft","finishOfflineDialog"])assert.match(html,new RegExp(`id="${id}"`),id);
  assert.match(html,/aria-live="polite"/);
  assert.match(html,/aria-labelledby="finishOfflineTitle"/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/@media\(max-width:420px\)/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
});
