"use strict";

const http = require("node:http");
const { readFileSync, existsSync } = require("node:fs");
const { extname, join, normalize } = require("node:path");
const { isIP } = require("node:net");
const { createStore,isUniqueViolation } = require("./database");
const { loadPublicAssets,cachedResponseBody } = require("./static-assets");
const { getEmailVerificationConfig } = require("./email");
const { createAuthService,configuredAdminEmail } = require("./auth");
const { createAdminService } = require("./admin");
const { createWorkoutService } = require("./workouts");
const { createTrainingService } = require("./training");
const { createCoachingService } = require("./coaching");
const { createDevicesService,devicesSettings } = require("./devices");
const { createAiService } = require("./ai");
const { aiSettings,createAiProvider } = require("./ai-provider");
const {createAiQuota}=require("./ai-quota");
const {createAiSettingsService}=require("./ai-settings");
const {createDailyBriefJob}=require("./ai-daily-brief");
const { createSetupService } = require("./setup");
const { createSupportService } = require("./support");
const { createProductSignalsService } = require("./product-signals");
const {adminGrantState}=require("./access-controls");
const {entitlementSettings,tierFor,capabilitiesFor}=require("./entitlements");
const {createEventBus}=require("./events");
const {createDataService}=require("./data-service");
const {profilePayload:coachingProfilePayload}=require("./coaching");
const { createBillingService } = require("./billing");
const {appleBillingSettings,createAppleBillingService}=require("./apple-billing");
const {deliverQueuedCookies}=require("./session-renewal");
const { composeServices } = require("./service-composition");
const { getPaymentConfig } = require("./payments");
const { createLogger,observeRequest } = require("./observability");
const {
  EXERCISES,
  EXERCISE_IDS,DAYS,
  defaultPlan,
  defaultPreferences,
  planStats,
  sanitizePreferences,
  sanitizeRating,
  sanitizePlan,
  expectedPlanRevision,
  sanitizeMonthlyPlan
} = require("./plans");
const {
  securityHeaders,
  responseBody,
  json,
  bodyJson,bodyBuffer,
  bodyForm,
  redirect
} = require("./http");

