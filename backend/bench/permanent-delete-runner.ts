import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { FilesService } from "../src/files/files.service";
import { StorageService } from "../src/storage/storage.service";
import { UsersService } from "../src/users/users.service";
import { createPermanentDeleteInstrument } from "./permanent-delete-instrument";

export const PERMANENT_DELETE_SCALES = [10, 100, 500, 1000] as const;
export const PERMANENT_DELETE_BYTES = 2048;
export const PERMANENT_DELETE_EMAIL = "bench-permanent-delete@homecloud.local";

export interface PermanentDeleteMeasurement {
  fileCount: number;
  bytesPerFile: number;
  serviceWallMs: number;
  existsSyncCalls: number;
  existsSyncCumulativeMs: number;
  existsSyncMaxMs: number;
  unlinkSyncCalls: number;
  unlinkSyncCumulativeMs: number;
  unlinkSyncMaxMs: number;
  asyncUnlinkAttempts: number;
  asyncUnlinkCumulativeMs: number;
  asyncUnlinkMaxMs: number;
  maxAsyncUnlinkInFlight: number;
  immediateDelayMs: number;
  immediateRanBeforeServiceReturn: boolean;
  before: { files: number; storageUsed: number; fsFiles: number };
  after: { files: number; storageUsed: number; fsFiles: number };
  dbResidualsAfterCleanup: Record<string, number>;
  fsResidualsAfterCleanup: number;
}

function numeric(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`Invalid bigint: ${value}`);
  return result;
}

export function permanentDeleteBenchRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-bench-delete-"));
}

export function verifyPermanentDeleteIsolation(
  storage: StorageService,
  root: string,
): void {
  const actual = path.resolve(storage.getStoragePath());
  const expected = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  if (
    actual !== expected ||
    ["", ".", "/", "/storage"].includes(expected) ||
    !actual.startsWith(temp + path.sep)
  ) {
    throw new Error(
      `SAFETY_BLOCKER: permanent-delete root ${actual} != isolated ${expected}`,
    );
  }
}

export function buildPermanentDeleteServices(
  dataSource: DataSource,
  root: string,
) {
  const storage = new StorageService(new ConfigService({ STORAGE_PATH: root }));
  verifyPermanentDeleteIsolation(storage, root);
  const users = new UsersService(dataSource.getRepository(UserEntity));
  return {
    storage,
    files: new FilesService(
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storage,
      users,
    ),
  };
}

function countFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).length;
}

async function cleanupRows(
  dataSource: DataSource,
  userId: number,
): Promise<void> {
  await dataSource.query(`DELETE FROM share_links WHERE "userId" = $1`, [
    userId,
  ]);
  await dataSource.query(`DELETE FROM upload_sessions WHERE "userId" = $1`, [
    userId,
  ]);
  await dataSource.query(`DELETE FROM files WHERE "userId" = $1`, [userId]);
  await dataSource.query(`DELETE FROM folders WHERE "userId" = $1`, [userId]);
  await dataSource.getRepository(UserEntity).delete(userId);
}

async function residuals(
  dataSource: DataSource,
  userId: number,
): Promise<Record<string, number>> {
  const [files, folders, users] = await Promise.all([
    dataSource.getRepository(FileEntity).count({ where: { userId } }),
    dataSource.getRepository(FolderEntity).count({ where: { userId } }),
    dataSource.getRepository(UserEntity).count({ where: { id: userId } }),
  ]);
  return { files, folders, users };
}

