import { MigrationInterface, QueryRunner } from "typeorm";

export const VALID_STATUSES = ["pending", "uploading", "completed", "aborted"];

export class UploadSessionStatusCheck1746825050000 implements MigrationInterface {
  name = "UploadSessionStatusCheck1746825050000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-validation: ensure no invalid status values exist
    const invalidStatuses: any[] = await queryRunner.query(`
      SELECT DISTINCT "status"
      FROM "upload_sessions"
      WHERE "status" NOT IN ('pending', 'uploading', 'completed', 'aborted')
    `);
    if (invalidStatuses.length > 0) {
      throw new Error(
        `Cannot add CHECK constraint: invalid status values found: ${invalidStatuses.map(s => s.status).join(", ")}`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      ADD CONSTRAINT "upload_session_status"
      CHECK ("status" IN ('pending', 'uploading', 'completed', 'aborted'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      DROP CONSTRAINT IF EXISTS "upload_session_status"
    `);
  }
}
