"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");
const { parse, VisitorKeys } = require("espree");

const PROJECT_ROOT = join(__dirname, "..");
const POLICY_PATH = join(PROJECT_ROOT, "architecture-policy.json");
const slash = (value) => value.split(sep).join("/");

function sourceFiles(root = PROJECT_ROOT) {
  const files = ["server.js"];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".js"))
        files.push(slash(relative(root, absolute)));
    }
  }
  walk(join(root, "src"));
  return files.sort();
}

function moduleReferences(source, file = "module.js") {
  const specifiers = [],
    unsafe = [];
  let syntax;
  try {
    syntax = parse(source, { ecmaVersion: "latest", sourceType: "module", loc: true });
  } catch (error) {
    return {
      specifiers: [],
      unsafe: [`${file} could not be parsed for dependencies: ${error.message}`],
    };
  }
  function location(node) {
    return `${file}:${node.loc?.start?.line || 1}:${(node.loc?.start?.column || 0) + 1}`;
  }
  function record(kind, node, candidates) {
    if (
      candidates.length !== 1 ||
      candidates[0]?.type !== "Literal" ||
      typeof candidates[0].value !== "string"
    ) {
      unsafe.push(`${location(node)} ${kind} must use exactly one string literal.`);
      return;
    }
    specifiers.push(candidates[0].value);
  }
  function computedMemberName(node) {
    if (!node?.computed) return "";
    if (node.property?.type === "Literal" && typeof node.property.value === "string")
      return node.property.value;
    if (node.property?.type === "TemplateLiteral" && node.property.expressions.length === 0) {
      return node.property.quasis[0]?.value?.cooked || "";
    }
    return "";
  }
  function isDirectNodeModuleRequire(node) {
    return (
      node?.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === "Literal" &&
      ["module", "node:module"].includes(node.arguments[0].value)
    );
  }
  function visit(node, parent = null) {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      record("require", node, node.arguments);
    } else if (node.type === "ImportExpression") {
      record("import", node, [node.source]);
    } else if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
      node.source
    ) {
      record("module specifier", node, [node.source]);
    }
    if (
      node.type === "Identifier" &&
      node.name === "require" &&
      !(parent?.type === "CallExpression" && parent.callee === node)
    ) {
      unsafe.push(`${location(node)} require may only be called directly with one string literal.`);
    }
    if (node.type === "Identifier" && node.name === "createRequire") {
      unsafe.push(
        `${location(node)} createRequire is outside the auditable module-loading policy.`,
      );
    }
    const memberName = node.type === "MemberExpression" ? computedMemberName(node) : "";
    if (memberName === "require" || memberName === "createRequire") {
      unsafe.push(
        `${location(node)} computed ${memberName} access is outside the auditable module-loading policy.`,
      );
    }
    if (
      node.type === "MemberExpression" &&
      node.computed &&
      !memberName &&
      ((node.object?.type === "Identifier" && node.object.name === "module") ||
        isDirectNodeModuleRequire(node.object))
    ) {
      unsafe.push(
        `${location(node)} computed access on a module loader is outside the auditable module-loading policy.`,
      );
    }
    for (const key of VisitorKeys[node.type] || []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const entry of child) if (entry) visit(entry, node);
      } else if (child) visit(child, node);
    }
  }
  visit(syntax);
  return { specifiers: [...new Set(specifiers)].sort(), unsafe: [...new Set(unsafe)] };
}

function localDependencies(source, file, root = PROJECT_ROOT) {
  const dependencies = [];
  for (const specifier of moduleReferences(source, file).specifiers.filter((value) =>
    value.startsWith("."),
  )) {
    const target = specifier.endsWith(".js") ? specifier : `${specifier}.js`;
    dependencies.push(slash(relative(root, resolve(dirname(join(root, file)), target))));
  }
  return [...new Set(dependencies)].sort();
}

function analyzeArchitecture(root = PROJECT_ROOT) {
  return sourceFiles(root).map((file) => {
    const source = readFileSync(join(root, file), "utf8");
    const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
    const references = moduleReferences(source, file);
    return {
      file,
      lines: lines.length,
      sourceLines: lines.filter((line) => line.trim()).length,
      bytes: Buffer.byteLength(source),
      dependencies: localDependencies(source, file, root),
      unsafeReferences: references.unsafe,
    };
  });
}

function dependencyCycles(modules) {
  const graph = new Map(modules.map((entry) => [entry.file, entry.dependencies]));
  const visited = new Set(),
    active = new Set(),
    stack = [],
    cycles = [];
  function visit(file) {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) if (graph.has(dependency)) visit(dependency);
    stack.pop();
    active.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function validateArchitecture(modules, policy) {
  const errors = [],
    byFile = new Map(modules.map((entry) => [entry.file, entry]));
  const policyFiles = Object.keys(policy.modules).sort();
  const actualFiles = [...byFile.keys()].sort();
  for (const file of actualFiles)
    if (!policy.modules[file]) errors.push(`${file} is not assigned an architectural role.`);
  for (const file of policyFiles)
    if (!byFile.has(file)) errors.push(`${file} is in the policy but does not exist.`);
  for (const entry of modules) {
    const rule = policy.modules[entry.file];
    if (!rule) continue;
    if (entry.lines > rule.maxLines)
      errors.push(
        `${entry.file} has ${entry.lines} lines; its reviewed budget is ${rule.maxLines}.`,
      );
    for (const unsafe of entry.unsafeReferences || []) errors.push(unsafe);
    for (const dependency of entry.dependencies) {
      if (!byFile.has(dependency))
        errors.push(`${entry.file} has an unresolved local dependency on ${dependency}.`);
      else if (!rule.allowedDependencies.includes(dependency))
        errors.push(`${entry.file} may not depend on ${dependency}.`);
    }
  }
  for (const cycle of dependencyCycles(modules))
    errors.push(`Dependency cycle: ${cycle.join(" -> ")}.`);
  return errors;
}

function formatBytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function markdownReport(modules, policy) {
  const rows = modules.map((entry) => {
    const role = policy.modules[entry.file]?.role || "Unassigned";
    const budget = policy.modules[entry.file]?.maxLines ?? "—";
    const dependencies = entry.dependencies.length
      ? entry.dependencies.map((file) => `\`${file}\``).join(", ")
      : "—";
    return `| \`${entry.file}\` | ${role} | ${entry.lines} | ${entry.sourceLines} | ${formatBytes(entry.bytes)} | ${budget} | ${dependencies} |`;
  });
  return [
    "| Module | Responsibility | Lines | Nonblank | Size | Line budget | Local dependencies |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
  ].join("\n");
}

function loadPolicy(path = POLICY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (require.main === module) {
  const policy = loadPolicy(),
    modules = analyzeArchitecture(),
    errors = validateArchitecture(modules, policy);
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify({ modules, errors }, null, 2)}\n`);
  else
    process.stdout.write(
      `${markdownReport(modules, policy)}\n\n${modules.length} modules; ${dependencyCycles(modules).length} cycles; ${errors.length} policy violations.\n`,
    );
  if (errors.length) {
    for (const error of errors) process.stderr.write(`Architecture: ${error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  analyzeArchitecture,
  dependencyCycles,
  loadPolicy,
  localDependencies,
  markdownReport,
  moduleReferences,
  sourceFiles,
  validateArchitecture,
};
