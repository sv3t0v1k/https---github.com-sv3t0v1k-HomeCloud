import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { ConfigService, ConfigModule } from "@nestjs/config";
import request from "supertest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import {
  applySecurityMiddleware,
  buildCorsOptions,
} from "../common/security.config";

const PRODUCTION_CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

function validLoginBody() {
  return { email: "user@test.com", password: "password123" };
}

describe("AuthController", () => {
  describe("Production security wiring (via security.config helpers)", () => {
    let app: any;
    let configService: ConfigService;

    const mockAuthService: any = {
      register: jest.fn(),
      login: jest.fn(),
      verifyRefreshToken: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
      changePassword: jest.fn(),
    };

    const mockJwtService: any = {
      verify: jest.fn((_token: string) => ({ sub: 1, email: "user@test.com" })),
      sign: jest.fn(),
    };

    beforeEach(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [() => PRODUCTION_CONFIG],
          }),
        ],
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: mockAuthService },
          { provide: JwtService, useValue: mockJwtService },
          { provide: Reflector, useValue: {} },
        ],
      }).compile();

      app = moduleFixture.createNestApplication();
      configService = moduleFixture.get(ConfigService);

      applySecurityMiddleware(app, configService);
      app.setGlobalPrefix("api/v1");
      await app.init();
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    it("CORS: production origin allowed with credentials", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .set("Origin", "https://app.example.ru")
        .send(validLoginBody())
        .expect(200);

      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.ru");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("CORS: preflight (OPTIONS) returns 204 with CORS headers", async () => {
      const res = await request(app.getHttpServer())
        .options("/api/v1/auth/refresh")
        .set("Origin", "https://app.example.ru")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "Content-Type, Authorization")
        .expect(204);

      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.ru");
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("CORS: preflight includes allowed methods and headers", async () => {
      const res = await request(app.getHttpServer())
        .options("/api/v1/auth/refresh")
        .set("Origin", "https://app.example.ru")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "Content-Type, Authorization")
        .expect(204);

      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.ru");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
      expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
    });

    it("buildCorsOptions throws when FRONTEND_URL missing in production", () => {
      const prodWithoutFrontend: Record<string, string | undefined> = {
        NODE_ENV: "production",
        FRONTEND_URL: undefined,
        JWT_SECRET: "strong-access-secret-1234567890ab",
        JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
        JWT_EXPIRES_IN: "15m",
        JWT_REFRESH_EXPIRES_IN: "7d",
      };
      const cs = { get: (key: string) => prodWithoutFrontend[key] };
      expect(() => buildCorsOptions(cs as unknown as ConfigService)).toThrow(
        "FRONTEND_URL must be set in production for CORS configuration",
      );
    });

    it("Global + auth rate limit wired through production helpers", async () => {
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send(validLoginBody())
          .expect(200);
      }
      expect(mockAuthService.login).toHaveBeenCalledTimes(10);
    });

    it("11th request to /api/v1/auth → 429", async () => {
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send(validLoginBody());
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send(validLoginBody())
        .expect(429);

      expect(res.status).toBe(429);
    });
  });

});
