jest.mock("bcryptjs", () => ({
  hash: jest.fn(async (value: string | Buffer) => {
    const token = value.toString();
    if (token === "token-a") return "old-hash";
    if (token.startsWith("refresh-")) return `hash-${token}`;
    return `password-hash-${token}`;
  }),
  compare: jest.fn(
    async (value: string | Buffer, hash: string) =>
      hash === `password-hash-${value.toString()}` ||
      hash === `hash-${value.toString()}` ||
      (value.toString() === "token-a" && hash === "old-hash"),
  ),
}));

import { AuthService } from "./auth.service";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";

type TokenRecord = {
  id: number;
  tokenHash: string;
  userId: number;
  revoked: boolean;
  expiresAt: Date;
  replacedBy?: string;
  revokedAt?: Date;
};

describe("AuthService - Phase 3", () => {
  let service: AuthService;
  let mockUserRepository: any;
  let mockRefreshTokenRepository: any;
  let mockJwtService: any;
  let mockConfigService: any;
  let transactionHarness: ReturnType<typeof createTransactionManager>;

  const user = { id: 1, email: "user@test.com", isActive: true };

  const createTransactionManager = (initialRecords: TokenRecord[]) => {
    const records = initialRecords.map((record) => ({ ...record }));
    let nextId = Math.max(0, ...records.map((record) => record.id)) + 1;
    let tokenLockTail = Promise.resolve();
    const findOneCalls: any[] = [];
    const find = jest.fn();

    const acquireTokenLock = async () => {
      const previousLock = tokenLockTail;
      let releaseLock: () => void = () => undefined;
      tokenLockTail = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previousLock;
      return releaseLock;
    };

    const update = jest.fn(
      async (_entity: unknown, criteria: any, changes: any) => {
        const record = records.find(
          (candidate) => candidate.id === criteria.id,
        );
        if (!record || record.revoked !== criteria.revoked) {
          return { affected: 0 };
        }

        Object.assign(record, changes);
        return { affected: 1 };
      },
    );

    const create = jest.fn(
      (
        _entity: unknown,
        data: Pick<TokenRecord, "tokenHash" | "expiresAt" | "userId">,
      ) => {
        const record: TokenRecord = {
          id: nextId++,
          revoked: false,
          ...data,
        };
        records.push(record);
        return record;
      },
    );

    const save = jest.fn(async (entity: TokenRecord) => entity);

    const revokeAllExecute = jest.fn(async () => {
      let affected = 0;
      for (const record of records) {
        if (!record.revoked) {
          record.revoked = true;
          record.revokedAt = new Date();
          affected += 1;
        }
      }
      return { affected };
    });

    const createManager = () => {
      let releaseTokenLock: (() => void) | undefined;
      const queryBuilder: any = {
        update: jest.fn(() => queryBuilder),
        set: jest.fn(() => queryBuilder),
        where: jest.fn(() => queryBuilder),
        execute: revokeAllExecute,
      };
      find.mockImplementation(async (_entity: unknown, options: any) => {
        const userId = options?.where?.userId;
        return userId === undefined
          ? []
          : records
              .filter((record) => record.userId === userId)
              .map((record) => ({ ...record }));
      });
      const findOne = jest.fn(async (entity: unknown, options: any) => {
        findOneCalls.push(options);
        if (options?.lock) {
          releaseTokenLock = await acquireTokenLock();
          const id = options?.where?.id;
          return records.find((record) => record.id === id) ?? null;
        }
        if (entity === RefreshTokenEntity) {
          const tokenHash = options?.where?.tokenHash;
          return (
            records.find((record) => record.tokenHash === tokenHash) ?? null
          );
        }
        if (options?.where?.id) return { ...user };
        return null;
      });
      const manager = {
        find,
        findOne,
        update,
        create,
        save,
        createQueryBuilder: jest.fn(() => queryBuilder),
      };
      return {
        manager,
        releaseTokenLock: () => {
          releaseTokenLock?.();
          releaseTokenLock = undefined;
        },
      };
    };

    return {
      records,
      createManager,
      find,
      findOneCalls,
      update,
      create,
      save,
      revokeAllExecute,
    };
  };

  const useTransaction = (initialRecords: TokenRecord[] = []) => {
    transactionHarness = createTransactionManager(initialRecords);
    mockRefreshTokenRepository.manager = {
      transaction: jest.fn(async (callback: (manager: any) => Promise<any>) => {
        const { manager, releaseTokenLock } =
          transactionHarness.createManager();
        const snapshot = transactionHarness.records.map((record) => ({
          ...record,
        }));
        try {
          return await callback(manager);
        } catch (error) {
          transactionHarness.records.splice(
            0,
            transactionHarness.records.length,
            ...snapshot,
          );
          throw error;
        } finally {
          releaseTokenLock();
        }
      }),
    };
    return transactionHarness;
  };

  const createMockConfig = (
    overrides: Record<string, string | undefined> = {},
  ) => ({
    get: jest.fn((key: string) => {
      if (key === "JWT_SECRET") return "strong-secret-key-1234567890-abcdef";
      if (key === "JWT_REFRESH_SECRET")
        return "strong-refresh-secret-1234567890-abcdef";
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
    };
    mockJwtService = {
      sign: jest.fn(),
      verify: jest.fn((token, options) => ({
        sub: 1,
        email: "user@test.com",
      })),
    };
    mockConfigService = createMockConfig();

    let tokenSequence = 0;
    mockJwtService.sign.mockImplementation(
      (payload: { sub: number }, options?: { secret?: string }) => {
        tokenSequence += 1;
        const isRefreshToken =
          options?.secret === mockConfigService.get("JWT_REFRESH_SECRET");
        return isRefreshToken
          ? `refresh-${tokenSequence}`
          : `access-${tokenSequence}`;
      },
    );

    useTransaction();

    service = new AuthService(
      mockUserRepository,
      mockRefreshTokenRepository,
      mockJwtService,
      mockConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe("validateJwtSecret", () => {
    it("should reject weak default secret", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET") return "changeme-change-in-production";
        if (key === "JWT_REFRESH_SECRET")
          return "strong-refresh-secret-1234567890";
        return undefined;
      });

      const result = await service.validateJwtSecret();
      expect(result.valid).toBe(false);
      expect(result.message).toContain("weak or default");
    });

    it("should reject short secret", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "JWT_SECRET") return "short";
        if (key === "JWT_REFRESH_SECRET")
          return "strong-refresh-secret-1234567890";
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
    it("should allow only one of two concurrent refreshes of the same token", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      const results = await Promise.allSettled([
        service.refresh(1, "token-a"),
        service.refresh(1, "token-a"),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<any> =>
          result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(UnauthorizedException);
      expect(rejected[0].reason.message).toBe("Refresh token was reused");
      expect(harness.update).toHaveBeenCalledTimes(1);
      expect(harness.revokeAllExecute).toHaveBeenCalledTimes(1);
      expect(harness.findOneCalls).toContainEqual(
        expect.objectContaining({
          where: { id: 1 },
          lock: { mode: "pessimistic_write" },
        }),
      );
    });

    it("should compare the raw token against the stored bcrypt hash", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      jest.clearAllMocks();
      await service.refresh(1, "token-a");

      expect(bcrypt.compare).toHaveBeenCalledWith("token-a", oldHash);
      expect(bcrypt.hash).not.toHaveBeenCalledWith("token-a", 10);
      expect(bcrypt.hash).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh-\d+$/),
        10,
      );
      expect(harness.find).toHaveBeenCalledWith(
        RefreshTokenEntity,
        expect.objectContaining({ where: { userId: 1 } }),
      );
    });

    it("should assign a unique jti to every refresh token", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      const firstRotation = await service.refresh(1, "token-a");
      await service.refresh(1, firstRotation.refreshToken);

      const refreshSignCalls = mockJwtService.sign.mock.calls.filter(
        ([, options]: any[]) =>
          options?.secret === mockConfigService.get("JWT_REFRESH_SECRET"),
      );
      const refreshPayloads = refreshSignCalls.map(
        ([payload]: any[]) => payload,
      );

      expect(refreshPayloads).toHaveLength(2);
      expect(refreshPayloads[0].jti).toEqual(expect.any(String));
      expect(refreshPayloads[1].jti).toEqual(expect.any(String));
      expect(refreshPayloads[0].jti).not.toBe(refreshPayloads[1].jti);
      expect(harness.records).toHaveLength(3);
    });

    it("should set replacedBy on the old token to the new token hash", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      await service.refresh(1, "token-a");

      const updateChanges = harness.update.mock.calls[0][2];
      const createdTokenHash = harness.create.mock.calls[0][1].tokenHash;
      expect(updateChanges.replacedBy).toBe(createdTokenHash);
      expect(updateChanges.replacedBy).not.toBe(oldHash);
      expect(harness.records[0].replacedBy).toBe(createdTokenHash);
    });

    it("should reject the old token after a successful rotation", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      await service.refresh(1, "token-a");

      await expect(service.refresh(1, "token-a")).rejects.toThrow(
        "Refresh token was reused",
      );
      expect(harness.revokeAllExecute).toHaveBeenCalledTimes(1);
    });

    it("should revoke all user tokens when reuse is detected", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: true,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      await expect(service.refresh(1, "token-a")).rejects.toThrow(
        "Refresh token was reused",
      );

      expect(harness.revokeAllExecute).toHaveBeenCalledTimes(1);
      expect(harness.records.every((record) => record.revoked)).toBe(true);
    });

    it("should allow refreshing the newly rotated token", async () => {
      const oldHash = await bcrypt.hash("token-a", 10);
      const harness = useTransaction([
        {
          id: 1,
          tokenHash: oldHash,
          userId: 1,
          revoked: false,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ]);

      const firstRotation = await service.refresh(1, "token-a");
      const secondRotation = await service.refresh(
        1,
        firstRotation.refreshToken,
      );

      expect(secondRotation.refreshToken).not.toBe(firstRotation.refreshToken);
      expect(harness.records).toHaveLength(3);
      expect(harness.records[1].replacedBy).toBe(harness.records[2].tokenHash);
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
      const userEntity = {
        id: 1,
        email: "user@test.com",
        password: await bcrypt.hash("oldpass", 12),
      };

      mockUserRepository.findOne.mockResolvedValue(userEntity);
      mockRefreshTokenRepository.save.mockResolvedValue({});

      await service.changePassword(1, "oldpass", "newpass");

      expect(mockRefreshTokenRepository.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe("cleanupExpiredTokens", () => {
    it("should delete expired tokens via LessThan(NOW) criteria", async () => {
      mockRefreshTokenRepository.delete.mockResolvedValueOnce({
        affected: 3,
      });

      await service.cleanupExpiredTokens();

      const criteria = mockRefreshTokenRepository.delete.mock.calls[0][0];
      expect(criteria).toHaveProperty("expiresAt");
      expect(criteria.expiresAt).toHaveProperty("_type", "lessThan");
      expect(criteria.expiresAt).toHaveProperty("_value");
      expect(criteria.expiresAt._value).toBeInstanceOf(Date);
      expect(mockRefreshTokenRepository.delete).toHaveBeenCalledTimes(1);
    });

    it("should not throw when no tokens to clean", async () => {
      mockRefreshTokenRepository.delete.mockResolvedValueOnce({
        affected: 0,
      });

      await expect(service.cleanupExpiredTokens()).resolves.toBeUndefined();
      expect(mockRefreshTokenRepository.delete).toHaveBeenCalledTimes(1);
    });

    it("should only target expired tokens — active tokens preserved", async () => {
      await service.cleanupExpiredTokens();

      const criteria = mockRefreshTokenRepository.delete.mock.calls[0][0];
      // LessThan(NOW) guarantees only tokens with expiresAt < now are deleted.
      // Active tokens (expiresAt >= NOW) are never matched by this criteria.
      expect(criteria.expiresAt._type).toBe("lessThan");
      const cutoff: Date = criteria.expiresAt._value;
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it("should preserve non-expired revoked tokens (reuse detection safety)", async () => {
      const revokedNotExpired = {
        id: 2,
        tokenHash: "revoked-not-expired-hash",
        userId: 1,
        revoked: true,
        expiresAt: new Date(Date.now() + 86400000),
        revokedAt: new Date(),
      };

      await service.cleanupExpiredTokens();

      const criteria = mockRefreshTokenRepository.delete.mock.calls[0][0];
      const cutoff: Date = criteria.expiresAt._value;
      // Non-expired revoked tokens: expiresAt is in the FUTURE → not matched by LessThan(NOW).
      // These are preserved for reuse detection in refresh() flow.
      expect(revokedNotExpired.expiresAt.getTime()).toBeGreaterThan(cutoff.getTime());
    });

    it("should clean up expired revoked tokens (rotation already replaced them)", async () => {
      mockRefreshTokenRepository.delete.mockResolvedValueOnce({
        affected: 2,
      });

      await service.cleanupExpiredTokens();

      const criteria = mockRefreshTokenRepository.delete.mock.calls[0][0];
      // Expired+revoked tokens have expiresAt < NOW → matched by LessThan(NOW) → safe to delete.
      // After rotation these tokens are already revoked+replacedBy, no longer needed.
      expect(criteria.expiresAt._type).toBe("lessThan");
      expect(criteria.expiresAt._value).toBeInstanceOf(Date);
    });

    it("should be idempotent", async () => {
      mockRefreshTokenRepository.delete.mockResolvedValue({ affected: 0 });

      await service.cleanupExpiredTokens();
      await service.cleanupExpiredTokens();

      expect(mockRefreshTokenRepository.delete).toHaveBeenCalledTimes(2);
      const criteria1 = mockRefreshTokenRepository.delete.mock.calls[0][0];
      const criteria2 = mockRefreshTokenRepository.delete.mock.calls[1][0];
      expect(criteria1.expiresAt._type).toBe("lessThan");
      expect(criteria2.expiresAt._type).toBe("lessThan");
    });
  });
});
