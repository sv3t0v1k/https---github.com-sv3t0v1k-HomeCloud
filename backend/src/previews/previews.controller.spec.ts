import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import request from "supertest";
import { PreviewsController } from "./previews.controller";
import { PreviewsService } from "./previews.service";

const CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

/**
 * Phase 11.3 — thumbnail cache boundary regression.
 * Verifies only the HTTP cache/auth contract (content generation is mocked).
 */
describe("PreviewsController thumbnail cache boundary (Phase 11.3)", () => {
  let app: any;
  const getThumbnail = jest.fn();
  const jwtVerify = jest.fn(() => ({ sub: 1, email: "u@t.c" }));

  beforeAll(async () => {
    getThumbnail.mockResolvedValue(Buffer.from("thumbnail-bytes"));

    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => CONFIG] })],
      controllers: [PreviewsController],
      providers: [
        { provide: PreviewsService, useValue: { getThumbnail } },
        { provide: JwtService, useValue: { verify: jwtVerify, sign: jest.fn() } },
        { provide: Reflector, useValue: {} },
      ],
    }).compile();

    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  const authed = () =>
    request(app.getHttpServer())
      .get("/api/v1/previews/1/thumbnail")
      .set("Authorization", "Bearer faketoken");

  it("authenticated thumbnail → private cache policy, not public, content unchanged", async () => {
    const res = await authed();

    expect(res.status).toBe(200);
    const cc = (res.headers["cache-control"] as string) || "";
    expect(cc).toContain("private");
    expect(cc).toContain("max-age=86400");
    expect(cc).not.toContain("public");
    expect((res.headers["vary"] as string) || "").toContain("Authorization");
    expect(res.headers["content-type"]).toContain("image/png");
    expect(getThumbnail).toHaveBeenCalledWith(1, 1);
  });

  it("missing Authorization → auth requirement enforced (guard rejects)", async () => {
    const res = await request(app.getHttpServer()).get(
      "/api/v1/previews/1/thumbnail",
    );

    expect([401, 403]).toContain(res.status);
    expect(getThumbnail).not.toHaveBeenCalled();
  });
});