const PROJECT_ROOT = join(__dirname,"..");
const PUBLIC_ROOT = join(PROJECT_ROOT,"public");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DISCOVERY_DATA = JSON.parse(readFileSync(join(__dirname,"data","discovery-data.json"),"utf8"));
const RELEASE_METADATA = JSON.parse(readFileSync(join(PROJECT_ROOT,"package.json"),"utf8"));
const BUILD_NUMBER = RELEASE_METADATA.strataBuild || RELEASE_METADATA.version;
const PAYMENT_CONFIG = getPaymentConfig(process.env);
const EMAIL_CONFIG = getEmailVerificationConfig(process.env);
const ADMIN_EMAIL = configuredAdminEmail(process.env.ADMIN_EMAIL);
const ENFORCE_PADDLE_IPS=String(process.env.PADDLE_ENFORCE_IP_ALLOWLIST||"").toLowerCase()==="true";
const AI_SETTINGS=aiSettings(process.env);
const APPLE_SETTINGS=appleBillingSettings(process.env);
const ENTITLEMENTS=entitlementSettings(process.env);
const LOGGER=createLogger();
// Browser URLs deliberately remain stable even though files are grouped by
// purpose on disk. Only entries in this map can ever be served publicly.
const STATIC_FILES = new Map([
  ["index.html","pages/index.html"],
  ["account.html","pages/account.html"],
  ["verify-email.html","pages/verify-email.html"],
  ["forgot-password.html","pages/forgot-password.html"],
  ["reset-password.html","pages/reset-password.html"],
  ["delete-account.html","pages/delete-account.html"],
  ["admin.html","pages/admin.html"],
  ["workout.html","pages/workout.html"],
  ["workout.css","styles/workout.css"],
  ["workout.js","scripts/workout.js"],
  ["workout-core.js","scripts/workout-core.js"],
  ["workout-state.js","scripts/workout-state.js"],
  ["workout-api.js","scripts/workout-api.js"],
  ["workout-calendar.js","scripts/workout-calendar.js"],
  ["workout-progression.js","scripts/workout-progression.js"],
  ["workout-render.js","scripts/workout-render.js"],
  ["workout-context.js","scripts/workout-context.js"],
  ["workout-guidance.js","scripts/workout-guidance.js"],
  ["workout-history.js","scripts/workout-history.js"],
  ["workout-events.js","scripts/workout-events.js"],
  ["workout-offline.html","pages/workout-offline.html"],
  ["workout-offline.css","styles/workout-offline.css"],
  ["workout-offline.js","scripts/workout-offline.js"],
  ["onboarding.html","pages/onboarding.html"],
  ["onboarding.css","styles/onboarding.css"],
  ["product-nav.css","styles/product-nav.css"],
  ["onboarding.js","scripts/onboarding.js"],
  ["onboarding-core.js","scripts/onboarding-core.js"],
  ["activation-core.js","scripts/activation-core.js"],
  ["activation-handoff.js","scripts/activation-handoff.js"],
  ["activation-home.js","scripts/activation-home.js"],
  ["training-block-core.js","scripts/training-block-core.js"],
  ["plan-insights-core.js","scripts/plan-insights-core.js"],
  ["planner.html","pages/planner.html"],
  ["discover.html","pages/discover.html"],
  ["ai.html","pages/ai.html"],
  ["ai.css","styles/ai.css"],
  ["ai-chat.css","styles/ai-chat.css"],
  ["ai-logic.js","scripts/ai-logic.js"],
  ["ai-state.js","scripts/ai-state.js"],
  ["ai-api.js","scripts/ai-api.js"],
  ["ai-render.js","scripts/ai-render.js"],
  ["ai-events.js","scripts/ai-events.js"],
  ["ai-conversation.js","scripts/ai-conversation.js"],
  ["ai-widget.js","scripts/ai-widget.js"],
  ["ai.js","scripts/ai.js"],
  ["install.html","pages/install.html"],
  ["offline.html","pages/offline.html"],
  ["pricing.html","pages/pricing.html"],
  ["contact.html","pages/contact.html"],
  ["dashboard.html","pages/dashboard.html"],
  ["policies.html","pages/policies.html"],
  ["terms.html","pages/terms.html"],
  ["privacy.html","pages/privacy.html"],
  ["refunds.html","pages/refunds.html"],
  ["styles.css","styles/styles.css"],
  ["fonts.css","styles/fonts.css"],
  ["tokens.css","styles/tokens.css"],
  ["experience.css","styles/experience.css"],
  ["site-experience.css","styles/site-experience.css"],
  ["product-signals.css","styles/product-signals.css"],
  ["motion.js","scripts/motion.js"],
  ["product-signals.js","scripts/product-signals.js"],
  ["account.css","styles/account.css"],
  ["account-logic.js","scripts/account-logic.js"],
  ["account-state.js","scripts/account-state.js"],
  ["account-api.js","scripts/account-api.js"],
  ["account-render.js","scripts/account-render.js"],
  ["account-events.js","scripts/account-events.js"],
  ["planner.css","styles/planner.css"],
  ["discover.css","styles/discover.css"],
  ["discover-coaching-meals.css","styles/discover-coaching-meals.css"],
  ["install.css","styles/install.css"],
  ["site-info.css","styles/site-info.css"],
  ["dashboard.css","styles/dashboard.css"],
  ["admin.css","styles/admin.css"],
  ["home-logic.js","scripts/home-logic.js"],
  ["home-state.js","scripts/home-state.js"],
  ["home-api.js","scripts/home-api.js"],
  ["home-render.js","scripts/home-render.js"],
  ["home-events.js","scripts/home-events.js"],
  ["app.js","scripts/app.js"],
  ["account.js","scripts/account.js"],
  ["verify-email.js","scripts/verify-email.js"],
  ["account-recovery.js","scripts/account-recovery.js"],
  ["planner-logic.js","scripts/planner-logic.js"],
  ["planner-state.js","scripts/planner-state.js"],
  ["planner-api.js","scripts/planner-api.js"],
  ["planner-render.js","scripts/planner-render.js"],
  ["planner-conflicts.js","scripts/planner-conflicts.js"],
  ["planner-templates.js","scripts/planner-templates.js"],
  ["planner-activation.js","scripts/planner-activation.js"],
  ["planner-events.js","scripts/planner-events.js"],
  ["planner.js","scripts/planner.js"],
  ["session-selection-core.js","scripts/session-selection-core.js"],
  ["entitlements.js","scripts/entitlements.js"],
  ["discovery-core.js","scripts/discovery-core.js"],
  ["preview-core.js","scripts/preview-core.js"],
  ["monthly-plan-core.js","scripts/monthly-plan-core.js"],
  ["personal-training-energy-ui-core.js","scripts/personal-training-energy-ui-core.js"],
  ["personal-training-ui-core.js","scripts/personal-training-ui-core.js"],
  ["personal-training-diary-ui.js","scripts/personal-training-diary-ui.js"],
  ["personal-training-meals-ui-core.js","scripts/personal-training-meals-ui-core.js"],
  ["discover-state.js","scripts/discover-state.js"],
  ["discover-api.js","scripts/discover-api.js"],
  ["discover-navigation.js","scripts/discover-navigation.js"],
  ["discover-progress.js","scripts/discover-progress.js"],
  ["discover-render.js","scripts/discover-render.js"],
  ["discover-coaching-render.js","scripts/discover-coaching-render.js"],
  ["discover-coaching-trend.js","scripts/discover-coaching-trend.js"],
  ["discover-catalog.js","scripts/discover-catalog.js"],
  ["discover-detail.js","scripts/discover-detail.js"],
  ["discover-session.js","scripts/discover-session.js"],
  ["discover-events.js","scripts/discover-events.js"],
  ["discover-coaching.js","scripts/discover-coaching.js"],
  ["discover-program.js","scripts/discover-program.js"],
  ["discover-coaching-meals.js","scripts/discover-coaching-meals.js"],
  ["discover.js","scripts/discover.js"],
  ["devices-core.js","scripts/devices-core.js"],["account-devices.js","scripts/account-devices.js"],["account-delete-dialog.js","scripts/account-delete-dialog.js"],["discover-recovery.js","scripts/discover-recovery.js"],["discover-brief.js","scripts/discover-brief.js"],["workout-recovery.js","scripts/workout-recovery.js"],
  ["install.js","scripts/install.js"],
  ["offline.js","scripts/offline.js"],
  ["pricing-logic.js","scripts/pricing-logic.js"],
  ["pricing-state.js","scripts/pricing-state.js"],
  ["pricing-api.js","scripts/pricing-api.js"],
  ["pricing-render.js","scripts/pricing-render.js"],
  ["pricing-events.js","scripts/pricing-events.js"],
  ["pricing.js","scripts/pricing.js"],
  ["contact.js","scripts/contact.js"],
  ["admin-state.js","scripts/admin-state.js"],
  ["admin-logic.js","scripts/admin-logic.js"],
  ["admin-api.js","scripts/admin-api.js"],
  ["admin-render.js","scripts/admin-render.js"],
  ["admin-session.js","scripts/admin-session.js"],
  ["admin-events.js","scripts/admin-events.js"],
  ["admin.js","scripts/admin.js"],
  ["pwa.js","scripts/pwa.js"],
  ["app-shell.js","scripts/app-shell.js"],
  ["app-mode.js","scripts/app-mode.js"],["app-mode.css","styles/app-mode.css"],["app-paywall.js","scripts/app-paywall.js"],
  ["service-worker.js","service-worker.js"],
  ["manifest.webmanifest","manifest.webmanifest"],
  ["exercises.json","data/exercises.json"],
  ["icons/strata-icon.svg","icons/strata-icon.svg"],
  ["icons/strata-192.png","icons/strata-192.png"],
  ["icons/strata-512.png","icons/strata-512.png"],
  ["icons/strata-maskable-512.png","icons/strata-maskable-512.png"],
  ["icons/apple-touch-icon.png","icons/apple-touch-icon.png"],
  ["images/hero-training.jpg","images/hero-training.jpg"],
  ["images/strata-og.jpg","images/strata-og.jpg"],
  ["fonts/manrope-latin.woff2","fonts/manrope-latin.woff2"],
  ["fonts/dm-mono-400-latin.woff2","fonts/dm-mono-400-latin.woff2"],
  ["fonts/dm-mono-500-latin.woff2","fonts/dm-mono-500-latin.woff2"]
]);
const PAGE_ALIASES = new Map([
  ["/install","install.html"],
  ["/planner","planner.html"],
  ["/pricing","pricing.html"],
  ["/contact","contact.html"],
  ["/policies","policies.html"],
  ["/terms","terms.html"],
  ["/privacy","privacy.html"],
  ["/refunds","refunds.html"],
  ["/verify-email","verify-email.html"],
  ["/forgot-password","forgot-password.html"],
  ["/reset-password","reset-password.html"],
  ["/delete-account","delete-account.html"],
  ["/admin","admin.html"],
  ["/ai","ai.html"],
  ["/dashboard","dashboard.html"]
]);
// The member-aware sections. Rankings and Recovery open the Strata+ studio for members; everyone else gets the
// public rankings and the Strata+ plan that includes Recovery. Dashboard is a two-choice page (Plan or the Strata+
// dashboard) for members; with only Plan to offer, everyone else goes straight to the planner. A null target
// serves the page itself.
const SECTION_ROUTES = new Map([
  ["/rankings",{plus:"/discover.html#exerciseExplorer",member:"/#rankings",visitor:"/#rankings"}],
  ["/dashboard",{plus:null,member:"/planner.html",visitor:"/planner.html"}],
  ["/my-week",{plus:"/dashboard",member:"/planner.html",visitor:"/planner.html"}],
  ["/recovery",{plus:"/discover.html#recoveryWorkspace",member:"/pricing?reason=recovery",visitor:"/pricing?reason=recovery"}]
]);
const PROTECTED_HTML = new Set(["discover.html","workout.html","onboarding.html","ai.html"]);
const PRIVATE_HTML = new Set(["index.html","account.html","dashboard.html","verify-email.html","forgot-password.html","reset-password.html","delete-account.html","admin.html",...PROTECTED_HTML]);
const MIME = {
  ".html":"text/html; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".webmanifest":"application/manifest+json; charset=utf-8",
  ".svg":"image/svg+xml",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".woff2":"font/woff2"
};
let publicAssets=new Map();
let store;
let auth;
let admin;
let support;
let workouts;
let training;
let coaching;
let devices;
let ai,aiSettingsService,briefJob;
let setup;
let productSignals;
let billing,appleBilling;

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g,(char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }

