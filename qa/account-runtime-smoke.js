"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { join } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");
const RELEASE = require(join(PROJECT_ROOT, "package.json"));
const BUILD = RELEASE.strataBuild || RELEASE.version;
const CATALOG_URL = `/exercises.json?v=${BUILD}`;
const readPublic = (...parts) => fs.readFileSync(join(PROJECT_ROOT, "public", ...parts), "utf8");
const html = readPublic("pages", "index.html");
const catalog = JSON.parse(readPublic("data", "exercises.json"));
const appSource = readPublic("scripts", "app.js");
const homeModuleNames = [
  "entitlements.js",
  "home-logic.js",
  "home-state.js",
  "home-api.js",
  "home-render.js",
  "home-events.js",
];
const homeModuleSources = homeModuleNames.map((name) => readPublic("scripts", name));
const Discovery = require(join(PROJECT_ROOT, "public", "scripts", "discovery-core"));
const Preview = require(join(PROJECT_ROOT, "public", "scripts", "preview-core"));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
class ClassList {
  constructor() {
    this.values = new Set();
  }
  add(...names) {
    names.forEach((name) => this.values.add(name));
  }
  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
  contains(name) {
    return this.values.has(name);
  }
}
class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.open = false;
    this.disabled = false;
    this.focused = false;
    this.dataset = {};
    this.attributes = {};
    this.classList = new ClassList();
    this.listeners = {};
    this.parentElement = { classList: new ClassList() };
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  focus() {
    this.focused = true;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { left: 0, right: 1000, top: 0, bottom: 1000 };
  }
}
const elements = new Map(ids.map((id) => [id, new Element(id)])),
  documentListeners = {};
const document = {
  body: new Element("body"),
  getElementById(id) {
    return elements.get(id) || null;
  },
  addEventListener(type, handler) {
    (documentListeners[type] ||= []).push(handler);
  },
  querySelectorAll() {
    return [];
  },
};
const navigations = [];
const fetches = [];
const context = {
  console,
  document,
  location: { search: "" },
  history: { replaceState() {} },
  requestAnimationFrame: (callback) => callback(),
  setTimeout,
  clearTimeout,
  URLSearchParams,
  window: {
    location: { assign: (path) => navigations.push(path) },
    StrataDiscovery: Discovery,
    StrataPreview: Preview,
  },
  FormData: class {
    constructor(form) {
      this.values = form.values || {};
    }
    get(key) {
      return this.values[key] || null;
    }
  },
  fetch: async (path) => {
    fetches.push(path);
    if (path === "/api/me")
      return {
        ok: true,
        json: async () => ({
          user: {
            id: "u1",
            name: "Account Audit",
            email: "audit@example.test",
            planCount: 2,
            workoutDays: 1,
            discovery: { active: true },
          },
        }),
      };
    if (path === CATALOG_URL) return { ok: true, json: async () => catalog };
    return { ok: false, json: async () => ({ error: "Not found" }) };
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(readPublic("scripts", "html.js"), context, { filename: "html.js" }); // Every page loads it first.
for (let index = 0; index < homeModuleSources.length; index += 1)
  vm.runInContext(homeModuleSources[index], context, { filename: homeModuleNames[index] });
vm.runInContext(appSource, context, { filename: "app.js" });

(async () => {
  await new Promise(setImmediate);
  const canonicalCatalogRendered = elements
    .get("exerciseList")
    .innerHTML.includes("Incline Smith Press");
  const searchInput = elements.get("searchInput"),
    equipmentFilter = elements.get("equipmentFilter");
  searchInput.value = "press";
  searchInput.listeners.input[0]({ target: searchInput });
  equipmentFilter.value = "Dumbbells";
  equipmentFilter.listeners.change[0]({ target: equipmentFilter });
  context.selectGroup("shoulders", false);
  const preservedFilters = searchInput.value === "press" && equipmentFilter.value === "Dumbbells";
  const labeledFilterSummary = /Shoulders.*Equipment: Dumbbells.*Search: “press”/.test(
    elements.get("activeTarget").textContent,
  );
  const persistentResetVisible = elements.get("resetActiveFilters").hidden === false;
  context.resetFilters();
  const resetRestoresDefaults =
    searchInput.value === "" &&
    equipmentFilter.value === "all" &&
    elements.get("levelFilter").value === "all" &&
    elements.get("resetActiveFilters").hidden === true &&
    elements.get("activeTarget").textContent === "Shoulders · All targets" &&
    searchInput.focused === true;
  const result = {
    accountFetch: fetches.filter((path) => path === "/api/me").length === 1,
    catalogFetch: fetches.filter((path) => path === CATALOG_URL).length === 1,
    canonicalCatalogRendered,
    signupIsNativeLink: /id="signupButton" href="\/account\.html\?mode=signup"/.test(html),
    loginIsNativeLink: /id="accountButton" href="\/account\.html\?mode=login"/.test(html),
    noModalDependency: !html.includes('id="authDialog"'),
    signedInProfileLabel: elements.get("accountButton").textContent === "Account profile",
    signedInProfileLink: elements.get("accountButton").href === "/account.html",
    signupHiddenWhenSignedIn: elements.get("signupButton").hidden === true,
    plannerLinkWhenSignedIn: elements.get("planButton").href === "/planner.html",
    planCountUpdated: elements.get("planCount").textContent === 2,
    plannerLinkHasUsefulLabel:
      elements.get("planButton").getAttribute("aria-label") === "Open weekly planner, 2 exercises",
    filtersSurviveGroupChange: preservedFilters,
    activeFiltersAreLabeled: labeledFilterSummary,
    persistentFilterResetAppears: persistentResetVisible,
    filterResetRestoresDefaults: resetRestoresDefaults,
    mobileMetadataRendered: /class="mobile-exercise-meta"/.test(
      elements.get("exerciseList").innerHTML,
    ),
    scoreHasImageSemantics: /class="score-badge[^"]*" role="img"/.test(
      elements.get("exerciseList").innerHTML,
    ),
    noBrowserTokenDependency: !appSource.includes("csrfToken"),
  };
  for (const [key, value] of Object.entries(result)) assert.equal(value, true, key);
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
