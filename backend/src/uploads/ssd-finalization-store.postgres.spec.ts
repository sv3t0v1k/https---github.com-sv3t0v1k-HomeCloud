import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, MigrationInterface } from "typeorm";
import { IsolatedSsdFinalizationJournal1746825180000 } from "../migrations/1746825180000-IsolatedSsdFinalizationJournal";
import {
  LEGACY_UPLOAD_WORKSPACE_ID,
  SSD_UPLOAD_WORKSPACE_ID,
} from "../entities/upload-workspace.entity";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";
import { SsdCrossFsFinalizer } from "./ssd-cross-fs-finalizer";
import {
  FinalizationBinding,
  FinalizationFilesystem,
} from "./ssd-finalization-contract";
import { PostgresSsdFinalizationStore } from "./ssd-finalization-store";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
postgres(
  "Isolated SSD finalization durable journal and atomic metadata",
  () => {
    let admin: DataSource, db: DataSource, store: PostgresSsdFinalizationStore;
    let root: string, schema: string, oldRoot: string | undefined;
    let uploadId: string, operationId: string, sessionId: number;
    let binding: FinalizationBinding;
    const digest = "a".repeat(64);
    beforeEach(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-stage2-journal-"));
      fs.mkdirSync(path.join(root, ".tmp"));
      oldRoot = process.env.STORAGE_PATH;
      process.env.STORAGE_PATH = root;
      schema = "ssd_stage2_" + randomUUID().replace(/-/g, "");
      admin = new DataSource({ type: "postgres", url });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const files = fs
        .readdirSync(path.join(__dirname, "../migrations"))
        .filter(
          (name) =>
            /^\d{13}-.*\.ts$/.test(name) &&
            Number(name.slice(0, 13)) <= 1746825180000,
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
      store = new PostgresSsdFinalizationStore(db);
      uploadId = randomUUID();
      operationId = randomUUID();
      await db.query(
        `INSERT INTO users(id,email,password,"storageQuota","storageUsed") VALUES (1,'journal@example.test','hash',1000,10),(2,'other@example.test','hash',1000,0)`,
      );
      const rows = await db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","uploadedSize","chunkSize","totalChunks","uploadedCount","accountingInitialized","tempPath","workspaceId",status,"expiresAt","userId")
      VALUES ($1,'fixture.bin',6,6,4,2,2,true,$2,$3,'uploading','2030-01-01',1) RETURNING id`,
        [
          uploadId,
          path.join(root, ".tmp", uploadId),
          LEGACY_UPLOAD_WORKSPACE_ID,
        ],
      );
      sessionId = rows[0].id;
      await db.query(
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,0,4,$2),($1,1,2,$2)`,
        [sessionId, digest],
      );
      binding = {
        sourceWorkspaceId: SSD_UPLOAD_WORKSPACE_ID,
        sourceRoot: path.join(root, "ssd-fixture"),
        sourcePath: path.join(root, "ssd-fixture", uploadId),
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
        temporaryPath: path.join(root, "1", `.${operationId}.assembling`),
        storagePath: path.join(root, "1", `${operationId}.ssd-finalized`),
        relativeObjectKey: `1/${operationId}.ssd-finalized`,
      };
    }, 30000);
    afterEach(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
      if (root) fs.rmSync(root, { recursive: true, force: true });
      if (oldRoot === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = oldRoot;
    });
    const begin = () =>
      store.begin({
        id: operationId,
        userId: 1,
        uploadId,
        expectedSha256: digest,
        binding,
      });
    const published = async () => {
      await begin();
      await store.transition(operationId, "assembling", "verified");
      await store.transition(operationId, "verified", "publishing");
      await store.transition(operationId, "publishing", "published");
    };
    const snapshot = () =>
      Promise.all(
        ["upload_sessions", "upload_chunks", "users", "files"].map((table) =>
          db.query(
            `SELECT * FROM ${table} ORDER BY ${table === "upload_chunks" ? '"sessionId","chunkIndex"' : "id"}`,
          ),
        ),
      );
    const state = async () =>
      (
        await db.query(
          `SELECT state,"fileId" FROM ssd_finalization_operations WHERE id=$1`,
          [operationId],
        )
      )[0];

    it("preserves legacy rows until commit, freezes exact manifest and atomically commits File/quota/session with chunks retained", async () => {
      const before = await snapshot();
      const operation = await begin();
      expect(operation.totalSize).toBe(6);
      expect(operation.binding).toEqual(binding);
      expect(await snapshot()).toEqual(before);
      const chunks = [];
      for await (const chunk of store.chunks(operationId)) chunks.push(chunk);
      expect(chunks).toEqual([
        { chunkIndex: 0, byteSize: 4, sha256: digest },
        { chunkIndex: 1, byteSize: 2, sha256: digest },
      ]);
      await store.transition(operationId, "assembling", "verified");
      await store.transition(operationId, "verified", "publishing");
      await store.transition(operationId, "publishing", "published");
      const file = await store.commit(operationId);
      expect(file).toMatchObject({
        name: "fixture.bin",
        size: 6,
        checksum: digest,
        userId: 1,
        uploadId,
        storagePath: binding.storagePath,
      });
      expect(await state()).toEqual({ state: "committed", fileId: file.id });
      expect(
        (await db.query(`SELECT "storageUsed" FROM users WHERE id=1`))[0]
          .storageUsed,
      ).toBe("16");
      expect(
        (
          await db.query(`SELECT status FROM upload_sessions WHERE id=$1`, [
            sessionId,
          ])
        )[0].status,
      ).toBe("completed");
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM upload_chunks WHERE "sessionId"=$1`,
            [sessionId],
          )
        )[0].count,
      ).toBe(2);
      await expect(store.commit(operationId)).rejects.toThrow("published");
      expect(
        (await db.query(`SELECT "storageUsed" FROM users WHERE id=1`))[0]
          .storageUsed,
      ).toBe("16");
    });
    it.each([
      ["gap", `DELETE FROM upload_chunks WHERE "chunkIndex"=0`],
      [
        "extra",
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,2,1,repeat('a',64))`,
      ],
      ["layout", `UPDATE upload_chunks SET "byteSize"=3 WHERE "chunkIndex"=0`],
      [
        "hash",
        `UPDATE upload_chunks SET sha256='invalid' WHERE "chunkIndex"=0`,
      ],
      ["counter", `UPDATE upload_sessions SET "uploadedCount"=1`],
      ["size", `UPDATE upload_sessions SET "uploadedSize"=5`],
      ["expired", `UPDATE upload_sessions SET "expiresAt"='2020-01-01'`],
      [
        "accounting",
        `UPDATE upload_sessions SET "accountingInitialized"=false`,
      ],
    ])(
      "rejects incomplete %s without journal or legacy mutation",
      async (_label, sql) => {
        await db.query(sql, sql.includes("$1") ? [sessionId] : []);
        const before = await snapshot();
        await expect(begin()).rejects.toThrow(/manifest/);
        expect(await snapshot()).toEqual(before);
        expect(
          await db.query(`SELECT * FROM ssd_finalization_operations`),
        ).toEqual([]);
      },
    );
    it("checks ownership, parent ownership and parent deletion", async () => {
      await expect(
        store.begin({
          id: operationId,
          userId: 2,
          uploadId,
          expectedSha256: digest,
          binding,
        }),
      ).rejects.toThrow("paths");
      await db.query(
        `INSERT INTO folders(id,name,"userId") VALUES (1,'Other',2)`,
      );
      await db.query(`UPDATE upload_sessions SET "parentId"=1 WHERE id=$1`, [
        sessionId,
      ]);
      await expect(begin()).rejects.toThrow("parent");
      await db.query(
        `UPDATE folders SET "userId"=1,"isDeleted"=true WHERE id=1`,
      );
      await expect(begin()).rejects.toThrow("parent");
    });
    it("rejects SSD ingress and preserves preexisting identity guards", async () => {
      await expect(
        db.query(`UPDATE upload_sessions SET "workspaceId"=$1 WHERE id=$2`, [
          SSD_UPLOAD_WORKSPACE_ID,
          sessionId,
        ]),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(
          `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","workspaceId","userId") VALUES ($1,'x',6,$2,$3,1)`,
          [randomUUID(), "/ssd/new", SSD_UPLOAD_WORKSPACE_ID],
        ),
      ).rejects.toThrow("binding");
      await expect(
        db.query(
          `UPDATE storage_locations SET "mountKey"='other' WHERE id=$1`,
          [LEGACY_STORAGE_ID],
        ),
      ).rejects.toThrow("immutable");
    });
    it("freezes reserved metadata/chunks and blocks competing legacy File completion while unreserved sessions remain writable", async () => {
      await begin();
      await expect(
        db.query(`UPDATE upload_sessions SET filename='changed' WHERE id=$1`, [
          sessionId,
        ]),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(`UPDATE upload_sessions SET status='completed' WHERE id=$1`, [
          sessionId,
        ]),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(`DELETE FROM upload_sessions WHERE id=$1`, [sessionId]),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(`DELETE FROM upload_chunks WHERE "sessionId"=$1`, [sessionId]),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(
          `UPDATE upload_chunks SET sha256=repeat('b',64) WHERE "sessionId"=$1`,
          [sessionId],
        ),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(
          `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,2,1,repeat('a',64))`,
          [sessionId],
        ),
      ).rejects.toThrow("reserved");
      await expect(
        db.query(
          `INSERT INTO files(name,"storagePath",size,"userId","uploadId","storageLocationId","relativeObjectKey") VALUES ('legacy',$1,6,1,$2,$3,'legacy.bin')`,
          [path.join(root, "legacy.bin"), uploadId, LEGACY_STORAGE_ID],
        ),
      ).rejects.toThrow("reserved");
      const other = randomUUID();
      const [{ id }] = await db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","tempPath","workspaceId","userId") VALUES ($1,'x',4,$2,$3,1) RETURNING id`,
        [other, path.join(root, ".tmp", other), LEGACY_UPLOAD_WORKSPACE_ID],
      );
      await db.query(
        `UPDATE upload_sessions SET "uploadedSize"=4 WHERE id=$1`,
        [id],
      );
      await db.query(
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,0,4,repeat('a',64))`,
        [id],
      );
      await db.query(`DELETE FROM upload_chunks WHERE "sessionId"=$1`, [id]);
      await db.query(`DELETE FROM upload_sessions WHERE id=$1`, [id]);
    });
    it("enforces immutable operation/manifest and monotonic transitions", async () => {
      await begin();
      await expect(
        db.query(
          `UPDATE ssd_finalization_operations SET binding='{}' WHERE id=$1`,
          [operationId],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(`DELETE FROM ssd_finalization_operations WHERE id=$1`, [
          operationId,
        ]),
      ).rejects.toThrow("retained");
      await expect(
        db.query(`DELETE FROM ssd_finalization_chunks WHERE "operationId"=$1`, [
          operationId,
        ]),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(
          `INSERT INTO ssd_finalization_chunks ("operationId","chunkIndex","byteSize",sha256) VALUES ($1,2,1,repeat('a',64))`,
          [operationId],
        ),
      ).rejects.toThrow("sealed");
      await expect(
        store.transition(operationId, "assembling", "published"),
      ).rejects.toThrow("transition");
      await store.transition(operationId, "assembling", "verified");
      await expect(
        store.transition(operationId, "assembling", "verified"),
      ).rejects.toThrow("conflict");
      await expect(store.commit(operationId)).rejects.toThrow("published");
    });
    it("serializes duplicate reservation and globally blocks another session until explicit resolution", async () => {
      const results = await Promise.allSettled([begin(), begin()]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const second = randomUUID();
      const secondOperation = randomUUID();
      const [{ id }] = await db.query(
        `INSERT INTO upload_sessions ("uploadId",filename,"totalSize","uploadedSize","chunkSize","totalChunks","uploadedCount","accountingInitialized","tempPath","workspaceId",status,"userId") VALUES ($1,'x',4,4,4,1,1,true,$2,$3,'uploading',1) RETURNING id`,
        [second, path.join(root, ".tmp", second), LEGACY_UPLOAD_WORKSPACE_ID],
      );
      await db.query(
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) VALUES ($1,0,4,repeat('a',64))`,
        [id],
      );
      await expect(
        store.begin({
          id: secondOperation,
          userId: 1,
          uploadId: second,
          expectedSha256: digest,
          binding: {
            ...binding,
            sourcePath: path.join(binding.sourceRoot, second),
            relativeObjectKey: `1/${secondOperation}.ssd-finalized`,
            storagePath: path.join(
              root,
              "1",
              `${secondOperation}.ssd-finalized`,
            ),
            temporaryPath: path.join(
              root,
              "1",
              `.${secondOperation}.assembling`,
            ),
          },
        }),
      ).rejects.toMatchObject({ code: "23505" });
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM ssd_finalization_operations`,
          )
        )[0].count,
      ).toBe(1);
    });
    it.each(["quota", "parent", "owner"])(
      "rolls back all commit metadata on unavailable %s and retains published journal",
      async (reason) => {
        if (reason === "parent") {
          await db.query(
            `INSERT INTO folders(id,name,"userId") VALUES (1,'owned',1)`,
          );
          await db.query(
            `UPDATE upload_sessions SET "parentId"=1 WHERE id=$1`,
            [sessionId],
          );
        }
        await published();
        if (reason === "quota")
          await db.query(`UPDATE users SET "storageQuota"=12 WHERE id=1`);
        if (reason === "parent")
          await db.query(`UPDATE folders SET "isDeleted"=true WHERE id=1`);
        if (reason === "owner")
          await db.query(`UPDATE users SET "isActive"=false WHERE id=1`);
        const before = await snapshot();
        await expect(store.commit(operationId)).rejects.toThrow();
        expect(await snapshot()).toEqual(before);
        expect(await state()).toEqual({ state: "published", fileId: null });
      },
    );
    it("deferred constraint rejects committed journal without corresponding File/session", async () => {
      await published();
      await expect(
        db.transaction(async (manager) => {
          await manager.query(
            `UPDATE ssd_finalization_operations SET state='committed',"fileId"=500 WHERE id=$1`,
            [operationId],
          );
        }),
      ).rejects.toThrow("Incomplete finalization commit");
      expect(await state()).toEqual({ state: "published", fileId: null });
    });
    it("refuses rollback with retained operations and rolls back empty journal migration safely", async () => {
      const migration = new IsolatedSsdFinalizationJournal1746825180000();
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await expect(migration.down(runner)).rejects.toThrow("transaction");
        await begin();
        await runner.startTransaction();
        await expect(migration.down(runner)).rejects.toThrow("Nonempty");
        await runner.rollbackTransaction();
        expect(await state()).toEqual({ state: "assembling", fileId: null });
      } finally {
        await runner.release();
      }
    });
    it("empty rollback leaves all legacy rows unchanged", async () => {
      const before = await snapshot();
      const runner = db.createQueryRunner();
      await runner.connect();
      try {
        await runner.startTransaction();
        await new IsolatedSsdFinalizationJournal1746825180000().down(runner);
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }
      expect(await snapshot()).toEqual(before);
      const guards = await db.query(
        `SELECT proname,prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'guard_%' ORDER BY proname`,
        [schema],
      );
      const upRunner = db.createQueryRunner();
      await upRunner.connect();
      try {
        await upRunner.startTransaction();
        await new IsolatedSsdFinalizationJournal1746825180000().up(upRunner);
        await upRunner.commitTransaction();
      } finally {
        await upRunner.release();
      }
      expect(await snapshot()).toEqual(before);
      const afterGuards = await db.query(
        `SELECT proname,prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'guard_%' ORDER BY proname`,
        [schema],
      );
      expect(
        afterGuards.filter((row: { proname: string }) =>
          guards.some(
            (old: { proname: string }) => old.proname === row.proname,
          ),
        ),
      ).toEqual(guards);
    });
    it("keeps a 60 GiB manifest paginated and does not allocate by file size", async () => {
      const totalSize = 60 * 1024 ** 3,
        chunkSize = 4 * 1024 ** 2,
        totalChunks = totalSize / chunkSize;
      await db.query(
        `UPDATE upload_sessions SET "totalSize"=$1,"uploadedSize"=$1,"chunkSize"=$2,"totalChunks"=$3,"uploadedCount"=$3 WHERE id=$4`,
        [totalSize, chunkSize, totalChunks, sessionId],
      );
      await db.query(`DELETE FROM upload_chunks WHERE "sessionId"=$1`, [
        sessionId,
      ]);
      await db.query(
        `INSERT INTO upload_chunks ("sessionId","chunkIndex","byteSize",sha256) SELECT $1,i,$2,repeat('a',64) FROM generate_series(0,$3::int-1) i`,
        [sessionId, chunkSize, totalChunks],
      );
      const operation = await begin();
      expect(operation.totalSize).toBe(totalSize);
      const query = jest.spyOn(db, "query");
      let count = 0;
      for await (const chunk of store.chunks(operationId)) {
        expect(chunk.chunkIndex).toBe(count++);
      }
      expect(count).toBe(totalChunks);
      expect(query.mock.calls).toHaveLength(Math.ceil(totalChunks / 128) + 1);
      expect(query.mock.calls.every(([sql]) => sql.includes("LIMIT 128"))).toBe(
        true,
      );
      query.mockRestore();
    }, 30000);
    it.each([false, true])(
      "integrates bounded real-file assembly with PostgreSQL; quota failure=%s retains durable evidence",
      async (quotaFailure) => {
        // Portable test double: bytes and fsync are real; no physical cross-FS or Linux boundary claim.
        const parts = [Buffer.from("abcd"), Buffer.from("ef")];
        const whole = createHash("sha256")
          .update(parts[0])
          .update(parts[1])
          .digest("hex");
        fs.mkdirSync(binding.sourcePath, { recursive: true });
        fs.mkdirSync(path.join(root, "1"));
        for (let i = 0; i < parts.length; i++) {
          fs.writeFileSync(path.join(binding.sourcePath, String(i)), parts[i]);
          await db.query(
            `UPDATE upload_chunks SET sha256=$3 WHERE "sessionId"=$1 AND "chunkIndex"=$2`,
            [sessionId, i, createHash("sha256").update(parts[i]).digest("hex")],
          );
        }
        if (quotaFailure)
          await db.query(`UPDATE users SET "storageQuota"=12 WHERE id=1`);
        const filesystem: FinalizationFilesystem = {
          prepare: (_user, _upload, id) => {
            operationId = id;
            binding = {
              ...binding,
              relativeObjectKey: `1/${id}.ssd-finalized`,
              storagePath: path.join(root, "1", `${id}.ssd-finalized`),
              temporaryPath: path.join(root, "1", `.${id}.assembling`),
            };
            return binding;
          },
          assertBinding: () => undefined,
          openChunk: (value, index) =>
            fs.openSync(path.join(value.sourcePath, String(index)), "r"),
          createTemporary: (value) =>
            fs.openSync(value.temporaryPath, "wx", 0o600),
          publish: (value) => {
            // Test double no-overwrite publication. Production exclusively uses its native boundary.
            fs.linkSync(value.temporaryPath, value.storagePath);
            fs.unlinkSync(value.temporaryPath);
            const directory = fs.openSync(path.dirname(value.storagePath), "r");
            try {
              fs.fsyncSync(directory);
            } finally {
              fs.closeSync(directory);
            }
          },
          close: () => undefined,
        };
        const result = await new SsdCrossFsFinalizer(store, filesystem)
          .finalize({
            userId: 1,
            uploadId,
            expectedSha256: whole,
          })
          .then(
            (file) => ({ file, error: undefined as Error | undefined }),
            (error) => ({ file: undefined, error: error as Error }),
          );
        expect(result.error?.message).toBe(
          quotaFailure ? "Finalization quota exceeded" : undefined,
        );
        expect(result.file?.size).toBe(quotaFailure ? undefined : 6);
        expect(result.file?.checksum).toBe(quotaFailure ? undefined : whole);
        expect(result.file?.storagePath).toBe(
          quotaFailure ? undefined : binding.storagePath,
        );
        expect(await state()).toEqual({
          state: quotaFailure ? "published" : "committed",
          fileId: result.file?.id ?? null,
        });
        expect(
          await db.query(`SELECT id FROM files WHERE "uploadId"=$1`, [
            uploadId,
          ]),
        ).toHaveLength(quotaFailure ? 0 : 1);
        expect(
          (await db.query(`SELECT "storageUsed" FROM users WHERE id=1`))[0]
            .storageUsed,
        ).toBe(quotaFailure ? "10" : "16");
        expect(
          (
            await db.query(`SELECT status FROM upload_sessions WHERE id=$1`, [
              sessionId,
            ])
          )[0].status,
        ).toBe(quotaFailure ? "uploading" : "completed");
        expect(
          createHash("sha256")
            .update(fs.readFileSync(binding.storagePath))
            .digest("hex"),
        ).toBe(whole);
        expect(fs.readdirSync(binding.sourcePath)).toEqual(["0", "1"]);
        expect(
          (
            await db.query(
              `SELECT count(*)::int AS count FROM upload_chunks WHERE "sessionId"=$1`,
              [sessionId],
            )
          )[0].count,
        ).toBe(2);
        expect(
          (
            await db.query(
              `SELECT count(*)::int AS count FROM ssd_finalization_chunks WHERE "operationId"=$1`,
              [operationId],
            )
          )[0].count,
        ).toBe(2);
      },
    );
    it("rolls back File/journal changes when a database failure occurs after File insertion", async () => {
      await published();
      const before = await snapshot();
      await db.query(
        `CREATE FUNCTION fail_test_quota_write() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'injected quota write failure'; END $body$`,
      );
      await db.query(
        `CREATE TRIGGER fail_test_quota_write BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_test_quota_write()`,
      );
      await expect(store.commit(operationId)).rejects.toThrow(
        "injected quota write failure",
      );
      expect(await snapshot()).toEqual(before);
      expect(await state()).toEqual({ state: "published", fileId: null });
    });
    it("forces synchronous WAL commit even when the caller connection defaults to off", async () => {
      await db.query(
        `CREATE FUNCTION require_test_synchronous_commit() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN IF current_setting('synchronous_commit') <> 'on' THEN RAISE EXCEPTION 'unsafe WAL setting'; END IF; RETURN NEW; END $body$`,
      );
      await db.query(
        `CREATE TRIGGER require_test_synchronous_commit BEFORE INSERT OR UPDATE ON ssd_finalization_operations FOR EACH ROW EXECUTE FUNCTION require_test_synchronous_commit()`,
      );
      const caller = new DataSource({
        type: "postgres",
        url,
        schema,
        extra: {
          options: `-c search_path=${schema} -c synchronous_commit=off`,
        },
      });
      await caller.initialize();
      try {
        expect(
          (
            await caller.query(
              `SELECT current_setting('synchronous_commit') AS setting`,
            )
          )[0].setting,
        ).toBe("off");
        const durable = new PostgresSsdFinalizationStore(caller);
        await durable.begin({
          id: operationId,
          userId: 1,
          uploadId,
          expectedSha256: digest,
          binding,
        });
        await durable.transition(operationId, "assembling", "verified");
        await durable.transition(operationId, "verified", "publishing");
        await durable.transition(operationId, "publishing", "published");
        await durable.commit(operationId);
        expect(
          (
            await caller.query(
              `SELECT current_setting('synchronous_commit') AS setting`,
            )
          )[0].setting,
        ).toBe("off");
        expect((await state()).state).toBe("committed");
      } finally {
        await caller.destroy();
      }
    });
  },
);
