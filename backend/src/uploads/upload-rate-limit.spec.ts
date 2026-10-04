import {
  INestApplication,
  BadRequestException,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { MulterModule } from "@nestjs/platform-express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { JwtGuard } from "../auth/guards/jwt.guard";
import {
  applySecurityMiddleware,
  getGlobalRateLimitOptions,
} from "../common/security.config";
import { StorageService } from "../storage/storage.service";
import { UploadsController } from "./uploads.controller";
import { UploadsService } from "./uploads.service";
import { IngressFileCleanupInterceptor } from "./ingress-file-cleanup.interceptor";
import { abortableDiskStorage } from "./abortable-disk-storage";
import {
  UploadRateLimitService,
  UploadRateLimitInterceptor,
  UPLOAD_RATE_POLICY,
} from "./upload-rate-limit";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

describe("authenticated upload rate policy (HTTP)", () => {
  let app: INestApplication;
  let limiter: UploadRateLimitService;
  let jwt: JwtService;
  let root: string;
  let ingress: string;
  let clock: number;
  let ingressWrites: jest.SpyInstance;
  let service: {
    uploadChunk: jest.Mock;
    abortUpload: jest.Mock;
    getUploadLimits: jest.Mock;
    createUploadSession: jest.Mock;
    completeUpload: jest.Mock;
    listUploadSessions: jest.Mock;
    toSessionMetadata: jest.Mock;
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-upload-rate-"));
    ingress = path.join(root, ".tmp", "multipart-ingress");
    fs.mkdirSync(ingress, { recursive: true });
    service = {
      uploadChunk: jest.fn(
        async (_userId: number, uploadId: string, chunkIndex: number) => ({
          uploadId,
          chunkIndex,
        }),
      ),
      abortUpload: jest.fn(async () => undefined),
      getUploadLimits: jest.fn(async () => ({
        maxChunkBytes: 10 * 1024 * 1024,
      })),
      createUploadSession: jest.fn(async () => ({ uploadId: FIRST })),
      completeUpload: jest.fn(async () => ({ id: 1 })),
      listUploadSessions: jest.fn(async () => []),
      toSessionMetadata: jest.fn((session) => session),
    };
    const disk = abortableDiskStorage(ingress);
    ingressWrites = jest.spyOn(disk, "_handleFile");
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: "upload-rate-test-secret-with-no-production-credentials",
        }),
        MulterModule.register({
          storage: disk,
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
        {
          provide: StorageService,
          useValue: { getTempPath: () => path.join(root, ".tmp") },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    limiter = module.get(UploadRateLimitService);
    jwt = module.get(JwtService);
    clock = Date.now();
    jest.spyOn(limiter, "now").mockImplementation(() => clock);
    applySecurityMiddleware(app, new ConfigService({ NODE_ENV: "test" }), {
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
    app.useLogger(false);
    await app.init();
    await app.listen(0, "127.0.0.1");
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const token = (userId = 1, extra: Record<string, unknown> = {}) =>
    jwt.sign({ sub: userId, email: `${userId}@example.test`, ...extra });
  const chunk = (uploadId = FIRST, userId = 1, chunkIndex = 0) =>
    request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${uploadId}/chunk`)
      .set("Authorization", `Bearer ${token(userId)}`)
      .field("chunkIndex", String(chunkIndex))
      .attach("chunk", Buffer.from("x"), "tiny.bin");

  function expectRetryAfter(response: request.Response) {
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toMatch(/^\d+$/);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }

  it("accepts 5120 synthetic chunks at 20 requests/s across concurrent uploads without the ordinary IP cap", async () => {
    for (let index = 0; index < 5120; index += 2) {
      clock += 100;
      const results = await Promise.all([
        chunk(FIRST, 1, index / 2),
        chunk(SECOND, 1, index / 2),
      ]);
      for (const result of results)
        expect({
          index,
          status: result.status,
          body: result.body,
        }).toMatchObject({ status: 200 });
    }
    expect(service.uploadChunk).toHaveBeenCalledTimes(5120);
    expect(fs.readdirSync(ingress)).toEqual([]);
    await request(app.getHttpServer())
      .get("/api/v1/uploads/limits")
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${FIRST}/complete`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
  }, 60000);

  it("keeps the ordinary global policy at 100 requests per 60 seconds while uploads have a separate budget", async () => {
    expect(getGlobalRateLimitOptions()).toMatchObject({
      max: 100,
      windowMs: 60000,
    });
    for (let index = 0; index < 100; index++)
      await request(app.getHttpServer()).get("/api/v1/files").expect(404);
    expectRetryAfter(await request(app.getHttpServer()).get("/api/v1/files"));
    await chunk().expect(200);
    await request(app.getHttpServer())
      .delete(`/api/v1/uploads/session/${FIRST}`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
  });

  it("bounds one user's burst across session IDs and refreshed JWTs and allows a different user", async () => {
    for (let index = 0; index < UPLOAD_RATE_POLICY.chunk.burst; index++)
      await chunk(index % 2 ? SECOND : FIRST).expect(200);
    const rotated = token(1, { nonce: "refreshed-token" });
    const blocked = await request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${SECOND}/chunk/?retry=1`)
      .set("Authorization", `Bearer ${rotated}`)
      .field("chunkIndex", "0")
      .attach("chunk", Buffer.from("x"), "tiny.bin");
    expectRetryAfter(blocked);
    expect(service.uploadChunk).toHaveBeenCalledTimes(
      UPLOAD_RATE_POLICY.chunk.burst,
    );
    expect(fs.readdirSync(ingress)).toEqual([]);
    await chunk(FIRST, 2).expect(200);
    clock += 1000;
    await chunk().expect(200);
  });

  it.each([
    ["missing", () => undefined],
    ["invalid", () => "not-a-jwt"],
    ["expired", () => jwt.sign({ sub: 1, exp: 1 })],
    ["string subject", () => jwt.sign({ sub: "1" })],
    ["missing subject", () => jwt.sign({ email: "missing@example.test" })],
    ["unsafe subject", () => jwt.sign({ sub: Number.MAX_SAFE_INTEGER + 1 })],
  ])(
    "does not exempt %s authentication from the ordinary IP cap",
    async (_name, makeToken) => {
      for (let index = 0; index < 50; index++) {
        const probe = request(app.getHttpServer()).post(
          `/api/v1/uploads/session/${FIRST}/chunk`,
        );
        const auth = makeToken();
        if (auth) probe.set("Authorization", `Bearer ${auth}`);
        const result = await probe;
        expect([400, 401]).toContain(result.status);
      }
      for (let index = 0; index < 50; index++)
        await request(app.getHttpServer()).get("/api/v1/files").expect(404);
      expectRetryAfter(await request(app.getHttpServer()).get("/api/v1/files"));
      expect(service.uploadChunk).not.toHaveBeenCalled();
      expect(fs.readdirSync(ingress)).toEqual([]);
    },
  );

  it("keeps upload control routes, unknown suffixes and unsupported methods in the ordinary global budget", async () => {
    const auth = `Bearer ${token()}`;
    const controls = [
      () =>
        request(app.getHttpServer())
          .get("/api/v1/uploads/limits")
          .set("Authorization", auth),
      () =>
        request(app.getHttpServer())
          .get("/api/v1/uploads/sessions")
          .set("Authorization", auth),
      () =>
        request(app.getHttpServer())
          .post("/api/v1/uploads/session")
          .set("Authorization", auth)
          .send({ filename: "tiny.bin", totalSize: 1, chunkSize: 1 }),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/uploads/session/${FIRST}/complete`)
          .set("Authorization", auth),
      () =>
        request(app.getHttpServer())
          .get(`/api/v1/uploads/session/${FIRST}/chunk`)
          .set("Authorization", auth),
      () =>
        request(app.getHttpServer())
          .post(`/api/v1/uploads/session/${FIRST}/chunk/unknown`)
          .set("Authorization", auth),
      () =>
        request(app.getHttpServer())
          .post("/api/v1/uploads/session/not-a-uuid/chunk")
          .set("Authorization", auth),
    ];
    for (let index = 0; index < 100; index++) {
      const response = await controls[index % controls.length]();
      expect(response.status).not.toBe(429);
    }
    expectRetryAfter(await controls[0]());
    await chunk().expect(200);
  });

  it("holds a shared per-user concurrency cap across sessions and releases it on service settlement", async () => {
    const pending: Array<() => void> = [];
    service.uploadChunk.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const running = Array.from(
      { length: UPLOAD_RATE_POLICY.maxPerUserConcurrent },
      (_, index) =>
        chunk(index % 2 ? FIRST : SECOND).then((response) => response),
    );
    await waitUntil(
      () => pending.length === UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    );
    expectRetryAfter(await chunk().then((response) => response));
    expect(service.uploadChunk).toHaveBeenCalledTimes(
      UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    );
    expect(ingressWrites).toHaveBeenCalledTimes(
      UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    );
    for (const finish of pending) finish();
    for (const response of await Promise.all(running))
      expect(response.status).toBe(200);
    service.uploadChunk.mockResolvedValue({ uploadId: FIRST });
    await chunk().expect(200);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });

  it("releases concurrency and disk ingress after malformed multipart and service errors", async () => {
    for (
      let index = 0;
      index < UPLOAD_RATE_POLICY.maxPerUserConcurrent + 1;
      index++
    ) {
      await request(app.getHttpServer())
        .post(`/api/v1/uploads/session/${FIRST}/chunk`)
        .set("Authorization", `Bearer ${token()}`)
        .field("chunkIndex", "not-an-integer")
        .attach("chunk", Buffer.from("x"), "tiny.bin")
        .expect(400);
    }
    service.uploadChunk.mockRejectedValueOnce(
      new BadRequestException("synthetic service failure"),
    );
    await chunk().expect(400);
    await chunk().expect(200);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });

  it("rejects excessive text fields, oversized chunkIndex and truncated multipart while releasing ingress and leases", async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${FIRST}/chunk`)
      .set("Authorization", `Bearer ${token()}`)
      .field("chunkIndex", "0")
      .field("extra", "x")
      .attach("chunk", Buffer.from("x"), "tiny.bin")
      .expect(400);
    expect(limiter.counts().active).toBe(0);
    await waitUntil(
      () =>
        fs.readdirSync(ingress).length === 0 && limiter.counts().active === 0,
    );
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${FIRST}/chunk`)
      .set("Authorization", `Bearer ${token()}`)
      .field("chunkIndex", "0".repeat(33))
      .attach("chunk", Buffer.from("x"), "tiny.bin")
      .expect(400);
    expect(limiter.counts().active).toBe(0);
    await waitUntil(() => fs.readdirSync(ingress).length === 0);
    const boundary = "homecloud-truncated-multipart";
    const partial = `--${boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="tiny.bin"\r\n\r\nx`;
    await request(app.getHttpServer())
      .post(`/api/v1/uploads/session/${FIRST}/chunk`)
      .set("Authorization", `Bearer ${token()}`)
      .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
      .send(partial)
      .expect(400);
    await waitUntil(
      () =>
        fs.readdirSync(ingress).length === 0 && limiter.counts().active === 0,
    );
    expect(service.uploadChunk).not.toHaveBeenCalled();
    await chunk().expect(200);
  });

  it("still applies the shared post-JWT upload budget to malformed session IDs before parsing files", async () => {
    for (let index = 0; index < UPLOAD_RATE_POLICY.chunk.burst; index++)
      await chunk().expect(200);
    const before = ingressWrites.mock.calls.length;
    expectRetryAfter(await chunk("not-a-uuid"));
    expect(ingressWrites).toHaveBeenCalledTimes(before);
    expect(service.uploadChunk).toHaveBeenCalledTimes(
      UPLOAD_RATE_POLICY.chunk.burst,
    );
    expect(limiter.counts().active).toBe(0);
  });

  it("rejects an IP admission burst before another JWT verification", async () => {
    const verify = jest.spyOn(jwt, "verify");
    for (let index = 0; index < UPLOAD_RATE_POLICY.admission.burst; index++) {
      const result = await request(app.getHttpServer())
        .post(`/api/v1/uploads/session/${FIRST}/chunk`)
        .set("Authorization", `Bearer ${token()}`);
      expect([400, 429]).toContain(result.status);
    }
    const before = verify.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    expectRetryAfter(await chunk());
    expect(verify).toHaveBeenCalledTimes(before);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });

  it("bounds fresh state at 10000 users and expires inactive entries without resetting active users", () => {
    const active = Array.from(
      { length: UPLOAD_RATE_POLICY.maxPerUserConcurrent },
      () => limiter.enter(1, "chunk"),
    );
    for (let userId = 2; userId <= UPLOAD_RATE_POLICY.maxKeys; userId++)
      limiter.enter(userId, "chunk")();
    expect(limiter.counts()).toMatchObject({
      chunkKeys: UPLOAD_RATE_POLICY.maxKeys,
      active: UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    });
    expect(() =>
      limiter.enter(UPLOAD_RATE_POLICY.maxKeys + 1, "chunk"),
    ).toThrow();
    expect(limiter.counts().chunkKeys).toBe(UPLOAD_RATE_POLICY.maxKeys);
    clock += UPLOAD_RATE_POLICY.idleMs + 1;
    const release = limiter.enter(UPLOAD_RATE_POLICY.maxKeys + 1, "chunk");
    expect(limiter.counts()).toMatchObject({
      chunkKeys: 2,
      active: UPLOAD_RATE_POLICY.maxPerUserConcurrent + 1,
    });
    expect(() => limiter.enter(1, "chunk")).toThrow();
    release();
    active.forEach((finish) => finish());
    expect(limiter.counts().active).toBe(0);
    clock += UPLOAD_RATE_POLICY.idleMs + 1;
    limiter.enter(1, "chunk")();
    expect(limiter.counts()).toMatchObject({ chunkKeys: 1, active: 0 });
  });

  it("caps all users' processing together and recovers capacity after settlement", async () => {
    const pending: Array<() => void> = [];
    service.uploadChunk.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const running = Array.from(
      { length: UPLOAD_RATE_POLICY.maxConcurrent },
      (_, index) =>
        chunk(
          index % 2 ? FIRST : SECOND,
          Math.floor(index / UPLOAD_RATE_POLICY.maxPerUserConcurrent) + 1,
        ).then((response) => response),
    );
    await waitUntil(() => pending.length === UPLOAD_RATE_POLICY.maxConcurrent);
    expect(limiter.counts().active).toBe(UPLOAD_RATE_POLICY.maxConcurrent);
    expectRetryAfter(await chunk(FIRST, 100).then((response) => response));
    expect(pending).toHaveLength(UPLOAD_RATE_POLICY.maxConcurrent);
    pending.forEach((finish) => finish());
    for (const response of await Promise.all(running))
      expect(response.status).toBe(200);
    expect(limiter.counts().active).toBe(0);
    service.uploadChunk.mockResolvedValue({ uploadId: FIRST });
    await chunk(FIRST, 100).expect(200);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });

  it("keeps a disconnected processing handler's slot until its service promise settles", async () => {
    const pending: Array<() => void> = [];
    service.uploadChunk.mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    const boundary = "homecloud-held-processing";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="tiny.bin"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n--${boundary}--\r\n`;
    const client = http.request({
      hostname: "127.0.0.1",
      port: (app.getHttpServer().address() as AddressInfo).port,
      method: "POST",
      path: `/api/v1/uploads/session/${FIRST}/chunk`,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
      },
    });
    client.on("error", () => undefined);
    client.end(body);
    await waitUntil(() => pending.length === 1);
    const running = Array.from(
      { length: UPLOAD_RATE_POLICY.maxPerUserConcurrent - 1 },
      () => chunk(SECOND).then((response) => response),
    );
    await waitUntil(
      () => pending.length === UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    );
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.counts().active).toBe(
      UPLOAD_RATE_POLICY.maxPerUserConcurrent,
    );
    expectRetryAfter(await chunk().then((response) => response));
    expect(pending).toHaveLength(UPLOAD_RATE_POLICY.maxPerUserConcurrent);
    pending.forEach((finish) => finish());
    for (const response of await Promise.all(running))
      expect(response.status).toBe(200);
    await waitUntil(() => limiter.counts().active === 0);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });

  it("protects abort against abuse using its own finite budget", async () => {
    for (let index = 0; index < UPLOAD_RATE_POLICY.abort.burst; index++)
      await request(app.getHttpServer())
        .delete(`/api/v1/uploads/session/${FIRST}`)
        .set("Authorization", `Bearer ${token()}`)
        .expect(200);
    expectRetryAfter(
      await request(app.getHttpServer())
        .delete(`/api/v1/uploads/session/${SECOND}`)
        .set("Authorization", `Bearer ${token()}`),
    );
    await chunk().expect(200);
    clock += 2000;
    await request(app.getHttpServer())
      .delete(`/api/v1/uploads/session/${FIRST}`)
      .set("Authorization", `Bearer ${token()}`)
      .expect(200);
    expect(limiter.counts().abortKeys).toBe(1);
  });

  it("releases the ingress lease and partial disk file when a slow multipart client disconnects", async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const boundary = "homecloud-slow-multipart";
    const client = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: `/api/v1/uploads/session/${FIRST}/chunk`,
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    });
    client.on("error", () => undefined);
    client.write(
      `--${boundary}\r\nContent-Disposition: form-data; name="chunkIndex"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="partial.bin"\r\nContent-Type: application/octet-stream\r\n\r\nx`,
    );
    await waitUntil(() => fs.readdirSync(ingress).length === 1);
    client.destroy();
    await waitUntil(() => fs.readdirSync(ingress).length === 0);
    expect(service.uploadChunk).not.toHaveBeenCalled();
    expect(limiter.counts().active).toBe(0);
    await chunk().expect(200);
    expect(fs.readdirSync(ingress)).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for upload lifecycle state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
