import { MigrationInterface, QueryRunner } from "typeorm";

/** Metadata only: public write routes are deliberately absent in this stage. */
export class PublicFolderShareBinding1746825210000 implements MigrationInterface {
  name = "PublicFolderShareBinding1746825210000";

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "share_links"
      ADD COLUMN "allowUpload" boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT "CHK_share_links_allowUpload_folder"
        CHECK (NOT "allowUpload" OR "isFolder")`);
    await runner.query(`ALTER TABLE "upload_sessions"
      ADD COLUMN "origin" varchar(6) NOT NULL DEFAULT 'owner',
      ADD COLUMN "shareLinkId" integer,
      ADD COLUMN "shareRootFolderId" integer,
      ADD CONSTRAINT "CHK_upload_sessions_public_origin"
        CHECK ("origin" IN ('owner', 'public') AND
          ("origin" <> 'owner' OR
            ("shareLinkId" IS NULL AND "shareRootFolderId" IS NULL))),
      ADD CONSTRAINT "FK_upload_sessions_shareLink"
        FOREIGN KEY ("shareLinkId") REFERENCES "share_links"("id") ON DELETE SET NULL,
      ADD CONSTRAINT "FK_upload_sessions_shareRootFolder"
        FOREIGN KEY ("shareRootFolderId") REFERENCES "folders"("id") ON DELETE SET NULL`);
    await runner.query(`CREATE INDEX "idx_upload_sessions_shareLinkId"
      ON "upload_sessions"("shareLinkId") WHERE "shareLinkId" IS NOT NULL`);

    await runner.query(`CREATE FUNCTION guard_public_upload_binding()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW.origin IS DISTINCT FROM OLD.origin OR
             (OLD.origin = 'public' AND
               (NEW."userId" IS DISTINCT FROM OLD."userId" OR
                NEW."parentId" IS DISTINCT FROM OLD."parentId")) OR
             (NEW."shareLinkId" IS DISTINCT FROM OLD."shareLinkId" AND
               NEW."shareLinkId" IS NOT NULL) OR
             (NEW."shareRootFolderId" IS DISTINCT FROM OLD."shareRootFolderId" AND
               NEW."shareRootFolderId" IS NOT NULL)
          THEN RAISE EXCEPTION 'Public upload binding is immutable'; END IF;
          RETURN NEW;
        END IF;

        IF NEW.origin = 'public' THEN
          IF NEW."shareLinkId" IS NULL OR NEW."shareRootFolderId" IS NULL OR
             NEW."parentId" IS NULL
          THEN RAISE EXCEPTION 'Public upload requires a complete binding'; END IF;
          IF NOT EXISTS (
            SELECT 1 FROM "share_links" link
            JOIN "files" mirror ON mirror.id = link."fileId"
            JOIN "folders" root ON root.id = mirror."folderId"
            WHERE link.id = NEW."shareLinkId" AND link."userId" = NEW."userId"
              AND link."isActive" AND link."isFolder" AND link."allowUpload"
              AND (link."expiresAt" IS NULL OR link."expiresAt" > now())
              AND mirror."userId" = NEW."userId" AND mirror."isFolder"
              AND NOT mirror."isDeleted" AND root.id = NEW."shareRootFolderId"
              AND root."userId" = NEW."userId" AND NOT root."isDeleted"
          ) THEN RAISE EXCEPTION 'Invalid public upload share root'; END IF;
          IF NOT EXISTS (
            WITH RECURSIVE ancestors AS (
              SELECT folder.id, folder."parentId", ARRAY[folder.id] AS path
              FROM "folders" folder
              JOIN "files" mirror ON mirror."folderId" = folder.id
              WHERE folder.id = NEW."parentId" AND folder."userId" = NEW."userId"
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
            )
            SELECT 1 FROM ancestors WHERE id = NEW."shareRootFolderId"
          ) THEN RAISE EXCEPTION 'Public upload target is outside share root'; END IF;
        END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(`CREATE TRIGGER "TR_public_upload_binding"
      BEFORE INSERT OR UPDATE ON "upload_sessions"
      FOR EACH ROW EXECUTE FUNCTION guard_public_upload_binding()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    const [active] = await runner.query(`SELECT
      EXISTS(SELECT 1 FROM "share_links" WHERE "allowUpload") AS upload_links,
      EXISTS(SELECT 1 FROM "upload_sessions" WHERE origin = 'public') AS public_sessions`);
    if (active.upload_links || active.public_sessions)
      throw new Error("Public sharing metadata prevents schema rollback");
    await runner.query(
      `DROP TRIGGER "TR_public_upload_binding" ON "upload_sessions"`,
    );
    await runner.query(`DROP FUNCTION guard_public_upload_binding()`);
    await runner.query(`DROP INDEX "idx_upload_sessions_shareLinkId"`);
    await runner.query(`ALTER TABLE "upload_sessions"
      DROP CONSTRAINT "FK_upload_sessions_shareRootFolder",
      DROP CONSTRAINT "FK_upload_sessions_shareLink",
      DROP CONSTRAINT "CHK_upload_sessions_public_origin",
      DROP COLUMN "shareRootFolderId",
      DROP COLUMN "shareLinkId",
      DROP COLUMN "origin"`);
    await runner.query(`ALTER TABLE "share_links"
      DROP CONSTRAINT "CHK_share_links_allowUpload_folder",
      DROP COLUMN "allowUpload"`);
  }
}
