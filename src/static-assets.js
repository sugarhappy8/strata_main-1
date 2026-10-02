"use strict";

const { readFileSync, statSync } = require("node:fs");
const { extname, join } = require("node:path");
const { gzipAccepted, responseBody } = require("./http");

const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024;

// Deployment assets are immutable for a process lifetime. Only the explicit
// public allowlist is eligible; personalized/private HTML never enters the cache.
function loadPublicAssets({ root, files, privateFiles, mime, maxBytes = DEFAULT_CACHE_BYTES }) {
  const assets = new Map();
  let retainedBytes = 0;
  for (const [requested, file] of files) {
    if (privateFiles.has(requested)) continue;
    const path = join(root, file);
    let size;
    try {
      size = statSync(path).size;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (size > maxBytes - retainedBytes) continue;
    const original = readFileSync(path);
    const identityHeaders = { "Content-Type": mime[extname(path)] || "application/octet-stream" };
    const gzipHeaders = { ...identityHeaders };
    const identity = responseBody({ headers: {} }, original, identityHeaders);
    const gzip = responseBody({ headers: { "accept-encoding": "gzip" } }, original, gzipHeaders);
    const cost = identity.length + (gzip === identity ? 0 : gzip.length);
    if (cost > maxBytes - retainedBytes) continue;
    assets.set(requested, {
      body: original,
      identity: { body: identity, headers: Object.freeze(identityHeaders) },
      gzip: { body: gzip, headers: Object.freeze(gzipHeaders) },
    });
    retainedBytes += cost;
  }
  return assets;
}

function cachedResponseBody(req, asset, headers) {
  const selected = gzipAccepted(req.headers["accept-encoding"]) ? asset.gzip : asset.identity;
  // Cache only representation metadata. Cache-Control, security headers and any
  // route-specific headers remain selected afresh by the HTTP composition root.
  Object.assign(headers, selected.headers);
  return selected.body;
}

module.exports = { loadPublicAssets, cachedResponseBody };
