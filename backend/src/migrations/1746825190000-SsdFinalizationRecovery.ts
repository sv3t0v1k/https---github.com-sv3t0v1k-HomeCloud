import { MigrationInterface, QueryRunner } from "typeorm";
import { IsolatedSsdFinalizationJournal1746825180000 } from "./1746825180000-IsolatedSsdFinalizationJournal";

/** Recovery checkpoints and lifecycle fences only. SSD ingress remains disabled. */
export class SsdFinalizationRecovery1746825190000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Finalization recovery requires a transaction");
    await runner.query(
      `LOCK TABLE ssd_finalization_operations, upload_sessions, upload_chunks, files IN ACCESS EXCLUSIVE MODE`,
    );
    await runner.query(`ALTER TABLE ssd_finalization_operations
      ADD COLUMN "targetArtifactDevice" text,
      ADD COLUMN "targetArtifactInode" text,
      ADD COLUMN "cleanupState" varchar(16) NOT NULL DEFAULT 'pending',
      ADD CONSTRAINT "CHK_ssd_target_identity" CHECK (("targetArtifactDevice" IS NULL AND "targetArtifactInode" IS NULL) OR
        ("targetArtifactDevice" IS NOT NULL AND "targetArtifactInode" IS NOT NULL AND
         "targetArtifactDevice" ~ '^(0|[1-9][0-9]*)$' AND "targetArtifactInode" ~ '^(0|[1-9][0-9]*)$' AND
         "targetArtifactDevice"=binding->>'targetDevice')),
      ADD CONSTRAINT "CHK_ssd_cleanup_state" CHECK ("cleanupState" IN ('pending','cleaned') AND ("cleanupState" <> 'cleaned' OR state='committed'))`);
    // Keep the historical numeric session identity, while allowing normal completed-session expiry after cleanup.
    const constraints =
      await runner.query(`SELECT conname FROM pg_constraint WHERE conrelid='ssd_finalization_operations'::regclass
      AND confrelid='upload_sessions'::regclass AND contype='f'`);
    for (const { conname } of constraints)
      await runner.query(
        `ALTER TABLE ssd_finalization_operations DROP CONSTRAINT "${String(conname).replace(/"/g, '""')}"`,
      );
    await runner.query(`DROP INDEX "UQ_ssd_finalization_active"`);
    // Populated deployments with multiple retained committed operations may need operator reconciliation first.
    // Never bypass the one-operation bound just to make a migration succeed.
    await runner.query(
      `CREATE UNIQUE INDEX "UQ_ssd_finalization_active" ON ssd_finalization_operations ((true)) WHERE "cleanupState"='pending'`,
    );
    await runner.query(`CREATE FUNCTION guard_ssd_session_insert() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "sessionId"=NEW.id AND "cleanupState"='pending')
          THEN RAISE EXCEPTION 'Upload session identity reserved by finalization'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_session_insert" BEFORE INSERT ON upload_sessions FOR EACH ROW EXECUTE FUNCTION guard_ssd_session_insert()`,
    );
    await runner.query(`CREATE OR REPLACE FUNCTION guard_ssd_finalization_operation() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.state <> 'assembling' OR NEW."fileId" IS NOT NULL OR NEW."createdTransaction" <> pg_current_xact_id() OR
            NEW."targetArtifactDevice" IS NOT NULL OR NEW."targetArtifactInode" IS NOT NULL OR NEW."cleanupState" <> 'pending' OR
            NOT EXISTS (SELECT 1 FROM upload_sessions WHERE id=NEW."sessionId")
            THEN RAISE EXCEPTION 'Invalid new finalization operation'; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Finalization journal is retained'; END IF;
        IF (to_jsonb(NEW)-ARRAY['state','fileId','updatedAt','targetArtifactDevice','targetArtifactInode','cleanupState']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','fileId','updatedAt','targetArtifactDevice','targetArtifactInode','cleanupState'])
          THEN RAISE EXCEPTION 'Finalization bindings are immutable'; END IF;
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
      END $body$`);
    await runner.query(`CREATE OR REPLACE FUNCTION guard_ssd_reserved_chunks() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE sid integer;
      BEGIN
        sid := CASE WHEN TG_OP='DELETE' THEN OLD."sessionId" ELSE NEW."sessionId" END;
        IF TG_OP='UPDATE' THEN
          PERFORM id FROM upload_sessions WHERE id IN (OLD."sessionId",NEW."sessionId") ORDER BY id FOR UPDATE;
        ELSE PERFORM id FROM upload_sessions WHERE id=sid FOR UPDATE; END IF;
        IF EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "sessionId"=sid AND "cleanupState"='pending') OR
          (TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "sessionId"=OLD."sessionId" AND "cleanupState"='pending'))
          THEN RAISE EXCEPTION 'Upload chunks reserved by finalization'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(`CREATE OR REPLACE FUNCTION guard_ssd_reserved_session() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        SELECT * INTO op FROM ssd_finalization_operations WHERE "sessionId"=OLD.id AND "cleanupState"='pending';
        IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Upload session reserved by finalization'; END IF;
        IF op.state='committed' AND OLD.status IN ('pending','uploading') AND NEW.status='completed' AND
          ROW(NEW.id,NEW."uploadId",NEW.filename,NEW."totalSize",NEW."uploadedSize",NEW."chunkSize",NEW."totalChunks",NEW."uploadedCount",NEW."accountingInitialized",NEW."uploadedChunks",NEW."workspaceId",NEW."tempPath",NEW."parentId",NEW."expiresAt",NEW."createdAt",NEW."userId")
            IS NOT DISTINCT FROM ROW(OLD.id,OLD."uploadId",OLD.filename,OLD."totalSize",OLD."uploadedSize",OLD."chunkSize",OLD."totalChunks",OLD."uploadedCount",OLD."accountingInitialized",OLD."uploadedChunks",OLD."workspaceId",OLD."tempPath",OLD."parentId",OLD."expiresAt",OLD."createdAt",OLD."userId") AND
          EXISTS (SELECT 1 FROM files WHERE id=op."fileId" AND "uploadId"=op."uploadId" AND "userId"=op."userId") THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Upload session reserved by finalization';
      END $body$`);
    await runner.query(`DROP TRIGGER "TR_ssd_reserved_file" ON files`);
    await runner.query(`CREATE OR REPLACE FUNCTION guard_ssd_reserved_file() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          PERFORM id FROM upload_sessions WHERE "uploadId"=OLD."uploadId" AND "userId"=OLD."userId" FOR UPDATE;
          IF EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "cleanupState"='pending' AND
            ("fileId"=OLD.id OR ("uploadId"=OLD."uploadId" AND "userId"=OLD."userId")))
            THEN RAISE EXCEPTION 'File upload reserved by finalization'; END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        PERFORM id FROM upload_sessions WHERE "uploadId"=NEW."uploadId" AND "userId"=NEW."userId" FOR UPDATE;
        SELECT * INTO op FROM ssd_finalization_operations WHERE "cleanupState"='pending' AND
          ("fileId"=NEW.id OR ("uploadId"=NEW."uploadId" AND "userId"=NEW."userId"));
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_OP='INSERT' AND op.state='committed' AND NEW.id=op."fileId" AND NEW.name=op.filename AND NEW.size=op."totalSize" AND
          NEW."parentId" IS NOT DISTINCT FROM op."parentId" AND NOT NEW."isFolder" AND NOT NEW."isDeleted" AND
          NEW.checksum=op."expectedSha256" AND NEW."storageLocationId"::text=op.binding->>'targetStorageId' AND
          NEW."relativeObjectKey"=op.binding->>'relativeObjectKey' AND NEW."storagePath"=op.binding->>'storagePath' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'File upload reserved by finalization';
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_reserved_file" BEFORE INSERT OR UPDATE OR DELETE ON files FOR EACH ROW EXECUTE FUNCTION guard_ssd_reserved_file()`,
    );
    await runner.query(`CREATE OR REPLACE FUNCTION check_ssd_finalization_commit() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        SELECT * INTO op FROM ssd_finalization_operations WHERE id=NEW.id;
        IF op.state='committed' AND op."cleanupState"='pending' AND NOT EXISTS (
          SELECT 1 FROM files f JOIN upload_sessions s ON s.id=op."sessionId"
          WHERE f.id=op."fileId" AND f."userId"=op."userId" AND f."uploadId"=op."uploadId" AND
            f.name=op.filename AND f.size=op."totalSize" AND f.checksum=op."expectedSha256" AND
            f."parentId" IS NOT DISTINCT FROM op."parentId" AND NOT f."isFolder" AND NOT f."isDeleted" AND s.status='completed' AND
            f."storageLocationId"::text=op.binding->>'targetStorageId' AND
            f."relativeObjectKey"=op.binding->>'relativeObjectKey' AND f."storagePath"=op.binding->>'storagePath')
          THEN RAISE EXCEPTION 'Incomplete finalization commit'; END IF;
        IF op."cleanupState"='cleaned' AND EXISTS (SELECT 1 FROM upload_chunks WHERE "sessionId"=op."sessionId")
          THEN RAISE EXCEPTION 'Incomplete finalization cleanup'; END IF;
        RETURN NEW;
      END $body$`);
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Finalization recovery requires a transaction");
    await runner.query(
      `LOCK TABLE ssd_finalization_operations, ssd_finalization_chunks IN ACCESS EXCLUSIVE MODE`,
    );
    if (
      (await runner.query(`SELECT 1 FROM ssd_finalization_operations LIMIT 1`))
        .length
    )
      throw new Error(
        "Nonempty finalization recovery journal cannot be reverted",
      );
    await runner.query(
      `DROP TRIGGER "TR_ssd_session_insert" ON upload_sessions`,
    );
    await runner.query(`DROP FUNCTION guard_ssd_session_insert()`);
    // No historical rows exist: recreate precisely the stage 2.1 schema/guards using its unchanged migration.
    const previous = new IsolatedSsdFinalizationJournal1746825180000();
    await previous.down(runner);
    await previous.up(runner);
  }
}
