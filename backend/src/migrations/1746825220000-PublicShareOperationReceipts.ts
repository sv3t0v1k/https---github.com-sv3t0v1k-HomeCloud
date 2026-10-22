import { MigrationInterface, QueryRunner } from "typeorm";

/** A completed create and its receipt will be committed in the same transaction. */
export class PublicShareOperationReceipts1746825220000 implements MigrationInterface {
  name = "PublicShareOperationReceipts1746825220000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "public_share_operations" (
      "id" bigserial PRIMARY KEY,
      "shareLinkId" integer REFERENCES "share_links"("id") ON DELETE SET NULL,
      "shareRootFolderId" integer REFERENCES "folders"("id") ON DELETE SET NULL,
      "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "kind" varchar(16) NOT NULL CHECK ("kind" IN ('mkdir', 'upload_session')),
      "idempotencyKey" uuid NOT NULL,
      "requestSha256" varchar(64) NOT NULL
        CHECK ("requestSha256" ~ '^[0-9a-f]{64}$'),
      "resultFolderId" integer REFERENCES "folders"("id") ON DELETE SET NULL,
      "resultUploadSessionId" integer REFERENCES "upload_sessions"("id") ON DELETE SET NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "expiresAt" timestamptz NOT NULL,
      CONSTRAINT "CHK_public_share_operation_result"
        CHECK (("kind" = 'mkdir' AND "resultUploadSessionId" IS NULL) OR
               ("kind" = 'upload_session' AND "resultFolderId" IS NULL)),
      CONSTRAINT "CHK_public_share_operation_expiry"
        CHECK ("expiresAt" > "createdAt")
    )`);
    await runner.query(`CREATE UNIQUE INDEX "uq_public_share_operation_retry"
      ON "public_share_operations"("shareLinkId", "kind", "idempotencyKey")
      WHERE "shareLinkId" IS NOT NULL`);
    await runner.query(`CREATE INDEX "idx_public_share_operation_expiry"
      ON "public_share_operations"("expiresAt")`);
    await runner.query(`CREATE FUNCTION guard_public_share_operation()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."userId" IS DISTINCT FROM OLD."userId" OR
             NEW.kind IS DISTINCT FROM OLD.kind OR
             NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR
             NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256" OR
             NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
             NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
             (NEW."shareLinkId" IS DISTINCT FROM OLD."shareLinkId" AND NEW."shareLinkId" IS NOT NULL) OR
             (NEW."shareRootFolderId" IS DISTINCT FROM OLD."shareRootFolderId" AND NEW."shareRootFolderId" IS NOT NULL) OR
             (NEW."resultFolderId" IS DISTINCT FROM OLD."resultFolderId" AND NEW."resultFolderId" IS NOT NULL) OR
             (NEW."resultUploadSessionId" IS DISTINCT FROM OLD."resultUploadSessionId" AND NEW."resultUploadSessionId" IS NOT NULL)
          THEN RAISE EXCEPTION 'Public share operation receipt is immutable'; END IF;
          RETURN NEW;
        END IF;
        IF NEW."shareLinkId" IS NULL OR NEW."shareRootFolderId" IS NULL OR
           (NEW.kind = 'mkdir' AND NEW."resultFolderId" IS NULL) OR
           (NEW.kind = 'upload_session' AND NEW."resultUploadSessionId" IS NULL)
        THEN RAISE EXCEPTION 'Incomplete public share operation receipt'; END IF;
        IF NOT EXISTS (SELECT 1 FROM "share_links" link
          JOIN "files" mirror ON mirror.id = link."fileId"
          WHERE link.id = NEW."shareLinkId" AND link."userId" = NEW."userId"
            AND link."allowUpload" AND link."isFolder" AND link."isActive"
            AND (link."expiresAt" IS NULL OR link."expiresAt" > now())
            AND mirror."folderId" = NEW."shareRootFolderId"
            AND mirror."userId" = NEW."userId" AND mirror."isFolder"
            AND NOT mirror."isDeleted")
        THEN RAISE EXCEPTION 'Invalid public share operation root'; END IF;
        IF (NEW.kind = 'mkdir' AND NOT EXISTS (
              SELECT 1 FROM "folders" WHERE id = NEW."resultFolderId"
                AND "userId" = NEW."userId")) OR
           (NEW.kind = 'upload_session' AND NOT EXISTS (
              SELECT 1 FROM "upload_sessions" WHERE id = NEW."resultUploadSessionId"
                AND "userId" = NEW."userId" AND origin = 'public'
                AND "shareLinkId" = NEW."shareLinkId"
                AND "shareRootFolderId" = NEW."shareRootFolderId"))
        THEN RAISE EXCEPTION 'Public share operation result does not match binding'; END IF;
        IF NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT folder.id, folder."parentId", ARRAY[folder.id] AS path
            FROM "folders" folder
            JOIN "files" mirror ON mirror."folderId" = folder.id
            LEFT JOIN "upload_sessions" session ON session.id = NEW."resultUploadSessionId"
            WHERE folder.id = CASE WHEN NEW.kind = 'mkdir' THEN NEW."resultFolderId" ELSE session."parentId" END
              AND folder."userId" = NEW."userId"
              AND NOT folder."isDeleted" AND mirror."userId" = NEW."userId"
              AND mirror."isFolder" AND NOT mirror."isDeleted"
            UNION ALL
            SELECT parent.id, parent."parentId", ancestors.path || parent.id
            FROM "folders" parent
            JOIN ancestors ON ancestors."parentId" = parent.id
            JOIN "files" mirror ON mirror."folderId" = parent.id
            WHERE parent."userId" = NEW."userId" AND NOT parent."isDeleted"
              AND mirror."userId" = NEW."userId" AND mirror."isFolder"
              AND NOT mirror."isDeleted" AND NOT parent.id = ANY(ancestors.path)
              AND cardinality(ancestors.path) < 128
          ) SELECT 1 FROM ancestors WHERE id = NEW."shareRootFolderId"
        ) THEN RAISE EXCEPTION 'Public share operation result is outside root'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(`CREATE TRIGGER "TR_public_share_operation"
      BEFORE INSERT OR UPDATE ON "public_share_operations"
      FOR EACH ROW EXECUTE FUNCTION guard_public_share_operation()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query(
      `SELECT EXISTS(SELECT 1 FROM "public_share_operations") AS has_receipts`,
    );
    if (row.has_receipts)
      throw new Error("Public share receipts prevent schema rollback");
    await runner.query(`DROP TABLE "public_share_operations"`);
    await runner.query(`DROP FUNCTION guard_public_share_operation()`);
  }
}