export async function measurePermanentDeleteScale(
  dataSource: DataSource,
  fileCount: number,
): Promise<PermanentDeleteMeasurement> {
  if (!Number.isSafeInteger(fileCount) || fileCount <= 0)
    throw new Error("fileCount must be positive.");
  const existing = await dataSource
    .getRepository(UserEntity)
    .findOne({ where: { email: PERMANENT_DELETE_EMAIL } });
  if (existing)
    throw new Error("Benchmark identity already exists; refusing to reuse.");
  const root = permanentDeleteBenchRoot();
  const { files, storage } = buildPermanentDeleteServices(dataSource, root);
  let userId: number | null = null;
  let measured: Omit<
    PermanentDeleteMeasurement,
    "dbResidualsAfterCleanup" | "fsResidualsAfterCleanup"
  > | null = null;

  try {
    const userRepo = dataSource.getRepository(UserEntity);
    const fileRepo = dataSource.getRepository(FileEntity);
    const totalBytes = fileCount * PERMANENT_DELETE_BYTES;
    const user = await userRepo.save(
      userRepo.create({
        email: PERMANENT_DELETE_EMAIL,
        password: "bench-password-2026",
        name: "bench-permanent-delete",
        isActive: true,
        isEmailVerified: false,
        storageQuota: totalBytes * 2,
        storageUsed: totalBytes,
      }),
    );
    userId = user.id;
    const rows: FileEntity[] = [];
    const payload = Buffer.alloc(PERMANENT_DELETE_BYTES, 0x5a);
    for (let index = 0; index < fileCount; index++) {
      const storagePath = storage.generatePath(userId, `trash-${index}.bin`);
      fs.writeFileSync(storagePath, payload);
      rows.push(
        fileRepo.create({
          name: `trash-${index}.bin`,
          storagePath,
          size: PERMANENT_DELETE_BYTES,
          mimeType: "application/octet-stream",
          checksum: null as unknown as string,
          isFolder: false,
          isDeleted: true,
          isStarred: false,
          deletedAt: new Date(),
          parentId: null,
          folderId: null,
          version: 1,
          uploadId: null,
          userId,
          user,
        }),
      );
    }
    await fileRepo.save(rows, { chunk: 250 });
    const beforeUser = await userRepo.findOneByOrFail({ id: userId });
    const before = {
      files: await fileRepo.count({ where: { userId } }),
      storageUsed: numeric(beforeUser.storageUsed),
      fsFiles: countFiles(root),
    };
    if (
      before.files !== fileCount ||
      before.fsFiles !== fileCount ||
      before.storageUsed !== totalBytes
    )
      throw new Error("Fixture verification failed.");

    const instrument = createPermanentDeleteInstrument();
    instrument.start();
    const started = process.hrtime.bigint();
    try {
      await files.emptyTrash(userId);
      instrument.markServiceReturned();
    } finally {
      instrument.restore();
    }
    const serviceWallMs = Number(process.hrtime.bigint() - started) / 1e6;
    const probe = await instrument.settled();
    const afterUser = await userRepo.findOneByOrFail({ id: userId });
    const after = {
      files: await fileRepo.count({ where: { userId } }),
      storageUsed: numeric(afterUser.storageUsed),
      fsFiles: countFiles(root),
    };
    measured = {
      fileCount,
      bytesPerFile: PERMANENT_DELETE_BYTES,
      serviceWallMs,
      existsSyncCalls: probe.existsSync.calls,
      existsSyncCumulativeMs: probe.existsSync.cumulativeMs,
      existsSyncMaxMs: probe.existsSync.maxMs,
      unlinkSyncCalls: probe.unlinkSync.calls,
      unlinkSyncCumulativeMs: probe.unlinkSync.cumulativeMs,
      unlinkSyncMaxMs: probe.unlinkSync.maxMs,
      asyncUnlinkAttempts: probe.asyncUnlink.calls,
      asyncUnlinkCumulativeMs: probe.asyncUnlink.cumulativeMs,
      asyncUnlinkMaxMs: probe.asyncUnlink.maxMs,
      maxAsyncUnlinkInFlight: probe.asyncUnlink.maxInFlight,
      immediateDelayMs: probe.immediateDelayMs,
      immediateRanBeforeServiceReturn: probe.immediateRanBeforeServiceReturn,
      before,
      after,
    };
  } finally {
    if (userId !== null) await cleanupRows(dataSource, userId);
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (!measured || userId === null)
    throw new Error("Measurement did not complete.");
  return {
    ...measured,
    dbResidualsAfterCleanup: await residuals(dataSource, userId),
    fsResidualsAfterCleanup: countFiles(root),
  };
}
