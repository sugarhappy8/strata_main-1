"use strict";

// A throwaway certificate chain shaped like the App Store's (root -> intermediate -> leaf, EC P-256, with Apple's marker
// extensions), made with openssl at test time so no private key is committed. signJws() signs payloads with the leaf key
// the way the App Store does (ES256, x5c = [leaf, intermediate, root]).
const { execFileSync } = require("node:child_process");
const { createPrivateKey, sign, X509Certificate } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

function createAppleTestChain({ leafMarker = true, intermediateMarker = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "strata-apple-chain-"));
  const file = (name) => join(dir, name);
  const run = (...args) =>
    execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    writeFileSync(
      file("ext.cnf"),
      [
        "[root]",
        "basicConstraints=critical,CA:true",
        "keyUsage=critical,keyCertSign,cRLSign",
        "",
        "[intermediate]",
        "basicConstraints=critical,CA:true,pathlen:0",
        "keyUsage=critical,keyCertSign,cRLSign",
        ...(intermediateMarker ? [`${INTERMEDIATE_OID}=ASN1:NULL`] : []),
        "",
        "[leaf]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature",
        ...(leafMarker ? [`${LEAF_OID}=ASN1:NULL`] : []),
        "",
      ].join("\n"),
    );
    for (const name of ["root", "intermediate", "leaf"])
      run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
    run(
      "req",
      "-x509",
      "-new",
      "-key",
      "root.key",
      "-subj",
      "/CN=Test Root CA - G3/O=STRATA tests",
      "-days",
      "36500",
      "-sha256",
      "-extensions",
      "root",
      "-config",
      file("ext.cnf"),
      "-out",
      "root.pem",
    );
    run(
      "req",
      "-new",
      "-key",
      "intermediate.key",
      "-subj",
      "/CN=Test WWDR CA/O=STRATA tests",
      "-out",
      "intermediate.csr",
      "-config",
      file("ext.cnf"),
    );
    run(
      "x509",
      "-req",
      "-in",
      "intermediate.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-CAcreateserial",
      "-days",
      "36000",
      "-sha256",
      "-extfile",
      file("ext.cnf"),
      "-extensions",
      "intermediate",
      "-out",
      "intermediate.pem",
    );
    run(
      "req",
      "-new",
      "-key",
      "leaf.key",
      "-subj",
      "/CN=Test App Store signing/O=STRATA tests",
      "-out",
      "leaf.csr",
      "-config",
      file("ext.cnf"),
    );
    run(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "intermediate.pem",
      "-CAkey",
      "intermediate.key",
      "-CAcreateserial",
      "-days",
      "35000",
      "-sha256",
      "-extfile",
      file("ext.cnf"),
      "-extensions",
      "leaf",
      "-out",
      "leaf.pem",
    );
    const der = (name) => new X509Certificate(readFileSync(file(name))).raw.toString("base64");
    const x5c = [der("leaf.pem"), der("intermediate.pem"), der("root.pem")];
    const leafKey = createPrivateKey(readFileSync(file("leaf.key")));
    const rootFingerprint = new X509Certificate(readFileSync(file("root.pem"))).fingerprint256;
    function signJws(payload, { header = {}, key = leafKey } = {}) {
      const head = Buffer.from(JSON.stringify({ alg: "ES256", x5c, ...header })).toString(
        "base64url",
      );
      const body = Buffer.from(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      ).toString("base64url");
      const signature = sign("sha256", Buffer.from(`${head}.${body}`), {
        key,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${head}.${body}.${signature}`;
    }
    return { x5c, rootFingerprint, signJws };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { createAppleTestChain };
