import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShareFailedAttempts1746825100000
  implements MigrationInterface
{
  name = "AddShareFailedAttempts1746825100000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        ADD COLUMN IF NOT EXISTS "failedAttempts" SMALLINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        DROP COLUMN IF EXISTS "failedAttempts",
        DROP COLUMN IF EXISTS "lockedUntil"
    `);
  }
}
