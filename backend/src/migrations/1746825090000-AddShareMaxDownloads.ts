import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShareMaxDownloads1746825090000
  implements MigrationInterface
{
  name = "AddShareMaxDownloads1746825090000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable: existing shares inherit `NULL` => unlimited. No backfill, no
    // unrelated schema changes.
    await queryRunner.query(`
      ALTER TABLE "share_links" ADD COLUMN IF NOT EXISTS "maxDownloads" BIGINT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links" DROP COLUMN IF EXISTS "maxDownloads"
    `);
  }
}
