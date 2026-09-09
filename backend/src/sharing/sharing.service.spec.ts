import { SharingService } from "./sharing.service";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { FileEntity } from "../entities/file.entity";
import { UserEntity } from "../entities/user.entity";
import { NotFoundException, BadRequestException } from "@nestjs/common";

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
  });
});
