import { INestApplication } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "../auth/jwt.strategy";
import { UploadRateLimitService } from "../uploads/upload-rate-limit";
import request from "supertest";
import { JwtGuard } from "../auth/guards/jwt.guard";
import { applySecurityMiddleware, getSearchRateLimitOptions } from "../common/security.config";
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

  const findAll = jest.fn(async () => []);

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: "gs1a-test-secret" })],
      controllers: [FilesController],
      providers: [
        JwtGuard,
        { provide: JwtStrategy, useValue: { validate: async (payload: { sub: number; email: string }) => ({ userId: payload.sub, email: payload.email }) } },
        { provide: FilesService, useValue: { search, findAll } },
        { provide: StorageService, useValue: {} },
      ],
    }).compile();

    jwt = moduleRef.get(JwtService);
    app = moduleRef.createNestApplication();

    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    applySecurityMiddleware(app, new ConfigService({ NODE_ENV: "test" }), {
      jwtService: jwt, uploads: new UploadRateLimitService(),
    });

    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  beforeEach(() => { search.mockClear(); findAll.mockClear(); });

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
  it("разделяет один бюджет между старым и новым поиском, HEAD/регистр/слеш не обходят его", async () => {
    const owner = jwt.sign({ sub: 42, email: "owner@example.test" });
    const rotated = jwt.sign({ sub: 42, email: "owner@example.test", version: 2 });
    const routes = [endpoint, "/api/v1/files", "/API/V1/FILES/SEARCH/", "/API/V1/FILES/"];
    for (let n = 0; n < 12; n++) {
      const path = routes[n % routes.length];
      const r = n % 3 === 0 ? request(app.getHttpServer()).head(path) : request(app.getHttpServer()).get(path);
      await r.set("Authorization", `Bearer ${n % 2 ? owner : rotated}`)
        .set("X-Forwarded-For", `192.0.2.${n + 1}`)
        .query(path.toLowerCase().includes("search") ? { q: "report" } : { search: "r" }).expect(200);
    }
    for (const path of routes) {
      const response = await request(app.getHttpServer()).get(path)
        .set("Authorization", `Bearer ${rotated}`).set("X-Forwarded-For", "198.51.100.2")
        .query(path.toLowerCase().includes("search") ? { q: "report" } : { search: "r" }).expect(429);
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    }
    await request(app.getHttpServer()).get("/api/v1/files")
      .set("Authorization", `Bearer ${owner}`).expect(200);
  });

  it("учитывает невалидный legacy search в поисковом бюджете до валидации", async () => {
    const owner = jwt.sign({ sub: 42, email: "owner@example.test" });
    for (let n = 0; n < 12; n++) await request(app.getHttpServer()).get("/api/v1/files?search[x]=a")
      .set("Authorization", `Bearer ${owner}`).expect(400);
    await request(app.getHttpServer()).get(endpoint).query({ q: "report" })
      .set("Authorization", `Bearer ${owner}`).expect(429);
    expect(findAll).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

});
