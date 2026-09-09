import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateFoldersTable1746824910000
  implements MigrationInterface
{
  name = "CreateFoldersTable1746824910000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "folders" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL,
        "isDeleted" BOOLEAN DEFAULT FALSE NOT NULL,
        "deletedAt" TIMESTAMP,
        "parentId" INTEGER,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_folders_parentId" ON "folders"("parentId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_folders_parentId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "folders"`);
  }
}