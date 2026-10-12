import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StorageService } from "../storage/storage.service";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";
import { SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { PreparedSsdWorkspace } from "./prepared-ssd-workspace";
import { IsolatedSsdFinalizationFilesystem } from "./ssd-finalization-filesystem";
import { RecoveryOperation } from "./ssd-recovery-contract";

// Portable contract only. Synthetic distinct st_dev and a confined mock are
// explicit: these tests do NOT qualify native Linux syscalls or real disks.
jest.mock("node:fs", () => {
  const actual = jest.requireActual<typeof fs>("node:fs");
  const sources = new Set<number>();
  const locks = new Map<string, number>();
  let separate = true;
  const isSource = (target: unknown) =>
    typeof target === "string" &&
    (target.endsWith("/ssd-source") || target.includes("/ssd-source/"));
  const device = (stat: fs.Stats | fs.BigIntStats, source: boolean) =>
    Object.assign(
      Object.create(Object.getPrototypeOf(stat)) as object,
      stat,
      separate && source
        ? { dev: typeof stat.dev === "bigint" ? 987654n : 987654 }
        : {},
    );
  return {
    __esModule: true,
    ...actual,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = actual.openSync(...args);
      if (isSource(args[0])) sources.add(fd);
      return fd;
    },
    closeSync: (fd: number) => {
      for (const [identity, lockedFd] of locks)
        if (lockedFd === fd) locks.delete(identity);
      sources.delete(fd);
      actual.closeSync(fd);
    },
    fstatSync: (fd: number, options?: fs.StatOptions) =>
      device(actual.fstatSync(fd, options), sources.has(fd)),
    lstatSync: (target: fs.PathLike, options?: fs.StatOptions) =>
      device(actual.lstatSync(target, options)!, isSource(target)),
    setSeparateForTest: (value: boolean) => {
      separate = value;
    },
    lockRootForTest: (fd: number) => {
      const stat = actual.fstatSync(fd);
      const identity = `${stat.dev}/${stat.ino}`;
      if (locks.has(identity))
        throw Object.assign(new Error("Live worker lock busy"), {
          code: "EWOULDBLOCK",
        });
      locks.set(identity, fd);
    },
  };
});

