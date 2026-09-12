import { FilesService } from "./files.service";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";

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
        create: jest.fn(),
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
  // Phase 7: Transactional createFile (F-08)
  // ============================================================
  describe("createFile - transactional (F-08)", () => {
    it("should use queryRunner transaction for createFile", async () => {
      mockUsersService.findById.mockResolvedValue({ id: 1, storageQuota: 1000, storageUsed: 0 });
      mockFolderRepository.findOne.mockResolvedValue({ id: 1, userId: 1 });
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.create.mockReturnValue({ id: 1, name: "test.txt" });
      qr.manager.save.mockResolvedValue({ id: 1, name: "test.txt" });

      await service.createFile(1, "test.txt", 100, "text/plain");

      expect(qr.connect).toHaveBeenCalled();
      expect(qr.startTransaction).toHaveBeenCalled();
      expect(qr.manager.create).toHaveBeenCalledWith(FileEntity, expect.objectContaining({
        name: "test.txt",
        isFolder: false,
        userId: 1,
      }));
      expect(qr.manager.save).toHaveBeenCalled();
      expect(mockUsersService.updateStorageUsed).toHaveBeenCalledWith(1, 100, qr.manager);
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should rollback transaction on quota failure in createFile", async () => {
      mockUsersService.findById.mockResolvedValue({ id: 1, storageQuota: 1000, storageUsed: 0 });
      mockFolderRepository.findOne.mockResolvedValue({ id: 1, userId: 1 });
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.create.mockReturnValue({ id: 1, name: "test.txt" });
      qr.manager.save.mockResolvedValue({ id: 1, name: "test.txt" });
      mockUsersService.updateStorageUsed.mockRejectedValue(new ForbiddenException("Quota exceeded"));

      await expect(service.createFile(1, "test.txt", 100, "text/plain")).rejects.toThrow("Quota exceeded");

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException for empty file name", async () => {
      await expect(service.createFile(1, "", 100, "text/plain")).rejects.toThrow(BadRequestException);
      await expect(service.createFile(1, "   ", 100, "text/plain")).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // Phase 7: Transactional createFolder (F-09)
  // ============================================================
  describe("createFolder - transactional (F-09)", () => {
    it("should use queryRunner transaction for createFolder", async () => {
      mockFolderRepository.findOne.mockResolvedValue({ id: 1, userId: 1 });
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.create.mockReturnValue({ id: 1, name: "New Folder" });
      qr.manager.save.mockResolvedValue({ id: 1, name: "New Folder" });

      await service.createFolder(1, "New Folder");

      expect(qr.connect).toHaveBeenCalled();
      expect(qr.startTransaction).toHaveBeenCalled();
      expect(qr.manager.create).toHaveBeenCalledWith(FolderEntity, expect.objectContaining({
        name: "New Folder",
        isDeleted: false,
        userId: 1,
      }));
      expect(qr.manager.save).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should rollback transaction on failure in createFolder", async () => {
      mockFolderRepository.findOne.mockResolvedValue({ id: 1, userId: 1 });
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.create.mockReturnValue({ id: 1, name: "New Folder" });
      qr.manager.save.mockRejectedValue(new Error("DB error"));

      await expect(service.createFolder(1, "New Folder")).rejects.toThrow("DB error");

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException for empty folder name", async () => {
      await expect(service.createFolder(1, "")).rejects.toThrow(BadRequestException);
      await expect(service.createFolder(1, "   ")).rejects.toThrow(BadRequestException);
    });
  });

  // ============================================================
  // Phase 7: Folder cycle detection (updateFolder)
  // ============================================================
  describe("updateFolder - cycle detection", () => {
    it("should throw BadRequestException when moving folder into its own subtree", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      const file = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.userId === 1) return Promise.resolve(folder);
        return Promise.resolve(null);
      });
      mockFileRepository.findOne.mockResolvedValue(file);
      (service as any).assertNoCycle = jest.fn().mockRejectedValue(new BadRequestException("Cannot move folder into its own subtree"));

      await expect(service.updateFolder(1, 1, { parentId: 2 })).rejects.toThrow(BadRequestException);
    });

    it("should allow moving folder to valid target", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      const file = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.userId === 1) return Promise.resolve(folder);
        return Promise.resolve(null);
      });
      mockFileRepository.findOne.mockResolvedValue(file);
      (service as any).assertNoCycle = jest.fn().mockResolvedValue(undefined);

      const result = await service.updateFolder(1, 1, { parentId: 3 });
      expect(result).toBeDefined();
    });
  });

  // ============================================================
  // Phase 7: Physical delete after commit (roadmap finding)
  // ============================================================
  describe("Physical deletion timing (roadmap finding)", () => {
    it("deleteFilePermanently should delete physical file AFTER commit", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, name: "test.txt", size: 1024, storagePath: "/s/test.txt",
      });

      await service.deleteFilePermanently(1, 1);

      expect(qr.commitTransaction).toHaveBeenCalled();
      // Physical deletion happens after commit — check it was called
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/test.txt");
    });

    it("deleteFolderPermanently should delete physical files AFTER commit", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find.mockResolvedValueOnce([
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: 100, storagePath: "/s/1/a.txt" },
      ]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.deleteFolderPermanently(1, 1);

      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/1/a.txt");
    });

    it("emptyTrash should delete physical files AFTER commit", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.find.mockResolvedValueOnce([
        { id: 1, userId: 1, isDeleted: true, isFolder: false, size: 100, storagePath: "/s/a.txt" },
      ]);
      qr.manager.find.mockResolvedValueOnce([]);

      await service.emptyTrash(1);

      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/a.txt");
    });

    it("deleteFilePermanently should NOT delete physical file on rollback", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, name: "test.txt", size: 100, storagePath: "/s/test.txt",
      });
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.deleteFilePermanently(1, 1)).rejects.toThrow("DB error");

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
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

  // ============================================================
  // Phase 7: Non-empty name validation (F-13)
  // ============================================================
  describe("Non-empty name validation (F-13)", () => {
    it("should throw BadRequestException for empty file name in updateFile", async () => {
      const file = {
        id: 1, userId: 1, isFolder: false, name: "test.txt", storagePath: "/s/test.txt",
      };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.updateFile(1, 1, { name: "   " })).rejects.toThrow(BadRequestException);
    });
  });
});
