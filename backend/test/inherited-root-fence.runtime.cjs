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

const script = `
const { assertInheritedRootFence } = require(
  "./dist/uploads/inherited-root-fence.js"
);
try {
  assertInheritedRootFence();
  console.log("FENCE_OK");
} catch (error) {
  console.error("FENCE_REJECTED:" + error.message);
  process.exitCode = 42;
}
`;

async function probe(root, inheritedFd, advertise = true) {
  const env = { ...process.env, STORAGE_PATH: root };

  delete env.HOMECLOUD_ROOT_FENCE_FD;

  if (advertise) {
    env.HOMECLOUD_ROOT_FENCE_FD = "3";
  }

  const child = spawn(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    env,
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      inheritedFd === undefined ? "ignore" : inheritedFd,
    ],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return { ...result, stdout, stderr };
}

async function withRoot(callback) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "hc-api-root-fence-"),
  );

  try {
    await callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function openBoundary(root) {
  const boundary = new SecureFilesystem(
    root,
    fs.lstatSync(root),
  );

  return {
    boundary,
    fd: boundary.directory(root),
  };
}

function closeBoundary(handle) {
  fs.closeSync(handle.fd);
  handle.boundary.close();
}

test("accepts a genuinely inherited locked FD", async () => {
  await withRoot(async (root) => {
    const holder = openBoundary(root);

    try {
      holder.boundary.lock(holder.fd);
      const result = await probe(root, holder.fd);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /FENCE_OK/);
    } finally {
      closeBoundary(holder);
    }
  });
});

test("rejects missing fence environment", async () => {
  await withRoot(async (root) => {
    const holder = openBoundary(root);

    try {
      holder.boundary.lock(holder.fd);
      const result = await probe(root, holder.fd, false);

      assert.equal(result.code, 42);
      assert.match(result.stderr, /FENCE_REJECTED/);
    } finally {
      closeBoundary(holder);
    }
  });
});

test("rejects advertised FD without an existing lock", async () => {
  await withRoot(async (root) => {
    const holder = openBoundary(root);

    try {
      const result = await probe(root, holder.fd);

      assert.equal(result.code, 42);
      assert.match(
        result.stderr,
        /Inherited root was not locked/,
      );
    } finally {
      closeBoundary(holder);
    }
  });
});

test("rejects missing FD even with advertised environment", async () => {
  await withRoot(async (root) => {
    const result = await probe(root, undefined);

    assert.equal(result.code, 42);
    assert.match(result.stderr, /FENCE_REJECTED/);
  });
});

test("rejects an inherited FD from a different directory", async () => {
  await withRoot(async (root) => {
    await withRoot(async (otherRoot) => {
      const holder = openBoundary(otherRoot);

      try {
        holder.boundary.lock(holder.fd);
        const result = await probe(root, holder.fd);

        assert.equal(result.code, 42);
        assert.match(
          result.stderr,
          /Inherited root descriptor mismatch/,
        );
      } finally {
        closeBoundary(holder);
      }
    });
  });
});
