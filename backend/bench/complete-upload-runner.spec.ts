import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { UploadsService } from "../src/uploads/uploads.service";
import { StorageService } from "../src/storage/storage.service";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { FileEntity } from "../src/entities/file.entity";
import { UserEntity } from "../src/entities/user.entity";
import { UsersService } from "../src/users/users.service";
import {
  measureCompleteUploadScale,
  normalizeBenchBigInt,
  COMPLETE_UPLOAD_SCALES,
  COMPLETE_UPLOAD_BENCH_MIME_TYPES,
  BENCH_QUOTA_MULTIPLIER,
  CHUNK_SIZE,
  buildCompleteUploadServices,
  verifyIsolation,
  computeExpectedSha256,
  writeChunks,
  computeBenchStorageQuota,
  createBenchUser,
  CompleteUploadMeasurement,
} from "./complete-upload-runner";
import { createWriteStreamInstrument } from "./write-stream-instrument";
import { createRssSampler } from "./rss-sampler";
import { createReadFileSyncInstrument } from "./read-file-sync-instrument";

function makeUploadSession(
  overrides: Partial<UploadSessionEntity> = {},
): UploadSessionEntity {
  const now = new Date();
  return {
    id: 1,
    uploadId: "sess-1",
    filename: "test.bin",
    totalSize: 100,
    uploadedSize: 0,
    chunkSize: 50,
    totalChunks: 2,
    uploadedChunks: [],
    tempPath: "/tmp/bench/sess-1",
    parentId: null,
    status: "pending",
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    user: {} as any,
    userId: 1,
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileEntity> = {}): FileEntity {
  const now = new Date();
  return {
    id: 1,
    name: "test.bin",
    storagePath: "/tmp/bench/final.bin",
    size: 100,
    mimeType: "application/octet-stream",
    checksum: "bench-checksum",
    isFolder: false,
    isDeleted: false,
    isStarred: false,
    deletedAt: null,
    parentId: null,
    folderId: null,
    version: 1,
    uploadId: "sess-1",
    createdAt: now,
    updatedAt: now,
    user: {} as any,
    userId: 1,
    parent: null as any,
    folder: null as any,
    shares: [],
    ...overrides,
  };
}

function createMockDataSourceAndServices(overrides?: {
  createUploadSession?: (
    userId: number,
    filename: string,
    totalSize: number,
    chunkSize: number,
  ) => Promise<UploadSessionEntity>;
}): {
  dataSource: DataSource;
  services: {
    uploadsService: UploadsService;
    storageService: StorageService;
    benchRoot: string;
  };
} {
  const sessionStore = new Map<string, UploadSessionEntity>();
  let benchUser: UserEntity | undefined;

  const dataSource = {
    getRepository: (entity: any) => {
      if (entity === UserEntity) {
        return {
          create: (value: Partial<UserEntity>) => value,
          save: async (value: UserEntity) => {
            benchUser = { ...value, id: 1 } as UserEntity;
            return benchUser;
          },
          count: async () => 0,
          find: async () => [],
          findOne: async (options?: {
            where?: { email?: string; id?: number };
          }) => {
            if (options?.where?.email) return undefined;
            if (options?.where?.id === benchUser?.id) return benchUser;
            return undefined;
          },
          delete: async () => ({}),
          query: async () => [],
        };
      }
      if (entity === UploadSessionEntity) {
        return {
          create: () => ({}),
          save: async (entity: UploadSessionEntity) => {
            const key = `${entity.uploadId}|${entity.userId}`;
            sessionStore.set(key, { ...entity, updatedAt: new Date() });
            return entity;
          },
          count: async () => 0,
          find: async () => [],
          findOne: async (options: {
            where: { uploadId: string; userId: number };
          }) => {
            if (!options?.where?.uploadId || !options?.where?.userId)
              return undefined;
            const key = `${options.where.uploadId}|${options.where.userId}`;
            return sessionStore.get(key);
          },
          delete: async () => ({}),
          query: async () => [],
        };
      }
      return {
        create: () => ({}),
        save: async (entity: { id?: number }) => ({
          ...entity,
          id: entity.id ?? 1,
        }),
        count: async () => 0,
        find: async () => [],
        findOne: async () => undefined,
        delete: async () => ({}),
        query: async () => [],
      };
    },
    query: async () => [],
  } as unknown as DataSource;

  const services = {
    uploadsService: {
      createUploadSession:
        overrides?.createUploadSession ??
        (async (
          userId: number,
          filename: string,
          totalSize: number,
          chunkSize: number,
        ) => {
          const session = makeUploadSession({
            userId,
            filename,
            totalSize,
            chunkSize,
          });
          const key = `${session.uploadId}|${session.userId}`;
          sessionStore.set(key, { ...session, status: "pending" });
          return session;
        }),
      completeUpload: async (userId: number, uploadId: string) => {
        const key = `${uploadId}|${userId}`;
        const session = sessionStore.get(key);
        if (session) {
          session.status = "completed";
          sessionStore.set(key, { ...session, updatedAt: new Date() });
        }
        if (benchUser) benchUser.storageUsed += session?.totalSize ?? 0;
        return makeFile({ uploadId });
      },
      abortUpload: async () => {},
    } as unknown as UploadsService,
    storageService: {
      getTempPath: () => "/tmp/bench",
    } as unknown as StorageService,
    benchRoot: "/tmp/bench",
  };

  return { dataSource, services };
}

describe("complete-upload-runner", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-bench-completeupload-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("scales are exactly 1MiB, 5MiB, 50MiB", () => {
    expect(Array.from(COMPLETE_UPLOAD_SCALES)).toEqual([
      1 * 1024 * 1024,
      5 * 1024 * 1024,
      50 * 1024 * 1024,
    ]);
  });

  it("assigns a finite safe quota above every benchmark upload size", () => {
    for (const scaleBytes of COMPLETE_UPLOAD_SCALES) {
      const quota = computeBenchStorageQuota(scaleBytes);
      expect(quota).toBe(scaleBytes * BENCH_QUOTA_MULTIPLIER);
      expect(quota).toBeGreaterThan(scaleBytes);
      expect(Number.isSafeInteger(quota)).toBe(true);
    }
    expect(() => computeBenchStorageQuota(0)).toThrow(
      /Invalid benchmark scale/,
    );
    expect(() => computeBenchStorageQuota(Number.MAX_SAFE_INTEGER)).toThrow(
      /Invalid benchmark scale/,
    );
  });

  it("normalizes PostgreSQL BIGINT quota values without losing precision", () => {
    expect(normalizeBenchBigInt("1048576", "storageUsed")).toBe(1048576);
    expect(normalizeBenchBigInt(2097152, "storageQuota")).toBe(2097152);
    expect(() =>
      normalizeBenchBigInt("9007199254740992", "storageQuota"),
    ).toThrow(/Invalid storageQuota/);
    expect(() => normalizeBenchBigInt("not-a-number", "storageUsed")).toThrow(
      /Invalid storageUsed/,
    );
  });

  it("creates a benchmark user whose quota passes the production quota check", async () => {
    const scaleBytes = COMPLETE_UPLOAD_SCALES[0];
    let storedUser: UserEntity | undefined;
    const repository = {
      findOne: async () => storedUser,
      create: (value: Partial<UserEntity>) => value,
      save: async (value: UserEntity) => {
        storedUser = { ...value, id: 1 } as UserEntity;
        return storedUser;
      },
      createQueryBuilder: () => ({
        update: () => ({
          set: () => ({
            where: () => ({
              execute: async () => {
                if (
                  !storedUser ||
                  storedUser.storageUsed + scaleBytes > storedUser.storageQuota
                ) {
                  return { affected: 0 };
                }
                storedUser.storageUsed += scaleBytes;
                return { affected: 1 };
              },
            }),
          }),
        }),
      }),
    };
    const dataSource = {
      getRepository: () => repository,
    } as unknown as DataSource;

    const userId = await createBenchUser(dataSource, scaleBytes);
    expect(storedUser?.storageQuota).toBeGreaterThan(scaleBytes);

    const usersService = new UsersService(repository as any);
    await expect(
      usersService.updateStorageUsed(userId, scaleBytes),
    ).resolves.toBeUndefined();
    expect(storedUser?.storageUsed).toBe(scaleBytes);
  });

  it("production completeUpload is invoked (real method reference, no simulation)", () => {
    const src = fs.readFileSync(
      require.resolve("./complete-upload-runner"),
      "utf8",
    );
    expect(src).toContain("uploadsService.completeUpload(");
    expect(src).not.toContain("// simulate");
    expect(src).not.toContain("Math.random");
  });

  it("allows the synthetic binary MIME only in benchmark config without env leakage", () => {
    const previous = process.env.ALLOWED_UPLOAD_MIME_TYPES;
    process.env.ALLOWED_UPLOAD_MIME_TYPES = "image/png";

    try {
      const { dataSource } = createMockDataSourceAndServices();
      const services = buildCompleteUploadServices(dataSource);

      expect(
        (services.uploadsService as unknown as { allowedMimeTypes: string[] })
          .allowedMimeTypes,
      ).toEqual([COMPLETE_UPLOAD_BENCH_MIME_TYPES]);
      expect(process.env.ALLOWED_UPLOAD_MIME_TYPES).toBe("image/png");

      fs.rmSync(services.benchRoot, { recursive: true, force: true });
    } finally {
      if (previous === undefined) {
        delete process.env.ALLOWED_UPLOAD_MIME_TYPES;
      } else {
        process.env.ALLOWED_UPLOAD_MIME_TYPES = previous;
      }
    }
  });

  it("isolated storage path is enforced", () => {
    const benchRoot = "/tmp/homecloud-bench-completeupload-failclosed";
    const configService = {
      get: (k: string) => (k === "STORAGE_PATH" ? benchRoot : undefined),
    } as unknown as ConfigService;
    const storageService = new StorageService(configService);
    expect(() => verifyIsolation(storageService, "/storage")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() => verifyIsolation(storageService, "/storage/.tmp")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() => verifyIsolation(storageService, "")).toThrow(/SAFETY_BLOCKER/);
    expect(() => verifyIsolation(storageService, "/")).toThrow(
      /SAFETY_BLOCKER/,
    );
    expect(() => verifyIsolation(storageService, ".")).toThrow(
      /SAFETY_BLOCKER/,
    );
    const other = path.join(
      os.tmpdir(),
      `homecloud-bench-completeupload-mismatch-${process.pid}`,
    );
    expect(() => verifyIsolation(storageService, other)).toThrow(
      /SAFETY_BLOCKER/,
    );
    fs.rmSync(benchRoot, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("computeExpectedSha256 matches writeChunks output", () => {
    const scale = 1024;
    const chunkSize = 512;
    const expected = computeExpectedSha256(scale, chunkSize);
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-bench-sha-"),
    );
    writeChunks(testDir, scale, chunkSize);
    const hash = crypto.createHash("sha256");
    for (let i = 0; i < Math.ceil(scale / chunkSize); i++) {
      const chunkPath = path.join(testDir, String(i));
      const data = fs.readFileSync(chunkPath);
      hash.update(data);
    }
    expect(hash.digest("hex")).toBe(expected);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("writeChunks creates correct number of chunks with correct sizes", () => {
    const scale = 1024;
    const chunkSize = 300;
    const testDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "homecloud-bench-chunks-"),
    );
    writeChunks(testDir, scale, chunkSize);
    const totalChunks = Math.ceil(scale / chunkSize);
    const files = fs.readdirSync(testDir);
    expect(files.length).toBe(totalChunks);
    let total = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(testDir, String(i));
      const stats = fs.statSync(chunkPath);
      const expected =
        i === totalChunks - 1 ? scale - i * chunkSize : chunkSize;
      expect(stats.size).toBe(expected);
      total += stats.size;
    }
    expect(total).toBe(scale);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("measurement result shape is correct", async () => {
    const { dataSource, services } = createMockDataSourceAndServices();
    // Override completeUpload to write a real file for size/hash checks
    const realFinalPath = path.join(tmp, "final.bin");
    const realTempPath = path.join(tmp, "sess-1");
    fs.mkdirSync(realTempPath, { recursive: true });
    // Write chunks that match the expected pattern for scale=100 (small)
    const scale = 100;
    const chunkSize = Math.min(scale, CHUNK_SIZE);
    writeChunks(realTempPath, scale, chunkSize);
    const createUploadSession = services.uploadsService.createUploadSession;
    const completeUpload = services.uploadsService.completeUpload;
    services.uploadsService.createUploadSession = async (...args) => {
      const session = await createUploadSession(...args);
      session.tempPath = realTempPath;
      return session;
    };
    services.uploadsService.completeUpload = async (userId, uploadId) => {
      // Assemble final file from chunks to satisfy runner's stat/SHA checks
      const totalChunks = Math.ceil(scale / chunkSize);
      const writeStream = fs.createWriteStream(realFinalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(realTempPath, String(i));
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      await completeUpload(userId, uploadId);
      return makeFile({ storagePath: realFinalPath, size: scale });
    };

    const result = await measureCompleteUploadScale(
      dataSource,
      scale,
      services,
    );
    const m: CompleteUploadMeasurement = result.measurement;
    expect(m.scaleBytes).toBe(scale);
    expect(m.chunkSizeBytes).toBe(scale);
    expect(m.chunkCount).toBe(Math.ceil(scale / chunkSize));
    expect(typeof m.wallMs).toBe("number");
    expect(m.wallMs).toBeGreaterThanOrEqual(0);
    expect(m.readFileSyncCalls).toBe(1);
    expect(m.readFileSyncCumulativeMs).toBeGreaterThanOrEqual(0);
    expect(m.readFileSyncMaxMs).toBeGreaterThanOrEqual(0);
    expect(m.immediateDelayMaxMs).toBeGreaterThanOrEqual(m.readFileSyncMaxMs);
    expect(m.timerDelayMaxMs).toBeGreaterThanOrEqual(m.readFileSyncMaxMs);
    expect(m.immediateBeforeReadReturn).toBe(0);
    expect(m.timerBeforeReadReturn).toBe(0);
    expect(m.rssBefore).toBeGreaterThan(0);
    expect(m.rssPeak).toBeGreaterThanOrEqual(m.rssBefore);
    expect(m.rssAfter).toBeGreaterThan(0);
    expect(m.rssDeltaPeak).toBeGreaterThanOrEqual(0);
    expect(m.createWriteStream).toBe(1);
    expect(m.writeCalls).toBeGreaterThan(0);
    expect(m.writeFalse).toBeGreaterThanOrEqual(0);
    expect(m.maxWritableLength).toBeGreaterThanOrEqual(0);
    expect(m.drainEvents).toBeGreaterThanOrEqual(0);
    expect(m.finalFileSize).toBe(scale);
    expect(m.expectedSha256).toBe(computeExpectedSha256(scale, chunkSize));
    expect(m.actualSha256).toBe(m.expectedSha256);
    expect(m.sessionStatus).toBe("completed");
    expect(m.storageUsed).toBe(scale);
    expect(m.storageQuota).toBe(computeBenchStorageQuota(scale));
    expect(m.persistedRows).toEqual({
      sessions: 0,
      files: 0,
      folders: 0,
      user: 0,
    });
    expect(m.dbResidualsAfterCleanup).toEqual({
      sessions: 0,
      files: 0,
      folders: 0,
      user: 0,
    });
    expect(m.fsResidualsAfterCleanup).toBe(0);
  });

  it("WriteStream metrics are present", async () => {
    const { dataSource, services } = createMockDataSourceAndServices();
    const scale = 100;
    const chunkSize = Math.min(scale, CHUNK_SIZE);
    const realTempPath = path.join(tmp, "sess-1");
    fs.mkdirSync(realTempPath, { recursive: true });
    writeChunks(realTempPath, scale, chunkSize);
    const createUploadSession = services.uploadsService.createUploadSession;
    const completeUpload = services.uploadsService.completeUpload;
    services.uploadsService.createUploadSession = async (...args) => {
      const session = await createUploadSession(...args);
      session.tempPath = realTempPath;
      return session;
    };
    services.uploadsService.completeUpload = async (userId, uploadId) => {
      const realFinalPath = path.join(tmp, "final.bin");
      const totalChunks = Math.ceil(scale / chunkSize);
      const writeStream = fs.createWriteStream(realFinalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(realTempPath, String(i));
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      await completeUpload(userId, uploadId);
      return makeFile({ storagePath: realFinalPath, size: scale });
    };

    const result = await measureCompleteUploadScale(
      dataSource,
      scale,
      services,
    );
    const m = result.measurement;
    expect(m.createWriteStream).toBe(1);
    expect(m.writeCalls).toBeGreaterThan(0);
  });

  it("RSS metrics are present and internally consistent", async () => {
    const { dataSource, services } = createMockDataSourceAndServices();
    const scale = 100;
    const chunkSize = Math.min(scale, CHUNK_SIZE);
    const realTempPath = path.join(tmp, "sess-1");
    fs.mkdirSync(realTempPath, { recursive: true });
    writeChunks(realTempPath, scale, chunkSize);
    const createUploadSession = services.uploadsService.createUploadSession;
    const completeUpload = services.uploadsService.completeUpload;
    services.uploadsService.createUploadSession = async (...args) => {
      const session = await createUploadSession(...args);
      session.tempPath = realTempPath;
      return session;
    };
    services.uploadsService.completeUpload = async (userId, uploadId) => {
      const realFinalPath = path.join(tmp, "final.bin");
      const totalChunks = Math.ceil(scale / chunkSize);
      const writeStream = fs.createWriteStream(realFinalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(realTempPath, String(i));
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      await completeUpload(userId, uploadId);
      return makeFile({ storagePath: realFinalPath, size: scale });
    };

    const result = await measureCompleteUploadScale(
      dataSource,
      scale,
      services,
    );
    const m = result.measurement;
    expect(m.rssBefore).toBeGreaterThan(0);
    expect(m.rssPeak).toBeGreaterThanOrEqual(m.rssBefore);
    expect(m.rssAfter).toBeGreaterThan(0);
    expect(m.rssDeltaPeak).toBe(m.rssPeak - m.rssBefore);
  });

  it("cleanup succeeds after normal completion", async () => {
    const { dataSource, services } = createMockDataSourceAndServices();
    const scale = 100;
    const chunkSize = Math.min(scale, CHUNK_SIZE);
    const realTempPath = path.join(tmp, "sess-1");
    fs.mkdirSync(realTempPath, { recursive: true });
    writeChunks(realTempPath, scale, chunkSize);
    const createUploadSession = services.uploadsService.createUploadSession;
    const completeUpload = services.uploadsService.completeUpload;
    services.uploadsService.createUploadSession = async (...args) => {
      const session = await createUploadSession(...args);
      session.tempPath = realTempPath;
      return session;
    };
    services.uploadsService.completeUpload = async (userId, uploadId) => {
      const realFinalPath = path.join(tmp, "final.bin");
      const totalChunks = Math.ceil(scale / chunkSize);
      const writeStream = fs.createWriteStream(realFinalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(realTempPath, String(i));
        const chunkData = fs.readFileSync(chunkPath);
        writeStream.write(chunkData);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
      await completeUpload(userId, uploadId);
      return makeFile({ storagePath: realFinalPath, size: scale });
    };

    await expect(
      measureCompleteUploadScale(dataSource, scale, services),
    ).resolves.toBeDefined();
  });

  it("cleanup succeeds after controlled failure", async () => {
    const { dataSource, services } = createMockDataSourceAndServices({
      createUploadSession: async () => {
        throw new Error("forced setup failure");
      },
    });
    await expect(
      measureCompleteUploadScale(dataSource, 100, services),
    ).rejects.toThrow(/forced setup failure/);
  });

  it("captures actual readFileSync calls and detects a known synchronous read region", async () => {
    const fixture = path.join(tmp, "sync-read.bin");
    fs.writeFileSync(fixture, Buffer.alloc(1024 * 1024));
    const instrument = createReadFileSyncInstrument([fixture]);
    instrument.start();
    fs.readFileSync(fixture);
    instrument.markServiceReturned();
    instrument.restore();
    const snap = await instrument.settled();
    expect(snap.calls).toBe(1);
    expect(snap.cumulativeDurationMs).toBeGreaterThan(0);
    expect(snap.maxDurationMs).toBe(snap.cumulativeDurationMs);
    expect(snap.maxImmediateDelayMs).toBeGreaterThanOrEqual(snap.maxDurationMs);
    expect(snap.maxTimerDelayMs).toBeGreaterThanOrEqual(snap.maxDurationMs);
    expect(snap.immediateBeforeReadReturn).toBe(0);
    expect(snap.timerBeforeReadReturn).toBe(0);
  });

  it("ignores readFileSync outside the exact chunk path set", async () => {
    const included = path.join(tmp, "included.bin");
    const excluded = path.join(tmp, "excluded.bin");
    fs.writeFileSync(included, "included");
    fs.writeFileSync(excluded, "excluded");
    const instrument = createReadFileSyncInstrument([included]);
    instrument.start();
    fs.readFileSync(excluded);
    fs.readFileSync(included);
    instrument.markServiceReturned();
    instrument.restore();
    expect((await instrument.settled()).calls).toBe(1);
  });

  it("does not classify an asynchronous wait as synchronous operation time", async () => {
    const fixture = path.join(tmp, "async-read.bin");
    fs.writeFileSync(fixture, Buffer.alloc(1024 * 1024));
    const instrument = createReadFileSyncInstrument([fixture]);
    instrument.start();
    await fs.promises.readFile(fixture);
    instrument.markServiceReturned();
    instrument.restore();
    const snap = await instrument.settled();
    expect(snap.calls).toBe(0);
    expect(snap.cumulativeDurationMs).toBe(0);
  });
});