jest.mock("./secure-filesystem", () => ({
  SecureFilesystem: class {
    constructor(
      readonly root: string,
      expected: fs.Stats,
    ) {
      const current = fs.lstatSync(root);
      if (current.dev !== expected.dev || current.ino !== expected.ino)
        throw new Error("Mock root acquisition changed");
    }
    private safe(target: string) {
      if (!(target === this.root || target.startsWith(this.root + path.sep)))
        throw new Error("Mock path escapes root");
      let current = this.root;
      for (const part of path
        .relative(this.root, target)
        .split(path.sep)
        .filter(Boolean)) {
        current = path.join(current, part);
        try {
          if (fs.lstatSync(current).isSymbolicLink())
            throw new Error("Mock symlink refused");
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
      }
    }
    stat(target: string) {
      this.safe(target);
      return fs.lstatSync(target);
    }
    lock(fd: number) {
      (fs as unknown as { lockRootForTest(fd: number): void }).lockRootForTest(
        fd,
      );
    }
    removeOwned(target: string, fd: number) {
      this.safe(target);
      const expected = fs.fstatSync(fd),
        actual = fs.lstatSync(target);
      if (
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        !actual.isFile() ||
        actual.nlink !== 1
      )
        throw new Error("Mock removal identity changed");
      fs.unlinkSync(target);
    }
    open(target: string, mode: "r" | "rw" | "wx" = "r") {
      this.safe(target);
      const fd = fs.openSync(target, mode === "rw" ? "r+" : mode, 0o600);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.geteuid!()
      ) {
        fs.closeSync(fd);
        throw new Error("Mock owned regular single-link file required");
      }
      return fd;
    }
    mkdir(target: string) {
      this.safe(target);
      try {
        fs.mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
    }
    sync(target: string, directory = false) {
      this.safe(target);
      const fd = fs.openSync(target, directory ? "r" : "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    rename(source: string, destination: string) {
      this.safe(source);
      this.safe(destination);
      // Single-threaded portable no-overwrite model; not a production fallback.
      if (fs.existsSync(destination))
        throw Object.assign(new Error("Destination exists"), {
          code: "EEXIST",
        });
      fs.renameSync(source, destination);
    }
    close() {}
  },
}));

describe("isolated SSD finalization filesystem portable contract", () => {
  const uploadId = "12345678-1234-4234-8234-123456789abc";
  const operationId = "abcdef12-3456-4234-8234-123456789abc";
  let root: string, source: string, target: string;
  let workspace: PreparedSsdWorkspace;
  let adapter: IsolatedSsdFinalizationFilesystem;
  let storage: StorageService;
  beforeEach(() => {
    (
      fs as unknown as { setSeparateForTest(value: boolean): void }
    ).setSeparateForTest(true);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-finalizer-contract-"));
    source = path.join(root, "ssd-source");
    target = path.join(root, "hdd-target");
    fs.mkdirSync(source, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    fs.mkdirSync(path.join(source, uploadId), { mode: 0o700 });
    fs.writeFileSync(path.join(source, uploadId, "0"), "preserve source", {
      mode: 0o600,
    });
    storage = {
      getPreparedSsdRoot: () => source,
      assertPreparedSsdPath: (absolute: string) => absolute,
      getStoragePath: () => target,
      assertTrustedPath: (absolute: string) => absolute,
      placementForPath: (absolute: string) => ({
        storageLocationId: LEGACY_STORAGE_ID,
        relativeObjectKey: path.relative(target, absolute),
        storagePath: absolute,
      }),
    } as unknown as StorageService;
    workspace = new PreparedSsdWorkspace(storage);
    adapter = new IsolatedSsdFinalizationFilesystem(
      storage,
      workspace,
      SSD_UPLOAD_WORKSPACE,
    );
  });
  afterEach(() => {
    adapter.close();
    workspace.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("pins exact journal identities, opens one chunk, exclusively creates 0600 and publishes", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    expect(binding.relativeObjectKey).toBe(`7/${operationId}.ssd-finalized`);
    expect(binding.temporaryPath).toBe(
      path.join(target, "7", `.${operationId}.assembling`),
    );
    expect(binding.sourceDevice).toBe("987654");
    expect(binding.sourceDirectoryInode).toBe(
      fs
        .lstatSync(path.join(source, uploadId), { bigint: true })
        .ino.toString(),
    );
    expect(binding.targetInode).toBe(
      fs.lstatSync(target, { bigint: true }).ino.toString(),
    );
    const chunk = adapter.openChunk(binding, 0);
    try {
      expect(fs.readFileSync(chunk, "utf8")).toBe("preserve source");
    } finally {
      fs.closeSync(chunk);
    }
    const writer = adapter.createTemporary(binding);
    try {
      expect(fs.fstatSync(writer).mode & 0o777).toBe(0o600);
      fs.writeSync(writer, "assembled");
      fs.fsyncSync(writer);
    } finally {
      fs.closeSync(writer);
    }
    adapter.publish(binding);
    adapter.assertBinding({ ...binding });
    expect(fs.readFileSync(binding.storagePath, "utf8")).toBe("assembled");
    expect(fs.existsSync(binding.temporaryPath)).toBe(false);
    expect(fs.readFileSync(path.join(source, uploadId, "0"), "utf8")).toBe(
      "preserve source",
    );
    expect(() => adapter.publish(binding)).toThrow("already published");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid user %s before target writes",
    (userId) => {
      expect(() => adapter.prepare(userId, uploadId, operationId)).toThrow(
        "identity",
      );
      expect(fs.readdirSync(target)).toEqual([]);
    },
  );
  it.each(["../escape", "ABCDEF12-3456-4234-8234-123456789ABC", "not-a-uuid"])(
    "rejects invalid operation %s",
    (id) => {
      expect(() => adapter.prepare(7, uploadId, id)).toThrow("identity");
      expect(fs.readdirSync(target)).toEqual([]);
    },
  );
  it("rejects source-target same filesystem without target directories", () => {
    (
      fs as unknown as { setSeparateForTest(value: boolean): void }
    ).setSeparateForTest(false);
    expect(() => adapter.prepare(7, uploadId, operationId)).toThrow("separate");
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it.each(["root", "source session", "target user"])(
    "latches replaced %s and leaves replacement untouched",
    (which) => {
      const binding = adapter.prepare(7, uploadId, operationId);
      const replaced =
        which === "root"
          ? target
          : which === "source session"
            ? path.join(source, uploadId)
            : path.join(target, "7");
      fs.renameSync(replaced, replaced + ".original");
      fs.mkdirSync(replaced, { mode: 0o700 });
      expect(() => adapter.assertBinding(binding)).toThrow(
        "binding unavailable",
      );
      fs.rmdirSync(replaced);
      fs.renameSync(replaced + ".original", replaced);
      expect(() => adapter.assertBinding(binding)).toThrow("unavailable");
      expect(fs.existsSync(binding.temporaryPath)).toBe(false);
    },
  );
  it("rejects a changed binding, invalid chunk index, and missing chunk without writes", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    expect(() => adapter.openChunk(binding, -1)).toThrow("index");
    expect(() => adapter.openChunk(binding, 99)).toThrow();
    expect(() =>
      adapter.assertBinding({
        ...binding,
        storagePath: path.join(target, "other"),
      }),
    ).toThrow("binding unavailable");
    expect(fs.readdirSync(path.join(target, "7"))).toEqual([]);
  });
  it("preserves an existing destination and temporary on failed no-overwrite publication", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const writer = adapter.createTemporary(binding);
    try {
      fs.writeSync(writer, "new");
      fs.fsyncSync(writer);
    } finally {
      fs.closeSync(writer);
    }
    fs.writeFileSync(binding.storagePath, "original", { mode: 0o600 });
    expect(() => adapter.publish(binding)).toThrow("Destination exists");
    expect(fs.readFileSync(binding.storagePath, "utf8")).toBe("original");
    expect(fs.readFileSync(binding.temporaryPath, "utf8")).toBe("new");
  });
  it("preserves a preexisting temporary rather than adopting or overwriting it", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.writeFileSync(binding.temporaryPath, "original", { mode: 0o600 });
    expect(() => adapter.createTemporary(binding)).toThrow();
    expect(fs.readFileSync(binding.temporaryPath, "utf8")).toBe("original");
  });
  it("rejects a substituted temporary before publication", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.closeSync(adapter.createTemporary(binding));
    fs.renameSync(binding.temporaryPath, binding.temporaryPath + ".original");
    fs.writeFileSync(binding.temporaryPath, "substitute", { mode: 0o600 });
    expect(() => adapter.publish(binding)).toThrow("binding unavailable");
    expect(fs.existsSync(binding.storagePath)).toBe(false);
    expect(fs.readFileSync(binding.temporaryPath, "utf8")).toBe("substitute");
  });
  it.each([
    "writable source",
    "writable target",
    "target symlink",
    "source symlink",
  ])("rejects %s during prepare", (which) => {
    if (which === "writable source")
      fs.chmodSync(path.join(source, uploadId), 0o777);
    if (which === "writable target") {
      fs.mkdirSync(path.join(target, "7"));
      fs.chmodSync(path.join(target, "7"), 0o777);
    }
    if (which === "target symlink")
      fs.symlinkSync(source, path.join(target, "7"));
    if (which === "source symlink") {
      fs.renameSync(path.join(source, uploadId), path.join(source, "real"));
      fs.symlinkSync(path.join(source, "real"), path.join(source, uploadId));
    }
    expect(() => adapter.prepare(7, uploadId, operationId)).toThrow();
    expect(
      fs.existsSync(path.join(target, "7", `${operationId}.ssd-finalized`)),
    ).toBe(false);
  });
  it("closes idempotently and leaves partial bytes for later recovery", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const writer = adapter.createTemporary(binding);
    fs.writeSync(writer, "partial");
    fs.closeSync(writer);
    adapter.close();
    adapter.close();
    expect(() => adapter.assertBinding(binding)).toThrow("unavailable");
    expect(fs.readFileSync(binding.temporaryPath, "utf8")).toBe("partial");
    expect(fs.existsSync(binding.storagePath)).toBe(false);
  });
  const identityOf = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return { device: stat.dev.toString(), inode: stat.ino.toString() };
  };
  const restart = (operation: RecoveryOperation) => {
    adapter.close();
    workspace.close();
    workspace = new PreparedSsdWorkspace(storage);
    adapter = new IsolatedSsdFinalizationFilesystem(
      storage,
      workspace,
      SSD_UPLOAD_WORKSPACE,
    );
    adapter.reopen(operation);
  };
  const journal = (
    binding: RecoveryOperation["binding"],
    targetIdentity: RecoveryOperation["targetIdentity"],
  ): RecoveryOperation => ({
    id: operationId,
    sessionId: 1,
    userId: 7,
    uploadId,
    filename: "file",
    parentId: null,
    totalSize: 15,
    chunkSize: 15,
    totalChunks: 1,
    expectedSha256: "a".repeat(64),
    binding,
    targetIdentity,
    state: "assembling",
    cleanupState: "pending",
  });
  it("reopens a journal-owned partial inode and resets it without changing identity", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const writer = adapter.createTemporary(binding);
    fs.writeSync(writer, "partial");
    fs.closeSync(writer);
    const identity = identityOf(binding.temporaryPath);
    restart(journal(binding, identity));
    const reset = adapter.resetTemporary(binding, identity);
    fs.writeSync(reset, "recovered");
    fs.fsyncSync(reset);
    fs.closeSync(reset);
    expect(identityOf(binding.temporaryPath)).toEqual(identity);
    adapter.syncTarget(binding, false);
    adapter.publish(binding);
    adapter.syncTarget(binding, true);
    expect(fs.readFileSync(binding.storagePath, "utf8")).toBe("recovered");
  });
  it("reopens the published inode after a rename response loss", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.closeSync(adapter.createTemporary(binding));
    const identity = identityOf(binding.temporaryPath);
    adapter.publish(binding);
    restart(journal(binding, identity));
    const found = adapter.inspectTarget(binding, true)!;
    expect(found.identity).toEqual(identity);
    fs.closeSync(found.fd);
    expect(adapter.inspectTarget(binding, false)).toBeNull();
    adapter.syncTarget(binding, true);
    expect(() => adapter.resetTemporary(binding, identity)).toThrow(
      "identity unavailable",
    );
  });
  it("creates and inspects a newly checkpointed target in the same reopened capability", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    restart(journal(binding, null));
    const fd = adapter.createTemporary(binding);
    fs.writeSync(fd, "recovered");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    const observed = adapter.inspectTarget(binding, false)!;
    expect(observed.identity).toEqual(identityOf(binding.temporaryPath));
    fs.closeSync(observed.fd);
    adapter.syncTarget(binding, false);
    adapter.publish(binding);
    adapter.syncTarget(binding, true);
    expect(fs.readFileSync(binding.storagePath, "utf8")).toBe("recovered");
  });
  it("keeps an exclusive-create crash artifact when its inode was never recorded", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.closeSync(adapter.createTemporary(binding));
    expect(() => restart(journal(binding, null))).toThrow(
      "Unowned recovery target",
    );
    expect(fs.existsSync(binding.temporaryPath)).toBe(true);
  });
  it("keeps a replaced journal-owned target without truncating it", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.closeSync(adapter.createTemporary(binding));
    const identity = identityOf(binding.temporaryPath);
    adapter.close();
    fs.renameSync(binding.temporaryPath, binding.temporaryPath + ".original");
    fs.writeFileSync(binding.temporaryPath, "unknown", { mode: 0o600 });
    expect(() => restart(journal(binding, identity))).toThrow(
      "Unowned recovery target",
    );
    expect(fs.readFileSync(binding.temporaryPath, "utf8")).toBe("unknown");
    expect(fs.existsSync(binding.temporaryPath + ".original")).toBe(true);
  });
  it("does not recreate a missing target directory on recovery", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    adapter.close();
    fs.rmdirSync(path.dirname(binding.storagePath));
    expect(() => restart(journal(binding, null))).toThrow();
    expect(fs.existsSync(path.dirname(binding.storagePath))).toBe(false);
  });
  it("rejects a changed persisted directory identity on restart", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    expect(() =>
      restart(journal({ ...binding, sourceDirectoryInode: "0" }, null)),
    ).toThrow("binding changed");
    expect(fs.readdirSync(path.dirname(binding.storagePath))).toEqual([]);
  });
  it("revalidates approved mount/source and marker mappings even with unchanged inode", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    storage.assertPreparedSsdPath = () => {
      throw new Error("Approved marker unavailable");
    };
    expect(() => restart(journal(binding, null))).toThrow();
    expect(fs.readFileSync(path.join(source, uploadId, "0"), "utf8")).toBe(
      "preserve source",
    );
  });
  it("never steals a live stale worker lock even when its journal permits replay", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const otherWorkspace = new PreparedSsdWorkspace(storage);
    const other = new IsolatedSsdFinalizationFilesystem(
      storage,
      otherWorkspace,
      SSD_UPLOAD_WORKSPACE,
    );
    try {
      expect(() => other.reopen(journal(binding, null))).toThrow("lock busy");
    } finally {
      other.close();
      otherWorkspace.close();
    }
    adapter.assertBinding(binding);
    expect(fs.readdirSync(path.dirname(binding.storagePath))).toEqual([]);
    restart(journal(binding, null)); // dead worker's FD releases the model lock
    adapter.assertBinding(binding);
  });
  it("removes only the exact owned chunk, repeats missing cleanup and preserves unknown names", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const chunk = path.join(source, uploadId, "0");
    const identity = identityOf(chunk);
    const part = { chunkIndex: 0, byteSize: 15, sha256: "a".repeat(64) };
    fs.writeFileSync(path.join(source, uploadId, "unknown"), "untouched", {
      mode: 0o600,
    });
    adapter.removeChunk(binding, part, identity);
    adapter.removeChunk(binding, part, identity);
    adapter.syncSource(binding);
    expect(fs.readdirSync(path.join(source, uploadId))).toEqual(["unknown"]);
  });
  it("refuses replacement, wrong size, hardlinked and non-owned-mode chunks during cleanup", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    const chunk = path.join(source, uploadId, "0");
    const identity = identityOf(chunk);
    const part = { chunkIndex: 0, byteSize: 15, sha256: "a".repeat(64) };
    expect(() =>
      adapter.removeChunk(binding, { ...part, byteSize: 14 }, identity),
    ).toThrow("identity changed");
    expect(() =>
      adapter.removeChunk(binding, part, { ...identity, inode: "0" }),
    ).toThrow("identity changed");
    fs.linkSync(chunk, chunk + ".other");
    expect(() => adapter.removeChunk(binding, part, identity)).toThrow();
    fs.unlinkSync(chunk + ".other");
    fs.chmodSync(chunk, 0o644);
    expect(() => adapter.removeChunk(binding, part, identity)).toThrow(
      "Untrusted",
    );
    expect(fs.readFileSync(chunk, "utf8")).toBe("preserve source");
  });
  it("preserves both copies when an extra final object makes recovery ambiguous", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    fs.closeSync(adapter.createTemporary(binding));
    const identity = identityOf(binding.temporaryPath);
    fs.writeFileSync(binding.storagePath, "unknown final", { mode: 0o600 });
    expect(() => restart(journal(binding, identity))).toThrow(
      "Unowned recovery target",
    );
    expect(fs.existsSync(binding.temporaryPath)).toBe(true);
    expect(fs.readFileSync(binding.storagePath, "utf8")).toBe("unknown final");
  });
  it("rejects an unavailable approved HDD even when the journal's inode still exists", () => {
    const binding = adapter.prepare(7, uploadId, operationId);
    storage.getStoragePath = () => {
      throw new Error("Approved HDD source unavailable");
    };
    expect(() => restart(journal(binding, null))).toThrow(
      "HDD source unavailable",
    );
    expect(fs.existsSync(path.join(source, uploadId, "0"))).toBe(true);
  });
  it("native boundary declares nonblocking flock and exact descriptor deletion with directory durability", () => {
    // Source-shape evidence only; Linux execution is a separate activation gate.
    const code = fs.readFileSync(
      path.join(__dirname, "../../native/secure-fs.c"),
      "utf8",
    );
    expect(code).toContain("flock(fd,LOCK_EX|LOCK_NB)");
    expect(code).toContain("a.st_dev!=b.st_dev || a.st_ino!=b.st_ino");
    expect(code).toContain("unlinkat(p,leaf,0)");
    expect(code).toContain("fsync(p)");
    expect(code).toContain('{"lock",0,lock_root');
    expect(code).toContain('{"removeOwned",0,remove_owned');
  });
});
