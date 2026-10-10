import { MigrationInterface, QueryRunner } from "typeorm";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  LEGACY_UPLOAD_WORKSPACE_KEY,
  LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY,
} from "../entities/upload-workspace.entity";
import { validateRoot } from "../storage/storage-mount-registry";

/** Fenced backend and upload ingress are required. Filesystem preflight is
 * read-only; transaction=all guarantees rollback of the entire DB binding. */
export class UploadWorkspaceBinding1746825160000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive)
      throw new Error("Upload workspace migration requires a transaction");
    const root = process.env.STORAGE_PATH || "/storage";
    validateRoot(root);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Invalid storage root");
    const workspaceRoot = path.join(root, ".tmp");
    const workspaceStat = fs.lstatSync(workspaceRoot);
    if (
      !workspaceStat.isDirectory() ||
      workspaceStat.isSymbolicLink() ||
      workspaceStat.dev !== rootStat.dev ||
      fs.realpathSync(workspaceRoot) !==
        path.join(fs.realpathSync(root), ".tmp")
    )
      throw new Error("Invalid or non-colocated legacy upload workspace");

    await queryRunner.query(
      `LOCK TABLE "upload_sessions", "upload_chunks" IN ACCESS EXCLUSIVE MODE`,
    );
    let afterId: number | null = null;
    while (true) {
      const rows: Array<{ id: number; uploadId: string; tempPath: string }> =
        await queryRunner.query(
          `SELECT id, "uploadId", "tempPath" FROM "upload_sessions" WHERE ($1::integer IS NULL OR id > $1) ORDER BY id LIMIT 500`,
          [afterId],
        );
      if (!rows.length) break;
      for (const row of rows) {
        afterId = row.id;
        if (
          typeof row.uploadId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            row.uploadId,
          ) ||
          row.tempPath !== path.join(workspaceRoot, row.uploadId)
        )
          throw new Error(`Unsafe legacy upload session binding: ${row.id}`);
        let sessionStat: fs.Stats;
        try {
          sessionStat = fs.lstatSync(row.tempPath);
        } catch (error) {
          // Expired/cancelled sessions and crashes may already lack directories.
          // Their exact immutable path still binds; recovery handles absent bytes.
          if ((error as { code?: string }).code === "ENOENT") continue;
          throw error;
        }
        if (
          !sessionStat.isDirectory() ||
          sessionStat.isSymbolicLink() ||
          sessionStat.dev !== workspaceStat.dev ||
          fs.realpathSync(row.tempPath) !==
            path.join(fs.realpathSync(workspaceRoot), row.uploadId)
        )
          throw new Error(`Unsafe legacy upload session directory: ${row.id}`);
      }
    }
    await queryRunner.query(`CREATE TABLE "upload_workspaces" (
      "id" uuid PRIMARY KEY,
      "machineKey" varchar(100) NOT NULL UNIQUE CHECK ("machineKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      "mountKey" varchar(100) NOT NULL UNIQUE CHECK ("mountKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      "type" varchar(32) NOT NULL DEFAULT 'local_filesystem' CHECK ("type" = 'local_filesystem'),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      `INSERT INTO "upload_workspaces" (id, "machineKey", "mountKey") VALUES ($1,$2,$3)`,
      [
        LEGACY_UPLOAD_WORKSPACE_ID,
        LEGACY_UPLOAD_WORKSPACE_KEY,
        LEGACY_UPLOAD_WORKSPACE_MOUNT_KEY,
      ],
    );
    await queryRunner.query(
      `ALTER TABLE "upload_sessions" ADD COLUMN "workspaceId" uuid`,
    );
    await queryRunner.query(`UPDATE "upload_sessions" SET "workspaceId"=$1`, [
      LEGACY_UPLOAD_WORKSPACE_ID,
    ]);
    await queryRunner.query(`ALTER TABLE "upload_sessions"
      ALTER COLUMN "workspaceId" SET NOT NULL,
      ADD CONSTRAINT "FK_upload_sessions_workspace" FOREIGN KEY ("workspaceId") REFERENCES "upload_workspaces"(id) ON DELETE RESTRICT`);
    await queryRunner.query(
      `CREATE INDEX "idx_upload_sessions_workspaceId" ON "upload_sessions" ("workspaceId")`,
    );
    await queryRunner.query(`CREATE FUNCTION "guard_upload_workspace_identity"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW."machineKey" IS DISTINCT FROM OLD."machineKey" OR NEW."mountKey" IS DISTINCT FROM OLD."mountKey" OR NEW.type IS DISTINCT FROM OLD.type
        THEN RAISE EXCEPTION 'Upload workspace identity is immutable'; END IF;
        RETURN NEW;
      END $body$`);
    await queryRunner.query(
      `CREATE TRIGGER "TR_upload_workspace_identity" BEFORE UPDATE ON "upload_workspaces" FOR EACH ROW EXECUTE FUNCTION "guard_upload_workspace_identity"()`,
    );
    const quotedRoot = workspaceRoot.replace(/'/g, "''");
    await queryRunner.query(`CREATE FUNCTION "guard_upload_session_binding"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" OR NEW."tempPath" IS DISTINCT FROM OLD."tempPath" OR NEW."uploadId" IS DISTINCT FROM OLD."uploadId"
          THEN RAISE EXCEPTION 'Upload session binding is immutable'; END IF;
        END IF;
        IF NEW."workspaceId" IS DISTINCT FROM '${LEGACY_UPLOAD_WORKSPACE_ID}'::uuid OR
          NEW."uploadId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR
          NEW."tempPath" IS DISTINCT FROM '${quotedRoot}/' || NEW."uploadId"
        THEN RAISE EXCEPTION 'Invalid or inconsistent upload workspace binding'; END IF;
        RETURN NEW;
      END $body$`);
    await queryRunner.query(
      `CREATE TRIGGER "TR_upload_session_binding" BEFORE INSERT OR UPDATE ON "upload_sessions" FOR EACH ROW EXECUTE FUNCTION "guard_upload_session_binding"()`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      "Upload workspace binding cannot be dropped: restore a coherent pre-checkpoint DB/storage backup instead",
    );
  }
}
