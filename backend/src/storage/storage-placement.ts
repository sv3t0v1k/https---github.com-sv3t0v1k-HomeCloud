import * as fs from "node:fs";
import * as path from "node:path";

export const LEGACY_STORAGE_ID = "f2f5c4b0-8d57-4c49-9f8c-0d095b344601";
export const LEGACY_STORAGE_KEY = "legacy-storage";

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
  constructor(root: string) {
    if (
      hasMalformedUnicode(root) ||
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      root === path.parse(root).root ||
      root.includes("\\") ||
      root.includes("\0")
    )
      throw new Error("Invalid storage root");
    this.root = root;
  }

  private confined(key: string, allowMissing: boolean): string {
    validateObjectKey(key);
    const rootStat = fs.lstatSync(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new Error("Invalid storage root");
    const realRoot = fs.realpathSync(this.root);
    const components = key.split("/");
    let candidate = this.root;
    for (let i = 0; i < components.length; i++) {
      candidate = path.join(candidate, components[i]);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(candidate);
      } catch (error) {
        if (
          allowMissing &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return path.join(this.root, ...components);
        }
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        (i < components.length - 1 ? !stat.isDirectory() : !stat.isFile())
      ) {
        throw new Error("Unsafe storage object");
      }
      const expected = path.join(realRoot, ...components.slice(0, i + 1));
      if (fs.realpathSync(candidate) !== expected)
        throw new Error("Storage confinement violation");
    }
    return candidate;
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
