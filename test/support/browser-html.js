"use strict";

// Every page loads public/scripts/html.js first, so tests that run browser scripts in a vm context do too.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { escape } = require("../../public/scripts/html.js");

const HTML_SOURCE = fs.readFileSync(path.join(__dirname, "../../public/scripts/html.js"), "utf8");
const DECODED = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** @param {object} context A context made by vm.createContext. */
function loadHtml(context) {
  vm.runInContext(HTML_SOURCE, context, { filename: "html.js" });
  return context;
}

/**
 * A fake element whose textContent and innerHTML stay in step, as they do in a browser.
 * @param {object} [fields]
 */
function fakeElement(fields = {}) {
  let markup = "";
  const element = {
    get innerHTML() {
      return markup;
    },
    set innerHTML(value) {
      markup = String(value);
    },
    get textContent() {
      return markup
        .replace(/<[^>]*>/g, "")
        .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => DECODED[entity]);
    },
    set textContent(value) {
      markup = escape(value);
    },
  };
  return Object.assign(element, fields);
}

module.exports = { HTML_SOURCE, fakeElement, loadHtml };
