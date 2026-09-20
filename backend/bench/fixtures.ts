import { DataSource, Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { ShareLinkEntity } from "../src/entities/share-link.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { BENCH_USER_EMAIL, BENCH_USER_PASSWORD, BENCH_USER_NAME } from "./services";

/**
 * Deterministic search tokens used to build ~10% selectivity evidence.
 * Token `benchsearchtoken` appears in exactly 10% of file/folder names.
 *
 * The 90% of rows that do NOT match the 10% token use `SEARCH_TOKEN_NEUTRAL`
 * — deliberately distinct from every search query string so the
 * "match-none" query provably matches zero rows.
 */
export const SEARCH_TOKEN_10PCT = "benchsearchtoken";
export const SEARCH_TOKEN_ALL = "bench";
export const SEARCH_TOKEN_NONE = "zzznomatchzzz";
export const SEARCH_TOKEN_NEUTRAL = "fixturedata";

export interface FixtureOptions {
  scale: number;
  searchToken: string;
  tokenFraction: number;
}

export interface FixtureResult {
  userId: number;
  rootFolderId: number;
  fileCount: number;
  folderCount: number;
  shareCount: number;
  sessionCount: number;
  trashCount: number;
}

function makeName(index: number, token: string): string {
  return `${BENCH_USER_NAME}_file_${token}_${index}`;
}

function makeFolderName(index: number, token: string): string {
  return `${BENCH_USER_NAME}_folder_${token}_${index}`;
}

/**
 * Ownership contract for the benchmark identity.
 *
 * The harness MUST create the benchmark user itself during the current run.
 * Reusing a pre-existing `bench@homecloud.local` is forbidden: email equality
 * does not prove the harness owns that row, and scoped cleanup would then
 * delete data it did not create.
 *
 * Returns a discriminated result so callers cannot forget the distinction.
 */
export type BenchUserResolution =
  | { ok: true; user: UserEntity; created: true }
  | { ok: false; reason: "already-exists" };

export async function resolveBenchUser(
  repo: Repository<UserEntity>,
): Promise<BenchUserResolution> {
  const existing = await repo.findOne({ where: { email: BENCH_USER_EMAIL } });
  if (existing) {
    return {
      ok: false,
      reason: "already-exists",
    };
  }

  const user = repo.create({
    email: BENCH_USER_EMAIL,
    password: BENCH_USER_PASSWORD,
    name: BENCH_USER_NAME,
    isActive: true,
    isEmailVerified: false,
    storageQuota: 0,
    storageUsed: 0,
  });
  const saved = await repo.save(user);
  return { ok: true, user: saved, created: true };
}

async function ensureBenchUser(
  repo: Repository<UserEntity>,
): Promise<UserEntity> {
  const resolution = await resolveBenchUser(repo);
  if (!resolution.ok) {
    throw new Error(
      `Benchmark identity ${BENCH_USER_EMAIL} already exists in this database. ` +
        "Refusing to reuse it: email equality does not prove harness ownership, " +
        "and scoped cleanup would delete data it did not create. " +
        "Use a clean dedicated benchmark database or remove stale benchmark " +
        "data manually after verification, then re-run.",
    );
  }
  return resolution.user;
}

/**
 * Build FK-consistent fixture data for a single benchmark user.
 *
 * - 1 root folder owned by the benchmark user
 * - `scale` file rows (isFolder=false) under the root, plus 1 mirror-less
 *   folder row per file to exercise folderId semantics minimally
 * - `scale` folder rows (real folders) with parentId chains
 * - a subset of files flagged isDeleted=true to exercise trash
 * - `shareCount` share links referencing real files
 * - `sessionCount` upload sessions referencing the benchmark user
 *
 * All rows are owned by the benchmark identity so cleanup can target them.
 */
export async function createFixtures(
  dataSource: DataSource,
  options: FixtureOptions,
): Promise<FixtureResult> {
  const userRepo = dataSource.getRepository(UserEntity);
  const folderRepo = dataSource.getRepository(FolderEntity);
  const fileRepo = dataSource.getRepository(FileEntity);
  const shareRepo = dataSource.getRepository(ShareLinkEntity);
  const sessionRepo = dataSource.getRepository(UploadSessionEntity);

  const user = await ensureBenchUser(userRepo);
  const userId = user.id;

  const root = folderRepo.create({
    name: `${BENCH_USER_NAME}_root`,
    isDeleted: false,
    deletedAt: null,
    parentId: null,
    userId,
  });
  const savedRoot = await folderRepo.save(root);
  const rootFolderId = savedRoot.id;

  const fileCount = options.scale;
  const folderCount = options.scale;
  const shareCount = Math.min(options.scale, 1000);
  const sessionCount = Math.min(options.scale, 1000);
  const trashCount = Math.max(1, Math.floor(options.scale / 10));

  const files: FileEntity[] = [];
  const folders: FolderEntity[] = [];
  const shares: ShareLinkEntity[] = [];
  const sessions: UploadSessionEntity[] = [];

  for (let i = 0; i < fileCount; i++) {
    const token =
      i % 10 === 0 ? options.searchToken : SEARCH_TOKEN_NEUTRAL;
    files.push(
      fileRepo.create({
        name: makeName(i, token),
        storagePath: `/storage/bench/${userId}/${i}`,
        size: 1024,
        mimeType: "text/plain",
        isFolder: false,
        isDeleted: i < trashCount,
        deletedAt: i < trashCount ? new Date() : null,
        isStarred: false,
        parentId: rootFolderId,
        folderId: null,
        version: 1,
        userId,
      }),
    );
  }

  for (let i = 0; i < folderCount; i++) {
    const token =
      i % 10 === 0 ? options.searchToken : SEARCH_TOKEN_NEUTRAL;
    folders.push(
      folderRepo.create({
        name: makeFolderName(i, token),
        isDeleted: i < trashCount,
        deletedAt: i < trashCount ? new Date() : null,
        parentId: rootFolderId,
        userId,
      }),
    );
  }

  await fileRepo.save(files);
  await folderRepo.save(folders);

for (let i = 0; i < shareCount; i++) {
    const file = files[i % fileCount];
    const share = new ShareLinkEntity();
    share.token = uuidv4();
    share.password = "";
    share.expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    share.isActive = true;
    share.downloadCount = 0;
    share.maxDownloads = null;
    share.isFolder = false;
    share.failedAttempts = 0;
    share.lockedUntil = null;
    share.fileId = file.id;
    share.userId = userId;
    shares.push(share);
  }
  if (shares.length) await shareRepo.save(shares);

  for (let i = 0; i < sessionCount; i++) {
    const session = new UploadSessionEntity();
    session.uploadId = uuidv4();
    session.filename = makeName(i, options.searchToken);
    session.totalSize = 1024;
    session.uploadedSize = 0;
    session.chunkSize = 1024;
    session.totalChunks = 1;
    session.uploadedChunks = [];
    session.tempPath = `/storage/.tmp/bench_${userId}_${i}`;
    session.parentId = rootFolderId;
    session.status = "pending";
    session.expiresAt = null;
    session.userId = userId;
    sessions.push(session);
  }
  if (sessions.length) await sessionRepo.save(sessions);

  return {
    userId,
    rootFolderId,
    fileCount,
    folderCount,
    shareCount,
    sessionCount,
    trashCount,
  };
}

/**
 * Delete ONLY rows owned by the benchmark identity, in FK-safe order.
 *
 * Ownership is proven by the exact `userId` captured when the benchmark user
 * was created during THIS run — never by re-resolving email, which would
 * accept a pre-existing unrelated user as proof of ownership.
 *
 * If no rows match, this is a safe no-op.
 */
export async function cleanupBenchmark(
  dataSource: DataSource,
  userId: number,
): Promise<void> {
  await dataSource.query(
    `DELETE FROM share_links WHERE "userId" = $1`,
    [userId],
  );
  await dataSource.query(
    `DELETE FROM upload_sessions WHERE "userId" = $1`,
    [userId],
  );
  await dataSource.query(
    `DELETE FROM files WHERE "userId" = $1`,
    [userId],
  );
  await dataSource.query(
    `DELETE FROM folders WHERE "userId" = $1`,
    [userId],
  );
  await dataSource.getRepository(UserEntity).delete(userId);
}

export async function countBenchmarkRows(
  dataSource: DataSource,
): Promise<Record<string, number>> {
  const userId = (
    await dataSource.getRepository(UserEntity).findOne({
      where: { email: BENCH_USER_EMAIL },
    })
  )?.id;
  if (userId === undefined) {
    return { files: 0, folders: 0, shares: 0, sessions: 0, users: 0 };
  }
  const [files, folders, shares, sessions] = await Promise.all([
    dataSource.getRepository(FileEntity).count({ where: { userId } }),
    dataSource.getRepository(FolderEntity).count({ where: { userId } }),
    dataSource.getRepository(ShareLinkEntity).count({ where: { userId } }),
    dataSource.getRepository(UploadSessionEntity).count({ where: { userId } }),
  ]);
  return { files, folders, shares, sessions, users: 1 };
}