import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { UploadsService } from "../src/uploads/uploads.service";
import { StorageService } from "../src/storage/storage.service";
import { UsersService } from "../src/users/users.service";
import { createWriteStreamInstrument, WriteStreamInstrumentHandle } from "./write-stream-instrument";
import { createRssSampler, RssSamplerHandle } from "./rss-sampler";

export const COMPLETE_UPLOAD_SCALES = [1 * 1024 * 1024, 10 * 1024 * 1024, 50 * 1024 * 1024] as const;
export const CHUNK_SIZE = 5 * 1024 * 1024;
export const COMPLETE_UPLOAD_BENCH_MIME_TYPES = "application/octet-stream";
export const BENCH_QUOTA_MULTIPLIER = 2;

export interface CompleteUploadMeasurement {
  scaleBytes: number;
  chunkCount: number;
  wallMs: number;
  rssBefore: number;
  rssPeak: number;
  rssAfter: number;
  rssDeltaPeak: number;
  createWriteStream: number;
  writeCalls: number;
  writeFalse: number;
  maxWritableLength: number;
  drainEvents: number;
  finalFileSize: number;
  expectedSha256: string;
  actualSha256: string;
  sessionStatus: string;
  storageUsed: number;
  storageQuota: number;
  dbResiduals: Record<string, number>;
  fsResiduals: number;
}

export interface CompleteUploadRunResult {
  measurement: CompleteUploadMeasurement;
}

export interface CompleteUploadServices {
  uploadsService: UploadsService;
  storageService: StorageService;
  benchRoot: string;
}

