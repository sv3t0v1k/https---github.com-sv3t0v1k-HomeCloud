import * as fs from "node:fs";
import * as path from "node:path";

import {
  ApprovedRoot,
  IDENTITY_MARKER,
  LEGACY_STORAGE_ID,
  StorageMountRegistry,
  legacyBinding,
  validateRoot,
} from "./storage-mount-registry";
export {
  LEGACY_STORAGE_ID,
  LEGACY_STORAGE_KEY,
} from "./storage-mount-registry";

export interface FilePlacement {
  storageLocationId?: string | null;
  relativeObjectKey?: string | null;
  storagePath?: string | null;
}

function hasMalformedUnicode(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  });
}

export function validateObjectKey(key: string): string {
  if (
    typeof key !== "string" ||
    hasMalformedUnicode(key) ||
    !key ||
    key.includes("\\") ||
    key.includes("\0") ||
    path.posix.isAbsolute(key) ||
    path.win32.isAbsolute(key) ||
    /^[A-Za-z]:/.test(key) ||
    key.split("/").some((p) => !p || p === "." || p === "..") ||
    key.split("/")[0] === ".tmp" ||
    key.split("/")[0] === IDENTITY_MARKER ||
    key.split("/")[0].startsWith(".hc-probe-") ||
    key.split("/")[0].startsWith(".restore-")
  ) {
    throw new Error("Invalid storage object key");
  }
  return key;
}

/** Portable profile: directories inside the registered root must be exclusively
 * owned by the service. lstat/realpath is not race-free openat2 confinement. */
export class StorageRegistry {
  readonly root: string;
  readonly mounts: StorageMountRegistry;
  constructor(
    root: string,
    production = false,
    bindings: readonly ApprovedRoot[] = [legacyBinding(root, production)],
  ) {
    validateRoot(root);
    this.root = root;
    this.mounts = new StorageMountRegistry(bindings);
    if (this.mounts.approved(LEGACY_STORAGE_ID).root !== root)
      throw new Error("Legacy root mismatch");
  }

  close(): void { this.mounts.close(); }

  assertLegacyAccess(write = false): void {
    this.mounts.assertAccess(LEGACY_STORAGE_ID, write);
  }

  /** Legacy workspace compatibility admission; does not redesign UploadSession. */
  assertTemporaryPath(absolute: string, write = true): string {
    this.assertLegacyAccess(write);
    if (
      typeof absolute !== "string" ||
      absolute !== path.resolve(absolute) ||
      !(
        absolute === path.join(this.root, ".tmp") ||
        absolute.startsWith(path.join(this.root, ".tmp") + path.sep)
      )
    )
      throw new Error("Unsafe legacy temporary path");
    const key = path.relative(this.root, absolute);
    if (key.includes("\\") || key.includes("\0") || hasMalformedUnicode(key))
      throw new Error("Unsafe legacy temporary path");
    this.checkComponents(key, true, true);
    return absolute;
  }

  private checkComponents(
    key: string,
    allowMissing: boolean,
    allowDirectory = false,
  ): string {
    const realRoot = fs.realpathSync(this.root);
    const device = fs.lstatSync(this.root).dev;
    const components = key.split("/");
    let candidate = this.root;
    for (let i = 0; i < components.length; i++) {
      candidate = path.join(candidate, components[i]);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(candidate);
      } catch (error) {
        if (allowMissing && (error as { code?: string }).code === "ENOENT")
          return path.join(this.root, ...components);
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        stat.dev !== device ||
        (i < components.length - 1
          ? !stat.isDirectory()
          : !(stat.isFile() || (allowDirectory && stat.isDirectory()))) ||
        (stat.isDirectory() &&
          ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))
      )
        throw new Error("Unsafe storage object");
      const expected = path.join(realRoot, ...components.slice(0, i + 1));
      if (fs.realpathSync(candidate) !== expected)
        throw new Error("Storage confinement violation");
    }
    return candidate;
  }

  assertDirectoryPath(absolute: string, write = false): string {
    this.assertLegacyAccess(write);
    if (absolute === this.root) return absolute;
    if (
      absolute !== path.resolve(absolute) ||
      !absolute.startsWith(this.root + path.sep)
    )
      throw new Error("Unsafe storage directory");
    const key = validateObjectKey(path.relative(this.root, absolute));
    const candidate = this.checkComponents(key, true, true);
    if (fs.existsSync(candidate) && !fs.lstatSync(candidate).isDirectory())
      throw new Error("Unsafe storage directory");
    return candidate;
  }

  private confined(key: string, allowMissing: boolean): string {
    validateObjectKey(key);
    this.assertLegacyAccess();
    return this.checkComponents(key, allowMissing);
  }

  keyFromAbsolute(absolute: string, allowMissing = false): string {
    if (
      typeof absolute !== "string" ||
      hasMalformedUnicode(absolute) ||
      !path.isAbsolute(absolute) ||
      absolute !== path.resolve(absolute) ||
      !absolute.startsWith(this.root + path.sep)
    ) {
      throw new Error("Unmappable legacy storage path");
    }
    const key = validateObjectKey(path.relative(this.root, absolute));
    if (this.confined(key, allowMissing) !== absolute)
      throw new Error("Ambiguous storage path");
    return key;
  }

  placementForPath(absolute: string, allowMissing = true) {
    const relativeObjectKey = this.keyFromAbsolute(absolute, allowMissing);
    return {
      storageLocationId: LEGACY_STORAGE_ID,
      relativeObjectKey,
      storagePath: absolute,
    };
  }

  resolve(file: FilePlacement, allowMissing = false): string {
    if (
      file.storageLocationId !== LEGACY_STORAGE_ID ||
      !file.relativeObjectKey
    ) {
      throw new Error("Unknown or incomplete storage placement");
    }
    const absolute = this.confined(file.relativeObjectKey, allowMissing);
    if (file.storagePath !== absolute)
      throw new Error("Inconsistent legacy storage bridge");
    return absolute;
  }
}
