import { MigrationInterface, QueryRunner } from "typeorm";

/** Additive, unwired journal. No SSD admission or filesystem mutations. */
export class IsolatedSsdFinalizationJournal1746825180000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Finalization journal requires a transaction");
    await runner.query(`CREATE TABLE ssd_finalization_operations (
      id uuid PRIMARY KEY,
      "sessionId" integer NOT NULL UNIQUE REFERENCES upload_sessions(id) ON DELETE RESTRICT,
      "userId" integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      "uploadId" varchar(255) NOT NULL,
      filename varchar(255) NOT NULL,
      "parentId" integer,
      "totalSize" bigint NOT NULL CHECK ("totalSize" > 0 AND "totalSize" <= 9007199254740991),
      "chunkSize" integer NOT NULL CHECK ("chunkSize" > 0),
      "totalChunks" integer NOT NULL CHECK ("totalChunks" > 0),
      "expectedSha256" varchar(64) NOT NULL CHECK ("expectedSha256" ~ '^[0-9a-f]{64}$'),
      binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
      state varchar(16) NOT NULL DEFAULT 'assembling' CHECK (state IN ('assembling','verified','publishing','published','committed')),
      "fileId" integer UNIQUE,
      "createdTransaction" xid8 NOT NULL DEFAULT pg_current_xact_id(),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE ("userId", "uploadId"),
      CHECK ((state = 'committed') = ("fileId" IS NOT NULL))
    )`);
    // One durable active operation across processes. A crash requires future explicit recovery.
    await runner.query(
      `CREATE UNIQUE INDEX "UQ_ssd_finalization_active" ON ssd_finalization_operations ((true)) WHERE state <> 'committed'`,
    );
    await runner.query(`CREATE TABLE ssd_finalization_chunks (
      "operationId" uuid NOT NULL REFERENCES ssd_finalization_operations(id) ON DELETE RESTRICT,
      "chunkIndex" integer NOT NULL CHECK ("chunkIndex" >= 0),
      "byteSize" integer NOT NULL CHECK ("byteSize" > 0),
      sha256 varchar(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      PRIMARY KEY ("operationId", "chunkIndex")
    )`);
    await runner.query(`CREATE FUNCTION guard_ssd_finalization_operation() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.state <> 'assembling' OR NEW."fileId" IS NOT NULL OR NEW."createdTransaction" <> pg_current_xact_id()
            THEN RAISE EXCEPTION 'Invalid new finalization operation'; END IF;
          RETURN NEW;
        END IF;
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Finalization journal is retained'; END IF;
        IF (to_jsonb(NEW) - ARRAY['state','fileId','updatedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','fileId','updatedAt'])
          THEN RAISE EXCEPTION 'Finalization bindings are immutable'; END IF;
        IF NOT ((OLD.state='assembling' AND NEW.state='verified') OR (OLD.state='verified' AND NEW.state='publishing') OR
          (OLD.state='publishing' AND NEW.state='published') OR (OLD.state='published' AND NEW.state='committed'))
          THEN RAISE EXCEPTION 'Invalid finalization transition'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_finalization_operation" BEFORE INSERT OR UPDATE OR DELETE ON ssd_finalization_operations FOR EACH ROW EXECUTE FUNCTION guard_ssd_finalization_operation()`,
    );
    await runner.query(`CREATE FUNCTION guard_ssd_finalization_manifest() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        IF TG_OP='INSERT' THEN
          SELECT * INTO op FROM ssd_finalization_operations WHERE id=NEW."operationId";
          IF NOT FOUND OR op.state <> 'assembling' OR op."createdTransaction" <> pg_current_xact_id() OR
            NEW."chunkIndex" >= op."totalChunks" OR NEW."byteSize" <> (CASE WHEN NEW."chunkIndex"=op."totalChunks"-1
              THEN op."totalSize"-NEW."chunkIndex"::bigint*op."chunkSize" ELSE op."chunkSize" END)
            THEN RAISE EXCEPTION 'Finalization manifest is sealed'; END IF;
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'Finalization manifest is immutable';
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_finalization_manifest" BEFORE INSERT OR UPDATE OR DELETE ON ssd_finalization_chunks FOR EACH ROW EXECUTE FUNCTION guard_ssd_finalization_manifest()`,
    );
    await runner.query(`CREATE FUNCTION guard_ssd_reserved_chunks() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE sid integer;
      BEGIN
        sid := CASE WHEN TG_OP='DELETE' THEN OLD."sessionId" ELSE NEW."sessionId" END;
        IF TG_OP='UPDATE' THEN
          PERFORM id FROM upload_sessions WHERE id IN (OLD."sessionId",NEW."sessionId") ORDER BY id FOR UPDATE;
        ELSE
          PERFORM id FROM upload_sessions WHERE id=sid FOR UPDATE;
        END IF;
        IF EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "sessionId"=sid) OR
          (TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM ssd_finalization_operations WHERE "sessionId"=OLD."sessionId"))
          THEN RAISE EXCEPTION 'Upload chunks reserved by finalization'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_reserved_chunks" BEFORE INSERT OR UPDATE OR DELETE ON upload_chunks FOR EACH ROW EXECUTE FUNCTION guard_ssd_reserved_chunks()`,
    );
    await runner.query(`CREATE FUNCTION guard_ssd_reserved_session() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        SELECT * INTO op FROM ssd_finalization_operations WHERE "sessionId"=OLD.id;
        IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Upload session reserved by finalization'; END IF;
        IF op.state='committed' AND OLD.status IN ('pending','uploading') AND NEW.status='completed' AND
          ROW(NEW.id,NEW."uploadId",NEW.filename,NEW."totalSize",NEW."uploadedSize",NEW."chunkSize",NEW."totalChunks",NEW."uploadedCount",NEW."accountingInitialized",NEW."uploadedChunks",NEW."workspaceId",NEW."tempPath",NEW."parentId",NEW."expiresAt",NEW."createdAt",NEW."userId")
            IS NOT DISTINCT FROM ROW(OLD.id,OLD."uploadId",OLD.filename,OLD."totalSize",OLD."uploadedSize",OLD."chunkSize",OLD."totalChunks",OLD."uploadedCount",OLD."accountingInitialized",OLD."uploadedChunks",OLD."workspaceId",OLD."tempPath",OLD."parentId",OLD."expiresAt",OLD."createdAt",OLD."userId") AND
          EXISTS (SELECT 1 FROM files WHERE id=op."fileId" AND "uploadId"=op."uploadId" AND "userId"=op."userId")
          THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Upload session reserved by finalization';
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_reserved_session" BEFORE UPDATE OR DELETE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION guard_ssd_reserved_session()`,
    );
    await runner.query(`CREATE FUNCTION guard_ssd_reserved_file() RETURNS trigger LANGUAGE plpgsql AS $body$
      DECLARE op ssd_finalization_operations%ROWTYPE;
      BEGIN
        IF NEW."uploadId" IS NULL THEN RETURN NEW; END IF;
        PERFORM id FROM upload_sessions WHERE "uploadId"=NEW."uploadId" AND "userId"=NEW."userId" FOR UPDATE;
        SELECT * INTO op FROM ssd_finalization_operations WHERE "uploadId"=NEW."uploadId" AND "userId"=NEW."userId";
        IF NOT FOUND THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' AND op.state='committed' THEN RETURN NEW; END IF;
        IF op.state='committed' AND NEW.id=op."fileId" AND NEW.name=op.filename AND NEW.size=op."totalSize" AND
          NEW."parentId" IS NOT DISTINCT FROM op."parentId" AND NOT NEW."isFolder" AND NOT NEW."isDeleted" AND
          NEW.checksum=op."expectedSha256" AND NEW."storageLocationId"::text=op.binding->>'targetStorageId' AND
          NEW."relativeObjectKey"=op.binding->>'relativeObjectKey' AND NEW."storagePath"=op.binding->>'storagePath'
          THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'File upload reserved by finalization';
      END $body$`);
    await runner.query(
      `CREATE TRIGGER "TR_ssd_reserved_file" BEFORE INSERT OR UPDATE ON files FOR EACH ROW EXECUTE FUNCTION guard_ssd_reserved_file()`,
    );
    await runner.query(`CREATE FUNCTION check_ssd_finalization_commit() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.state='committed' AND NOT EXISTS (
          SELECT 1 FROM files f JOIN upload_sessions s ON s.id=NEW."sessionId"
          WHERE f.id=NEW."fileId" AND f."userId"=NEW."userId" AND f."uploadId"=NEW."uploadId" AND
            f.name=NEW.filename AND f.size=NEW."totalSize" AND f.checksum=NEW."expectedSha256" AND
            f."parentId" IS NOT DISTINCT FROM NEW."parentId" AND s.status='completed' AND
            f."storageLocationId"::text=NEW.binding->>'targetStorageId' AND
            f."relativeObjectKey"=NEW.binding->>'relativeObjectKey' AND f."storagePath"=NEW.binding->>'storagePath')
          THEN RAISE EXCEPTION 'Incomplete finalization commit'; END IF;
        RETURN NEW;
      END $body$`);
    await runner.query(
      `CREATE CONSTRAINT TRIGGER "TR_ssd_finalization_commit" AFTER UPDATE ON ssd_finalization_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ssd_finalization_commit()`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw new Error("Finalization journal requires a transaction");
    await runner.query(
      `LOCK TABLE ssd_finalization_operations, ssd_finalization_chunks IN ACCESS EXCLUSIVE MODE`,
    );
    if (
      (await runner.query(`SELECT 1 FROM ssd_finalization_operations LIMIT 1`))
        .length
    )
      throw new Error("Nonempty finalization journal cannot be dropped");
    await runner.query(`DROP TRIGGER "TR_ssd_reserved_file" ON files`);
    await runner.query(
      `DROP TRIGGER "TR_ssd_reserved_session" ON upload_sessions`,
    );
    await runner.query(
      `DROP TRIGGER "TR_ssd_reserved_chunks" ON upload_chunks`,
    );
    await runner.query(
      `DROP TABLE ssd_finalization_chunks, ssd_finalization_operations`,
    );
    await runner.query(
      `DROP FUNCTION guard_ssd_reserved_file(), guard_ssd_reserved_session(), guard_ssd_reserved_chunks(), guard_ssd_finalization_operation(), guard_ssd_finalization_manifest(), check_ssd_finalization_commit()`,
    );
  }
}
