import { MigrationInterface, QueryRunner } from "typeorm";

export class DurableUploadChunks1746825130000 implements MigrationInterface {
  name = "DurableUploadChunks1746825130000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" ADD COLUMN "uploadedCount" integer NOT NULL DEFAULT 0, ADD COLUMN "accountingInitialized" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`CREATE TABLE "upload_chunks" (
      "sessionId" integer NOT NULL REFERENCES "upload_sessions"("id") ON DELETE CASCADE,
      "chunkIndex" integer NOT NULL CHECK ("chunkIndex" >= 0),
      "byteSize" integer NOT NULL CHECK ("byteSize" > 0),
      "sha256" varchar(64) NOT NULL,
      PRIMARY KEY ("sessionId", "chunkIndex")
    )`);
    // Existing counters, legacy JSONB, disk chunks and quota reservations stay
    // untouched. Legacy sessions hydrate once under their row lock on reuse.
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "upload_chunks"`);
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" DROP COLUMN "uploadedCount", DROP COLUMN "accountingInitialized"`,
    );
  }
}
