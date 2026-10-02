"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  escape,
  html,
  raw,
  join,
  isMarkup,
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

test("html escapes every value put into it and returns trusted markup that nests once", () => {
  const name = `<img src=x onerror="alert(1)">`;
  assert.equal(
    String(html`<li>${name}</li>`),
    "<li>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</li>",
  );
  assert.equal(
    String(html`<b title="${`" onclick="x`}">${42}</b>`),
    '<b title="&quot; onclick=&quot;x">42</b>',
  );
  assert.equal(String(html`<p>${null}${undefined}</p>`), "<p></p>");
  assert.equal(typeof html`<i></i>`, "object");
  assert.ok(isMarkup(html`<i></i>`) && Object.isFrozen(html`<i></i>`));

  const items = ["a<b", "c&d"].map((item) => html`<li>${item}</li>`);
  assert.equal(
    String(html`<ul>${items}</ul>`),
    "<ul><li>a&lt;b</li><li>c&amp;d</li></ul>",
    "a list of markup is joined, not escaped again",
  );
  const inner = html`<b>${"x & y"}</b>`;
  assert.equal(
    String(html`<p>${inner} ${html`<i>${inner}</i>`}</p>`),
    "<p><b>x &amp; y</b> <i><b>x &amp; y</b></i></p>",
    "nested markup is escaped exactly once",
  );
  assert.equal(
    String(html`<ul>${["<a>", inner]}</ul>`),
    "<ul>&lt;a&gt;<b>x &amp; y</b></ul>",
    "plain strings in a list are still escaped",
  );
  assert.equal(
    String(html`${{ toString: () => "<x>" }}`),
    "&lt;x&gt;",
    "only html`` and raw() are trusted, not any object",
  );
  assert.equal(String(html`${String(inner)}`), "&lt;b&gt;x &amp;amp; y&lt;/b&gt;");
  assert.equal(
    String(html`<ul>${raw(["<li>1</li>", "<li>2</li>"])}</ul>`),
    "<ul><li>1</li><li>2</li></ul>",
  );
  assert.equal(String(join(["a<b", inner], ", ")), "a&lt;b, <b>x &amp; y</b>");
  assert.equal(String(join(["a", "b"], html`<br>`)), "a<br>b");
});

test("the three DOM writes go through one module and take only trusted markup", () => {
  const element = { innerHTML: "old", outerHTML: "old", inserted: [] };
  element.insertAdjacentHTML = (position, markup) => element.inserted.push([position, markup]);
  setHtml(element, html`<b>${"<i>"}</b>`);
  assert.equal(element.innerHTML, "<b>&lt;i&gt;</b>");
  setHtml(element, [html`<i>1</i>`, html`<i>2</i>`]);
  assert.equal(element.innerHTML, "<i>1</i><i>2</i>");
  insertHtml(element, "beforeend", html`<hr>`);
  assert.deepEqual(element.inserted, [["beforeend", "<hr>"]]);
  replaceHtml(element, raw("<p></p>"));
  assert.equal(element.outerHTML, "<p></p>");
  for (const refused of [
    "<img src=x onerror=alert(1)>",
    "",
    null,
    undefined,
    42,
    [html`<i></i>`, "<b>"],
  ]) {
    assert.throws(() => setHtml(element, refused), /setHtml takes markup built with html``/);
    assert.throws(() => insertHtml(element, "beforeend", refused), /insertHtml takes markup/);
    assert.throws(() => replaceHtml(element, refused), /replaceHtml takes markup/);
  }
  assert.equal(element.innerHTML, "<i>1</i><i>2</i>", "a refused write changes nothing");
});

test("browser code builds markup only with html`` and writes it only through html.js", () => {
  const files = fs
    .readdirSync(SCRIPTS)
    .filter((file) => file.endsWith(".js") && file !== "html.js");
  assert.ok(files.length > 80);
  for (const file of files) {
    const source = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
    assert.doesNotMatch(
      source,
      /"&amp;"/,
      `${file} must build markup with html\`\` instead of its own escaper`,
    );
    assert.doesNotMatch(
      source,
      /\bStrataHtml\.escape\b|\bescape:\s*\w+\s*}\s*=\s*StrataHtml/,
      `${file} must put values into html\`\` instead of escaping them by hand`,
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
  assert.match(lint, /TemplateLiteral:not\(TaggedTemplateExpression > TemplateLiteral\)/);
  assert.match(lint, /MemberExpression\[object\.name='StrataHtml'\]\[property\.name='escape'\]/);
});
