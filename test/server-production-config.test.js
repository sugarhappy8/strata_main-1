"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const PROJECT_ROOT = join(__dirname, "..");

async function rejectedStartup(flag) {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
    TURSO_DATABASE_URL: "",
    TURSO_AUTH_TOKEN: "",
    PADDLE_CHECKOUT_ENABLED: "false",
  };
  if (flag === undefined) delete env.EMAIL_VERIFICATION_ENABLED;
  else env.EMAIL_VERIFICATION_ENABLED = flag;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Production configuration check timed out."));
    }, 4000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  return { ...exit, stderr };
}

test("production requires an explicit valid email-verification switch", async () => {
  for (const flag of [undefined, "treu"]) {
    const result = await rejectedStartup(flag);
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /EMAIL_VERIFICATION_ENABLED must be set explicitly to true or false/i,
    );
    assert.doesNotMatch(
      result.stderr,
      /TURSO_DATABASE_URL\s*is\s*required/i,
      "flag validation must happen before storage startup",
    );
  }
});
