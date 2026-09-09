import { AuthService } from "./auth.service";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";

describe("AuthService - Phase 3", () => {
  let service: AuthService;
  let mockUserRepository: any;
  let mockRefreshTokenRepository: any;
  let mockJwtService: any;
  let mockConfigService: any;

  const createMockConfig = (overrides: Record<string, string | undefined> = {}) => ({
    get: jest.fn((key: string) => {
      if (key === "JWT_SECRET") return "strong-secret-key-1234567890-abcdef";
      if (key === "JWT_REFRESH_SECRET") return "strong-refresh-secret-1234567890-abcdef";
      if (key === "JWT_EXPIRES_IN") return "15m";
      if (key === "JWT_REFRESH_EXPIRES_IN") return "7d";
      return overrides[key] || undefined;
    }),
  });

  beforeEach(() => {
    mockUserRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
    };
    mockRefreshTokenRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
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
    mockJwtService = {
      sign: jest.fn((payload, options) => `access-${payload.sub}`),
      verify: jest.fn((token, options) => ({ sub: 1, email: "user@test.com" })),
    };

    mockConfigService = createMockConfig();

    service = new AuthService(
      mockUserRepository,
      mockRefreshTokenRepository,
      mockJwtService,
      mockConfigService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("validateJwtSecret", () => {
    it("should reject weak default secret", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET") return "changeme-change-in-production";
        if (key === "JWT_REFRESH_SECRET") return "strong-refresh-secret-1234567890";
        return undefined;
      });

      const result = await service.validateJwtSecret();
      expect(result.valid).toBe(false);
      expect(result.message).toContain("weak or default");
    });

    it("should reject short secret", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET") return "short";
        if (key === "JWT_REFRESH_SECRET") return "strong-refresh-secret-1234567890";
        return undefined;
      });

      const result = await service.validateJwtSecret();
      expect(result.valid).toBe(false);
      expect(result.message).toContain("at least 32 characters");
    });

    it("should accept strong secret", async () => {
      const result = await service.validateJwtSecret();
      expect(result.valid).toBe(true);
    });
  });

  describe("validateRefreshSecret", () => {
    it("should reject weak refresh secret", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET") return "strong-secret-key-1234567890";
        if (key === "JWT_REFRESH_SECRET") return "changeme";
        return undefined;
      });

      const result = await service.validateRefreshSecret();
      expect(result.valid).toBe(false);
      expect(result.message).toContain("weak or default");
    });
  });

  describe("refresh", () => {
    it("should reject reused refresh token and revoke all user tokens", async () => {
      const user = { id: 1, email: "user@test.com", isActive: true };
      const tokenHash = await bcrypt.hash("token-a", 10);
      const storedToken = {
        id: 1,
        tokenHash,
        userId: 1,
        revoked: true,
        expiresAt: new Date(Date.now() + 86400000),
      };

      mockUserRepository.findOne.mockResolvedValue(user);
      mockRefreshTokenRepository.findOne.mockResolvedValue(storedToken);

      await expect(
        service.refresh(1, "token-a"),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockRefreshTokenRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("should revoke refresh token on logout", async () => {
      const tokenHash = await bcrypt.hash("token-a", 10);
      const storedToken = {
        id: 1,
        tokenHash,
        userId: 1,
        revoked: false,
      };

      mockRefreshTokenRepository.findOne.mockResolvedValue(storedToken);

      await service.logout(1, "token-a");

      expect(mockRefreshTokenRepository.update).toHaveBeenCalledWith(1, {
        revoked: true,
        revokedAt: expect.any(Date),
      });
    });
  });

  describe("changePassword", () => {
    it("should revoke all refresh tokens after password change", async () => {
      const user = {
        id: 1,
        email: "user@test.com",
        password: await bcrypt.hash("oldpass", 12),
      };

      mockUserRepository.findOne.mockResolvedValue(user);
      mockRefreshTokenRepository.save.mockResolvedValue({});

      await service.changePassword(1, "oldpass", "newpass");

      expect(mockRefreshTokenRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });
});
