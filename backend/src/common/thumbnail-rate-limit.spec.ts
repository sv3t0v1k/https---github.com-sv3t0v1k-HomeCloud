import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { Test } from "@nestjs/testing";
import request from "supertest";

import {
  applySecurityMiddleware,
  getThumbnailUserRateLimitOptions,
  thumbnailClientKey,
} from "./security.config";

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

describe("Thumbnail IPv6 /64 and authenticated-user budgets", () => {
  let app: INestApplication;

  const jwtService = {
    verify: jest.fn((token: string) => {
      if (token === "signed.payload.alpha") return { sub: 7 };
      if (token === "signed.payload.beta") return { sub: 8 };
      throw new Error("Invalid JWT");
    }),
  } as unknown as JwtService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication();

    // Simulate a trusted ingress for per-client IP integration tests.
    // Production uses configureTrustedProxy with a pinned peer address.
    app.getHttpAdapter().getInstance().set("trust proxy", 1);

    applySecurityMiddleware(
      app,
      new ConfigService({ NODE_ENV: "test" }),
      { jwtService, uploads: {} as never },
    );

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("normalizes equivalent IPv6 forms and mapped IPv4", () => {
    const fake = (ip: string) => ({ ip } as Request);

    expect(thumbnailClientKey(fake("2001:db8:abcd:42::1")))
      .toBe("ip6:2001:0db8:abcd:0042/64");

    expect(thumbnailClientKey(fake(
      "2001:0DB8:ABCD:0042:ffff::beef",
    ))).toBe("ip6:2001:0db8:abcd:0042/64");

    expect(thumbnailClientKey(fake("2001:db8:abcd:43::1")))
      .not.toBe(thumbnailClientKey(fake("2001:db8:abcd:42::1")));

    expect(thumbnailClientKey(fake("::ffff:192.0.2.9")))
      .toBe(thumbnailClientKey(fake("192.0.2.9")));
  });

  it("rejects IPv6 address rotation within one /64", async () => {
    for (let index = 1; index <= 240; index++) {
      await request(app.getHttpServer())
        .get("/api/v1/previews/1/thumbnail")
        .set(
          "X-Forwarded-For",
          `2001:db8:abcd:42::${index.toString(16)}`,
        )
        .expect(404);
    }

    const blocked = await request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("X-Forwarded-For", "2001:db8:abcd:42::ffff")
      .expect(429);

    expect(blocked.body.message).toBe("Too many thumbnail requests");

    // Another /64 has its own IP budget when no JWT is supplied.
    await request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("X-Forwarded-For", "2001:db8:abcd:43::1")
      .expect(404);
  }, 30_000);

  it("rejects one verified user rotating across distinct subnets", async () => {
    for (let index = 1; index <= 240; index++) {
      await request(app.getHttpServer())
        .get("/api/v1/previews/1/thumbnail")
        .set("Authorization", "Bearer signed.payload.alpha")
        .set(
          "X-Forwarded-For",
          `2001:db8:${index.toString(16)}:42::1`,
        )
        .expect(404);
    }

    const blocked = await request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("Authorization", "Bearer signed.payload.alpha")
      .set("X-Forwarded-For", "2001:db8:1000:42::1")
      .expect(429);

    expect(blocked.body.message).toBe("Too many thumbnail requests");

    // A different verified user from the same new subnet remains admitted.
    await request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("Authorization", "Bearer signed.payload.beta")
      .set("X-Forwarded-For", "2001:db8:1000:42::2")
      .expect(404);
  }, 30_000);

  it("does not derive user keys from unverified JWT payloads", () => {
    const options = getThumbnailUserRateLimitOptions(jwtService);

    const fake = (authorization: string) => ({
      headers: { authorization },
      ip: "2001:db8:abcd:42::1",
    } as Request);

    expect(options.keyGenerator(
      fake("Bearer signed.payload.alpha"),
    )).toBe("user:7");

    expect(options.keyGenerator(
      fake("Bearer invalid.payload.signature"),
    )).toBe("ip6:2001:0db8:abcd:0042/64");

    expect(options.keyGenerator(
      fake("Bearer unsigned"),
    )).toBe("ip6:2001:0db8:abcd:0042/64");
  });
});
