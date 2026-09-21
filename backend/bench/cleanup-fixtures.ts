import { DataSource } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { UserEntity } from "../src/entities/user.entity";
import { BENCH_USER_EMAIL, BENCH_USER_NAME } from "./services";

/**
 * Deterministic benchmark-owned temporary storage root.
 * Never points at the application's `/storage/.tmp`.
 */
export function benchTempRoot(): string {
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-bench-tmp-")),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface CleanupFixtureOptions {
  scale: number;
  expiredFraction: number;
}

export interface CleanupFixtureResult {
  userId: number;
  tempRoot: string;
  totalSessions: number;
  expiredSessions: number;
  activeSessions: number;
}

async function ensureBenchUser(
  repo: import("typeorm").Repository<UserEntity>,
): Promise<UserEntity> {
  const existing = await repo.findOne({
    where: { email: BENCH_USER_EMAIL },
  });
  if (existing) {
    throw new Error(
      `Benchmark identity ${BENCH_USER_EMAIL} already exists. Refusing to reuse.`,
    );
  }
  const user = repo.create({
    email: BENCH_USER_EMAIL,
    password: "bench-password-2026",
    name: BENCH_USER_NAME,
    isActive: true,
    isEmailVerified: false,
    storageQuota: 0,
    storageUsed: 0,
  });
  return repo.save(user);
}

/**
 * Create a deterministic set of upload sessions for the benchmark user.
 *
 * - `scale` total sessions
 * - `expiredFraction` are past their `expiresAt` (status pending)
 * - the remainder are active (status pending, future expiry)
 *
 * Temp directories are created on disk under a benchmark-owned temp root so
 * `cleanupOrphanedTempDirs` can scan them without touching application storage.
 */
export async function createCleanupFixtures(
  dataSource: DataSource,
  options: CleanupFixtureOptions,
): Promise<CleanupFixtureResult> {
  const userRepo = dataSource.getRepository(UserEntity);
  const sessionRepo = dataSource.getRepository(UploadSessionEntity);

  const user = await ensureBenchUser(userRepo);
  const userId = user.id;
  const tempRoot = benchTempRoot();

  const totalSessions = options.scale;
  const expiredSessions = Math.max(
    1,
    Math.floor(totalSessions * options.expiredFraction),
  );
  const activeSessions = totalSessions - expiredSessions;

  const now = new Date();
  const past = new Date(now.getTime() - 60 * 60 * 1000);
  const future = new Date(now.getTime() + 60 * 60 * 1000);

  const sessions: UploadSessionEntity[] = [];
  for (let i = 0; i < totalSessions; i++) {
    const isExpired = i < expiredSessions;
    const session = new UploadSessionEntity();
    session.uploadId = uuidv4();
    session.filename = `${BENCH_USER_NAME}_cleanup_${i}`;
    session.totalSize = 1024;
    session.uploadedSize = 0;
    session.chunkSize = 1024;
    session.totalChunks = 1;
    session.uploadedChunks = [];
    const dir = path.join(tempRoot, session.uploadId);
    fs.mkdirSync(dir, { recursive: true });
    session.tempPath = dir;
    session.parentId = null;
    session.status = "pending";
    session.expiresAt = isExpired ? past : future;
    session.userId = userId;
    sessions.push(session);
  }

  for (let i = 0; i < sessions.length; i += 500) {
    await sessionRepo.save(sessions.slice(i, i + 500));
  }

  return {
    userId,
    tempRoot,
    totalSessions,
    expiredSessions,
    activeSessions,
  };
}

export async function cleanupCleanupFixtures(
  dataSource: DataSource,
  fixture: CleanupFixtureResult,
): Promise<void> {
  try {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
  await dataSource.query(
    `DELETE FROM upload_sessions WHERE "userId" = $1`,
    [fixture.userId],
  );
  await dataSource.getRepository(UserEntity).delete(fixture.userId);
}

export async function countCleanupRows(
  dataSource: DataSource,
  userId: number,
): Promise<Record<string, number>> {
  const [sessions, user] = await Promise.all([
    dataSource.getRepository(UploadSessionEntity).count({ where: { userId } }),
    dataSource.getRepository(UserEntity).count({ where: { id: userId } }),
  ]);
  return { sessions, user };
}