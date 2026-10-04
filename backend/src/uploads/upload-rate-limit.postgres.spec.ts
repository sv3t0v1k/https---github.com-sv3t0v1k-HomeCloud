import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { MulterModule } from "@nestjs/platform-express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { applySecurityMiddleware } from "../common/security.config";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { UploadsController } from "./uploads.controller";
import { UploadsService } from "./uploads.service";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";
import { abortableDiskStorage } from "./abortable-disk-storage";
import {
  UploadRateLimitService,
  UploadRateLimitInterceptor,
  UPLOAD_RATE_POLICY,
} from "./upload-rate-limit";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const postgres = databaseUrl ? describe : describe.skip;

postgres(
  "upload throttling cancellation — isolated real PostgreSQL HTTP",
  () => {
    const schema = `uploads_rate_${randomUUID().replace(/-/g, "")}`;
    let root: string;
    let admin: DataSource;
    let database: DataSource;
    let app: INestApplication;
    let service: UploadsService;
    let storage: StorageService;
    let jwt: JwtService;

    beforeAll(async () => {
      root = fs.mkdtempSync(
        path.join(os.tmpdir(), "homecloud-upload-rate-postgres-"),
      );
      admin = new DataSource({ type: "postgres", url: databaseUrl });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      database = new DataSource({
        type: "postgres",
        url: databaseUrl,
        schema,
        synchronize: true,
        extra: { options: `-c search_path=${schema}` },
        entities: [
          UserEntity,
          FileEntity,
          FolderEntity,
          ShareLinkEntity,
          UploadSessionEntity,
          UploadChunkEntity,
          RefreshTokenEntity,
        ],
      });
      await database.initialize();
      const config = new ConfigService({
        NODE_ENV: "test",
        STORAGE_PATH: root,
        MAX_FILE_SIZE: 10,
        MAX_TOTAL_SIZE: 10,
        MAX_CHUNK_SIZE: 1,
        ALLOWED_UPLOAD_MIME_TYPES: "application/octet-stream,text/plain",
      });
      storage = new StorageService(config);
      service = new UploadsService(
        database.getRepository(UploadSessionEntity),
        database.getRepository(FileEntity),
        database.getRepository(FolderEntity),
        storage,
        new UsersService(database.getRepository(UserEntity)),
        config,
      );
      const ingress = path.join(storage.getTempPath(), "multipart-ingress");
      fs.mkdirSync(ingress, { recursive: true });
      const module = await Test.createTestingModule({
        imports: [
          JwtModule.register({
            secret: "upload-rate-postgres-test-no-production-credentials",
          }),
          MulterModule.register({
            storage: abortableDiskStorage(ingress),
            limits: {
              files: 1,
              fileSize: 2,
              fields: 1,
              parts: 3,
              fieldSize: 32,
              fieldNameSize: 64,
            },
          }),
        ],
        controllers: [UploadsController],
        providers: [
          JwtGuard,
          UploadRateLimitService,
          UploadRateLimitInterceptor,
          IngressFileCleanupInterceptor,
          { provide: UploadsService, useValue: service },
          { provide: StorageService, useValue: storage },
        ],
      }).compile();
      app = module.createNestApplication();
      jwt = module.get(JwtService);
      const limiter = module.get(UploadRateLimitService);
      jest.spyOn(limiter, "now").mockReturnValue(Date.now());
      applySecurityMiddleware(app, config, {
        jwtService: jwt,
        uploads: limiter,
      });
      app.setGlobalPrefix("api/v1");
      app.useGlobalPipes(
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
      );
      await app.init();
    }, 30000);

    afterAll(async () => {
      if (app) await app.close();
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
      if (root) fs.rmSync(root, { recursive: true, force: true });
      jest.restoreAllMocks();
    });

    it("abort survives exhausted transfer/global budgets, remains owned and authenticated, and releases quota and temporary files idempotently", async () => {
      const users = database.getRepository(UserEntity);
      const owner = await users.save({
        email: `${randomUUID()}@example.test`,
        name: "Owner",
        password: "unused-hash",
        storageQuota: 10,
        storageUsed: 0,
      });
      const other = await users.save({
        email: `${randomUUID()}@example.test`,
        name: "Other",
        password: "unused-hash",
        storageQuota: 10,
        storageUsed: 0,
      });
      const session = await service.createUploadSession(
        owner.id,
        "cancel.bin",
        10,
        1,
      );
      const auth = `Bearer ${jwt.sign({ sub: owner.id, email: owner.email })}`;
      const otherAuth = `Bearer ${jwt.sign({ sub: other.id, email: other.email })}`;
      const base = `/api/v1/uploads/session/${session.uploadId}`;
      const unpublished = storage.generateFinalPath(
        owner.id,
        session.uploadId,
        session.filename,
      );
      fs.writeFileSync(unpublished, "unfinished assembly");
      expect(
        (await service.getUploadLimits(owner.id)).quotaRemainingBytes,
      ).toBe(0);

      for (let index = 0; index < UPLOAD_RATE_POLICY.chunk.burst; index++) {
        await request(app.getHttpServer())
          .post(`${base}/chunk`)
          .set("Authorization", auth)
          .field("chunkIndex", "0")
          .attach("chunk", Buffer.from("x"), "tiny.bin")
          .expect(200);
      }
      await request(app.getHttpServer())
        .post(`${base}/chunk`)
        .set("Authorization", auth)
        .field("chunkIndex", "1")
        .attach("chunk", Buffer.from("x"), "tiny.bin")
        .expect("Retry-After", /^\d+$/)
        .expect(429);
      expect(
        await database
          .getRepository(UploadChunkEntity)
          .countBy({ sessionId: session.id }),
      ).toBe(1);

      await request(app.getHttpServer()).delete(base).expect(401);
      await request(app.getHttpServer())
        .delete(base)
        .set("Authorization", otherAuth)
        .expect(404);
      expect(fs.existsSync(session.tempPath)).toBe(true);
      expect(fs.existsSync(unpublished)).toBe(true);
      expect(
        (await service.getUploadLimits(owner.id)).quotaRemainingBytes,
      ).toBe(0);

      // The unauthenticated DELETE above consumed one ordinary global request.
      for (let index = 0; index < 99; index++)
        await request(app.getHttpServer()).get("/api/v1/files").expect(404);
      await request(app.getHttpServer()).get("/api/v1/files").expect(429);
      await request(app.getHttpServer())
        .delete(base)
        .set("Authorization", auth)
        .expect(200);
      expect(fs.existsSync(session.tempPath)).toBe(false);
      expect(fs.existsSync(unpublished)).toBe(false);
      // A repeated owned abort repairs leftovers from an earlier interrupted cleanup.
      fs.mkdirSync(session.tempPath, { recursive: true });
      fs.writeFileSync(path.join(session.tempPath, "0"), "leftover");
      fs.writeFileSync(unpublished, "leftover unpublished assembly");
      await request(app.getHttpServer())
        .delete(base)
        .set("Authorization", auth)
        .expect(200);
      expect(fs.existsSync(session.tempPath)).toBe(false);
      expect(fs.existsSync(unpublished)).toBe(false);
      expect(
        fs.readdirSync(path.join(storage.getTempPath(), "multipart-ingress")),
      ).toEqual([]);
      expect(
        await database
          .getRepository(UploadChunkEntity)
          .countBy({ sessionId: session.id }),
      ).toBe(0);
      expect(
        (
          await database
            .getRepository(UploadSessionEntity)
            .findOneByOrFail({ id: session.id })
        ).status,
      ).toBe("aborted");
      expect(
        Number((await users.findOneByOrFail({ id: owner.id })).storageUsed),
      ).toBe(0);
      expect(
        (await service.getUploadLimits(owner.id)).quotaRemainingBytes,
      ).toBe(10);
      expect(
        await database.getRepository(FileEntity).countBy({ userId: owner.id }),
      ).toBe(0);
      const replacement = await service.createUploadSession(
        owner.id,
        "replacement.bin",
        10,
        1,
      );
      await service.abortUpload(owner.id, replacement.uploadId);
    }, 30000);
  },
);
