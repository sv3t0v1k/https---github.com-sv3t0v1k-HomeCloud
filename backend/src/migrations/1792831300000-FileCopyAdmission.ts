import { MigrationInterface, QueryRunner } from "typeorm";

export class FileCopyAdmission1792831300000 implements MigrationInterface {
  name = "FileCopyAdmission1792831300000";

  async up(runner: QueryRunner): Promise<void> {
    // Serialize global admission decisions across backend replicas.
    // Never retain this row lock during physical file I/O.
    await runner.query(`
      CREATE TABLE "file_copy_admission" (
        "id" boolean PRIMARY KEY DEFAULT true,
        CONSTRAINT "CHK_file_copy_admission_singleton"
          CHECK ("id" = true)
      )
    `);

    await runner.query(`
      INSERT INTO "file_copy_admission" ("id") VALUES (true)
    `);

    // Active reservations remain durable across process crashes.
    // Cleanup must be proven safe before changing their state.
    await runner.query(`
      CREATE TABLE "file_copy_operations" (
        "id" uuid PRIMARY KEY,

        "userId" integer NOT NULL
          REFERENCES "users"("id") ON DELETE RESTRICT,

        "sourceFileId" integer NOT NULL,

        "storageLocationId" uuid NOT NULL
          REFERENCES "storage_locations"("id") ON DELETE RESTRICT,

        "relativeObjectKey" varchar(500) NOT NULL,

        "bytes" bigint NOT NULL,

        "state" varchar(20) NOT NULL DEFAULT 'reserved',

        "resultFileId" integer,
        "cleanupClaimId" uuid,

        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "CHK_file_copy_bytes"
          CHECK ("bytes" >= 0),

        CONSTRAINT "CHK_file_copy_key"
          CHECK (
            length("relativeObjectKey") > 0
            AND left("relativeObjectKey", 1) <> '/'
          ),

        CONSTRAINT "CHK_file_copy_state"
          CHECK (
            "state" IN (
              'reserved',
              'cleanup_required',
              'committed',
              'released'
            )
          ),

        CONSTRAINT "CHK_file_copy_cleanup_claim"
          CHECK (
            "cleanupClaimId" IS NULL
            OR "state" = 'cleanup_required'
          ),

        CONSTRAINT "CHK_file_copy_committed"
          CHECK (
            "state" <> 'committed'
            OR "resultFileId" IS NOT NULL
          )
      )
    `);

    // One unresolved operation per user, including recovery.
    await runner.query(`
      CREATE UNIQUE INDEX "UQ_file_copy_active_user"
      ON "file_copy_operations" ("userId")
      WHERE "state" IN ('reserved', 'cleanup_required')
    `);

    await runner.query(`
      CREATE UNIQUE INDEX "UQ_file_copy_object"
      ON "file_copy_operations" (
        "storageLocationId",
        "relativeObjectKey"
      )
    `);

    await runner.query(`
      CREATE INDEX "IDX_file_copy_active"
      ON "file_copy_operations" ("state", "createdAt")
      WHERE "state" IN ('reserved', 'cleanup_required')
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    const rows: unknown[] = await runner.query(`
      SELECT 1 FROM "file_copy_operations" LIMIT 1
    `);

    // Do not discard recovery evidence.
    if (rows.length !== 0) {
      throw new Error("Copy operation records prevent schema rollback");
    }

    await runner.query(`DROP TABLE "file_copy_operations"`);
    await runner.query(`DROP TABLE "file_copy_admission"`);
  }
}
