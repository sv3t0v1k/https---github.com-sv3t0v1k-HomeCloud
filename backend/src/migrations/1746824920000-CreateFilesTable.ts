import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateFilesTable1746824920000
  implements MigrationInterface
{
  name = "CreateFilesTable1746824920000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "files" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL,
        "storagePath" VARCHAR(500),
        "size" BIGINT DEFAULT 0 NOT NULL,
        "mimeType" VARCHAR(100),
        "checksum" TEXT,
        "isFolder" BOOLEAN DEFAULT FALSE NOT NULL,
        "isDeleted" BOOLEAN DEFAULT FALSE NOT NULL,
        "isStarred" BOOLEAN DEFAULT FALSE NOT NULL,
        "deletedAt" TIMESTAMP,
        "parentId" INTEGER,
        "version" BIGINT DEFAULT 0 NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_files_parentId" ON "files"("parentId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_files_isDeleted" ON "files"("isDeleted")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_files_mimeType" ON "files"("mimeType")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_mimeType"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_isDeleted"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_parentId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "files"`);
  }
}