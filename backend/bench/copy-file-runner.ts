import * as crypto from "crypto";
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
import { createCopyFileInstrument } from "./copy-file-instrument";

export const COPY_FILE_SCALES = [
  1 * 1024 * 1024,
  10 * 1024 * 1024,
  50 * 1024 * 1024,
  100 * 1024 * 1024,
] as const;
export const COPY_FILE_BENCH_EMAIL = "bench-copyfile@homecloud.local";

export interface CopyFileMeasurement {
  scaleBytes: number;
  serviceWallMs: number;
  syncCopyMs: number;
  immediateDelayMs: number;
  immediateRanBeforeReturn: boolean;
  copyFileSyncCalls: number;
  asyncCopyAttempts: number;
  destinationSize: number;
  expectedSha256: string;
  actualSha256: string;
  persistedFileCount: number;
  persistedCopySize: number;
  persistedCopyMimeType: string;
  storageUsed: number;
  storageQuota: number;
  dbResidualsAfterCleanup: Record<string, number>;
  fsResidualsAfterCleanup: number;
}

function normalizeBigInt(value: number | string, field: string): number {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return numberValue;
}

export function copyBenchRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-bench-copyfile-"));
}

export function verifyCopyIsolation(
  storageService: StorageService,
  expectedRoot: string,
): void {
  const actual = path.resolve(storageService.getStoragePath());
  const expected = path.resolve(expectedRoot);
  if (["", ".", "/", "/storage"].includes(expected) || actual !== expected) {
    throw new Error(
      `SAFETY_BLOCKER: copy benchmark storage root ${actual} != ${expected}`,
    );
  }
  const temp = path.resolve(os.tmpdir());
  if (!actual.startsWith(temp + path.sep)) {
    throw new Error(
      `SAFETY_BLOCKER: copy benchmark root is outside temp: ${actual}`,
    );
  }
}

export function buildCopyServices(
  dataSource: DataSource,
  benchRoot: string,
): {
  filesService: FilesService;
  storageService: StorageService;
} {
  const storageService = new StorageService(
    new ConfigService({ STORAGE_PATH: benchRoot }),
  );
  verifyCopyIsolation(storageService, benchRoot);
  const usersService = new UsersService(dataSource.getRepository(UserEntity));
  return {
    storageService,
    filesService: new FilesService(
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storageService,
      usersService,
    ),
  };
}

export function writeDeterministicFixture(
  filePath: string,
  scaleBytes: number,
): string {
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "w");
  try {
    let remaining = scaleBytes;
    while (remaining > 0) {
      const bytes = Math.min(remaining, block.length);
      fs.writeSync(fd, block, 0, bytes);
      hash.update(block.subarray(0, bytes));
      remaining -= bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

async function countRows(
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

export async function measureCopyFileScale(
  dataSource: DataSource,
  scaleBytes: number,
): Promise<CopyFileMeasurement> {
  const existing = await dataSource.getRepository(UserEntity).findOne({
    where: { email: COPY_FILE_BENCH_EMAIL },
  });
  if (existing)
    throw new Error("Benchmark identity already exists; refusing to reuse.");

  const benchRoot = copyBenchRoot();
  const { filesService, storageService } = buildCopyServices(
    dataSource,
    benchRoot,
  );
  let userId: number | null = null;
  let measurement: Omit<
    CopyFileMeasurement,
    "dbResidualsAfterCleanup" | "fsResidualsAfterCleanup"
  > | null = null;

  try {
    const userRepo = dataSource.getRepository(UserEntity);
    const user = await userRepo.save(
      userRepo.create({
        email: COPY_FILE_BENCH_EMAIL,
        password: "bench-password-2026",
        name: "bench-copyfile",
        isActive: true,
        isEmailVerified: false,
        storageQuota: scaleBytes * 3,
        storageUsed: scaleBytes,
      }),
    );
    userId = user.id;
    const sourcePath = storageService.generatePath(userId, "source.bin");
    const expectedSha256 = writeDeterministicFixture(sourcePath, scaleBytes);
    const fileRepo = dataSource.getRepository(FileEntity);
    const source = await fileRepo.save(
      fileRepo.create({
        name: "source.bin",
        storagePath: sourcePath,
        size: scaleBytes,
        mimeType: "application/octet-stream",
        checksum: expectedSha256,
        isFolder: false,
        isDeleted: false,
        isStarred: false,
        deletedAt: null,
        parentId: null,
        folderId: null,
        version: 1,
        uploadId: null,
        userId,
        user,
      }),
    );

    const instrument = createCopyFileInstrument();
    instrument.start();
    let copy: FileEntity;
    const start = process.hrtime.bigint();
    try {
      copy = await filesService.copyFile(userId, source.id);
    } finally {
      instrument.restore();
    }
    const serviceWallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const probe = await instrument.settled();

    const persistedCopy = await fileRepo.findOne({
      where: { id: copy.id, userId },
    });
    const persistedUser = await userRepo.findOne({ where: { id: userId } });
    if (!persistedCopy || !persistedUser)
      throw new Error("Copy metadata was not persisted.");

    measurement = {
      scaleBytes,
      serviceWallMs,
      syncCopyMs: probe.operationMs,
      immediateDelayMs: probe.immediateDelayMs,
      immediateRanBeforeReturn: probe.immediateRanBeforeReturn,
      copyFileSyncCalls: instrument.calls(),
      asyncCopyAttempts: instrument.asyncAttempts(),
      destinationSize: fs.statSync(copy.storagePath).size,
      expectedSha256,
      actualSha256: sha256(copy.storagePath),
      persistedFileCount: await fileRepo.count({ where: { userId } }),
      persistedCopySize: normalizeBigInt(
        persistedCopy.size as unknown as number | string,
        "copy size",
      ),
      persistedCopyMimeType: persistedCopy.mimeType,
      storageUsed: normalizeBigInt(
        persistedUser.storageUsed as unknown as number | string,
        "storageUsed",
      ),
      storageQuota: normalizeBigInt(
        persistedUser.storageQuota as unknown as number | string,
        "storageQuota",
      ),
    };
  } finally {
    if (userId !== null) await cleanupRows(dataSource, userId);
    fs.rmSync(benchRoot, { recursive: true, force: true });
  }

  if (!measurement || userId === null)
    throw new Error("Copy measurement did not complete.");
  return {
    ...measurement,
    dbResidualsAfterCleanup: await countRows(dataSource, userId),
    fsResidualsAfterCleanup: fs.existsSync(benchRoot)
      ? fs.readdirSync(benchRoot).length
      : 0,
  };
}