async function planSnapshotFor(userId) {
  const row = await store.plan(userId);
  if (!row) return {plan:defaultPlan(),updatedAt:0,storedPlanJson:null};
  const storedUpdatedAt=Number(row.updated_at);
  const updatedAt=Number.isSafeInteger(storedUpdatedAt)&&storedUpdatedAt>0?storedUpdatedAt:0;
  const storedPlanJson=String(row.plan_json);
  try { return {plan:sanitizePlan(JSON.parse(storedPlanJson),{repair:true}),updatedAt,storedPlanJson}; }
  catch { return {plan:defaultPlan(),updatedAt,storedPlanJson}; }
}

async function planFor(userId) {
  return (await planSnapshotFor(userId)).plan;
}

async function monthlyPlanSnapshotFor(userId) {
  const row=await store.monthlyPlan(userId);
  if (!row) return {plan:null,updatedAt:0};
  try {
    const stored=JSON.parse(row.plan_json);
    const storedGeneratedAt=Number(stored?.generatedAt);
    return {plan:{...sanitizeMonthlyPlan(stored,{
      generatedAt:Number.isSafeInteger(storedGeneratedAt)&&storedGeneratedAt>0?storedGeneratedAt:Number(row.updated_at)
    }),updatedAt:Number(row.updated_at)},updatedAt:Number(row.updated_at)};
  } catch {
    // Keep the revision of a corrupt row so an explicit replacement can recover it.
    return {plan:null,updatedAt:Number(row.updated_at)};
  }
}

async function hasCurrentDiscoveryAccess(userId,now=Date.now()) {
  return billing.hasCurrentAccess(userId,now);
}

