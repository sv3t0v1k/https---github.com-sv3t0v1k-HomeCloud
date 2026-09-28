import { FilesService } from "./files.service";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";

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
      createQueryBuilder: jest.fn(),
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
      mockFileRepository.findOne.mockResolvedValue({ id: 81, folderId: 1 });

      const result = await service.findFolder(1, 1);
      expect(result).toEqual({ ...folder, shareFileId: 81 });
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1, userId: 1, isDeleted: false },
      });
      expect(mockFileRepository.findOne).toHaveBeenCalledWith({
        where: { folderId: 1, userId: 1, isFolder: true, isDeleted: false },
      });
    });

    it("fails closed when an otherwise visible folder has no mirror file", async () => {
      mockFolderRepository.findOne.mockResolvedValue({
        id: 1,
        userId: 1,
        name: "Documents",
      });
      mockFileRepository.findOne.mockResolvedValue(null);

      await expect(service.findFolder(1, 1)).rejects.toThrow(
        "Folder mirror not found",
      );
    });

    it("should throw NotFoundException when folder belongs to another user", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.findFolder(1, 2)).rejects.toThrow(NotFoundException);
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1, isDeleted: false },
      });
    });

    it("should not return a deleted folder", async () => {
      mockFolderRepository.findOne.mockResolvedValue(null);

      await expect(service.findFolder(1, 3)).rejects.toThrow(NotFoundException);
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 3, userId: 1, isDeleted: false },
      });
    });
  });

  describe("findFolders", () => {
    it("adds the owner-scoped mirror id required by folder sharing", async () => {
      const getMany = jest.fn().mockResolvedValue([
        { id: 4, userId: 1, name: "Alpha" },
        { id: 9, userId: 1, name: "Beta" },
      ]);
      mockFolderRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });
      mockFileRepository.find.mockResolvedValue([
        { id: 40, folderId: 4 },
        { id: 90, folderId: 9 },
      ]);

      await expect(service.findFolders(1)).resolves.toEqual([
        { id: 4, userId: 1, name: "Alpha", shareFileId: 40 },
        { id: 9, userId: 1, name: "Beta", shareFileId: 90 },
      ]);
      expect(mockFileRepository.find).toHaveBeenCalledWith({
        where: {
          userId: 1,
          folderId: expect.anything(),
          isFolder: true,
          isDeleted: false,
        },
      });
    });

    it("does not query mirrors for an empty folder listing", async () => {
      const getMany = jest.fn().mockResolvedValue([]);
      mockFolderRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany,
      });

      await expect(service.findFolders(1)).resolves.toEqual([]);
      expect(mockFileRepository.find).not.toHaveBeenCalled();
    });

    it("fails closed when a listed folder has no owner-scoped mirror", async () => {
      mockFolderRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([{ id: 4, userId: 1, name: "Alpha" }]),
      });
      mockFileRepository.find.mockResolvedValue([]);

      await expect(service.findFolders(1)).rejects.toThrow(
        "Folder mirror not found",
      );
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
      mockQueryRunner.manager.create.mockImplementation(
        (entity: any, data: any) => {
          if (entity === FolderEntity) return folder;
          return { ...createdMirror, ...data };
        },
      );
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
      mockQueryRunner.manager.create.mockImplementation(
        (entity: any, data: any) => {
          return { ...createdFile, ...data };
        },
      );
      mockQueryRunner.manager.save.mockResolvedValue(createdFile);

      const result = await service.createFile(1, "test.txt", 100, "text/plain");

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
      mockQueryRunner.manager.create.mockImplementation(
        (entity: any, data: any) => {
          if (entity === FolderEntity)
            return {
              id: data.name === "A" ? 10 : 11,
              userId: 1,
              name: data.name,
            };
          createdMirrors.push(data);
          return { id: data.name === "A" ? 100 : 101, ...data };
        },
      );
      mockQueryRunner.manager.save.mockImplementation((obj: any) =>
        Promise.resolve(obj),
      );

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
    let qr: any;

    beforeEach(() => {
      qr = createMockQueryRunner();
      mockFolderRepository.manager.connection.createQueryRunner.mockReturnValue(
        qr,
      );
    });

    it("should throw ForbiddenException when moving folder to folder owned by another user", async () => {
      const folder = { id: 1, userId: 1, name: "Documents" };
      mockFolderRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.id === 1 && where.userId === 1)
          return Promise.resolve(folder);
        return Promise.resolve(null);
      });

      await expect(service.updateFolder(1, 1, { parentId: 2 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockFolderRepository.findOne).toHaveBeenCalledWith({
        where: { id: 2, userId: 1 },
      });
      expect(qr.startTransaction).not.toHaveBeenCalled();
    });

    it("synchronizes rename and move when folder and mirror ids differ", async () => {
      const folder = { id: 7, userId: 1, name: "Old", parentId: null };
      const mirror = {
        id: 900,
        folderId: 7,
        userId: 1,
        isFolder: true,
        name: "Old",
        parentId: null,
      };
      mockFolderRepository.findOne.mockResolvedValue({ id: 12, userId: 1 });
      jest.spyOn(service, "assertNoCycle").mockResolvedValue();
      qr.manager.findOne.mockImplementation((entity: any) =>
        Promise.resolve(entity === FolderEntity ? folder : mirror),
      );
      qr.manager.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );

      const result = await service.updateFolder(1, 7, {
        name: "New",
        parentId: 12,
      });

      expect(qr.manager.findOne).toHaveBeenNthCalledWith(2, FileEntity, {
        where: { folderId: 7, userId: 1, isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      expect(folder).toMatchObject({ name: "New", parentId: 12 });
      expect(mirror).toMatchObject({
        id: 900,
        folderId: 7,
        name: "New",
        parentId: 12,
      });
      expect(result).toBe(mirror);
      expect(qr.manager.save).toHaveBeenNthCalledWith(1, folder);
      expect(qr.manager.save).toHaveBeenNthCalledWith(2, mirror);
      expect(qr.manager.save.mock.invocationCallOrder[1]).toBeLessThan(
        qr.commitTransaction.mock.invocationCallOrder[0],
      );
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("fails closed when mirror is missing", async () => {
      qr.manager.findOne
        .mockResolvedValueOnce({ id: 7, userId: 1 })
        .mockResolvedValueOnce(null);

      await expect(service.updateFolder(1, 7, { name: "New" })).rejects.toThrow(
        "Folder mirror not found",
      );
      expect(qr.manager.save).not.toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("rolls back when the mirror save fails", async () => {
      qr.manager.findOne
        .mockResolvedValueOnce({ id: 7, userId: 1, name: "Old" })
        .mockResolvedValueOnce({
          id: 900,
          folderId: 7,
          userId: 1,
          isFolder: true,
        });
      qr.manager.save
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("mirror save failed"));

      await expect(service.updateFolder(1, 7, { name: "New" })).rejects.toThrow(
        "mirror save failed",
      );
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });
  });

  describe("restore integrity", () => {
    it("restores a file to root when its former parent is not active", async () => {
      const file = {
        id: 9,
        userId: 3,
        parentId: 41,
        isDeleted: true,
        deletedAt: new Date(),
      };
      mockFileRepository.findOne.mockResolvedValue(file);
      mockFolderRepository.findOne.mockResolvedValue(null);
      mockFileRepository.save.mockImplementation((value: any) =>
        Promise.resolve(value),
      );

      await service.restoreFile(3, 9);

      expect(file).toMatchObject({
        parentId: null,
        isDeleted: false,
        deletedAt: null,
      });
    });
  });

  describe("folder mirror transactional lifecycle", () => {
    let qr: any;
    const folder = { id: 41, userId: 3, isDeleted: false, deletedAt: null };
    const mirror = {
      id: 812,
      folderId: 41,
      userId: 3,
      isFolder: true,
      isDeleted: false,
      deletedAt: null,
    };

    beforeEach(() => {
      qr = createMockQueryRunner();
      mockFolderRepository.manager.connection.createQueryRunner.mockReturnValue(
        qr,
      );
      qr.manager.findOne.mockImplementation((entity: any) =>
        Promise.resolve(
          entity === FolderEntity ? { ...folder } : { ...mirror },
        ),
      );
      qr.manager.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );
    });

    it.each([
      ["removeFolder", (svc: FilesService) => svc.removeFolder(3, 41), true],
      ["restoreFolder", (svc: FilesService) => svc.restoreFolder(3, 41), false],
    ])(
      "%s synchronizes folder and differently-id mirror",
      async (_name, operation, deleted) => {
        await operation(service);

        expect(qr.manager.findOne).toHaveBeenNthCalledWith(2, FileEntity, {
          where: { folderId: 41, userId: 3, isFolder: true },
          lock: { mode: "pessimistic_write" },
        });
        const [savedFolder, savedMirror] = qr.manager.save.mock.calls.map(
          (call: any[]) => call[0],
        );
        expect(savedFolder.isDeleted).toBe(deleted);
        expect(savedMirror).toMatchObject({
          id: 812,
          folderId: 41,
          isDeleted: deleted,
        });
        expect(savedMirror.deletedAt).toBe(savedFolder.deletedAt);
        expect(qr.manager.save.mock.invocationCallOrder[1]).toBeLessThan(
          qr.commitTransaction.mock.invocationCallOrder[0],
        );
        expect(qr.rollbackTransaction).not.toHaveBeenCalled();
        expect(qr.release).toHaveBeenCalledTimes(1);
      },
    );

    it("restores a folder to root when its former parent is not active", async () => {
      const child = { ...folder, parentId: 10, isDeleted: true };
      const childMirror = { ...mirror, parentId: 10, isDeleted: true };
      qr.manager.findOne
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(childMirror)
        .mockResolvedValueOnce(null);

      await service.restoreFolder(3, 41);

      expect(child.parentId).toBeNull();
      expect(childMirror.parentId).toBeNull();
    });

    it.each([
      ["removeFolder", (svc: FilesService) => svc.removeFolder(3, 41)],
      ["restoreFolder", (svc: FilesService) => svc.restoreFolder(3, 41)],
    ])("%s fails closed without a mirror", async (_name, operation) => {
      qr.manager.findOne
        .mockResolvedValueOnce({ ...folder })
        .mockResolvedValueOnce(null);

      await expect(operation(service)).rejects.toThrow(
        "Folder mirror not found",
      );
      expect(qr.manager.save).not.toHaveBeenCalled();
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["removeFolder", (svc: FilesService) => svc.removeFolder(3, 41)],
      ["restoreFolder", (svc: FilesService) => svc.restoreFolder(3, 41)],
    ])("%s rolls back when the mirror save fails", async (_name, operation) => {
      qr.manager.save
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("mirror save failed"));

      await expect(operation(service)).rejects.toThrow("mirror save failed");
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        "updateFolder",
        (svc: FilesService) => svc.updateFolder(3, 41, { name: "New" }),
      ],
      ["removeFolder", (svc: FilesService) => svc.removeFolder(3, 41)],
      ["restoreFolder", (svc: FilesService) => svc.restoreFolder(3, 41)],
    ])(
      "%s releases after transaction start failure",
      async (_name, operation) => {
        qr.startTransaction.mockRejectedValue(new Error("start failed"));

        await expect(operation(service)).rejects.toThrow("start failed");
        expect(qr.rollbackTransaction).not.toHaveBeenCalled();
        expect(qr.commitTransaction).not.toHaveBeenCalled();
        expect(qr.release).toHaveBeenCalledTimes(1);
      },
    );
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
    const source = {
      id: 1,
      userId: 1,
      name: "test.txt",
      size: 100,
      mimeType: "text/plain",
      storagePath: "/storage/1/source.txt",
    };

    beforeEach(() => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      mockFileRepository.findOne.mockResolvedValue(source);
      mockUsersService.findById.mockResolvedValue({
        id: 1,
        storageQuota: 1000,
        storageUsed: 0,
      });
      qr.manager.create.mockImplementation((_entity: any, value: any) => value);
      qr.manager.save.mockImplementation(async (value: any) => {
        value.id = 2;
        return value;
      });
    });

    it("awaits physical copy before creating metadata", async () => {
      let allowCopy!: () => void;
      const pendingCopy = new Promise<void>((resolve) => {
        allowCopy = resolve;
      });
      mockStorageService.copyFile.mockReturnValueOnce(pendingCopy);

      const operation = service.copyFile(1, 1);
      await Promise.resolve();
      await Promise.resolve();

      const qr = mockFileRepository.manager.connection.createQueryRunner();
      expect(qr.manager.create).not.toHaveBeenCalled();
      expect(qr.manager.save).not.toHaveBeenCalled();
      allowCopy();
      await operation;
      expect(qr.manager.save).toHaveBeenCalledTimes(1);
    });

    it("does not create metadata or charge quota when physical copy fails", async () => {
      const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
      mockStorageService.copyFile.mockRejectedValueOnce(missing);

      await expect(service.copyFile(1, 1)).rejects.toBe(missing);

      const qr = mockFileRepository.manager.connection.createQueryRunner();
      expect(qr.manager.create).not.toHaveBeenCalled();
      expect(qr.manager.save).not.toHaveBeenCalled();
      expect(mockUsersService.updateStorageUsed).not.toHaveBeenCalled();
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it("returns and persists exact normalized metadata on success", async () => {
      mockFileRepository.findOne.mockResolvedValueOnce({
        ...source,
        size: "100",
      });

      const result = await service.copyFile(1, 1);

      expect(mockStorageService.copyFile).toHaveBeenCalledWith(
        source.storagePath,
        "/storage/1/test.txt",
      );
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      expect(qr.manager.create).toHaveBeenCalledWith(
        FileEntity,
        expect.objectContaining({
          name: "test.txt",
          storagePath: "/storage/1/test.txt",
          size: 100,
          mimeType: "text/plain",
          userId: 1,
        }),
      );
      expect(mockUsersService.updateStorageUsed).toHaveBeenCalledWith(
        1,
        100,
        qr.manager,
      );
      expect(result).toEqual(
        expect.objectContaining({
          name: "test.txt",
          storagePath: "/storage/1/test.txt",
          size: 100,
        }),
      );
    });

    it("does not remove a colliding destination or create side effects", async () => {
      const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
      mockStorageService.copyFile.mockRejectedValueOnce(collision);

      await expect(service.copyFile(1, 1)).rejects.toBe(collision);

      const qr = mockFileRepository.manager.connection.createQueryRunner();
      expect(qr.manager.create).not.toHaveBeenCalled();
      expect(qr.manager.save).not.toHaveBeenCalled();
      expect(mockUsersService.updateStorageUsed).not.toHaveBeenCalled();
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it("cleans up only the new destination when metadata persistence fails", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.save.mockRejectedValueOnce(new Error("save failed"));

      await expect(service.copyFile(1, 1)).rejects.toThrow("save failed");

      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
      expect(mockStorageService.deleteFile).not.toHaveBeenCalledWith(
        source.storagePath,
      );
      expect(mockUsersService.updateStorageUsed).toHaveBeenCalledWith(
        1,
        100,
        qr.manager,
      );
      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("cleans up the destination without masking a quota error", async () => {
      const quotaError = new ForbiddenException("Storage quota exceeded");
      mockUsersService.updateStorageUsed.mockRejectedValueOnce(quotaError);
      mockStorageService.deleteFile.mockRejectedValueOnce(
        new Error("cleanup failed"),
      );

      await expect(service.copyFile(1, 1)).rejects.toBe(quotaError);
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
      expect((service as any).logger.error).toBeDefined();
    });

    it("commits quota and metadata through the same transaction manager", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();

      await service.copyFile(1, 1);

      expect(qr.connect).toHaveBeenCalledTimes(1);
      expect(qr.startTransaction).toHaveBeenCalledTimes(1);
      expect(mockUsersService.updateStorageUsed).toHaveBeenCalledWith(
        1,
        100,
        qr.manager,
      );
      expect(qr.manager.save).toHaveBeenCalledTimes(1);
      expect(
        mockUsersService.updateStorageUsed.mock.invocationCallOrder[0],
      ).toBeLessThan(qr.manager.save.mock.invocationCallOrder[0]);
      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("rolls back quota when metadata save fails and cleans destination", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.save.mockRejectedValueOnce(new Error("metadata failed"));

      await expect(service.copyFile(1, 1)).rejects.toThrow("metadata failed");

      expect(qr.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(qr.commitTransaction).not.toHaveBeenCalled();
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
    });

    it("keeps destination when an ambiguous commit is proven present", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      const commitError = new Error("commit outcome unknown");
      qr.commitTransaction.mockRejectedValueOnce(commitError);
      mockFileRepository.findOne
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce({ id: 2, storagePath: "/storage/1/test.txt" });

      await expect(service.copyFile(1, 1)).rejects.toBe(commitError);

      expect(mockFileRepository.findOne).toHaveBeenLastCalledWith({
        where: {
          id: 2,
          userId: 1,
          storagePath: "/storage/1/test.txt",
        },
      });
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
      expect(qr.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("removes destination when an ambiguous commit is proven absent", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.commitTransaction.mockRejectedValueOnce(new Error("commit failed"));
      mockFileRepository.findOne
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(null);

      await expect(service.copyFile(1, 1)).rejects.toThrow("commit failed");

      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
    });

    it("keeps destination when ambiguous commit reconciliation is unavailable", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.commitTransaction.mockRejectedValueOnce(new Error("commit failed"));
      mockFileRepository.findOne
        .mockResolvedValueOnce(source)
        .mockRejectedValueOnce(new Error("database unavailable"));

      await expect(service.copyFile(1, 1)).rejects.toThrow("commit failed");

      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it("cleans destination when query runner creation fails", async () => {
      mockFileRepository.manager.connection.createQueryRunner.mockImplementationOnce(
        () => {
          throw new Error("runner failed");
        },
      );

      await expect(service.copyFile(1, 1)).rejects.toThrow("runner failed");
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
      expect(mockStorageService.deleteFile).not.toHaveBeenCalledWith(
        source.storagePath,
      );
    });

    it("cleans destination when metadata entity creation fails", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.manager.create.mockImplementationOnce(() => {
        throw new Error("entity failed");
      });

      await expect(service.copyFile(1, 1)).rejects.toThrow("entity failed");
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
      expect(qr.release).toHaveBeenCalledTimes(1);
    });

    it("does not mask the original error when query runner release fails", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      const quotaError = new ForbiddenException("Storage quota exceeded");
      mockUsersService.updateStorageUsed.mockRejectedValueOnce(quotaError);
      qr.release.mockRejectedValueOnce(new Error("release failed"));

      await expect(service.copyFile(1, 1)).rejects.toBe(quotaError);
      expect(mockStorageService.deleteFile).toHaveBeenCalledWith(
        "/storage/1/test.txt",
      );
    });

    it("does not turn a committed copy into an error when release fails", async () => {
      const qr = mockFileRepository.manager.connection.createQueryRunner();
      qr.release.mockRejectedValueOnce(new Error("release failed"));

      await expect(service.copyFile(1, 1)).resolves.toEqual(
        expect.objectContaining({ id: 2, size: 100 }),
      );
      expect(qr.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mockStorageService.deleteFile).not.toHaveBeenCalled();
    });

    it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      "rejects unsafe source size metadata: %s",
      async (size) => {
        mockFileRepository.findOne.mockResolvedValueOnce({ ...source, size });

        await expect(service.copyFile(1, 1)).rejects.toThrow(
          BadRequestException,
        );
        expect(mockStorageService.copyFile).not.toHaveBeenCalled();
      },
    );

    it("should throw ForbiddenException when copying file to folder owned by another user", async () => {
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
