import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateArchiveDownloadCapabilities1792831200000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE archive_download_capabilities (
      id VARCHAR(32) PRIMARY KEY,
      "tokenHash" VARCHAR(64) NOT NULL,
      "userId" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      manifest JSONB NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_archive_download_capabilities_expiry" ON archive_download_capabilities ("expiresAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_archive_download_capabilities_user" ON archive_download_capabilities ("userId")`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE archive_download_capabilities`);
  }
}
