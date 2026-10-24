import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { PublicFolderService } from "./public-folder.service";
import { SharingService } from "./sharing.service";
import { FilesService } from "../files/files.service";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import appDataSource from "../data-source";
import { LEGACY_STORAGE_ID } from "../storage/storage-placement";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("public folder creation — PostgreSQL", () => {
  const schema = `public_folder_${randomUUID().replace(/-/g, "")}`;
  let admin: DataSource;
  let db: DataSource;
  let service: PublicFolderService;
  let share: any;
  let root: string;
  let originalStoragePath: string | undefined;
  let originalTestStoragePath: string | undefined;
  const token = "stage2-public-folder-token";

  beforeAll(async () => {
    originalStoragePath = process.env.STORAGE_PATH;
    originalTestStoragePath = process.env.HOMECLOUD_TEST_STORAGE_PATH;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-public-folder-"));
    fs.mkdirSync(path.join(root, ".tmp"));
    process.env.STORAGE_PATH = root;
    process.env.HOMECLOUD_TEST_STORAGE_PATH = root;
    admin = new DataSource({ type: "postgres", url });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: "postgres",
      url,
      schema,
      entities: appDataSource.options.entities,
      migrations: appDataSource.options.migrations,
      extra: { options: `-c search_path=${schema}` },
    });
    await db.initialize();
    await db.runMigrations();
    const shares = {
      findShareByToken: jest.fn(async () => share),
      verifySharePassword: jest.fn(async (_token: string, password: string) => {
        if (password !== "correct") throw new Error("Invalid password");
        return true;
      }),
    } as unknown as SharingService;
    service = new PublicFolderService(db, shares, {
      get: () => "stage2-test-secret",
    } as unknown as ConfigService);
  }, 30000);
  afterAll(async () => {
    try {
      if (db?.isInitialized) await db.destroy();
    } finally {
      try {
        if (admin?.isInitialized) {
          try {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin.destroy();
          }
        }
      } finally {
        try {
          if (root) fs.rmSync(root, { recursive: true, force: true });
        } finally {
          if (originalStoragePath === undefined) delete process.env.STORAGE_PATH;
          else process.env.STORAGE_PATH = originalStoragePath;
          if (originalTestStoragePath === undefined) delete process.env.HOMECLOUD_TEST_STORAGE_PATH;
          else process.env.HOMECLOUD_TEST_STORAGE_PATH = originalTestStoragePath;
        }
      }
    }
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE public_share_operations, share_links, files, folders, users RESTART IDENTITY CASCADE`,
    );
    await db.query(
      `INSERT INTO users(id,email,password,name) VALUES (1,'stage2@example.invalid','synthetic','QA')`,
    );
    await db.query(`INSERT INTO folders(id,name,"userId","parentId") VALUES
      (10,'shared',1,NULL),(11,'child',1,10),(12,'outside',1,NULL)`);
    await db.query(`INSERT INTO files(id,name,"isFolder","userId","folderId","parentId",version)
      VALUES (110,'shared',true,1,10,NULL,1),(111,'child',true,1,11,10,1),
             (112,'outside',true,1,12,NULL,1)`);
    await db.query(
      `INSERT INTO share_links(id,token,"userId","fileId","isFolder","allowUpload","expiresAt")
      VALUES (210,$1,1,110,true,true,now()+interval '1 day')`,
      [token],
    );
    share = {
      id: 210,
      token,
      userId: 1,
      isFolder: true,
      allowUpload: true,
      expiresAt: new Date(Date.now() + 86400000),
      password: null,
      file: { folderId: 10 },
    };
  });

  async function proof() {
    return (await service.authorize(token)).proof;
  }
  async function count() {
    return Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM folders WHERE id NOT IN (10,11,12)`,
        )
      )[0].n,
    );
  }

  it("creates nested folders, preserves old objects, resolves collisions and retries", async () => {
    const auth = await proof();
    const key = randomUUID();
    const first = await service.createFolder(token, auth, key, {
      parentId: 10,
      name: "child",
    });
    expect(first).toMatchObject({ parentId: 10, name: "child (1)" });
    expect(
      await service.createFolder(token, auth, key, {
        parentId: 10,
        name: "child",
      }),
    ).toEqual(first);
    const nested = await service.createFolder(token, auth, randomUUID(), {
      parentId: first.id,
      name: "deeper",
    });
    expect(nested.parentId).toBe(first.id);
    expect(await count()).toBe(2);
    await expect(
      service.createFolder(token, auth, key, {
        parentId: 10,
        name: "different",
      }),
    ).rejects.toThrow();
    expect(
      (await db.query(`SELECT name FROM folders WHERE id=11`))[0].name,
    ).toBe("child");
  });

  it("rejects outside, read-only, revoked and expired links without writes", async () => {
    const auth = await proof();
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 12,
        name: "bad",
      }),
    ).rejects.toThrow();
    await db.query(`UPDATE share_links SET "allowUpload"=false WHERE id=210`);
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "bad",
      }),
    ).rejects.toThrow();
    await db.query(
      `UPDATE share_links SET "allowUpload"=true,"isActive"=false WHERE id=210`,
    );
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "bad",
      }),
    ).rejects.toThrow();
    await db.query(
      `UPDATE share_links SET "isActive"=true,"expiresAt"=now()-interval '1 minute' WHERE id=210`,
    );
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "bad",
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it("rejects moved or deleted target at commit admission", async () => {
    const auth = await proof();
    await db.query(`UPDATE folders SET "parentId"=12 WHERE id=11`);
    await db.query(`UPDATE files SET "parentId"=12 WHERE id=111`);
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 11,
        name: "bad",
      }),
    ).rejects.toThrow();
    await db.query(
      `UPDATE folders SET "parentId"=10,"isDeleted"=true WHERE id=11`,
    );
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 11,
        name: "bad",
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });

  it("rejects a link that expires while waiting for its row lock", async () => {
    await db.query(`UPDATE share_links SET "expiresAt"=clock_timestamp()+interval '300 milliseconds' WHERE id=210`);
    const auth = await proof();
    const blocker = db.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    try {
      await blocker.query(`SELECT id FROM share_links WHERE id=210 FOR UPDATE`);
      const attempt = service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "too-late",
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await blocker.commitTransaction();
      await expect(attempt).rejects.toThrow();
      expect(await count()).toBe(0);
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
    }
  });

  it("serializes concurrent public creations and one-key retries", async () => {
    const auth = await proof();
    const key = randomUUID();
    const results = await Promise.all([
      service.createFolder(token, auth, key, {
        parentId: 10,
        name: "parallel",
      }),
      service.createFolder(token, auth, key, {
        parentId: 10,
        name: "parallel",
      }),
      service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "parallel",
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(new Set(results.map((result) => result.name))).toEqual(
      new Set(["parallel", "parallel (1)"]),
    );
    expect(await count()).toBe(2);
  });

  it("keeps owner and public folder names distinct under concurrent requests", async () => {
    const owner = new FilesService(db.getRepository(FileEntity), db.getRepository(FolderEntity), {} as any, {} as any);
    const auth = await proof();
    const original = db.transaction.bind(db);
    let release!: () => void;
    let selected!: () => void;
    const paused = new Promise<void>(resolve => { selected = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    (db as any).transaction = async (callback: any) => original(async manager => {
      const query = manager.query.bind(manager);
      manager.query = async (sql: string, params?: any[]) => {
        const result = await query(sql, params);
        if (sql.includes("SELECT name FROM files")) { selected(); await gate; }
        return result;
      };
      return callback(manager);
    });
    try {
      const publicRequest = service.createFolder(token, auth, randomUUID(), {parentId:10,name:"simultaneous"});
      await paused;
      const ownerRequest = owner.createFolder(1,"simultaneous",10);
      await new Promise(resolve => setTimeout(resolve,25));
      release();
      const [publicFolder, ownerMirror] = await Promise.all([publicRequest,ownerRequest]);
      expect(new Set([publicFolder.name,ownerMirror.name]).size).toBe(2);
    } finally {
      release();
      (db as any).transaction = original;
    }
  });

  it("keeps an owner file and a public folder distinct under concurrent requests", async () => {
    const storageRoot = process.env.HOMECLOUD_TEST_STORAGE_PATH;
    if (!storageRoot) throw new Error("HOMECLOUD_TEST_STORAGE_PATH is required for file collision test");
    const path = `${storageRoot}/qa-${randomUUID()}`;
    const owner = new FilesService(db.getRepository(FileEntity), db.getRepository(FolderEntity), {
      generateSafeFilename: (name: string) => name,
      generatePath: () => path,
      placementForPath: () => ({storagePath:path,storageLocationId:LEGACY_STORAGE_ID,relativeObjectKey:path.slice(storageRoot.length+1)}),
    } as any, {findById: async () => ({id:1}),updateStorageUsed: async () => undefined} as any);
    const auth = await proof();
    const original = db.transaction.bind(db);
    let release!: () => void;
    let selected!: () => void;
    const paused = new Promise<void>(resolve => { selected = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    (db as any).transaction = async (callback: any) => original(async manager => {
      const query = manager.query.bind(manager);
      manager.query = async (sql: string, params?: any[]) => {
        const result = await query(sql, params);
        if (sql.includes("SELECT name FROM files")) { selected(); await gate; }
        return result;
      };
      return callback(manager);
    });
    try {
      const publicRequest = service.createFolder(token, auth, randomUUID(), {parentId:10,name:"cross-type"});
      await paused;
      const ownerRequest = owner.createFile(1,"cross-type",1,"application/octet-stream",10);
      await new Promise(resolve => setTimeout(resolve,25));
      release();
      const [publicFolder, ownerFile] = await Promise.all([publicRequest,ownerRequest]);
      expect(new Set([publicFolder.name,ownerFile.name]).size).toBe(2);
      expect((await db.query(`SELECT count(*)::int AS n FROM files WHERE "parentId"=10 AND name IN ('cross-type','cross-type (1)')`))[0].n).toBe(2);
    } finally {
      release();
      (db as any).transaction = original;
    }
  });

  it("keeps names distinct when owner renames, moves, and restores folders", async () => {
    const owner = new FilesService(
      db.getRepository(FileEntity), db.getRepository(FolderEntity),
      {} as any, {} as any,
    );
    const auth = await proof();
    const publicFolder = await service.createFolder(token, auth, randomUUID(), {
      parentId: 10, name: "target",
    });
    const renamed = await owner.updateFolder(1, 11, { name: "target" });
    expect(renamed.name).toBe("target (1)");
    const moved = await owner.updateFolder(1, 12, { parentId: 10, name: "target" });
    expect(moved.name).toBe("target (2)");
    await db.query(`UPDATE folders SET "isDeleted"=true WHERE id=$1`, [publicFolder.id]);
    await db.query(`UPDATE files SET "isDeleted"=true WHERE "folderId"=$1`, [publicFolder.id]);
    await service.createFolder(token, auth, randomUUID(), { parentId: 10, name: "target" });
    await owner.restoreFolder(1, publicFolder.id);
    const [restored] = await db.query(`SELECT name FROM folders WHERE id=$1`, [publicFolder.id]);
    expect(restored.name).toBe("target (3)");
  });

  it("keeps names distinct when a file rename races with public folder creation", async () => {
    const owner = new FilesService(
      db.getRepository(FileEntity), db.getRepository(FolderEntity),
      {} as any, {} as any,
    );
    const storageRoot = process.env.HOMECLOUD_TEST_STORAGE_PATH;
    if (!storageRoot) throw new Error("HOMECLOUD_TEST_STORAGE_PATH is required");
    await db.query(`INSERT INTO files(id,name,"isFolder","userId","parentId",version,
      "storageLocationId","relativeObjectKey","storagePath")
      VALUES (120,'old',false,1,10,1,$1,'qa-old',$2)`,
      [LEGACY_STORAGE_ID, `${storageRoot}/qa-old`]);
    const auth = await proof();
    const [file, folder] = await Promise.all([
      owner.updateFile(1, 120, { name: "concurrent" }),
      service.createFolder(token, auth, randomUUID(), { parentId: 10, name: "concurrent" }),
    ]);
    expect(new Set([file.name, folder.name])).toEqual(
      new Set(["concurrent", "concurrent (1)"]),
    );
  });

  it("serializes folder rename with public creation and opposite owner moves", async () => {
    const owner = new FilesService(
      db.getRepository(FileEntity), db.getRepository(FolderEntity),
      {} as any, {} as any,
    );
    const auth = await proof();
    const [renamed, created] = await Promise.all([
      owner.updateFolder(1, 11, { name: "folder-race" }),
      service.createFolder(token, auth, randomUUID(), { parentId: 10, name: "folder-race" }),
    ]);
    expect(new Set([renamed.name, created.name])).toEqual(
      new Set(["folder-race", "folder-race (1)"]),
    );
    const moves = await Promise.allSettled([
      owner.updateFolder(1, 11, { parentId: created.id }),
      owner.updateFolder(1, created.id, { parentId: 11 }),
    ]);
    expect(moves.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(moves.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = moves.find(result => result.status === "rejected");
    if (rejected?.status !== "rejected") throw new Error("Expected one rejected move");
    expect(rejected.reason.message).toBe("Cannot move folder into its own subtree");
  });

  it("bounds folder metadata per public link", async () => {
    const auth = await proof();
    await db.query(
      `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultFolderId","expiresAt")
      SELECT 210,10,1,'mkdir',md5(g::text)::uuid,$1,11,now()+interval '1 day'
      FROM generate_series(1,1000) g`,
      ["a".repeat(64)],
    );
    await expect(
      service.createFolder(token, auth, randomUUID(), {
        parentId: 10,
        name: "over-cap",
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(await count()).toBe(0);
  });

  it("requires proof and a valid password for password-protected links", async () => {
    share.password = "stored-hash";
    await expect(service.authorize(token, "bad")).rejects.toThrow();
    const auth = (await service.authorize(token, "correct")).proof;
    await expect(
      service.createFolder(token, undefined, randomUUID(), {
        parentId: 10,
        name: "bad",
      }),
    ).rejects.toThrow();
    expect(
      (
        await service.createFolder(token, auth, randomUUID(), {
          parentId: 10,
          name: "good",
        })
      ).name,
    ).toBe("good");
  });
});
