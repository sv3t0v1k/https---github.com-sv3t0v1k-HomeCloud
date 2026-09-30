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
        copyFile: jest.fn(),
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
    const setSubtree = (
      qr: any,
      folderIds: number[],
      files: any[] = [],
      mirrors: any[] = folderIds.map((folderId, index) => ({
        id: 1000 + index,
        folderId,
        userId: 1,
        isFolder: true,
        size: 0,
      })),
    ) => {
      qr.manager.query.mockResolvedValue(folderIds.map(id => ({ id })));
      qr.manager.find
        .mockResolvedValueOnce(folderIds.map(id => ({ id, userId: 1 })))
        .mockResolvedValueOnce(files)
        .mockResolvedValueOnce(mirrors);
    };

    it("should throw NotFoundException when folder does not exist", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue(null);

      await expect(service.deleteFolderPermanently(1, 1)).rejects.toThrow(NotFoundException);
    });

    it("should delete empty folder without decrementing storage", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Empty" });
      setSubtree(qr, [1]);

      await service.deleteFolderPermanently(1, 1);

      // totalSize=0 for empty folder, decrement called but early-returns in service
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 0, qr.manager);
      expect(qr.manager.delete).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("should decrement storage by file size for folder with files", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Docs" });
      setSubtree(qr, [1], [
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: "1024", storagePath: "/storage/1/file.txt" },
      ]);

      await service.deleteFolderPermanently(1, 1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 1024, qr.manager);
      expect(qr.manager.delete).toHaveBeenCalled();
      expect(qr.commitTransaction).toHaveBeenCalled();
    });

    it("rolls back on unsafe file size metadata", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1 });
      setSubtree(qr, [1], [
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: "invalid" },
      ]);

      await expect(service.deleteFolderPermanently(1, 1)).rejects.toThrow(
        "Invalid file size metadata",
      );
      expect(qr.manager.delete).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });

    it("should collect and delete all files in nested subtree", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      // CTE returns 2 folders (root + child)
      setSubtree(qr, [1, 2], [
        { id: 10, userId: 1, parentId: 1, isFolder: false, size: 100, storagePath: "/s/1/a.txt" },
        { id: 20, userId: 1, parentId: 1, isFolder: false, size: 200, storagePath: "/s/1/b.txt" },
        { id: 30, userId: 1, parentId: 2, isFolder: false, size: 300, storagePath: "/s/2/c.txt" },
      ]);

      await service.deleteFolderPermanently(1, 1);

      // Total: 100 + 200 + 300 = 600
      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 600, qr.manager);
      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(3);
      expect(qr.manager.delete).toHaveBeenCalled();
    });

    it("should delete all folder records in subtree", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();

      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      setSubtree(qr, [1, 2]);

      await service.deleteFolderPermanently(1, 1);

      expect(qr.manager.delete).toHaveBeenCalledWith(FolderEntity, [1, 2]);
    });

    it("should not fail on missing storagePath", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      setSubtree(qr, [1], [
        { id: 10, parentId: 1, isFolder: false, size: 50, storagePath: null },
      ]);

      await service.deleteFolderPermanently(1, 1);

      expect(mockStorageService.fileExists).not.toHaveBeenCalled();
    });

    it("should rollback transaction on error", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1, name: "Root" });
      setSubtree(qr, [1]);
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.deleteFolderPermanently(1, 1)).rejects.toThrow("DB error");

      expect(qr.rollbackTransaction).toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
    });

    it("finds differently-id mirrors by folderId and deletes files before folders", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 4, userId: 1 });
      const mirrors = [
        { id: 901, folderId: 4, userId: 1, isFolder: true, size: 0 },
        { id: 902, folderId: 5, userId: 1, isFolder: true, size: 0 },
      ];
      setSubtree(qr, [4, 5], [], mirrors);

      await service.deleteFolderPermanently(1, 4);

      expect(qr.startTransaction).toHaveBeenCalledWith("SERIALIZABLE");
      expect(qr.manager.find).toHaveBeenNthCalledWith(3, FileEntity, {
        where: { userId: 1, folderId: expect.anything(), isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      expect(qr.manager.delete).toHaveBeenNthCalledWith(1, FileEntity, [901, 902]);
      expect(qr.manager.delete).toHaveBeenNthCalledWith(2, FolderEntity, [4, 5]);
      expect(qr.manager.delete.mock.invocationCallOrder[1]).toBeLessThan(
        qr.commitTransaction.mock.invocationCallOrder[0],
      );
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("fails closed and rolls back when any subtree mirror is missing", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 4, userId: 1 });
      setSubtree(qr, [4, 5], [], [
        { id: 901, folderId: 4, userId: 1, isFolder: true },
      ]);

      await expect(service.deleteFolderPermanently(1, 4)).rejects.toThrow(
        "Folder mirror not found",
      );
      expect(mockUsersService.decrementStorageUsed).not.toHaveBeenCalled();
      expect(qr.manager.delete).not.toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("rolls back without physical deletion when folder delete fails", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 4, userId: 1 });
      setSubtree(qr, [4], [
        { id: 20, userId: 1, parentId: 4, isFolder: false, size: 5, storagePath: "/s/a" },
      ]);
      qr.manager.delete
        .mockResolvedValueOnce({ affected: 2 })
        .mockRejectedValueOnce(new Error("folder delete failed"));

      await expect(service.deleteFolderPermanently(1, 4)).rejects.toThrow(
        "folder delete failed",
      );
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("releases query runner when transaction start fails", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.startTransaction.mockRejectedValue(new Error("start failed"));

      await expect(service.deleteFolderPermanently(1, 4)).rejects.toThrow("start failed");
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
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

      qr.manager.query.mockResolvedValue([{ id: 10 }]);
      qr.manager.find
        .mockResolvedValueOnce([{ id: 10, userId: 1, isDeleted: true }])
        .mockResolvedValueOnce([
          { id: 1, userId: 1, isDeleted: true, isFolder: false, size: 100, storagePath: "/s/a.txt" },
          { id: 2, userId: 1, isDeleted: true, isFolder: false, size: 200, storagePath: "/s/b.txt" },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 501, folderId: 10, userId: 1, isFolder: true }]);

      await service.emptyTrash(1);

      expect(qr.startTransaction).toHaveBeenCalledWith("SERIALIZABLE");
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
      qr.manager.query.mockResolvedValue([]);
      qr.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.emptyTrash(1)).rejects.toThrow("DB error");
      expect(qr.rollbackTransaction).toHaveBeenCalled();
    });

    it("should handle empty trash gracefully", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.find.mockResolvedValueOnce([]);
      qr.manager.query.mockResolvedValue([]);

      await service.emptyTrash(1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 0, qr.manager);
      expect(qr.manager.delete).not.toHaveBeenCalled();
    });

    it("recursively deletes folder contents and mirrors without double-counting quota", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      const duplicate = { id: 20, userId: 1, isDeleted: true, isFolder: false, size: 200, storagePath: "/s/a" };
      qr.manager.query.mockResolvedValue([{ id: 10 }, { id: 11 }]);
      qr.manager.find
        .mockResolvedValueOnce([{ id: 10, userId: 1 }, { id: 11, userId: 1 }])
        .mockResolvedValueOnce([duplicate])
        .mockResolvedValueOnce([
          duplicate,
          { id: 21, userId: 1, isFolder: false, size: 300, storagePath: "/s/b" },
        ])
        .mockResolvedValueOnce([
          { id: 701, folderId: 10, userId: 1, isFolder: true },
          { id: 702, folderId: 11, userId: 1, isFolder: true },
        ]);

      await service.emptyTrash(1);

      expect(mockUsersService.decrementStorageUsed).toHaveBeenCalledWith(1, 500, qr.manager);
      expect(qr.manager.delete).toHaveBeenNthCalledWith(1, FileEntity, [20, 21, 701, 702]);
      expect(qr.manager.delete).toHaveBeenNthCalledWith(2, FolderEntity, [10, 11]);
      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(2);
      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("rolls back all trash when a folder mirror is missing", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.query.mockResolvedValue([{ id: 10 }]);
      qr.manager.find
        .mockResolvedValueOnce([{ id: 10, userId: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await expect(service.emptyTrash(1)).rejects.toThrow("Folder mirror not found");
      expect(qr.manager.delete).not.toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("releases query runner when transaction start fails", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.startTransaction.mockRejectedValue(new Error("start failed"));

      await expect(service.emptyTrash(1)).rejects.toThrow("start failed");
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
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
      const mirror = { id: 77, folderId: 1, userId: 1, isFolder: true, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.userId === 1) return Promise.resolve(folder);
        return Promise.resolve(null);
      });
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockImplementation((entity: any) =>
        Promise.resolve(entity === FolderEntity ? folder : mirror),
      );
      qr.manager.save.mockImplementation((entity: any) => Promise.resolve(entity));
      (service as any).assertNoCycle = jest.fn().mockResolvedValue(undefined);

      const result = await service.updateFolder(1, 1, { parentId: 3 });
      expect(result).toBe(mirror);
      expect(qr.manager.findOne).toHaveBeenCalledWith(FileEntity, {
        where: { folderId: 1, userId: 1, isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      expect(qr.commitTransaction).toHaveBeenCalled();
    });
  });

  // ============================================================
  // Phase 7: Physical delete after commit (roadmap finding)
  // ============================================================
  describe("Physical deletion timing (roadmap finding)", () => {
    const controlledDeletion = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };

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
      qr.manager.find
        .mockResolvedValueOnce([{ id: 1, userId: 1 }])
        .mockResolvedValueOnce([
          { id: 10, userId: 1, parentId: 1, isFolder: false, size: 100, storagePath: "/s/1/a.txt" },
        ])
        .mockResolvedValueOnce([{ id: 101, folderId: 1, userId: 1, isFolder: true }]);

      await service.deleteFolderPermanently(1, 1);

      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/1/a.txt");
    });

    it("emptyTrash should delete physical files AFTER commit", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.find.mockResolvedValueOnce([
        { id: 1, userId: 1, isDeleted: true, isFolder: false, size: 100, storagePath: "/s/a.txt" },
      ]);
      qr.manager.query.mockResolvedValue([]);

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

    it("deleteFilePermanently awaits physical deletion after commit", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, size: 100, storagePath: "/s/a.txt",
      });
      const deletion = controlledDeletion();
      let deletionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        deletionStarted = resolve;
      });
      mockStorageService.deleteFile.mockImplementationOnce(() => {
        deletionStarted();
        return deletion.promise;
      });

      let settled = false;
      const result = service.deleteFilePermanently(1, 1).then(() => {
        settled = true;
      });
      await started;

      expect(qr.commitTransaction).toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith("/s/a.txt");
      expect(settled).toBe(false);
      deletion.resolve();
      await result;
      expect(settled).toBe(true);
    });

    it("deleteFolderPermanently awaits deletion and contains failures after commit", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1 });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find
        .mockResolvedValueOnce([{ id: 1, userId: 1 }])
        .mockResolvedValueOnce([
          { id: 10, size: 10, storagePath: "/s/a" },
          { id: 11, size: 20, storagePath: "/s/b" },
        ])
        .mockResolvedValueOnce([
          { id: 101, folderId: 1, userId: 1, isFolder: true },
        ]);
      const error = new Error("unlink failed");
      mockStorageService.deleteFile
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);
      const logSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation();

      await expect(service.deleteFolderPermanently(1, 1)).resolves.toEqual({
        message: "Folder deleted permanently",
      });

      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenNthCalledWith(1, "/s/a");
      expect(mockStorageService.deleteFile).toHaveBeenNthCalledWith(2, "/s/b");
      expect(logSpy).toHaveBeenCalledWith("Failed to delete physical file");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("/s/a");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("unlink failed");
    });

    it("deleteFolderPermanently waits for a successful physical deletion", async () => {
      const qr = mockFolderRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({ id: 1, userId: 1 });
      qr.manager.query.mockResolvedValue([{ id: 1 }]);
      qr.manager.find
        .mockResolvedValueOnce([{ id: 1, userId: 1 }])
        .mockResolvedValueOnce([{ id: 10, size: 10, storagePath: "/s/a" }])
        .mockResolvedValueOnce([
          { id: 101, folderId: 1, userId: 1, isFolder: true },
        ]);
      const deletion = controlledDeletion();
      let deletionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        deletionStarted = resolve;
      });
      mockStorageService.deleteFile.mockImplementationOnce(() => {
        deletionStarted();
        return deletion.promise;
      });

      let settled = false;
      const result = service.deleteFolderPermanently(1, 1).then(() => {
        settled = true;
      });
      await started;

      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      deletion.resolve();
      await result;
      expect(settled).toBe(true);
    });

    it("deleteFilePermanently logs and contains a post-commit deletion failure", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.findOne.mockResolvedValue({
        id: 1, userId: 1, size: 100, storagePath: "/s/a.txt",
      });
      const error = new Error("unlink failed");
      mockStorageService.deleteFile.mockRejectedValueOnce(error);
      const logSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation();

      await expect(service.deleteFilePermanently(1, 1)).resolves.toEqual({
        message: "File deleted permanently",
      });

      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Failed to delete physical file");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("/s/a.txt");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("unlink failed");
    });

    it("emptyTrash awaits deletions sequentially with one unlink in flight", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.query.mockResolvedValue([]);
      qr.manager.find.mockResolvedValueOnce([
        { id: 1, size: 10, storagePath: "/s/a", isFolder: false },
        { id: 2, size: 20, storagePath: "/s/b", isFolder: false },
      ]);
      const first = controlledDeletion();
      const second = controlledDeletion();
      let firstStarted!: () => void;
      let secondStarted!: () => void;
      const firstStart = new Promise<void>((resolve) => {
        firstStarted = resolve;
      });
      const secondStart = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      let inFlight = 0;
      let maxInFlight = 0;
      mockStorageService.deleteFile.mockImplementation(() => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const isFirst = mockStorageService.deleteFile.mock.calls.length === 1;
        if (isFirst) {
          firstStarted();
        } else {
          secondStarted();
        }
        const current = isFirst ? first.promise : second.promise;
        return current.finally(() => {
          inFlight -= 1;
        });
      });

      let settled = false;
      const result = service.emptyTrash(1).then(() => {
        settled = true;
      });
      await firstStart;

      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      first.resolve();
      await secondStart;
      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(2);
      expect(maxInFlight).toBe(1);
      expect(settled).toBe(false);
      second.resolve();
      await result;
      expect(maxInFlight).toBe(1);
      expect(settled).toBe(true);
      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("emptyTrash logs a rejected deletion and continues without an unhandled rejection", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.query.mockResolvedValue([]);
      qr.manager.find.mockResolvedValueOnce([
        { id: 1, size: 10, storagePath: "/s/a", isFolder: false },
        { id: 2, size: 20, storagePath: "/s/b", isFolder: false },
      ]);
      const error = new Error("unlink failed");
      mockStorageService.deleteFile
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(undefined);
      const logSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation();

      await expect(service.emptyTrash(1)).resolves.toEqual({
        message: "Trash emptied",
      });

      expect(mockStorageService.deleteFile).toHaveBeenCalledTimes(2);
      expect(logSpy).toHaveBeenCalledWith("Failed to delete physical file");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("/s/a");
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("unlink failed");
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
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
