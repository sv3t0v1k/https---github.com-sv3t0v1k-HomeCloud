import { DataSource } from "typeorm";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { UploadsService } from "../src/uploads/uploads.service";
import { StorageService } from "../src/storage/storage.service";
import { UsersService } from "../src/users/users.service";
import { ConfigService } from "@nestjs/config";
import {
  createCleanupFixtures,
  cleanupCleanupFixtures,
} from "./cleanup-fixtures";
import { median, time } from "./runner";

export interface CleanupMeasurement {
  scale: number;
  totalSessions: number;
  expiredSessions: number;
  activeSessions: number;
  cleaned: number;
  remainingSessions: number;
  runs: number;
  timingsMs: number[];
  medianMs: number;
}

/**
 * Benchmark-owned storage root. Always created under os.tmpdir() with a
 * process-pid suffix so it can never collide with the application's
 * `/storage` directory.
 */
export function benchStoragePath(): string {
  const dir = path.join(
    os.tmpdir(),
    `homecloud-bench-cleanup-storage-${process.pid}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fail-closed guard: the resolved storage path and temp root used by the
 * benchmark service must be exactly the benchmark-owned root and a
 * descendant of it. Rejects production paths and unsafe roots BEFORE any
 * filesystem mutation or cleanup method invocation.
 */
export function verifyBenchStorageIsolation(
  storageService: StorageService,
  expectedRoot: string,
): void {
  const resolved = path.resolve(storageService.getStoragePath());
  const expected = path.resolve(expectedRoot);
  const tempRoot = path.resolve(storageService.getTempPath());

  const dangerous = ["/storage", "/storage/.tmp", "", "/", "."];
  if (dangerous.includes(expected) || dangerous.includes(resolved)) {
    throw new Error(
      `SAFETY_BLOCKER: benchmark storage path resolved to dangerous root: expected=${expected} resolved=${resolved}`,
    );
  }

  if (resolved !== expected) {
    throw new Error(
      `SAFETY_BLOCKER: resolved storage path ${resolved} does not match benchmark-owned root ${expected}`,
    );
  }

  if (!tempRoot.startsWith(expected + path.sep) && tempRoot !== expected) {
    throw new Error(
      `SAFETY_BLOCKER: resolved temp root ${tempRoot} is not a descendant of benchmark-owned root ${expected}`,
    );
  }
}

/**
 * Build the benchmark UploadsService with an EXPLICIT, AUTHORITATIVE
 * benchmark-owned storage root.
 *
 * NestJS ConfigService.get() checks process.env BEFORE the constructor
 * overrides, so a container-injected `STORAGE_PATH=/storage` would silently
 * replace the intended benchmark root. We delete the env var for the
 * duration of construction and restore it afterwards, so the benchmark
 * root is authoritative regardless of caller environment.
 */
export function buildUploadsService(dataSource: DataSource): UploadsService {
  const benchStorage = benchStoragePath();
  const prevStoragePath = process.env.STORAGE_PATH;
  delete process.env.STORAGE_PATH;
  try {
    const configService = new ConfigService({
      STORAGE_PATH: benchStorage,
      MAX_SHARE_SIZE: 100 * 1024 * 1024,
      MAX_FILE_SIZE: 0,
      MAX_TOTAL_SIZE: 10 * 1024 * 1024 * 1024,
      MAX_CHUNK_SIZE: 50 * 1024 * 1024,
      UPLOAD_SESSION_TTL_HOURS: 24,
    });
    const storageService = new StorageService(configService);
    const usersService = new UsersService(dataSource.getRepository(UserEntity));
    const uploadsService = new UploadsService(
      dataSource.getRepository(UploadSessionEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storageService,
      usersService,
      configService,
    );

    verifyBenchStorageIsolation(storageService, benchStorage);

    return uploadsService;
  } finally {
    if (prevStoragePath !== undefined) {
      process.env.STORAGE_PATH = prevStoragePath;
    }
  }
}

/**
 * Measure `cleanupExpiredSessions` — safe: only benchmark sessions exist in
 * the benchmark DB, and temp paths are benchmark-owned.
 */
export async function measureExpired(
  dataSource: DataSource,
  scale: number,
  runs: number,
): Promise<CleanupMeasurement> {
  const uploadsService = buildUploadsService(dataSource);
  const storageService = (uploadsService as any).storageService as StorageService;
  const tempRoot = storageService.getTempPath();
  const fixture = await createCleanupFixtures(dataSource, {
    scale,
    expiredFraction: 0.1,
  }, tempRoot);

  const timings: number[] = [];
  let cleaned = 0;
  for (let i = 0; i < runs; i++) {
    const { result, ms } = await time(() =>
      uploadsService.cleanupExpiredSessions(),
    );
    timings.push(ms);
    cleaned = result as number;
  }

  const remaining = await dataSource
    .getRepository(UploadSessionEntity)
    .count({ where: { userId: fixture.userId } });

  await cleanupCleanupFixtures(dataSource, fixture);

  return {
    scale,
    totalSessions: fixture.totalSessions,
    expiredSessions: fixture.expiredSessions,
    activeSessions: fixture.activeSessions,
    cleaned,
    remainingSessions: remaining,
    runs,
    timingsMs: timings,
    medianMs: median(timings),
  };
}

export interface OrphanMeasurement {
  scale: number;
  directories: number;
  queries: number;
  runs: number;
  timingsMs: number[];
  medianMs: number;
  queriesPerDirectory: number;
  cleaned: number;
  remainingSessions: number;
  residualEntries: number;
}

/**
 * Measure the REAL `cleanupOrphanedTempDirs()` against fixtures located in its
 * actual isolated benchmark temp root.
 *
 * The production method scans `storageService.getTempPath()`. Fixtures are
 * created under that exact root, so the measured call operates on real
 * benchmark-owned directories. The manual per-directory `findOne` loop that
 * previously simulated the old N+1 pattern is removed from the measured path.
 */
export async function measureOrphanPattern(
  dataSource: DataSource,
  scale: number,
  runs: number,
): Promise<OrphanMeasurement> {
  const uploadsService = buildUploadsService(dataSource);
  const storageService = (uploadsService as any).storageService as StorageService;
  const tempRoot = storageService.getTempPath();

  const fixture = await createCleanupFixtures(dataSource, {
    scale,
    expiredFraction: 0.0,
  }, tempRoot);

  const repo = dataSource.getRepository(UploadSessionEntity);
  const origCreateQB = repo.createQueryBuilder.bind(repo);
  let queryCount = 0;
  repo.createQueryBuilder = (...args: any[]) => {
    queryCount++;
    return origCreateQB(...args);
  };

  const timings: number[] = [];
  let cleaned = 0;

  // warm-up
  await uploadsService.cleanupOrphanedTempDirs();

  for (let i = 0; i < runs; i++) {
    queryCount = 0;
    const start = process.hrtime.bigint();
    cleaned = await uploadsService.cleanupOrphanedTempDirs();
    const end = process.hrtime.bigint();
    timings.push(Number(end - start) / 1e6);
  }

  const remainingSessions = await repo.count({ where: { userId: fixture.userId } });
  const residualEntries = fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot).length : 0;

  await cleanupCleanupFixtures(dataSource, fixture);

  return {
    scale,
    directories: fixture.totalSessions,
    queries: queryCount,
    runs,
    timingsMs: timings,
    medianMs: median(timings),
    queriesPerDirectory: queryCount / Math.max(1, fixture.totalSessions),
    cleaned,
    remainingSessions,
    residualEntries,
  };
}