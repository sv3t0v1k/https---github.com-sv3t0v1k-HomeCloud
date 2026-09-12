import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
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

    return query.getMany();
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
      where: { id, userId },
    });
    if (!folder) {
      throw new NotFoundException("Folder not found");
    }
    return folder;
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

    const queryRunner = this.fileRepository.manager.connection.createQueryRunner();
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
      await this.usersService.updateStorageUsed(userId, size, queryRunner.manager);

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

    const queryRunner = this.folderRepository.manager.connection.createQueryRunner();
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
    const folder = await this.findFolder(userId, id);
    const file = await this.fileRepository.findOne({ where: { id, userId } });

    if (data.name) {
      if (!data.name.trim()) {
        throw new BadRequestException("Folder name must not be empty");
      }
      folder.name = data.name;
      if (file) {
        file.name = data.name;
      }
    }

    if (data.parentId !== undefined) {
      await this.assertFolderOwnership(userId, data.parentId);

      // Prevent folder cycle: target parent must not be a descendant
      if (data.parentId !== null) {
        await this.assertNoCycle(id, data.parentId);
      }

      folder.parentId = data.parentId ?? null;
      if (file) {
        file.parentId = data.parentId ?? null;
      }
    }

    await this.folderRepository.save(folder);
    if (file) {
      await this.fileRepository.save(file);
    }

    return file;
  }

  async assertNoCycle(folderId: number, targetParentId: number): Promise<void> {
    const descendantRows: { id: number }[] = await this.folderRepository.query(`
      WITH RECURSIVE descendants AS (
        SELECT id FROM folders WHERE id = $1 AND "userId" = (SELECT "userId" FROM folders WHERE id = $1)
        UNION ALL
        SELECT f.id FROM folders f
        INNER JOIN descendants d ON f."parentId" = d.id
      )
      SELECT id FROM descendants
    `, [folderId]);

    const descendantIds = new Set(descendantRows.map(r => r.id));
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
    const folder = await this.findFolder(userId, id);
    const file = await this.fileRepository.findOne({ where: { id, userId } });

    folder.isDeleted = true;
    folder.deletedAt = new Date();
    await this.folderRepository.save(folder);

    if (file) {
      file.isDeleted = true;
      file.deletedAt = new Date();
      await this.fileRepository.save(file);
    }

    return { message: "Folder moved to trash" };
  }

  async restoreFile(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    file.isDeleted = false;
    file.deletedAt = null;
    await this.fileRepository.save(file);

    return { message: "File restored" };
  }

  async restoreFolder(userId: number, id: number) {
    const folder = await this.findFolder(userId, id);
    const file = await this.fileRepository.findOne({ where: { id, userId } });

    folder.isDeleted = false;
    folder.deletedAt = null;
    await this.folderRepository.save(folder);

    if (file) {
      file.isDeleted = false;
      file.deletedAt = null;
      await this.fileRepository.save(file);
    }

    return { message: "Folder restored" };
  }

  async deleteFilePermanently(userId: number, id: number) {
    const queryRunner = this.fileRepository.manager.connection.createQueryRunner();
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

      await this.usersService.decrementStorageUsed(userId, file.size, queryRunner.manager);
      await queryRunner.manager.delete(FileEntity, id);

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      if (fileToDelete.storagePath) {
        try {
          this.storageService.deleteFile(fileToDelete.storagePath);
        } catch (error) {
          this.logger.error(`Failed to delete physical file ${fileToDelete.storagePath}`, error);
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
    const queryRunner = this.folderRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let allFilesToDelete: FileEntity[] = [];
    let folderIdsToDelete: number[] = [];

    try {
      const folder = await queryRunner.manager.findOne(FolderEntity, {
        where: { id, userId },
      });

      if (!folder) {
        throw new NotFoundException("Folder not found");
      }

      // Recursively collect all descendant folder IDs via CTE
      const descendantFolderRows: { id: number }[] = await queryRunner.manager.query(`
        WITH RECURSIVE descendants AS (
          SELECT id FROM folders WHERE id = $1 AND "userId" = $2
          UNION ALL
          SELECT f.id FROM folders f
          INNER JOIN descendants d ON f."parentId" = d.id
          WHERE f."userId" = $2
        )
        SELECT id FROM descendants
      `, [id, userId]);

      folderIdsToDelete = descendantFolderRows.map(r => r.id);

      // Collect all files in the subtree (excluding folder mirror records)
      const descendantFiles = await queryRunner.manager.find(FileEntity, {
        where: {
          userId,
          parentId: In(folderIdsToDelete),
          isFolder: false,
        },
      });

      // Collect all folder mirror files (records where isFolder=true in subtree)
      const folderMirrorFiles = await queryRunner.manager.find(FileEntity, {
        where: {
          userId,
          id: In(folderIdsToDelete),
          isFolder: true,
        },
      });

      allFilesToDelete = [...descendantFiles, ...folderMirrorFiles];
      const totalSize = allFilesToDelete.reduce((sum, f) => sum + f.size, 0);

      // Atomic quota decrement (inside transaction)
      await this.usersService.decrementStorageUsed(userId, totalSize, queryRunner.manager);

      // Bulk delete all records (inside transaction)
      if (folderIdsToDelete.length > 0) {
        await queryRunner.manager.delete(FolderEntity, folderIdsToDelete);
      }
      if (allFilesToDelete.length > 0) {
        await queryRunner.manager.delete(FileEntity, allFilesToDelete.map(f => f.id));
      }

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      for (const file of allFilesToDelete) {
        if (file.storagePath) {
          try {
            this.storageService.deleteFile(file.storagePath);
          } catch (error) {
            this.logger.error(`Failed to delete physical file ${file.storagePath}`, error);
          }
        }
      }

      return { message: "Folder deleted permanently" };
    } catch (error) {
      await queryRunner.rollbackTransaction();
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
    const queryRunner = this.fileRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let trashedFiles: any[] = [];

    try {
      const files = await queryRunner.manager.find(FileEntity, {
        where: { userId, isDeleted: true, isFolder: false },
      });
      const folders = await queryRunner.manager.find(FolderEntity, {
        where: { userId, isDeleted: true },
      });

      trashedFiles = files;

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);

      // Atomic quota decrement (inside transaction)
      await this.usersService.decrementStorageUsed(userId, totalSize, queryRunner.manager);

      // Bulk delete all records (inside transaction)
      const fileIds = files.map(f => f.id);
      const folderIds = folders.map(f => f.id);
      if (fileIds.length > 0) {
        await queryRunner.manager.delete(FileEntity, fileIds);
      }
      if (folderIds.length > 0) {
        await queryRunner.manager.delete(FolderEntity, folderIds);
      }

      await queryRunner.commitTransaction();

      // Physical deletion AFTER successful commit — safe from rollback
      for (const file of trashedFiles) {
        if (file.storagePath) {
          try {
            this.storageService.deleteFile(file.storagePath);
          } catch (error) {
            this.logger.error(`Failed to delete physical file ${file.storagePath}`, error);
          }
        }
      }

      return { message: "Trash emptied" };
    } catch (error) {
      await queryRunner.rollbackTransaction();
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

    const safeName = this.storageService.generateSafeFilename(source.name);
    const targetPath = this.storageService.generatePath(userId, safeName);

    if (this.storageService.fileExists(source.storagePath)) {
      fs.copyFileSync(source.storagePath, targetPath);
    }

    const copy = this.fileRepository.create({
      name: safeName,
      storagePath: targetPath,
      size: source.size,
      mimeType: source.mimeType,
      isFolder: false,
      parentId: targetParentId,
      userId,
      user,
    });

    await this.fileRepository.save(copy);
    await this.usersService.updateStorageUsed(userId, source.size);

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
