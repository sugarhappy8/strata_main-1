#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { dirname, join, relative, resolve, sep } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");
const POLICY_PATH = join(PROJECT_ROOT, "frontend-architecture-policy.json");
const REQUIRED_ROLES = new Set(["logic", "state", "api", "render", "events", "entry"]);
const slash = (value) => value.split(sep).join("/");
const cleanAsset = (value) =>
  String(value || "")
    .split("?")[0]
    .replace(/^\//, "");

function loadPolicy(path = POLICY_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function fileStats(file, root = PROJECT_ROOT) {
  const source = readFileSync(join(root, file), "utf8"),
    lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  return {
    file,
    source,
    lines: lines.length,
    sourceLines: lines.filter((line) => line.trim()).length,
    bytes: Buffer.byteLength(source),
  };
}
// A page may load one <script type="module"> entry whose side-effect imports name its scripts in order.
// Given a way to read an asset, the entry stands for its imports followed by itself, which is the order the
// browser runs them in.
function moduleImports(source) {
  return [...source.matchAll(/^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm)].map((match) =>
    cleanAsset(match[1]).replace(/^\.\//, ""),
  );
}
function moduleScripts(asset, readAsset, seen = new Set()) {
  if (seen.has(asset)) return [];
  seen.add(asset);
  return [
    ...moduleImports(readAsset(asset)).flatMap((name) => moduleScripts(name, readAsset, seen)),
    asset,
  ];
}
function moduleEntries(source) {
  return [...source.matchAll(/<script\b([^>]*)>/gi)]
    .filter((match) => /\btype=["']module["']/i.test(match[1]))
    .map((match) => cleanAsset(/\bsrc=["']([^"']+)["']/i.exec(match[1])?.[1]))
    .filter(Boolean);
}
// An entry holds nothing but comments and its ordered imports, so all page logic stays in reviewed modules.
function strayEntryLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !/^import\s+["'][^"']+["'];?$/.test(line));
}
function htmlScripts(source, readAsset = null) {
  return [...source.matchAll(/<script\b([^>]*)>/gi)].flatMap((match) => {
    const src = /\bsrc=["']([^"']+)["']/i.exec(match[1])?.[1];
    if (!src) return [];
    const asset = cleanAsset(src);
    return readAsset && /\btype=["']module["']/i.test(match[1])
      ? moduleScripts(asset, readAsset)
      : [asset];
  });
}
function localRequires(source, file, root = PROJECT_ROOT) {
  return [...source.matchAll(/\brequire\(["'](\.[^"']+)["']\)/g)].map((match) => {
    const target = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
    return slash(relative(root, resolve(dirname(join(root, file)), target)));
  });
}
function globalReferences(source) {
  return [
    ...new Set([...source.matchAll(/\bStrata[A-Z][A-Za-z0-9_]*\b/g)].map((match) => match[0])),
  ];
}

function analyzeFrontend(root = PROJECT_ROOT, policy = loadPolicy()) {
  const definitions = [];
  for (const [page, pagePolicy] of Object.entries(policy.pages || {}))
    for (const module of pagePolicy.modules || []) definitions.push({ ...module, page });
  const uniqueFiles = [...new Set(definitions.map((module) => module.file))],
    stats = new Map(uniqueFiles.map((file) => [file, fileStats(file, root)]));
  const producers = new Map();
  for (const module of definitions) if (module.global) producers.set(module.global, module.file);
  const modules = uniqueFiles.map((file) => {
    const entry = stats.get(file),
      ownGlobals = new Set(
        definitions
          .filter((module) => module.file === file)
          .map((module) => module.global)
          .filter(Boolean),
      );
    const globalDependencies = globalReferences(entry.source)
      .filter((name) => producers.has(name) && !ownGlobals.has(name))
      .map((name) => producers.get(name));
    return {
      file,
      lines: entry.lines,
      sourceLines: entry.sourceLines,
      bytes: entry.bytes,
      publishedGlobals: [...ownGlobals].filter((name) => entry.source.includes(name)),
      dependencies: [
        ...new Set([...localRequires(entry.source, file, root), ...globalDependencies]),
      ].sort(),
    };
  });
  return {
    definitions,
    modules,
    pages: Object.entries(policy.pages || {}).map(([name, pagePolicy]) => {
      const html = readFileSync(join(root, pagePolicy.html), "utf8"),
        readAsset = (asset) =>
          readFileSync(join(root, "public/scripts", asset.split("/").at(-1)), "utf8");
      return {
        name,
        ...pagePolicy,
        scripts: htmlScripts(html, readAsset),
        moduleEntries: moduleEntries(html).map((asset) => ({ asset, source: readAsset(asset) })),
      };
    }),
  };
}

function dependencyCycles(modules) {
  const graph = new Map(
    modules.map((module) => [
      module.file,
      module.dependencies.filter((dependency) =>
        modules.some((candidate) => candidate.file === dependency),
      ),
    ]),
  );
  const visited = new Set(),
    active = new Set(),
    stack = [],
    cycles = [];
  function visit(file) {
    if (active.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    stack.pop();
    active.delete(file);
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function validateFrontend(analysis, policy) {
  const errors = [],
    byFile = new Map(analysis.modules.map((module) => [module.file, module]));
  for (const page of analysis.pages) {
    if ((page.moduleEntries || []).length > 1)
      errors.push(`${page.html} must load at most one module entry.`);
    for (const entry of page.moduleEntries || [])
      if (strayEntryLines(entry.source).length)
        errors.push(`${entry.asset} must only import ${page.name}'s scripts in order.`);
    const roles = new Set(page.modules.map((module) => module.role));
    for (const role of REQUIRED_ROLES)
      if (!roles.has(role)) errors.push(`${page.name} has no ${role} boundary.`);
    if (page.modules.filter((module) => module.role === "entry").length !== 1)
      errors.push(`${page.name} must have exactly one entry coordinator.`);
    let previous = -1;
    for (const module of page.modules) {
      const stats = byFile.get(module.file);
      if (stats && stats.lines > module.maxLines)
        errors.push(
          `${module.file} has ${stats.lines} lines; ${page.name}'s reviewed ${module.role} budget is ${module.maxLines}.`,
        );
      const asset = module.file.split("/").at(-1),
        position = page.scripts.indexOf(asset);
      if (position < 0) errors.push(`${page.html} does not load ${asset}.`);
      else if (position <= previous)
        errors.push(`${page.html} loads ${asset} outside the reviewed dependency order.`);
      else previous = position;
      if (module.global && !stats?.publishedGlobals.includes(module.global))
        errors.push(`${module.file} does not publish ${module.global}.`);
    }
    const positions = new Map(page.modules.map((module, index) => [module.file, index]));
    for (const module of page.modules) {
      for (const dependency of byFile.get(module.file)?.dependencies || []) {
        if (positions.has(dependency) && positions.get(dependency) >= positions.get(module.file))
          errors.push(
            `${page.name} dependency direction is invalid: ${module.file} -> ${dependency}.`,
          );
      }
    }
  }
  for (const cycle of dependencyCycles(analysis.modules))
    errors.push(`Frontend dependency cycle: ${cycle.join(" -> ")}.`);
  if (Object.keys(policy.pages || {}).length === 0)
    errors.push("Frontend architecture policy has no pages.");
  return errors;
}

function formatBytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}
function markdownReport(analysis) {
  const rolesByFile = new Map();
  for (const definition of analysis.definitions) {
    const label = `${definition.page}: ${definition.role}`;
    rolesByFile.set(definition.file, [...(rolesByFile.get(definition.file) || []), label]);
  }
  const rows = analysis.modules.map(
    (module) =>
      `| \`${module.file}\` | ${rolesByFile.get(module.file).join("; ")} | ${module.lines} | ${module.sourceLines} | ${formatBytes(module.bytes)} | ${module.dependencies.length ? module.dependencies.map((file) => `\`${file}\``).join(", ") : "—"} |`,
  );
  const graphs = analysis.pages.map((page) => {
    const chain = page.modules
      .map((module) => `${module.role}:${module.file.split("/").at(-1)}`)
      .join(" → ");
    return `- **${page.name}:** ${chain}`;
  });
  return [
    "| Browser module | Reviewed role | Lines | Nonblank | Size | Dependencies |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "Load-order graph:",
    ...graphs,
  ].join("\n");
}

if (require.main === module) {
  const policy = loadPolicy(),
    analysis = analyzeFrontend(PROJECT_ROOT, policy),
    errors = validateFrontend(analysis, policy);
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify({ ...analysis, errors }, null, 2)}\n`);
  else
    process.stdout.write(
      `${markdownReport(analysis)}\n\n${analysis.pages.length} page boundaries; ${analysis.modules.length} browser modules; ${dependencyCycles(analysis.modules).length} cycles; ${errors.length} policy violations.\n`,
    );
  if (errors.length) {
    for (const error of errors) process.stderr.write(`Frontend architecture: ${error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  analyzeFrontend,
  dependencyCycles,
  globalReferences,
  htmlScripts,
  loadPolicy,
  localRequires,
  moduleEntries,
  moduleImports,
  markdownReport,
  validateFrontend,
};
