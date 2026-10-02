// @ts-check
"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

/** @param {unknown} value */
function clean(value) {
  return String(value || "").trim();
}

/** @param {number} milliseconds @returns {Pick<RequestInit,"signal">} */
function requestSignal(milliseconds) {
  const signal =
    typeof globalThis.AbortSignal?.timeout === "function"
      ? globalThis.AbortSignal.timeout(milliseconds)
      : undefined;
  return signal ? { signal } : {};
}

/** @param {unknown} header @returns {{timestamp:number,signatures:string[]}|null} */
function parseSignatureHeader(header) {
  /** @type {Record<"ts"|"h1",string[]>} */
  const values = { ts: [], h1: [] };
  for (const segment of clean(header).split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if ((key === "ts" || key === "h1") && value) values[key].push(value);
  }
  const timestampText = values.ts[0] || "";
  if (values.ts.length !== 1 || !/^[0-9]+$/.test(timestampText) || !values.h1.length) return null;
  const timestamp = Number(timestampText);
  return Number.isSafeInteger(timestamp) ? { timestamp, signatures: values.h1 } : null;
}

/**
 * Verify Paddle's signature against the exact request bytes and a bounded
 * timestamp. Multiple h1 values support Paddle secret rotation.
 * @param {string|Buffer} rawBody
 * @param {unknown} header
 * @param {string} secret
 * @param {{now?:number,toleranceSeconds?:number}} options
 */
function verifyPaddleSignature(
  rawBody,
  header,
  secret,
  { now = Math.floor(Date.now() / 1000), toleranceSeconds = 5 } = {},
) {
  if (!secret) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const nowSeconds = now > 10_000_000_000 ? Math.floor(now / 1000) : Math.floor(now);
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${parsed.timestamp}:`), body]))
    .digest();
  return parsed.signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const actual = Buffer.from(candidate, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

/** @param {unknown} value @returns {number|null} */
function ipv4Number(value) {
  const parts = String(value || "")
    .replace(/^::ffff:/i, "")
    .split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part) || Number(part) > 255))
    return null;
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

/** @param {unknown} value @returns {{network:number,bits:number}|null} */
function parseIpv4Cidr(value) {
  const parts = String(value || "").split("/");
  if (parts.length !== 2) return null;
  const network = ipv4Number(parts[0]);
  const bits = Number(parts[1]);
  return network !== null &&
    /^[0-9]{1,2}$/.test(parts[1] || "") &&
    Number.isInteger(bits) &&
    bits >= 0 &&
    bits <= 32
    ? { network, bits }
    : null;
}

/**
 * Fetch Paddle's current webhook source ranges with the private API boundary
 * supplied explicitly. The caller retains ownership of secret storage.
 * @param {import("./domain-types").PaddleSecrets|undefined} secrets
 * @param {import("./domain-types").FetchLike} fetchImpl
 * @returns {Promise<string[]>}
 */
async function fetchPaddleIpv4Cidrs(secrets, fetchImpl = globalThis.fetch) {
  if (!secrets?.apiKey) throw new Error("Paddle IP verification is not configured.");
  let response;
  try {
    response = await fetchImpl(`${secrets.apiBase}/ips`, {
      headers: { Authorization: `Bearer ${secrets.apiKey}`, "Paddle-Version": "1" },
      ...requestSignal(3_000),
    });
  } catch {
    throw new Error("Paddle IP verification is temporarily unavailable.");
  }
  if (!response?.ok) throw new Error("Paddle IP verification is temporarily unavailable.");
  /** @type {{data?:{ipv4_cidrs?:unknown}}|null} */
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const cidrs = payload?.data?.ipv4_cidrs;
  if (
    !Array.isArray(cidrs) ||
    !cidrs.length ||
    !cidrs.every((value) => parseIpv4Cidr(value) !== null)
  ) {
    throw new Error("Paddle returned an invalid IP allowlist.");
  }
  return [...new Set(cidrs)];
}

/** @param {unknown} address @param {readonly string[]} cidrs */
function isPaddleWebhookAddress(address, cidrs) {
  const candidate = ipv4Number(address);
  if (candidate === null || !Array.isArray(cidrs)) return false;
  return cidrs.some((cidr) => {
    const parsed = parseIpv4Cidr(cidr);
    if (!parsed) return false;
    const mask = parsed.bits === 0 ? 0 : (0xffffffff << (32 - parsed.bits)) >>> 0;
    return (candidate & mask) === (parsed.network & mask);
  });
}

module.exports = { verifyPaddleSignature, fetchPaddleIpv4Cidrs, isPaddleWebhookAddress };
