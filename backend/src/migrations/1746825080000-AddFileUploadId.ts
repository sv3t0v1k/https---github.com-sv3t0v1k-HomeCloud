import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFileUploadId1746825080000 implements MigrationInterface {
  name = "AddFileUploadId1746825080000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add nullable uploadId column to support idempotent completeUpload.
    // Nullable so existing rows are unaffected.
    await queryRunner.query(`
      ALTER TABLE "files"
      ADD COLUMN IF NOT EXISTS "uploadId" VARCHAR(255)
    `);

    // Partial index for idempotency lookups (only non-null uploadId values).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_files_uploadId"
      ON "files"("uploadId")
      WHERE "uploadId" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_uploadId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "uploadId"`);
  }
}