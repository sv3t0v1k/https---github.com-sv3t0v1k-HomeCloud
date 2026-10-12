import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DataSource, MigrationInterface, QueryRunner } from "typeorm";
import { PrepareSsdUploadWorkspace1746825170000 } from "../migrations/1746825170000-PrepareSsdUploadWorkspace";
import {
  LEGACY_UPLOAD_WORKSPACE,
  SSD_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";
import { LEGACY_STORAGE_ID } from "../storage/storage-mount-registry";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
postgres(
  "Stage 1 additive SSD identity against the exact legacy schema",
  () => {
    let admin: DataSource, db: DataSource, runner: QueryRunner;
    let root: string, schema: string, previousRoot: string | undefined;
    const migration = new PrepareSsdUploadWorkspace1746825170000();
    const uploadId = "12345678-1234-4234-8234-123456789abc";
    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-stage1-schema-"));
      fs.mkdirSync(path.join(root, ".tmp"));
      fs.mkdirSync(path.join(root, ".tmp", uploadId));
      fs.writeFileSync(path.join(root, ".tmp", uploadId, "0"), "part");
      fs.writeFileSync(path.join(root, "legacy.bin"), "legacy");
      previousRoot = process.env.STORAGE_PATH;
      process.env.STORAGE_PATH = root;
      schema = "ssd_stage1_" + randomUUID().replace(/-/g, "");
      admin = new DataSource({ type: "postgres", url });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const files = fs
        .readdirSync(path.join(__dirname, "../migrations"))
        .filter(
          (name) =>
            /^\d{13}-.*\.ts$/.test(name) &&
            Number(name.slice(0, 13)) < 1746825170000,
        )
        .sort();
      const migrations = await Promise.all(
        files.map(
          async (name) =>
            Object.values(
              await import(path.join(__dirname, "../migrations", name)),
            ).find(
              (value: any) =>
                typeof value === "function" &&
                typeof value.prototype?.up === "function",
            ) as new () => MigrationInterface,
        ),
      );
      db = new DataSource({
        type: "postgres",
        url,
        schema,
        migrations,
        extra: { options: `-c search_path=${schema}` },
      });
      await db.initialize();
      await db.runMigrations();
      if (
        (await db.query(`SELECT count(*)::int AS count FROM migrations`))[0]
          .count !== 22
      )
        throw new Error("Expected exact 22-migration legacy baseline");
      await db.query(
        `INSERT INTO users (id,email,password,"storageUsed") VALUES (1,'ssd@example.test','hash',6)`,
      );
      await db.query(
        `INSERT INTO files (name,size,"storagePath","userId","storageLocationId","relativeObjectKey") VALUES ('legacy.bin',6,$1,1,$2,'legacy.bin')`,
        [path.join(root, "legacy.bin"), LEGACY_STORAGE_ID],
      );
      await db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","chunkSize","totalChunks","uploadedCount","accountingInitialized","uploadedSize","tempPath","workspaceId",status,"expiresAt","userId") VALUES ($1,'part.bin',4,4,1,1,true,4,$2,$3,'uploading','2027-01-01',1)`,
        [
          uploadId,
          path.join(root, ".tmp", uploadId),
          LEGACY_UPLOAD_WORKSPACE.id,
        ],
      );
      await db.query(
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) SELECT id,0,4,repeat('a',64) FROM upload_sessions`,
      );
      runner = db.createQueryRunner();
      await runner.connect();
    }, 30000);
    afterEach(async () => {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
      if (runner && !runner.isReleased) await runner.release();
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = previousRoot;
    });
    const inventory = async () =>
      Promise.all(
        [
          "files",
          "upload_sessions",
          "upload_chunks",
          "users",
          "storage_locations",
        ].map((table) =>
          db.query(
            `SELECT * FROM "${table}" ORDER BY ${table === "upload_chunks" ? '"sessionId","chunkIndex"' : "id"}`,
          ),
        ),
      );
    const apply = async () => {
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    };
    it("preserves rows, guards, quota, files and chunk bytes; rollback removes only the unused SSD identity", async () => {
      const before = await inventory();
      const functions = await db.query(
        `SELECT proname,prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'guard_%' ORDER BY proname`,
        [schema],
      );
      await apply();
      expect(await inventory()).toEqual(before);
      expect(
        await db.query(
          `SELECT proname,prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'guard_%' ORDER BY proname`,
          [schema],
        ),
      ).toEqual(functions);
      expect(
        await db.query(
          `SELECT id,"machineKey","mountKey",type FROM upload_workspaces ORDER BY "machineKey"`,
        ),
      ).toEqual([LEGACY_UPLOAD_WORKSPACE, SSD_UPLOAD_WORKSPACE]);
      expect(fs.readFileSync(path.join(root, "legacy.bin"), "utf8")).toBe(
        "legacy",
      );
      expect(
        fs.readFileSync(path.join(root, ".tmp", uploadId, "0"), "utf8"),
      ).toBe("part");
      await expect(
        db.query(
          `UPDATE upload_workspaces SET "mountKey"='other' WHERE id=$1`,
          [SSD_UPLOAD_WORKSPACE.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(`UPDATE upload_sessions SET "workspaceId"=$1`, [
          SSD_UPLOAD_WORKSPACE.id,
        ]),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(
          `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","workspaceId","userId") VALUES ($1,'x',4,$2,$3,1)`,
          [randomUUID(), "/ssd/new", SSD_UPLOAD_WORKSPACE.id],
        ),
      ).rejects.toThrow("binding");
      await expect(
        db.query(`UPDATE files SET "storageLocationId"=$1`, [
          SSD_UPLOAD_WORKSPACE.id,
        ]),
      ).rejects.toThrow("placement");
      await runner.startTransaction();
      await migration.down(runner);
      await runner.commitTransaction();
      expect(await inventory()).toEqual(before);
      expect(
        (await db.query(`SELECT id FROM upload_workspaces`)).map(
          (row: any) => row.id,
        ),
      ).toEqual([LEGACY_UPLOAD_WORKSPACE.id]);
    });
    it.each(["id", "machineKey", "mountKey"])(
      "fails closed and rolls back on reserved %s collision",
      async (column) => {
        await db.query(
          `INSERT INTO upload_workspaces (id,"machineKey","mountKey") VALUES ($1,$2,$3)`,
          [
            column === "id" ? SSD_UPLOAD_WORKSPACE.id : randomUUID(),
            column === "machineKey"
              ? SSD_UPLOAD_WORKSPACE.machineKey
              : "collision-workspace",
            column === "mountKey"
              ? SSD_UPLOAD_WORKSPACE.mountKey
              : "collision-mount",
          ],
        );
        const before = await inventory();
        const workspaces = await db.query(
          `SELECT * FROM upload_workspaces ORDER BY id`,
        );
        await expect(apply()).rejects.toMatchObject({ code: "23505" });
        expect(await inventory()).toEqual(before);
        expect(
          await db.query(`SELECT * FROM upload_workspaces ORDER BY id`),
        ).toEqual(workspaces);
      },
    );
    it("requires transactions before either direction mutates metadata", async () => {
      await expect(migration.up(runner)).rejects.toThrow("transaction");
      await expect(migration.down(runner)).rejects.toThrow("transaction");
      expect(
        await db.query(`SELECT id FROM upload_workspaces WHERE id=$1`, [
          SSD_UPLOAD_WORKSPACE.id,
        ]),
      ).toEqual([]);
    });
  },
);
