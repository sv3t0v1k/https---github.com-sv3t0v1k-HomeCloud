import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, MigrationInterface, QueryRunner } from "typeorm";
import { LegacyStoragePlacement1746825150000 } from "../migrations/1746825150000-LegacyStoragePlacement";
import { LEGACY_STORAGE_ID, StorageRegistry } from "./storage-placement";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
postgres(
  "Logical placement migration from exact pre-checkpoint PostgreSQL schema",
  () => {
    let admin: DataSource;
    let db: DataSource;
    let runner: QueryRunner;
    let schema: string;
    let root: string;
    let oldRoot: string | undefined;
    const migration = new LegacyStoragePlacement1746825150000();
    const migrationFiles = fs
      .readdirSync(path.join(__dirname, "../migrations"))
      .filter(
        (name) =>
          /^\d{13}-/.test(name) &&
          Number(name.slice(0, 13)) < 1746825150000 &&
          name.endsWith(".ts"),
      )
      .sort();

    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-schema-😀-"));
      fs.mkdirSync(path.join(root, "1"));
      fs.writeFileSync(
        path.join(root, "1/live.bin"),
        Buffer.from([0, 255, 128]),
      );
      fs.writeFileSync(path.join(root, "1/trash.bin"), "trash");
      oldRoot = process.env.STORAGE_PATH;
      process.env.STORAGE_PATH = root;
      schema = `placement_${randomUUID().replace(/-/g, "")}`;
      admin = new DataSource({ type: "postgres", url });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const migrations = await Promise.all(
        migrationFiles.map(
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
      const [baseline] = await db.query(`SELECT count(*)::int AS count FROM migrations`);
      if (baseline.count !== 20) throw new Error("Expected exact 20-migration baseline");
      await db.query(
        `INSERT INTO users (id,email,password) VALUES (1,'placement@example.test','hash')`,
      );
      await db.query(
        `INSERT INTO files (id,name,"storagePath",size,"isFolder","isDeleted","userId") VALUES (-1,'live.BIN',$1,3,false,false,1),(2,'trash.bin',$2,5,false,true,1),(3,'folder',NULL,0,true,false,1)`,
        [path.join(root, "1/live.bin"), path.join(root, "1/trash.bin")],
      );
      await db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","userId") VALUES ('resumable','new.bin',5,$1,1)`,
        [path.join(root, ".tmp/session")],
      );
      await db.query(
        `INSERT INTO share_links (token,"fileId","userId") VALUES ('share',-1,1)`,
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
      if (oldRoot === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = oldRoot;
    });
    async function apply() {
      await runner.startTransaction();
      try {
        await migration.up(runner);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    }
    const inventory = () =>
      ["live.bin", "trash.bin"].map((name) => {
        const file = path.join(root, "1", name),
          stat = fs.statSync(file);
        return {
          name,
          ino: stat.ino,
          size: stat.size,
          mtime: stat.mtimeMs,
          sha: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        };
      });
    it("backfills 1:1 including negative ID/trash/Unicode root, preserving all old rows, sessions, shares and bytes", async () => {
      const before = await db.query(`SELECT * FROM files ORDER BY id`);
      const sessions = await db.query(`SELECT * FROM upload_sessions`);
      const shares = await db.query(`SELECT * FROM share_links`);
      const bytes = inventory();
      await apply();
      const rows = await db.query(`SELECT * FROM files ORDER BY id`);
      expect(
        rows.map(
          ({ storageLocationId, relativeObjectKey, ...row }: any) => row,
        ),
      ).toEqual(before);
      expect(
        rows
          .slice(0, 2)
          .map((row: any) => [row.storageLocationId, row.relativeObjectKey]),
      ).toEqual([
        [LEGACY_STORAGE_ID, "1/live.bin"],
        [LEGACY_STORAGE_ID, "1/trash.bin"],
      ]);
      expect(rows[2].storageLocationId).toBeNull();
      expect(rows[2].relativeObjectKey).toBeNull();
      expect(await db.query(`SELECT * FROM upload_sessions`)).toEqual(sessions);
      expect(await db.query(`SELECT * FROM share_links`)).toEqual(shares);
      expect(inventory()).toEqual(bytes);
      for (const row of rows.slice(0, 2))
        expect(new StorageRegistry(root).resolve(row)).toBe(row.storagePath);
      await expect(
        db.query(`DELETE FROM storage_locations WHERE id=$1`, [
          LEGACY_STORAGE_ID,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        db.query(`UPDATE storage_locations SET "mountKey"='other'`),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(
          `INSERT INTO files (name,"storagePath","userId") VALUES ('old writer',$1,1)`,
          [path.join(root, "1/new.bin")],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(`UPDATE files SET "storagePath"=$1 WHERE id=-1`, [
          path.join(root, "1/other.bin"),
        ]),
      ).rejects.toThrow();
      await expect(
        db.query(
          `INSERT INTO files (name,"storagePath","storageLocationId","relativeObjectKey","userId") SELECT 'duplicate',"storagePath","storageLocationId","relativeObjectKey",1 FROM files WHERE id=-1`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(migration.down()).rejects.toThrow("cannot be dropped");
    });
    it.each([
      "outside",
      "traversal",
      "duplicate-separator",
      "missing",
      "leaf-symlink",
      "ancestor-symlink",
      "duplicate",
      "size",
      "folder-placement",
    ])("fails closed and rolls back schema/data for %s", async (kind) => {
      let unsafe = path.join(root, "1/live.bin");
      if (kind === "outside") unsafe = root + "-outside/live.bin";
      if (kind === "traversal") unsafe = root + "/1/../1/live.bin";
      if (kind === "duplicate-separator") unsafe = root + "/1//live.bin";
      if (kind === "missing") unsafe = root + "/1/missing.bin";
      if (kind === "leaf-symlink") {
        fs.symlinkSync(unsafe, path.join(root, "link"));
        unsafe = path.join(root, "link");
      }
      if (kind === "ancestor-symlink") {
        fs.symlinkSync(path.join(root, "1"), path.join(root, "link"));
        unsafe = path.join(root, "link/live.bin");
      }
      if (kind === "duplicate")
        await db.query(`UPDATE files SET "storagePath"=$1,size=3 WHERE id=2`, [
          unsafe,
        ]);
      else if (kind === "size")
        await db.query(`UPDATE files SET size=4 WHERE id=-1`);
      else if (kind === "folder-placement")
        await db.query(`UPDATE files SET "storagePath"=$1 WHERE id=3`, [
          unsafe,
        ]);
      else
        await db.query(`UPDATE files SET "storagePath"=$1 WHERE id=-1`, [
          unsafe,
        ]);
      const before = await db.query(`SELECT * FROM files ORDER BY id`);
      await expect(apply()).rejects.toThrow();
      expect(await db.query(`SELECT * FROM files ORDER BY id`)).toEqual(before);
      const [table] = await db.query(
        `SELECT to_regclass('storage_locations') AS name`,
      );
      expect(table.name).toBeNull();
    });
  },
);
