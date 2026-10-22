import { randomUUID } from "node:crypto";
import { DataSource, QueryRunner } from "typeorm";
import { PublicFolderShareBinding1746825210000 } from "../migrations/1746825210000-PublicFolderShareBinding";
import { PublicShareOperationReceipts1746825220000 } from "../migrations/1746825220000-PublicShareOperationReceipts";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("Public folder sharing metadata — isolated PostgreSQL", () => {
  let db: DataSource;
  let runner: QueryRunner;
  let schema: string;
  const binding = new PublicFolderShareBinding1746825210000();
  const receipts = new PublicShareOperationReceipts1746825220000();
  const key = "11111111-1111-4111-8111-111111111111";
  const hash = "a".repeat(64);

  beforeAll(async () => {
    db = new DataSource({ type: "postgres", url });
    await db.initialize();
  });

  beforeEach(async () => {
    schema = `public_folder_${randomUUID().replace(/-/g, "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query(`SET LOCAL search_path TO "${schema}"`);
    await runner.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await runner.query(`CREATE TABLE folders (
      id integer PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id),
      "parentId" integer REFERENCES folders(id) ON DELETE SET NULL,
      "isDeleted" boolean NOT NULL DEFAULT false)`);
    await runner.query(`CREATE TABLE files (
      id integer PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id),
      "folderId" integer REFERENCES folders(id) ON DELETE SET NULL,
      "isFolder" boolean NOT NULL, "isDeleted" boolean NOT NULL DEFAULT false)`);
    await runner.query(`CREATE TABLE share_links (
      id integer PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id),
      "fileId" integer NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      "isFolder" boolean NOT NULL, "isActive" boolean NOT NULL DEFAULT true,
      "expiresAt" timestamptz)`);
    await runner.query(`CREATE TABLE upload_sessions (
      id integer PRIMARY KEY, "userId" integer NOT NULL REFERENCES users(id),
      "parentId" integer)`);
    await runner.query(`INSERT INTO users(id) VALUES (1),(2)`);
    await runner.query(`INSERT INTO folders(id,"userId","parentId") VALUES
      (10,1,NULL),(11,1,10),(12,1,NULL),(20,2,NULL)`);
    await runner.query(`INSERT INTO files(id,"userId","folderId","isFolder") VALUES
      (110,1,10,true),(111,1,11,true),(112,1,12,true),(120,2,20,true),
      (130,1,NULL,false)`);
    await runner.query(`INSERT INTO share_links(id,"userId","fileId","isFolder") VALUES
      (210,1,110,true),(211,1,130,false),(212,2,120,true)`);
    await runner.query(
      `INSERT INTO upload_sessions(id,"userId","parentId") VALUES (310,1,11)`,
    );
  });

  afterEach(async () => {
    if (runner && !runner.isReleased) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
    if (schema) await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  async function rejected(sql: string, params: unknown[] = []): Promise<void> {
    await runner.query(`SAVEPOINT expected_rejection`);
    await expect(runner.query(sql, params)).rejects.toThrow();
    await runner.query(`ROLLBACK TO SAVEPOINT expected_rejection`);
    await runner.query(`RELEASE SAVEPOINT expected_rejection`);
  }

  it("migrates old links and owner sessions without granting write access", async () => {
    await binding.up(runner);
    await receipts.up(runner);
    expect(
      await runner.query(
        `SELECT id,"allowUpload" FROM share_links ORDER BY id`,
      ),
    ).toEqual([
      { id: 210, allowUpload: false },
      { id: 211, allowUpload: false },
      { id: 212, allowUpload: false },
    ]);
    expect(
      await runner.query(
        `SELECT id,origin,"shareLinkId","shareRootFolderId" FROM upload_sessions`,
      ),
    ).toEqual([
      { id: 310, origin: "owner", shareLinkId: null, shareRootFolderId: null },
    ]);
    await runner.query(
      `INSERT INTO share_links(id,"userId","fileId","isFolder") VALUES (213,1,110,true)`,
    );
    await runner.query(
      `INSERT INTO upload_sessions(id,"userId","parentId") VALUES (313,1,11)`,
    );
    expect(
      (
        await runner.query(`SELECT "allowUpload" FROM share_links WHERE id=213`)
      )[0].allowUpload,
    ).toBe(false);
    expect(
      (await runner.query(`SELECT origin FROM upload_sessions WHERE id=313`))[0]
        .origin,
    ).toBe("owner");
    await rejected(`UPDATE share_links SET "allowUpload"=true WHERE id=211`);
    await rejected(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId")
      VALUES (314,1,11,'owner',210)`);
    await receipts.down(runner);
    await binding.down(runner);
    expect(
      await runner.query(`SELECT id FROM share_links ORDER BY id`),
    ).toEqual([{ id: 210 }, { id: 211 }, { id: 212 }, { id: 213 }]);
    expect(
      await runner.query(`SELECT id FROM upload_sessions ORDER BY id`),
    ).toEqual([{ id: 310 }, { id: 313 }]);
  });

  it("binds public sessions to a live permitted subtree and fails closed after deletion", async () => {
    await binding.up(runner);
    await receipts.up(runner);
    await runner.query(
      `UPDATE share_links SET "allowUpload"=true WHERE id=210`,
    );
    await rejected(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId","shareRootFolderId")
      VALUES (311,1,12,'public',210,10)`);
    await rejected(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId","shareRootFolderId")
      VALUES (311,2,20,'public',210,10)`);
    await rejected(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId","shareRootFolderId")
      VALUES (311,1,11,'public',210,NULL)`);
    await runner.query(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId","shareRootFolderId")
      VALUES (311,1,11,'public',210,10)`);
    await runner.query(`UPDATE folders SET "parentId"=12 WHERE id=11`);
    await rejected(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
      VALUES (210,10,1,'upload_session',$1,$2,311,now()+interval '1 day')`,
      [randomUUID(), hash],
    );
    await runner.query(`UPDATE folders SET "parentId"=10 WHERE id=11`);
    await runner.query(`UPDATE folders SET "isDeleted"=true WHERE id=10`);
    await rejected(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
      VALUES (210,10,1,'upload_session',$1,$2,311,now()+interval '1 day')`,
      [randomUUID(), hash],
    );
    await runner.query(`UPDATE folders SET "isDeleted"=false WHERE id=10`);
    await rejected(`UPDATE upload_sessions SET origin='owner' WHERE id=311`);
    await rejected(`UPDATE upload_sessions SET "parentId"=12 WHERE id=311`);
    await rejected(`UPDATE upload_sessions SET "shareLinkId"=212 WHERE id=311`);
    await runner.query(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
      VALUES (210,10,1,'upload_session',$1,$2,311,now()+interval '1 day')`,
      [key, hash],
    );
    await rejected(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
      VALUES (210,10,1,'upload_session',$1,$2,311,now()+interval '1 day')`,
      [key, "b".repeat(64)],
    );
    await rejected(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultFolderId","expiresAt")
      VALUES (210,10,1,'mkdir',$1,$2,12,now()+interval '1 day')`,
      [key, hash],
    );
    await runner.query(`DELETE FROM share_links WHERE id=210`);
    expect(
      await runner.query(
        `SELECT origin,"shareLinkId","shareRootFolderId" FROM upload_sessions WHERE id=311`,
      ),
    ).toEqual([{ origin: "public", shareLinkId: null, shareRootFolderId: 10 }]);
    expect(
      await runner.query(`SELECT "shareLinkId" FROM public_share_operations`),
    ).toEqual([{ shareLinkId: null }]);
    await rejected(`UPDATE upload_sessions SET "shareLinkId"=212 WHERE id=311`);
    await rejected(`UPDATE public_share_operations SET "shareLinkId"=212`);
    await runner.query(`DELETE FROM folders WHERE id=10`);
    expect(
      await runner.query(
        `SELECT "shareRootFolderId" FROM upload_sessions WHERE id=311`,
      ),
    ).toEqual([{ shareRootFolderId: null }]);
    expect(
      await runner.query(
        `SELECT "shareRootFolderId" FROM public_share_operations`,
      ),
    ).toEqual([{ shareRootFolderId: null }]);
  });

  it("refuses schema rollback while public capabilities or receipts exist", async () => {
    await binding.up(runner);
    await receipts.up(runner);
    await runner.query(
      `UPDATE share_links SET "allowUpload"=true WHERE id=210`,
    );
    await runner.query(`INSERT INTO upload_sessions(id,"userId","parentId",origin,"shareLinkId","shareRootFolderId")
      VALUES (311,1,11,'public',210,10)`);
    await runner.query(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","expiresAt")
      VALUES (210,10,1,'upload_session',$1,$2,311,now()+interval '1 day')`,
      [key, hash],
    );
    await expect(receipts.down(runner)).rejects.toThrow("receipts prevent");
    await expect(binding.down(runner)).rejects.toThrow("metadata prevents");
    await runner.query(`DELETE FROM public_share_operations`);
    await receipts.down(runner);
    await expect(binding.down(runner)).rejects.toThrow("metadata prevents");
    await runner.query(`DELETE FROM upload_sessions WHERE id=311`);
    await runner.query(
      `UPDATE share_links SET "allowUpload"=false WHERE id=210`,
    );
    await binding.down(runner);
  });
});