async function userPayload(session) {
  const now=Date.now();
  const [plan,paidDiscovery,subscription,apple,deletion,adminState,controls]=await Promise.all([
    planFor(session.id),
    billing.accessSummaryForUser(session.id),
    billing.subscriptionForUser(session.id),
    appleBilling.subscriptionForUser(session.id),
    store.activeAccountDeletion(session.id,now),
    admin.adminIdentity(session),
    store.adminControls(session.id)
  ]);
  const adminGrant=adminGrantState(controls,now);
  const discovery={
    ...paidDiscovery,
    active:paidDiscovery.active||Boolean(apple?.active)||adminGrant.active,
    // "paid" covers a Paddle subscription or a legacy lifetime purchase; the
    // nullable subscription snapshot tells the two apart for the client.
    // "apple" is Strata+ bought in the iOS app; precedence is paid > apple > grant.
    accessType:paidDiscovery.active?"paid":apple?.active?"apple":adminGrant.active?"grant":null,
    adminGrant,checkoutBlocked:Boolean(controls?.checkout_blocked_at),
    subscription,apple
  };
  return {
    id:session.id,
    name:session.name,
    email:session.email,
    createdAt:session.created_at,
    ...planStats(plan),
    discovery,
    capabilities:capabilitiesFor({plusActive:discovery.active},ENTITLEMENTS),
    isAdmin:adminState.active,
    accountDeletion:{pending:Boolean(deletion),expiresAt:deletion?Number(deletion.expires_at):null}
  };
}

async function preferencesSnapshotFor(userId) {
  const row=await store.preferences(userId);
  if (!row) return {preferences:defaultPreferences(),updatedAt:0,storedPreferencesJson:null};
  const storedPreferencesJson=String(row.preferences_json),storedUpdatedAt=Number(row.updated_at);
  const updatedAt=Number.isSafeInteger(storedUpdatedAt)&&storedUpdatedAt>0?storedUpdatedAt:0;
  try { return {preferences:sanitizePreferences(JSON.parse(storedPreferencesJson)),updatedAt,storedPreferencesJson}; }
  catch { return {preferences:defaultPreferences(),updatedAt,storedPreferencesJson}; }
}

async function preferencesFor(userId) {
  return (await preferencesSnapshotFor(userId)).preferences;
}

/** Every member route guards itself with one feature name from src/entitlements.js. */
function requireFeature(feature) {
  const tier=tierFor(feature,ENTITLEMENTS);
  if (tier===null) throw new TypeError(`Unknown feature ${feature}.`);
  return async function requireAccess(req,res) {
    const session=await auth.requireSession(req,res);
    if (!session) return null;
    if (tier==="off") { json(res,403,{error:"This feature is switched off.",code:"FEATURE_UNAVAILABLE",feature}); return null; }
    if (tier==="plus"&&!await hasCurrentDiscoveryAccess(session.id)) {
      json(res,402,{error:"Strata+ purchase required.",code:"DISCOVERY_ACCESS_REQUIRED",feature});
      return null;
    }
    return session;
  };
}
const requireDiscoveryAccess=requireFeature("plus.studio");

