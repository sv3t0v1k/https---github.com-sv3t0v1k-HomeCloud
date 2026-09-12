import { MigrationInterface, QueryRunner } from "typeorm";

export class ShareLinksTokenUnique1746825040000 implements MigrationInterface {
  name = "ShareLinksTokenUnique1746825040000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-validation: ensure no duplicate tokens exist
    const duplicates: any[] = await queryRunner.query(`
      SELECT "token", COUNT(*) as cnt
      FROM "share_links"
      GROUP BY "token"
      HAVING COUNT(*) > 1
    `);
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot create UNIQUE constraint: duplicate tokens found: ${duplicates.map(d => d.token).join(", ")}`,
      );
    }

    // Replace non-unique index with UNIQUE index
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_token"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_share_links_token"
      ON "share_links" ("token")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_token"`);
    await queryRunner.query(`
      CREATE INDEX "idx_share_links_token"
      ON "share_links" ("token")
    `);
  }
}
