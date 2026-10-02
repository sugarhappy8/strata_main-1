/* global module */
// The one HTML escaper, and the one place browser code writes markup into the page. Every page loads
// this file first. Build markup with html`<li>${name}</li>`: every value put into it is escaped, so a
// member's text can never become a tag or an attribute. Markup that is already safe (another html``
// result, a reviewed constant) goes in through raw(). setHtml, insertHtml and replaceHtml are the only
// writes to innerHTML, insertAdjacentHTML and outerHTML; ESLint rejects any other.
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

  /**
   * Marks markup that is already safe, so html`` keeps it as it is. A list is joined.
   * @param {unknown} markup
   */
  function raw(markup) {
    return Object.freeze({
      [TRUSTED]: Array.isArray(markup) ? markup.join("") : String(markup ?? ""),
    });
  }

  /**
   * Tagged template that escapes every value put into it, except raw() markup. Returns a string.
   * @param {TemplateStringsArray} strings
   * @param {...unknown} values
   */
  function html(strings, ...values) {
    let markup = strings[0];
    values.forEach((value, index) => {
      const trusted = value !== null && typeof value === "object" && TRUSTED in value;
      markup += (trusted ? value[TRUSTED] : escape(value)) + strings[index + 1];
    });
    return markup;
  }

  /**
   * Replaces an element's content with markup built by html`` or escape().
   * @param {{innerHTML:string}} element
   * @param {unknown} markup
   */
  function setHtml(element, markup) {
    element.innerHTML = String(markup ?? "");
  }

  /**
   * Inserts markup built by html`` or escape() next to or inside an element.
   * @param {{insertAdjacentHTML:(position:InsertPosition,markup:string)=>void}} element
   * @param {InsertPosition} position
   * @param {unknown} markup
   */
  function insertHtml(element, position, markup) {
    element.insertAdjacentHTML(position, String(markup ?? ""));
  }

  /**
   * Replaces an element itself with markup built by html`` or escape().
   * @param {{outerHTML:string}} element
   * @param {unknown} markup
   */
  function replaceHtml(element, markup) {
    element.outerHTML = String(markup ?? "");
  }

  return Object.freeze({ escape, html, raw, setHtml, insertHtml, replaceHtml });
});
