import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DataSource, MigrationInterface, QueryRunner } from "typeorm";
import { DurableUploadWholeSha2561746825200000 } from "../migrations/1746825200000-DurableUploadWholeSha256";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  SSD_UPLOAD_WORKSPACE_ID,
} from "../entities/upload-workspace.entity";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";
import { PostgresSsdFinalizationStore } from "./ssd-finalization-store";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("Durable SHA256 admission and production SSD journal contract", () => {
  let admin: DataSource, db: DataSource, runner: QueryRunner;
  let root: string, ssd: string, schema: string, legacyUploadId: string;
  let oldRoot: string | undefined, oldSsd: string | undefined;
  const migration = new DurableUploadWholeSha2561746825200000();
  const digest = "a".repeat(64);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-whole-sha256-"));
    fs.mkdirSync(path.join(root, ".tmp"));
    // Deliberately absent: mapping migration must never provision filesystem roots.
    ssd = root + "-ssd";
    oldRoot = process.env.STORAGE_PATH;
    oldSsd = process.env.UPLOAD_SSD_PATH;
    process.env.STORAGE_PATH = root;
    process.env.UPLOAD_SSD_PATH = ssd;
    schema = "whole_sha256_" + randomUUID().replace(/-/g, "");
    admin = new DataSource({ type: "postgres", url });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const files = fs
      .readdirSync(path.join(__dirname, "../migrations"))
      .filter(
        (name) =>
          /^\d{13}-.*\.ts$/.test(name) &&
          Number(name.slice(0, 13)) < 1746825200000,
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
    await db.query(
      `INSERT INTO users (id,email,password,"storageUsed","storageQuota") VALUES (1,'sha256@example.test','hash',7,1000)`,
    );
    legacyUploadId = randomUUID();
    await db.query(
      `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","chunkSize","totalChunks","uploadedSize","uploadedCount","accountingInitialized","tempPath","workspaceId",status,"userId")
      VALUES ($1,'legacy.bin',4,4,1,4,1,true,$2,$3,'uploading',1)`,
      [
        legacyUploadId,
        path.join(root, ".tmp", legacyUploadId),
        LEGACY_UPLOAD_WORKSPACE_ID,
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
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (oldRoot === undefined) delete process.env.STORAGE_PATH;
    else process.env.STORAGE_PATH = oldRoot;
    if (oldSsd === undefined) delete process.env.UPLOAD_SSD_PATH;
    else process.env.UPLOAD_SSD_PATH = oldSsd;
  });

  async function change(direction: "up" | "down" = "up") {
    await runner.startTransaction();
    try {
      await migration[direction](runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  }

  async function insertSession(
    expectedSha256: unknown = digest,
    workspaceId = SSD_UPLOAD_WORKSPACE_ID,
    sourceRoot = ssd,
  ) {
    const uploadId = randomUUID();
    const [row] = await db.query(
      `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","chunkSize","totalChunks","uploadedSize","uploadedCount","accountingInitialized","tempPath","workspaceId",status,"userId","expectedSha256")
      VALUES ($1,'new.bin',4,4,1,4,1,true,$2,$3,'uploading',1,$4) RETURNING *`,
      [uploadId, path.join(sourceRoot, uploadId), workspaceId, expectedSha256],
    );
    await db.query(
      `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,0,4,$2)`,
      [row.id, digest],
    );
    return row;
  }

  function request(session: { uploadId: string }, expectedSha256 = digest) {
    const id = randomUUID();
    return {
      id,
      userId: 1,
      uploadId: session.uploadId,
      expectedSha256,
      binding: {
        sourceWorkspaceId: SSD_UPLOAD_WORKSPACE_ID,
        sourceRoot: ssd,
        sourcePath: path.join(ssd, session.uploadId),
        sourceDevice: "1",
        sourceInode: "2",
        sourceDirectoryDevice: "1",
        sourceDirectoryInode: "3",
        targetStorageId: LEGACY_STORAGE_ID,
        targetRoot: root,
        targetDevice: "4",
        targetInode: "5",
        targetDirectoryDevice: "4",
        targetDirectoryInode: "6",
        temporaryPath: path.join(root, "1", `.${id}.assembling`),
        storagePath: path.join(root, "1", `${id}.ssd-finalized`),
        relativeObjectKey: `1/${id}.ssd-finalized`,
      },
    };
  }

  it("rejects a changed legacy operator root before additive DDL and keeps the old guard usable", async () => {
    const before = (await db.query(`SELECT * FROM upload_sessions`))[0];
    const [guard] = await db.query(
      `SELECT prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname='guard_upload_session_binding'`,
      [schema],
    );
    process.env.STORAGE_PATH = root + "-other-hdd";
    await expect(change()).rejects.toThrow("legacy session root");
    expect((await db.query(`SELECT * FROM upload_sessions`))[0]).toEqual(
      before,
    );
    expect(
      await db.query(
        `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='upload_sessions' AND column_name='expectedSha256'`,
        [schema],
      ),
    ).toEqual([]);
    expect(
      (
        await db.query(
          `SELECT prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname='guard_upload_session_binding'`,
          [schema],
        )
      )[0],
    ).toEqual(guard);
    await db.query(
      `UPDATE upload_sessions SET filename='old-guard-still-works.bin' WHERE "uploadId"=$1`,
      [legacyUploadId],
    );
    process.env.STORAGE_PATH = root;
    await change();
    expect(
      (
        await db.query(
          `SELECT "expectedSha256" FROM upload_sessions WHERE "uploadId"=$1`,
          [legacyUploadId],
        )
      )[0].expectedSha256,
    ).toBeNull();
  });

  it("preserves populated legacy sessions and restores legacy binding on unused rollback", async () => {
    const before = (await db.query(`SELECT * FROM upload_sessions`))[0];
    const bindingBefore = (
      await db.query(
        `SELECT prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname='guard_upload_session_binding'`,
        [schema],
      )
    )[0];
    await change();
    expect((await db.query(`SELECT * FROM upload_sessions`))[0]).toEqual({
      ...before,
      expectedSha256: null,
    });
    expect(fs.existsSync(ssd)).toBe(false);
    await db.query(
      `UPDATE upload_sessions SET filename='legacy-renamed.bin' WHERE "uploadId"=$1`,
      [legacyUploadId],
    );
    await change("down");
    expect(
      (await db.query(`SELECT * FROM upload_sessions`))[0].expectedSha256,
    ).toBeUndefined();
    expect(
      (
        await db.query(
          `SELECT prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname='guard_upload_session_binding'`,
          [schema],
        )
      )[0].prosrc,
    ).not.toContain(SSD_UPLOAD_WORKSPACE_ID);
    expect(bindingBefore.prosrc).toContain(LEGACY_UPLOAD_WORKSPACE_ID);
  });

  it.each([
    null,
    "A".repeat(64),
    "g".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    "a".repeat(64) + "\n",
  ])(
    "rejects malformed/missing SSD SHA256 %p at the database boundary",
    async (value) => {
      await change();
      await expect(insertSession(value)).rejects.toThrow();
      expect(
        await db.query(
          `SELECT id FROM upload_sessions WHERE "workspaceId"=$1`,
          [SSD_UPLOAD_WORKSPACE_ID],
        ),
      ).toEqual([]);
    },
  );

  it("rejects hash changes including NULL promotion and freezes only checksummed metadata", async () => {
    await change();
    const session = await insertSession();
    for (const [column, value] of [
      ["expectedSha256", null],
      ["expectedSha256", "b".repeat(64)],
      ["filename", "changed.bin"],
      ["totalSize", 5],
      ["chunkSize", 5],
      ["totalChunks", 2],
    ] as const)
      await expect(
        db.query(`UPDATE upload_sessions SET "${column}"=$2 WHERE id=$1`, [
          session.id,
          value,
        ]),
      ).rejects.toThrow("immutable");
    await expect(
      db.query(
        `UPDATE upload_sessions SET "expectedSha256"=$2 WHERE "uploadId"=$1`,
        [legacyUploadId, digest],
      ),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(`UPDATE upload_sessions SET status='aborted' WHERE id=$1`, [
        session.id,
      ]),
    ).resolves.toBeDefined();
    await expect(change("down")).rejects.toThrow("prevent checksum rollback");
    expect(
      (
        await db.query(
          `SELECT "expectedSha256" FROM upload_sessions WHERE id=$1`,
          [session.id],
        )
      )[0].expectedSha256,
    ).toBe(digest);
  });

  it("requires explicit disjoint mapping and rejects inconsistent workspace paths", async () => {
    process.env.UPLOAD_SSD_PATH = path.join(root, "nested");
    await expect(change()).rejects.toThrow("disjoint");
    delete process.env.UPLOAD_SSD_PATH;
    await change();
    await expect(insertSession()).rejects.toThrow("binding");
    await change("down");
    process.env.UPLOAD_SSD_PATH = ssd;
    await change();
    await expect(
      insertSession(
        digest,
        SSD_UPLOAD_WORKSPACE_ID,
        path.join(ssd, "unmapped"),
      ),
    ).rejects.toThrow("binding");
  });

  it("production store rejects legacy and mismatched durable SHA256 sessions", async () => {
    await change();
    const store = new PostgresSsdFinalizationStore(db, "ssd");
    await expect(
      store.begin(request({ uploadId: legacyUploadId })),
    ).rejects.toThrow("manifest metadata");
    const session = await insertSession();
    await expect(store.begin(request(session, "b".repeat(64)))).rejects.toThrow(
      "manifest metadata",
    );
    const wrongPath = request(session);
    wrongPath.binding.sourceRoot = ssd + "-wrong";
    wrongPath.binding.sourcePath = path.join(
      wrongPath.binding.sourceRoot,
      session.uploadId,
    );
    await expect(store.begin(wrongPath)).rejects.toThrow("manifest metadata");
    expect(
      await db.query(`SELECT id FROM ssd_finalization_operations`),
    ).toEqual([]);
  });

  it("persists write-once verified MIME before publishing and atomically commits File/quota/session", async () => {
    await change();
    const session = await insertSession();
    const store = new PostgresSsdFinalizationStore(db, "ssd");
    const input = request(session);
    const op = await store.begin(input);
    expect(op).toMatchObject({
      expectedSha256: digest,
      mimeType: "application/octet-stream",
      mimeTypeCheckpointed: false,
    });
    await expect(store.recordMimeType(op.id, "text/plain")).rejects.toThrow(
      "verified",
    );
    await store.recordTarget(op.id, { device: "4", inode: "42" });
    await store.transition(op.id, "assembling", "verified");
    await expect(
      store.transition(op.id, "verified", "publishing"),
    ).rejects.toThrow("MIME checkpoint");
    await store.recordMimeType(op.id, "text/plain");
    await store.recordMimeType(op.id, "text/plain");
    await expect(store.recordMimeType(op.id, "image/png")).rejects.toThrow(
      "immutable",
    );
    await expect(
      db.query(
        `UPDATE ssd_finalization_operations SET "mimeType"='image/png' WHERE id=$1`,
        [op.id],
      ),
    ).rejects.toThrow("immutable");
    await store.transition(op.id, "verified", "publishing");
    await store.transition(op.id, "publishing", "published");
    const file = await store.commit(op.id);
    expect(file).toMatchObject({
      mimeType: "text/plain",
      checksum: digest,
      size: 4,
      uploadId: session.uploadId,
    });
    expect((await store.commit(op.id)).id).toBe(file.id);
    expect(
      (await db.query(`SELECT "storageUsed" FROM users WHERE id=1`))[0]
        .storageUsed,
    ).toBe("11");
    expect(
      (
        await db.query(`SELECT status FROM upload_sessions WHERE id=$1`, [
          session.id,
        ])
      )[0].status,
    ).toBe("completed");
    await store.finishCleanup(op.id);
    expect((await store.lookup(op.id)).operation.cleanupState).toBe("cleaned");
    expect(
      await db.query(`SELECT * FROM upload_chunks WHERE "sessionId"=$1`, [
        session.id,
      ]),
    ).toEqual([]);
    await db.query(`DELETE FROM upload_sessions WHERE id=$1`, [session.id]);
    await expect(change("down")).rejects.toThrow("MIME prevents");
  });

  it("rejects a mismatched File MIME even when SQL bypasses the store commit helper", async () => {
    await change();
    const session = await insertSession();
    const store = new PostgresSsdFinalizationStore(db, "ssd");
    const input = request(session);
    const op = await store.begin(input);
    await store.recordTarget(op.id, { device: "4", inode: "42" });
    await store.transition(op.id, "assembling", "verified");
    await store.recordMimeType(op.id, "text/plain");
    await store.transition(op.id, "verified", "publishing");
    await store.transition(op.id, "publishing", "published");
    await expect(
      db.transaction(async (manager) => {
        const [{ id }] = await manager.query(
          `SELECT nextval(pg_get_serial_sequence('files','id'))::int AS id`,
        );
        await manager.query(
          `UPDATE ssd_finalization_operations SET state='committed',"fileId"=$2 WHERE id=$1`,
          [op.id, id],
        );
        await manager.query(
          `INSERT INTO files (id,name,"storagePath","storageLocationId","relativeObjectKey",size,"mimeType",checksum,"parentId","userId","uploadId")
        VALUES ($1,'new.bin',$2,$3,$4,4,'application/octet-stream',$5,NULL,1,$6)`,
          [
            id,
            input.binding.storagePath,
            LEGACY_STORAGE_ID,
            input.binding.relativeObjectKey,
            digest,
            session.uploadId,
          ],
        );
        await manager.query(
          `UPDATE upload_sessions SET status='completed' WHERE id=$1`,
          [session.id],
        );
      }),
    ).rejects.toThrow("MIME commit");
    expect((await store.lookup(op.id)).operation.state).toBe("published");
    expect(
      await db.query(`SELECT id FROM files WHERE "uploadId"=$1`, [
        session.uploadId,
      ]),
    ).toEqual([]);
    expect(
      (await db.query(`SELECT "storageUsed" FROM users WHERE id=1`))[0]
        .storageUsed,
    ).toBe("7");
  });
});
