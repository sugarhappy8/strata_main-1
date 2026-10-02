"use strict";

// The scripts a page runs, in order: its script tags, with a <script type="module"> entry standing for the
// scripts it imports. Tests ask this instead of searching the HTML, so they hold for either way of loading.
const fs = require("node:fs");
const path = require("node:path");
const { htmlScripts } = require("../../scripts/frontend-architecture-report");

const PUBLIC = path.join(__dirname, "../../public");

/** @param {string} page A file name under public/pages/, such as "discover.html". */
function pageScripts(page) {
  const html = fs.readFileSync(path.join(PUBLIC, "pages", page), "utf8");
  return htmlScripts(html, (asset) =>
    fs.readFileSync(path.join(PUBLIC, "scripts", asset.split("/").at(-1)), "utf8"),
  ).map((asset) => asset.split("/").at(-1));
}

module.exports = { pageScripts };