export function benchStoragePath(): string {
  const dir = path.join(
    os.tmpdir(),
    `homecloud-bench-completeupload-${process.pid}`,
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

export function buildCompleteUploadServices(
  dataSource: DataSource,
): CompleteUploadServices {
  const benchRoot = benchStoragePath();
  const prevStoragePath = process.env.STORAGE_PATH;
  const prevAllowedMimeTypes = process.env.ALLOWED_UPLOAD_MIME_TYPES;
  delete process.env.STORAGE_PATH;
  process.env.ALLOWED_UPLOAD_MIME_TYPES = COMPLETE_UPLOAD_BENCH_MIME_TYPES;
  try {
    const configService = new ConfigService({
      STORAGE_PATH: benchRoot,
      MAX_FILE_SIZE: 0,
      MAX_TOTAL_SIZE: 10 * 1024 * 1024 * 1024,
      MAX_CHUNK_SIZE: 50 * 1024 * 1024,
      UPLOAD_SESSION_TTL_HOURS: 24,
      ALLOWED_UPLOAD_MIME_TYPES: COMPLETE_UPLOAD_BENCH_MIME_TYPES,
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
    if (prevAllowedMimeTypes === undefined) {
      delete process.env.ALLOWED_UPLOAD_MIME_TYPES;
    } else {
      process.env.ALLOWED_UPLOAD_MIME_TYPES = prevAllowedMimeTypes;
    }
  }
}

export function computeBenchStorageQuota(scaleBytes: number): number {
  const quota = scaleBytes * BENCH_QUOTA_MULTIPLIER;
  if (!Number.isSafeInteger(scaleBytes) || scaleBytes <= 0 || !Number.isSafeInteger(quota)) {
    throw new Error(`Invalid benchmark scale for storage quota: ${scaleBytes}`);
  }
  return quota;
}

export async function createBenchUser(
  dataSource: DataSource,
  scaleBytes: number,
): Promise<number> {
  const repo = dataSource.getRepository(UserEntity);
  const existing = await repo.findOne({
    where: { email: "bench-completeupload@homecloud.local" },
  });
  if (existing) {
    throw new Error("Benchmark identity already exists; refusing to reuse.");
  }
  const user = repo.create({
    email: "bench-completeupload@homecloud.local",
    password: "bench-password-2026",
    name: "bench-completeupload",
    isActive: true,
    isEmailVerified: false,
    storageQuota: computeBenchStorageQuota(scaleBytes),
    storageUsed: 0,
  });
  const saved = await repo.save(user);
  return saved.id;
}

async function cleanupAll(dataSource: DataSource, userId: number): Promise<void> {
  await dataSource.query(`DELETE FROM share_links WHERE "userId" = $1`, [userId]);
  await dataSource.query(`DELETE FROM upload_sessions WHERE "userId" = $1`, [userId]);
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

export function computeExpectedSha256(scaleBytes: number, chunkSize: number): string {
  const totalChunks = Math.ceil(scaleBytes / chunkSize);
  const hash = crypto.createHash("sha256");
  for (let i = 0; i < totalChunks; i++) {
    const chunkBytes = i === totalChunks - 1 ? scaleBytes - i * chunkSize : chunkSize;
    const chunkData = Buffer.alloc(chunkBytes, i % 256);
    hash.update(chunkData);
  }
  return hash.digest("hex");
}

export function writeChunks(tempPath: string, scaleBytes: number, chunkSize: number): void {
  const totalChunks = Math.ceil(scaleBytes / chunkSize);
  for (let i = 0; i < totalChunks; i++) {
    const chunkBytes = i === totalChunks - 1 ? scaleBytes - i * chunkSize : chunkSize;
    const chunkData = Buffer.alloc(chunkBytes, i % 256);
    const chunkPath = path.join(tempPath, String(i));
    fs.writeFileSync(chunkPath, chunkData);
  }
}

export async function measureCompleteUploadScale(
  dataSource: DataSource,
  scaleBytes: number,
  services?: CompleteUploadServices,
): Promise<CompleteUploadRunResult> {
  const chunkSize = scaleBytes <= CHUNK_SIZE ? scaleBytes : CHUNK_SIZE;
  const totalChunks = Math.ceil(scaleBytes / chunkSize);

  const { uploadsService, storageService, benchRoot } = services ?? buildCompleteUploadServices(dataSource);
  const tempRoot = storageService.getTempPath();

  let userId: number | null = null;
  let uploadId: string | null = null;

  const writeInstrument = createWriteStreamInstrument();
  const rssSampler = createRssSampler(1); // 1ms interval

  try {
    userId = await createBenchUser(dataSource, scaleBytes);

    const session = await uploadsService.createUploadSession(
      userId,
      `bench_${scaleBytes}.bin`,
      scaleBytes,
      chunkSize,
    );
    uploadId = session.uploadId;

    // Write all chunks to disk before measurement
    writeChunks(session.tempPath, scaleBytes, chunkSize);

    // Start instrumentation
    writeInstrument.start();
    rssSampler.start();

    const start = process.hrtime.bigint();
    const result = await uploadsService.completeUpload(userId, uploadId);
    const end = process.hrtime.bigint();

    // Stop instrumentation
    rssSampler.stop();
    writeInstrument.restore();

    const wallMs = Number(end - start) / 1e6;
    const rssSnap = rssSampler.snapshot();
    const writeSnap = writeInstrument.snapshot();

    // Verify final file
    const finalPath = result.storagePath;
    const finalStats = fs.statSync(finalPath);
    const actualSize = finalStats.size;
    const actualHash = crypto.createHash("sha256");
    const fileData = fs.readFileSync(finalPath);
    actualHash.update(fileData);
    const actualSha256 = actualHash.digest("hex");
    const expectedSha256 = computeExpectedSha256(scaleBytes, chunkSize);

    // Count residuals
    const residualRows = await countRows(dataSource, userId);
    const residualFs = fs.existsSync(tempRoot)
      ? fs.readdirSync(tempRoot).length
      : 0;

    // Re-fetch session status AFTER measurement boundary (outside wall-time, instrumentation, RSS)
    const completedSession = await dataSource
      .getRepository(UploadSessionEntity)
      .findOne({ where: { uploadId, userId } });
    if (!completedSession) {
      throw new Error(`Upload session ${uploadId} not found after successful completeUpload`);
    }
    const sessionStatus = completedSession.status;
    const completedUser = await dataSource
      .getRepository(UserEntity)
      .findOne({ where: { id: userId } });
    if (!completedUser) {
      throw new Error(`Benchmark user ${userId} not found after successful completeUpload`);
    }
    if (
      completedUser.storageUsed !== scaleBytes ||
      completedUser.storageQuota !== computeBenchStorageQuota(scaleBytes)
    ) {
      throw new Error(
        `Quota accounting mismatch: used=${completedUser.storageUsed} quota=${completedUser.storageQuota}`,
      );
    }

    const measurement: CompleteUploadMeasurement = {
      scaleBytes,
      chunkCount: totalChunks,
      wallMs,
      rssBefore: rssSnap.before,
      rssPeak: rssSnap.peak,
      rssAfter: rssSnap.after,
      rssDeltaPeak: rssSnap.peak - rssSnap.before,
      createWriteStream: writeSnap.createWriteStream,
      writeCalls: writeSnap.write,
      writeFalse: writeSnap.writeFalse,
      maxWritableLength: writeSnap.maxWritableLength,
      drainEvents: writeSnap.drain,
      finalFileSize: actualSize,
      expectedSha256,
      actualSha256,
      sessionStatus,
      storageUsed: completedUser.storageUsed,
      storageQuota: completedUser.storageQuota,
      dbResiduals: residualRows,
      fsResiduals: residualFs,
    };

    return { measurement };
  } finally {
    // Cleanup
    if (uploadId && userId) {
      try {
        await uploadsService.abortUpload(userId, uploadId);
      } catch {
        // best-effort
      }
    }
    if (userId) {
      await cleanupAll(dataSource, userId);
    }
    fs.rmSync(benchRoot, { recursive: true, force: true });
  }
}
