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
      manager: {
        connection: {
          createQueryRunner: jest.fn(() => mockQueryRunner),
        },
      },
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
    let mockQueryRunner: any;

    beforeEach(() => {
      mockQueryRunner = {
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
      };
      mockFolderRepository.manager.connection.createQueryRunner.mockReturnValue(
        mockQueryRunner,
      );
      mockFileRepository.manager.connection.createQueryRunner.mockReturnValue(
        mockQueryRunner,
      );
    });

    it("should throw ForbiddenException when parent folder belongs to another user", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.createFolder(1, "New Folder", 2)).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
    });

    it("should set folderId on the folder mirror FileEntity", async () => {
      const folder = { id: 5, userId: 1, name: "New Folder" };
      const createdMirror = {
        id: 9,
        name: "New Folder",
        isFolder: true,
        isDeleted: false,
        parentId: null,
        folderId: 5,
        userId: 1,
        version: 1,
      };
      mockFolderRepository.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.create.mockImplementation((entity: any, data: any) => {
        if (entity === FolderEntity) return folder;
        return { ...createdMirror, ...data };
      });
      mockQueryRunner.manager.save.mockResolvedValue(createdMirror);

      const result = await service.createFolder(1, "New Folder");

      const fileCreateCall = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) => c[0] === FileEntity,
      );
      expect(fileCreateCall).toBeDefined();
      expect(fileCreateCall[1]).toMatchObject({
        isFolder: true,
        folderId: 5,
        userId: 1,
      });
      expect(result.folderId).toBe(5);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("should NOT set folderId on ordinary files created via createFile", async () => {
      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1000,
        storageUsed: 0,
      });
      mockFolderRepository.findOne.mockResolvedValue(null);
      const createdFile = {
        id: 11,
        name: "test.txt",
        isFolder: false,
        folderId: null,
        userId: 1,
        size: 100,
        mimeType: "text/plain",
        parentId: null,
      };
      mockQueryRunner.manager.create.mockImplementation((entity: any, data: any) => {
        return { ...createdFile, ...data };
      });
      mockQueryRunner.manager.save.mockResolvedValue(createdFile);

      const result = await service.createFile(
        1,
        "test.txt",
        100,
        "text/plain",
      );

      const fileCreateCall = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) => c[0] === FileEntity,
      );
      expect(fileCreateCall[1]).toMatchObject({
        isFolder: false,
      });
      expect(fileCreateCall[1].folderId).toBeUndefined();
      expect(result.folderId).toBeNull();
    });

    it("keeps mirror linkage independent of intervening createFile calls", async () => {
      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1000,
        storageUsed: 0,
      });
      mockFolderRepository.findOne.mockResolvedValue(null);

      const createdMirrors: any[] = [];
      mockQueryRunner.manager.create.mockImplementation((entity: any, data: any) => {
        if (entity === FolderEntity) return { id: data.name === "A" ? 10 : 11, userId: 1, name: data.name };
        createdMirrors.push(data);
        return { id: data.name === "A" ? 100 : 101, ...data };
      });
      mockQueryRunner.manager.save.mockImplementation((obj: any) => Promise.resolve(obj));

      // First createFolder
      await service.createFolder(1, "A");
      // Intervening createFile
      await service.createFile(1, "plain.txt", 10, "text/plain");
      // Second createFolder
      const result = await service.createFolder(1, "B");

      const folderMirrors = createdMirrors.filter((d) => d.isFolder === true);
      expect(folderMirrors).toHaveLength(2);
      expect(folderMirrors[0].folderId).toBe(10);
      expect(folderMirrors[1].folderId).toBe(11);
      expect(result.folderId).toBe(11);
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
