"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const PUBLIC_ROOT = path.join(PROJECT_ROOT, "public");
const RELEASE = require(path.join(PROJECT_ROOT, "package.json"));
const BUILD = RELEASE.strataBuild || RELEASE.version;
const read = (name) => fs.readFileSync(path.join(PUBLIC_ROOT, "pages", name), "utf8");
const visibleText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<wbr\s*\/?>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const text = (name) => visibleText(read(name));
const navLabels = (html, className) => {
  const nav =
    html.match(new RegExp(`<nav class="[^"]*${className}[^"]*"[\\s\\S]*?<\\/nav>`))?.[0] || "";
  return [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((match) => visibleText(match[1]));
};

test("homepage exposes pricing, contact, and the public policy directory without JavaScript", () => {
  const home = read("index.html"),
    policies = read("policies.html");
  const mobileNav = home.match(/<nav class="mobile-public-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  const mobileLinks = [...mobileNav.matchAll(/<a href="([^"]+)"(?: [^>]*)?>([^<]+)<\/a>/g)].map(
    (match) => [match[1], match[2]],
  );
  const footer = home.match(/<nav class="footer-links"[\s\S]*?<\/nav>/)?.[0] || "";
  for (const route of ["/pricing", "/contact", "/policies"])
    assert.match(home, new RegExp(`href="${route}"`), `${route} homepage link`);
  for (const route of ["/terms", "/privacy", "/refunds"])
    assert.match(policies, new RegExp(`href="${route}"`), `${route} policy-directory link`);
  assert.deepEqual(mobileLinks, [
    ["#rankings", "Rankings"],
    ["/dashboard", "Dashboard"],
    ["/install.html", "Install"],
  ]);
  assert.equal(
    (footer.match(/href="\/policies"/g) || []).length,
    1,
    "homepage footer must expose one Policies destination",
  );
  assert.doesNotMatch(
    footer,
    /href\s*=\s*"\/(?:terms|privacy|refunds)"/,
    "the policy hub replaces redundant legal links in the homepage footer",
  );
  assert.match(home, /mailto:stratafitness\.official@gmail\.com/i);
  assert.match(text("index.html"), /\$2\.99 USD/i);
  assert.doesNotMatch(
    text("index.html"),
    /trial|7\s*days|no\s*card/i,
    "the homepage no longer offers the retired free trial",
  );
  assert.doesNotMatch(
    text("index.html"),
    /Strata\s*AI/,
    "Strata AI lives inside Strata+, not on the homepage",
  );
  assert.match(text("index.html"), /\$2\.99 USD per month/i);
  assert.match(text("index.html"), /renews monthly until canceled/i);
  assert.doesNotMatch(text("index.html"), /lifetime|one[- ]time|never\s*a\s*subscription/i);
});

test("the editorial homepage and the five-section navigation remain canonical", () => {
  const home = read("index.html"),
    discover = read("discover.html"),
    planner = read("planner.html"),
    workout = read("workout.html");
  assert.match(home, /<section class="hero"[^>]*aria-labelledby="hero-title"/);
  assert.match(
    home,
    /<div class="hero-media" role="img" aria-label="Athlete performing a pull-up in a gym">/,
  );
  assert.match(home, /<h1 id="hero-title">Your next<br \/>workout\.<br \/><em>Ready\.<\/em><\/h1>/);
  assert.ok(
    home.indexOf('class="hero"') < home.indexOf('id="rankings"'),
    "The editorial hero must lead instead of opening on the exercise catalog",
  );
  assert.doesNotMatch(
    home,
    /<\s*title\s*>\s*Exercises\b/i,
    "The rejected Exercises-first shell must not replace the STRATA homepage",
  );
  for (const removed of [
    "start-directory",
    'class="ticker"',
    "system-section",
    "editorial-section",
    "discovery-offer",
  ])
    assert.doesNotMatch(
      home,
      new RegExp(removed),
      `${removed} was cut: the homepage is hero, free preview, rankings, method, sources`,
    );

  const expected = ["Rankings", "Dashboard", "Train", "Recovery", "Profile"];
  // The homepage is the landing page: Rankings, Dashboard, and Install. Every other page keeps all five sections.
  assert.deepEqual(navLabels(home, "desktop-nav"), ["Rankings", "Dashboard", "Install"]);
  assert.deepEqual(
    navLabels(read("dashboard.html"), "info-nav"),
    expected,
    "the Strata+ dashboard page",
  );
  const pages = {
    discover: [discover, "studio-nav-desktop"],
    planner: [planner, "planner-primary-nav-desktop"],
    workout: [workout, "workout-nav-desktop"],
  };
  for (const page of [
    "ai",
    "account",
    "onboarding",
    "install",
    "contact",
    "policies",
    "pricing",
    "privacy",
    "refunds",
    "terms",
  ])
    pages[page] = [
      read(`${page}.html`),
      page === "ai"
        ? "studio-nav-desktop"
        : page === "account"
          ? "account-nav"
          : page === "onboarding"
            ? "product-nav"
            : page === "install"
              ? "install-nav"
              : "info-nav",
    ];
  for (const [name, [html, className]] of Object.entries(pages))
    assert.deepEqual(navLabels(html, className), expected, `${name} uses the five sections`);
  // One way to each section: no page keeps a separate Account link next to Profile, or the retired Strata+/Plan/Exercises labels.
  for (const [name, [html]] of Object.entries(pages)) {
    const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0] || "";
    assert.doesNotMatch(
      header,
      />\s*(?:Account|Exercises|Plan|Strata\s*\+)\s*<\s*\/a\s*>/,
      `${name} header keeps only the five sections`,
    );
  }
  // Member-aware sections resolve on the server; the studio switches its own views in place.
  assert.match(
    planner,
    /<a href="\/rankings">Rankings<\/a><a href="\/dashboard" aria-current="page">Dashboard<\/a><a href="\/workout\.html">Train<\/a><a href="\/recovery">Recovery<\/a><a href="\/account\.html">Profile<\/a>/,
  );
  assert.match(
    discover,
    /<a href="#exerciseExplorer" data-section="rankings">Rankings<\/a><a class="active" href="\/dashboard" data-section="week" aria-current="page">Dashboard<\/a>/,
  );
  assert.match(workout, /<a href="\/workout\.html" aria-current="page">Train<\/a>/);
  assert.match(
    read("account.html"),
    /<a class="back-link" href="\/account\.html" aria-current="page">Profile<\/a>/,
  );
});

test("the public policies page publishes the founder story without cluttering the homepage", () => {
  const home = read("index.html"),
    policies = read("policies.html");
  const founder =
    policies.match(/<section class="info-container policy-founder"[\s\S]*?<\/section>/)?.[0] || "";
  const copy = visibleText(founder);
  assert.doesNotMatch(home, /class\s*=\s*"founder-section"/);
  assert.doesNotMatch(home, /href\s*=\s*"#founder"/);
  assert.match(home, /href="\/policies"/);
  assert.match(policies, /id="founder"/);
  assert.match(policies, /href="#founder"/);
  assert.match(copy, /Saeed Abdalla Alketbi/);
  assert.match(copy, /founded by Saeed Abdalla Alketbi at 22/i);
  assert.match(
    copy,
    /third-year chemical engineering student at United Arab Emirates University \(UAEU\)/i,
  );
  assert.match(copy, /Born and raised in the UAE and based in Al Ain/i);
  assert.match(copy, /Chemical Engineering · UAEU/i);
  assert.match(policies, /<div class="policy-founder-mark"[^>]*>[\s\S]*?<span>SK<\/span>/);
  assert.doesNotMatch(
    policies,
    /<\s*div\s*class\s*=\s*"policy-founder-mark"[^>]*\s*>\s*[\s\S]*?\s*<\s*span\s*>\s*SA\s*<\s*\/span\s*>/,
  );
  assert.doesNotMatch(copy, /Zahkir|Malad|street\s*13|st\.?\s*13/i);
});

test("core footers use the policy directory instead of repeating every legal page", () => {
  for (const page of [
    "account.html",
    "discover.html",
    "planner.html",
    "install.html",
    "delete-account.html",
    "forgot-password.html",
    "reset-password.html",
    "verify-email.html",
    "workout.html",
    "admin.html",
  ]) {
    const footer = read(page).match(/<footer\b[\s\S]*?<\/footer>/)?.[0] || "";
    assert.match(footer, /href="\/policies"/, `${page} policy-directory link`);
    assert.doesNotMatch(
      footer,
      /href\s*=\s*"\/(?:terms|privacy|refunds)"/,
      `${page} redundant policy link`,
    );
  }
});

test("published Strata+ price and refund promise are exact and consistent", () => {
  assert.equal(BUILD, "9.5.0");
  const pricingHtml = read("pricing.html"),
    pricing = text("pricing.html"),
    refunds = text("refunds.html"),
    terms = text("terms.html");
  assert.match(pricing, /Strata\+/);
  assert.match(pricing, /\$2\.99 USD/i);
  assert.doesNotMatch(pricing, /trial|no\s*card/i, "the free trial is retired");
  assert.match(pricing, /Renews until canceled/i);
  assert.match(pricing, /session building/i);
  assert.match(pricing, /31-day planner/i);
  assert.match(pricing, /workout check-ins/i);
  assert.match(pricing, /Review suggested plan changes before saving/i);
  assert.match(pricing, /setup and technique guides/i);
  assert.match(pricing, /your Plan stays yours if you stop Strata\+/i);
  assert.match(pricingHtml, /href="\/planner\.html">Open free planner/);
  assert.match(pricingHtml, /Create my free account/);
  assert.match(pricingHtml, /Create an account or sign in to subscribe/);
  assert.match(pricingHtml, /without an account, and syncs once you sign in/);
  assert.doesNotMatch(pricingHtml, /id\s*=\s*"trialDiscovery"/);
  assert.match(pricingHtml, /href="\/refunds"/);
  assert.match(pricingHtml, /id="buyDiscovery"/);
  // Paddle.js is requested by pricing.js on the website only, never inside the iOS app.
  assert.doesNotMatch(pricingHtml, /cdn\s*\.paddle\s*\.com/);
  assert.match(
    read("../scripts/pricing.js"),
    /"https:\/\/cdn\.paddle\.com\/paddle\/v2\/paddle\.js"/,
  );
  assert.match(pricingHtml, new RegExp(`src="/pricing\\.js\\?v=${BUILD.replace(/\./g, "\\.")}"`));
  assert.match(pricing, /Paddle is the merchant of record/i);
  assert.match(pricing, /unlocks after STRATA securely confirms the subscription/i);
  for (const phrase of ["merchant of record", "per month", "stays free", "until canceled"]) {
    const count = pricing.toLowerCase().split(phrase).length - 1;
    assert.ok(count <= 1, `Pricing repeats “${phrase}” ${count} times`);
  }
  assert.match(refunds, /14 calendar days after an eligible Strata\+ monthly charge/i);
  assert.match(refunds, /original payment method/i);
  assert.match(refunds, /Cancellation does not automatically refund/i);
  assert.match(refunds, /Deleting a STRATA account is not cancellation and is not a refund/i);
  assert.match(terms, /\$2\.99 USD/i);
  assert.match(terms, /no longer offers a free Strata\+ trial/i);
  assert.match(terms, /recurring subscription/i);
  assert.match(terms, /renews monthly at \$2\.99 USD until canceled/i);
  assert.match(terms, /never converts into a subscription/i);
  assert.match(text("privacy.html"), /no longer offers a free Strata\+ trial/i);
  assert.match(terms, /Paddle acts as merchant of record/i);
  assert.match(
    terms,
    /lifetime access purchased before this recurring offer remain grandfathered/i,
  );
});

test("customer-facing product branding is Strata+ while compatibility identifiers stay stable", () => {
  const pages = [
    "index.html",
    "pricing.html",
    "account.html",
    "discover.html",
    "planner.html",
    "contact.html",
    "policies.html",
    "terms.html",
    "privacy.html",
    "refunds.html",
    "delete-account.html",
    "admin.html",
  ];
  const visibleCopy = pages.map(text).join(" ");
  const manifest = fs.readFileSync(path.join(PUBLIC_ROOT, "manifest.webmanifest"), "utf8");
  assert.match(visibleCopy, /Strata\+/);
  assert.doesNotMatch(visibleCopy, /\bDiscovery\b/);
  assert.match(manifest, /"name": "Strata\+ Studio"/);
  assert.match(read("pricing.html"), /id="buyDiscovery"/);
  assert.match(read("discover.html"), /data-section="week"[^>]*>Dashboard<\/a>/);
});

test("contact and policy pages publish the official support address and cross-links", () => {
  const email = "stratafitness.official@gmail.com";
  const contact = read("contact.html");
  assert.match(contact, new RegExp(`mailto:${email.replace(".", "\\.")}`, "i"));
  assert.match(text("contact.html"), new RegExp(email.replace(".", "\\."), "i"));
  for (const page of [
    "pricing.html",
    "contact.html",
    "policies.html",
    "terms.html",
    "privacy.html",
    "refunds.html",
  ]) {
    assert.match(
      read(page),
      /class="info-nav"[^>]*>[\s\S]*href="\/dashboard">Dashboard<\/a>/,
      `${page} Dashboard navigation`,
    );
  }
  for (const page of ["policies.html", "terms.html", "privacy.html", "refunds.html"]) {
    const html = read(page);
    assert.match(text(page), new RegExp(email.replace(".", "\\."), "i"), `${page} support email`);
    for (const route of ["/policies", "/terms", "/privacy", "/refunds"])
      assert.match(html, new RegExp(`href="${route}"`), `${page} ${route} link`);
  }
  assert.match(
    text("privacy.html"),
    /does not receive or store full payment-card or bank-account details/i,
  );
});

test("support and deletion pages explain their important fallback and retention behavior", () => {
  const contact = read("contact.html"),
    deletion = text("delete-account.html");
  assert.match(contact, /<noscript>[\s\S]*support form needs JavaScript[\s\S]*mailto:/i);
  assert.match(
    text("contact.html"),
    /signed-in requests use the name and email registered to the account/i,
  );
  assert.match(deletion, /monthly plan/i);
  assert.match(deletion, /weekly and monthly plans, profile, and preferences/i);
  assert.match(
    deletion,
    /support (?:requests|records)[\s\S]*administrator security logs[\s\S]*may be retained/i,
  );
});

test("public policies distinguish self-service from guarded administrator deletion", () => {
  const terms = text("terms.html"),
    privacy = text("privacy.html");
  for (const copy of [terms, privacy]) {
    assert.match(copy, /authorized administrator/i);
    assert.match(copy, /paused non-owner account|non-owner account after pausing it/i);
    assert.match(
      copy,
      /does not cancel a live Paddle subscription|not subscription cancellation and is not a refund/i,
    );
  }
  assert.match(terms, /one explicit review/i);
  assert.match(terms, /server-generated action-specific audit reason/i);
  assert.doesNotMatch(terms, /exact\s*account\s*email\s*and\s*an\s*audit\s*reason/i);
  assert.match(privacy, /re-checks Paddle and database blockers/i);
  assert.match(privacy, /cannot delete the primary owner/i);
});

test("public copy describes recurring checkout, cancellation, and grandfathered access", () => {
  const publicCopy = ["pricing.html", "terms.html", "privacy.html", "refunds.html"]
    .map(text)
    .join(" ");
  assert.match(publicCopy, /\$2\.99 USD per month/i);
  assert.match(publicCopy, /renews monthly/i);
  assert.match(publicCopy, /grandfathered/i);
  assert.doesNotMatch(publicCopy, /permanent\s*access/i);
  assert.doesNotMatch(
    publicCopy,
    /prelaunch|until\s*checkout\s*is\s*activated|when\s*paid\s*checkout\s*launches|when\s*purchasing\s*is\s*available/i,
  );
  assert.match(text("privacy.html"), /Paddle handles checkout, recurring payment/i);
  assert.match(text("privacy.html"), /current billing-period end/i);
  assert.match(text("refunds.html"), /Refunding the charge may end the paid Strata\+ access/i);
  const pricingClient = ["entitlements.js", "pricing-logic.js", "pricing-render.js", "pricing.js"]
    .map((name) => fs.readFileSync(path.join(PUBLIC_ROOT, "scripts", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(pricingClient, /permanently\s*unlocked/i);
  assert.doesNotMatch(
    pricingClient,
    /\/api\/discovery\/trial|startTrial|trialDiscovery/,
    "pricing never starts the retired trial",
  );
  assert.match(pricingClient, /buyButton\s*\.hidden\s*=\s*!\s*canSubscribe\s*;/);
  assert.match(pricingClient, /monthly subscription is active and renews on/);
  assert.match(pricingClient, /previous monthly subscription is canceled and will not renew/);
  assert.match(pricingClient, /error\s*\.code\s*===\s*"CHECKOUT_PREPARING"/);
  assert.doesNotMatch(
    pricingClient,
    /error\s*\.status\s*===\s*409/,
    "a concurrent-checkout response must stay retryable instead of impersonating a completed payment",
  );
});

test("Account leaves training progress to Strata+ and keeps its next action and controls", () => {
  const account = read("account.html");
  assert.doesNotMatch(
    account,
    /Weekly\s*progress|Recent\s*momentum|Training\s*signal|accountWeekProgress|accountWinsList|accountAdaptationTitle/,
  );
  for (const id of [
    "accountAccessState",
    "accountBilling",
    "connectedDevices",
    "accountSessionList",
    "accountExportData",
    "accountDeleteRequest",
  ])
    assert.match(account, new RegExp(`id="${id}"`));
});

test("public pages share one card: title, description, and the STRATA share image", () => {
  for (const page of [
    "index",
    "pricing",
    "contact",
    "policies",
    "privacy",
    "terms",
    "refunds",
    "install",
    "planner",
  ]) {
    const html = read(`${page}.html`),
      description = html.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert.ok(description, `${page} description`);
    assert.match(
      html,
      new RegExp(
        `<meta property="og:description" content="${description.replace(/[.*+?^${}()|[\]\\$]/g, "\\$&")}" />`,
      ),
      `${page} share description matches the page`,
    );
    assert.match(
      html,
      /<meta property="og:image" content="https:\/\/stratafitness\.online\/images\/strata-og\.jpg" \/>/,
      `${page} share image`,
    );
    assert.match(html, /<meta property="og:title" content="[^"]+" \/>/, `${page} share title`);
    assert.match(
      html,
      /<meta name="twitter:card" content="summary_large_image" \/>/,
      `${page} large card`,
    );
  }
  assert.ok(
    fs.statSync(path.join(PUBLIC_ROOT, "images", "strata-og.jpg")).size < 150_000,
    "the share image stays small",
  );
});
