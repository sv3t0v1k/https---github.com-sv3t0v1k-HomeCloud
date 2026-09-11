import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStorageUsedCheck1746825020000 implements MigrationInterface {
  name = "AddStorageUsedCheck1746825020000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "storage_used_nonnegative" CHECK ("storageUsed" >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP CONSTRAINT IF EXISTS "storage_used_nonnegative"
    `);
  }
}
