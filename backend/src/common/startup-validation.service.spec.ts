import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { INestApplication } from "@nestjs/common";
import { StartupValidationService, validateStartupConfiguration } from "./startup-validation.service";

const PRODUCTION_CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
  DB_PASSWORD: "strong-db-password-2026!",
  REDIS_PASSWORD: "strong-redis-password-2026!",
};

async function createApp(envValues: Record<string, string>): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => envValues],
      }),
    ],
    providers: [StartupValidationService],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

describe("validateStartupConfiguration helper (real wiring)", () => {
  it("passes strong production config via helper", async () => {
    const app = await createApp(PRODUCTION_CONFIG);
    await expect(validateStartupConfiguration(app)).resolves.toBeDefined();
    await app.close();
  });

  it("fail-closed: rejects weak JWT_SECRET via helper", async () => {
    const app = await createApp({
      ...PRODUCTION_CONFIG,
      JWT_SECRET: "change-me-in-production",
    });
    await expect(validateStartupConfiguration(app)).rejects.toThrow(
      /JWT_SECRET is weak or default/,
    );
    await app.close();
  });

  it("fail-closed: rejects equal JWT secrets via helper", async () => {
    const sameSecret = "same-secret-value-that-is-long-enough-here";
    const app = await createApp({
      ...PRODUCTION_CONFIG,
      JWT_SECRET: sameSecret,
      JWT_REFRESH_SECRET: sameSecret,
    });
    await expect(validateStartupConfiguration(app)).rejects.toThrow(
      /JWT_SECRET and JWT_REFRESH_SECRET must be different values/,
    );
    await app.close();
  });

  it("fail-closed: rejects weak DB_PASSWORD via helper", async () => {
    const app = await createApp({
      ...PRODUCTION_CONFIG,
      DB_PASSWORD: "change-me-in-production",
    });
    await expect(validateStartupConfiguration(app)).rejects.toThrow(
      /DB_PASSWORD is weak or default/,
    );
    await app.close();
  });
});

describe("StartupValidationService (unit, real ConfigModule)", () => {
  let service: StartupValidationService;

  const createModule = async (envValues: Record<string, string>) => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => envValues],
        }),
      ],
      providers: [StartupValidationService],
    }).compile();

    const configService = module.get<ConfigService>(ConfigService);
    // Verify real ConfigService is used (not a mock)
    expect(configService.get).toBeDefined();
    return module.get<StartupValidationService>(StartupValidationService);
  };

  describe("production-like config", () => {
    beforeEach(async () => {
      service = await createModule(PRODUCTION_CONFIG);
    });

    it("should pass validation with strong distinct secrets", async () => {
      await expect(service.validateJwtSecrets()).resolves.not.toThrow();
    });

    it("should pass DB/Redis credential validation", async () => {
      await expect(service.validateDatabaseCredentials()).resolves.not.toThrow();
    });
  });

  describe("fail-closed: JWT secrets", () => {
    it("should reject weak JWT_SECRET", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_SECRET: "change-me-in-production",
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_SECRET is weak or default/,
      );
    });

    it("should reject weak JWT_REFRESH_SECRET", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_REFRESH_SECRET: "change-me-in-production",
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_REFRESH_SECRET is weak or default/,
      );
    });

    it("should reject short JWT_SECRET (< 32 chars)", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_SECRET: "short",
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_SECRET must be at least 32 characters/,
      );
    });

    it("should reject short JWT_REFRESH_SECRET (< 32 chars)", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_REFRESH_SECRET: "short",
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_REFRESH_SECRET must be at least 32 characters/,
      );
    });

    it("should reject equal JWT secrets", async () => {
      const sameSecret = "same-secret-value-that-is-long-enough-here";
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_SECRET: sameSecret,
        JWT_REFRESH_SECRET: sameSecret,
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_SECRET and JWT_REFRESH_SECRET must be different values/,
      );
    });

    it("should reject empty JWT_SECRET", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        JWT_SECRET: "",
      });

      await expect(service.validateJwtSecrets()).rejects.toThrow(
        /JWT_SECRET is weak or default/,
      );
    });
  });

  describe("fail-closed: DB/Redis credentials", () => {
    it("should reject weak DB_PASSWORD", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        DB_PASSWORD: "change-me-in-production",
      });

      await expect(service.validateDatabaseCredentials()).rejects.toThrow(
        /DB_PASSWORD is weak or default/,
      );
    });

    it("should reject weak REDIS_PASSWORD", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        REDIS_PASSWORD: "change-me-in-production",
      });

      await expect(service.validateDatabaseCredentials()).rejects.toThrow(
        /REDIS_PASSWORD is weak or default/,
      );
    });

    it("should reject short DB_PASSWORD (< 8 chars)", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        DB_PASSWORD: "short",
      });

      await expect(service.validateDatabaseCredentials()).rejects.toThrow(
        /DB_PASSWORD must be at least 8 characters/,
      );
    });

    it("should reject short REDIS_PASSWORD (< 8 chars)", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        REDIS_PASSWORD: "short",
      });

      await expect(service.validateDatabaseCredentials()).rejects.toThrow(
        /REDIS_PASSWORD must be at least 8 characters/,
      );
    });

    it("should reject empty DB_PASSWORD", async () => {
      service = await createModule({
        ...PRODUCTION_CONFIG,
        DB_PASSWORD: "",
      });

      await expect(service.validateDatabaseCredentials()).rejects.toThrow(
        /DB_PASSWORD is weak or default/,
      );
    });
  });
});
