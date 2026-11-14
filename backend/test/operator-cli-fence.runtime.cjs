"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SecureFilesystem } = require(
  "../dist/uploads/secure-filesystem.js",
);

const workdir = path.resolve(__dirname, "..");
const preload = path.join(
  __dirname,
  "entrypoint-fence-preload.cjs",
);

async function invoke(root, cli, action, flags) {
  const child = spawn(
    "sh",
    [
      "docker/entrypoint.sh",
      "node",
      cli,
      action,
      ...flags,
    ],
    {
      cwd: workdir,
      env: {
        ...process.env,
        STORAGE_PATH: root,
        NODE_OPTIONS: `--require ${preload}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Operator CLI test timed out"));
    }, 8000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function withRoot(callback) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hc-operator-fence-"),
  );

  try {
    await callback(root);
  } finally {
    fs.rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}

const cli = "./node_modules/typeorm/cli.js";
const flags = [
  "-d",
  "dist/data-source.js",
  "--transaction",
  "all",
];

test("operator migration requires exclusive root lock", async () => {
  await withRoot(async (root) => {
    const boundary = new SecureFilesystem(
      root,
      fs.lstatSync(root),
    );
    const fd = boundary.directory(root);

    try {
      boundary.lock(fd);

      const blocked = await invoke(
        root,
        cli,
        "migration:run",
        flags,
      );

      assert.notEqual(blocked.code, 0);
      assert.doesNotMatch(
        blocked.stdout,
        /HC_MIGRATIONS_FENCED/,
      );
    } finally {
      fs.closeSync(fd);
      boundary.close();
    }

    const allowed = await invoke(
      root,
      cli,
      "migration:run",
      flags,
    );

    assert.equal(allowed.code, 0, allowed.stderr);
    assert.match(
      allowed.stdout,
      /HC_MIGRATIONS_FENCED/,
    );
  });
});

test("schema:drop is rejected without execution", async () => {
  await withRoot(async (root) => {
    const result = await invoke(
      root,
      cli,
      "schema:drop",
      ["-d", "dist/data-source.js"],
    );

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /Unsupported operator TypeORM CLI invocation/,
    );
    assert.doesNotMatch(
      result.stdout,
      /HC_MIGRATIONS_FENCED/,
    );
  });
});

test("migration:revert is rejected without execution", async () => {
  await withRoot(async (root) => {
    const result = await invoke(
      root,
      cli,
      "migration:revert",
      ["-d", "dist/data-source.js"],
    );

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /Unsupported operator TypeORM CLI invocation/,
    );
  });
});

test("arbitrary SQL query is rejected", async () => {
  await withRoot(async (root) => {
    const result = await invoke(
      root,
      cli,
      "query",
      ["DELETE FROM files"],
    );

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /Unsupported operator TypeORM CLI invocation/,
    );
  });
});

test("migration:show is allowed under root fence", async () => {
  await withRoot(async (root) => {
    const result = await invoke(
      root,
      "node_modules/typeorm/cli.js",
      "migration:show",
      ["-d", "dist/data-source.js"],
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /HC_MIGRATIONS_FENCED/,
    );
  });
});
