import { MigrationInterface, QueryRunner } from "typeorm";

export class AddParentIdForeignKeys1746825030000 implements MigrationInterface {
  name = "AddParentIdForeignKeys1746825030000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-validation: check for orphaned parentId references before adding constraints

    const orphanedFolders: any[] = await queryRunner.query(`
      SELECT f.id FROM "folders" f
      WHERE f."parentId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "folders" p WHERE p.id = f."parentId")
    `);
    if (orphanedFolders.length > 0) {
      throw new Error(
        `Cannot add FK: orphaned folder parentIds found: ${orphanedFolders.map(r => r.id).join(", ")}`,
      );
    }

    const orphanedFiles: any[] = await queryRunner.query(`
      SELECT f.id FROM "files" f
      WHERE f."parentId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "folders" p WHERE p.id = f."parentId")
    `);
    if (orphanedFiles.length > 0) {
      throw new Error(
        `Cannot add FK: orphaned file parentIds found: ${orphanedFiles.map(r => r.id).join(", ")}`,
      );
    }

    const orphanedSessions: any[] = await queryRunner.query(`
      SELECT u.id FROM "upload_sessions" u
      WHERE u."parentId" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "folders" p WHERE p.id = u."parentId")
    `);
    if (orphanedSessions.length > 0) {
      throw new Error(
        `Cannot add FK: orphaned upload_session parentIds found: ${orphanedSessions.map(r => r.id).join(", ")}`,
      );
    }

    // Add FK constraints with ON DELETE SET NULL
    // SET NULL chosen because: permanent folder deletion is handled by
    // application code (recursive subtree deletion); soft delete keeps
    // the folder row (children retain valid parentId); as a safety net,
    // if a parent is ever removed, children become root-level items.

    await queryRunner.query(`
      ALTER TABLE "folders"
      ADD CONSTRAINT "fk_folders_parentId"
      FOREIGN KEY ("parentId") REFERENCES "folders"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "files"
      ADD CONSTRAINT "fk_files_parentId"
      FOREIGN KEY ("parentId") REFERENCES "folders"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "upload_sessions"
      ADD CONSTRAINT "fk_upload_sessions_parentId"
      FOREIGN KEY ("parentId") REFERENCES "folders"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "upload_sessions" DROP CONSTRAINT IF EXISTS "fk_upload_sessions_parentId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT IF EXISTS "fk_files_parentId"`);
    await queryRunner.query(`ALTER TABLE "folders" DROP CONSTRAINT IF EXISTS "fk_folders_parentId"`);
  }
}
