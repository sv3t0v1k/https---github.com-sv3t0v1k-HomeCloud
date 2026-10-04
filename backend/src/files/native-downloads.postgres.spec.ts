import { randomUUID, createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import request from "supertest";
import { DownloadCapabilityService } from "./download-capability.service";
import { NativeDownloadsController } from "./native-downloads.controller";
import { FilesService } from "./files.service";
import { StorageService } from "../storage/storage.service";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { CreateDownloadCapabilities1746825140000 } from "../migrations/1746825140000-CreateDownloadCapabilities";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
describeDatabase(
  "Native download capability: real PostgreSQL and HTTP streaming",
  () => {
    const schema = `download_${randomUUID().replace(/-/g, "")}`;
    let admin: DataSource;
    let db: DataSource;
    let app: INestApplication;
    let service: DownloadCapabilityService;
    let root: string;
    let fixture: string;
    const config = new ConfigService({ NODE_ENV: "test" });
    beforeAll(async () => {
      admin = new DataSource({ type: "postgres", url: databaseUrl });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      db = new DataSource({
        type: "postgres",
        url: databaseUrl,
        extra: { options: `-c search_path=${schema}` },
      });
      await db.initialize();
      await db.query(
        `CREATE TABLE users (id INTEGER PRIMARY KEY, "isActive" BOOLEAN NOT NULL)`,
      );
      await db.query(
        `CREATE TABLE files (id INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "isDeleted" BOOLEAN NOT NULL, "isFolder" BOOLEAN NOT NULL)`,
      );
      const runner = db.createQueryRunner();
      await new CreateDownloadCapabilities1746825140000().up(runner);
      await runner.release();
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "hc-native-pg-")),
      );
      fixture = path.join(root, "fixture.bin");
      fs.writeFileSync(fixture, "native-stream-proof");
      service = new DownloadCapabilityService(db);
      const module = await Test.createTestingModule({
        controllers: [NativeDownloadsController],
        providers: [
          { provide: ConfigService, useValue: config },
          { provide: DownloadCapabilityService, useValue: service },
          {
            provide: StorageService,
            useValue: {
              ensureWithinStorageRoot: (value: string) => {
                const resolved = path.resolve(value);
                if (!resolved.startsWith(root + path.sep))
                  throw new Error("Outside storage");
                return resolved;
              },
            },
          },
          {
            provide: FilesService,
            useValue: {
              findOne: async (userId: number, id: number) => {
                const [row] = await db.query(
                  `SELECT * FROM files WHERE id = $1 AND "userId" = $2`,
                  [id, userId],
                );
                if (!row) throw new NotFoundException("File not found");
                return {
                  ...row,
                  name: 'proof\r\n".bin',
                  storagePath: fixture,
                  size: fs.statSync(fixture).size,
                  mimeType: "application/octet-stream",
                };
              },
            },
          },
        ],
      })
        .overrideGuard(JwtGuard)
        .useValue({
          canActivate: (context: ExecutionContext) => {
            const req = context.switchToHttp().getRequest();
            if (req.headers.authorization !== "Bearer owner")
              throw new UnauthorizedException();
            req.user = { userId: 1 };
            return true;
          },
        })
        .compile();
      app = module.createNestApplication();
      app.setGlobalPrefix("api/v1");
      await app.init();
    }, 30000);
    afterAll(async () => {
      await app?.close();
      if (root) fs.rmSync(root, { recursive: true, force: true });
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
    });
    beforeEach(async () => {
      await db.query(`TRUNCATE download_capabilities, files, users CASCADE`);
      await db.query(`INSERT INTO users VALUES (1, TRUE), (2, TRUE)`);
      await db.query(
        `INSERT INTO files VALUES (7, 1, FALSE, FALSE), (8, 2, FALSE, FALSE)`,
      );
    });
    const prepare = async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/native-downloads/7/prepare")
        .set("Authorization", "Bearer owner")
        .expect(200);
      const cookie = String(res.headers["set-cookie"][0]).split(";")[0];
      expect(res.headers["set-cookie"][0]).toContain("HttpOnly");
      expect(res.headers["set-cookie"][0]).toContain("SameSite=Strict");
      expect(res.headers["set-cookie"][0]).toContain(
        "Path=/api/v1/native-downloads/7",
      );
      expect(res.body).toEqual({
        downloadPath: "/native-downloads/7",
        expiresInSeconds: 120,
      });
      expect(JSON.stringify(res.body)).not.toContain(cookie.split("=")[1]);
      return cookie;
    };
    it("requires issuance authorization and denies another owner's resource", async () => {
      const unauthenticated = await request(app.getHttpServer())
        .post("/api/v1/native-downloads/7/prepare")
        .expect(401);
      expect(unauthenticated.body.statusCode).toBe(401);
      await request(app.getHttpServer())
        .post("/api/v1/native-downloads/8/prepare")
        .set("Authorization", "Bearer owner")
        .expect(404);
    });
    it("sets secure production host-only cookies and rejects missing/forged HTTP cookies", async () => {
      config.set("NODE_ENV", "production");
      try {
        const res = await request(app.getHttpServer())
          .post("/api/v1/native-downloads/7/prepare")
          .set("Authorization", "Bearer owner")
          .expect(200);
        const cookie = String(res.headers["set-cookie"][0]);
        expect(cookie).toContain("Secure");
        expect(cookie).not.toContain("Domain=");
      } finally {
        config.set("NODE_ENV", "test");
      }
      await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .expect(404);
      await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", "hc_native_download=forged")
        .expect(404);
    });
    it("denies transferred/folder resources and never issues for a deleted file", async () => {
      const token = await service.issue(1, 7);
      await db.query(`UPDATE files SET "userId" = 2 WHERE id = 7`);
      await expect(service.authorize(token, 7, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db.query(
        `UPDATE files SET "userId" = 1, "isFolder" = TRUE WHERE id = 7`,
      );
      await expect(service.authorize(token, 7, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db.query(
        `UPDATE files SET "isFolder" = FALSE, "isDeleted" = TRUE WHERE id = 7`,
      );
      await request(app.getHttpServer())
        .post("/api/v1/native-downloads/7/prepare")
        .set("Authorization", "Bearer owner")
        .expect(404);
    });
    it("consumes a valid ticket even for an unsatisfiable Range", async () => {
      const cookie = await prepare();
      const deniedRange = await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .set("Range", "bytes=999-")
        .expect(416);
      expect(deniedRange.headers["content-range"]).toBe(`bytes */${Buffer.byteLength("native-stream-proof")}`);
      await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .expect(404);
    });
    it("streams native GET, permits HEAD first, consumes exactly once", async () => {
      const cookie = await prepare();
      await request(app.getHttpServer())
        .head("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .expect(200);
      const res = await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .buffer(true)
        .expect(200);
      expect(res.body).toEqual(Buffer.from("native-stream-proof"));
      expect(res.headers["content-length"]).toBe("19");
      expect(res.headers["cache-control"]).toBe("no-store");
      await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .expect(404);
      expect(await db.query(`SELECT * FROM download_capabilities`)).toEqual([]);
    });
    it("supports first-GET Range and requires a fresh ticket for resume", async () => {
      const cookie = await prepare();
      const res = await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .set("Range", "bytes=7-12")
        .buffer(true)
        .expect(206);
      expect(res.body).toEqual(Buffer.from("stream"));
      expect(res.headers["content-range"]).toBe("bytes 7-12/19");
      await request(app.getHttpServer())
        .get("/api/v1/native-downloads/7")
        .set("Cookie", cookie)
        .set("Range", "bytes=13-")
        .expect(404);
    });
    it("rejects forged, cross-resource, expired, deleted and inactive grants", async () => {
      const token = await service.issue(1, 7);
      await expect(
        service.authorize("0".repeat(64), 7, true),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.authorize(token, 8, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db.query(`UPDATE files SET "isDeleted" = TRUE WHERE id = 7`);
      await expect(service.authorize(token, 7, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db.query(`UPDATE files SET "isDeleted" = FALSE WHERE id = 7`);
      await db.query(`UPDATE users SET "isActive" = FALSE WHERE id = 1`);
      await expect(service.authorize(token, 7, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db.query(`UPDATE users SET "isActive" = TRUE WHERE id = 1`);
      await db.query(
        `UPDATE download_capabilities SET "expiresAt" = NOW() - INTERVAL '1 second'`,
      );
      await expect(service.authorize(token, 7, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
    it("admits exactly one concurrent replay and stores only the hash", async () => {
      const token = await service.issue(1, 7);
      const [stored] = await db.query(`SELECT * FROM download_capabilities`);
      expect(stored.tokenHash).toBe(
        createHash("sha256").update(token).digest("hex"),
      );
      expect(JSON.stringify(stored)).not.toContain(token);
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => service.authorize(token, 7, true)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
    it("bounds pending issuance, invalidates replaced grants and prunes expired rows", async () => {
      const old = await service.issue(1, 7);
      const fresh = await service.issue(1, 7);
      await expect(service.authorize(old, 7, false)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await service.authorize(fresh, 7, false)).toBe(1);
      for (let id = 20; id < 27; id++) {
        await db.query(`INSERT INTO files VALUES ($1, 1, FALSE, FALSE)`, [id]);
        await service.issue(1, id);
      }
      await db.query(`INSERT INTO files VALUES (30, 1, FALSE, FALSE)`);
      await expect(service.issue(1, 30)).rejects.toMatchObject({ status: 429 });
      await db.query(
        `UPDATE download_capabilities SET "expiresAt" = NOW() - INTERVAL '1 second'`,
      );
      await service.issue(1, 30);
      expect(
        (await db.query(`SELECT * FROM download_capabilities`)).length,
      ).toBe(1);
    });
  },
);
