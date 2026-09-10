import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissingIndexes1746825010000
  implements MigrationInterface
{
  name = "AddMissingIndexes1746825010000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_files_userId" ON "files"("userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_folders_userId" ON "folders"("userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_share_links_userId" ON "share_links"("userId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_share_links_fileId" ON "share_links"("fileId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id_revoked" ON "refresh_tokens"("user_id", "revoked")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_refresh_tokens_user_id_revoked"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_fileId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_share_links_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_folders_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_files_userId"`);
  }
}
