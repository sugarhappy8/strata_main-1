"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { securityHeaders } = require("../src/http");

const ROOT = join(__dirname, "..");
const PUBLIC = join(ROOT, "public");
const PAGES = join(PUBLIC, "pages");
const STYLES = join(PUBLIC, "styles");
const BUILD =
  require(join(ROOT, "package.json")).strataBuild || require(join(ROOT, "package.json")).version;
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex
      .slice(1)
      .match(/.{2}/g)
      .map((value) => Number.parseInt(value, 16) / 255);
    const [red, green, blue] = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground),
    second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("every public page loads the self-hosted fonts and no runtime CDN font or image", () => {
  const forbidden =
    /https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|images\.unsplash\.com)\b/i;
  const fontLink = new RegExp(`href=["']/fonts\\.css\\?v=${BUILD.replace(/\./g, "\\.")}["']`, "g");
  for (const name of readdirSync(PAGES).filter((entry) => entry.endsWith(".html"))) {
    const source = read(`public/pages/${name}`);
    assert.doesNotMatch(
      source,
      forbidden,
      `${name} must not request a third-party font or image runtime`,
    );
    assert.equal(
      (source.match(fontLink) || []).length,
      1,
      `${name} must load the versioned self-hosted font stylesheet once`,
    );
  }
  for (const name of readdirSync(STYLES).filter((entry) => entry.endsWith(".css"))) {
    assert.doesNotMatch(
      read(`public/styles/${name}`),
      forbidden,
      `${name} must not request a third-party font or image runtime`,
    );
  }
});

test("font files, homepage photographs, credits, and licenses stay bundled", () => {
  const fonts = read("public/styles/fonts.css");
  for (const path of [
    "manrope-latin.woff2",
    "dm-mono-400-latin.woff2",
    "dm-mono-500-latin.woff2",
  ]) {
    const absolute = join(PUBLIC, "fonts", path);
    assert.ok(statSync(absolute).size > 8_000, `${path} must contain a real bundled font`);
    assert.equal(
      readFileSync(absolute).subarray(0, 4).toString("ascii"),
      "wOF2",
      `${path} WOFF2 signature`,
    );
    assert.match(
      fonts,
      new RegExp(`url\\(["']?/fonts/${path.replace(".", "\\.")}["']?\\)`),
      `${path} font-face source`,
    );
  }
  assert.equal((fonts.match(/@font-face/g) || []).length, 3);
  assert.doesNotMatch(fonts, /https?\s*:\s*\/\//);

  const home = read("public/pages/index.html"),
    homeCss = read("public/styles/styles.css");
  assert.match(homeCss, /background-image:\s*url\(["']\/images\/hero-training\.jpg["']\)/);
  assert.match(
    home,
    /<div class="hero-credit">[\s\S]*?href="https:\/\/unsplash\.com\/photos\/a-man-doing-a-pull-up-on-a-bar-in-a-gym-ThLzcgVeU5I"[\s\S]*?Corey Young \/ Unsplash[\s\S]*?<\/div>/,
  );
  for (const path of ["hero-training.jpg"]) {
    const body = readFileSync(join(PUBLIC, "images", path));
    assert.ok(body.length > 100_000, `${path} must contain the retained photograph`);
    assert.deepEqual([...body.subarray(0, 3)], [0xff, 0xd8, 0xff], `${path} JPEG signature`);
  }

  const notices = read("docs/third-party-assets.md");
  assert.match(notices, /Copyright 2018 The Manrope Project Authors/);
  assert.match(notices, /Copyright 2020 The DM Mono Project Authors/);
  assert.match(notices, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(notices, /hero-training\.jpg[\s\S]*Corey Young/);
});

test("privacy copy and the content policy describe and enforce same-origin assets", () => {
  const privacy = read("public/pages/privacy.html");
  assert.match(
    privacy,
    /serves its display fonts and homepage photographs from the same STRATA origin/i,
  );
  assert.match(privacy, /does not contact Google Fonts or Unsplash/i);
  assert.match(privacy, /credit links[\s\S]*only when you choose to follow their links/i);

  const csp = securityHeaders()["Content-Security-Policy"];
  const directives = Object.fromEntries(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((part) => part[0])
      .map(([name, ...sources]) => [name, sources]),
  );
  assert.deepEqual(directives["font-src"], ["'self'"]);
  assert.deepEqual(directives["style-src"], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(directives["img-src"], ["'self'", "https://*.paddle.com", "data:"]);
  assert.doesNotMatch(csp, /fonts\s*\.googleapis|fonts\s*\.gstatic|images\s*\.unsplash/i);
});

test("homepage source notes meet normal-text contrast", () => {
  const css = read("public/styles/styles.css");
  const colors = css.match(
    /\.sources-section\s*\{\s*--muted:\s*(#[0-9a-f]{6});[^}]*background:\s*(#[0-9a-f]{6})/i,
  );
  assert.ok(colors, "sources section must define a scoped muted foreground and background");
  assert.ok(
    contrastRatio(colors[1], colors[2]) >= 4.5,
    `source-note contrast must be at least 4.5:1, got ${contrastRatio(colors[1], colors[2]).toFixed(2)}:1`,
  );
});
