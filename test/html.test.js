"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  escape,
  html,
  raw,
  setHtml,
  insertHtml,
  replaceHtml,
} = require("../public/scripts/html.js");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = path.join(ROOT, "public/scripts");

test("escape makes text safe for element content and quoted attributes", () => {
  assert.equal(
    escape(`<a href="x" title='y'>&</a>`),
    "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
  );
  assert.equal(escape(null), "");
  assert.equal(escape(undefined), "");
  assert.equal(escape(0), "0");
  assert.equal(escape("plain"), "plain");
});

test("html escapes every value put into it and keeps only raw() markup as it is", () => {
  const name = `<img src=x onerror="alert(1)">`;
  assert.equal(html`<li>${name}</li>`, "<li>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</li>");
  assert.equal(
    html`<b title="${`" onclick="x`}">${42}</b>`,
    '<b title="&quot; onclick=&quot;x">42</b>',
  );
  assert.equal(html`<p>${null}${undefined}</p>`, "<p></p>");
  const items = ["a<b", "c&d"].map((item) => html`<li>${item}</li>`);
  assert.equal(html`<ul>${raw(items)}</ul>`, "<ul><li>a&lt;b</li><li>c&amp;d</li></ul>");
  assert.equal(
    html`<ul>${items}</ul>`,
    "<ul>&lt;li&gt;a&amp;lt;b&lt;/li&gt;,&lt;li&gt;c&amp;amp;d&lt;/li&gt;</ul>",
  );
  assert.equal(
    html`${{ toString: () => "<x>" }}`,
    "&lt;x&gt;",
    "only raw() is trusted, not any object",
  );
  assert.equal(typeof html`<i></i>`, "string");
});

test("the three DOM writes go through one module", () => {
  const element = { innerHTML: "old", outerHTML: "old", inserted: [] };
  element.insertAdjacentHTML = (position, markup) => element.inserted.push([position, markup]);
  setHtml(element, html`<b>${"<i>"}</b>`);
  assert.equal(element.innerHTML, "<b>&lt;i&gt;</b>");
  setHtml(element, null);
  assert.equal(element.innerHTML, "");
  insertHtml(element, "beforeend", "<hr>");
  assert.deepEqual(element.inserted, [["beforeend", "<hr>"]]);
  replaceHtml(element, "<p></p>");
  assert.equal(element.outerHTML, "<p></p>");
});

test("browser code has one HTML escaper and writes markup only through html.js", () => {
  const files = fs
    .readdirSync(SCRIPTS)
    .filter((file) => file.endsWith(".js") && file !== "html.js");
  assert.ok(files.length > 80);
  for (const file of files) {
    const source = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
    assert.doesNotMatch(
      source,
      /"&amp;"/,
      `${file} must use StrataHtml.escape instead of its own escaper`,
    );
    assert.doesNotMatch(
      source,
      /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/,
      `${file} must write markup through StrataHtml`,
    );
    assert.doesNotMatch(
      source,
      /\.insertAdjacentHTML\s*\(/,
      `${file} must insert markup through StrataHtml`,
    );
  }
  const lint = fs.readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8");
  assert.match(lint, /"no-restricted-syntax"/);
  assert.match(lint, /ignores:\s*\["public\/scripts\/html\.js"\]/);
});
