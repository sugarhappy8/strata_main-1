"use strict";
/* global document, getComputedStyle, NodeFilter */

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const ROOT = join(__dirname, "..", "..");
const WIDTHS = [320, 360, 390, 430, 600, 700, 768];
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function headerFrom(path) {
  const match = read(path).match(/<header\b[\s\S]*?<\/header>/i);
  assert.ok(match, `${path} must contain a header`);
  return match[0];
}

async function layout(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
}
async function rect(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} must render`);
  return {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  };
}
async function rects(page, selector) {
  const boxes = await page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    }),
  );
  return boxes;
}

function inside(inner, outer, label) {
  assert.ok(
    inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5,
    `${label} must stay inside its component`,
  );
}

test(
  "Strata+ content keeps long labels and persistent controls in separate responsive space",
  { timeout: 30_000 },
  async () => {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    const browser = await chromium.launch(options),
      page = await browser.newPage({ viewport: { width: 768, height: 800 } });
    try {
      const css = read("public/styles/discover.css");
      const markup = `
      <main class="studio-container">
        <article class="exercise-card"><div class="card-topline"><span class="match-pill">96% personal match</span><div class="card-tools"><button class="movement-save is-compact"><span>+</span><b>Save</b></button><button class="score-button"><strong>95</strong><span>FitScore</span></button></div></div><h3>Behind-body Cable Lateral Raise With A Deliberately Long Name</h3><span class="target">Shoulders / side delts</span><p>A complete explanation remains readable without escaping the card.</p><div class="mini-meta"><span>Cables</span><span>Raise / press</span><span>Intermediate</span></div><div class="community-line"><span>Community rating</span><strong>Not rated yet</strong></div><div class="mini-actions"><button>Inspect</button><button>Compare +</button><a href="#">Add to plan</a></div></article>
