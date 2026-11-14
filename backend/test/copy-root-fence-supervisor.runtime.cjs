"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { SecureFilesystem } = require(
  "../dist/uploads/secure-filesystem.js",
);
const { runWithRootFence } = require(
  "../docker/copy-root-fence-supervisor.cjs",
);

const mode = process.env.HC_FENCE_TEST_MODE;

if (mode) {
  const migration =
    mode === "migration-fail"
      ? [
          "-e",
          'console.log("HC_MIGRATION_FAILED");process.exit(17)',
        ]
      : [
          "-e",
          'console.log("HC_MIGRATION_ACTIVE");setTimeout(()=>process.exit(0),1200)',
        ];

  const api = [
    "-e",
    'console.log("HC_API_ACTIVE:"+process.pid);setInterval(()=>{},1000)',
  ];

  runWithRootFence(process.env.HC_FENCE_TEST_ROOT, [
    [process.execPath, migration],
    [process.execPath, api],
  ]).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
} else {
  function start(mode, root) {
    const child = spawn(process.execPath, [__filename], {
      env: {
        ...process.env,
        HC_FENCE_TEST_MODE: mode,
        HC_FENCE_TEST_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const state = { out: "", err: "" };

    child.stdout.on("data", (data) => {
      state.out += String(data);
    });

    child.stderr.on("data", (data) => {
      state.err += String(data);
    });

    // The surviving API inherits stdout/stderr. Wait for the
    // supervisor's exit, not for descendant-owned pipes to close.
    const exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      });
    });

    async function waitFor(token) {
      for (let i = 0; i < 200; i++) {
        if (state.out.includes(token)) return;

        if (
          child.exitCode !== null ||
          child.signalCode !== null
        ) {
          throw new Error(
            "Supervisor exited early: " + state.err,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      throw new Error(
        "Missing startup marker: " + token + "\n" + state.err,
      );
    }

    return { child, state, exited, waitFor };
  }

  function canAcquire(root) {
    const boundary = new SecureFilesystem(
      root,
      fs.lstatSync(root),
    );
    const fd = boundary.directory(root);

    try {
      boundary.lock(fd);
      return true;
    } catch {
      return false;
    } finally {
      fs.closeSync(fd);
      boundary.close();
    }
  }

  async function waitUntilUnlocked(root) {
    for (let i = 0; i < 100; i++) {
      if (canAcquire(root)) return true;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return false;
  }

  async function withRoot(callback) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "hc-fence-runtime-"),
    );

    try {
      await callback(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test(
    "lock persists through migrations, API, and supervisor SIGKILL",
    { timeout: 15000 },
    async () => {
      await withRoot(async (root) => {
        const run = start("normal", root);
        let apiPid;

        try {
          await run.waitFor("HC_MIGRATION_ACTIVE");
          assert.equal(canAcquire(root), false);

          await run.waitFor("HC_API_ACTIVE:");
          apiPid = Number(
            run.state.out.match(/HC_API_ACTIVE:(\d+)/)?.[1],
          );

          assert.ok(Number.isSafeInteger(apiPid));
          assert.ok(apiPid > 0);
          assert.equal(canAcquire(root), false);

          assert.equal(run.child.kill("SIGKILL"), true);
          await run.exited;

          // API survives and retains the same kernel lock.
          assert.equal(canAcquire(root), false);

          process.kill(apiPid, "SIGKILL");

          assert.equal(await waitUntilUnlocked(root), true);
        } finally {
          if (
            run.child.exitCode === null &&
            run.child.signalCode === null
          ) {
            run.child.kill("SIGKILL");
          }

          if (apiPid) {
            try {
              process.kill(apiPid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") {
                throw error;
              }
            }
          }

          await run.exited;
        }
      });
    },
  );

  test(
    "failed migrations never start API and release the fence",
    { timeout: 10000 },
    async () => {
      await withRoot(async (root) => {
        const run = start("migration-fail", root);
        const result = await run.exited;

        assert.equal(result.code, 17);
        assert.match(run.state.out, /HC_MIGRATION_FAILED/);
        assert.doesNotMatch(run.state.out, /HC_API_ACTIVE/);
        assert.equal(canAcquire(root), true);
      });
    },
  );

  test(
    "SIGTERM is forwarded to API and the fence is released",
    { timeout: 15000 },
    async () => {
      await withRoot(async (root) => {
        const run = start("normal", root);
        let apiPid;

        try {
          await run.waitFor("HC_API_ACTIVE:");

          apiPid = Number(
            run.state.out.match(/HC_API_ACTIVE:(\d+)/)?.[1],
          );

          assert.ok(Number.isSafeInteger(apiPid));
          assert.equal(canAcquire(root), false);

          assert.equal(run.child.kill("SIGTERM"), true);

          const result = await run.exited;
          assert.equal(result.code, 143);
          assert.equal(await waitUntilUnlocked(root), true);
        } finally {
          if (
            run.child.exitCode === null &&
            run.child.signalCode === null
          ) {
            run.child.kill("SIGKILL");
          }

          if (apiPid) {
            try {
              process.kill(apiPid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") {
                throw error;
              }
            }
          }

          await run.exited;
        }
      });
    },
  );
}
