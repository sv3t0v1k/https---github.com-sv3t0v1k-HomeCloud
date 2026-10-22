import { LEGACY_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { ConfigService } from "@nestjs/config";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadsService } from "./uploads.service";
import { SecureFilesystem } from "./secure-filesystem";

const mutableFs = jest.requireActual<typeof import("fs")>("fs");

describe("large upload operation complexity", () => {
  afterEach(() => jest.restoreAllMocks());

  it("5120 synthetic chunks need constant filesystem probes and compact session writes at every index", async () => {
    const records = new Map<number, { byteSize: number; sha256: string }>();
    const disk = new Map<string, { size: number; ino: number; bytes: Buffer }>();
    const session = Object.assign(new UploadSessionEntity(), {
      id: 7,
      uploadId: "synthetic",
      workspaceId: LEGACY_UPLOAD_WORKSPACE.id,
      userId: 1,
      filename: "synthetic.bin",
      totalSize: 5120,
      chunkSize: 1,
      totalChunks: 5120,
      uploadedSize: 0,
      uploadedCount: 0,
      accountingInitialized: true,
      uploadedChunks: [],
      tempPath: "/synthetic/session",
      status: "pending",
      expiresAt: null,
    });
    const chunkRepository = {
      findOne: jest.fn(
        async ({ where }: { where: { chunkIndex: number } }) =>
          records.get(where.chunkIndex) || null,
      ),
      insert: jest.fn(
        async (row: {
          chunkIndex: number;
          byteSize: number;
          sha256: string;
        }) => {
          records.set(row.chunkIndex, row);
        },
      ),
    };
    const manager = {
      query: jest.fn(async () => [{ locked: true }]),
      findOne: jest.fn(async () => session),
      getRepository: jest.fn(() => chunkRepository),
      save: jest.fn(async (value: UploadSessionEntity) => {
        expect(value.uploadedChunks).toEqual([]);
        return value;
      }),
    };
    const queryRunner = {
      manager,
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
    };
    const repository = {
      manager: { connection: { createQueryRunner: () => queryRunner } },
    };
    const service = new UploadsService(
      repository as never,
      {} as never,
      {} as never,
      { assertTemporaryPath: jest.fn((target: string) => target), assertTrustedPath: jest.fn((target: string) => target), getTempPath: () => "/synthetic" } as never,
      {} as never,
      new ConfigService({
        MAX_FILE_SIZE: 0,
        MAX_TOTAL_SIZE: 0,
        MAX_CHUNK_SIZE: 1,
      }),
    );
    // Keep the 5120-chunk complexity measurement isolated from filesystem
    // identity probes; focused workspace tests validate that boundary.
    jest.spyOn(service as any, "resolveSessionWorkspace").mockResolvedValue(session.tempPath);
    const resolver = (service as any).workspaceResolver;
    jest.spyOn(resolver, "root").mockReturnValue("/synthetic");
    jest.spyOn(resolver, "assertPath").mockImplementation((target: unknown) => target);
    let probes = 0;
    const notFound = () =>
      Object.assign(new Error("missing"), { code: "ENOENT" });
    // Synthetic FD identities preserve the same inode across rename and count
    // both the existence probe and the publication identity verification.
    const descriptors = new Map<number, { size: number; ino: number; bytes: Buffer }>();
    let nextDescriptor = 10000;
    let nextInode = 1;
    const stats = (entry: { size: number; ino: number; bytes: Buffer }) => ({
      ...entry, dev: 1, isFile: () => true, isSymbolicLink: () => false,
    });
    const boundary = {
      stat: (target: string) => {
        probes++;
        const entry = disk.get(target);
        if (!entry) throw notFound();
        return stats(entry);
      },
      open: (target: string, mode: "r" | "rw" | "wx" = "r") => {
        let entry = disk.get(target);
        if (mode === "wx") {
          if (entry) throw Object.assign(new Error("exists"), { code: "EEXIST" });
          entry = { size: 0, ino: nextInode++, bytes: Buffer.alloc(0) };
          disk.set(target, entry);
        } else {
          probes++;
          if (!entry) throw notFound();
        }
        const fd = nextDescriptor++;
        descriptors.set(fd, entry);
        return fd;
      },
      sync: () => undefined,
      rename: (from: string, to: string) => {
        disk.set(to, disk.get(from)!);
        disk.delete(from);
      },
      remove: (target: string) => { disk.delete(target); },
    };
    jest.spyOn(resolver, "filesystem").mockReturnValue(boundary as unknown as SecureFilesystem);
    jest.spyOn(mutableFs, "fstatSync").mockImplementation(((fd: number) => {
      const entry = descriptors.get(fd);
      if (!entry) throw new Error("Invalid synthetic descriptor");
      return stats(entry);
    }) as never);
    jest.spyOn(mutableFs, "closeSync").mockImplementation((fd: number) => {
      if (!descriptors.delete(fd)) throw new Error("Synthetic descriptor already closed");
    });
    jest.spyOn(mutableFs, "writeFile").mockImplementation(((fd: number, data: Buffer, callback: (error: Error | null) => void) => {
      const entry = descriptors.get(fd);
      if (!entry) return callback(new Error("Invalid synthetic write descriptor"));
      entry.bytes = Buffer.from(data);
      entry.size = data.length;
      callback(null);
    }) as never);
    jest.spyOn(mutableFs, "fsync").mockImplementation((fd: number, callback: (error: Error | null) => void) => {
      callback(descriptors.has(fd) ? null : new Error("Invalid synthetic sync descriptor"));
    });
    jest.spyOn(mutableFs, "read").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | null, bytesRead: number, buffer: Buffer) => void) => {
      const entry = descriptors.get(fd);
      if (!entry) return callback(new Error("Invalid synthetic read descriptor"), 0, buffer);
      const bytesRead = entry.bytes.copy(buffer, offset, position, position + length);
      callback(null, bytesRead, buffer);
    }) as never);
    for (let index = 0; index < 5120; index++) {
      const before = probes;
      await service.uploadChunk(1, session.uploadId, index, Buffer.from("a"));
      // Old implementation probes totalChunks even for the FIRST request.
      expect(probes - before).toBeLessThanOrEqual(3);
      expect(descriptors.size).toBe(0);
    }
    expect(probes).toBe(2 * 5120);
    expect(descriptors.size).toBe(0);
    expect(session.uploadedCount).toBe(5120);
    expect(session.uploadedSize).toBe(5120);
    expect(records.size).toBe(5120);
    expect(chunkRepository.findOne).toHaveBeenCalledTimes(5120);
    expect(chunkRepository.insert).toHaveBeenCalledTimes(5120);
    expect(manager.save).toHaveBeenCalledTimes(5120);
    // An exact retry hashes and syncs the retained descriptor without another
    // insertion, quota increment, or descriptor leak.
    const beforeRetry = probes;
    await service.uploadChunk(1, session.uploadId, 5119, Buffer.from("a"));
    expect(probes - beforeRetry).toBeLessThanOrEqual(3);
    expect(descriptors.size).toBe(0);
    expect(session.uploadedCount).toBe(5120);
    expect(session.uploadedSize).toBe(5120);
    expect(chunkRepository.insert).toHaveBeenCalledTimes(5120);
    expect(manager.save).toHaveBeenCalledTimes(5121);
  }, 30000);
});
