/* Disposable container probe. No production fallback or host mounts. */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Independent of secure-fs.node: distinguish syscall availability from addon
// loading. Use the target compiler's Linux syscall numbers and open_how ABI.
const syscallSource = String.raw`
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/openat2.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(void) {
  struct open_how minimal = {.flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC};
  int fd = syscall(SYS_openat2, AT_FDCWD, "/tmp", &minimal, sizeof(minimal));
  int first = fd < 0 ? errno : 0;
  if (fd >= 0) close(fd);
  int parent = open("/tmp", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0) return 2;
  struct open_how strict = {
    .flags = O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
               RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV
  };
  fd = syscall(SYS_openat2, parent, ".", &strict, sizeof(strict));
  int second = fd < 0 ? errno : 0;
  if (fd >= 0) close(fd);
  close(parent);
  printf("{\"number\":%ld,\"minimal_errno\":%d,\"strict_errno\":%d}\n",
         (long)SYS_openat2, first, second);
  return 0;
}
`;

function nativeProbe(load = () => require(path.join(process.cwd(), "native/secure-fs.node"))) {
  const result = { os: process.platform, arch: process.arch,
    nativeAddonLoaded: false, nativeBoundaryOperational: false };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hc-native-preflight-"));
  let binding, root, fd;
  try {
    result.phase = "load";
    binding = load();
    result.nativeAddonLoaded = true;
    result.phase = "root";
    root = binding.root(fs.realpathSync(temporary));
    result.phase = "directory";
    fd = binding.directory(root, ".");
    result.phase = "identity";
    const actual = fs.fstatSync(fd, { bigint: true });
    const expected = fs.statSync(temporary, { bigint: true });
    if (actual.dev !== expected.dev || actual.ino !== expected.ino)
      throw new Error("Root descriptor identity mismatch");
    result.phase = "flock";
    binding.lock(root, fd);
    result.phase = "complete";
    result.nativeBoundaryOperational = true;
  } catch (error) {
    result.error = { code: error.code || "PROBE_FAILED", message: error.message };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (root !== undefined) binding.close(root);
    fs.rmSync(temporary, { recursive: true });
  }
  return result;
}

function syscallProbe() {
  if (process.platform !== "linux") return { available: false, reason: "Linux required" };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "hc-openat2-probe-"));
  try {
    const source = path.join(temporary, "probe.c");
    const executable = path.join(temporary, "probe");
    fs.writeFileSync(source, syscallSource, { mode: 0o600 });
    const compiled = spawnSync("cc", ["-Wall", "-Werror", source, "-o", executable],
      { encoding: "utf8", timeout: 20000 });
    if (compiled.error || compiled.status !== 0)
      return { available: false, reason: "compiler unavailable or probe compilation failed",
        code: compiled.error?.code, status: compiled.status };
    const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 5000 });
    if (ran.error || ran.status !== 0)
      return { available: false, reason: "syscall probe did not complete", status: ran.status };
    return { available: true, ...JSON.parse(ran.stdout) };
  } finally {
    fs.rmSync(temporary, { recursive: true });
  }
}

if (require.main === module || !module.parent) {
  // Always emit structured diagnostics; the qualification caller rejects
  // unavailable native operations. Loading the addon alone is never PASS.
  const result = { ...nativeProbe(), openat2: syscallProbe() };
  console.log(JSON.stringify(result));
  if (process.argv.includes("--strict") && !result.nativeBoundaryOperational)
    process.exitCode = 1;
}
module.exports = { nativeProbe, syscallSource };