function sameOrigin(req) {
  const fetchSite=String(req.headers["sec-fetch-site"]||"").toLowerCase();
  if (fetchSite==="cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const protocol = String(req.headers["x-forwarded-proto"] || (process.env.NODE_ENV === "production" ? "https" : "http")).split(",")[0].trim();
  return origin === `${protocol}://${req.headers.host}`;
}

function trustedAuthOrigin(req) {
  const origin=String(req.headers.origin||"");
  if (!origin||origin==="null") return false;
  const configured=String(process.env.APP_BASE_URL||"").trim();
  if (configured&&process.env.NODE_ENV==="production") {
    try { return origin===new URL(configured).origin; }
    catch { return false; }
  }
  return sameOrigin(req);
}

const rateBuckets = new Map();
function requestAddress(req) {
  const direct=req.socket.remoteAddress||"unknown";
  if (process.env.TRUST_PROXY!=="true") return direct;
  const forwarded=String(req.headers["x-forwarded-for"]||"").split(",").map((value)=>value.trim()).filter((value)=>isIP(value));
  return forwarded.at(-1)||direct;
}

function rateKeyAllowed(key,max=10,windowMs=15*60*1000) {
  const now=Date.now();
  const bucket=(rateBuckets.get(key)||[]).filter((time) => now-time<windowMs);
  if (bucket.length >= max) return false;
  bucket.push(now); rateBuckets.set(key,bucket); return true;
}

function rateAllowed(req,kind,max=10,windowMs=15*60*1000) {
  // Identity buckets apply across addresses; network buckets allow shared Wi-Fi.
  return rateKeyAllowed(kind.startsWith("identity:")?kind:`${kind}:${requestAddress(req)}`,max,windowMs);
}

function healthMethodAllowed(req,res) {
  if(req.method==="GET")return true;
  json(res,405,{error:"Method not allowed."},{Allow:"GET"});
  return false;
}

async function handleReadiness(req,res) {
  if(!healthMethodAllowed(req,res))return;
  try {
    const ok=await store.ping();
    json(res,ok?200:503,{ok});
  } catch {
    json(res,503,{ok:false});
  }
}

function handleLiveness(req,res) {
  if(!healthMethodAllowed(req,res))return;
  json(res,200,{ok:true});
}

async function handleApi(req,res,url) {
  if (url.pathname==="/api/paddle/webhook") { await billing.handleWebhook(req,res); return; }
  if (url.pathname==="/api/billing/apple/notifications") { await appleBilling.handleNotification(req,res); return; }
  if (["POST","PUT","PATCH","DELETE"].includes(req.method) && !sameOrigin(req)) { json(res,403,{error:"Cross-origin request rejected."}); return; }
  if (await productSignals.handleApi(req,res,url)) return;
  if (await support.handleApi(req,res,url)) return;
  if (await auth.handleApi(req,res,url)) return;
  if (await admin.handleApi(req,res,url)) return;
  if (await aiSettingsService.handleApi(req,res,url)) return;
  if (await ai.handleApi(req,res,url)) return;
  if (await dataService.handleApi(req,res,url)) return;
  if (await training.handleApi(req,res,url)) return;
  if (await coaching.handleApi(req,res,url)) return;
  if (await devices.handleApi(req,res,url)) return;
  if (await workouts.handleApi(req,res,url)) return;
  if (await setup.handleApi(req,res,url)) return;
  if (await billing.handleApi(req,res,url)) return;
  if (await appleBilling.handleApi(req,res,url)) return;
  if (url.pathname === "/api/status" && req.method === "GET") {
    json(res,200,{ok:true,build:BUILD_NUMBER,storage:store.kind,persistent:store.kind==="turso"||process.env.NODE_ENV!=="production",paymentsConfigured:PAYMENT_CONFIG.configured,checkoutEnabled:PAYMENT_CONFIG.enabled,appStoreConfigured:APPLE_SETTINGS.configured,webhookIpAllowlist:ENFORCE_PADDLE_IPS,emailVerificationEnabled:EMAIL_CONFIG.enabled,emailVerificationConfigured:EMAIL_CONFIG.configured,passwordResetEnabled:EMAIL_CONFIG.enabled,accountDeletionEnabled:EMAIL_CONFIG.enabled,adminConfigured:Boolean(ADMIN_EMAIL)}); return;
  }
  if (url.pathname === "/api/plan" && req.method === "GET") {
    const session=await auth.requireSession(req,res); if (!session) return;
    const [snapshot,user]=await Promise.all([planSnapshotFor(session.id),userPayload(session)]);
    json(res,200,{plan:snapshot.plan,planUpdatedAt:snapshot.updatedAt,user,csrfToken:session.csrf_token}); return;
  }
  if (url.pathname === "/api/plan" && req.method === "PUT") {
    const session=await auth.requireSession(req,res); if (!session) return;
    if (!auth.validCsrf(req,session)) { json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"}); return; }
    const input=await bodyJson(req), expectedPlanUpdatedAt=expectedPlanRevision(input.expectedPlanUpdatedAt), plan=sanitizePlan(input.plan);
    if (input.expectedUserId!==undefined && String(input.expectedUserId)!==String(session.id)) { json(res,409,{error:"The signed-in account changed. Reload before saving.",code:"ACCOUNT_CHANGED"}); return; }
    const saved=await store.upsertPlan(session.id,JSON.stringify(plan),Date.now(),expectedPlanUpdatedAt);
    if (saved) await events.emit("plan.updated",{userId:session.id,plan,updatedAt:Number(saved.updated_at),source:input.source==="ai"?"ai":"manual",detail:input.source==="ai"?"ai-proposal":"plan-edit"});
    if (!saved) {
      const current=await planSnapshotFor(session.id);
      // A retry after a committed response was lost is not a conflict. The
      // canonical plan is already stored, so return its authoritative revision
      // and let the browser resume from it without asking for an overwrite.
      if (JSON.stringify(current.plan)===JSON.stringify(plan)) {
        json(res,200,{ok:true,plan:current.plan,planUpdatedAt:current.updatedAt,stats:planStats(current.plan),reused:true});
        return;
      }
      json(res,409,{
        error:"Your weekly plan changed in another tab or device. Review the latest copy before saving again.",
        code:"PLAN_CHANGED",
        plan:current.plan,
        planUpdatedAt:current.updatedAt,
        stats:planStats(current.plan)
      });
      return;
    }
    json(res,200,{ok:true,plan,planUpdatedAt:Number(saved.updated_at),stats:planStats(plan)}); return;
  }
  if (url.pathname === "/api/monthly-plan" && req.method === "GET") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    const [monthlyPlan,weeklyPlan]=await Promise.all([monthlyPlanSnapshotFor(session.id),planFor(session.id)]);
    json(res,200,{monthlyPlan:monthlyPlan.plan,monthlyPlanUpdatedAt:monthlyPlan.updatedAt,weeklyPlan,csrfToken:session.csrf_token}); return;
  }
  if (url.pathname === "/api/monthly-plan" && req.method === "PUT") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    if (!auth.validCsrf(req,session)) { json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"}); return; }
    const input=await bodyJson(req), expected=expectedPlanRevision(input.expectedUpdatedAt);
    const now=Math.max(Date.now(),expected+1),monthlyPlan=sanitizeMonthlyPlan(input.monthlyPlan,{generatedAt:now});
    const saved=await store.upsertMonthlyPlan(session.id,JSON.stringify(monthlyPlan),now,expected);
    if (!saved) {
      json(res,409,{error:"A newer monthly plan was saved on another tab. Your setup is unchanged. Reload to review the saved plan before generating again.",code:"MONTHLY_PLAN_CONFLICT"}); return;
    }
    json(res,200,{ok:true,monthlyPlan:{...monthlyPlan,updatedAt:Number(saved.updated_at)}}); return;
  }
  if (url.pathname === "/api/discovery" && req.method === "GET") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    const [preferences,aggregates,userRatings,monthlyPlan,weeklyPlan,user]=await Promise.all([preferencesFor(session.id),store.ratingAggregates(),store.ratingsForUser(session.id),monthlyPlanSnapshotFor(session.id),planSnapshotFor(session.id),userPayload(session)]);
    json(res,200,{user,csrfToken:session.csrf_token,exercises:EXERCISES,methodology:DISCOVERY_DATA.methodology,sources:DISCOVERY_DATA.sources,limitedConfidenceExercises:DISCOVERY_DATA.limitedConfidenceExercises,preferences,ratings:{aggregates,user:userRatings},monthlyPlan:monthlyPlan.plan,monthlyPlanUpdatedAt:monthlyPlan.updatedAt,weeklyPlan:weeklyPlan.plan,weeklyPlanUpdatedAt:weeklyPlan.updatedAt}); return;
  }
  if (url.pathname === "/api/ratings/aggregates" && req.method === "GET") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    const aggregates=await store.ratingAggregates();
    // This deliberately contains community aggregates only. Never include a
    // user row, email address, per-account rating, or session credential here.
    json(res,200,{aggregates,updatedAt:Date.now()}); return;
  }
  if (url.pathname === "/api/preferences" && req.method === "PUT") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    if (!auth.validCsrf(req,session)) { json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"}); return; }
    const input=await bodyJson(req), preferences=sanitizePreferences(input.preferences);
    await store.upsertPreferences(session.id,JSON.stringify(preferences),Date.now());
    await events.emit("preferences.saved",{userId:session.id,preferences});
    json(res,200,{ok:true,preferences}); return;
  }
  const ratingMatch=url.pathname.match(/^\/api\/ratings\/([a-z0-9-]{2,80})$/);
  if (ratingMatch && req.method === "PUT") {
    const session=await requireDiscoveryAccess(req,res); if (!session) return;
    if (!trustedAuthOrigin(req)) { json(res,403,{error:"Rating security check failed. Refresh and try again.",code:"RATING_ORIGIN_REQUIRED"}); return; }
    if (!auth.validCsrf(req,session)) { json(res,403,{error:"Security check failed. Refresh and try again.",code:"INVALID_CSRF"}); return; }
    const exerciseId=ratingMatch[1];
    if (!EXERCISE_IDS.has(exerciseId)) { json(res,404,{error:"Exercise not found."}); return; }
    if (!rateAllowed(req,`rating:${session.id}`,60)) { json(res,429,{error:"Too many rating updates. Try again later."}); return; }
    const input=await bodyJson(req), rating=sanitizeRating(input.rating), now=Date.now();
    await store.upsertRating(session.id,exerciseId,rating,now,now);
    json(res,200,{ok:true,rating:{exercise_id:exerciseId,...rating,updated_at:now},aggregate:await store.ratingAggregate(exerciseId)}); return;
  }
  json(res,404,{error:"API route not found."});
}

