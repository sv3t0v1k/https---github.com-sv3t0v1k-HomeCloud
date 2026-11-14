"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(
  path.join(root, "backend/docker/copy-root-fence-supervisor.cjs"),
  "utf8"
);
const gate = fs.readFileSync(
  path.join(root, "deploy/linux/startup-gate.sh"),
  "utf8"
);
const base = "/run/homecloud/maintenance";
const token = "a".repeat(32);

const gateCode = gate.match(
  /node -e '([\s\S]*?)'\s+"\$maintenance\/maintenance\.inhibit"/
)[1];

function fixture() {
  const files = new Map();
  const marker = {
    uid: 0, gid: 0, mode: 0o100600, nlink: 1, dev: 8, ino: 9007199254740993n,
    isFile: () => true,
    isSymbolicLink: () => false,
    isDirectory: () => false,
  };
  files.set(base, {
    ...marker,
    mode: 0o40711,
    isFile: () => false,
    isDirectory: () => true,
  });
  files.set(base + "/maintenance.inhibit", marker);
  files.set(base + "/restore-migration." + token + ".8.9007199254740993", marker);

  const env = {
    HOMECLOUD_MAINTENANCE_REQUIRED: "1",
    STORAGE_PATH: "/storage",
  };

  const fakeFs = {
    lstatSync(name, options) {
      if (!files.has(name)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      const entry = files.get(name);
      return options?.bigint ? Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, typeof v === "number" ? BigInt(v) : v])) : entry;
    },
    realpathSync(name) { return name; },
    readFileSync() {
      return "1 2 8:1 / " + base + " ro - ext4 /dev/sda rw\n";
    },
  };
  const module = { exports: {} };
  const load = (name) => {
    if (name === "node:fs") return fakeFs;
    if (name === "node:path") return path;
    if (name === "node:child_process") return {};
    return { SecureFilesystem: class {} };
  };

  vm.runInNewContext(source, {
    require: load, module,
    process: { env, execPath: "/usr/bin/node" },
  });

  function runGate(mode, candidate = token) {
    const { spawnSync } = require("node:child_process");

    const inventory = [...files].map(([name, entry]) => [
      name, {
        uid: entry.uid,
        gid: entry.gid,
        mode: entry.mode,
        nlink: entry.nlink,
        dev: entry.dev?.toString(), ino: entry.ino?.toString(),
        file: entry.isFile(),
        symlink: entry.isSymbolicLink(),
        directory: entry.isDirectory(),
      },
    ]);

    const result = spawnSync(process.execPath, [
      "-e",
      `
      const vm = require("node:vm");
      const path = require("node:path");
      const data = JSON.parse(process.argv[1]);
      const files = new Map(data.inventory);

      const fakeFs = {
        lstatSync(name, options) {
          if (!files.has(name)) {
            throw Object.assign(new Error("missing"), {
              code: "ENOENT",
            });
          }
          let entry = files.get(name);
          if (options?.bigint) entry = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, ["uid", "gid", "mode", "nlink", "dev", "ino"].includes(k) && v !== undefined ? BigInt(v) : v]));
          return {
            ...entry,
            isFile: () => entry.file,
            isSymbolicLink: () => entry.symlink,
            isDirectory: () => entry.directory,
          };
        },
      };

      process.argv = [
        "node", data.filename, data.mode, data.candidate,
      ];

      vm.runInNewContext(data.code, {
        require(name) {
          if (name === "node:fs") return fakeFs;
          if (name === "node:path") return path;
          throw new Error("Unexpected module: " + name);
        },
        process,
      });
      `,
      JSON.stringify({
        code: gateCode,
        filename: base + "/maintenance.inhibit",
        mode,
        candidate,
        inventory,
      }),
    ], {
      encoding: "utf8",
      timeout: 5000,
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.ok([0, 1].includes(result.status));

    return result.status === 0;
  }

  return {
    files, marker, env, runGate,
    ...module.exports,
  };
}

test("ordinary backend remains inhibited", () => {
  const f = fixture();
  assert.throws(() => f.assertMaintenanceAllowed(), /inhibited/);
  assert.equal(f.runGate("normal"), false);
});

test("exact restore permit admitted", () => {
  const f = fixture();
  assert.doesNotThrow(() => f.assertMaintenanceAllowed(token));
  assert.equal(f.runGate("restore-migration"), true);
});

test("wrong token rejected", () => {
  const f = fixture();
  assert.throws(() => f.assertMaintenanceAllowed("b".repeat(32)));
  assert.equal(f.runGate("restore-migration", "b".repeat(32)), false);
  assert.equal(f.runGate("restore-migration", "../bad"), false);
});

test("missing permit rejected", () => {
  const f = fixture();
  f.files.delete(base + "/restore-migration." + token + ".8.9007199254740993");
  assert.throws(() => f.assertMaintenanceAllowed(token));
  assert.equal(f.runGate("restore-migration"), false);
});

test("missing inhibitor rejected", () => {
  const f = fixture();
  f.files.delete(base + "/maintenance.inhibit");
  assert.throws(() => f.assertMaintenanceAllowed(token));
  assert.equal(f.runGate("restore-migration"), false);
});

test("unsafe permit rejected", () => {
  for (const change of [
    { uid: 1001 },
    { gid: 1001 },
    { mode: 0o100644 },
    { nlink: 2 },
    { isSymbolicLink: () => true },
  ]) {
    const f = fixture();
    f.files.set(base + "/restore-migration." + token + ".8.9007199254740993", {
      ...f.marker, ...change,
    });
    assert.throws(() => f.assertMaintenanceAllowed(token));
    assert.equal(f.runGate("restore-migration"), false);
  }
});

test("restore requires production mode and fixed root", () => {
  const f = fixture();
  delete f.env.HOMECLOUD_MAINTENANCE_REQUIRED;
  assert.throws(() => f.assertMaintenanceAllowed(token));
  f.env.HOMECLOUD_MAINTENANCE_REQUIRED = "1";
  f.env.STORAGE_PATH = "/other";
  assert.throws(() => f.assertMaintenanceAllowed(token));
});

test("only exact transactional TypeORM migration is selected", () => {
  const f = fixture();
  const phases = f.restoreMigrationPhases(["--restore-migration", token]);
  assert.equal(JSON.stringify(phases), JSON.stringify([
    ["/usr/bin/node", [
      "./node_modules/typeorm/cli.js", "migration:run",
      "-d", "dist/data-source.js", "--transaction", "all",
    ]],
  ]));
  for (const args of [
    ["--restore-migration"],
    ["--restore-migration", token, "extra"],
    ["--restore-migration", "../bad"],
    ["--operator-cli", token],
  ]) {
    assert.throws(() => f.restoreMigrationPhases(args));
  }
});

// The same token must not authorize a later maintenance operation.
test("stale permit rejects replaced inhibitor with exact bigint inode", () => {
  const f = fixture();
  f.files.set(base + "/maintenance.inhibit", { ...f.marker, ino: 9007199254740992n });
  assert.throws(() => f.assertMaintenanceAllowed(token));
  assert.equal(f.runGate("restore-migration"), false);
});
