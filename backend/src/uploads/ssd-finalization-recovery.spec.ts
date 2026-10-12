import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { FileEntity } from "../entities/file.entity";
import {
  SsdFinalizationRecovery,
  recoverPendingSsdFinalizations,
} from "./ssd-finalization-recovery";
import {
  ArtifactIdentity,
  RecoveryFilesystem,
  RecoveryOperation,
  RecoveryStore,
} from "./ssd-recovery-contract";
import { FinalizationChunk } from "./ssd-finalization-contract";
import {
  FINALIZER_BUFFER_BYTES,
  identity,
  sameIdentity,
} from "./ssd-finalization-stream";

const id = "abcdef12-3456-4234-8234-123456789abc";
const upload = "12345678-1234-4234-8234-123456789abc";
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("isolated SSD recovery restart and cleanup orchestration (portable)", () => {
  let root: string,
    source: string,
    target: string,
    operation: RecoveryOperation;
  let parts: FinalizationChunk[],
    store: RecoveryStore,
    file: FileEntity | null,
    quota: number;
  let events: string[], fault: string | undefined, preserveLock: boolean;
  const bytes = Buffer.alloc(3 * FINALIZER_BUFFER_BYTES + 11, 41);
  const snapshot = () =>
    JSON.parse(JSON.stringify(operation)) as RecoveryOperation;
  function event(name: string) {
    events.push(name);
    if (fault === name) throw new Error(`Injected ${name}`);
  }
  const chunkPath = (index: number) => path.join(source, String(index));
  function artifactIdentity(name: string): ArtifactIdentity {
    const fd = fs.openSync(name, "r");
    try {
      return identity(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  function own(name: string, observed: ArtifactIdentity) {
    if (!sameIdentity(artifactIdentity(name), observed))
      throw new Error("Test target identity changed");
  }
  function filesystem(): RecoveryFilesystem {
    let closed = false;
    return {
      reopen: () => {
        if (preserveLock) throw new Error("Live worker holds lock");
        event("reopen");
      },
      assertBinding: () => {
        if (closed) throw new Error("Closed filesystem");
        event("binding");
      },
      inspectTarget: (binding, final) => {
        const name = final ? binding.storagePath : binding.temporaryPath;
        try {
          const fd = fs.openSync(name, "r");
          return { fd, identity: identity(fd) };
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return null;
          throw error;
        }
      },
      createTemporary: (binding) => {
        event("create");
        return fs.openSync(binding.temporaryPath, "wx", 0o600);
      },
      resetTemporary: (binding, observed) => {
        own(binding.temporaryPath, observed);
        event("reset");
        const fd = fs.openSync(binding.temporaryPath, "r+");
        fs.ftruncateSync(fd, 0);
        return fd;
      },
      openChunk: (_binding, index) => fs.openSync(chunkPath(index), "r"),
      publish: (binding) => {
        event("before rename");
        if (fs.existsSync(binding.storagePath)) throw new Error("No overwrite");
        fs.renameSync(binding.temporaryPath, binding.storagePath);
        event("after rename");
      },
      syncTarget: (binding, final) => {
        event(final ? "sync final" : "sync temporary");
        const fd = fs.openSync(
          final ? binding.storagePath : binding.temporaryPath,
          "r",
        );
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      },
      removeChunk: (_binding, part, observed) => {
        own(chunkPath(part.chunkIndex), observed);
        event(`before unlink ${part.chunkIndex}`);
        fs.unlinkSync(chunkPath(part.chunkIndex));
        event(`after unlink ${part.chunkIndex}`);
      },
      syncSource: () => event("sync source"),
      close: () => {
        closed = true;
        events.push("close");
      },
    };
  }
  const run = () =>
    new SsdFinalizationRecovery(store, filesystem()).recover(id);
  function seed(
    state: RecoveryOperation["state"],
    location: "none" | "partial" | "temporary" | "final",
  ) {
    operation.state = state;
    if (location !== "none") {
      const name =
        location === "final"
          ? operation.binding.storagePath
          : operation.binding.temporaryPath;
      fs.writeFileSync(
        name,
        location === "partial" ? bytes.subarray(0, 9) : bytes,
        { mode: 0o600 },
      );
      operation.targetIdentity = artifactIdentity(name);
    }
    if (state === "committed") {
      quota = bytes.length;
      file = Object.assign(new FileEntity(), {
        id: 5,
        checksum: hash(bytes),
        size: bytes.length,
      });
    }
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-stage23-recovery-"));
    source = path.join(root, "ssd");
    target = path.join(root, "hdd");
    fs.mkdirSync(source, { mode: 0o700 });
    fs.mkdirSync(target, { mode: 0o700 });
    const split = Math.ceil(bytes.length / 2);
    parts = [bytes.subarray(0, split), bytes.subarray(split)].map(
      (value, index) => {
        fs.writeFileSync(chunkPath(index), value, { mode: 0o600 });
        return {
          chunkIndex: index,
          byteSize: value.length,
          sha256: hash(value),
        };
      },
    );
    operation = {
      id,
      sessionId: 1,
      userId: 1,
      uploadId: upload,
      filename: "fixture.bin",
      parentId: null,
      totalSize: bytes.length,
      chunkSize: split,
      totalChunks: 2,
      expectedSha256: hash(bytes),
      state: "assembling",
      targetIdentity: null,
      cleanupState: "pending",
      binding: {
        sourceWorkspaceId: "ssd",
        sourceRoot: source,
        sourcePath: source,
        sourceDevice: "1",
        sourceInode: "1",
        sourceDirectoryDevice: "1",
        sourceDirectoryInode: "2",
        targetStorageId: "legacy",
        targetRoot: target,
        targetDevice: "2",
        targetInode: "3",
        targetDirectoryDevice: "2",
        targetDirectoryInode: "4",
        temporaryPath: path.join(target, `.${id}.assembling`),
        storagePath: path.join(target, `${id}.ssd-finalized`),
        relativeObjectKey: `${id}.ssd-finalized`,
      },
    };
    file = null;
    quota = 0;
    events = [];
    fault = undefined;
    preserveLock = false;
    store = {
      begin: jest.fn(async () => {
        throw new Error("Recovery cannot reserve a new operation");
      }),
      lookup: jest.fn(async () => {
        event("lookup");
        return { operation: snapshot(), file };
      }),
      recordTarget: jest.fn(async (_id, observed) => {
        event("record target");
        if (
          operation.targetIdentity &&
          !sameIdentity(operation.targetIdentity, observed)
        )
          throw new Error("Immutable target identity");
        operation.targetIdentity = observed;
        event("after target checkpoint");
      }),
      chunks: async function* () {
        for (const part of parts) yield part;
      },
      transition: jest.fn(async (_id, from, to) => {
        event(`before ${to}`);
        if (operation.state !== from) throw new Error("State conflict");
        operation.state = to;
        event(`after ${to}`);
      }),
      commit: jest.fn(async () => {
        event("before commit");
        if (!file) {
          file = Object.assign(new FileEntity(), {
            id: 5,
            size: bytes.length,
            checksum: hash(bytes),
          });
          quota += bytes.length;
          operation.state = "committed";
        }
        event("after commit");
        return file;
      }),
      finishCleanup: jest.fn(async () => {
        event("before cleaned");
        if (operation.state !== "committed") throw new Error("Commit required");
        operation.cleanupState = "cleaned";
        event("after cleaned");
      }),
      pending: async function* () {
        if (operation.cleanupState === "pending") yield id;
      },
    };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("replays durable MIME checkpoint without rerunning a failing detector", async () => {
    seed("verified", "temporary");
    operation.mimeType = "image/png";
    operation.mimeTypeCheckpointed = true;
    const metadata = jest.fn(async () => { throw new Error("Detector unavailable"); });
    await expect(new SsdFinalizationRecovery(store, filesystem(), metadata).recover(id)).resolves.toMatchObject({ size: bytes.length });
    expect(metadata).not.toHaveBeenCalled();
    expect(operation.cleanupState).toBe("cleaned");
    expect(quota).toBe(bytes.length);
  });

  it.each([
    ["assembling", "none"],
    ["assembling", "partial"],
    ["assembling", "temporary"],
    ["verified", "temporary"],
    ["publishing", "temporary"],
    ["publishing", "final"],
    ["published", "final"],
    ["committed", "final"],
  ] as const)(
    "restarts %s/%s, commits once and releases after owned cleanup",
    async (state, location) => {
      seed(state, location);
      fs.writeFileSync(path.join(source, "unknown"), "retain me");
      const result = await run();
      expect(result?.id).toBe(5);
      expect(hash(fs.readFileSync(operation.binding.storagePath))).toBe(
        hash(bytes),
      );
      expect(operation.cleanupState).toBe("cleaned");
      expect(quota).toBe(bytes.length);
      expect(fs.readdirSync(source)).toEqual(["unknown"]);
      expect(store.begin).not.toHaveBeenCalled();
      await run();
      expect(quota).toBe(bytes.length);
      expect(store.commit).toHaveBeenCalledTimes(state === "committed" ? 0 : 1);
    },
  );
  it.each([
    "before verified",
    "after verified",
    "before publishing",
    "after publishing",
    "before rename",
    "after rename",
    "sync final",
    "before published",
    "after published",
    "before commit",
    "after commit",
    "before unlink 0",
    "after unlink 0",
    "before unlink 1",
    "after unlink 1",
    "sync source",
    "before cleaned",
    "after cleaned",
  ])(
    "fault at %s closes then a fresh restart safely completes",
    async (point) => {
      seed("assembling", "partial");
      fault = point;
      await expect(run()).rejects.toThrow();
      expect(events.at(-1)).toBe("close");
      const removedBeforeCommit =
        operation.state !== "committed" && fs.readdirSync(source).length !== 2;
      expect(removedBeforeCommit).toBe(false);
      fault = undefined;
      await run();
      expect(operation.cleanupState).toBe("cleaned");
      expect(quota).toBe(bytes.length);
      expect(fs.readdirSync(source)).toEqual([]);
      expect(hash(fs.readFileSync(operation.binding.storagePath))).toBe(
        hash(bytes),
      );
    },
  );
  it("retains an exclusive object when target checkpoint response is unknown", async () => {
    seed("assembling", "none");
    fault = "record target";
    await expect(run()).rejects.toThrow("record target");
    fault = undefined;
    await expect(run()).rejects.toThrow("journal-owned");
    expect(fs.existsSync(operation.binding.temporaryPath)).toBe(true);
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    expect(quota).toBe(0);
  });
  it("recovers after a durable target checkpoint response is lost", async () => {
    seed("assembling", "none");
    fault = "after target checkpoint";
    await expect(run()).rejects.toThrow("after target checkpoint");
    expect(operation.targetIdentity).not.toBeNull();
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    fault = undefined;
    await run();
    expect(operation.cleanupState).toBe("cleaned");
    expect(quota).toBe(bytes.length);
  });
  it.each(["published", "committed"] as const)(
    "HDD outage in %s retains SSD, metadata and barrier",
    async (state) => {
      seed(state, "final");
      fault = "sync final";
      await expect(run()).rejects.toThrow();
      expect(fs.readdirSync(source)).toEqual(["0", "1"]);
      expect(operation.cleanupState).toBe("pending");
      expect(quota).toBe(state === "committed" ? bytes.length : 0);
      fault = undefined;
      await run();
      expect(operation.cleanupState).toBe("cleaned");
    },
  );
  it("SSD outage retains durable HDD and allows existing HDD bytes to be read", async () => {
    seed("committed", "final");
    fault = "reopen";
    await expect(run()).rejects.toThrow();
    expect(hash(fs.readFileSync(operation.binding.storagePath))).toBe(
      hash(bytes),
    );
    expect(operation.cleanupState).toBe("pending");
  });
  it("refuses a live worker and can restart only after the lock is released", async () => {
    seed("published", "final");
    preserveLock = true;
    await expect(run()).rejects.toThrow("Live worker");
    expect(quota).toBe(0);
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    preserveLock = false;
    await run();
    expect(quota).toBe(bytes.length);
  });
  it.each([
    "wrong bytes",
    "same bytes wrong inode",
    "two names",
    "missing target",
    "no publication intent",
  ])("fails closed for %s before deleting", async (scenario) => {
    seed("published", "final");
    if (scenario === "wrong bytes")
      fs.writeFileSync(
        operation.binding.storagePath,
        Buffer.alloc(bytes.length, 19),
      );
    if (scenario === "same bytes wrong inode") {
      fs.renameSync(
        operation.binding.storagePath,
        operation.binding.storagePath + ".owned",
      );
      fs.writeFileSync(operation.binding.storagePath, bytes, { mode: 0o600 });
    }
    if (scenario === "two names")
      fs.writeFileSync(operation.binding.temporaryPath, bytes, { mode: 0o600 });
    if (scenario === "missing target")
      fs.renameSync(
        operation.binding.storagePath,
        operation.binding.storagePath + ".owned",
      );
    if (scenario === "no publication intent") operation.state = "verified";
    await expect(run()).rejects.toThrow();
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    expect(quota).toBe(0);
    expect(operation.cleanupState).toBe("pending");
  });
  it("preflights a corrupt last chunk without deleting the earlier valid source", async () => {
    seed("committed", "final");
    fs.writeFileSync(chunkPath(1), Buffer.alloc(parts[1].byteSize, 2));
    await expect(run()).rejects.toThrow("integrity");
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    expect(operation.cleanupState).toBe("pending");
    expect(quota).toBe(bytes.length);
  });
  it("uses a fully synced assembling HDD temporary when an SSD chunk is missing", async () => {
    seed("assembling", "temporary");
    fs.unlinkSync(chunkPath(1));
    await run();
    expect(hash(fs.readFileSync(operation.binding.storagePath))).toBe(
      hash(bytes),
    );
    expect(events).not.toContain("reset");
    expect(quota).toBe(bytes.length);
  });
  it("preserves a fully synced assembling HDD copy when an SSD chunk is corrupt", async () => {
    seed("assembling", "temporary");
    fs.writeFileSync(chunkPath(1), Buffer.alloc(parts[1].byteSize, 7));
    await expect(run()).rejects.toThrow("integrity");
    expect(hash(fs.readFileSync(operation.binding.storagePath))).toBe(
      hash(bytes),
    );
    expect(events).not.toContain("reset");
    expect(quota).toBe(bytes.length);
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
  });
  it.each(["missing", "corrupt"])(
    "preserves a partial HDD temporary before reset when SSD is %s",
    async (scenario) => {
      seed("assembling", "partial");
      const before = fs.readFileSync(operation.binding.temporaryPath);
      if (scenario === "missing") fs.unlinkSync(chunkPath(1));
      else fs.writeFileSync(chunkPath(1), Buffer.alloc(parts[1].byteSize, 7));
      await expect(run()).rejects.toThrow();
      expect(fs.readFileSync(operation.binding.temporaryPath)).toEqual(before);
      expect(events).not.toContain("reset");
      expect(quota).toBe(0);
    },
  );
  it("accepts a known chunk already absent after interrupted cleanup", async () => {
    seed("committed", "final");
    fs.unlinkSync(chunkPath(0));
    await run();
    expect(fs.readdirSync(source)).toEqual([]);
    expect(quota).toBe(bytes.length);
  });
  it("requires authoritative DB outcome and preserves all source on lookup outage", async () => {
    seed("committed", "final");
    fault = "lookup";
    await expect(run()).rejects.toThrow();
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
    fault = undefined;
    file = null;
    await expect(run()).rejects.toThrow("Authoritative");
    expect(fs.readdirSync(source)).toEqual(["0", "1"]);
  });
  it("repeated cleaned replay tolerates subsequent ordinary File/session lifecycle", async () => {
    seed("committed", "final");
    await run();
    file = null;
    fault = "reopen";
    await expect(run()).resolves.toBeNull();
    expect(quota).toBe(bytes.length);
  });
  it("keeps reads and verification buffers within 64KiB during replay", async () => {
    seed("assembling", "partial");
    const alloc = jest.spyOn(Buffer, "allocUnsafe");
    await run();
    expect(
      Math.max(...alloc.mock.calls.map((call) => call[0])),
    ).toBeLessThanOrEqual(FINALIZER_BUFFER_BYTES);
  });
  it("releases the process slot after failure and rejects overlapping recovery", async () => {
    seed("published", "final");
    const original = store.lookup;
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    store.lookup = jest.fn(async (value) => {
      await pause;
      return original(value);
    });
    const first = run();
    await expect(run()).rejects.toThrow("busy");
    release();
    await first;
    await expect(run()).resolves.toMatchObject({ id: 5 });
  });
  it("runs a paginated pending sweep once and reports fail-closed results without retry loops", async () => {
    seed("published", "final");
    fault = "lookup";
    const results = [];
    for await (const result of recoverPendingSsdFinalizations(
      store,
      filesystem,
    ))
      results.push(result);
    expect(results).toEqual([{ id, recovered: false }]);
    expect(store.lookup).toHaveBeenCalledTimes(1);
    fault = undefined;
    for await (const result of recoverPendingSsdFinalizations(
      store,
      filesystem,
    ))
      expect(result.recovered).toBe(true);
    expect(quota).toBe(bytes.length);
  });
});
