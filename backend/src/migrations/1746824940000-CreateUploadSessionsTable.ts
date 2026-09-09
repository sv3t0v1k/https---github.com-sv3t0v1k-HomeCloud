import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateUploadSessionsTable1746824940000
  implements MigrationInterface
{
  name = "CreateUploadSessionsTable1746824940000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "upload_sessions" (
        "id" SERIAL PRIMARY KEY,
        "uploadId" VARCHAR(255) NOT NULL,
        "filename" VARCHAR(255) NOT NULL,
        "totalSize" BIGINT NOT NULL,
        "uploadedSize" BIGINT DEFAULT 0 NOT NULL,
        "chunkSize" INTEGER DEFAULT 0 NOT NULL,
        "totalChunks" INTEGER DEFAULT 0 NOT NULL,
        "uploadedChunks" JSON DEFAULT '[]' NOT NULL,
        "tempPath" VARCHAR(500) NOT NULL,
        "parentId" INTEGER,
        "status" VARCHAR(20) DEFAULT 'pending' NOT NULL,
        "expiresAt" TIMESTAMP,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_upload_sessions_uploadId" ON "upload_sessions"("uploadId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_upload_sessions_uploadId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "upload_sessions"`);
  }
}