async function serveStatic(req,res,url) {
  const aliasPath=url.pathname.length>1?url.pathname.replace(/\/+$/g,""):url.pathname;
  const requested = aliasPath === "/"
    ? "index.html"
    : PAGE_ALIASES.has(aliasPath)
      ? PAGE_ALIASES.get(aliasPath)
      : normalize(url.pathname).replace(/^[/\\]+/,"");
  const section=SECTION_ROUTES.get(requested==="dashboard.html"?"/dashboard":aliasPath);
  if (section) {
    const session=await auth.sessionFor(req),plus=Boolean(session&&await hasCurrentDiscoveryAccess(session.id));
    const location=plus?section.plus:session?section.member:section.visitor;
    if (location) {
      res.writeHead(302,{...securityHeaders(),Location:location,"Cache-Control":"private, no-store",Vary:"Cookie"});
      res.end();
      return;
    }
  }
  if (!STATIC_FILES.has(requested)) { json(res,404,{error:"Page not found."}); return; }
  const activeSession=(PROTECTED_HTML.has(requested)||requested==="index.html"||requested==="admin.html")?await auth.sessionFor(req):null;
  if (requested==="admin.html") {
    if (!activeSession) {
      res.writeHead(302,{...securityHeaders(),Location:"/account.html?mode=login&next=admin","Cache-Control":"no-store"});
      res.end();
      return;
    }
    const identity=await admin.adminIdentity(activeSession,{allowBootstrap:true});
    if (identity.boundNow) {
      const params=new URLSearchParams({mode:"login",next:"admin",error:"Admin ownership is secured. Sign in again to continue."});
      res.writeHead(302,{...securityHeaders(),Location:`/account.html?${params}`,"Cache-Control":"no-store","Set-Cookie":auth.sessionCookie("",0)});
      res.end();
      return;
    }
    if (!identity.active) {
      const params=new URLSearchParams({mode:"login",next:"admin",error:"Administrator access required."});
      res.writeHead(302,{...securityHeaders(),Location:`/account.html?${params}`,"Cache-Control":"no-store"});
      res.end();
      return;
    }
  }
  if (PROTECTED_HTML.has(requested) && !activeSession) {
    const params=new URLSearchParams({mode:"login",next:requested.replace(".html","")});
    const day=url.searchParams.get("day");
    if (requested==="workout.html"&&DAYS.includes(day)) params.set("next",`/workout.html?day=${day}`);
    res.writeHead(302,{...securityHeaders(),Location:`/account.html?${params}`,"Cache-Control":"no-store"});
    res.end();
    return;
  }
  if (PROTECTED_HTML.has(requested)&&!await hasCurrentDiscoveryAccess(activeSession.id)) {
    res.writeHead(302,{...securityHeaders(),Location:requested==="ai.html"?"/pricing?reason=ai":"/pricing?reason=discovery-required","Cache-Control":"no-store"});
    res.end();
    return;
  }
  const publicFile=STATIC_FILES.get(requested);
  const filePath=join(PUBLIC_ROOT,publicFile);
  const cached=publicAssets.get(requested);
  if (!cached&&!existsSync(filePath)) { json(res,404,{error:"Page not found."}); return; }
  let body=cached?cached.body:readFileSync(filePath);
  if (requested==="account.html") body=Buffer.from(auth.renderAccountFallbacks(body.toString("utf8"),url));
  if (requested==="verify-email.html") body=Buffer.from(auth.renderVerificationFallbacks(body.toString("utf8"),url));
  if (requested==="index.html") {
    const user=activeSession?await userPayload(activeSession):null;
    const actions=user
      ? `<a class="account-button discover-button" id="discoverButton" href="${user.discovery.active?"/discover.html":"/pricing"}">${user.discovery.active?"Strata+":"Unlock Strata+"}</a>\n        <a class="account-button account-create" id="signupButton" href="/account.html?mode=signup" hidden>Sign up</a>\n        <a class="account-button account-link signed-in" id="accountButton" href="/account.html">${escapeHtml(user.name.split(/\s+/)[0])} profile</a>\n        <a class="session-button" id="planButton" href="/planner.html">Plan <span id="planCount">${user.planCount}</span></a>`
      : `<a class="account-button discover-button" id="discoverButton" href="/discover.html" hidden>Strata+</a>\n        <a class="account-button account-create" id="signupButton" href="/account.html?mode=signup">Sign up</a>\n        <a class="account-button account-link" id="accountButton" href="/account.html?mode=login">Log in</a>\n        <a class="session-button" id="planButton" href="/planner.html">Plan <span id="planCount">0</span></a>`;
    body=Buffer.from(body.toString("utf8").replace(/<!-- ACCOUNT_ACTIONS_START -->[\s\S]*?<!-- ACCOUNT_ACTIONS_END -->/,`<!-- ACCOUNT_ACTIONS_START -->\n        ${actions}\n        <!-- ACCOUNT_ACTIONS_END -->`));
  }
  const privateHtml=PRIVATE_HTML.has(requested);
  const cacheControl=privateHtml
    ? "private, no-store"
    : requested==="service-worker.js"||requested==="manifest.webmanifest"
      ? "no-cache, must-revalidate"
      : requested.endsWith(".html")
        ? "no-cache"
        : requested.endsWith(".js")||requested.endsWith(".css")
          ? "no-cache, must-revalidate"
          : "public, max-age=300";
  const headers={...securityHeaders(),"Content-Type":MIME[extname(filePath)]||"application/octet-stream","Cache-Control":cacheControl};
  if (requested==="service-worker.js") headers["Service-Worker-Allowed"]="/";
  if (requested==="admin.html") headers["X-Robots-Tag"]="noindex, nofollow, noarchive";
  if (privateHtml) headers.Vary="Cookie";
  body=cached?cachedResponseBody(req,cached,headers):responseBody(req,body,headers);
  res.writeHead(200,headers); if (req.method === "HEAD") res.end(); else res.end(body);
}

