/* global module */
// The one HTML escaper, and the one place browser code writes markup into the page. Every page loads
// this file first. Build markup with html`<li>${name}</li>`: every value put into it is escaped, so a
// member's text can never become a tag or an attribute. html`` returns trusted markup, not a string, so
// it nests without being escaped twice; a list of it is joined. Markup that is already safe in some
// other form (a reviewed constant, markup read back from the page) goes in through raw().
// setHtml, insertHtml and replaceHtml are the only writes to innerHTML, insertAdjacentHTML and
// outerHTML, and they take only trusted markup: a plain string is refused. ESLint rejects any other write.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.StrataHtml = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENTITIES = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  });
  const TRUSTED = Symbol("trusted markup");

  /**
   * Text made safe for element content and quoted attribute values.
   * @param {unknown} value
   */
  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ENTITIES[character]);
  }

  /** @param {string} text */
  function trusted(text) {
    return Object.freeze({ [TRUSTED]: text, toString: () => text });
  }

  /**
   * Whether a value is trusted markup made by html`` or raw().
   * @param {unknown} value
   */
  function isMarkup(value) {
    return value !== null && typeof value === "object" && TRUSTED in value;
  }

  /**
   * One value put into html``: trusted markup as it is, a list item by item, anything else escaped.
   * @param {unknown} value
   * @returns {string}
   */
  function part(value) {
    if (isMarkup(value)) return value[TRUSTED];
    if (Array.isArray(value)) return value.map(part).join("");
    return escape(value);
  }

  /**
   * Marks markup that is already safe, so html`` keeps it as it is. A list is joined.
   * @param {unknown} markup
   */
  function raw(markup) {
    return trusted(Array.isArray(markup) ? markup.join("") : String(markup ?? ""));
  }

  /**
   * Tagged template that escapes every value put into it, except trusted markup. Returns trusted markup.
   * @param {TemplateStringsArray} strings
   * @param {...unknown} values
   */
  function html(strings, ...values) {
    let markup = strings[0];
    values.forEach((value, index) => {
      markup += part(value) + strings[index + 1];
    });
    return trusted(markup);
  }

  /**
   * Joins a list with a separator; each item and the separator are escaped unless they are markup.
   * @param {unknown[]} items
   * @param {unknown} separator
   */
  function join(items, separator) {
    const between = part(separator);
    return trusted(items.map(part).join(between));
  }

  /**
   * The text of trusted markup, or of a list of it. Anything else is refused.
   * @param {unknown} markup
   * @param {string} write
   */
  function markupFor(markup, write) {
    if (isMarkup(markup)) return markup[TRUSTED];
    if (Array.isArray(markup) && markup.every(isMarkup)) return part(markup);
    throw new TypeError(
      `StrataHtml.${write} takes markup built with html\`\`; use textContent for text.`,
    );
  }

  /**
   * Replaces an element's content with markup built by html``.
   * @param {{innerHTML:string}} element
   * @param {unknown} markup
   */
  function setHtml(element, markup) {
    element.innerHTML = markupFor(markup, "setHtml");
  }

  /**
   * Inserts markup built by html`` next to or inside an element.
   * @param {{insertAdjacentHTML:(position:InsertPosition,markup:string)=>void}} element
   * @param {InsertPosition} position
   * @param {unknown} markup
   */
  function insertHtml(element, position, markup) {
    element.insertAdjacentHTML(position, markupFor(markup, "insertHtml"));
  }

  /**
   * Replaces an element itself with markup built by html``.
   * @param {{outerHTML:string}} element
   * @param {unknown} markup
   */
  function replaceHtml(element, markup) {
    element.outerHTML = markupFor(markup, "replaceHtml");
  }

  return Object.freeze({ escape, html, raw, join, isMarkup, setHtml, insertHtml, replaceHtml });
});
