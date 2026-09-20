import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigModule } from "@nestjs/config";
import request from "supertest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

const CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

/**
 * Phase 11.2B — regression coverage for the refresh/logout DTO boundary.
 * Replicates the global ValidationPipe from main.ts exactly; verifies only
 * DTO/global-validation behavior, not JWT cryptography (AuthService is mocked).
 */
describe("AuthController refresh/logout validation (Phase 11.2B)", () => {
  let app: any;
  const verifyRefresh = jest.fn();
  const refresh = jest.fn();
  const logout = jest.fn();
  const jwtVerify = jest.fn(() => ({ sub: 1, email: "u@t.c" }));

  beforeAll(async () => {
    verifyRefresh.mockResolvedValue({ sub: 1, email: "u@t.c" });
    refresh.mockResolvedValue({ accessToken: "a", refreshToken: "r" });
    logout.mockResolvedValue(undefined);

    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => CONFIG] })],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: { verifyRefreshToken: verifyRefresh, refresh, logout },
        },
        { provide: JwtService, useValue: { verify: jwtVerify, sign: jest.fn() } },
        { provide: Reflector, useValue: {} },
      ],
    }).compile();

    app = mod.createNestApplication();
    // Exact global pipe from main.ts
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix("api/v1");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.clearAllMocks());

  const authHeader = { Authorization: "Bearer faketoken" };

  async function post(path: string, body: any, auth = false) {
    let r = request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send(body);
    if (auth) r = r.set(authHeader);
    return r;
  }

  describe("POST /auth/refresh", () => {
    it("valid refreshToken passes validation and reaches service", async () => {
      const res = await post("refresh", { refreshToken: "valid-rt" });
      expect(res.status).toBe(200);
      expect(verifyRefresh).toHaveBeenCalledTimes(1);
      expect(verifyRefresh).toHaveBeenCalledWith("valid-rt");
      expect(refresh).toHaveBeenCalledWith(1, "valid-rt");
    });

    it("missing refreshToken -> 400", async () => {
      const res = await post("refresh", {});
      expect(res.status).toBe(400);
      expect(verifyRefresh).not.toHaveBeenCalled();
    });

    it("non-string refreshToken -> 400", async () => {
      const res = await post("refresh", { refreshToken: 123 });
      expect(res.status).toBe(400);
      expect(verifyRefresh).not.toHaveBeenCalled();
    });

    it("empty refreshToken -> 400", async () => {
      const res = await post("refresh", { refreshToken: "" });
      expect(res.status).toBe(400);
      expect(verifyRefresh).not.toHaveBeenCalled();
    });

    it("over-limit refreshToken -> 400", async () => {
      const res = await post("refresh", {
        refreshToken: "x".repeat(1025),
      });
      expect(res.status).toBe(400);
      expect(verifyRefresh).not.toHaveBeenCalled();
    });

    it("unknown property -> 400", async () => {
      const res = await post("refresh", {
        refreshToken: "valid-rt",
        unknownProp: "x",
      });
      expect(res.status).toBe(400);
      expect(verifyRefresh).not.toHaveBeenCalled();
    });
  });

  describe("POST /auth/logout", () => {
    it("valid refreshToken passes validation and reaches service", async () => {
      const res = await post("logout", { refreshToken: "valid-rt" }, true);
      expect(res.status).toBe(200);
      expect(logout).toHaveBeenCalledTimes(1);
      expect(logout).toHaveBeenCalledWith(1, "valid-rt");
    });

    it("missing refreshToken -> 400", async () => {
      const res = await post("logout", {}, true);
      expect(res.status).toBe(400);
      expect(logout).not.toHaveBeenCalled();
    });

    it("non-string refreshToken -> 400", async () => {
      const res = await post("logout", { refreshToken: 123 }, true);
      expect(res.status).toBe(400);
      expect(logout).not.toHaveBeenCalled();
    });

    it("empty refreshToken -> 400", async () => {
      const res = await post("logout", { refreshToken: "" }, true);
      expect(res.status).toBe(400);
      expect(logout).not.toHaveBeenCalled();
    });

    it("over-limit refreshToken -> 400", async () => {
      const res = await post("logout", { refreshToken: "x".repeat(1025) }, true);
      expect(res.status).toBe(400);
      expect(logout).not.toHaveBeenCalled();
    });

    it("unknown property -> 400", async () => {
      const res = await post("logout", { refreshToken: "valid-rt", unknownProp: "x" }, true);
      expect(res.status).toBe(400);
      expect(logout).not.toHaveBeenCalled();
    });
  });
});