const server=http.createServer({requestTimeout:30_000,headersTimeout:15_000,keepAliveTimeout:5_000},async(req,res) => {
  observeRequest(req,res,LOGGER);
  deliverQueuedCookies(req,res);
  try {
    const url=new URL(req.url,`http://${req.headers.host || "localhost"}`);
    if (url.pathname==="/livez") handleLiveness(req,res);
    else if (url.pathname==="/readyz"||url.pathname==="/healthz") await handleReadiness(req,res);
    else if (url.pathname.startsWith("/api/")) await handleApi(req,res,url);
    else if (url.pathname.startsWith("/auth/")) await auth.handleForm(req,res,url);
    else if (["GET","HEAD"].includes(req.method)) await serveStatic(req,res,url);
    else json(res,405,{error:"Method not allowed."},{Allow:"GET, HEAD"});
  } catch(error) {
    if (!res.headersSent) {
      const payload={error:error.status?error.message:"Something went wrong on our side. Try again in a moment."};
      if (error.status&&/^[A-Z][A-Z0-9_]{2,63}$/.test(String(error.code||""))) payload.code=String(error.code);
      json(res,error.status||500,payload);
    }
    if (!error.status) LOGGER.error("http.unexpected_error",{requestId:req.strataRequestId,error});
  }
});

server.setTimeout(60_000,(socket)=>socket.destroy());

