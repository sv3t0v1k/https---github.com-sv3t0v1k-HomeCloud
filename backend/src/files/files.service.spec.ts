import { FilesService } from "./files.service";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { NotFoundException, ForbiddenException } from "@nestjs/common";

describe("FilesService - Authorization Boundary", () => {
  let service: FilesService;
  let mockFileRepository: any;
  let mockFolderRepository: any;
  let mockStorageService: any;
  let mockUsersService: any;

  beforeEach(() => {
    mockFileRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn(),
        getOne: jest.fn(),
      })),
    };
    mockFolderRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    };
    mockStorageService = {
      generateSafeFilename: jest.fn((name) => name),
      generatePath: jest.fn(
        (userId, filename) => `/storage/${userId}/${filename}`,
      ),
      fileExists: jest.fn(() => true),
      deleteFile: jest.fn(),
      getStoragePath: jest.fn(() => "/storage"),
    };
    mockUsersService = {
      findById: jest.fn(),
      updateStorageUsed: jest.fn(),
      decrementStorageUsed: jest.fn(),
    };

    service = new FilesService(
      mockFileRepository,
      mockFolderRepository,
      mockStorageService,
      mockUsersService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("findOne", () => {
    it("should return file when it belongs to user", async () => {
      const file = { id: 1, userId: 1, name: "test.txt" };
      mockFileRepository.findOne.mockResolvedValue(file);

      const result = await service.findOne(1, 1);
      expect(result).toEqual(file);
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1, userId: 1 },
      });
    });

    it("should throw NotFoundException when file belongs to another user", async () => {
      mockFileRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(1, 2)).rejects.toThrow(NotFoundException);
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("findFolder", () => {
    it("should return folder when it belongs to user", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockResolvedValue(folder);

      const result = await service.findFolder(1, 1);
      expect(result).toEqual(folder);
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1, userId: 1 },
      });
    });

    it("should throw NotFoundException when folder belongs to another user", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.findFolder(1, 2)).rejects.toThrow(NotFoundException);
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("createFile", () => {
    it("should throw ForbiddenException when parent folder belongs to another user", async () => {
      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1000,
        storageUsed: 0,
      });
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createFile(1, "test.txt", 100, "text/plain", 2),
      ).rejects.toThrow(ForbiddenException);
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("createFolder", () => {
    it("should throw ForbiddenException when parent folder belongs to another user", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.createFolder(1, "New Folder", 2)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("updateFile", () => {
    it("should throw ForbiddenException when moving file to folder owned by another user", async () => {
      const file = {
        id: 1,
        userId: 1,
        isFolder: false,
        name: "test.txt",
        storagePath: "/storage/1/test.txt",
      };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.updateFile(1, 1, { parentId: 2 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("updateFolder", () => {
    it("should throw ForbiddenException when moving folder to folder owned by another user", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      const file = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.id === 1 && where.userId === 1)
          return Promise.resolve(folder);
        return Promise.resolve(null);
      });
      mockFileRepository.findOne.mockResolvedValue(file);

      await expect(service.updateFolder(1, 1, { parentId: 2 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("moveFile", () => {
    it("should throw ForbiddenException when moving file to folder owned by another user", async () => {
      const file = { id: 1, userId: 1, name: "test.txt" };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.moveFile(1, 1, 2)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });

  describe("copyFile", () => {
    it("should throw ForbiddenException when copying file to folder owned by another user", async () => {
      const source = {
        id: 1,
        userId: 1,
        name: "test.txt",
        size: 100,
        mimeType: "text/plain",
        storagePath: "/storage/1/test.txt",
      };
      mockFileRepository.findOne.mockResolvedValue(source);
      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1000,
        storageUsed: 0,
      });
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.copyFile(1, 1, 2)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });
  });
});
