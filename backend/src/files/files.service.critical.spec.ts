import { FilesService } from "./files.service";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { NotFoundException, ForbiddenException } from "@nestjs/common";

describe("FilesService - Critical Findings (F-01, F-02, MISS-01, MISS-02, MISS-03, MISS-04, F-10)", () => {
  let service: FilesService;
  let mockFileRepository: any;
  let mockFolderRepository: any;
  let mockStorageService: any;
  let mockUsersService: any;

  const createMockQueryRunner = () => ({
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      query: jest.fn(),
      save: jest.fn(),
    },
  });

  beforeEach(() => {
    const mockQueryRunner = createMockQueryRunner();

    mockFileRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => mockQueryRunner),
        },
      },
    };

    mockFolderRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => mockQueryRunner),
        },
      },
    };

    mockStorageService = {
      generateSafeFilename: jest.fn((name) => name),
      generatePath: jest.fn((userId, filename) => `/storage/${userId}/${filename}`),
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

  // ============================================================
  // Permanent Folder Deletion (MISS-01, MISS-02)
  // ============================================================
  describe("deleteFolderPermanently — MISS-01 (quota) + MISS-02 (subtree)", () => {
    it("should throw NotFoundException when folder does not exist", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue(null);

      await expect(service.deleteFolderPermanently(1, 1)).rejects.toThrow(NotFoundException);
    });

    it("should delete empty folder without decrementing storage", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Empty" });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find.mockResolvedValue([]);
      qr.manager.find.mockResolvedValue([]);

      await service.deleteFolderPermanently(1, 1);

      // totalSize=0 for empty folder, decrement called but early-returns in service
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 0, qr.manager);
      expect(qr.manager.delete).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should decrement storage by file size for folder with files", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Docs" });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      // Use mockResolvedValueOnce for the two find calls (descendant files + folder mirrors)
      qr.manager.find.mockResolvedValueOnce([
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: 1024, storagePath: "/storage/1/file.txt" },
      ]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.deleteFolderPermanently(1, 1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 1024, qr.manager);
      expect(qr.manager.delete).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should collect and delete all files in nested subtree", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      // CTE returns 2 folders (root + child)
      qr.manager.query.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      // First find: descendant files (isFolder: false)
      qr.manager.find.mockResolvedValueOnce([
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: 100, storagePath: "/s/1/a.txt" },
        { id: 20, userId: 1, parentId: 1, isFolder: false, size: 200, storagePath: "/s/1/b.txt" },
        { id: 30, userId: 1, parentId: 2, isFolder: false, size: 300, storagePath: "/s/2/c.txt" },
      ]);
      // Second find: folder mirror files (isFolder: true) - none in this case
      qr.manager.find.mockResolvedValueOnce([]);

      await service.deleteFolderPermanently(1, 1);

      // Total: 100 + 200 + 300 = 600
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 600, qr.manager);
      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(3);
      expect(qr.manager.delete).toHaveBeenCalled();
    });

    it("should delete all folder records in subtree", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      qr.manager.query.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.deleteFolderPermanently(1, 1);

      expect(qr.manager.delete).toHaveBeenCalledWith(FolderEntity, [1, 2]);
    });

    it("should not fail on missing storagePath", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find.mockResolvedValueOnce([
        { id: 10, parentId: 1, isFolder: false, size: 50, storagePath: null },
      ]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.deleteFolderPermanently(1, 1);

      expect(mockStorageService.fileExists).not.toHaveBeenCalled();
    });

    it("should rollback transaction on error", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.deleteFolderPermanently(1, 1)).rejects.toThrow("DB error");

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Permanent File Deletion (F-10)
  // ============================================================
  describe("deleteFilePermanently — F-10", () => {
    it("should delete file and decrement storage in transaction", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, name: "test.txt", size: 1024, storagePath: "/s/test.txt",
      });

      await service.deleteFilePermanently(1, 1);

      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/test.txt");
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 1024, qr.manager);
      expect(qr.manager.delete).toHaveBeenCalledWith(FileEntity, 1);
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should throw NotFoundException when file not found", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue(null);

      await expect(service.deleteFilePermanently(1, 999)).rejects.toThrow(NotFoundException);
    });

    it("should rollback on error", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, name: "test.txt", size: 100, storagePath: "/s/test.txt",
      });
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.deleteFilePermanently(1, 1)).rejects.toThrow("DB error");
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it("should handle zero-byte file", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, name: "empty.txt", size: 0, storagePath: "/s/empty.txt",
      });

      await service.deleteFilePermanently(1, 1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 0, qr.manager);
    });
  });

  // ============================================================
  // Empty Trash (MISS-04)
  // ============================================================
  describe("emptyTrash — MISS-04", () => {
    it("should decrement total size and delete all trashed items in transaction", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();

      qr.manager.find.mockResolvedValueOnce([
        { id: 1, userId: 1, isDeleted: true, isFolder: false, size: 100, storagePath: "/s/a.txt" },
        { id: 2, userId: 1, isDeleted: true, isFolder: false, size: 200, storagePath: "/s/b.txt" },
      ]);
      qr.manager.find.mockResolvedValueOnce([{ id: 10, userId: 1, isDeleted: true }]);

      await service.emptyTrash(1);

      // Total size: 100 + 200 = 300
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 300, qr.manager);
      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(2);
      expect(qr.manager.delete).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should rollback on error", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.find.mockResolvedValueOnce([
        { id: 1, userId: 1, isDeleted: true, isFolder: false, size: 50, storagePath: "/s/a.txt" },
      ]);
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.emptyTrash(1)).rejects.toThrow("DB error");
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it("should handle empty trash gracefully", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.emptyTrash(1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 0, qr.manager);
      expect(qr.manager.delete).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Authorization boundary tests (carried over from existing spec)
  // ============================================================
  describe("Authorization boundary", () => {
    it("should throw ForbiddenException when parent folder belongs to another user (createFile)", async () => {
      mockUsersService.findById.mockResolvedValue({ id: 1, storageQuota: 1000, storageUsed: 0 });
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.createFile(1, "test.txt", 100, "text/plain", 2)).rejects.toThrow(ForbiddenException);
    });

    it("should throw ForbiddenException when parent folder belongs to another user (createFolder)", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.createFolder(1, "New Folder", 2)).rejects.toThrow(ForbiddenException);
    });

    it("should throw ForbiddenException when moving file to folder owned by another user", async () => {
      const file = { id: 1, userId: 1, isFolder: false, name: "test.txt", storagePath: "/s/test.txt" };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.updateFile(1, 1, { parentId: 2 })).rejects.toThrow(ForbiddenException);
    });

    it("should throw ForbiddenException when moving folder to folder owned by another user", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      const file = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.id === 1 && where.userId === 1) return Promise.resolve(folder);
        return Promise.resolve(null);
      });
      mockFileRepository.findOne.mockResolvedValue(file);

      await expect(service.updateFolder(1, 1, { parentId: 2 })).rejects.toThrow(ForbiddenException);
    });
  });
});
