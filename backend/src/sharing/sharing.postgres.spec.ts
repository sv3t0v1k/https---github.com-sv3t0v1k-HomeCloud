import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, QueryRunner } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UserEntity } from "../entities/user.entity";
import { AddMissingIndexes1746825010000 } from "../migrations/1746825010000-AddMissingIndexes";
import { AddShareFailedAttempts1746825100000 } from "../migrations/1746825100000-AddShareFailedAttempts";
import { AddShareMaxDownloads1746825090000 } from "../migrations/1746825090000-AddShareMaxDownloads";
import { AddFileUploadId1746825080000 } from "../migrations/1746825080000-AddFileUploadId";
import { AddFileFolderIdMirrorLink1746825110000 } from "../migrations/1746825110000-AddFileFolderIdMirrorLink";
import { CreateFilesTable1746824920000 } from "../migrations/1746824920000-CreateFilesTable";
import { CreateFoldersTable1746824910000 } from "../migrations/1746824910000-CreateFoldersTable";
import { CreateRefreshTokensTable1746825000000 } from "../migrations/1746825000000-CreateRefreshTokensTable";
import { CreateShareLinksTable1746824930000 } from "../migrations/1746824930000-CreateShareLinksTable";
import { CreateUsersTable1746824900000 } from "../migrations/1746824900000-CreateUsersTable";
import { ShareLinksTokenUnique1746825040000 } from "../migrations/1746825040000-ShareLinksTokenUnique";
import { SharingService } from "./sharing.service";
import { StorageService } from "../storage/storage.service";
import * as bcrypt from "bcryptjs";

