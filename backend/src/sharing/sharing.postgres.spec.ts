import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, QueryRunner } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UserEntity } from "../entities/user.entity";
import { AddShareMaxDownloads1746825090000 } from "../migrations/1746825090000-AddShareMaxDownloads";
import { SharingService } from "./sharing.service";

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
      extra: { max: 10 },
    });
    await dataSource.initialize();
    await dataSource.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await dataSource.query(`CREATE TABLE ${table} (
      "id" SERIAL PRIMARY KEY,
      "token" VARCHAR(255) NOT NULL UNIQUE,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "expiresAt" TIMESTAMP NULL,
      "downloadCount" BIGINT NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
    migrationRunner = dataSource.createQueryRunner();
    await migrationRunner.connect();
    // У миграции имя таблицы без schema: исключаем public из search_path.
    await migrationRunner.query(`SET search_path TO "${schema}"`);
    await migration.up(migrationRunner);
    service = new SharingService(
      dataSource.getRepository(ShareLinkEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(UserEntity),
      new ConfigService(),
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
    await dataSource.query(`TRUNCATE TABLE ${table}`);
  });

  async function insertShare(
    token: string,
    maxDownloads: number | null,
    downloadCount = 0,
    active = true,
    expiresAt: Date | null = null,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ${table} ("token", "maxDownloads", "downloadCount", "isActive", "expiresAt") VALUES ($1, $2, $3, $4, $5)`,
      [token, maxDownloads, downloadCount, active, expiresAt],
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

  it("миграция up сохраняет старые строки с null, а down удаляет только maxDownloads", async () => {
    await migration.down(migrationRunner);
    try {
      await dataSource.query(
        `INSERT INTO ${table} ("token", "downloadCount") VALUES ($1, $2)`,
        ["existing", 7],
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
      expect(columns.map((column) => column.column_name)).not.toContain(
        "maxDownloads",
      );
      expect(await counters()).toEqual({ existing: 7 });
    } finally {
      await migration.up(migrationRunner);
    }
  });
});
