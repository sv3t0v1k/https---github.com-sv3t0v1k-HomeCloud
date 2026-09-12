import { MigrationInterface, QueryRunner } from "typeorm";

export class UploadedChunksJsonb1746825070000 implements MigrationInterface {
  name = "UploadedChunksJsonb1746825070000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      ALTER COLUMN "uploadedChunks" TYPE jsonb
      USING "uploadedChunks"::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      ALTER COLUMN "uploadedChunks" TYPE json
      USING "uploadedChunks"::json
    `);
  }
}
