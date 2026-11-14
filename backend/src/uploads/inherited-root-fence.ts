import * as fs from "node:fs";
import * as path from "node:path";
import { SecureFilesystem } from "./secure-filesystem";

/**
 * Required before NestFactory.create() on Linux.
 *
 * FD 3 must refer to the storage root and already belong to
 * a locked open-file description inherited from the supervisor.
 */
export function assertInheritedRootFence(): void {
  if (process.platform !== "linux") {
    throw new Error("Root fencing requires Linux");
  }

  if (process.env.HOMECLOUD_ROOT_FENCE_FD !== "3") {
    throw new Error("Required inherited root fence is missing");
  }

  if (process.geteuid?.() === 0) {
    throw new Error("Privileged fenced API refused");
  }

  const root = process.env.STORAGE_PATH || "/storage";

  if (!path.isAbsolute(root) || root !== path.resolve(root)) {
    throw new Error("Invalid fenced storage root");
  }

  const expected = fs.lstatSync(root);

  if (!expected.isDirectory() || expected.isSymbolicLink()) {
    throw new Error("Unsafe fenced storage root");
  }

  const boundary = new SecureFilesystem(root, expected);
  let contenderFd: number | undefined;

  try {
    contenderFd = boundary.directory(root);

    const inherited = fs.fstatSync(3);
    const current = fs.fstatSync(contenderFd);

    if (
      !inherited.isDirectory() ||
      inherited.dev !== current.dev ||
      inherited.ino !== current.ino
    ) {
      throw new Error("Inherited root descriptor mismatch");
    }

    // A fresh, independent descriptor MUST encounter an
    // already-held lock. Otherwise this is not inherited fencing.
    let contended = false;

    try {
      boundary.lock(contenderFd);
    } catch (error) {
      if ((error as { code?: string }).code !== "EWOULDBLOCK") {
        throw new Error("Root lock contention cannot be verified");
      }

      contended = true;
    }

    if (!contended) {
      throw new Error("Inherited root was not locked");
    }

    // Must be the SAME locked open-file description.
    // A different FD referring to the locked root fails.
    boundary.lock(3);

    const visible = fs.lstatSync(root);

    if (
      !visible.isDirectory() ||
      visible.isSymbolicLink() ||
      visible.dev !== inherited.dev ||
      visible.ino !== inherited.ino
    ) {
      throw new Error("Fenced root changed during verification");
    }
  } finally {
    if (contenderFd !== undefined) {
      fs.closeSync(contenderFd);
    }

    boundary.close();
  }

  // Do NOT close FD 3: it preserves the lock after supervisor death.
}