div>
        <section class="training-block-card"><h3>4–8 week block</h3><p>Optional structure that never rewrites the weekly plan.</p><form id="trainingBlockForm"><label>Block length<select><option>8 weeks</option></select></label><label>Start date<input type="date" value="2026-09-07" /></label><label>Current week<select><option>Week 8</option></select></label><label>Status<select><option>Completed</option></select></label><label class="training-block-check"><input type="checkbox" /><span><strong>Mark the final week as lighter</strong><small>A reminder to review a lower workload; your weekly Plan is not edited.</small></span></label><div class="training-block-actions"><button class="button">Save training block</button><span>Review the suggested start date. Nothing changes until you save.</span></div></form></section>
        <div class="detail-hero"><div class="dialog-head"><p class="kicker">Exercise intelligence / shoulders</p><button class="icon-button" aria-label="Close exercise details">×</button></div><h2 class="detail-title">Behind-body Cable Lateral Raise</h2></div>
      </main>
      <aside class="compare-tray"><div><span>Exercise battle</span><p>Seated Leg Curl vs. Behind-body Cable Lateral Raise</p></div><div class="compare-tray-actions"><button class="plain-button light">Clear</button><button class="button button-accent">Compare <span>2/4</span></button></div></aside>
      <nav class="studio-nav studio-nav-mobile"><a>Rankings</a><a>Strata+</a><a>Plan</a><a>Train</a></nav>`;
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(`<style>${css}</style><body class="plus-studio">${markup}</body>`);
        const result = await layout(page),
          card = await rect(page, ".exercise-card"),
          tray = await rect(page, ".compare-tray"),
          nav = width <= 760 ? await rect(page, ".studio-nav-mobile") : null;
        assert.ok(
          result.overflow <= 1,
          `Strata+ fixture overflows ${width}px by ${result.overflow}px`,
        );
        for (const [selector, label] of [
          [".exercise-card h3", "long exercise name"],
          [".mini-actions", "exercise actions"],
        ])
          inside(await rect(page, selector), card, `${label} at ${width}px`);
        const block = await rect(page, ".training-block-card"),
          blockForm = await rect(page, "#trainingBlockForm");
        inside(blockForm, block, `training block form at ${width}px`);
        for (const control of await rects(
          page,
          "#trainingBlockForm > label,#trainingBlockForm > .training-block-actions",
        ))
          inside(control, blockForm, `training block control at ${width}px`);
        if (width <= 760) {
          assert.ok(
            tray.bottom <= nav.top + 0.5,
            `comparison tray overlaps mobile navigation at ${width}px`,
          );
        }
        if (width <= 680) {
          const styles = await page.evaluate(() => {
            const close = getComputedStyle(document.querySelector(".detail-hero .icon-button")),
              kicker = getComputedStyle(document.querySelector(".detail-hero .kicker"));
            return { closeColor: close.color, kickerDisplay: kicker.display };
          });
          assert.equal(
            styles.closeColor,
            "rgb(250, 249, 245)",
            `detail close control must remain visible at ${width}px`,
          );
          assert.notEqual(
            styles.kickerDisplay,
            "none",
            `detail heading must not become a blank bar at ${width}px`,
          );
        }
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test(
  "pricing benefits keep their descriptions in the readable content column",
  { timeout: 30_000 },
  async () => {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    const browser = await chromium.launch(options),
      page = await browser.newPage({ viewport: { width: 1252, height: 900 } });
    try {
      const pricing = read("public/pages/pricing.html"),
        benefits = pricing.match(/<ul class="feature-list plus-benefits">[\s\S]*?<\/ul>/)?.[0];
      assert.ok(benefits, "pricing page must include the Strata+ benefit list");
      const styles = `${read("public/styles/site-info.css")}\n${read("public/styles/experience.css")}`;
      for (const width of [1440, 1252, 981, 980, 768, 430, 320]) {
        await page.setViewportSize({ width, height: Math.max(700, Math.round(width * 0.75)) });
        await page.setContent(
          `<style>${styles}</style><body class="pricing-page"><main class="info-main"><div class="info-container pricing-grid"><article class="price-card">${benefits}</article><article class="free-card"></article></div></main></body>`,
        );
        const result = await layout(page),
          rows = await page.locator(".plus-benefits li").evaluateAll((items) =>
            items.map((item) => {
              const itemBox = item.getBoundingClientRect(),
                heading = item.querySelector("strong"),
                headingBox = heading.getBoundingClientRect(),
                descriptionRects = [];
              const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
              while (walker.nextNode()) {
                const text = walker.currentNode;
                if (!text.nodeValue.trim() || heading.contains(text)) continue;
                const range = document.createRange();
                range.selectNodeContents(text);
                descriptionRects.push(
                  ...[...range.getClientRects()]
                    .filter((rect) => rect.width > 0)
                    .map((rect) => ({ left: rect.left, width: rect.width })),
                );
              }
              return {
                left: itemBox.left,
                width: itemBox.width,
                height: itemBox.height,
                headingLeft: headingBox.left,
                lineHeight: parseFloat(getComputedStyle(item).lineHeight),
                descriptionRects,
              };
            }),
          );
        assert.equal(rows.length, 6, `pricing must keep all six benefits at ${width}px`);
        assert.ok(
          result.overflow <= 1,
          `pricing benefit list overflows ${width}px by ${result.overflow}px`,
        );
        for (const [index, row] of rows.entries()) {
          assert.ok(
            row.descriptionRects.length > 0,
            `pricing benefit ${index + 1} must expose readable copy at ${width}px`,
          );
          const descriptionLeft = Math.min(...row.descriptionRects.map(({ left }) => left));
          const widestLine = Math.max(
            ...row.descriptionRects.map(({ width: lineWidth }) => lineWidth),
          );
          const availableWidth = row.width - (row.headingLeft - row.left);
          assert.ok(
            descriptionLeft >= row.headingLeft - 1,
            `pricing benefit ${index + 1} description fell into the icon column at ${width}px`,
          );
          assert.ok(
            widestLine >= Math.min(120, availableWidth * 0.55),
            `pricing benefit ${index + 1} description is trapped in a ${widestLine}px text column at ${width}px`,
          );
          assert.ok(
            row.height <= row.lineHeight * 10,
            `pricing benefit ${index + 1} became ${row.height}px tall at ${width}px`,
          );
        }
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test(
  "pricing hero keeps actions readable at release breakpoints",
  { timeout: 30_000 },
  async () => {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    const browser = await chromium.launch(options),
      page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const pricing = read("public/pages/pricing.html"),
        hero = pricing.match(/<section class="info-hero"[\s\S]*?<\/section>/)?.[0];
      assert.ok(hero, "pricing page must include its purchase hero");
      const disclosures = [
        ...pricing.matchAll(/<details class="[^"]*pricing-disclosure[^"]*"[\s\S]*?<\/details>/g),
      ].map((match) => match[0]);
      const styles = `${read("public/styles/site-info.css")}\n${read("public/styles/experience.css")}`;
      for (const width of [1440, 981, 800, 768, 430, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.setContent(
          `<style>${styles}</style><body class="pricing-page"><main>${hero}<section class="info-main">${disclosures.join("")}</section></main></body>`,
        );
        const result = await layout(page),
          container = await rect(page, ".info-hero .info-container"),
          actions = await rect(page, ".purchase-actions"),
          status = await rect(page, "#purchaseStatus"),
          primary = await rect(page, "#purchaseSignup");
        assert.ok(
          result.overflow <= 1,
          `pricing hero overflows ${width}px by ${result.overflow}px`,
        );
        inside(actions, container, `pricing actions at ${width}px`);
        inside(status, container, `pricing status at ${width}px`);
        assert.ok(
          actions.bottom <= status.top + 1,
          `pricing status overlaps its actions at ${width}px`,
        );
        assert.ok(
          primary.width >= 44 && primary.height >= 44,
          `pricing primary action is too small at ${width}px`,
        );
        for (const summary of await rects(page, ".pricing-disclosure > summary")) {
          assert.ok(
            summary.width >= 44 && summary.height >= 44,
            `pricing disclosure control is too small at ${width}px`,
          );
        }
        const collapsed = await page
          .locator(".pricing-disclosure:not([open])")
          .evaluateAll((nodes) =>
            nodes.every((node) => {
              const box = node.getBoundingClientRect(),
                summary = node.querySelector(":scope > summary")?.getBoundingClientRect();
              return Boolean(summary) && box.height <= summary.height + 2;
            }),
          );
        assert.equal(
          collapsed,
          true,
          `closed pricing details must not add visual clutter at ${width}px`,
        );
        if (width <= 430)
          assert.ok(
            primary.bottom <= 844,
            `pricing primary action must appear in the first mobile viewport at ${width}px`,
          );
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test(
  "workout controls give long movement names and narrow inputs their own rows",
  { timeout: 30_000 },
  async () => {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    const browser = await chromium.launch(options),
      page = await browser.newPage({
        viewport: { width: 768, height: 800 },
        reducedMotion: "reduce",
      });
    try {
      const css = read("public/styles/workout.css"),
        markup = `
      <article class="exercise-card"><div class="exercise-heading"><span class="exercise-index">01</span><div><h3>Single-leg Dumbbell Romanian Deadlift</h3><p>Planned: 3 × 8–12 / side · Dumbbells</p></div><span class="exercise-progress">0/3 sets</span></div><div class="format-controls"><label class="field">Record<select><option>Time in seconds</option></select></label><label class="field">Load type<select><option>External load</option></select></label><label class="field">Unit<select><option>kg</option></select></label></div><table class="sets-table"><thead><tr><th>Set</th><th>Load (kg)</th><th>Reps</th><th>Completed</th></tr></thead><tbody><tr><td>1</td><td><input /></td><td><input /></td><td><button class="set-check">Mark done</button></td></tr></tbody></table></article>
      <div class="rest-timer"><div class="timer-readout"><span>Rest timer</span><strong>1:30</strong></div><select><option>90 sec</option></select><button class="button">Start rest</button><button class="button quiet">Reset</button></div>
      <div class="save-strip"><span>Ready</span><div class="actions"><button class="button">Save now</button><button class="button">Save &amp; close</button><button class="button">Download draft</button></div></div>
      <section class="panel celebration"><form class="check-in"><div class="check-in-heading"><div><p class="eyebrow">Optional · about 15 seconds</p><h3>How did this session feel?</h3></div><p>Your explicit answers can shape one small suggestion for next time.</p></div><div class="check-in-grid"><label>Difficulty<select><option>5 · Very hard</option></select></label><label>Energy<select><option>1 · Very low</option></select></label><label>Comfort<select><option>1 · Very uncomfortable</option></select></label><label>Enjoyment<select><option>1 · Not enjoyable</option></select></label></div><div class="check-in-actions"><button class="button primary">Save check-in</button><span>Couldn't save — Retry when ready.</span></div></form><section class="adaptation-proposal"><p class="eyebrow">Plan change available</p><h3>Review a smaller next session.</h3><p class="adaptation-change">Monday · Single-leg Dumbbell Romanian Deadlift · 4 to 3 sets</p><div class="actions"><button class="button primary">Approve this plan change</button><button class="button secondary">Keep my current plan</button></div></section></section>
      <dialog open><div class="section-heading"><h2>A completed workout with a deliberately long title</h2><button class="button quiet compact">Close ×</button></div><div class="detail-set"><span>Set 12</span><span>1,000 reps · 1,000 lb assistance</span><span class="done">✓ Done</span></div></dialog>`;
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(`<style>${css}</style><body class="workout-page">${markup}</body>`);
        const result = await layout(page),
          card = await rect(page, ".exercise-card"),
          heading = await rect(page, ".exercise-heading");
        assert.ok(
          result.overflow <= 1,
          `workout fixture overflows ${width}px by ${result.overflow}px`,
        );
        inside(
          await rect(page, ".exercise-heading h3"),
          heading,
          `workout exercise name at ${width}px`,
        );
        inside(await rect(page, ".sets-table"), card, `workout set table at ${width}px`);
        if (width <= 420) {
          const title = await rect(page, ".exercise-heading > div"),
            progress = await rect(page, ".exercise-progress");
          assert.ok(
            progress.top >= title.bottom - 1,
            `set progress must not squeeze the movement name at ${width}px`,
          );
          const saveActions = await rect(page, ".save-strip .actions");
          for (const button of await rects(page, ".save-strip .actions .button"))
            inside(button, saveActions, `save action at ${width}px`);
          const adaptation = await rect(page, ".adaptation-proposal");
          for (const button of await rects(page, ".adaptation-proposal .actions .button"))
            inside(button, adaptation, `adaptation action at ${width}px`);
        }
        if (width <= 340)
          assert.ok(
            (await rect(page, ".format-controls select")).width >= card.width - 32,
            `320px logging choices must show their complete labels`,
          );
        const checkIn = await rect(page, ".check-in");
        for (const select of await rects(page, ".check-in-grid select"))
          inside(select, checkIn, `check-in choice at ${width}px`);
        const dialog = await rect(page, "dialog");
        inside(
          await rect(page, "dialog .section-heading"),
          dialog,
          `workout dialog heading at ${width}px`,
        );
        inside(await rect(page, "dialog .detail-set"), dialog, `workout detail row at ${width}px`);
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test(
  "weekly setup navigation fills the available mobile width at every supported breakpoint",
  { timeout: 30_000 },
  async () => {
    const options = { headless: true };
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH)
      options.executablePath = resolve(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
    const browser = await chromium.launch(options),
      page = await browser.newPage({ viewport: { width: 768, height: 800 } });
    try {
      const css = `${read("public/styles/onboarding.css")}\n${read("public/styles/product-nav.css")}`,
        header = headerFrom("public/pages/onboarding.html");
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.setContent(`<style>${css}</style><body class="setup-page">${header}</body>`);
        const result = await layout(page),
          links = await rects(page, ".product-nav a");
        assert.ok(
          result.overflow <= 1,
          `setup navigation overflows ${width}px by ${result.overflow}px`,
        );
        assert.equal(links.length, 5);
        assert.ok(
          Math.max(...links.map(({ width: linkWidth }) => linkWidth)) -
            Math.min(...links.map(({ width: linkWidth }) => linkWidth)) <=
            1,
          `setup navigation columns are uneven at ${width}px`,
        );
        assert.ok(
          links.every(({ width: linkWidth, height }) => linkWidth >= 44 && height >= 44),
          `setup navigation loses a touch target at ${width}px`,
        );
        assert.equal(
          await page
            .locator(".setup-header")
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          "rgb(14, 16, 13)",
          `setup header must stay opaque while content scrolls at ${width}px`,
        );
      }
    } finally {
      await page.close();
      await browser.close();
    }
  },
);
