import { PublicUploadParentInvalidation1746825230000 } from "../migrations/1746825230000-PublicUploadParentInvalidation";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DataSource, QueryRunner } from "typeorm";
import request from "supertest";
import appDataSource from "../data-source";
import { SharingModule } from "./sharing.module";
import { SharingService } from "./sharing.service";
import { PublicFolderService } from "./public-folder.service";
import { PublicUploadsService } from "./public-uploads.service";
import { UploadsService } from "../uploads/uploads.service";
import { FilesService } from "../files/files.service";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UploadRateLimitService } from "../uploads/upload-rate-limit";
import { applySecurityMiddleware } from "../common/security.config";

const url = process.env.HOMECLOUD_TEST_DATABASE_URL;
const pg = url ? describe : describe.skip;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Operation exceeded 5s")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

pg(
  "Public single-file uploads — migrated PostgreSQL, real HTTP/modules/storage",
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hc-public-upload-"));
    const schema = `public_upload_${randomUUID().replace(/-/g, "")}`;
    let db: DataSource, admin: DataSource, app: NestExpressApplication;
    let uploads: PublicUploadsService,
      core: UploadsService,
      folders: PublicFolderService,
      files: FilesService,
      shares: SharingService;
    const bytes = Buffer.from([0, 255, 128, 17, 42, 0]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const oldRoot = process.env.STORAGE_PATH;

    beforeAll(async () => {
      process.env.STORAGE_PATH = root;
      fs.mkdirSync(path.join(root, ".tmp"));
      admin = new DataSource({ type: "postgres", url });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      db = new DataSource({
        type: "postgres",
        url,
        schema,
        entities: appDataSource.options.entities,
        migrations: appDataSource.options.migrations,
        extra: {
          max: 8,
          connectionTimeoutMillis: 2000,
          options: `-c search_path=${schema} -c statement_timeout=4000 -c lock_timeout=3000`,
        },
      });
      await db.initialize();
      await db.runMigrations();
      const config = new ConfigService({
        STORAGE_PATH: root,
        JWT_SECRET: "public-upload-test-secret-32-characters",
        MAX_CHUNK_SIZE: 64,
        MAX_FILE_SIZE: 1024,
        MAX_TOTAL_SIZE: 4096,
        NODE_ENV: "test",
      });
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          TypeOrmModule.forRootAsync({
            useFactory: () => db.options,
            dataSourceFactory: async () => db,
          }),
          SharingModule,
        ],
      })
        .overrideProvider(ConfigService)
        .useValue(config)
        .compile();
      app = module.createNestApplication<NestExpressApplication>({
        bodyParser: false,
      });
      app.getHttpAdapter().getInstance().set("trust proxy", "loopback");
      uploads = app.get(PublicUploadsService);
      core = app.get(UploadsService);
      folders = app.get(PublicFolderService);
      files = app.get(FilesService);
      shares = app.get(SharingService);
      applySecurityMiddleware(app, config, {
        jwtService: app.get(JwtService),
        uploads: app.get(UploadRateLimitService),
        publicUploads: uploads,
      });
      app.useBodyParser("json");
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      app.setGlobalPrefix("api/v1");
      await app.init();
    }, 30000);
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      if (app) await app.close();
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
      fs.rmSync(root, { recursive: true, force: true });
      if (oldRoot === undefined) delete process.env.STORAGE_PATH;
      else process.env.STORAGE_PATH = oldRoot;
    });

    async function fixture(password?: string) {
      const user = await db
        .getRepository(UserEntity)
        .save({
          email: `${randomUUID()}@example.test`,
          password: "synthetic",
          storageQuota: 128,
          storageUsed: 0,
        });
      const mirror = await files.createFolder(user.id, "shared");
      const link = await shares.createShareLink(user.id, mirror.id, {
        allowUpload: true,
        password,
      });
      const { proof } = await folders.authorize(link.token, password);
      return { user, mirror, link, proof };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function start(
      f: Fixture,
      key = randomUUID(),
      input: Record<string, unknown> = {},
    ) {
      return uploads.create(f.link.token, f.proof, key, {
        parentId: f.mirror.folderId!,
        filename: "data.bin",
        totalSize: bytes.length,
        chunkSize: 2,
        expectedSha256: sha,
        ...input,
      } as any);
    }
    async function staged(f: Fixture, input: Record<string, unknown> = {}) {
      const session = await start(f, randomUUID(), input);
      for (const index of [2, 0, 1])
        await uploads.chunk(
          f.link.token,
          f.proof,
          session.uploadId,
          index,
          bytes.subarray(2 * index, 2 * index + 2),
        );
      return session;
    }
    async function used(f: Fixture) {
      return Number(
        (await db.getRepository(UserEntity).findOneByOrFail({ id: f.user.id }))
          .storageUsed,
      );
    }
    function http(f: Fixture, suffix = "") {
      return `/api/v1/sharing/public/${f.link.token}/uploads/session${suffix}`;
    }
    function pause(uploadId: string) {
      const entered = gate(),
        resume = gate();
      const target = path.join(root, ".tmp", uploadId);
      const internal = core as any,
        original = internal.syncDirectory.bind(core);
      let once = false;
      const spy = jest
        .spyOn(internal, "syncDirectory")
        .mockImplementation(async (...args: unknown[]) => {
          await original(...args);
          if (args[0] === target && !once) {
            once = true;
            entered.release();
            await resume.promise;
          }
        });
      return {
        entered: () => bounded(entered.promise),
        resume: resume.release,
        restore: () => spy.mockRestore(),
      };
    }

    it("keeps public targets immutable while migrated FK deletion invalidates orphan sessions", async () => {
      const f = await fixture(),
        session = await start(f);
      const migration = new PublicUploadParentInvalidation1746825230000();
      await db.transaction((manager) => migration.down(manager.queryRunner!));
      try {
        await expect(
          files.deleteFolderPermanently(f.user.id, f.mirror.folderId!),
        ).rejects.toThrow("immutable");
      } finally {
        await db.transaction((manager) => migration.up(manager.queryRunner!));
      }
      const outside = await files.createFolder(f.user.id, "outside");
      await expect(
        db.query(
          `UPDATE upload_sessions SET "parentId"=NULL WHERE "uploadId"=$1`,
          [session.uploadId],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        db.query(
          `UPDATE upload_sessions SET "parentId"=$2 WHERE "uploadId"=$1`,
          [session.uploadId, outside.folderId],
        ),
      ).rejects.toThrow("immutable");
      await files.deleteFolderPermanently(f.user.id, f.mirror.folderId!);
      const orphan = await db
        .getRepository(UploadSessionEntity)
        .findOneByOrFail({ uploadId: session.uploadId });
      expect(orphan).toMatchObject({
        origin: "public",
        parentId: null,
        shareLinkId: null,
        shareRootFolderId: null,
      });
      await expect(
        core.completeUpload(f.user.id, session.uploadId),
      ).rejects.toMatchObject({ status: 404 });
      await db
        .getRepository(UploadSessionEntity)
        .update(orphan.id, { expiresAt: new Date(0) });
      await core.cleanupExpiredSessions();
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        128,
      );
    });

    it("serves all public HTTP operations without a JWT, with bounded disk multipart and safe projections", async () => {
      const f = await fixture();
      const create = await request(app.getHttpServer())
        .post(http(f))
        .set("X-Forwarded-Proto", "https")
        .set("X-Share-Upload-Proof", f.proof)
        .set("Idempotency-Key", randomUUID())
        .send({
          parentId: f.mirror.folderId,
          filename: "data.bin",
          totalSize: 6,
          chunkSize: 2,
          expectedSha256: sha,
        })
        .expect(201);
      const session = create.body;
      for (const index of [0, 2, 1, 1])
        await request(app.getHttpServer())
          .post(http(f, `/${session.uploadId}/chunk`))
          .set("X-Forwarded-Proto", "https")
          .set("X-Share-Upload-Proof", f.proof)
          .field("chunkIndex", index)
          .attach("chunk", bytes.subarray(index * 2, index * 2 + 2), "chunk")
          .expect(200);
      const status = await request(app.getHttpServer())
        .get(http(f, `/${session.uploadId}`))
        .set("X-Forwarded-Proto", "https")
        .set("X-Share-Upload-Proof", f.proof)
        .expect(200);
      expect(status.body.chunks).toHaveLength(3);
      const complete = await request(app.getHttpServer())
        .post(http(f, `/${session.uploadId}/complete`))
        .set("X-Forwarded-Proto", "https")
        .set("X-Share-Upload-Proof", f.proof)
        .expect(200);
      expect(complete.body.checksum).toBe(sha);
      expect(complete.headers["cache-control"]).toBe("no-store");
      for (const body of [session, status.body, complete.body]) {
        const keys = JSON.stringify(body);
        expect(keys).not.toMatch(
          /tempPath|storagePath|workspaceId|userId|shareLinkId|relativeObjectKey/,
        );
      }
      const stored = await db
        .getRepository(FileEntity)
        .findOneByOrFail({ id: complete.body.id });
      expect(fs.readFileSync(stored.storagePath)).toEqual(bytes);
      const download = await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${f.link.token}/download`)
        .send({ fileId: stored.id })
        .buffer(true)
        .parse((response, done) => {
          const parts: Buffer[] = [];
          response.on("data", (chunk) => parts.push(Buffer.from(chunk)));
          response.on("end", () => done(null, Buffer.concat(parts)));
        })
        .expect(200);
      expect(createHash("sha256").update(download.body).digest("hex")).toBe(
        sha,
      );
      expect(await used(f)).toBe(6);
      expect(
        (await uploads.complete(f.link.token, f.proof, session.uploadId)).id,
      ).toBe(stored.id);
      const cancelled = await start(f);
      for (let i = 0; i < 2; i++)
        await request(app.getHttpServer())
          .delete(http(f, `/${cancelled.uploadId}`))
          .set("X-Forwarded-Proto", "https")
          .set("X-Share-Upload-Proof", f.proof)
          .expect(200);
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        122,
      );
      expect(
        fs.readdirSync(path.join(root, ".tmp", "multipart-ingress")),
      ).toHaveLength(0);
    }, 15000);

    it("requires HTTPS/proof before multipart, rejects client owner/storage fields and conceals internal errors", async () => {
      const f = await fixture(),
        session = await start(f);
      const before = fs.readdirSync(
        path.join(root, ".tmp", "multipart-ingress"),
      );
      await request(app.getHttpServer())
        .post(http(f, `/${session.uploadId}/chunk`))
        .set("X-Forwarded-Proto", "https")
        .attach("chunk", bytes, "bad")
        .expect(403);
      await request(app.getHttpServer())
        .post(http(f, `/${session.uploadId}/chunk`))
        .set("X-Share-Upload-Proof", f.proof)
        .attach("chunk", bytes, "bad")
        .expect(403);
      expect(
        fs.readdirSync(path.join(root, ".tmp", "multipart-ingress")),
      ).toEqual(before);
      await request(app.getHttpServer())
        .post(http(f))
        .set("X-Forwarded-Proto", "https")
        .set("X-Share-Upload-Proof", f.proof)
        .set("Idempotency-Key", randomUUID())
        .send({
          parentId: f.mirror.folderId,
          filename: "x",
          totalSize: 1,
          chunkSize: 1,
          userId: 99,
          workspaceId: "forged",
        })
        .expect(400);
      jest
        .spyOn(uploads, "status")
        .mockRejectedValue(new Error("/private/secret owner=1"));
      const failure = await request(app.getHttpServer())
        .get(http(f, `/${session.uploadId}`))
        .set("X-Forwarded-Proto", "https")
        .set("X-Share-Upload-Proof", f.proof)
        .expect(500);
      expect(JSON.stringify(failure.body)).not.toMatch(
        /private|secret|owner|stack|token/,
      );
    });

    it("keeps authenticated public chunks outside ordinary request budgets while retaining bounded upload admission", async () => {
      const f = await fixture();
      const content = Buffer.alloc(121, 42);
      const session = await start(f, randomUUID(), {
        totalSize: content.length,
        chunkSize: 1,
        expectedSha256: undefined,
      });
      const limits = app.get(UploadRateLimitService);
      let now = limits.now();
      jest.spyOn(limits, "now").mockImplementation(() => now);
      for (let index = 0; index < content.length; index++) {
        now += 100;
        await request(app.getHttpServer())
          .post(http(f, `/${session.uploadId}/chunk`))
          .set("X-Forwarded-Proto", "https")
          .set("X-Share-Upload-Proof", f.proof)
          .field("chunkIndex", index)
          .attach("chunk", content.subarray(index, index + 1), "chunk")
          .expect(200);
      }
      expect(
        (await uploads.status(f.link.token, f.proof, session.uploadId)).chunks,
      ).toHaveLength(121);
      expect(limits.counts().active).toBe(0);
      await uploads.abort(f.link.token, f.proof, session.uploadId);
    }, 15000);

    it("preserves public creation receipt and reservation when preparing the workspace fails, then repairs on retry", async () => {
      const f = await fixture(),
        key = randomUUID();
      const filesystem = (core as any).workspaceResolver.filesystem();
      const mkdir = jest
        .spyOn(filesystem, "mkdir")
        .mockImplementationOnce(() => {
          throw new Error("Injected workspace preparation failure");
        });
      await expect(start(f, key)).rejects.toMatchObject({ status: 400 });
      mkdir.mockRestore();
      const [pending] = await db
        .getRepository(UploadSessionEntity)
        .findBy({ userId: f.user.id });
      expect(pending).toBeDefined();
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        122,
      );
      expect((await start(f, key)).uploadId).toBe(pending.uploadId);
      await uploads.abort(f.link.token, f.proof, pending.uploadId);
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        128,
      );
    });

    it("serializes competing reservations against the same owner quota", async () => {
      const f = await fixture();
      await db.getRepository(UserEntity).update(f.user.id, { storageQuota: 6 });
      const results = await Promise.allSettled([start(f), start(f)]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        0,
      );
      const session = (
        results.find(
          (result) => result.status === "fulfilled",
        ) as PromiseFulfilledResult<any>
      ).value;
      await uploads.abort(f.link.token, f.proof, session.uploadId);
      expect((await core.getUploadLimits(f.user.id)).quotaRemainingBytes).toBe(
        6,
      );
    });

    it("follows the shared root identity but refuses a deleted ancestor above that root", async () => {
      const f = await fixture();
      const ancestor = await files.createFolder(f.user.id, "ancestor");
      await files.updateFolder(f.user.id, f.mirror.folderId!, {
        parentId: ancestor.folderId,
      });
      const session = await start(f);
      await files.removeFolder(f.user.id, ancestor.folderId!);
      await expect(
        uploads.status(f.link.token, f.proof, session.uploadId),
      ).rejects.toMatchObject({ status: 404 });
      await files.restoreFolder(f.user.id, ancestor.folderId!);
      await uploads.abort(f.link.token, f.proof, session.uploadId);
    });

    it("releases assembly admission when acquiring a database connection fails", async () => {
      const f = await fixture(),
        session = await staged(f);
      const createRunner = db.createQueryRunner.bind(db);
      const spy = jest
        .spyOn(db, "createQueryRunner")
        .mockImplementationOnce((mode) => {
          const runner = createRunner(mode);
          jest
            .spyOn(runner, "connect")
            .mockRejectedValueOnce(new Error("Injected connection failure"));
          return runner;
        });
      await expect(
        uploads.complete(f.link.token, f.proof, session.uploadId),
      ).rejects.toThrow("connection failure");
      spy.mockRestore();
      expect(
        (await uploads.complete(f.link.token, f.proof, session.uploadId))
          .checksum,
      ).toBe(sha);
    });

    it("bounds pending session metadata independently of byte quota", async () => {
      const f = await fixture();
      await db
        .getRepository(UserEntity)
        .update(f.user.id, { storageQuota: 1024 });
      const sessions = [];
      for (let i = 0; i < 128; i++)
        sessions.push(
          await start(f, randomUUID(), {
            totalSize: 1,
            chunkSize: 1,
            expectedSha256: undefined,
          }),
        );
      await expect(start(f)).rejects.toMatchObject({ status: 429 });
      await uploads.abort(f.link.token, f.proof, sessions[0].uploadId);
      await start(f);
    }, 15000);

    it("reclaims expired receipts in a bounded batch while preserving live replay", async () => {
      const f = await fixture(),
        liveKey = randomUUID(),
        expiredKey = randomUUID();
      const session = await start(f, liveKey);
      await db.query(
        `INSERT INTO public_share_operations
      ("shareLinkId","shareRootFolderId","userId",kind,"idempotencyKey","requestSha256","resultUploadSessionId","createdAt","expiresAt")
      SELECT "shareLinkId","shareRootFolderId","userId",kind,$2,"requestSha256","resultUploadSessionId",clock_timestamp()-interval '25 hours',clock_timestamp()-interval '1 hour'
      FROM public_share_operations WHERE "idempotencyKey"=$1`,
        [liveKey, expiredKey],
      );
      await expect(start(f, expiredKey)).rejects.toMatchObject({ status: 409 });
      await uploads.cleanupReceipts();
      expect(
        await db.query(
          `SELECT id FROM public_share_operations WHERE "idempotencyKey"=$1`,
          [expiredKey],
        ),
      ).toHaveLength(0);
      expect((await start(f, liveKey)).uploadId).toBe(session.uploadId);
    });

    it("supports parallel exact chunk retries and resume without double accounting", async () => {
      const f = await fixture(),
        session = await start(f);
      await Promise.all(
        [0, 0, 2].map((index) =>
          uploads.chunk(
            f.link.token,
            f.proof,
            session.uploadId,
            index,
            bytes.subarray(index * 2, index * 2 + 2),
          ),
        ),
      );
      expect(
        (await uploads.status(f.link.token, f.proof, session.uploadId)).chunks,
      ).toHaveLength(2);
      await expect(
        uploads.chunk(
          f.link.token,
          f.proof,
          session.uploadId,
          0,
          Buffer.from("xx"),
        ),
      ).rejects.toThrow();
      await uploads.chunk(
        f.link.token,
        f.proof,
        session.uploadId,
        1,
        bytes.subarray(2, 4),
      );
      expect(
        (await uploads.complete(f.link.token, f.proof, session.uploadId))
          .checksum,
      ).toBe(sha);
      expect(await used(f)).toBe(6);
    });

    it("atomically replays creation, rejects changed payload, and validates scope on replay", async () => {
      const f = await fixture(),
        key = randomUUID();
      const results = await Promise.all([start(f, key), start(f, key)]);
      expect(results[0].uploadId).toBe(results[1].uploadId);
      expect(
        await db
          .getRepository(UploadSessionEntity)
          .countBy({ userId: f.user.id }),
      ).toBe(1);
      await expect(start(f, key, { filename: "other" })).rejects.toMatchObject({
        status: 409,
      });
      const outside = await files.createFolder(f.user.id, "outside");
      const child = await files.createFolder(
        f.user.id,
        "child",
        f.mirror.folderId!,
      );
      const nestedKey = randomUUID();
      await start(f, nestedKey, { parentId: child.folderId });
      await files.updateFolder(f.user.id, child.folderId!, {
        parentId: outside.folderId,
      });
      await expect(
        start(f, nestedKey, { parentId: child.folderId }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it.each(["readonly", "revoked", "expired", "inactive"])(
      "refuses %s link on every operation",
      async (mode) => {
        const f = await fixture(),
          session = await staged(f);
        if (mode === "inactive")
          await db
            .getRepository(UserEntity)
            .update(f.user.id, { isActive: false });
        else
          await db
            .getRepository(ShareLinkEntity)
            .update(
              f.link.id,
              mode === "readonly"
                ? { allowUpload: false }
                : mode === "revoked"
                  ? { isActive: false }
                  : { expiresAt: new Date(0) },
            );
        for (const operation of [
          () => start(f),
          () =>
            uploads.chunk(
              f.link.token,
              f.proof,
              session.uploadId,
              0,
              bytes.subarray(0, 2),
            ),
          () => uploads.status(f.link.token, f.proof, session.uploadId),
          () => uploads.complete(f.link.token, f.proof, session.uploadId),
          () => uploads.abort(f.link.token, f.proof, session.uploadId),
        ])
          await expect(operation()).rejects.toThrow();
        expect(await used(f)).toBe(0);
        await db
          .getRepository(UploadSessionEntity)
          .update({ uploadId: session.uploadId }, { expiresAt: new Date(0) });
        await core.cleanupExpiredSessions();
        expect(
          await db
            .getRepository(UploadSessionEntity)
            .countBy({ uploadId: session.uploadId }),
        ).toBe(0);
      },
    );

    it.each(["revoke", "expiry", "move", "delete", "proof"])(
      "rechecks %s after assembly and refuses publication",
      async (mode) => {
        const f = await fixture(),
          child = await files.createFolder(
            f.user.id,
            "child",
            f.mirror.folderId!,
          );
        const session = await staged(f, { parentId: child.folderId });
        const barrier = pause(session.uploadId);
        const completion = uploads
          .complete(f.link.token, f.proof, session.uploadId)
          .catch((error) => error);
        try {
          await barrier.entered();
          if (mode === "revoke") await shares.revokeShare(f.user.id, f.link.id);
          if (mode === "expiry")
            await db
              .getRepository(ShareLinkEntity)
              .update(f.link.id, { expiresAt: new Date(0) });
          if (mode === "move")
            await files.updateFolder(f.user.id, child.folderId!, {
              parentId: null,
            });
          if (mode === "delete")
            await bounded(
              files.deleteFolderPermanently(f.user.id, f.mirror.folderId!),
            );
          if (mode === "proof")
            jest.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60_000);
          barrier.resume();
          expect(await bounded(completion)).toBeInstanceOf(Error);
          expect(
            await db
              .getRepository(FileEntity)
              .countBy({ uploadId: session.uploadId }),
          ).toBe(0);
          expect(await used(f)).toBe(0);
        } finally {
          barrier.resume();
          await completion;
          barrier.restore();
        }
      },
      10000,
    );

    it("rejects foreign/outside targets and both directions of session confusion, including owner HTTP API", async () => {
      const f = await fixture(),
        other = await fixture(),
        session = await staged(f);
      const sibling = await files.createFolder(f.user.id, "sibling");
      for (const parentId of [other.mirror.folderId, sibling.folderId, null, 0])
        await expect(start(f, randomUUID(), { parentId })).rejects.toThrow();
      const secondLink = await shares.createShareLink(f.user.id, f.mirror.id, {
        allowUpload: true,
      });
      const secondProof = (await folders.authorize(secondLink.token)).proof;
      await expect(
        uploads.complete(secondLink.token, secondProof, session.uploadId),
      ).rejects.toMatchObject({ status: 404 });
      const owned = await core.createUploadSession(
        f.user.id,
        "owned",
        6,
        2,
        f.mirror.folderId!,
      );
      await expect(
        uploads.abort(f.link.token, f.proof, owned.uploadId),
      ).rejects.toMatchObject({ status: 404 });
      for (const op of [
        () => core.getUploadSession(f.user.id, session.uploadId),
        () => core.reconcileUploadSession(f.user.id, session.uploadId),
        () => core.completeUpload(f.user.id, session.uploadId),
        () => core.abortUpload(f.user.id, session.uploadId),
      ])
        await expect(op()).rejects.toMatchObject({ status: 404 });
      expect(
        (await core.listUploadSessions(f.user.id)).some(
          (row) => row.uploadId === session.uploadId,
        ),
      ).toBe(false);
      const jwt = app.get(JwtService).sign({ sub: f.user.id });
      await request(app.getHttpServer())
        .get(`/api/v1/uploads/session/${session.uploadId}`)
        .set("Authorization", `Bearer ${jwt}`)
        .expect(404);
      const result = await uploads.complete(
        f.link.token,
        f.proof,
        session.uploadId,
      );
      await files.updateFile(f.user.id, result.id, {
        parentId: sibling.folderId,
      });
      await expect(
        uploads.complete(f.link.token, f.proof, session.uploadId),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("preserves owner/public collisions, quota reservations and cancellation", async () => {
      const f = await fixture();
      await db
        .getRepository(UserEntity)
        .update(f.user.id, { storageQuota: 12 });
      const publicSession = await staged(f);
      const owner = await core.createUploadSession(
        f.user.id,
        "data.bin",
        6,
        6,
        f.mirror.folderId!,
      );
      await core.uploadChunk(f.user.id, owner.uploadId, 0, bytes);
      await expect(start(f)).rejects.toThrow();
      const [a, b] = await Promise.all([
        uploads.complete(f.link.token, f.proof, publicSession.uploadId),
        core.completeUpload(f.user.id, owner.uploadId),
      ]);
      expect(new Set([a.name, b.name])).toEqual(
        new Set(["data.bin", "data (1).bin"]),
      );
      expect(await used(f)).toBe(12);
      expect(
        fs.readFileSync(
          (await db.getRepository(FileEntity).findOneByOrFail({ id: a.id }))
            .storagePath,
        ),
      ).toEqual(bytes);
      expect(fs.readFileSync(b.storagePath)).toEqual(bytes);
    });

    it("rejects empty files, size violations and SHA mismatch; computes checksum when optional expected hash is absent", async () => {
      const f = await fixture();
      for (const input of [
        { totalSize: 0 },
        { chunkSize: 65 },
        { totalSize: 1025 },
      ])
        await expect(start(f, randomUUID(), input)).rejects.toMatchObject({
          status: 400,
        });
      const broken = await staged(f, { expectedSha256: "a".repeat(64) });
      await expect(
        uploads.complete(f.link.token, f.proof, broken.uploadId),
      ).rejects.toMatchObject({ status: 400 });
      expect(await used(f)).toBe(0);
      await uploads.abort(f.link.token, f.proof, broken.uploadId);
      const optional = await staged(f, { expectedSha256: undefined });
      expect(
        (await uploads.complete(f.link.token, f.proof, optional.uploadId))
          .checksum,
      ).toBe(sha);
    });

    it("checks quota again at publication, keeps resumable chunks and releases reservation on abort", async () => {
      const f = await fixture(),
        session = await staged(f),
        barrier = pause(session.uploadId);
      const completion = uploads
        .complete(f.link.token, f.proof, session.uploadId)
        .catch((error) => error);
      try {
        await barrier.entered();
        await db
          .getRepository(UserEntity)
          .update(f.user.id, { storageQuota: 5 });
        barrier.resume();
        expect(await bounded(completion)).toMatchObject({ status: 403 });
        expect(
          (await uploads.status(f.link.token, f.proof, session.uploadId))
            .chunks,
        ).toHaveLength(3);
        await uploads.abort(f.link.token, f.proof, session.uploadId);
        expect(await used(f)).toBe(0);
        expect(
          (await core.getUploadLimits(f.user.id)).quotaRemainingBytes,
        ).toBe(5);
      } finally {
        barrier.resume();
        await completion;
        barrier.restore();
      }
    });

    it("uses a password proof without repeating password attempt accounting for chunks", async () => {
      const f = await fixture("correct");
      const attempts = (
        await db
          .getRepository(ShareLinkEntity)
          .findOneByOrFail({ id: f.link.id })
      ).failedAttempts;
      const password = jest.spyOn(shares, "verifySharePassword");
      const session = await staged(f);
      await uploads.complete(f.link.token, f.proof, session.uploadId);
      expect(password).not.toHaveBeenCalled();
      expect(
        (
          await db
            .getRepository(ShareLinkEntity)
            .findOneByOrFail({ id: f.link.id })
        ).failedAttempts,
      ).toBe(attempts);
      await db
        .getRepository(ShareLinkEntity)
        .update(f.link.id, { maxDownloads: 0, downloadCount: 0 });
      await start(f); // Download budget is independent from write permission.
    });

    it("bounds assembly connections, preserves pool capacity for revoke, and releases admission after failure", async () => {
      const f = await fixture(),
        sessions = [await staged(f), await staged(f), await staged(f)];
      const entered = [gate(), gate()],
        resume = gate();
      const internal = core as any,
        original = internal.syncDirectory.bind(core);
      const paused = new Set<number>();
      const spy = jest
        .spyOn(internal, "syncDirectory")
        .mockImplementation(async (...args: unknown[]) => {
          await original(...args);
          const index = sessions.findIndex(
            (session) => args[0] === path.join(root, ".tmp", session.uploadId),
          );
          if (index >= 0 && index < 2 && !paused.has(index)) {
            paused.add(index);
            entered[index].release();
            await resume.promise;
          }
        });
      const gates = entered.map((g) => ({
        entered: () => bounded(g.promise),
        resume: resume.release,
        restore: () => undefined,
      }));
      const active = sessions
        .slice(0, 2)
        .map((session) =>
          uploads
            .complete(f.link.token, f.proof, session.uploadId)
            .catch((error) => error),
        );
      try {
        await Promise.all(gates.map((g) => g.entered()));
        await expect(
          bounded(
            uploads.complete(f.link.token, f.proof, sessions[2].uploadId),
          ),
        ).rejects.toMatchObject({ status: 429 });
        await bounded(shares.revokeShare(f.user.id, f.link.id));
        gates.forEach((g) => g.resume());
        await Promise.all(active);
        await db
          .getRepository(ShareLinkEntity)
          .update(f.link.id, { isActive: true });
        expect(
          (
            await bounded(
              uploads.complete(f.link.token, f.proof, sessions[2].uploadId),
            )
          ).checksum,
        ).toBe(sha);
      } finally {
        gates.forEach((g) => g.resume());
        await Promise.all(active);
        gates.forEach((g) => g.restore());
        spy.mockRestore();
      }
    }, 12000);

    it("rejects too-small pools before acquiring a connection", async () => {
      const f = await fixture(),
        session = await staged(f);
      const options = db.options as any;
      const previous = options.extra.max;
      options.extra.max = 2;
      try {
        await expect(
          uploads.complete(f.link.token, f.proof, session.uploadId),
        ).rejects.toMatchObject({ status: 429 });
      } finally {
        options.extra.max = previous;
      }
      expect(
        (await uploads.complete(f.link.token, f.proof, session.uploadId))
          .checksum,
      ).toBe(sha);
    });

    it("does not fall back on EXDEV and preserves chunks for a safe same-FS retry", async () => {
      const f = await fixture(),
        session = await staged(f);
      const link = jest
        .spyOn(fs.promises, "link")
        .mockRejectedValueOnce(
          Object.assign(new Error("cross-device"), { code: "EXDEV" }),
        );
      await expect(
        uploads.complete(f.link.token, f.proof, session.uploadId),
      ).rejects.toMatchObject({ code: "EXDEV" });
      expect(await used(f)).toBe(0);
      expect(
        (await uploads.status(f.link.token, f.proof, session.uploadId)).chunks,
      ).toHaveLength(3);
      link.mockRestore();
      const result = await uploads.complete(
        f.link.token,
        f.proof,
        session.uploadId,
      );
      expect(result.checksum).toBe(sha);
    });

    it.each([false, true])(
      "recovers safely after COMMIT failure (commit applied: %s)",
      async (applied) => {
        const f = await fixture(),
          session = await staged(f);
        const createRunner = db.createQueryRunner.bind(db);
        const spy = jest
          .spyOn(db, "createQueryRunner")
          .mockImplementation((mode) => {
            const runner: QueryRunner = createRunner(mode),
              commit = runner.commitTransaction.bind(runner);
            jest
              .spyOn(runner, "commitTransaction")
              .mockImplementation(async () => {
                if (applied) await commit();
                throw new Error("Interrupted commit");
              });
            return runner;
          });
        await expect(
          uploads.complete(f.link.token, f.proof, session.uploadId),
        ).rejects.toThrow();
        spy.mockRestore();
        const result = await uploads.complete(
          f.link.token,
          f.proof,
          session.uploadId,
        );
        expect(result.checksum).toBe(sha);
        expect(await used(f)).toBe(6);
        expect(
          await db
            .getRepository(FileEntity)
            .countBy({ uploadId: session.uploadId }),
        ).toBe(1);
        expect(fs.existsSync(path.join(root, ".tmp", session.uploadId))).toBe(
          false,
        );
      },
    );
  },
);
