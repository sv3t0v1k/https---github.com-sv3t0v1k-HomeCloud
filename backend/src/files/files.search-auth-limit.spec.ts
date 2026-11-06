import { INestApplication } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { getSearchRateLimitOptions } from "../common/security.config";
import { StorageService } from "../storage/storage.service";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

describe("GS-1A: JWT и лимит поиска", () => {
  let app: INestApplication;
  let jwt: JwtService;

  const search = jest.fn(async (userId: number) => ({
    userId,
    files: [],
    folders: [],
  }));

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: "gs1a-test-secret" })],
      controllers: [FilesController],
      providers: [
        JwtGuard,
        { provide: FilesService, useValue: { search } },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    jwt = moduleRef.get(JwtService);
    app = moduleRef.createNestApplication();

    app.use(
      "/api/v1/files/search",
      rateLimit(getSearchRateLimitOptions(jwt)),
    );

    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  beforeEach(() => search.mockClear());

  const endpoint = "/api/v1/files/search";

  it("отклоняет отсутствующий, поддельный и истёкший JWT", async () => {
    await request(app.getHttpServer())
      .get(endpoint).query({ q: "report" }).expect(401);

    await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", "Bearer invalid.jwt.signature")
      .query({ q: "report" })
      .expect(401);

    const expired = jwt.sign({
      sub: 42,
      email: "owner@example.test",
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", `Bearer ${expired}`)
      .query({ q: "report" })
      .expect(401);

    expect(search).not.toHaveBeenCalled();
  });

  it("отклоняет дополнительные компоненты Authorization", async () => {
    const token = jwt.sign({
      sub: 42,
      email: "owner@example.test",
    });

    for (const authorization of [
      `Bearer ${token} extra`,
      `Bearer  ${token}`,
    ]) {
      await request(app.getHttpServer())
        .get(endpoint)
        .set("Authorization", authorization)
        .query({ q: "report" })
        .expect(401);
    }

    expect(search).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", `Bearer ${token}`)
      .query({ q: "report" })
      .expect(200);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it("сохраняет ключ пользователя при смене JWT и IP", () => {
    const first = jwt.sign({ sub: 42, email: "owner@example.test" });
    const second = jwt.sign({
      sub: 42, email: "owner@example.test", version: 2,
    });

    const options = getSearchRateLimitOptions(jwt);
    const firstRequest = {
      headers: { authorization: `Bearer ${first}` },
      ip: "192.0.2.10",
    } as Parameters<typeof options.keyGenerator>[0];
    const secondRequest = {
      headers: { authorization: `Bearer ${second}` },
      ip: "198.51.100.20",
    } as Parameters<typeof options.keyGenerator>[0];

    expect(options.keyGenerator(firstRequest)).toBe("user:42");
    expect(options.keyGenerator(secondRequest)).toBe("user:42");
  });

  it("ограничивает пользователя, а не IP или отдельный JWT", async () => {
    const owner = jwt.sign({ sub: 42, email: "owner@example.test" });
    const secondToken = jwt.sign({
      sub: 42, email: "owner@example.test", version: 2,
    });
    const other = jwt.sign({ sub: 43, email: "other@example.test" });

    for (let i = 0; i < 12; i++) {
      await request(app.getHttpServer())
        .get(endpoint)
        .set("Authorization", `Bearer ${owner}`)
        .query({ q: "report" })
        .expect(200);
    }

    await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", `Bearer ${secondToken}`)
      .query({ q: "report" })
      .expect(429);

    const response = await request(app.getHttpServer())
      .get(endpoint)
      .set("Authorization", `Bearer ${other}`)
      .query({ q: "report", userId: 42 })
      .expect(200);

    expect(response.body.userId).toBe(43);
    expect(search).toHaveBeenLastCalledWith(43, "report", 20, 0);
  });
});
