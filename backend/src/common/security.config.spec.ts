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
