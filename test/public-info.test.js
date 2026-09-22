"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const PROJECT_ROOT=path.join(__dirname,"..");
const PUBLIC_ROOT=path.join(PROJECT_ROOT,"public");
const RELEASE=require(path.join(PROJECT_ROOT,"package.json"));
const BUILD=RELEASE.strataBuild||RELEASE.version;
const read=(name)=>fs.readFileSync(path.join(PUBLIC_ROOT,"pages",name),"utf8");
const visibleText=(html)=>html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<wbr\s*\/?>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
const text=(name)=>visibleText(read(name));
const navLabels=(html,className)=>{
  const nav=html.match(new RegExp(`<nav class="[^"]*${className}[^"]*"[\\s\\S]*?<\\/nav>`))?.[0]||"";
  return[...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((match)=>visibleText(match[1]));
};

test("homepage exposes pricing, contact, and the public policy directory without JavaScript",()=>{
  const home=read("index.html"),policies=read("policies.html");
  const mobileNav=home.match(/<nav class="mobile-public-nav"[\s\S]*?<\/nav>/)?.[0]||"";
  const mobileLinks=[...mobileNav.matchAll(/<a href="([^"]+)"(?: [^>]*)?>([^<]+)<\/a>/g)].map((match)=>[match[1],match[2]]);
  const footer=home.match(/<nav class="footer-links"[\s\S]*?<\/nav>/)?.[0]||"";
  for(const route of ["/pricing","/contact","/policies"])assert.match(home,new RegExp(`href="${route}"`),`${route} homepage link`);
  for(const route of ["/terms","/privacy","/refunds"])assert.match(policies,new RegExp(`href="${route}"`),`${route} policy-directory link`);
  assert.deepEqual(mobileLinks,[["#rankings","Exercises"],["/discover.html","Strata+"],["/planner.html","Plan"],["/workout.html","Train"]]);
  assert.equal((footer.match(/href="\/policies"/g)||[]).length,1,"homepage footer must expose one Policies destination");
  assert.doesNotMatch(footer,/href="\/(?:terms|privacy|refunds)"/,"the policy hub replaces redundant legal links in the homepage footer");
  assert.match(home,/mailto:stratafitness\.official@gmail\.com/i);
  assert.match(text("index.html"),/\$2\.99 USD/i);
  assert.match(text("index.html"),/7 days/i);
  assert.match(text("index.html"),/\$2\.99 USD per month/i);
  assert.match(text("index.html"),/never auto-converts/i);
  assert.match(text("index.html"),/renews monthly until canceled/i);
  assert.doesNotMatch(text("index.html"),/lifetime|one[- ]time|never a subscription/i);
});

test("the 7.8.1 editorial homepage and four-destination product identity remain canonical",()=>{
  const home=read("index.html"),discover=read("discover.html"),planner=read("planner.html"),workout=read("workout.html");
  assert.match(home,/<section class="hero"[^>]*aria-labelledby="hero-title"/);
  assert.match(home,/<div class="hero-media" role="img" aria-label="Athlete performing a pull-up in a gym">/);
  assert.match(home,/<h1 id="hero-title">YOUR NEXT<br \/>WORKOUT\.<br \/><em>READY\.<\/em><\/h1>/);
  assert.ok(home.indexOf('class="hero"')<home.indexOf('id="rankings"'),"The editorial hero must lead instead of opening on the exercise catalog");
  assert.match(home,/src="\/images\/strata-layers\.jpg"/);
  assert.match(home,/src="\/images\/training-story\.jpg"/);
  assert.match(home,/<section class="editorial-section">/);
  assert.doesNotMatch(home,/<title>Exercises\b/i,"The rejected Exercises-first shell must not replace the STRATA homepage");

  const expected=["Exercises","Strata+","Plan","Train"];
  assert.deepEqual(navLabels(home,"desktop-nav"),expected);
  assert.deepEqual(navLabels(discover,"studio-nav-desktop"),expected);
  assert.deepEqual(navLabels(planner,"planner-primary-nav-desktop"),expected);
  assert.deepEqual(navLabels(workout,"workout-nav-desktop"),expected);
  for(const labels of [navLabels(home,"desktop-nav"),navLabels(discover,"studio-nav-desktop"),navLabels(planner,"planner-primary-nav-desktop"),navLabels(workout,"workout-nav-desktop")]){
    assert.equal(labels.includes("Exercises"),true,"Use a familiar name for finding exercises in every primary navigation");
    assert.equal(labels.includes("Progress"),false,"Progress belongs inside Strata+, not global navigation");
    assert.equal(labels.includes("Account"),false,"Account remains a utility action, not a primary product destination");
  }
});

test("the public policies page publishes the founder story without cluttering the homepage",()=>{
  const home=read("index.html"),policies=read("policies.html");
  const founder=policies.match(/<section class="info-container policy-founder"[\s\S]*?<\/section>/)?.[0]||"";
  const copy=visibleText(founder);
  assert.doesNotMatch(home,/class="founder-section"/);
  assert.doesNotMatch(home,/href="#founder"/);
  assert.match(home,/href="\/policies"/);
  assert.match(policies,/id="founder"/);
  assert.match(policies,/href="#founder"/);
  assert.match(copy,/Saeed Abdalla Alketbi/);
  assert.match(copy,/founded by Saeed Abdalla Alketbi at 22/i);
  assert.match(copy,/third-year chemical engineering student at United Arab Emirates University \(UAEU\)/i);
  assert.match(copy,/Born and raised in the UAE and based in Al Ain/i);
  assert.match(copy,/Chemical Engineering · UAEU/i);
  assert.match(policies,/<div class="policy-founder-mark"[^>]*>[\s\S]*?<span>SK<\/span>/);
  assert.doesNotMatch(policies,/<div class="policy-founder-mark"[^>]*>[\s\S]*?<span>SA<\/span>/);
  assert.doesNotMatch(copy,/Zahkir|Malad|street 13|st\.?\s*13/i);
});

test("core footers use the policy directory instead of repeating every legal page",()=>{
  for(const page of ["account.html","discover.html","planner.html","install.html","delete-account.html","forgot-password.html","reset-password.html","verify-email.html","workout.html","admin.html"]){
    const footer=read(page).match(/<footer\b[\s\S]*?<\/footer>/)?.[0]||"";
    assert.match(footer,/href="\/policies"/,`${page} policy-directory link`);
    assert.doesNotMatch(footer,/href="\/(?:terms|privacy|refunds)"/,`${page} redundant policy link`);
  }
});

test("published Strata+ price and refund promise are exact and consistent",()=>{
  assert.equal(BUILD,"8.5.0");
  const pricingHtml=read("pricing.html"),pricing=text("pricing.html"),refunds=text("refunds.html"),terms=text("terms.html");
  assert.match(pricing,/Strata\+/);
  assert.match(pricing,/\$2\.99 USD/i);
  assert.match(pricing,/7-day trial/i);
  assert.match(pricing,/recurring monthly subscription/i);
  assert.match(pricing,/renews every month until canceled/i);
  assert.match(pricing,/Trials never charge you automatically/i);
  assert.match(pricing,/session building/i);
  assert.match(pricing,/community week previews/i);
  assert.match(pricing,/31-day planner/i);
  assert.match(pricing,/workout check-ins/i);
  assert.match(pricing,/Review suggested plan changes before saving/i);
  assert.match(pricing,/exercise setup and technique guides/i);
  assert.match(pricing,/manual Plan is not taken away when access ends/i);
  assert.match(pricingHtml,/href="\/planner\.html">Open free planner/);
  assert.match(pricingHtml,/Create my free account/);
  assert.match(pricingHtml,/free 7-day trial or explicitly subscribe for \$2\.99 USD per month/);
  assert.match(pricingHtml,/without an account; it stays in that browser[\s\S]*own synced Plan/);
  assert.match(pricingHtml,/href="\/refunds"/);
  assert.match(pricingHtml,/id="buyDiscovery"/);
  assert.match(pricingHtml,/src="https:\/\/cdn\.paddle\.com\/paddle\/v2\/paddle\.js"/);
  assert.match(pricingHtml,new RegExp(`src="/pricing\\.js\\?v=${BUILD.replace(/\./g,"\\.")}"`));
  assert.match(pricing,/Paddle is the merchant of record/i);
  assert.match(pricing,/unlocks after STRATA securely confirms the subscription/i);
  assert.match(refunds,/14 calendar days after an eligible Strata\+ monthly charge/i);
  assert.match(refunds,/original payment method/i);
  assert.match(refunds,/Cancellation does not automatically refund/i);
  assert.match(refunds,/Deleting a STRATA account is not cancellation and is not a refund/i);
  assert.match(terms,/\$2\.99 USD/i);
  assert.match(terms,/runs for 7 consecutive days/i);
  assert.match(terms,/recurring subscription/i);
  assert.match(terms,/renews monthly at \$2\.99 USD until canceled/i);
  assert.match(terms,/never converts into a subscription/i);
  assert.match(terms,/Paddle acts as merchant of record/i);
  assert.match(terms,/lifetime access purchased before this recurring offer remain grandfathered/i);
});

test("customer-facing product branding is Strata+ while compatibility identifiers stay stable",()=>{
  const pages=["index.html","pricing.html","account.html","discover.html","planner.html","contact.html","policies.html","terms.html","privacy.html","refunds.html","delete-account.html","admin.html"];
  const visibleCopy=pages.map(text).join(" ");
  const manifest=fs.readFileSync(path.join(PUBLIC_ROOT,"manifest.webmanifest"),"utf8");
  assert.match(visibleCopy,/Strata\+/);
  assert.doesNotMatch(visibleCopy,/\bDiscovery\b/);
  assert.match(manifest,/"name": "Strata\+ Studio"/);
  assert.match(read("pricing.html"),/id="buyDiscovery"/);
  assert.match(read("discover.html"),/href="\/discover\.html"/);
});

test("contact and policy pages publish the official support address and cross-links",()=>{
  const email="stratafitness.official@gmail.com";
  const contact=read("contact.html");
  assert.match(contact,new RegExp(`mailto:${email.replace(".","\\.")}`,"i"));
  assert.match(text("contact.html"),new RegExp(email.replace(".","\\."),"i"));
  for(const page of ["pricing.html","contact.html","policies.html","terms.html","privacy.html","refunds.html"]){
    assert.match(read(page),/class="info-nav"[^>]*>[\s\S]*href="\/planner\.html">Plan<\/a>/,`${page} Plan navigation`);
  }
  for(const page of ["policies.html","terms.html","privacy.html","refunds.html"]) {
    const html=read(page);
    assert.match(text(page),new RegExp(email.replace(".","\\."),"i"),`${page} support email`);
    for(const route of ["/policies","/terms","/privacy","/refunds"])assert.match(html,new RegExp(`href="${route}"`),`${page} ${route} link`);
  }
  assert.match(text("privacy.html"),/does not receive or store full payment-card or bank-account details/i);
});

test("support and deletion pages explain their important fallback and retention behavior",()=>{
  const contact=read("contact.html"),deletion=text("delete-account.html");
  assert.match(contact,/<noscript>[\s\S]*support form needs JavaScript[\s\S]*mailto:/i);
  assert.match(text("contact.html"),/signed-in requests use the name and email registered to the account/i);
  assert.match(deletion,/monthly plan/i);
  assert.match(deletion,/published (?:community-)?plan listing/i);
  assert.match(deletion,/support (?:requests|records)[\s\S]*administrator security logs[\s\S]*may be retained/i);
});

test("public policies distinguish self-service from guarded administrator deletion",()=>{
  const terms=text("terms.html"),privacy=text("privacy.html");
  for(const copy of [terms,privacy]){
    assert.match(copy,/authorized administrator/i);
    assert.match(copy,/paused non-owner account|non-owner account after pausing it/i);
    assert.match(copy,/does not cancel a live Paddle subscription|not subscription cancellation and is not a refund/i);
  }
  assert.match(terms,/one explicit review/i);
  assert.match(terms,/server-generated action-specific audit reason/i);
  assert.doesNotMatch(terms,/exact account email and an audit reason/i);
  assert.match(privacy,/re-checks Paddle and database blockers/i);
  assert.match(privacy,/cannot delete the primary owner/i);
});

test("community-plan policies explain publication, privacy, replacement, and removal",()=>{
  const privacy=text("privacy.html"),terms=text("terms.html");
  assert.match(privacy,/validated structured weekly plan/i);
  assert.match(privacy,/display name/i);
  assert.match(privacy,/email address and internal user identifier are not included in the listing/i);
  assert.match(privacy,/rather than uploading a binary file or attachment/i);
  assert.match(terms,/Only Strata\+ members can browse and apply community plans/i);
  assert.match(terms,/replaces your current saved week/i);
  assert.match(terms,/publisher can unpublish their listing/i);
});

test("public copy describes recurring checkout, cancellation, and grandfathered access",()=>{
  const publicCopy=["pricing.html","terms.html","privacy.html","refunds.html"].map(text).join(" ");
  assert.match(publicCopy,/\$2\.99 USD per month/i);
  assert.match(publicCopy,/renews monthly/i);
  assert.match(publicCopy,/grandfathered/i);
  assert.doesNotMatch(publicCopy,/permanent access/i);
  assert.doesNotMatch(publicCopy,/prelaunch|until checkout is activated|when paid checkout launches|when purchasing is available/i);
  assert.match(text("privacy.html"),/Paddle handles checkout, recurring payment/i);
  assert.match(text("privacy.html"),/current billing-period end/i);
  assert.match(text("refunds.html"),/Refunding the charge may end the paid Strata\+ access/i);
  const pricingClient=["pricing-logic.js","pricing-render.js","pricing.js"].map(name=>fs.readFileSync(path.join(PUBLIC_ROOT,"scripts",name),"utf8")).join("\n");
  assert.doesNotMatch(pricingClient,/permanently unlocked/i);
  assert.doesNotMatch(pricingClient,/Skip trial — subscribe/i);
  assert.match(pricingClient,/buyButton\.hidden=!canSubscribe\|\|trialEligible/);
  assert.match(pricingClient,/monthly subscription is active and renews on/);
  assert.match(pricingClient,/previous monthly subscription is canceled and will not renew/);
  assert.match(pricingClient,/error\.code==="CHECKOUT_PREPARING"/);
  assert.doesNotMatch(pricingClient,/error\.status===409/,"a concurrent-checkout response must stay retryable instead of impersonating a completed payment");
});
