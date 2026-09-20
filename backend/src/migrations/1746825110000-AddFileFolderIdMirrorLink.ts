import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Stage A: explicit FolderEntity <-> FileEntity mirror relation for NEW folders.
 *
 * - Adds nullable `files.folderId`.
 * - FK `files.folderId -> folders.id` ON DELETE SET NULL ON UPDATE CASCADE.
 * - Partial UNIQUE index on non-NULL folderId (one folder -> one mirror).
 * - Compatibility CHECK (NOT VALID): folderId IS NULL OR isFolder = true.
 *   Existing legacy mirror rows (isFolder=true, folderId=NULL) are preserved;
 *   no backfill, no ID-equality assumptions.
 */
export class AddFileFolderIdMirrorLink1746825110000
  implements MigrationInterface
{
  name = "AddFileFolderIdMirrorLink1746825110000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PG16 idiom (matches existing migrations 1746825020000 / 1746825030000 / 1746825050000):
    // plain ADD CONSTRAINT + pre-drop. `IF NOT EXISTS` is a PG17 feature and
    // would fail on the project's target postgres:16-alpine.
    await queryRunner.query(`
      ALTER TABLE "files"
        ADD COLUMN IF NOT EXISTS "folderId" INTEGER
    `);

    await queryRunner.query(
      `ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "fk_files_folderId"`,
    );
    await queryRunner.query(`
      ALTER TABLE "files"
        ADD CONSTRAINT "fk_files_folderId"
        FOREIGN KEY ("folderId") REFERENCES "folders"("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_files_folderId"
        ON "files"("folderId")
        WHERE "folderId" IS NOT NULL
    `);

    await queryRunner.query(
      `ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "chk_files_folderId_or_isFolder"`,
    );
    await queryRunner.query(`
      ALTER TABLE "files"
        ADD CONSTRAINT "chk_files_folderId_or_isFolder"
        CHECK ("folderId" IS NULL OR "isFolder" = true) NOT VALID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "chk_files_folderId_or_isFolder"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_files_folderId"`);
    await queryRunner.query(
      `ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "fk_files_folderId"`,
    );
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "folderId"`);
  }
}