import fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { FileEntity } from "../entities/file.entity";
import {
  FINALIZER_BUFFER_BYTES,
  SsdCrossFsFinalizer,
} from "./ssd-cross-fs-finalizer";
import {
  FinalizationBinding,
  FinalizationChunk,
  FinalizationFilesystem,
  FinalizationOperation,
  FinalizationStore,
} from "./ssd-finalization-contract";

const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const uploadId = "12345678-1234-4234-8234-123456789abc";
describe("isolated cross-FS finalizer portable orchestration contract", () => {
  let root: string,
    source: string,
    target: string,
    binding: FinalizationBinding;
  let parts: FinalizationChunk[],
    totalSize: number,
    chunkSize: number,
    whole: string;
  let events: string[], state: string, operation: FinalizationOperation;
  let store: FinalizationStore, filesystem: FinalizationFilesystem;
  let fault: string | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-finalizer-contract-"));
    source = path.join(root, "source");
    target = path.join(root, "target");
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    events = [];
    state = "";
    fault = undefined;
    fixture(3, 128 * 1024);
    store = {
      begin: jest.fn(async (input) => {
        events.push("begin");
        state = "assembling";
        operation = {
          ...input,
          sessionId: 1,
          filename: "binary.bin",
          parentId: null,
          totalSize,
          chunkSize,
          totalChunks: parts.length,
        };
        if (fault === "begin") throw new Error("begin failure");
        return operation;
      }),
      chunks: async function* () {
        for (const part of parts) yield part;
      },
      transition: jest.fn(async (_id, from, to) => {
        if (state !== from) throw new Error("test state mismatch");
        events.push(to);
        if (fault === to) throw new Error(`${to} failure`);
        state = to;
      }),
      commit: jest.fn(async () => {
        events.push("commit");
        if (state !== "published")
          throw new Error("test publication state mismatch");
        if (fault === "commit") throw new Error("ambiguous commit");
        state = "committed";
        return Object.assign(new FileEntity(), {
          id: 1,
          size: totalSize,
          checksum: whole,
        });
      }),
    };
    // Test double exercises real bounded streams, with no production portable fallback.
    filesystem = {
      prepare: (_user, _upload, id) => {
        binding = {
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
        };
        return binding;
      },
      assertBinding: jest.fn(() => {
        if (fault === "binding") throw new Error("binding changed");
      }),
      openChunk: (_binding, index) =>
        fs.openSync(path.join(source, String(index)), "r"),
      createTemporary: (value) => {
        events.push("create");
        return fs.openSync(value.temporaryPath, "wx", 0o600);
      },
      publish: (value) => {
        events.push("publish");
        if (fault === "publish") throw new Error("publication failure");
        // Portable contract only. Production uses native RENAME_NOREPLACE.
        if (fs.existsSync(value.storagePath))
          throw new Error("destination exists");
        fs.renameSync(value.temporaryPath, value.storagePath);
      },
      close: jest.fn(),
    };
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function fixture(count: number, size: number) {
    parts = [];
    totalSize = 0;
    chunkSize = size;
    const digest = createHash("sha256");
    for (let i = 0; i < count; i++) {
      const bytes = Buffer.alloc(i === count - 1 ? size - 1 : size, i % 251);
      fs.writeFileSync(path.join(source, String(i)), bytes);
      parts.push({
        chunkIndex: i,
        byteSize: bytes.length,
        sha256: hash(bytes),
      });
      digest.update(bytes);
      totalSize += bytes.length;
    }
    whole = digest.digest("hex");
  }
  const run = () =>
    new SsdCrossFsFinalizer(store, filesystem).finalize({
      userId: 1,
      uploadId,
      expectedSha256: whole,
    });
  it("validates each part and whole bytes, fsyncs before verified, publishes before DB commit and retains source", async () => {
    const realSync = fs.fsync.bind(fs);
    jest.spyOn(fs, "fsync").mockImplementation((fd, callback) => {
      events.push("fsync");
      realSync(fd, callback);
    });
    const file = await run();
    expect(file.checksum).toBe(whole);
    expect(hash(fs.readFileSync(binding.storagePath))).toBe(whole);
    expect(events).toEqual([
      "begin",
      "create",
      "fsync",
      "verified",
      "publishing",
      "publish",
      "published",
      "commit",
    ]);
    expect(fs.readdirSync(source)).toHaveLength(3);
    expect(filesystem.close).toHaveBeenCalledTimes(1);
    expect(fs.statSync(binding.storagePath).mode & 0o777).toBe(0o600);
  });
  it.each([
    "begin",
    "binding",
    "verified",
    "publishing",
    "publish",
    "published",
    "commit",
  ])("retains sources and never commits through %s failure", async (point) => {
    fault = point;
    await expect(run()).rejects.toThrow();
    expect(fs.readdirSync(source)).toHaveLength(3);
    expect(jest.mocked(store.commit).mock.calls.length).toBe(
      point === "commit" ? 1 : 0,
    );
    expect(fs.existsSync(binding.storagePath)).toBe(
      ["published", "commit"].includes(point),
    );
  });
  it("retains incomplete HDD assembly on fsync error without publication or destructive compensation", async () => {
    jest
      .spyOn(fs, "fsync")
      .mockImplementation((_fd, cb) => cb(new Error("sync fail")));
    await expect(run()).rejects.toThrow("sync fail");
    expect(state).toBe("assembling");
    expect(fs.existsSync(binding.temporaryPath)).toBe(true);
    expect(events).not.toContain("publish");
  });
  it.each([
    "gap",
    "missing",
    "extra",
    "badSize",
    "badHash",
    "corrupt",
    "truncate",
    "whole",
  ])("fails closed for %s integrity failure", async (failure) => {
    if (failure === "gap") parts[1].chunkIndex = 2;
    if (failure === "missing")
      store.chunks = async function* () {
        yield parts[0];
      };
    if (failure === "extra")
      store.chunks = async function* () {
        yield* parts;
        yield parts[0];
      };
    if (failure === "badSize") parts[0].byteSize--;
    if (failure === "badHash") parts[0].sha256 = "not a hash";
    if (failure === "corrupt")
      fs.writeFileSync(path.join(source, "0"), Buffer.alloc(chunkSize, 254));
    if (failure === "truncate") fs.truncateSync(path.join(source, "0"), 2);
    if (failure === "whole") whole = "f".repeat(64);
    await expect(run()).rejects.toThrow();
    expect(events).not.toContain("publish");
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("rejects process-wide overlapping finalizers without waiting or opening another target", async () => {
    let release!: () => void;
    const begin = store.begin;
    store.begin = async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return begin(input);
    };
    const pending = run();
    await expect(run()).rejects.toThrow("busy");
    release();
    await pending;
  });
  it("bounds writable buffering under slow output independently of file size", async () => {
    fixture(128, 256 * 1024);
    const realWrite = fs.write.bind(fs);
    let maximum = 0,
      inFlight = 0,
      maximumInFlight = 0;
    jest.spyOn(fs, "write").mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
      callback: (error: Error | null, count: number, buffer: Buffer) => void,
    ) => {
      maximum = Math.max(maximum, length);
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      setTimeout(
        () =>
          realWrite(
            fd,
            buffer,
            offset,
            length,
            position,
            (error, count, value) => {
              inFlight--;
              callback(error, count, value);
            },
          ),
        1,
      );
    }) as typeof fs.write);
    await run();
    expect(maximumInFlight).toBe(1);
    expect(maximum).toBeGreaterThan(0);
    expect(maximum).toBeLessThanOrEqual(FINALIZER_BUFFER_BYTES);
    expect(fs.statSync(binding.storagePath).size).toBe(totalSize);
  });
  it("handles short writes without reusing or losing bytes", async () => {
    const realWrite = fs.write.bind(fs);
    jest
      .spyOn(fs, "write")
      .mockImplementation(((
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
        callback: (error: Error | null, count: number, buffer: Buffer) => void,
      ) =>
        realWrite(
          fd,
          buffer,
          offset,
          Math.min(length, 4096),
          position,
          callback,
        )) as typeof fs.write);
    await run();
    expect(hash(fs.readFileSync(binding.storagePath))).toBe(whole);
  });
  it("retains bytes and closes capability on output I/O failure", async () => {
    jest
      .spyOn(fs, "write")
      .mockImplementation(((
        _fd: number,
        _buffer: Buffer,
        _offset: number,
        _length: number,
        _position: null,
        callback: (error: Error) => void,
      ) => callback(new Error("write failure"))) as typeof fs.write);
    await expect(run()).rejects.toThrow("write failure");
    expect(store.commit).not.toHaveBeenCalled();
    expect(filesystem.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(binding.temporaryPath)).toBe(true);
  });
  it("keeps pipeline listeners bounded across hundreds of chunks", async () => {
    fixture(700, 1024);
    const warnings: Error[] = [];
    const listener = (warning: Error) => warnings.push(warning);
    process.on("warning", listener);
    try {
      await run();
      expect(
        warnings.filter((w) => w.name === "MaxListenersExceededWarning"),
      ).toEqual([]);
    } finally {
      process.off("warning", listener);
    }
  });
});
