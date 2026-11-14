"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { SecureFilesystem } = require(
  path.resolve(__dirname, "../dist/uploads/secure-filesystem.js"),
);

const root = process.env.HOMECLOUD_LOCK_TEST_ROOT;

if (!root || !path.isAbsolute(root)) {
  throw new Error("Invalid test root");
}

if (typeof process.send !== "function") {
  throw new Error("IPC required");
}

const boundary = new SecureFilesystem(root, fs.lstatSync(root));
const lockFd = boundary.directory(root);

boundary.lock(lockFd);

// FD 3 в дочернем процессе ссылается на ту же открытую
// файловую сущность, что и lockFd у supervisor.
const child = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", lockFd],
  },
);

child.on("error", (error) => {
  process.stderr.write(String(error));
  process.exit(1);
});

if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
  throw new Error("Failed to start inherited lock holder");
}

child.unref();

process.send({
  status: "CHILD_HOLDS_LOCK",
  childPid: child.pid,
});

// Supervisor остаётся живым, пока тест не отправит SIGKILL.
setInterval(() => {}, 1000);
