"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { SecureFilesystem } = require(
  "../dist/uploads/secure-filesystem.js",
);

const EXIT_SIGNALS = {
  SIGTERM: 143,
  SIGINT: 130,
  SIGKILL: 137,
};


const MAINTENANCE_ROOT = "/run/homecloud/maintenance";
const MAINTENANCE_MARKER = "maintenance.inhibit";

function lstatOrMissing(filename, bigint = false) {
  try {
    return fs.lstatSync(filename, { bigint });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function validRestoreToken(token) {
  return typeof token === "string" &&
    /^[a-f0-9]{32}$/.test(token);
}

function assertMaintenanceAllowed(restoreToken = null) {
  if (restoreToken !== null &&
      (!validRestoreToken(restoreToken) ||
       process.env.HOMECLOUD_MAINTENANCE_REQUIRED !== "1" ||
       (process.env.STORAGE_PATH || "/storage") !== "/storage")) {
    throw new Error("Invalid restore migration admission");
  }

  const requiredFlag =
    process.env.HOMECLOUD_MAINTENANCE_REQUIRED;

  if (
    requiredFlag !== undefined &&
    requiredFlag !== "1"
  ) {
    throw new Error("Invalid maintenance admission mode");
  }

  const configured =
    requiredFlag === "1" ||
    lstatOrMissing("/run/homecloud/startup.gate") !== null;

  const state = lstatOrMissing(MAINTENANCE_ROOT);

  if (state === null) {
    // Standalone development and isolated runtime fixtures.
    // The production host startup gate requires this mount.
    if (configured || restoreToken !== null) {
      throw new Error("Required maintenance mount is missing");
    }
    return;
  }

  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.uid !== 0 ||
    state.gid !== 0 ||
    (state.mode & 0o7777) !== 0o711 ||
    fs.realpathSync(MAINTENANCE_ROOT) !== MAINTENANCE_ROOT
  ) {
    throw new Error("Unsafe maintenance directory");
  }

  const records = fs
    .readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((line) => line.split(" "))
    .filter((fields) => fields[4] === MAINTENANCE_ROOT);

  if (
    records.length !== 1 ||
    !records[0][5].split(",").includes("ro")
  ) {
    throw new Error("Maintenance mount must be readonly");
  }

  // lstat, not existsSync: dangling symlinks and inspection
  // errors must never be treated as an absent inhibit.
  const marker = lstatOrMissing(
    path.join(MAINTENANCE_ROOT, MAINTENANCE_MARKER),
    true,
  );

  if (restoreToken !== null) {
    if (marker === null) {
      throw new Error("Restore migration authorization missing or invalid");
    }
    const permit = lstatOrMissing(
      path.join(MAINTENANCE_ROOT,
        `restore-migration.${restoreToken}.${marker.dev}.${marker.ino}`),
      true,
    );

    const validPrivateMarker = (entry) =>
      entry !== null &&
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.uid === 0n &&
      entry.gid === 0n &&
      (entry.mode & 0o7777n) === 0o600n &&
      entry.nlink === 1n;

    if (!validPrivateMarker(marker) ||
        !validPrivateMarker(permit)) {
      throw new Error("Restore migration authorization missing or invalid");
    }
    return;
  }

  if (marker !== null) {
    throw new Error("Maintenance startup is inhibited");
  }
}

async function runWithRootFence(root, phases) {
  return runFenced(root, phases, null);
}

async function runFenced(root, phases, restoreToken) {
  if (
    process.platform !== "linux" ||
    process.geteuid?.() === 0
  ) {
    throw new Error("Linux non-root runtime required");
  }

  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    root !== path.resolve(root) ||
    !Array.isArray(phases) ||
    phases.length === 0
  ) {
    throw new Error("Invalid fenced startup configuration");
  }

  const original = fs.lstatSync(root);
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new Error("Unsafe fenced storage root");
  }

  const boundary = new SecureFilesystem(root, original);
  let fd;
  let current = null;
  let stopping = null;

  const forward = (signal) => {
    if (stopping === null) stopping = signal;

    if (
      current &&
      current.exitCode === null &&
      current.signalCode === null
    ) {
      current.kill(signal);
    }
  };

  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");

  try {
    fd = boundary.directory(root);
    boundary.lock(fd);

    const pinned = fs.fstatSync(fd);
    const visible = fs.lstatSync(root);

    if (
      pinned.dev !== visible.dev ||
      pinned.ino !== visible.ino ||
      !visible.isDirectory() ||
      visible.isSymbolicLink()
    ) {
      throw new Error("Fenced storage root changed");
    }

    // Recheck AFTER the exclusive kernel lock was acquired.
    // The outer startup gate alone cannot close this race.
    assertMaintenanceAllowed(restoreToken);

    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);

    for (const phase of phases) {
      if (stopping !== null) {
        return EXIT_SIGNALS[stopping] || 1;
      }

      if (
        !Array.isArray(phase) ||
        typeof phase[0] !== "string" ||
        !path.isAbsolute(phase[0]) ||
        !Array.isArray(phase[1]) ||
        !phase[1].every((v) => typeof v === "string")
      ) {
        throw new Error("Invalid fenced startup phase");
      }

      // A maintenance request may arrive during migrations.
      // Never admit the next phase on a stale decision.
      assertMaintenanceAllowed(restoreToken);

      current = spawn(phase[0], phase[1], {
        shell: false,
        stdio: ["inherit", "inherit", "inherit", fd],
        env: {
          ...process.env,
          HOMECLOUD_ROOT_FENCE_FD: "3",
        },
      });

      const result = await new Promise((resolve, reject) => {
        current.once("error", reject);
        current.once("close", (code, signal) => {
          resolve({ code, signal });
        });
      });

      current = null;

      if (stopping !== null) {
        return EXIT_SIGNALS[stopping] || 1;
      }

      if (result.signal) {
        return EXIT_SIGNALS[result.signal] || 1;
      }

      if (result.code !== 0) {
        return result.code ?? 1;
      }
    }

    return 0;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);

    if (fd !== undefined) fs.closeSync(fd);
    boundary.close();
  }
}


