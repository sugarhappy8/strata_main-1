"use strict";

const DEFAULT_TIMEOUT_MS = 10_000;

function clean(value) {
  return String(value ?? "").trim();
}
function localHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function deploymentUrl(value) {
  const url = new URL(clean(value));
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Smoke target must be a root HTTP(S) URL without credentials, query data, or a fragment.",
    );
  if (url.protocol !== "https:" && !localHost(url.hostname))
    throw new Error("Remote smoke targets must use HTTPS.");
  url.pathname = "/";
  return url;
}

function hasDirective(value, directive) {
  return clean(value)
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .includes(directive);
}

function requireSecurityHeaders(response, label) {
  const contentType = clean(response.headers.get("content-type")).toLowerCase();
  if (
    (contentType.includes("text/html") || contentType.includes("application/json")) &&
    clean(response.headers.get("x-content-type-options")).toLowerCase() !== "nosniff"
  )
    throw new Error(`${label} is missing X-Content-Type-Options: nosniff.`);
  if (contentType.includes("text/html") && !clean(response.headers.get("content-security-policy")))
    throw new Error(`${label} is missing Content-Security-Policy.`);
}

async function request(
  baseUrl,
  path,
  { redirect = "manual", timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(new URL(path, baseUrl), {
    redirect,
    signal,
    headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.8" },
  });
  requireSecurityHeaders(response, path);
  return response;
}

async function jsonResponse(baseUrl, path, options) {
  const response = await request(baseUrl, path, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} did not return JSON.`);
  }
  if (!response.ok)
    throw new Error(
      `${path} returned ${response.status}: ${clean(body?.error) || "request failed"}`,
    );
  return { response, body };
}

// The public status says only that the app is up and which build it runs. Storage, email, and payment setup are checked
// before the deploy by `npm run preflight:production` and afterwards on the admin Overview, never in public.
function validateStatus(body, { expectedBuild = "" } = {}) {
  if (!body || body.ok !== true)
    throw new Error("/api/status did not report an operational application.");
  if (expectedBuild && clean(body.version) !== expectedBuild)
    throw new Error(
      `/api/status reported version ${clean(body.version) || "unknown"}; expected ${expectedBuild}.`,
    );
  const extra = Object.keys(body).filter((key) => key !== "ok" && key !== "version");
  if (extra.length)
    throw new Error(`/api/status reveals setup it should not: ${extra.join(", ")}.`);
}

async function runSmoke(baseValue, { expectedBuild = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const baseUrl = deploymentUrl(baseValue),
    checks = [];
  const timed = async (name, operation) => {
    const started = performance.now();
    await operation();
    checks.push({
      name,
      passed: true,
      durationMs: Number((performance.now() - started).toFixed(1)),
    });
  };

  await timed("status", async () => {
    const { body } = await jsonResponse(baseUrl, "/api/status", { timeoutMs });
    validateStatus(body, { expectedBuild });
  });
  await timed("readiness", async () => {
    const { body } = await jsonResponse(baseUrl, "/healthz", { timeoutMs });
    if (body?.ok !== true) throw new Error("/healthz did not confirm live storage access.");
  });
  await timed("public-home", async () => {
    const response = await request(baseUrl, "/", { timeoutMs });
    if (
      !response.ok ||
      !clean(response.headers.get("content-type")).toLowerCase().includes("text/html")
    )
      throw new Error("The homepage did not return HTML successfully.");
  });
  await timed("manifest", async () => {
    const response = await request(baseUrl, "/manifest.webmanifest", { timeoutMs });
    if (
      !response.ok ||
      !clean(response.headers.get("content-type"))
        .toLowerCase()
        .includes("application/manifest+json")
    )
      throw new Error("The web app manifest was unavailable or had the wrong content type.");
  });
  await timed("private-route", async () => {
    const response = await request(baseUrl, "/discover.html", { timeoutMs });
    if (
      ![302, 303, 307, 308].includes(response.status) ||
      !clean(response.headers.get("location")).startsWith("/account.html")
    )
      throw new Error("A signed-out private route did not redirect to account access.");
    if (!hasDirective(response.headers.get("cache-control"), "no-store"))
      throw new Error("The private-route redirect was not marked no-store.");
  });
  return { ok: true, target: baseUrl.origin, expectedBuild: expectedBuild || null, checks };
}

function parseOptions(argumentsList, environment = process.env) {
  const positional = argumentsList.find((value) => !value.startsWith("--"));
  const target = positional || clean(environment.STRATA_SMOKE_BASE_URL);
  const expectedBuild = clean(environment.STRATA_EXPECTED_BUILD);
  const timeout = Number(environment.STRATA_SMOKE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!target) throw new Error("Provide a deployment URL or set STRATA_SMOKE_BASE_URL.");
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000)
    throw new Error("STRATA_SMOKE_TIMEOUT_MS must be a whole number from 1000 to 60000.");
  return {
    target,
    expectedBuild,
    timeoutMs: timeout,
    json: argumentsList.includes("--json"),
  };
}

async function main(
  argumentsList = process.argv.slice(2),
  environment = process.env,
  logger = console,
) {
  const options = parseOptions(argumentsList, environment);
  const result = await runSmoke(options.target, options);
  if (options.json) logger.log(JSON.stringify(result, null, 2));
  else {
    for (const check of result.checks) logger.log(`PASS ${check.name} — ${check.durationMs} ms`);
    logger.log(
      `Deployment smoke passed for ${result.target}${result.expectedBuild ? ` at build ${result.expectedBuild}` : ""}.`,
    );
  }
  return result;
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = {
  DEFAULT_TIMEOUT_MS,
  deploymentUrl,
  parseOptions,
  requireSecurityHeaders,
  runSmoke,
  validateStatus,
};
