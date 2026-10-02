"use strict";
// Forward preview host/port flags to the existing Node application. Normal
// development keeps the application's loopback default and environment config.
const { spawn } = require("node:child_process");
const environment = { ...process.env };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--host") environment.HOST = process.argv[++index] || "127.0.0.1";
  else if (flag === "--port") environment.PORT = process.argv[++index] || "4173";
  else if (flag !== "--strictPort") throw new Error(`Unknown development option: ${flag}`);
}
const child = spawn(process.execPath, ["--env-file-if-exists=.env", "--watch", "server.js"], {
  stdio: "inherit",
  env: environment,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
