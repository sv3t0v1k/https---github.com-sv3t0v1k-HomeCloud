import { MigrationInterface, QueryRunner } from "typeorm";
import * as path from "node:path";
import { validateRoot } from "../storage/storage-mount-registry";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  SSD_UPLOAD_WORKSPACE_ID,
} from "../entities/upload-workspace.entity";

/** Whole-file checksum is fixed at admission. SSD admission requires an explicit
 * operator root mapping; runtime mount qualification remains mandatory. */
export class DurableUploadWholeSha2561746825200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Whole upload checksum migration requires a transaction");
    const roots = this.roots();
    await runner.query(
      `LOCK TABLE upload_sessions, ssd_finalization_operations IN ACCESS EXCLUSIVE MODE`,
    );
    const mismatched = await runner.query(
      `SELECT id FROM upload_sessions WHERE "workspaceId"=$1 AND "tempPath" IS DISTINCT FROM $2 || '/' || "uploadId" LIMIT 1`,
      [LEGACY_UPLOAD_WORKSPACE_ID, path.join(roots.legacy, ".tmp")],
    );
    if (mismatched.length) throw new Error("Existing legacy session root does not match operator mapping");
    await runner.query(`ALTER TABLE upload_sessions
      ADD COLUMN "expectedSha256" varchar(64),
      ADD CONSTRAINT "CHK_upload_sessions_expectedSha256"
        CHECK ("expectedSha256" IS NULL OR "expectedSha256" ~ '^[0-9a-f]{64}$')`);
    await runner.query(`CREATE FUNCTION guard_upload_whole_sha256() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW."expectedSha256" IS DISTINCT FROM OLD."expectedSha256"
          THEN RAISE EXCEPTION 'Upload whole checksum is immutable'; END IF;
        IF OLD."expectedSha256" IS NOT NULL AND
          ROW(NEW.filename,NEW."totalSize",NEW."chunkSize",NEW."totalChunks") IS DISTINCT FROM
          ROW(OLD.filename,OLD."totalSize",OLD."chunkSize",OLD."totalChunks")
          THEN RAISE EXCEPTION 'Checksummed upload metadata is immutable'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(`CREATE TRIGGER "TR_upload_whole_sha256" BEFORE UPDATE ON upload_sessions
      FOR EACH ROW EXECUTE FUNCTION guard_upload_whole_sha256()`);
    await runner.query(this.bindingGuard(roots.legacy, roots.ssd));
    await runner.query(`ALTER TABLE ssd_finalization_operations
      ADD COLUMN "mimeType" varchar(255) NOT NULL DEFAULT 'application/octet-stream',
      ADD COLUMN "mimeTypeCheckpointed" boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT "CHK_ssd_mime_type" CHECK ("mimeType" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')`);
    await runner.query(this.journalGuard(true));
    await runner.query(`CREATE FUNCTION check_ssd_mime_commit() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        SELECT * INTO op FROM ssd_finalization_operations WHERE id=NEW.id;
        IF op.state='committed' AND op."cleanupState"='pending' AND NOT EXISTS (
          SELECT 1 FROM files WHERE id=op."fileId" AND "mimeType"=op."mimeType")
          THEN RAISE EXCEPTION 'Incomplete finalization MIME commit'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(`CREATE CONSTRAINT TRIGGER "TR_ssd_mime_commit" AFTER UPDATE ON ssd_finalization_operations
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ssd_mime_commit()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Whole upload checksum migration requires a transaction");
    const roots = this.roots();
    await runner.query(
      `LOCK TABLE upload_sessions, ssd_finalization_operations IN ACCESS EXCLUSIVE MODE`,
    );
    if (
      (
        await runner.query(
          `SELECT 1 FROM upload_sessions WHERE "expectedSha256" IS NOT NULL LIMIT 1`,
        )
      ).length
    )
      throw new Error("Checksummed upload sessions prevent checksum rollback");
    if (
      (
        await runner.query(
          `SELECT 1 FROM ssd_finalization_operations WHERE "mimeTypeCheckpointed" LIMIT 1`,
        )
      ).length
    )
      throw new Error(
        "Checkpointed finalization MIME prevents checksum rollback",
      );
    await runner.query(
      `DROP TRIGGER "TR_ssd_mime_commit" ON ssd_finalization_operations`,
    );
    await runner.query(`DROP FUNCTION check_ssd_mime_commit()`);
    await runner.query(this.journalGuard(false));
    await runner.query(`ALTER TABLE ssd_finalization_operations
      DROP CONSTRAINT "CHK_ssd_mime_type", DROP COLUMN "mimeType", DROP COLUMN "mimeTypeCheckpointed"`);
    await runner.query(this.bindingGuard(roots.legacy, undefined, false));
    await runner.query(
      `DROP TRIGGER "TR_upload_whole_sha256" ON upload_sessions`,
    );
    await runner.query(`DROP FUNCTION guard_upload_whole_sha256()`);
    await runner.query(`ALTER TABLE upload_sessions
      DROP CONSTRAINT "CHK_upload_sessions_expectedSha256",
      DROP COLUMN "expectedSha256"`);
  }

  private roots(): { legacy: string; ssd?: string } {
    const legacy = process.env.STORAGE_PATH || "/storage";
    const ssd = process.env.UPLOAD_SSD_PATH || undefined;
    validateRoot(legacy);
    if (ssd) {
      validateRoot(ssd);
      if (
        ssd === legacy ||
        ssd.startsWith(legacy + path.sep) ||
        legacy.startsWith(ssd + path.sep)
      )
        throw new Error("SSD and HDD roots must be disjoint");
      if (ssd.length > 450) throw new Error("SSD root is too long");
    }
    return { legacy, ssd };
  }

  private bindingGuard(
    legacy: string,
    ssd?: string,
    includeHash = true,
  ): string {
    const quotedLegacy = path.join(legacy, ".tmp").replace(/'/g, "''");
    const ssdClause = ssd
      ? `OR (NEW."workspaceId"='${SSD_UPLOAD_WORKSPACE_ID}'::uuid AND
      NEW."tempPath"='${ssd.replace(/'/g, "''")}/' || NEW."uploadId" AND NEW."expectedSha256" IS NOT NULL)`
      : "";
    return `CREATE OR REPLACE FUNCTION guard_upload_session_binding() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."tempPath" IS DISTINCT FROM OLD."tempPath" OR NEW."uploadId" IS DISTINCT FROM OLD."uploadId"${includeHash ? ' OR NEW."expectedSha256" IS DISTINCT FROM OLD."expectedSha256"' : ""}
          THEN RAISE EXCEPTION 'Upload session binding is immutable'; END IF;
        END IF;
        IF NEW."uploadId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR NOT (
          (NEW."workspaceId"='${LEGACY_UPLOAD_WORKSPACE_ID}'::uuid AND NEW."tempPath"='${quotedLegacy}/' || NEW."uploadId") ${ssdClause})
        THEN RAISE EXCEPTION 'Invalid or inconsistent upload workspace binding'; END IF;
        RETURN NEW;
      END $body$`;
  }

  private journalGuard(includeMime: boolean): string {
    return `CREATE OR REPLACE FUNCTION guard_ssd_finalization_operation() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.state <> 'assembling' OR NEW."fileId" IS NOT NULL OR NEW."createdTransaction" <> pg_current_xact_id() OR
            NEW."targetArtifactDevice" IS NOT NULL OR NEW."targetArtifactInode" IS NOT NULL OR NEW."cleanupState" <> 'pending' OR
            NOT EXISTS (SELECT 1 FROM upload_sessions WHERE id=NEW."sessionId")
            THEN RAISE EXCEPTION 'Invalid new finalization operation'; END IF;
${
  includeMime
    ? `
          IF NEW."mimeType" <> 'application/octet-stream' OR NEW."mimeTypeCheckpointed"
            THEN RAISE EXCEPTION 'Invalid initial MIME checkpoint'; END IF;
          IF EXISTS (SELECT 1 FROM upload_sessions WHERE id=NEW."sessionId" AND "workspaceId"='${SSD_UPLOAD_WORKSPACE_ID}'::uuid) AND NOT EXISTS (
            SELECT 1 FROM upload_sessions WHERE id=NEW."sessionId" AND "expectedSha256"=NEW."expectedSha256" AND "tempPath"=NEW.binding->>'sourcePath' AND
              "workspaceId"::text=NEW.binding->>'sourceWorkspaceId')
            THEN RAISE EXCEPTION 'SSD finalization contract mismatch'; END IF;
`
    : ""
}
          RETURN NEW;
        END IF;
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Finalization journal is retained'; END IF;
        IF (to_jsonb(NEW)-ARRAY['state','fileId','updatedAt','targetArtifactDevice','targetArtifactInode','cleanupState'${includeMime ? ",'mimeType','mimeTypeCheckpointed'" : ""}]) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','fileId','updatedAt','targetArtifactDevice','targetArtifactInode','cleanupState'${includeMime ? ",'mimeType','mimeTypeCheckpointed'" : ""}])
          THEN RAISE EXCEPTION 'Finalization bindings are immutable'; END IF;
${
  includeMime
    ? `
        IF TG_OP='UPDATE' THEN
          IF OLD.state='verified' AND NEW.state=OLD.state AND
            NOT OLD."mimeTypeCheckpointed" AND NEW."mimeTypeCheckpointed" AND
            ROW(NEW."fileId",NEW."targetArtifactDevice",NEW."targetArtifactInode",NEW."cleanupState") IS NOT DISTINCT FROM
            ROW(OLD."fileId",OLD."targetArtifactDevice",OLD."targetArtifactInode",OLD."cleanupState") THEN RETURN NEW; END IF;
          IF ROW(NEW."mimeType",NEW."mimeTypeCheckpointed") IS DISTINCT FROM ROW(OLD."mimeType",OLD."mimeTypeCheckpointed")
            THEN RAISE EXCEPTION 'Finalization MIME checkpoint is immutable'; END IF;
          IF NEW.state='publishing' AND NOT NEW."mimeTypeCheckpointed" AND EXISTS (
            SELECT 1 FROM upload_sessions WHERE id=NEW."sessionId" AND "workspaceId"='${SSD_UPLOAD_WORKSPACE_ID}'::uuid)
            THEN RAISE EXCEPTION 'SSD publishing requires MIME checkpoint'; END IF;
        END IF;
`
    : ""
}
        IF OLD.state='assembling' AND NEW.state=OLD.state AND NEW."fileId" IS NULL AND
          OLD."targetArtifactDevice" IS NULL AND OLD."targetArtifactInode" IS NULL AND
          NEW."targetArtifactDevice" IS NOT NULL AND NEW."targetArtifactInode" IS NOT NULL AND
          NEW."cleanupState"=OLD."cleanupState" THEN RETURN NEW; END IF;
        IF ROW(NEW."targetArtifactDevice",NEW."targetArtifactInode") IS DISTINCT FROM
          ROW(OLD."targetArtifactDevice",OLD."targetArtifactInode") THEN RAISE EXCEPTION 'Target identity checkpoint is immutable'; END IF;
        IF OLD.state='committed' AND NEW.state=OLD.state AND NEW."fileId"=OLD."fileId" AND
          OLD."cleanupState"='pending' AND NEW."cleanupState"='cleaned' AND NEW."targetArtifactDevice" IS NOT NULL AND EXISTS (
            SELECT 1 FROM files f JOIN upload_sessions s ON s.id=NEW."sessionId"
            WHERE f.id=NEW."fileId" AND f."userId"=NEW."userId" AND f."uploadId"=NEW."uploadId" AND
              f.name=NEW.filename AND f.size=NEW."totalSize" AND f.checksum=NEW."expectedSha256" AND
              f."parentId" IS NOT DISTINCT FROM NEW."parentId" AND NOT f."isFolder" AND NOT f."isDeleted" AND s.status='completed' AND
              f."storageLocationId"::text=NEW.binding->>'targetStorageId' AND
              f."relativeObjectKey"=NEW.binding->>'relativeObjectKey' AND f."storagePath"=NEW.binding->>'storagePath')
          THEN RETURN NEW; END IF;
        IF NEW."cleanupState" <> OLD."cleanupState" THEN RAISE EXCEPTION 'Invalid cleanup transition'; END IF;
        IF NOT ((OLD.state='assembling' AND NEW.state='verified') OR (OLD.state='verified' AND NEW.state='publishing') OR
          (OLD.state='publishing' AND NEW.state='published') OR (OLD.state='published' AND NEW.state='committed'))
          THEN RAISE EXCEPTION 'Invalid finalization transition'; END IF;
        IF NEW."targetArtifactDevice" IS NULL THEN RAISE EXCEPTION 'Finalization requires target identity checkpoint'; END IF;
        RETURN NEW;
      END $body$`;
  }
}
