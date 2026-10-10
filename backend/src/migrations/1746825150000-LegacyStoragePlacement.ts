import { MigrationInterface, QueryRunner } from "typeorm";
import * as fs from "node:fs";
import {
  LEGACY_STORAGE_ID,
  LEGACY_STORAGE_KEY,
  StorageRegistry,
} from "../storage/storage-placement";

/** Requires a fenced writer and the original storage mount visible to the migrator.
 * No byte I/O mutations. TypeORM's transaction=all is intentionally required. */
export class LegacyStoragePlacement1746825150000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive)
      throw new Error("Storage migration requires a transaction");
    const root = process.env.STORAGE_PATH || "/storage";
    const registry = new StorageRegistry(root);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error("Invalid storage root");
    await queryRunner.query(`LOCK TABLE "files" IN ACCESS EXCLUSIVE MODE`);
    // Keyset batches bound JS memory; locking prevents concurrent File writers.
    let afterId: number | null = null;
    const seen = new Set<string>();
    while (true) {
      const rows: Array<{
        id: number;
        isFolder: boolean;
        storagePath: string;
        size: string;
      }> = await queryRunner.query(
        `SELECT id, "isFolder", "storagePath", size FROM "files" WHERE ($1::integer IS NULL OR id > $1) ORDER BY id LIMIT 500`,
        [afterId],
      );
      if (!rows.length) break;
      for (const row of rows) {
        afterId = row.id;
        if (row.isFolder) {
          if (row.storagePath !== null)
            throw new Error(`Folder has physical placement: File ${row.id}`);
          continue;
        }
        try {
          const key = registry.keyFromAbsolute(row.storagePath);
          if (seen.has(key)) throw new Error("Duplicate storage object");
          seen.add(key);
          if (
            BigInt(fs.statSync(row.storagePath, { bigint: true }).size) !==
            BigInt(row.size)
          )
            throw new Error("Stored size mismatch");
        } catch {
          throw new Error(`Unsafe or missing legacy object: File ${row.id}`);
        }
      }
    }
    await queryRunner.query(`CREATE TABLE "storage_locations" (
      "id" uuid PRIMARY KEY,
      "machineKey" varchar(100) NOT NULL UNIQUE CHECK ("machineKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      "displayName" varchar(255) NOT NULL CHECK (length("displayName") > 0),
      "mountKey" varchar(100) NOT NULL UNIQUE CHECK ("mountKey" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
      "type" varchar(32) NOT NULL DEFAULT 'local_filesystem' CHECK ("type" = 'local_filesystem'),
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      `INSERT INTO "storage_locations" (id, "machineKey", "mountKey", "displayName") VALUES ($1,$2,$2,$3)`,
      [LEGACY_STORAGE_ID, LEGACY_STORAGE_KEY, "Основное хранилище"],
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN "storageLocationId" uuid, ADD COLUMN "relativeObjectKey" text`,
    );
    // Preflight proved canonical prefix and exact normalization. substring preserves bytes/name.
    await queryRunner.query(
      `UPDATE "files" SET "storageLocationId" = $1, "relativeObjectKey" = substring("storagePath" from $2::integer) WHERE NOT "isFolder"`,
      [LEGACY_STORAGE_ID, Array.from(root).length + 2],
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD CONSTRAINT "FK_files_storage_location" FOREIGN KEY ("storageLocationId") REFERENCES "storage_locations"(id) ON DELETE RESTRICT`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_files_placement" ON "files" ("storageLocationId", "relativeObjectKey")`,
    );
    await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "CHK_files_placement" CHECK (
      ("isFolder" AND "storageLocationId" IS NULL AND "relativeObjectKey" IS NULL AND "storagePath" IS NULL) OR
      (NOT "isFolder" AND "storageLocationId" IS NOT NULL AND "relativeObjectKey" IS NOT NULL AND "storagePath" IS NOT NULL))`);
    // The bridge root is sealed to this deployment until a separately qualified remap.
    const quotedRoot = root.replace(/'/g, "''");
    await queryRunner.query(`CREATE FUNCTION "guard_legacy_file_placement"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NOT NEW."isFolder" THEN
          IF NEW."storageLocationId" <> '${LEGACY_STORAGE_ID}'::uuid OR
            NEW."relativeObjectKey" = '' OR left(NEW."relativeObjectKey", 1) = '/' OR
            NEW."relativeObjectKey" ~ '^[A-Za-z]:' OR position(chr(92) in NEW."relativeObjectKey") > 0 OR
            NEW."relativeObjectKey" ~ '(^|/)[.]{1,2}(/|$)' OR position('//' in NEW."relativeObjectKey") > 0 OR
            right(NEW."relativeObjectKey", 1) = '/' OR split_part(NEW."relativeObjectKey", '/', 1) = '.tmp' OR
            split_part(NEW."relativeObjectKey", '/', 1) LIKE '.restore-%' OR
            NEW."storagePath" IS DISTINCT FROM '${quotedRoot}/' || NEW."relativeObjectKey"
          THEN RAISE EXCEPTION 'Invalid or inconsistent legacy placement'; END IF;
        END IF;
        RETURN NEW;
      END $body$`);
    await queryRunner.query(
      `CREATE TRIGGER "TR_files_legacy_placement" BEFORE INSERT OR UPDATE ON "files" FOR EACH ROW EXECUTE FUNCTION "guard_legacy_file_placement"()`,
    );
    await queryRunner.query(`CREATE FUNCTION "guard_storage_identity"() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW."machineKey" IS DISTINCT FROM OLD."machineKey" OR NEW."mountKey" IS DISTINCT FROM OLD."mountKey" OR NEW.type IS DISTINCT FROM OLD.type
        THEN RAISE EXCEPTION 'Storage identity is immutable'; END IF;
        RETURN NEW;
      END $body$`);
    await queryRunner.query(
      `CREATE TRIGGER "TR_storage_identity" BEFORE UPDATE ON "storage_locations" FOR EACH ROW EXECUTE FUNCTION "guard_storage_identity"()`,
    );
  }

  public async down(): Promise<void> {
    throw new Error(
      "Logical placement cannot be dropped: restore a coherent pre-checkpoint DB/storage backup instead",
    );
  }
}
