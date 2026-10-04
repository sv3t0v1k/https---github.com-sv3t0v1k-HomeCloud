import { ConfigService } from "@nestjs/config";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadsService } from "./uploads.service";
import * as fs from "fs";

const mutableFs = jest.requireActual<typeof import("fs")>("fs");

describe("large upload operation complexity", () => {
  afterEach(() => jest.restoreAllMocks());

  it("5120 synthetic chunks need constant filesystem probes and compact session writes at every index", async () => {
    const records = new Map<number, { byteSize: number; sha256: string }>();
    const disk = new Map<string, number>();
    const session = Object.assign(new UploadSessionEntity(), {
      id: 7,
      uploadId: "synthetic",
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
      { getTempPath: () => "/synthetic" } as never,
      {} as never,
      new ConfigService({
        MAX_FILE_SIZE: 0,
        MAX_TOTAL_SIZE: 0,
        MAX_CHUNK_SIZE: 1,
      }),
    );
    let probes = 0;
    const notFound = () =>
      Object.assign(new Error("missing"), { code: "ENOENT" });
    jest.spyOn(mutableFs, "existsSync").mockImplementation((target) => {
      probes++;
      return disk.has(String(target));
    });
    jest.spyOn(mutableFs, "statSync").mockImplementation(((target: string) => {
      probes++;
      return { size: disk.get(String(target)) || 0 };
    }) as never);
    jest.spyOn(fs.promises, "lstat").mockImplementation(async (target) => {
      probes++;
      if (!disk.has(String(target))) throw notFound();
      return {
        size: disk.get(String(target)),
        isFile: () => true,
        isSymbolicLink: () => false,
      } as never;
    });
    jest
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(async (target, data) => {
        disk.set(String(target), (data as Buffer).length);
      });
    jest
      .spyOn(fs.promises, "open")
      .mockResolvedValue({
        sync: async () => {},
        close: async () => {},
      } as never);
    jest.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      disk.set(String(to), disk.get(String(from))!);
      disk.delete(String(from));
    });
    jest.spyOn(mutableFs, "renameSync").mockImplementation((from, to) => {
      disk.set(String(to), disk.get(String(from))!);
      disk.delete(String(from));
    });
    for (let index = 0; index < 5120; index++) {
      const before = probes;
      await service.uploadChunk(1, session.uploadId, index, Buffer.from("a"));
      // Old implementation probes totalChunks even for the FIRST request.
      expect(probes - before).toBeLessThanOrEqual(3);
    }
    expect(probes).toBe(5120);
    expect(session.uploadedCount).toBe(5120);
    expect(session.uploadedSize).toBe(5120);
    expect(records.size).toBe(5120);
    expect(chunkRepository.findOne).toHaveBeenCalledTimes(5120);
    expect(chunkRepository.insert).toHaveBeenCalledTimes(5120);
    expect(manager.save).toHaveBeenCalledTimes(5120);
  }, 30000);
});
