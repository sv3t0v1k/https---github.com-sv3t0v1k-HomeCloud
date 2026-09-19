import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Request, Response } from "express";
import { applySecurityMiddleware } from "./security.config";

describe("Public sharing security middleware (HTTP)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    applySecurityMiddleware(app, new ConfigService({ NODE_ENV: "test" }));
    app
      .getHttpAdapter()
      .getInstance()
      .get("/api/v1/sharing/public/ok", (_req: Request, res: Response) =>
        res.sendStatus(200),
      );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("marks successful and error responses no-store", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/ok")
      .expect("Cache-Control", "no-store")
      .expect(200);
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/missing")
      .expect("Cache-Control", "no-store")
      .expect(404);
    await request(app.getHttpServer())
      .options("/api/v1/sharing/public/token/download")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "range,content-type")
      .expect("Cache-Control", "no-store")
      .expect("Access-Control-Allow-Headers", /Range/)
      .expect(204);
  });

  it("exposes streaming headers to browser clients", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/sharing/public/missing")
      .set("Origin", "http://localhost:5173")
      .expect(404);
    const exposed = response.headers["access-control-expose-headers"];
    for (const header of [
      "Content-Disposition",
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Retry-After",
    ]) {
      expect(exposed).toContain(header);
    }
  });

  it("limits metadata enumeration across different tokens per IP", async () => {
    for (let index = 0; index < 60; index++) {
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/token-${index}`)
        .expect(404);
    }
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/another-token")
      .expect("Cache-Control", "no-store")
      .expect("Retry-After", /\d+/)
      .expect(429);
    await request(app.getHttpServer()).get("/api/v1/files").expect(404);
  });

  it("shares a stricter budget between verification and download across tokens", async () => {
    for (let index = 0; index < 10; index++) {
      const action = index % 2 ? "verify" : "download";
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/token-${index}/${action}`)
        .send({ password: "incorrect" })
        .expect(404);
    }
    for (const action of ["verify", "download"]) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/new-token/${action}`)
        .send({ password: "incorrect" })
        .expect("Cache-Control", "no-store")
        .expect(429);
    }
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/metadata")
      .expect(404);
  });

  it("preserves no-store when the global limiter rejects a public request", async () => {
    for (let index = 0; index < 100; index++) {
      await request(app.getHttpServer()).get("/api/v1/files").expect(404);
    }
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/token")
      .expect("Cache-Control", "no-store")
      .expect(429);
  });
});

describe("per-token rate limiting", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    applySecurityMiddleware(app, new ConfigService({ NODE_ENV: "test" }));
    app
      .getHttpAdapter()
      .getInstance()
      .get("/api/v1/sharing/public/ok", (_req: Request, res: Response) =>
        res.sendStatus(200),
      );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const TOK_A = "11111111-1111-5678-9abc-def012345678";
  const TOK_B = "22222222-2222-5678-9abc-def012345678";

  it("one token exhausts its own token budget (30/min)", async () => {
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/${TOK_A}`)
        .expect(404);
    }
    await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/${TOK_A}`)
      .expect("Retry-After", /\d+/)
      .expect(429);
  });

  it("different token keeps an independent bucket", async () => {
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/${TOK_A}`)
        .expect(404);
    }
    await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/${TOK_A}`)
      .expect(429);
    // TOK_B has its own bucket; IP usage at 32/60 — still under IP limit
    await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/${TOK_B}`)
      .expect(404);
  });

  it("raw token is absent from 429 response body and headers", async () => {
    const secret = "secrettoken-abcdef123456-0000-9999-8888-777777777777";
    for (let i = 0; i < 31; i++) {
      await request(app.getHttpServer()).get(`/api/v1/sharing/public/${secret}`);
    }
    const res = await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/${secret}`)
      .expect(429);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.headers)).not.toContain(secret);
  });

  it("per-IP metadata limit (60/min) still applies across many different tokens", async () => {
    for (let i = 0; i < 60; i++) {
      const hex = i.toString(16).padStart(24, "0");
      const token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 24)}`;
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/${token}`)
        .expect(404);
    }
    await request(app.getHttpServer())
      .get("/api/v1/sharing/public/finaltoken-0000000")
      .expect(429);
  });

  it("per-IP verify/download limit (10/min) still applies across different tokens", async () => {
    for (let i = 0; i < 10; i++) {
      const hex = (i + 100).toString(16).padStart(24, "0");
      const token = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 24)}`;
      const action = i % 2 === 0 ? "verify" : "download";
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${token}/${action}`)
        .send({ password: "x" })
        .expect(404);
    }
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public/newtoken-0000000/verify")
      .send({ password: "x" })
      .expect(429);
  });

  it("malformed token path falls back to IP without bypass", async () => {
    const res1 = await request(app.getHttpServer())
      .get("/api/v1/sharing/public/not-a-uuid")
      .expect(404);
    expect(res1.headers["cache-control"]).toBe("no-store");
    const res2 = await request(app.getHttpServer())
      .get("/api/v1/sharing/public/")
      .expect(404);
    expect(res2.headers["cache-control"]).toBe("no-store");
  });

  it("query string does not fragment the token bucket", async () => {
    const token = "deadbeef-dead-dead-dead-deadbeefdead";
    for (let i = 0; i < 30; i++) {
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/${token}?x=${i}`)
        .expect(404);
    }
    // 31st with a different query string → still 429 (same token bucket)
    await request(app.getHttpServer())
      .get(`/api/v1/sharing/public/${token}?x=999`)
      .expect(429);
  });
});

