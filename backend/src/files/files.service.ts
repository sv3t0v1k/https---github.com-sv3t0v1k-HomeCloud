import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In, QueryRunner } from "typeorm";
import * as fs from "fs";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    @InjectRepository(FolderEntity)
    private folderRepository: Repository<FolderEntity>,
    private storageService: StorageService,
    private usersService: UsersService,
  ) {}

  private sumFileSizes(files: FileEntity[]): number {
    return files.reduce((total, file) => {
      const size = Number(file.size);
      const nextTotal = total + size;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(nextTotal)
      ) {
        throw new BadRequestException("Invalid file size metadata");
      }
      return nextTotal;
    }, 0);
  }

  async findAll(
    userId: number,
    parentId?: number,
    search?: string,
    includeDeleted = false,
  ) {
    let query = this.fileRepository
      .createQueryBuilder("file")
      .where("file.userId = :userId", { userId })
      .andWhere("file.isFolder = :isFolder", { isFolder: false });

    if (!includeDeleted) {
      query = query.andWhere("file.isDeleted = :isDeleted", {
        isDeleted: false,
      });
    }

    if (parentId) {
      query = query.andWhere("file.parentId = :parentId", { parentId });
    } else {
      query = query.andWhere("file.parentId IS NULL");
    }

    if (search) {
      query = query.andWhere("file.name ILIKE :search", {
        search: `%${search}%`,
      });
    }

    query.orderBy("file.isFolder", "DESC").addOrderBy("file.name", "ASC");

    return query.getMany();
  }

  async findFolders(userId: number, parentId?: number, includeDeleted = false) {
    let query = this.folderRepository
      .createQueryBuilder("folder")
      .where("folder.userId = :userId", { userId })
      .andWhere("folder.isDeleted = :isDeleted", { isDeleted: includeDeleted });

    if (parentId) {
      query = query.andWhere("folder.parentId = :parentId", { parentId });
    } else {
      query = query.andWhere("folder.parentId IS NULL");
    }

    query.orderBy("folder.name", "ASC");

    const folders = await query.getMany();
    if (folders.length === 0) return [];

    const mirrors = await this.fileRepository.find({
      where: {
        userId,
        folderId: In(folders.map((folder) => folder.id)),
        isFolder: true,
        isDeleted: includeDeleted,
      },
    });
    const mirrorByFolderId = new Map(
      mirrors.map((mirror) => [mirror.folderId, mirror.id]),
    );

    return folders.map((folder) => {
      const shareFileId = mirrorByFolderId.get(folder.id);
      if (!shareFileId) {
        throw new NotFoundException("Folder mirror not found");
      }
      return { ...folder, shareFileId };
    });
  }

  async findOne(userId: number, id: number) {
    const file = await this.fileRepository.findOne({ where: { id, userId } });
    if (!file) {
      throw new NotFoundException("File not found");
    }
    return file;
  }

  async findFolder(userId: number, id: number) {
    const folder = await this.folderRepository.findOne({
      where: { id, userId, isDeleted: false },
    });
    if (!folder) {
      throw new NotFoundException("Folder not found");
    }
    const mirror = await this.fileRepository.findOne({
      where: { folderId: id, userId, isFolder: true, isDeleted: false },
    });
    if (!mirror) {
      throw new NotFoundException("Folder mirror not found");
    }
    return { ...folder, shareFileId: mirror.id };
  }

  async assertFolderOwnership(userId: number, folderId?: number | null) {
    if (!folderId) return;
    const folder = await this.folderRepository.findOne({
      where: { id: folderId, userId },
    });
    if (!folder) {
      throw new ForbiddenException("Target folder not found or access denied");
    }
  }

  async createFile(
    userId: number,
    name: string,
    size: number,
    mimeType: string,
    parentId?: number,
  ) {
    if (!name || !name.trim()) {
      throw new BadRequestException("File name must not be empty");
    }

    const safeName = this.storageService.generateSafeFilename(name);
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException("User not found");
    }

    await this.assertFolderOwnership(userId, parentId);

    const queryRunner =
      this.fileRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const file = queryRunner.manager.create(FileEntity, {
        name: safeName,
        storagePath: this.storageService.generatePath(userId, safeName),
        size,
        mimeType,
        isFolder: false,
        parentId,
        userId,
        user,
      });

      await queryRunner.manager.save(file);
      await this.usersService.updateStorageUsed(
        userId,
        size,
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      return file;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async createFolder(userId: number, name: string, parentId?: number) {
    if (!name || !name.trim()) {
      throw new BadRequestException("Folder name must not be empty");
    }

    await this.assertFolderOwnership(userId, parentId);

    const queryRunner =
      this.folderRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const folder = queryRunner.manager.create(FolderEntity, {
        name,
        isDeleted: false,
        parentId,
        userId,
      });

      await queryRunner.manager.save(folder);

      const file = queryRunner.manager.create(FileEntity, {
        name,
        isFolder: true,
        isDeleted: false,
        parentId,
        folderId: folder.id,
        userId,
        version: 1,
      });

      await queryRunner.manager.save(file);

      await queryRunner.commitTransaction();

      return file;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateFile(
    userId: number,
    id: number,
    data: { name?: string; parentId?: number | null },
  ) {
    const file = await this.findOne(userId, id);
    if (file.isFolder) {
      throw new BadRequestException("Cannot update folder via files endpoint");
    }

    if (data.name) {
      if (!data.name.trim()) {
        throw new BadRequestException("File name must not be empty");
      }
      const safeName = this.storageService.generateSafeFilename(data.name);
      const oldPath = file.storagePath;
      const newPath = this.storageService.generatePath(userId, safeName);

      if (this.storageService.fileExists(oldPath)) {
        fs.renameSync(oldPath, newPath);
      }

      file.name = safeName;
      file.storagePath = newPath;
    }

    if (data.parentId !== undefined) {
      await this.assertFolderOwnership(userId, data.parentId);
      file.parentId = data.parentId ?? null;
    }

    await this.fileRepository.save(file);
    return file;
  }

  async updateFolder(
    userId: number,
    id: number,
    data: { name?: string; parentId?: number | null },
  ) {
    if (data.name !== undefined && data.name !== null && !data.name.trim()) {
      throw new BadRequestException("Folder name must not be empty");
    }
    if (data.parentId !== undefined) {
      await this.assertFolderOwnership(userId, data.parentId);
      if (data.parentId !== null) {
        await this.assertNoCycle(id, data.parentId);
      }
    }

    const queryRunner =
      this.folderRepository.manager.connection.createQueryRunner();
    let transactionStarted = false;

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionStarted = true;

      const folder = await queryRunner.manager.findOne(FolderEntity, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!folder) {
        throw new NotFoundException("Folder not found");
      }

      const mirror = await queryRunner.manager.findOne(FileEntity, {
        where: { folderId: id, userId, isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      if (!mirror) {
        throw new NotFoundException("Folder mirror not found");
      }

      if (data.name && data.name.trim()) {
        folder.name = data.name;
        mirror.name = data.name;
      }

      if (data.parentId !== undefined) {
        folder.parentId = data.parentId ?? null;
        mirror.parentId = data.parentId ?? null;
      }

      await queryRunner.manager.save(folder);
      await queryRunner.manager.save(mirror);
      await queryRunner.commitTransaction();
      return mirror;
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async assertNoCycle(folderId: number, targetParentId: number): Promise<void> {
    const descendantRows: { id: number }[] = await this.folderRepository.query(
      `
      WITH RECURSIVE descendants AS (
        SELECT id FROM folders WHERE id = $1 AND "userId" = (SELECT "userId" FROM folders WHERE id = $1)
        UNION ALL
        SELECT f.id FROM folders f
        INNER JOIN descendants d ON f."parentId" = d.id
      )
      SELECT id FROM descendants
    `,
      [folderId],
    );

    const descendantIds = new Set(descendantRows.map((r) => r.id));
    if (descendantIds.has(targetParentId)) {
      throw new BadRequestException("Cannot move folder into its own subtree");
    }
  }

  async removeFile(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    if (file.isFolder) {
      throw new BadRequestException("Cannot delete folder via files endpoint");
    }

    file.isDeleted = true;
    file.deletedAt = new Date();
    await this.fileRepository.save(file);

    return { message: "File moved to trash" };
  }

  async removeFolder(userId: number, id: number) {
    const queryRunner =
      this.folderRepository.manager.connection.createQueryRunner();
    let transactionStarted = false;

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionStarted = true;
      const folder = await queryRunner.manager.findOne(FolderEntity, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!folder) {
        throw new NotFoundException("Folder not found");
      }
      const mirror = await queryRunner.manager.findOne(FileEntity, {
        where: { folderId: id, userId, isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      if (!mirror) {
        throw new NotFoundException("Folder mirror not found");
      }

      const now = new Date();
      folder.isDeleted = true;
      folder.deletedAt = now;
      mirror.isDeleted = true;
      mirror.deletedAt = now;
      await queryRunner.manager.save(folder);
      await queryRunner.manager.save(mirror);
      await queryRunner.commitTransaction();
      return { message: "Folder moved to trash" };
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async restoreFile(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    if (file.parentId !== null) {
      const activeParent = await this.folderRepository.findOne({
        where: { id: file.parentId, userId, isDeleted: false },
      });
      if (!activeParent) file.parentId = null;
    }
    file.isDeleted = false;
    file.deletedAt = null;
    await this.fileRepository.save(file);

    return { message: "File restored" };
  }

  async restoreFolder(userId: number, id: number) {
    const queryRunner =
      this.folderRepository.manager.connection.createQueryRunner();
    let transactionStarted = false;

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionStarted = true;
      const folder = await queryRunner.manager.findOne(FolderEntity, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!folder) {
        throw new NotFoundException("Folder not found");
      }
      const mirror = await queryRunner.manager.findOne(FileEntity, {
        where: { folderId: id, userId, isFolder: true },
        lock: { mode: "pessimistic_write" },
      });
      if (!mirror) {
        throw new NotFoundException("Folder mirror not found");
      }

      if (folder.parentId !== null) {
        const activeParent = await queryRunner.manager.findOne(FolderEntity, {
          where: { id: folder.parentId, userId, isDeleted: false },
        });
        if (!activeParent) {
          folder.parentId = null;
          mirror.parentId = null;
        }
      }

      folder.isDeleted = false;
      folder.deletedAt = null;
      mirror.isDeleted = false;
      mirror.deletedAt = null;
      await queryRunner.manager.save(folder);
      await queryRunner.manager.save(mirror);
      await queryRunner.commitTransaction();
      return { message: "Folder restored" };
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteFilePermanently(userId: number, id: number) {
    const queryRunner =
      this.fileRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let fileToDelete: FileEntity | null = null;

    try {
      const file = await queryRunner.manager.findOne(FileEntity, {
        where: { id, userId },
      });

      if (!file) {
        throw new NotFoundException("File not found");
      }

      fileToDelete = file;

      await this.usersService.decrementStorageUsed(
        userId,
        file.size,
        queryRunner.manager,
      );
      await queryRunner.manager.delete(FileEntity, id);

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      if (fileToDelete.storagePath) {
        try {
          await this.storageService.deleteFile(fileToDelete.storagePath);
        } catch (error) {
          this.logger.error(
            `Failed to delete physical file ${fileToDelete.storagePath}`,
            error,
          );
        }
      }

      return { message: "File deleted permanently" };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async deleteFolderPermanently(userId: number, id: number) {
    const queryRunner =
      this.folderRepository.manager.connection.createQueryRunner();
    let transactionStarted = false;
    let physicalFilesToDelete: FileEntity[] = [];

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction("SERIALIZABLE");
      transactionStarted = true;
      const folder = await queryRunner.manager.findOne(FolderEntity, {
        where: { id, userId },
        lock: { mode: "pessimistic_write" },
      });

      if (!folder) {
        throw new NotFoundException("Folder not found");
      }

      // Recursively collect all descendant folder IDs via CTE
      const descendantFolderRows: { id: number }[] =
        await queryRunner.manager.query(
          `
        WITH RECURSIVE descendants AS (
          SELECT id FROM folders WHERE id = $1 AND "userId" = $2
          UNION
          SELECT f.id FROM folders f
          INNER JOIN descendants d ON f."parentId" = d.id
          WHERE f."userId" = $2
        )
        SELECT id FROM descendants
      `,
          [id, userId],
        );

      const folderIdsToDelete = descendantFolderRows.map((r) => r.id);
      const lockedFolders = await queryRunner.manager.find(FolderEntity, {
        where: { id: In(folderIdsToDelete), userId },
        lock: { mode: "pessimistic_write" },
      });
      if (lockedFolders.length !== folderIdsToDelete.length) {
        throw new NotFoundException("Folder subtree is inconsistent");
      }

      // Collect all files in the subtree (excluding folder mirror records)
      const descendantFiles = await queryRunner.manager.find(FileEntity, {
        where: {
          userId,
          parentId: In(folderIdsToDelete),
          isFolder: false,
        },
        lock: { mode: "pessimistic_write" },
      });

      // Collect all folder mirror files (records where isFolder=true in subtree)
      const folderMirrorFiles = await queryRunner.manager.find(FileEntity, {
        where: {
          userId,
          folderId: In(folderIdsToDelete),
          isFolder: true,
        },
        lock: { mode: "pessimistic_write" },
      });
      const mirroredFolderIds = new Set(
        folderMirrorFiles.map((file) => file.folderId),
      );
      if (
        folderMirrorFiles.length !== folderIdsToDelete.length ||
        folderIdsToDelete.some((folderId) => !mirroredFolderIds.has(folderId))
      ) {
        throw new NotFoundException("Folder mirror not found");
      }

      physicalFilesToDelete = descendantFiles;
      const allFileRecords = [...descendantFiles, ...folderMirrorFiles];
      const totalSize = this.sumFileSizes(descendantFiles);

      // Atomic quota decrement (inside transaction)
      await this.usersService.decrementStorageUsed(
        userId,
        totalSize,
        queryRunner.manager,
      );

      // Bulk delete all records (inside transaction)
      if (allFileRecords.length > 0) {
        await queryRunner.manager.delete(
          FileEntity,
          allFileRecords.map((f) => f.id),
        );
      }
      if (folderIdsToDelete.length > 0) {
        await queryRunner.manager.delete(FolderEntity, folderIdsToDelete);
      }

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      for (const file of physicalFilesToDelete) {
        if (file.storagePath) {
          try {
            await this.storageService.deleteFile(file.storagePath);
          } catch (error) {
            this.logger.error(
              `Failed to delete physical file ${file.storagePath}`,
              error,
            );
          }
        }
      }

      return { message: "Folder deleted permanently" };
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async getTrash(userId: number) {
    const files = await this.fileRepository.find({
      where: { userId, isDeleted: true, isFolder: false },
      order: { deletedAt: "DESC" },
    });

    const folders = await this.folderRepository.find({
      where: { userId, isDeleted: true },
      order: { deletedAt: "DESC" },
    });

    return { files, folders };
  }

  async emptyTrash(userId: number) {
    const queryRunner =
      this.fileRepository.manager.connection.createQueryRunner();
    let transactionStarted = false;
    let physicalFilesToDelete: FileEntity[] = [];

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction("SERIALIZABLE");
      transactionStarted = true;
      const folderRows: { id: number }[] = await queryRunner.manager.query(
        `
        WITH RECURSIVE trash_folders AS (
          SELECT id FROM folders WHERE "userId" = $1 AND "isDeleted" = true
          UNION
          SELECT f.id FROM folders f
          INNER JOIN trash_folders t ON f."parentId" = t.id
          WHERE f."userId" = $1
        )
        SELECT id FROM trash_folders
      `,
        [userId],
      );
      const folderIds = folderRows.map((row) => row.id);

      let folderFiles: FileEntity[] = [];
      let folderMirrors: FileEntity[] = [];
      if (folderIds.length > 0) {
        const lockedFolders = await queryRunner.manager.find(FolderEntity, {
          where: { id: In(folderIds), userId },
          lock: { mode: "pessimistic_write" },
        });
        if (lockedFolders.length !== folderIds.length) {
          throw new NotFoundException("Trash folder subtree is inconsistent");
        }
      }

      const directlyTrashedFiles = await queryRunner.manager.find(FileEntity, {
        where: { userId, isDeleted: true, isFolder: false },
        lock: { mode: "pessimistic_write" },
      });
      if (folderIds.length > 0) {
        folderFiles = await queryRunner.manager.find(FileEntity, {
          where: { userId, parentId: In(folderIds), isFolder: false },
          lock: { mode: "pessimistic_write" },
        });
        folderMirrors = await queryRunner.manager.find(FileEntity, {
          where: { userId, folderId: In(folderIds), isFolder: true },
          lock: { mode: "pessimistic_write" },
        });
        const mirroredFolderIds = new Set(
          folderMirrors.map((file) => file.folderId),
        );
        if (
          folderMirrors.length !== folderIds.length ||
          folderIds.some((folderId) => !mirroredFolderIds.has(folderId))
        ) {
          throw new NotFoundException("Folder mirror not found");
        }
      }

      const ordinaryFiles = new Map<number, FileEntity>();
      for (const file of [...directlyTrashedFiles, ...folderFiles]) {
        ordinaryFiles.set(file.id, file);
      }
      physicalFilesToDelete = [...ordinaryFiles.values()];
      const allFileRecords = [...physicalFilesToDelete, ...folderMirrors];
      const totalSize = this.sumFileSizes(physicalFilesToDelete);

      // Atomic quota decrement (inside transaction)
      await this.usersService.decrementStorageUsed(
        userId,
        totalSize,
        queryRunner.manager,
      );

      // Bulk delete all records (inside transaction)
      const fileIds = allFileRecords.map((f) => f.id);
      if (fileIds.length > 0) {
        await queryRunner.manager.delete(FileEntity, fileIds);
      }
      if (folderIds.length > 0) {
        await queryRunner.manager.delete(FolderEntity, folderIds);
      }

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      for (const file of physicalFilesToDelete) {
        if (file.storagePath) {
          try {
            await this.storageService.deleteFile(file.storagePath);
          } catch (error) {
            this.logger.error(
              `Failed to delete physical file ${file.storagePath}`,
              error,
            );
          }
        }
      }

      return { message: "Trash emptied" };
    } catch (error) {
      if (transactionStarted) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async copyFile(userId: number, id: number, targetParentId?: number) {
    const source = await this.findOne(userId, id);
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException("User not found");
    }

    await this.assertFolderOwnership(userId, targetParentId);

    const size = Number(source.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new BadRequestException("Invalid file size metadata");
    }

    const safeName = this.storageService.generateSafeFilename(source.name);
    const targetPath = this.storageService.generatePath(userId, safeName);

    await this.storageService.copyFile(source.storagePath, targetPath);

    let queryRunner: QueryRunner | undefined;
    let copy: FileEntity | undefined;
    let transactionStarted = false;
    let commitAttempted = false;
    const cleanupDestination = async () => {
      try {
        await this.storageService.deleteFile(targetPath);
      } catch (cleanupError) {
        this.logger.error(
          `Failed to clean up copied file ${targetPath}`,
          cleanupError,
        );
      }
    };

    try {
      queryRunner = this.fileRepository.manager.connection.createQueryRunner();
      copy = queryRunner.manager.create(FileEntity, {
        name: safeName,
        storagePath: targetPath,
        size,
        mimeType: source.mimeType,
        isFolder: false,
        parentId: targetParentId,
        userId,
        user,
      });
      await queryRunner.connect();
      await queryRunner.startTransaction();
      transactionStarted = true;
      await this.usersService.updateStorageUsed(
        userId,
        size,
        queryRunner.manager,
      );
      await queryRunner.manager.save(copy);
      commitAttempted = true;
      await queryRunner.commitTransaction();
    } catch (error) {
      if (commitAttempted) {
        try {
          if (!copy?.id) {
            throw new Error("Copy record identity is unavailable");
          }
          const persistedCopy = await this.fileRepository.findOne({
            where: { id: copy.id, userId, storagePath: targetPath },
          });
          if (!persistedCopy) {
            await cleanupDestination();
          }
        } catch (reconciliationError) {
          this.logger.error(
            `Failed to reconcile copied file after ambiguous commit ${targetPath}`,
            reconciliationError,
          );
        }
      } else {
        if (transactionStarted && queryRunner) {
          try {
            await queryRunner.rollbackTransaction();
          } catch (rollbackError) {
            this.logger.error(
              "Failed to roll back copied file transaction",
              rollbackError,
            );
          }
        }
        await cleanupDestination();
      }
      throw error;
    } finally {
      if (queryRunner) {
        try {
          await queryRunner.release();
        } catch (releaseError) {
          this.logger.error(
            "Failed to release copied file transaction",
            releaseError,
          );
        }
      }
    }

    return copy;
  }

  async moveFile(userId: number, id: number, targetParentId?: number) {
    const file = await this.findOne(userId, id);
    await this.assertFolderOwnership(userId, targetParentId);
    file.parentId = targetParentId ?? null;
    await this.fileRepository.save(file);
    return file;
  }

  async search(userId: number, query: string) {
    const files = await this.fileRepository
      .createQueryBuilder("file")
      .where("file.userId = :userId", { userId })
      .andWhere("file.isDeleted = :isDeleted", { isDeleted: false })
      .andWhere("file.name ILIKE :query", { query: `%${query}%` })
      .orderBy("file.isFolder", "DESC")
      .addOrderBy("file.name", "ASC")
      .getMany();

    const folders = await this.folderRepository
      .createQueryBuilder("folder")
      .where("folder.userId = :userId", { userId })
      .andWhere("folder.isDeleted = :isDeleted", { isDeleted: false })
      .andWhere("folder.name ILIKE :query", { query: `%${query}%` })
      .orderBy("folder.name", "ASC")
      .getMany();

    return { files, folders };
  }

  async getStorageInfo(userId: number) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException("User not found");
    }

    const fileCount = await this.fileRepository.count({
      where: { userId, isDeleted: false, isFolder: false },
    });

    const folderCount = await this.folderRepository.count({
      where: { userId, isDeleted: false },
    });

    return {
      storageQuota: user.storageQuota,
      storageUsed: user.storageUsed,
      fileCount,
      folderCount,
    };
  }
}
