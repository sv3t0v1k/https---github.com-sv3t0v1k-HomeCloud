import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNameNotEmptyCheck1746825060000 implements MigrationInterface {
  name = "AddNameNotEmptyCheck1746825060000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-validation: ensure no empty names exist
    const emptyFolders: any[] = await queryRunner.query(`
      SELECT id FROM "folders"
      WHERE "name" = '' OR "name" IS NULL
    `);
    if (emptyFolders.length > 0) {
      throw new Error(
        `Cannot add CHECK: empty folder names found: ${emptyFolders.map(r => r.id).join(", ")}`,
      );
    }

    const emptyFiles: any[] = await queryRunner.query(`
      SELECT id FROM "files"
      WHERE "name" = '' OR "name" IS NULL
    `);
    if (emptyFiles.length > 0) {
      throw new Error(
        `Cannot add CHECK: empty file names found: ${emptyFiles.map(r => r.id).join(", ")}`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE "folders"
      ADD CONSTRAINT "folders_name_not_empty"
      CHECK ("name" <> '' AND "name" IS NOT NULL)
    `);

    await queryRunner.query(`
      ALTER TABLE "files"
      ADD CONSTRAINT "files_name_not_empty"
      CHECK ("name" <> '' AND "name" IS NOT NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "files"
      DROP CONSTRAINT IF EXISTS "files_name_not_empty"
    `);
    await queryRunner.query(`
      ALTER TABLE "folders"
      DROP CONSTRAINT IF EXISTS "folders_name_not_empty"
    `);
  }
}