let cleanup,shuttingDown=false,events,dataService;
async function start() {
  if (process.env.NODE_ENV==="production"&&!EMAIL_CONFIG.flagValid) {
    throw new Error("EMAIL_VERIFICATION_ENABLED must be set explicitly to true or false in production.");
  }
  publicAssets=loadPublicAssets({root:PUBLIC_ROOT,files:STATIC_FILES,privateFiles:PRIVATE_HTML,mime:MIME});
  store = await createStore(PROJECT_ROOT);
  events=createEventBus({logger:LOGGER});
  billing=createBillingService({
    store,paymentConfig:PAYMENT_CONFIG,enforcePaddleIps:ENFORCE_PADDLE_IPS,
    requestAddress,rateAllowed,isUniqueViolation,getAuth:()=>auth,getUserPayload:userPayload,
    http:{json,bodyJson},logger:LOGGER
  });
  appleBilling=createAppleBillingService({store,settings:APPLE_SETTINGS,getAuth:()=>auth,getUserPayload:userPayload,trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json},logger:LOGGER});
  ({auth,admin,support}=composeServices({
    store,emailConfig:EMAIL_CONFIG,paymentConfig:PAYMENT_CONFIG,
    adminEmail:ADMIN_EMAIL,enforcePaddleIps:ENFORCE_PADDLE_IPS,
    exerciseIds:EXERCISE_IDS,trustedAuthOrigin,rateAllowed,requestAddress,
    http:{json,bodyJson,bodyForm,redirect,securityHeaders},getUserPayload:userPayload,
    reconcileCheckoutCreationBeforeDeletion:billing.reconcileCheckoutCreationBeforeDeletion,
    reconcileUnsettledPurchases:billing.reconcileUnsettledPurchases,isUniqueViolation,appleDeletionNotice:appleBilling.deletionNotice,
    createAuthService,createAdminService,createSupportService
  }));
  dataService=createDataService({store,events,getPlan:planFor,coachingProfile:async(userId)=>coachingProfilePayload(await store.coachingProfile(userId)),requireSession:(req,res)=>auth.requireSession(req,res),requireFeature,http:{json},logger:LOGGER});
  productSignals=createProductSignalsService({store,admin,trustedOrigin:trustedAuthOrigin,requestAddress,rateKeyAllowed,http:{json,bodyJson}});
  workouts=createWorkoutService({store,auth,requireAccess:requireFeature("plus.train"),rateAllowed,http:{json,bodyJson},events});
  training=createTrainingService({store,auth,requireAccess:requireFeature("plus.train"),trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json,bodyJson},events});
  coaching=createCoachingService({store,auth,requireAccess:requireFeature("plus.nutrition"),trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json,bodyJson},events,getPlan:planFor});
  devices=createDevicesService({store,auth,requireAccess:requireFeature("plus.recovery"),trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json,bodyJson,bodyBuffer,redirect},settings:devicesSettings(process.env),hasAccess:hasCurrentDiscoveryAccess,logger:LOGGER,isUniqueViolation,events});devices.start();
  if (AI_SETTINGS.insecure) LOGGER.warn("ai.insecure_base_url_ignored",{});
  const aiProvider=createAiProvider(AI_SETTINGS.provider),aiQuota=createAiQuota({store,limits:AI_SETTINGS.limits});
  ai=createAiService({store,auth,requireAccess:requireFeature("plus.ai"),trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json,bodyJson},provider:aiProvider,getPlanSnapshot:planSnapshotFor,quota:aiQuota,dataService,logger:LOGGER,config:AI_SETTINGS.limits});
  aiSettingsService=createAiSettingsService({store,auth,trustedOrigin:trustedAuthOrigin,rateAllowed,http:{json,bodyJson},quota:aiQuota,admin});
  // The Daily Brief runs through the night's queue; tests turn it on explicitly.
  briefJob=createDailyBriefJob({store,dataService,provider:aiProvider,quota:aiQuota,hasAccess:hasCurrentDiscoveryAccess,logger:LOGGER,settings:{hour:AI_SETTINGS.brief.hour}});briefJob.subscribe(events);
  if (AI_SETTINGS.brief.enabled&&aiProvider.configured&&(process.env.NODE_ENV!=="test"||process.env.STRATA_AI_DAILY_BRIEF==="true")) briefJob.start();
  if (aiProvider.configured&&process.env.NODE_ENV!=="test") void aiProvider.health().then((health)=>LOGGER.info("ai.models",{primaryListed:health.modelListed,fallbackListed:health.fallbackListed})).catch((error)=>LOGGER.warn("ai.models_unchecked",{code:error?.code||"AI_FAILED"}));
  setup=createSetupService({
    store,auth,requireAccess:requireDiscoveryAccess,trustedOrigin:trustedAuthOrigin,
    getPlanSnapshot:planSnapshotFor,getPreferencesSnapshot:preferencesSnapshotFor,getUserPayload:userPayload,
    http:{json,bodyJson},events
  });
  await admin.bootstrap();
  await store.deleteExpired(Date.now());
  await auth.cleanup();
  await support.cleanup();
  await productSignals.cleanup();
  await dataService.cleanup();
  await appleBilling.cleanup();
  if (ENFORCE_PADDLE_IPS) void billing.warmProviderTrust().catch((error)=>LOGGER.error("billing.webhook_allowlist_warm_failed",{error}));
  cleanup=setInterval(() => {
    void store.deleteExpired(Date.now()).catch((error)=>LOGGER.error("cleanup.store_failed",{error}));
    void auth.cleanup().catch((error)=>LOGGER.error("cleanup.auth_failed",{error}));
    void support.cleanup().catch((error)=>LOGGER.error("cleanup.support_failed",{error}));
    void productSignals.cleanup().catch((error)=>LOGGER.error("cleanup.product_signals_failed",{error}));
    void dataService.cleanup().catch((error)=>LOGGER.error("cleanup.data_layer_failed",{error}));
    void aiQuota.cleanup(90).catch((error)=>LOGGER.error("cleanup.ai_usage_failed",{error}));
    void appleBilling.cleanup().catch((error)=>LOGGER.error("cleanup.apple_notifications_failed",{error}));
    for (const [key,times] of rateBuckets) if (!times.some((time) => Date.now()-time<15*60*1000)) rateBuckets.delete(key);
  },60*60*1000);
  cleanup.unref();
  server.listen(PORT,HOST,() => {
    const address=server.address(),listeningPort=typeof address==="object"&&address?address.port:PORT;
    if(process.env.NODE_ENV==="test")console.log(`Strata running at http://${HOST}:${listeningPort} using ${store.kind} storage`);
    else LOGGER.info("service.ready",{host:HOST,port:listeningPort,storage:store.kind,build:BUILD_NUMBER});
  });
}
function shutdown() {
  if (shuttingDown) return;
  shuttingDown=true;
  if (cleanup) clearInterval(cleanup);
  devices?.stop();
  briefJob?.stop();
  const deadline=setTimeout(()=>{
    console.error("Shutdown deadline reached; closing remaining connections.");
    server.closeAllConnections();
    process.exit(1);
  },10_000);
  deadline.unref();
  server.close(async(error)=>{
    try {
      if (error&&error.code!=="ERR_SERVER_NOT_RUNNING") throw error;
      await store?.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch(error) {
      console.error("Could not finish graceful shutdown:",error);
      process.exit(1);
    }
  });
  server.closeIdleConnections();
}
process.on("SIGINT",shutdown);
process.on("SIGTERM",shutdown);
start().catch((error) => { console.error(`STRATA could not start: ${error.message}`); process.exitCode=1; });
