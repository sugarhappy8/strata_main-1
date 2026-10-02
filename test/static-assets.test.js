"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");
const { loadPublicAssets, cachedResponseBody } = require("../src/static-assets");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "strata-assets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = "Public exercise content. ".repeat(200);
  writeFileSync(join(root, "exercises.json"), body);
  writeFileSync(join(root, "account.html"), "PRIVATE ACCOUNT TEMPLATE");
  writeFileSync(join(root, "secret.txt"), "UNLISTED");
  const options = {
    root,
    files: new Map([
      ["exercises.json", "exercises.json"],
      ["account.html", "account.html"],
      ["missing.css", "missing.css"],
    ]),
    privateFiles: new Set(["account.html"]),
    mime: { ".json": "application/json" },
  };
  return { root, body, options };
}

test("preloads only public allowlisted assets and reuses gzip representations", (t) => {
  const { root, body, options } = fixture(t),
    assets = loadPublicAssets(options);
  assert.deepEqual([...assets.keys()], ["exercises.json"]);
  const asset = assets.get("exercises.json");
  assert.equal(asset.body.toString(), body);
  writeFileSync(join(root, "exercises.json"), "later deployment");
  const headers = { "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" };
  const gzip = cachedResponseBody({ headers: { "accept-encoding": "gzip" } }, asset, headers);
  assert.equal(gunzipSync(gzip).toString(), body);
  assert.equal(headers["Content-Encoding"], "gzip");
  assert.equal(headers["Content-Length"], gzip.length);
  assert.equal(headers.Vary, "Accept-Encoding");
  assert.equal(headers["Cache-Control"], "public, max-age=300");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(
    cachedResponseBody({ headers: { "accept-encoding": "br, *;q=1" } }, asset, {}),
    gzip,
  );
  const identityHeaders = {};
  const identity = cachedResponseBody(
    { headers: { "accept-encoding": "gzip;q=0, *;q=1" } },
    asset,
    identityHeaders,
  );
  assert.equal(identity, asset.body);
  assert.equal(identityHeaders["Content-Encoding"], undefined);
  assert.equal(identityHeaders["Content-Length"], Buffer.byteLength(body));
  assert.equal(identityHeaders.Vary, "Accept-Encoding");
});

test("cache budget includes retained original and compressed buffers", (t) => {
  const { body, options } = fixture(t);
  assert.equal(loadPublicAssets({ ...options, maxBytes: 1 }).size, 0);
  assert.equal(loadPublicAssets({ ...options, maxBytes: Buffer.byteLength(body) }).size, 0);
});
