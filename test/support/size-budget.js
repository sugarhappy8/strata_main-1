"use strict";

// The reviewed line budget for a browser module comes from frontend-architecture-policy.json, so tests and the
// architecture report never disagree about how large a module may grow.
const policy = require("../../frontend-architecture-policy.json");

const budgets = new Map();
for (const page of Object.values(policy.pages))
  for (const module of page.modules) budgets.set(module.file, module.maxLines);

/** @param {string} file A file name under public/scripts/. */
function frontendBudget(file) {
  const budget = budgets.get(`public/scripts/${file}`);
  if (!Number.isSafeInteger(budget))
    throw new Error(`No reviewed line budget for public/scripts/${file}.`);
  return budget;
}

/** Lines as the architecture report counts them. @param {string} source */
function lineCount(source) {
  return (source.endsWith("\n") ? source.slice(0, -1) : source).split("\n").length;
}

module.exports = { frontendBudget, lineCount };
