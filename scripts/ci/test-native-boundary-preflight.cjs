"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { nativeProbe } = require("./native-boundary-preflight.cjs");

test("addon loading cannot hide a failed root syscall; owned temporary root is removed", () => {
  let temporary;
  const result = nativeProbe(() => ({ root(value) {
    temporary = value;
    throw Object.assign(new Error("Function not implemented"), { code: "ENOSYS" });
  } }));
  assert.equal(result.nativeAddonLoaded, true);
  assert.equal(result.nativeBoundaryOperational, false);
  assert.equal(result.phase, "root");
  assert.equal(result.error.code, "ENOSYS");
  assert.equal(fs.existsSync(temporary), false);
});

test("probe exercises identity and flock and releases both descriptors", () => {
  let fd, closed = false, locked = false;
  const result = nativeProbe(() => ({
    root: (value) => value,
    directory(root, key) {
      assert.equal(key, ".");
      return (fd = fs.openSync(root, "r"));
    },
    lock(root, descriptor) { assert.equal(descriptor, fd); locked = true; },
    close() { closed = true; },
  }));
  assert.equal(result.nativeBoundaryOperational, true);
  assert.equal(result.phase, "complete");
  assert.equal(locked && closed, true);
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});

test("flock refusal is a qualification failure and closes the capability", () => {
  let closed = false;
  const result = nativeProbe(() => ({
    root: (value) => value,
    directory: (root) => fs.openSync(root, "r"),
    lock() { throw Object.assign(new Error("lock unavailable"), { code: "EAGAIN" }); },
    close() { closed = true; },
  }));
  assert.equal(result.nativeBoundaryOperational, false);
  assert.equal(result.phase, "flock");
  assert.equal(result.error.code, "EAGAIN");
  assert.equal(closed, true);
});

test("inline container invocation emits diagnostics and strict mode refuses a missing addon", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hc-preflight-invocation-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "native-boundary-preflight.cjs"), "utf8");
    const result = spawnSync(process.execPath, ["-e", source, "--", "--strict"],
      { cwd: temporary, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.nativeAddonLoaded, false);
    assert.equal(data.nativeBoundaryOperational, false);
    assert.equal(data.phase, "load");
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
});
