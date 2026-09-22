import { randomUUID } from "node:crypto";
import { DataSource, QueryRunner } from "typeorm";
import { ShareLockedUntilTimestamptz1746825120000 } from "../migrations/1746825120000-ShareLockedUntilTimestamptz";

const testDatabaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres(
  "ShareLockedUntilTimestamptz migration — реальный PostgreSQL",
  () => {
    const migration = new ShareLockedUntilTimestamptz1746825120000();
    let dataSource: DataSource;
    let queryRunner: QueryRunner;
    let schema: string;

    beforeAll(async () => {
      dataSource = new DataSource({ type: "postgres", url: testDatabaseUrl });
      await dataSource.initialize();
    });

  afterEach(async () => {
    if (queryRunner && !queryRunner.isReleased) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      await queryRunner.release();
    }
    if (schema)
      await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });

    afterAll(async () => {
      if (dataSource?.isInitialized) await dataSource.destroy();
    });

    async function prepare(sessionTimezone: string): Promise<void> {
      schema = `locked_until_${randomUUID().replace(/-/g, "")}`;
      await dataSource.query(`CREATE SCHEMA "${schema}"`);
      queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();
      await queryRunner.query(`SET LOCAL search_path TO "${schema}"`);
      await queryRunner.query(`SET LOCAL TIME ZONE '${sessionTimezone}'`);
      await queryRunner.query(`
      CREATE TABLE "share_links" (
        "id" INTEGER PRIMARY KEY,
        "lockedUntil" TIMESTAMP WITHOUT TIME ZONE NULL
      )
    `);
      await queryRunner.query(`
      INSERT INTO "share_links" ("id", "lockedUntil") VALUES
        (1, NULL),
        (2, TIMESTAMP '1999-01-02 03:04:05')
    `);
    }

    async function runUp(sessionTimezone: string) {
      await prepare(sessionTimezone);
      const transactionRows: Array<{ transaction_ms: string }> =
        await queryRunner.query(`
        SELECT (EXTRACT(EPOCH FROM transaction_timestamp()) * 1000)::bigint::text AS transaction_ms
      `);
      await migration.up(queryRunner);
      const rows: Array<{ id: number; locked_ms: string | null }> =
        await queryRunner.query(`
        SELECT "id", (EXTRACT(EPOCH FROM "lockedUntil") * 1000)::bigint::text AS locked_ms
        FROM "share_links"
        ORDER BY "id"
      `);
      const column: Array<{ data_type: string }> = await queryRunner.query(
        `
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'share_links' AND column_name = 'lockedUntil'
    `,
        [schema],
      );
      return {
        transactionMs: Number(transactionRows[0].transaction_ms),
        rows,
        column,
      };
    }

    it.each(["UTC", "Asia/Vladivostok"])(
      "up сохраняет NULL и создаёт новый абсолютный lock при session timezone %s",
      async (sessionTimezone) => {
        const result = await runUp(sessionTimezone);
        expect(result.rows[0]).toEqual({ id: 1, locked_ms: null });
        const lockedMs = Number(result.rows[1].locked_ms);
        expect(lockedMs).toBe(result.transactionMs + 15 * 60_000);
        expect(result.column).toEqual([
          { data_type: "timestamp with time zone" },
        ]);
        await queryRunner.rollbackTransaction();
      },
    );

    it("down детерминированно записывает UTC wall-clock", async () => {
      await runUp("Asia/Vladivostok");
      await queryRunner.query(`
      UPDATE "share_links"
      SET "lockedUntil" = TIMESTAMPTZ '2030-01-02 03:04:05+00'
      WHERE "id" = 2
    `);
      await migration.down(queryRunner);
      const rows = await queryRunner.query(`
      SELECT "lockedUntil"::text AS value
      FROM "share_links"
      WHERE "id" = 2
    `);
      expect(rows).toEqual([{ value: "2030-01-02 03:04:05" }]);
      await queryRunner.rollbackTransaction();
    });
  },
);