// Запускается только с явно выделенной тестовой БД; DATABASE_URL не используется.
const testDatabaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("SharingService — реальный PostgreSQL", () => {
  const schema = `sharing_test_${randomUUID().replace(/-/g, "")}`;
  const table = `"${schema}"."share_links"`;
  let dataSource: DataSource;
  let migrationRunner: QueryRunner;
  let service: SharingService;
  let schemaCreated = false;
  const migration = new AddShareMaxDownloads1746825090000();
  const createUsersMigration = new CreateUsersTable1746824900000();
  const testUserId = 100;
  const testFileId = 100;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      url: testDatabaseUrl,
      schema,
      synchronize: false,
      migrationsRun: false,
      entities: [
        ShareLinkEntity,
        FileEntity,
        UserEntity,
        FolderEntity,
        RefreshTokenEntity,
      ],
      extra: { max: 10, options: `-c search_path=${schema}` },
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    migrationRunner = dataSource.createQueryRunner();
    await migrationRunner.connect();
    // У миграции имя таблицы без schema: исключаем public из search_path.
    await migrationRunner.query(`SET search_path TO "${schema}"`);
    await createUsersMigration.up(migrationRunner);
    await new CreateFoldersTable1746824910000().up(migrationRunner);
    await new CreateFilesTable1746824920000().up(migrationRunner);
    await new AddFileUploadId1746825080000().up(migrationRunner);
    await new AddFileFolderIdMirrorLink1746825110000().up(migrationRunner);
    await new CreateRefreshTokensTable1746825000000().up(migrationRunner);
    await new CreateShareLinksTable1746824930000().up(migrationRunner);
    await new AddMissingIndexes1746825010000().up(migrationRunner);
    await new ShareLinksTokenUnique1746825040000().up(migrationRunner);
    await migration.up(migrationRunner);
    await new AddShareFailedAttempts1746825100000().up(migrationRunner);
    await dataSource.query(
      `INSERT INTO "${schema}"."users" ("id", "email", "password", "isActive") VALUES ($1, $2, $3, $4)`,
      [testUserId, "test@test", "test-password", true],
    );
    await dataSource.query(
      `INSERT INTO "${schema}"."files" ("id", "name", "mimeType", "size", "isFolder", "isDeleted", "userId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [testFileId, "test.png", "image/png", 100, false, false, testUserId],
    );
    service = new SharingService(
      dataSource.getRepository(ShareLinkEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(UserEntity),
      new ConfigService(),
      { ensureWithinStorageRoot: (p: string) => p } as unknown as StorageService,
    );
  }, 30000);

  afterAll(async () => {
    try {
      if (migrationRunner && !migrationRunner.isReleased) {
        await migrationRunner.release();
      }
      if (schemaCreated) {
        await dataSource.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      if (dataSource?.isInitialized) await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    try {
      await dataSource.query(`TRUNCATE TABLE ${table}`);
    } catch {
      // Table doesn't exist yet (migration not applied in this schema). Skip cleanup.
    }
  });

  async function insertShare(
    token: string,
    maxDownloads: number | null,
    downloadCount = 0,
    active = true,
    expiresAt: Date | null = null,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ${table} ("token", "maxDownloads", "downloadCount", "isActive", "expiresAt", "userId", "fileId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [token, maxDownloads, downloadCount, active, expiresAt, testUserId, testFileId],
    );
  }

  async function counters(): Promise<Record<string, number>> {
    const rows: Array<{ token: string; count: number }> =
      await dataSource.query(
        `SELECT "token", "downloadCount"::int AS count FROM ${table}`,
      );
    return Object.fromEntries(rows.map((row) => [row.token, row.count]));
  }

  it("допускает ровно 3 из 20 конкурентных запросов при лимите 3", async () => {
    await insertShare("limited", 3);
    await insertShare("other", 10, 1);
    await insertShare("expired", 10, 2, true, new Date("2000-01-01"));
    await insertShare("revoked", 10, 3, false);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.incrementDownloadCount("limited"),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(3);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(17);
    const reasons = (rejected as PromiseRejectedResult[]).map((result) => result.reason);
    expect(reasons).toEqual(Array.from({ length: 17 }, () => expect.any(NotFoundException)));
    expect(await counters()).toEqual({
      limited: 3,
      other: 1,
      expired: 2,
      revoked: 3,
    });
  });

  it("не использует чужие строки при исчерпанном, истёкшем, отозванном или неизвестном token", async () => {
    await insertShare("exhausted", 3, 3);
    await insertShare("other", 10, 1);
    await insertShare("expired", 10, 2, true, new Date("2000-01-01"));
    await insertShare("revoked", 10, 3, false);
    for (const token of ["exhausted", "expired", "revoked", "missing"]) {
      await expect(
        service.incrementDownloadCount(token),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await counters()).toEqual({
      exhausted: 3,
      other: 1,
      expired: 2,
      revoked: 3,
    });
  });

  it("сохраняет null как unlimited при конкурентных запросах", async () => {
    await insertShare("unlimited", null);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        service.incrementDownloadCount("unlimited"),
      ),
    );
    expect(await counters()).toEqual({ unlimited: 20 });
  });

  it("ограничивает folder share поддеревом и повторно проверяет scope при admission", async () => {
    await dataSource.query(
      `INSERT INTO "${schema}"."folders" (id, name, "parentId", "userId", "isDeleted") VALUES
       (200, 'Root', NULL, $1, false),
       (201, 'Nested', 200, $1, false),
       (202, 'Sibling', NULL, $1, false)`,
      [testUserId],
    );
    await dataSource.query(
      `INSERT INTO "${schema}"."files"
       (id, name, "mimeType", size, "isFolder", "isDeleted", "userId", "parentId", "folderId") VALUES
       (1200, 'Root', 'application/zip', 0, true, false, $1, NULL, 200),
       (1201, 'Nested', 'application/zip', 0, true, false, $1, 200, 201),
       (1202, 'Sibling', 'application/zip', 0, true, false, $1, NULL, 202),
       (1300, 'inside.txt', 'text/plain', 5, false, false, $1, 201, NULL),
       (1301, 'outside.txt', 'text/plain', 5, false, false, $1, 202, NULL)`,
      [testUserId],
    );
    await dataSource.query(
      `INSERT INTO ${table} (token, "maxDownloads", "downloadCount", "isActive", "userId", "fileId", "isFolder")
       VALUES ('folder-scope', 2, 0, true, $1, 1200, true)`,
      [testUserId],
    );

    const root = await service.listSharedChildren("folder-scope", { limit: 50, offset: 0 });
    expect(root.items.map((item: { id: number; kind: string }) => [item.id, item.kind]))
      .toEqual([[201, "folder"]]);
    const nested = await service.listSharedChildren(
      "folder-scope",
      { parentId: 201, limit: 50, offset: 0 },
    );
    expect(nested.items.map((item: { id: number; kind: string }) => [item.id, item.kind]))
      .toEqual([[1300, "file"]]);
    await expect(service.resolveSharedFolderFile(await service.findShareByToken("folder-scope"), 1301))
      .rejects.toBeInstanceOf(NotFoundException);

    await expect(service.incrementFolderDownloadCount("folder-scope", 1300))
      .resolves.toEqual({ downloadCount: "1" });
    await dataSource.query(
      `UPDATE "${schema}"."files" SET "parentId" = 202 WHERE id = 1300`,
    );
    await expect(service.incrementFolderDownloadCount("folder-scope", 1300))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await counters())["folder-scope"]).toBe(1);

    await dataSource.query(
      `UPDATE "${schema}"."files" SET "parentId" = 201 WHERE id = 1300`,
    );
    const concurrent = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.incrementFolderDownloadCount("folder-scope", 1300),
      ),
    );
    expect(concurrent.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await counters())["folder-scope"]).toBe(2);

    await dataSource.query(
      `INSERT INTO "${schema}"."folders" (id, name, "parentId", "userId", "isDeleted")
       VALUES (199, 'Deleted ancestor', NULL, $1, true)`,
      [testUserId],
    );
    await dataSource.query(
      `INSERT INTO "${schema}"."files"
       (id, name, "mimeType", size, "isFolder", "isDeleted", "userId", "parentId", "folderId")
       VALUES (1199, 'Deleted ancestor', 'application/zip', 0, true, true, $1, NULL, 199)`,
      [testUserId],
    );
    await dataSource.query(
      `UPDATE "${schema}"."folders" SET "parentId" = 199 WHERE id = 200`,
    );
    await expect(service.listSharedChildren("folder-scope", { limit: 50, offset: 0 }))
      .rejects.toBeInstanceOf(NotFoundException);
    await dataSource.query(
      `UPDATE ${table} SET "downloadCount" = 0 WHERE token = 'folder-scope'`,
    );
    await expect(service.incrementFolderDownloadCount("folder-scope", 1300))
      .rejects.toBeInstanceOf(NotFoundException);
    expect((await counters())["folder-scope"]).toBe(0);
  });

  it("миграция up сохраняет старые строки с null, а down удаляет только maxDownloads", async () => {
    await migration.down(migrationRunner);
    try {
      await dataSource.query(
        `INSERT INTO ${table} ("token", "downloadCount", "userId", "fileId") VALUES ($1, $2, $3, $4)`,
        ["existing", 7, testUserId, testFileId],
      );
      await migration.up(migrationRunner);
      expect(
        await dataSource.query(`SELECT "maxDownloads" FROM ${table}`),
      ).toEqual([{ maxDownloads: null }]);
      await migration.down(migrationRunner);
      const columns: Array<{ column_name: string }> = await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'share_links'`,
        [schema],
      );
      expect(columns.map((c) => c.column_name)).not.toContain(
        "maxDownloads",
      );
      expect(await counters()).toEqual({ existing: 7 });
    } finally {
      await migration.up(migrationRunner);
    }
  });

  it("5 concurrent wrong passwords → exactly 5 failedAttempts + lock", async () => {
    const passwordHash = await bcrypt.hash("secret", 10);
    // Create user/file tables (not in migration) and insert test data via repos.
    await dataSource.query(`SET search_path TO "${schema}"`);
    await new CreateFilesTable1746824920000().up(migrationRunner);
    await new AddFileUploadId1746825080000().up(migrationRunner);
    await dataSource.query(
      `INSERT INTO "${schema}"."users" ("id", "email", "password", "isActive") VALUES ($1, $2, $3, $4)`,
      [1, "lockout@test", "test-password", true],
    );
    await dataSource.query(
      `INSERT INTO "${schema}"."files" ("id", "name", "mimeType", "size", "isFolder", "isDeleted", "userId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [1, "test.png", "image/png", 100, false, false, 1],
    );
    await dataSource.getRepository(ShareLinkEntity).save({
      token: "locktest", password: passwordHash, maxDownloads: null,
      downloadCount: 0, isActive: true, expiresAt: null,
      userId: 1, fileId: 1, failedAttempts: 0, lockedUntil: null,
    } as any);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => service.verifySharePassword("locktest", "wrong")),
    );

    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? "success" : r.reason?.message ?? "error",
    );
    for (const o of outcomes) {
      expect(["Invalid password", "Too many password attempts"]).toContain(o);
    }

    const share = await dataSource.getRepository(ShareLinkEntity).findOne({
      where: { token: "locktest" },
    });
    expect(share).not.toBeNull();
    expect(share!.failedAttempts).toBe(5);
    expect(share!.lockedUntil).not.toBeNull();
    expect(share!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  it("истёкший lock + 1 wrong password → series reset: failedAttempts=1, lockedUntil=NULL", async () => {
    const passwordHash = await bcrypt.hash("secret", 10);
    await dataSource.query(`SET search_path TO "${schema}"`);
    await new CreateFilesTable1746824920000().up(migrationRunner);
    await new AddFileUploadId1746825080000().up(migrationRunner);
    await dataSource.query(
      `INSERT INTO "${schema}"."users" ("id", "email", "password", "isActive") VALUES ($1, $2, $3, $4)`,
       [2, "expirelockout@test", "test-password", true],
    );
    await dataSource.query(
      `INSERT INTO "${schema}"."files" ("id", "name", "mimeType", "size", "isFolder", "isDeleted", "userId") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [2, "test.png", "image/png", 100, false, false, 2],
    );
    await dataSource.getRepository(ShareLinkEntity).save({
      token: "expiretest", password: passwordHash, maxDownloads: null,
      downloadCount: 0, isActive: true, expiresAt: null,
      userId: 2, fileId: 2, failedAttempts: 5, lockedUntil: new Date(Date.now() - 60000),
    } as any);

    await expect(service.verifySharePassword("expiretest", "wrong")).rejects.toThrow(
      "Invalid password",
    );

    const share = await dataSource.getRepository(ShareLinkEntity).findOne({
      where: { token: "expiretest" },
    });
    expect(share).not.toBeNull();
    expect(share!.failedAttempts).toBe(1);
    expect(share!.lockedUntil).toBeNull();
  });
});
