import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDownloadCapabilities1746825140000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "download_capabilities" (
      "tokenHash" VARCHAR(64) PRIMARY KEY,
      "userId" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "fileId" INTEGER NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      UNIQUE ("userId", "fileId")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_download_capabilities_expiry" ON "download_capabilities" ("expiresAt")`,
    );
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "download_capabilities"`);
  }
}
