import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, MigrationInterface, QueryRunner } from "typeorm";
import { UploadWorkspaceBinding1746825160000 } from "../migrations/1746825160000-UploadWorkspaceBinding";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  LEGACY_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const resumable = "12345678-1234-4234-8234-123456789abc";
postgres("Upload workspace migration from exact MS-2 PostgreSQL schema", () => {
  let admin: DataSource, db: DataSource, runner: QueryRunner;
  let schema: string, root: string, oldRoot: string | undefined;
  const migration = new UploadWorkspaceBinding1746825160000();
  const files = fs
    .readdirSync(path.join(__dirname, "../migrations"))
    .filter(
      (name) =>
        /^\d{13}-/.test(name) &&
        Number(name.slice(0, 13)) < 1746825160000 &&
        name.endsWith(".ts"),
    )
    .sort();

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-workspace-😀-'"));
    fs.mkdirSync(path.join(root, ".tmp"));
    fs.mkdirSync(path.join(root, ".tmp", resumable));
    fs.writeFileSync(
      path.join(root, ".tmp", resumable, "chunk_0"),
      Buffer.from([0, 255, 128]),
    );
    oldRoot = process.env.STORAGE_PATH;
    process.env.STORAGE_PATH = root;
    schema = `workspace_${randomUUID().replace(/-/g, "")}`;
    admin = new DataSource({ type: "postgres", url });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
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
    const [baseline] = await db.query(
      `SELECT count(*)::int AS count FROM migrations`,
    );
    if (baseline.count !== 21)
      throw new Error("Expected exact 21-migration MS-2 baseline");
    await db.query(
      `INSERT INTO users (id,email,password,"storageUsed") VALUES (1,'workspace@example.test','hash',7)`,
    );
    for (const [
      id,
      uploadId,
      status,
      size,
      uploaded,
      count,
      initialized,
      legacy,
    ] of [
      [-1, resumable, "uploading", 9, 3, 1, true, [0]],
      [
        2,
        "12345678-1234-4234-8234-123456789ab1",
        "pending",
        8,
        0,
        0,
        false,
        [],
      ],
      [
        3,
        "12345678-1234-4234-8234-123456789ab2",
        "completed",
        5,
        5,
        1,
        true,
        [0],
      ],
      [
        4,
        "12345678-1234-4234-8234-123456789ab3",
        "aborted",
        6,
        0,
        0,
        false,
        [],
      ],
    ]) {
      await db.query(
        `INSERT INTO upload_sessions (id,"uploadId",filename,"totalSize","uploadedSize","chunkSize","totalChunks","uploadedCount","accountingInitialized","uploadedChunks","tempPath",status,"expiresAt","userId") VALUES ($1,$2,'bytes.bin',$3,$4,3,3,$5,$6,$7,$8,$9,'2027-01-01',1)`,
        [
          id,
          uploadId,
          size,
          uploaded,
          count,
          initialized,
          JSON.stringify(legacy),
          path.join(root, ".tmp", String(uploadId)),
          status,
        ],
      );
    }
    await db.query(
      `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES (-1,0,3,$1)`,
      [
        createHash("sha256")
          .update(Buffer.from([0, 255, 128]))
          .digest("hex"),
      ],
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
  const inventory = () => {
    const name = path.join(root, ".tmp", resumable, "chunk_0"),
      stat = fs.statSync(name);
    return {
      ino: stat.ino,
      dev: stat.dev,
      size: stat.size,
      mtime: stat.mtimeMs,
      sha: createHash("sha256").update(fs.readFileSync(name)).digest("hex"),
    };
  };
  it("binds every status including negative IDs, retaining all old data, confirmed parts, reservations and exact bytes", async () => {
    const sessions = await db.query(
      `SELECT * FROM upload_sessions ORDER BY id`,
    );
    const chunks = await db.query(`SELECT * FROM upload_chunks`);
    const users = await db.query(`SELECT * FROM users`);
    const bytes = inventory();
    await apply();
    const rows = await db.query(`SELECT * FROM upload_sessions ORDER BY id`);
    expect(rows.map(({ workspaceId, ...row }: any) => row)).toEqual(sessions);
    expect(rows.map((row: any) => row.workspaceId)).toEqual(
      Array(4).fill(LEGACY_UPLOAD_WORKSPACE_ID),
    );
    expect(await db.query(`SELECT * FROM upload_chunks`)).toEqual(chunks);
    expect(await db.query(`SELECT * FROM users`)).toEqual(users);
    expect(inventory()).toEqual(bytes);
    const [workspace] = await db.query(
      `SELECT id,"machineKey","mountKey",type FROM upload_workspaces`,
    );
    expect(workspace).toEqual(LEGACY_UPLOAD_WORKSPACE);
    await expect(
      db.query(`DELETE FROM upload_workspaces WHERE id=$1`, [
        LEGACY_UPLOAD_WORKSPACE_ID,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    for (const column of ["id", "machineKey", "mountKey", "type"]) {
      const value = column === "id" ? randomUUID() : "other";
      await expect(
        db.query(`UPDATE upload_workspaces SET "${column}"=$1`, [value]),
      ).rejects.toThrow("immutable");
    }
    for (const [column, value] of [
      ["workspaceId", randomUUID()],
      ["tempPath", path.join(root, ".tmp", "other")],
      ["uploadId", "other"],
    ])
      await expect(
        db.query(`UPDATE upload_sessions SET "${column}"=$1 WHERE id=-1`, [
          value,
        ]),
      ).rejects.toThrow("immutable");
    await db.query(
      `UPDATE upload_sessions SET status='pending',"uploadedSize"=3 WHERE id=-1`,
    );
    await expect(
      db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","userId") VALUES ('old-writer','x',1,$1,1)`,
        [path.join(root, ".tmp", "old-writer")],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","workspaceId","userId") VALUES ('../escape','x',1,$1,$2,1)`,
        [path.join(root, "escape"), LEGACY_UPLOAD_WORKSPACE_ID],
      ),
    ).rejects.toThrow("binding");
    await expect(
      db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","workspaceId","userId") VALUES ('non-uuid','x',1,$1,$2,1)`,
        [path.join(root, ".tmp", "non-uuid"), LEGACY_UPLOAD_WORKSPACE_ID],
      ),
    ).rejects.toThrow("binding");
    await expect(migration.down()).rejects.toThrow("cannot be dropped");
  });
  it.each([
    "outside",
    "traversal",
    "duplicate-separator",
    "upload-id-traversal",
    "non-uuid",
    "workspace-missing",
    "workspace-symlink",
    "session-symlink",
    "session-file",
  ])("rejects %s and rolls back schema plus all old data", async (kind) => {
    if (kind === "outside")
      await db.query(`UPDATE upload_sessions SET "tempPath"=$1 WHERE id=-1`, [
        root + "-outside/.tmp/" + resumable,
      ]);
    if (kind === "traversal")
      await db.query(`UPDATE upload_sessions SET "tempPath"=$1 WHERE id=-1`, [
        root + "/.tmp/../.tmp/" + resumable,
      ]);
    if (kind === "duplicate-separator")
      await db.query(`UPDATE upload_sessions SET "tempPath"=$1 WHERE id=-1`, [
        root + "/.tmp//" + resumable,
      ]);
    if (kind === "upload-id-traversal")
      await db.query(
        `UPDATE upload_sessions SET "uploadId"='../escape' WHERE id=-1`,
      );
    if (kind === "non-uuid")
      await db.query(
        `UPDATE upload_sessions SET "uploadId"='non-uuid',"tempPath"=$1 WHERE id=-1`,
        [path.join(root, ".tmp", "non-uuid")],
      );
    if (kind === "workspace-missing")
      fs.rmSync(path.join(root, ".tmp"), { recursive: true });
    if (kind === "workspace-symlink") {
      fs.renameSync(path.join(root, ".tmp"), path.join(root, "other"));
      fs.symlinkSync(path.join(root, "other"), path.join(root, ".tmp"));
    }
    if (kind === "session-symlink") {
      fs.renameSync(
        path.join(root, ".tmp", resumable),
        path.join(root, "other"),
      );
      fs.symlinkSync(
        path.join(root, "other"),
        path.join(root, ".tmp", resumable),
      );
    }
    if (kind === "session-file") {
      fs.rmSync(path.join(root, ".tmp", resumable), { recursive: true });
      fs.writeFileSync(path.join(root, ".tmp", resumable), "wrong");
    }
    const before = await db.query(`SELECT * FROM upload_sessions ORDER BY id`);
    await expect(apply()).rejects.toThrow();
    expect(await db.query(`SELECT * FROM upload_sessions ORDER BY id`)).toEqual(
      before,
    );
    expect(
      (await db.query(`SELECT to_regclass('upload_workspaces') AS name`))[0]
        .name,
    ).toBeNull();
  });
  it("requires a transaction before touching schema", async () => {
    await expect(migration.up(runner)).rejects.toThrow(
      "requires a transaction",
    );
    expect(
      (await db.query(`SELECT to_regclass('upload_workspaces') AS name`))[0]
        .name,
    ).toBeNull();
  });
});
