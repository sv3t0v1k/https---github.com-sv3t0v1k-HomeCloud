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

  beforeAll(async () => {
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

  afterAll(async () => {
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
