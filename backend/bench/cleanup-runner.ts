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

function benchStoragePath(): string {
  const dir = path.join(
    os.tmpdir(),
    `homecloud-bench-cleanup-storage-${process.pid}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function buildUploadsService(dataSource: DataSource): UploadsService {
  const configService = new ConfigService({
    STORAGE_PATH: benchStoragePath(),
    MAX_SHARE_SIZE: 100 * 1024 * 1024,
    MAX_FILE_SIZE: 0,
    MAX_TOTAL_SIZE: 10 * 1024 * 1024 * 1024,
    MAX_CHUNK_SIZE: 50 * 1024 * 1024,
    UPLOAD_SESSION_TTL_HOURS: 24,
  });
  const storageService = new StorageService(configService);
  const usersService = new UsersService(dataSource.getRepository(UserEntity));
  return new UploadsService(
    dataSource.getRepository(UploadSessionEntity),
    dataSource.getRepository(FileEntity),
    dataSource.getRepository(FolderEntity),
    storageService,
    usersService,
    configService,
  );
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
  const fixture = await createCleanupFixtures(dataSource, {
    scale,
    expiredFraction: 0.1,
  });

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
}

/**
 * Measure the N+1 query pattern of `cleanupOrphanedTempDirs` in isolation.
 *
 * The production method scans the application's `/storage/.tmp`, which we
 * cannot safely touch. This replicates its exact per-directory DB lookup
 * (`findOne({ where: { tempPath } })`) against benchmark-owned temp paths to
 * prove query-count scaling without touching production storage.
 */
export async function measureOrphanPattern(
  dataSource: DataSource,
  scale: number,
  runs: number,
): Promise<OrphanMeasurement> {
  const fixture = await createCleanupFixtures(dataSource, {
    scale,
    expiredFraction: 0.0,
  });

  const repo = dataSource.getRepository(UploadSessionEntity);
  const timings: number[] = [];
  let queries = 0;

  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    let count = 0;
    const entries = fs.readdirSync(fixture.tempRoot);
    for (const entry of entries) {
      const entryPath = path.join(fixture.tempRoot, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;
      await repo.findOne({ where: { tempPath: entryPath } });
      count++;
    }
    const end = process.hrtime.bigint();
    timings.push(Number(end - start) / 1e6);
    queries = count;
  }

  await cleanupCleanupFixtures(dataSource, fixture);

  return {
    scale,
    directories: fixture.totalSessions,
    queries,
    runs,
    timingsMs: timings,
    medianMs: median(timings),
    queriesPerDirectory: queries / Math.max(1, fixture.totalSessions),
  };
}