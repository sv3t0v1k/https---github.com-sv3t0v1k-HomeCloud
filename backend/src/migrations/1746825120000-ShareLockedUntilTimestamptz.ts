import { MigrationInterface, QueryRunner } from "typeorm";

export class ShareLockedUntilTimestamptz1746825120000 implements MigrationInterface {
  name = "ShareLockedUntilTimestamptz1746825120000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        ADD COLUMN "lockedUntilWasSet" BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await queryRunner.query(`
      UPDATE "share_links"
      SET "lockedUntilWasSet" = TRUE
      WHERE "lockedUntil" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "share_links"
        ALTER COLUMN "lockedUntil" TYPE TIMESTAMP WITH TIME ZONE
        USING NULL::TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      UPDATE "share_links"
      SET "lockedUntil" = CURRENT_TIMESTAMP + INTERVAL '15 minutes'
      WHERE "lockedUntilWasSet"
    `);
    await queryRunner.query(`
      ALTER TABLE "share_links"
        DROP COLUMN "lockedUntilWasSet"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "share_links"
        ALTER COLUMN "lockedUntil" TYPE TIMESTAMP WITHOUT TIME ZONE
        USING "lockedUntil" AT TIME ZONE 'UTC'
    `);
  }
}
