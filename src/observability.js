"use strict";

const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,95}$/;
const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passcode|secret|token|email|body|payload|credential|session|csrf|api[_-]?key|verification[_-]?code|(?:user|account|customer|subscription|transaction)(?:_?id)?$)/i;
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

function boundedText(value, maximum = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function redactedText(value, maximum = 500) {
  return boundedText(value, maximum)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[redacted]")
    .replace(
      /\b((?:api[_ -]?key|password|passcode|secret|token|csrf(?:[_ -]?token)?|verification[_ -]?(?:code|token))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(?:pdl_(?:live_apikey|sdbx_apikey|ntfset)_|re_)[A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .replace(/([?#&](?:token|code)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\b[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+\b/g, "[redacted-email]");
}

function safeFields(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactedText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error)
    return {
      name: boundedText(value.name, 80),
      code: boundedText(value.code, 80) || undefined,
      message: redactedText(value.message),
    };
  if (depth >= 3 || typeof value !== "object") return "[omitted]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => safeFields(item, depth + 1, seen));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40))
    output[boundedText(key, 80)] = SENSITIVE_KEY.test(key)
      ? "[redacted]"
      : safeFields(item, depth + 1, seen);
  return output;
}

function incomingRequestId(header) {
  const value = Array.isArray(header) ? header[0] : header;
  const clean = boundedText(value, 96);
  return REQUEST_ID_PATTERN.test(clean) ? clean : "";
}

function createLogger({
  sink = console,
  clock = () => new Date(),
  service = "strata",
  environment = process.env.NODE_ENV || "development",
  enabled = environment !== "test",
} = {}) {
  function log(level, event, fields = {}) {
    if (!enabled) return;
    const normalized = LOG_LEVELS.has(level) ? level : "info";
    const entry = {
      timestamp: clock().toISOString(),
      level: normalized,
      service,
      environment,
      event: redactedText(event, 120),
      ...safeFields(fields),
    };
    const writer =
      normalized === "error" ? sink.error : normalized === "warn" ? sink.warn : sink.log;
    writer.call(sink, JSON.stringify(entry));
  }
  return {
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

function observeRequest(
  request,
  response,
  logger,
  { now = () => performance.now(), makeId = randomUUID } = {},
) {
  const requestId = incomingRequestId(request.headers?.["x-request-id"]) || makeId();
  const started = now();
  response.setHeader("X-Request-ID", requestId);
  request.strataRequestId = requestId;
  let recorded = false;
  const record = (state) => {
    if (recorded) return;
    recorded = true;
    const path = (() => {
      try {
        return new URL(request.url || "/", "http://strata.invalid").pathname;
      } catch {
        return "/invalid-request-target";
      }
    })();
    logger.info("http.request", {
      requestId,
      method: boundedText(request.method || "UNKNOWN", 16),
      path,
      status: Number(response.statusCode) || 0,
      durationMs: Number(Math.max(0, now() - started).toFixed(1)),
      state,
    });
  };
  response.once("finish", () => record("finished"));
  response.once("close", () => record(response.writableEnded ? "finished" : "closed"));
  return requestId;
}

module.exports = {
  REQUEST_ID_PATTERN,
  boundedText,
  createLogger,
  incomingRequestId,
  observeRequest,
  safeFields,
};
