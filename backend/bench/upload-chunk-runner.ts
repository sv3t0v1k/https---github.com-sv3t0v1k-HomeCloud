import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { UploadsService } from "../src/uploads/uploads.service";
import { StorageService } from "../src/storage/storage.service";
import { UsersService } from "../src/users/users.service";
import { createFsInstrument, FsInstrumentCounters } from "./fs-instrument";

export const UPLOAD_CHUNK_SCALES = [100, 1000, 5000] as const;

export interface UploadChunkServices {
  uploadsService: UploadsService;
  storageService: StorageService;
  benchRoot: string;
}

export interface UploadChunkMeasurement {
  scale: number;
  totalChunks: number;
  chunkIndex: number;
  chunkBytes: number;
  latencyMs: number;
  counters: FsInstrumentCounters;
  sessionStatus: string;
  uploadedChunks: number;
}

export interface UploadChunkRunResult {
  measurement: UploadChunkMeasurement;
  residualRows: Record<string, number>;
  residualFs: number;
}

function benchStoragePath(): string {
  const dir = path.join(
    os.tmpdir(),
    `homecloud-bench-uploadchunk-${process.pid}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function verifyIsolation(
  storageService: StorageService,
  expectedRoot: string,
): void {
  const resolved = path.resolve(storageService.getStoragePath());
  const expected = path.resolve(expectedRoot);
  const tempRoot = path.resolve(storageService.getTempPath());
  const dangerous = ["/storage", "/storage/.tmp", "", "/", "."];
  if (dangerous.includes(expected) || dangerous.includes(resolved)) {
    throw new Error(
      `SAFETY_BLOCKER: dangerous root expected=${expected} resolved=${resolved}`,
    );
  }
  if (resolved !== expected) {
    throw new Error(
      `SAFETY_BLOCKER: resolved ${resolved} != benchmark root ${expected}`,
    );
  }
  if (!tempRoot.startsWith(expected + path.sep) && tempRoot !== expected) {
    throw new Error(
      `SAFETY_BLOCKER: temp root ${tempRoot} not under ${expected}`,
    );
  }
}

export function buildUploadChunkServices(
  dataSource: DataSource,
): UploadChunkServices {
  const benchRoot = benchStoragePath();
  const prevStoragePath = process.env.STORAGE_PATH;
  delete process.env.STORAGE_PATH;
  try {
    const configService = new ConfigService({
      STORAGE_PATH: benchRoot,
      MAX_FILE_SIZE: 0,
      MAX_TOTAL_SIZE: 10 * 1024 * 1024 * 1024,
      MAX_CHUNK_SIZE: 50 * 1024 * 1024,
      UPLOAD_SESSION_TTL_HOURS: 24,
    });
    const storageService = new StorageService(configService);
    verifyIsolation(storageService, benchRoot);
    const uploadsService = new UploadsService(
      dataSource.getRepository(UploadSessionEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storageService,
      new UsersService(dataSource.getRepository(UserEntity)),
      configService,
    );
    return { uploadsService, storageService, benchRoot };
  } finally {
    if (prevStoragePath !== undefined) {
      process.env.STORAGE_PATH = prevStoragePath;
    }
  }
}

async function createBenchUser(dataSource: DataSource): Promise<number> {
  const repo = dataSource.getRepository(UserEntity);
  const existing = await repo.findOne({
    where: { email: "bench-uploadchunk@homecloud.local" },
  });
  if (existing) {
    throw new Error("Benchmark identity already exists; refusing to reuse.");
  }
  const user = repo.create({
    email: "bench-uploadchunk@homecloud.local",
    password: "bench-password-2026",
    name: "bench-uploadchunk",
    isActive: true,
    isEmailVerified: false,
    storageQuota: 0,
    storageUsed: 0,
  });
  const saved = await repo.save(user);
  return saved.id;
}

async function cleanupAll(dataSource: DataSource, userId: number): Promise<void> {
  await dataSource.query(`DELETE FROM share_links WHERE "userId" = $1`, [userId]);
  await dataSource.query(`DELETE FROM upload_sessions WHERE "userId" = $1`, [
    userId,
  ]);
  await dataSource.query(`DELETE FROM files WHERE "userId" = $1`, [userId]);
  await dataSource.query(`DELETE FROM folders WHERE "userId" = $1`, [userId]);
  await dataSource.getRepository(UserEntity).delete(userId);
}

async function countRows(
  dataSource: DataSource,
  userId: number,
): Promise<Record<string, number>> {
  const [sessions, files, folders, user] = await Promise.all([
    dataSource.getRepository(UploadSessionEntity).count({ where: { userId } }),
    dataSource.getRepository(FileEntity).count({ where: { userId } }),
    dataSource.getRepository(FolderEntity).count({ where: { userId } }),
    dataSource.getRepository(UserEntity).count({ where: { id: userId } }),
  ]);
  return { sessions, files, folders, user };
}

export async function measureUploadChunkScale(
  dataSource: DataSource,
  scale: number,
  services: UploadChunkServices = buildUploadChunkServices(dataSource),
): Promise<UploadChunkRunResult> {
  const { uploadsService, storageService, benchRoot } = services;
  const tempRoot = storageService.getTempPath();

  let userId: number | null = null;
  let uploadId: string | null = null;

  try {
    userId = await createBenchUser(dataSource);

    const chunkSize = 1;
    const totalSize = scale;
    const session = await uploadsService.createUploadSession(
      userId,
      `bench_${scale}.bin`,
      totalSize,
      chunkSize,
    );
    uploadId = session.uploadId;

    const chunkIndex = 0;
    const chunkData = Buffer.alloc(1, 0x41);

    const instrument = createFsInstrument();
    const start = process.hrtime.bigint();
    instrument.start();
    let measured: Awaited<ReturnType<UploadsService["uploadChunk"]>>;
    try {
      measured = await uploadsService.uploadChunk(
        userId,
        uploadId,
        chunkIndex,
        chunkData,
      );
    } finally {
      instrument.restore();
    }
    const end = process.hrtime.bigint();
    const latencyMs = Number(end - start) / 1e6;

    const measurement: UploadChunkMeasurement = {
      scale,
      totalChunks: scale,
      chunkIndex,
      chunkBytes: chunkData.length,
      latencyMs,
      counters: instrument.snapshot(),
      sessionStatus: measured.status,
      uploadedChunks: measured.uploadedCount,
    };

    const residualRows = await countRows(dataSource, userId);
    const residualFs = fs.existsSync(tempRoot)
      ? fs.readdirSync(tempRoot).length
      : 0;

    return { measurement, residualRows, residualFs };
  } finally {
    if (uploadId && userId) {
      try {
        await uploadsService.abortUpload(userId, uploadId);
      } catch {
        /* best-effort */
      }
    }
    if (userId) {
      await cleanupAll(dataSource, userId);
    }
    fs.rmSync(benchRoot, { recursive: true, force: true });
  }
}