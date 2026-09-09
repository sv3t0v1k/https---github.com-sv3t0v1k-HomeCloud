import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateShareLinksTable1746824930000
  implements MigrationInterface
{
  name = "CreateShareLinksTable1746824930000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "share_links" (
        "id" SERIAL PRIMARY KEY,
        "token" VARCHAR(255) NOT NULL,
        "password" VARCHAR(255),
        "expiresAt" TIMESTAMP,
        "isActive" BOOLEAN DEFAULT TRUE NOT NULL,
        "downloadCount" BIGINT DEFAULT 0 NOT NULL,
        "isFolder" BOOLEAN DEFAULT FALSE NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
        "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "fileId" INTEGER NOT NULL REFERENCES "files"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_share_links_token" ON "share_links"("token")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_token"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "share_links"`);
  }
}