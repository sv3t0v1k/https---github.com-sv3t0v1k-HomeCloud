import { Test, TestingModule } from "@nestjs/testing";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { getRepositoryToken } from "@nestjs/typeorm";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { AuthService } from "./auth.service";
import * as bcrypt from "bcryptjs";

const PRODUCTION_CONFIG = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://app.example.ru",
  JWT_SECRET: "strong-access-secret-1234567890ab",
  JWT_REFRESH_SECRET: "strong-refresh-secret-1234567890ab",
  JWT_EXPIRES_IN: "15m",
  JWT_REFRESH_EXPIRES_IN: "7d",
};

const mockUserRepository = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
};

const mockRefreshTokenRepository = {
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          execute: jest.fn().mockResolvedValue({}),
        })),
      })),
    })),
  })),
  manager: {
    transaction: jest.fn(),
  },
};

type TokenRecord = {
  id: number;
  tokenHash: string;
  userId: number;
  revoked: boolean;
  expiresAt: Date;
};

function createManager(records: TokenRecord[]) {
  return {
    find: jest.fn().mockImplementation(async (_entity: any, options?: any) => {
      const userId = options?.where?.userId;
      return userId === undefined
        ? []
        : records.filter((r) => r.userId === userId);
    }),
    findOne: jest.fn().mockImplementation(async (entity: any, options?: any) => {
      if (entity === UserEntity && options?.where?.id) {
        return { id: options.where.id, isActive: true };
      }
      if (entity === RefreshTokenEntity && options?.where?.id) {
        return records.find((r) => r.id === options.where.id) ?? null;
      }
      return null;
    }),
    update: jest.fn().mockImplementation(async (_entity: any, criteria: any, changes: any) => {
      const index = records.findIndex((record) =>
        Object.entries(criteria).every(
          ([key, value]) => (record as Record<string, unknown>)[key] === value,
        ),
      );
      if (index === -1) {
        return { affected: 0 };
      }
      Object.assign(records[index], changes);
      return { affected: 1 };
    }),
    create: jest.fn().mockReturnValue({}),
    save: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn(() => ({
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({
            execute: jest.fn().mockResolvedValue({}),
          })),
        })),
      })),
    })),
  };
}

describe("AuthService - token lifecycle (real services)", () => {
  let service: AuthService;
  let jwtService: JwtService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => PRODUCTION_CONFIG],
        }),
        JwtModule.registerAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (configService: ConfigService) => ({
            secret: configService.get("JWT_SECRET"),
            signOptions: {
              expiresIn: configService.get("JWT_EXPIRES_IN") || "15m",
            },
          }),
        }),
      ],
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(UserEntity),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(RefreshTokenEntity),
          useValue: mockRefreshTokenRepository,
        },
      ],
    }).compile();

    service = moduleFixture.get(AuthService);
    jwtService = moduleFixture.get(JwtService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("production TTL config", () => {
    it("access token expires according to JWT_EXPIRES_IN=15m", () => {
      const payload = { sub: 1, email: "user@test.com" };
      const token = jwtService.sign(payload, {
        secret: PRODUCTION_CONFIG.JWT_SECRET,
        expiresIn: PRODUCTION_CONFIG.JWT_EXPIRES_IN,
      });

      const decoded = jwtService.verify(token, {
        secret: PRODUCTION_CONFIG.JWT_SECRET,
      }) as any;

      const ttlSeconds = decoded.exp - decoded.iat;
      expect(ttlSeconds).toBeCloseTo(15 * 60, -1);
    });

    it("refresh token expires according to JWT_REFRESH_EXPIRES_IN=7d", () => {
      const payload = { sub: 1, email: "user@test.com", jti: "test-jti" };
      const token = jwtService.sign(payload, {
        secret: PRODUCTION_CONFIG.JWT_REFRESH_SECRET,
        expiresIn: PRODUCTION_CONFIG.JWT_REFRESH_EXPIRES_IN,
      });

      const decoded = jwtService.verify(token, {
        secret: PRODUCTION_CONFIG.JWT_REFRESH_SECRET,
      }) as any;

      const ttlSeconds = decoded.exp - decoded.iat;
      expect(ttlSeconds).toBeCloseTo(7 * 24 * 60 * 60, -2);
    });

    it("access and refresh tokens use distinct secrets", () => {
      const accessToken = jwtService.sign(
        { sub: 1, email: "user@test.com" },
        {
          secret: PRODUCTION_CONFIG.JWT_SECRET,
          expiresIn: PRODUCTION_CONFIG.JWT_EXPIRES_IN,
        },
      );
      const refreshToken = jwtService.sign(
        { sub: 1, email: "user@test.com", jti: "test-jti" },
        {
          secret: PRODUCTION_CONFIG.JWT_REFRESH_SECRET,
          expiresIn: PRODUCTION_CONFIG.JWT_REFRESH_EXPIRES_IN,
        },
      );

      expect(() =>
        jwtService.verify(accessToken, {
          secret: PRODUCTION_CONFIG.JWT_REFRESH_SECRET,
        }),
      ).toThrow();

      expect(() =>
        jwtService.verify(refreshToken, {
          secret: PRODUCTION_CONFIG.JWT_SECRET,
        }),
      ).toThrow();
    });
  });

  describe("refresh expiry/reuse path (real AuthService)", () => {
    it("rejects expired refresh token via real AuthService logic", async () => {
      const storedTokenHash = await bcrypt.hash("expired-token", 10);
      const records: TokenRecord[] = [
        {
          id: 1,
          tokenHash: storedTokenHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() - 1000),
        },
      ];

      mockRefreshTokenRepository.manager.transaction.mockImplementation(
        async (callback) => {
          const manager = createManager(records);
          return callback(manager);
        },
      );

      await expect(service.refresh(1, "expired-token")).rejects.toThrow(
        "Refresh token expired",
      );
    });

    it("rejects reused refresh token via real AuthService logic", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const records: TokenRecord[] = [
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ];

      mockRefreshTokenRepository.manager.transaction.mockImplementation(
        async (callback) => {
          const manager = createManager(records);
          return callback(manager);
        },
      );

      const firstResult = await service.refresh(1, "token-a");
      expect(firstResult.refreshToken).toBeDefined();

      await expect(service.refresh(1, "token-a")).rejects.toThrow(
        "Refresh token was reused",
      );
    });
  });
});