function operatorCliPhases(args) {
  const [mode, command, cli, action, ...flags] = args;

  const allowedCli =
    cli === "./node_modules/typeorm/cli.js" ||
    cli === "node_modules/typeorm/cli.js";

  const allowedAction =
    action === "migration:run" ||
    action === "migration:show";

  const normalFlags =
    flags.length === 2 &&
    flags[0] === "-d" &&
    flags[1] === "dist/data-source.js";

  const transactionFlags =
    action === "migration:run" &&
    flags.length === 4 &&
    flags[0] === "-d" &&
    flags[1] === "dist/data-source.js" &&
    flags[2] === "--transaction" &&
    flags[3] === "all";

  if (
    mode !== "--operator-cli" ||
    command !== "node" ||
    !allowedCli ||
    !allowedAction ||
    (!normalFlags && !transactionFlags)
  ) {
    throw new Error("Unsupported operator TypeORM CLI invocation");
  }

  // Never trust an arbitrary executable or data-source path.
  // The root lock is acquired before this phase starts.
  return [[process.execPath, [cli, action, ...flags]]];
}

function restoreMigrationPhases(args) {
  if (args.length !== 2 ||
      args[0] !== "--restore-migration" ||
      !validRestoreToken(args[1])) {
    throw new Error("Invalid restore migration invocation");
  }

  return [[process.execPath, [
    "./node_modules/typeorm/cli.js",
    "migration:run",
    "-d",
    "dist/data-source.js",
    "--transaction",
    "all",
  ]]];
}

module.exports = {
  runWithRootFence,
  assertMaintenanceAllowed,
  restoreMigrationPhases,
};

if (require.main === module) {
  const root = process.env.STORAGE_PATH || "/storage";

  const args = process.argv.slice(2);
  const restoreToken =
    args[0] === "--restore-migration" ? args[1] : null;

  const phases =
    args[0] === "--restore-migration"
      ? restoreMigrationPhases(args)
      : process.argv.length > 2
        ? operatorCliPhases(args)
      : [
    [
      process.execPath,
      [
        "./node_modules/typeorm/cli.js",
        "migration:run",
        "-d",
        "dist/data-source.js",
        "--transaction",
        "all",
      ],
    ],
    [process.execPath, ["dist/main.js"]],
  ];

  runFenced(root, phases, restoreToken).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        "STOP: fenced backend startup failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      process.exitCode = 1;
    },
  );
}
