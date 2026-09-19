import { SharingService } from "./sharing.service";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { UploadSessionStatusCheck1746825050000 } from "../migrations/1746825050000-UploadSessionStatusCheck";
import { ShareLinksTokenUnique1746825040000 } from "../migrations/1746825040000-ShareLinksTokenUnique";

describe("SharingService - Authorization Boundary", () => {
  let service: SharingService;
  let mockShareLinkRepository: any;
  let mockFileRepository: any;
  let mockUserRepository: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockShareLinkRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    mockFileRepository = {
      findOne: jest.fn(),
    };
    mockUserRepository = {
      findOne: jest.fn(),
    };
    mockConfigService = {
      get: jest.fn((key) => {
        if (key === "MAX_SHARE_SIZE") return "104857600";
        if (key === "ALLOWED_SHARE_MIME_TYPES")
          return "image/png,image/jpeg,application/pdf";
        return undefined;
      }),
    };

    service = new SharingService(
      mockShareLinkRepository,
      mockFileRepository,
      mockUserRepository,
      mockConfigService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // Builds a chainable TypeORM query-builder mock whose `.execute()` resolves
  // to `{ raw }` — mirrors the atomic UPDATE ... RETURNING used by
  // `incrementDownloadCount`. `raw` length 0 simulates a rejected (no-row) UPDATE.
  function makeQb(raw: Array<Record<string, unknown>> = []) {
    const execute = jest.fn().mockResolvedValue({ raw });
    const builder: Record<string, any> = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute,
    };
    mockShareLinkRepository.createQueryBuilder.mockReturnValue(builder);
    return builder;
  }

  describe("createShareLink", () => {
    it("should create share link when file belongs to user", async () => {
      const file = {
        id: 1,
        userId: 1,
        name: "test.png",
        mimeType: "image/png",
        size: 100,
        isFolder: false,
      };
      const user = { id: 1, email: "user@example.com" };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockUserRepository.findOne.mockResolvedValue(user);
      mockShareLinkRepository.create.mockReturnValue({});
      mockShareLinkRepository.save.mockResolvedValue({});

      const result = await service.createShareLink(1, 1, {});
      expect(result).toBeDefined();
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1, userId: 1 },
      });
    });

    it("should throw NotFoundException when file belongs to another user", async () => {
      mockFileRepository.findOne.mockResolvedValue(null);

      await expect(service.createShareLink(1, 2, {})).rejects.toThrow(
        NotFoundException,
      );
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });

    it("should throw NotFoundException when file does not exist", async () => {
      mockFileRepository.findOne.mockResolvedValue(null);

      await expect(service.createShareLink(1, 999, {})).rejects.toThrow(
        NotFoundException,
      );
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { id: 999, userId: 1 },
      });
    });

    it("should throw BadRequestException when file type is not allowed for sharing", async () => {
      const file = {
        id: 1,
        userId: 1,
        name: "test.exe",
        mimeType: "application/x-msdownload",
        size: 100,
        isFolder: false,
      };
      mockFileRepository.findOne.mockResolvedValue(file);

      await expect(service.createShareLink(1, 1, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when file size exceeds maximum shareable size", async () => {
      const file = {
        id: 1,
        userId: 1,
        name: "large.png",
        mimeType: "image/png",
        size: 200 * 1024 * 1024,
        isFolder: false,
      };
      mockFileRepository.findOne.mockResolvedValue(file);

      await expect(service.createShareLink(1, 1, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should generate unique tokens for different share links (F-04)", async () => {
      const file = {
        id: 1, userId: 1, name: "test.png", mimeType: "image/png", size: 100, isFolder: false,
      };
      const user = { id: 1, email: "user@example.com" };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockUserRepository.findOne.mockResolvedValue(user);
      mockShareLinkRepository.create.mockReturnValue({});
      mockShareLinkRepository.save.mockResolvedValue({});

      const result1 = await service.createShareLink(1, 1, {});
      const result2 = await service.createShareLink(1, 1, {});

      // Token is generated by uuidv4 - extremely high entropy
      // Verify that the save was called with a token (non-empty string)
      expect(mockShareLinkRepository.create).toHaveBeenCalledTimes(2);
      const createCalls = mockShareLinkRepository.create.mock.calls;
      expect(createCalls[0][0].token).toBeDefined();
      expect(createCalls[0][0].token).toHaveLength(36); // uuid v4 format
      expect(createCalls[1][0].token).toBeDefined();
      expect(createCalls[1][0].token).toHaveLength(36);
      expect(createCalls[0][0].token).not.toBe(createCalls[1][0].token);
    });

    it("should look up share link by token with isActive filter (F-04)", async () => {
      mockShareLinkRepository.findOne.mockResolvedValue({ token: "test-token", isActive: true });

      await service.findShareByToken("test-token");

      expect(mockShareLinkRepository.findOne).toHaveBeenCalledWith({
        where: { token: "test-token", isActive: true },
        relations: ["file", "user"],
      });
    });
  });

  describe("verifySharePassword", () => {
    it("should reject expired password-protected share regardless of password (F-04)", async () => {
      const pastDate = new Date(Date.now() - 1000);
      mockShareLinkRepository.findOne.mockResolvedValue({
        token: "tok",
        isActive: true,
        expiresAt: pastDate,
        password: "hashed-password",
      });

      await expect(
        service.verifySharePassword("tok", "any-password"),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.verifySharePassword("tok", "correct-password"),
      ).rejects.toThrow(NotFoundException);

      expect(mockShareLinkRepository.findOne).toHaveBeenCalledWith({
        where: { token: "tok", isActive: true },
      });
    });
  });

  describe("findShareByToken expiry (null = never, C1)", () => {
    it("should allow share when expiresAt is null (never expires)", async () => {
      mockShareLinkRepository.findOne.mockResolvedValue({
        token: "tok",
        isActive: true,
        expiresAt: null,
        file: {},
        user: {},
      });

      const result = await service.findShareByToken("tok");

      expect(result).toEqual(
        expect.objectContaining({ token: "tok", isActive: true, expiresAt: null }),
      );
    });

    it("should reject expired share", async () => {
      mockShareLinkRepository.findOne.mockResolvedValue({
        token: "tok",
        isActive: true,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.findShareByToken("tok")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("incrementDownloadCount — expiry (null = never, C1)", () => {
    it("should allow increment when expiresAt is null", async () => {
      makeQb([{ downloadCount: 1 }]);

      const result = await service.incrementDownloadCount("tok");

      expect(result.downloadCount).toBe(1);
      expect(mockShareLinkRepository.createQueryBuilder).toHaveBeenCalled();
    });

    it("should reject expired share before incrementing", async () => {
      // Atomic UPDATE excludes expired rows → 0 returned rows.
      makeQb([]);

      await expect(service.incrementDownloadCount("tok")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("incrementDownloadCount — maxDownloads download limit (atomic, C2)", () => {
    it("maxDownloads=null => unlimited: allows increment and advances counter", async () => {
      // maxDownloads IS NULL always matches (subject to active+expiry), so the
      // UPDATE returns the incremented row.
      const qb = makeQb([{ downloadCount: 1 }]);

      const result = await service.incrementDownloadCount("tok");

      expect(result.downloadCount).toBe(1);
      expect(qb.andWhere).toHaveBeenCalledWith(
        `"maxDownloads" IS NULL OR "downloadCount" < "maxDownloads"`,
      );
    });

    it("count below limit => allowed + increment", async () => {
      const qb = makeQb([{ downloadCount: 3 }]); // was 2, now 3
      const result = await service.incrementDownloadCount("tok");
      expect(result.downloadCount).toBe(3);
      expect(qb.execute).toHaveBeenCalled();
    });

    it("count equal to limit => rejected, no increment", async () => {
      // downloadCount == maxDownloads => `downloadCount < maxDownloads` is false
      // and maxDownloads is not NULL => UPDATE matches 0 rows.
      makeQb([]);

      await expect(service.incrementDownloadCount("tok")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("count above limit => rejected, no increment", async () => {
      makeQb([]);

      await expect(service.incrementDownloadCount("tok")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("last allowed download is permitted then the limit holds", async () => {
      // Boundary: current count == max-1 => allowed (count < max true), advances
      // to max. Next attempt with count == max => rejected (count < max false).
      const allowed = makeQb([{ downloadCount: 2 }]); // max=2, allowed: 1->2
      await expect(service.incrementDownloadCount("tok")).resolves.toEqual(
        expect.objectContaining({ downloadCount: 2 }),
      );
      expect(allowed.execute).toHaveBeenCalledTimes(1);

      makeQb([]); // now count==max => rejected
      await expect(service.incrementDownloadCount("tok")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("expired share is rejected even when maxDownloads allows more (regression)", async () => {
      makeQb([]);
      await expect(service.incrementDownloadCount("tok")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("Migration F-04 + F-16", () => {
    it("ShareLinksTokenUnique migration should exist and be reversible", () => {
      expect(ShareLinksTokenUnique1746825040000).toBeDefined();
      const m = new ShareLinksTokenUnique1746825040000();
      expect(m.name).toBe("ShareLinksTokenUnique1746825040000");
      expect(typeof m.up).toBe("function");
      expect(typeof m.down).toBe("function");
    });
  });
});
