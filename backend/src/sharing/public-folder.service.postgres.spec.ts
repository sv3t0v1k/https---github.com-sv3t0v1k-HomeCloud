import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { PublicFolderService } from "./public-folder.service";
import { SharingService } from "./sharing.service";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("public folder creation — PostgreSQL", () => {
  let db: DataSource;
  let service: PublicFolderService;
  let share: any;
  const token = "stage2-public-folder-token";

  beforeAll(async () => {
    db = new DataSource({ type: "postgres", url });
    await db.initialize();
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
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
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
