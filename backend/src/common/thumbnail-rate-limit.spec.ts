import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { applySecurityMiddleware } from "./security.config";

describe("Thumbnail HTTP rate-limit isolation", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();

    applySecurityMiddleware(
      app,
      new ConfigService({ NODE_ENV: "test" }),
    );

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("has a separate 240/min budget, including HEAD and query variants", async () => {
    for (let index = 0; index < 239; index++) {
      await request(app.getHttpServer())
        .get(`/api/v1/previews/1/thumbnail?nonce=${index}`)
        .set("X-Forwarded-For", `192.0.2.${index % 200 + 1}`)
        .expect(404);
    }

    await request(app.getHttpServer())
      .head("/api/v1/previews/1/thumbnail")
      .expect(404);

    const blocked = await request(app.getHttpServer())
      .get("/api/v1/previews/2/thumbnail?nonce=overflow")
      .expect(429);

    expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
    expect(blocked.body.message).toBe("Too many thumbnail requests");

    // Thumbnail traffic must not exhaust ordinary file operations.
    await request(app.getHttpServer())
      .get("/api/v1/files")
      .expect(404);
  }, 20_000);

  it("retains the ordinary budget for unrelated and malformed routes", async () => {
    for (let index = 0; index < 100; index++) {
      await request(app.getHttpServer())
        .get("/api/v1/files")
        .expect(404);
    }

    const limited = await request(app.getHttpServer())
      .get("/api/v1/files")
      .expect(429);
    expect(limited.status).toBe(429);

    for (const invalid of [
      "/api/v1/previews/1/thumbnail/extra",
      "/api/v1/previews/not-a-number/thumbnail",
      "/api/v1/previews/0/thumbnail",
      "/api/v1/previews/1/thumbnail%2f",
    ]) {
      await request(app.getHttpServer())
        .get(invalid)
        .expect(429);
    }

    await request(app.getHttpServer())
      .post("/api/v1/previews/1/thumbnail")
      .expect(429);

    // A genuine thumbnail read remains in its independent budget.
    await request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .expect(404);
  }, 15_000);
});
