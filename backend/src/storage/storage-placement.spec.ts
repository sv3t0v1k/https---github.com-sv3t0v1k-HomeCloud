import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LEGACY_STORAGE_ID,
  StorageRegistry,
  validateObjectKey,
} from "./storage-placement";

describe("Legacy storage registry: real filesystem confinement", () => {
  let root: string;
  let registry: StorageRegistry;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-placement-"));
    registry = new StorageRegistry(root);
    fs.mkdirSync(path.join(root, "1"));
    fs.writeFileSync(
      path.join(root, "1", "object.bin"),
      Buffer.from([0, 255, 128]),
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it.each([
    "",
    "/etc/passwd",
    "../x",
    "a/../x",
    "a/./b",
    "a//b",
    "a/",
    "a\\b",
    "C:/x",
    "C:x",
    "a\0b",
    "a\ud800b",
    "a\udfffb",
    ".tmp/x",
    ".restore-staging/x",
  ])("rejects malformed key %p", (key) => {
    expect(() => validateObjectKey(key)).toThrow();
  });
  it("rejects malformed Unicode roots/absolute paths but preserves valid Unicode scalars", () => {
    expect(() => new StorageRegistry(root + "\ud800")).toThrow();
    expect(() =>
      registry.keyFromAbsolute(root + "/1/bad\ud800.bin", true),
    ).toThrow();
    expect(
      registry.placementForPath(root + "/1/emoji-😀.bin").relativeObjectKey,
    ).toBe("1/emoji-😀.bin");
  });
  it("resolves only the logical pair and enforces the retained absolute bridge", () => {
    const file = registry.placementForPath(path.join(root, "1/object.bin"));
    expect(file.storageLocationId).toBe(LEGACY_STORAGE_ID);
    expect(file.relativeObjectKey).toBe("1/object.bin");
    expect(registry.resolve(file)).toBe(file.storagePath);
    expect(() =>
      registry.resolve({ ...file, storagePath: path.join(root, "other") }),
    ).toThrow();
    expect(() =>
      registry.resolve({ ...file, storageLocationId: "unknown" }),
    ).toThrow();
    expect(() => registry.resolve({ storagePath: file.storagePath })).toThrow();
    expect(() =>
      registry.resolve({ ...file, relativeObjectKey: null }),
    ).toThrow();
  });
  it("does not normalize unsafe legacy paths or confuse root-prefix siblings", () => {
    for (const target of [
      root,
      root + "-other/file",
      root + "/1/../1/object.bin",
      root + "/1//object.bin",
      "relative",
    ]) {
      expect(() => registry.keyFromAbsolute(target)).toThrow();
    }
  });
  it("rejects symlink leaf and ancestor even when link target stays inside root", () => {
    fs.symlinkSync(path.join(root, "1/object.bin"), path.join(root, "leaf"));
    fs.symlinkSync(path.join(root, "1"), path.join(root, "ancestor"));
    for (const key of ["leaf", "ancestor/object.bin", "ancestor/new.bin"]) {
      expect(() => registry.placementForPath(path.join(root, key))).toThrow();
    }
  });
  it("supports safe new targets and idempotent missing-object cleanup, never recreates a missing root", () => {
    const file = registry.placementForPath(path.join(root, "1/new.bin"));
    expect(() => registry.resolve(file)).toThrow();
    expect(registry.resolve(file, true)).toBe(file.storagePath);
    fs.rmSync(root, { recursive: true });
    expect(() => registry.resolve(file, true)).toThrow();
    expect(fs.existsSync(root)).toBe(false);
  });
});