describe("per-token attempt rate limiting (verify/download)", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    applySecurityMiddleware(app, new ConfigService({ NODE_ENV: "test" }));
    app
      .getHttpAdapter()
      .getInstance()
      .get("/api/v1/sharing/public/ok", (_req: Request, res: Response) =>
        res.sendStatus(200),
      );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const TOKEN_A = "11111111-1111-5678-9abc-def012345678";
  const TOKEN_B = "22222222-2222-5678-9abc-def012345678";
  const SECRET = "secrettoken-abcdef123456-0000-9999-8888-777777777777";

  it("exhausts shared verify+download bucket at 10 per token", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
        .set("X-Forwarded-For", "10.0.0.1")
        .send({ password: "x" })
        .expect(404);
    }
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${TOKEN_A}/download`)
        .set("X-Forwarded-For", "10.0.0.1")
        .send({})
        .expect(404);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
      .set("X-Forwarded-For", "10.0.0.1")
      .send({ password: "x" })
      .expect(429);
  });

  it("different token has independent attempt bucket across IPs", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
        .set("X-Forwarded-For", `10.1.${i}.1`)
        .send({ password: "x" })
        .expect(404);
    }
    // 11th from new IP → per-IP attempt fresh, per-token attempt 11/10 → 429
    await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
      .set("X-Forwarded-For", "10.1.99.1")
      .send({ password: "x" })
      .expect(429);
    // Token B from same new IP → independent bucket → 404
    await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${TOKEN_B}/verify`)
      .set("X-Forwarded-For", "10.1.99.1")
      .send({ password: "x" })
      .expect(404);
  });

  it("query string does not fragment per-token attempt bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${TOKEN_A}/verify?req=${i}`)
        .set("X-Forwarded-For", `10.2.${i}.1`)
        .send({ password: "x" })
        .expect(404);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${TOKEN_A}/verify?random=bogus`)
      .set("X-Forwarded-For", "10.2.99.1")
      .send({ password: "x" })
      .expect(429);
  });

  it("metadata does not consume attempt bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .get(`/api/v1/sharing/public/${TOKEN_A}`)
        .set("X-Forwarded-For", "10.0.0.1")
        .expect(404);
    }
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
        .set("X-Forwarded-For", "10.0.0.2")
        .send({ password: "x" })
        .expect(404);
    }
    await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${TOKEN_A}/verify`)
      .set("X-Forwarded-For", "10.0.0.3")
      .send({ password: "x" })
      .expect(429);
  });

  it("missing token path fails safe without bypass", async () => {
    await request(app.getHttpServer())
      .post("/api/v1/sharing/public//verify")
      .set("X-Forwarded-For", "10.0.0.1")
      .send({ password: "x" })
      .expect(404);
  });

  it("raw token absent from 429 response", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer())
        .post(`/api/v1/sharing/public/${SECRET}/verify`)
        .set("X-Forwarded-For", `10.4.${i}.1`)
        .send({ password: "x" });
    }
    const res = await request(app.getHttpServer())
      .post(`/api/v1/sharing/public/${SECRET}/verify`)
      .set("X-Forwarded-For", "10.4.99.1")
      .send({ password: "x" })
      .expect(429);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.headers)).not.toContain(SECRET);
  });
});
