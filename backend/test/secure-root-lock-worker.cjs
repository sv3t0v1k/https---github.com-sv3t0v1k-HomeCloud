"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { SecureFilesystem } = require(
  path.resolve(__dirname, "../dist/uploads/secure-filesystem.js"),
);

const root = process.env.HOMECLOUD_LOCK_TEST_ROOT;

if (!root || !path.isAbsolute(root)) {
  throw new Error("Missing absolute test root");
}

const boundary = new SecureFilesystem(root, fs.lstatSync(root));
const fd = boundary.directory(root);

boundary.lock(fd);

if (typeof process.send !== "function") {
  throw new Error("IPC required");
}

process.send({ status: "LOCKED" });

setInterval(() => {}, 1000);
