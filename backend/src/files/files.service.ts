import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { FileEntity } from '../entities/file.entity';
import { FolderEntity } from '../entities/folder.entity';
import { UserEntity } from '../entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { UsersService } from '../users/users.service';

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

  async findAll(userId: number, parentId?: number, search?: string, includeDeleted = false) {
    const query = this.fileRepository
      .createQueryBuilder('file')
      .where('file.userId = :userId', { userId })
      .andWhere('file.isFolder = :isFolder', { isFolder: false });

    if (!includeDeleted) {
      query = query.andWhere('file.isDeleted = :isDeleted', { isDeleted: false });
    }

    if (parentId) {
      query = query.andWhere('file.parentId = :parentId', { parentId });
    } else {
      query = query.andWhere('file.parentId IS NULL');
    }

    if (search) {
      query = query.andWhere('file.name ILIKE :search', { search: `%${search}%` });
    }

    query.orderBy('file.isFolder', 'DESC').addOrderBy('file.name', 'ASC');

    return query.getMany();
  }

  async findFolders(userId: number, parentId?: number, includeDeleted = false) {
    const query = this.folderRepository
      .createQueryBuilder('folder')
      .where('folder.userId = :userId', { userId })
      .andWhere('folder.isDeleted = :isDeleted', { isDeleted: includeDeleted });

    if (parentId) {
      query = query.andWhere('folder.parentId = :parentId', { parentId });
    } else {
      query = query.andWhere('folder.parentId IS NULL');
    }

    query.orderBy('folder.name', 'ASC');

    return query.getMany();
  }

  async findOne(userId: number, id: number) {
    const file = await this.fileRepository.findOne({ where: { id, userId } });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return file;
  }

  async findFolder(userId: number, id: number) {
    const folder = await this.folderRepository.findOne({ where: { id, userId } });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    return folder;
  }

  async createFile(userId: number, name: string, size: number, mimeType: string, parentId?: number) {
    const safeName = this.storageService.generateSafeFilename(name);
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException('User not found');
    }

    const file = this.fileRepository.create({
      name: safeName,
      storagePath: this.storageService.generatePath(userId, safeName),
      size,
      mimeType,
      isFolder: false,
      parentId,
      userId,
      user,
    });

    await this.fileRepository.save(file);
    await this.usersService.updateStorageUsed(userId, size);

    return file;
  }

  async createFolder(userId: number, name: string, parentId?: number) {
    const folder = this.folderRepository.create({
      name,
      isDeleted: false,
      parentId,
      userId,
    });

    await this.folderRepository.save(folder);

    const file = this.fileRepository.create({
      name,
      isFolder: true,
      isDeleted: false,
      parentId,
      userId,
      version: 1,
    });

    await this.fileRepository.save(file);

    return file;
  }

  async updateFile(userId: number, id: number, data: { name?: string; parentId?: number | null }) {
    const file = await this.findOne(userId, id);
    if (file.isFolder) {
      throw new BadRequestException('Cannot update folder via files endpoint');
    }

    if (data.name) {
      const safeName = this.storageService.generateSafeFilename(data.name);
      const oldPath = file.storagePath;
      const newPath = this.storageService.generatePath(userId, safeName);

      if (this.storageService.fileExists(oldPath)) {
        const dir = this.storageService.getStoragePath();
        const relativeOld = oldPath.replace(dir, '').replace(/^\//, '');
        const relativeNew = newPath.replace(dir, '').replace(/^\//, '');
        fs.renameSync(oldPath, newPath);
      }

      file.name = safeName;
      file.storagePath = newPath;
    }

    if (data.parentId !== undefined) {
      file.parentId = data.parentId;
    }

    await this.fileRepository.save(file);
    return file;
  }

  async updateFolder(userId: number, id: number, data: { name?: string; parentId?: number | null }) {
    const folder = await this.findFolder(userId, id);
    const file = await this.fileRepository.findOne({ where: { id, userId } });

    if (data.name) {
      folder.name = data.name;
      if (file) {
        file.name = data.name;
      }
    }

    if (data.parentId !== undefined) {
      folder.parentId = data.parentId;
      if (file) {
        file.parentId = data.parentId;
      }
    }

    await this.folderRepository.save(folder);
    if (file) {
      await this.fileRepository.save(file);
    }

    return file;
  }

  async removeFile(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    if (file.isFolder) {
      throw new BadRequestException('Cannot delete folder via files endpoint');
    }

    file.isDeleted = true;
    file.deletedAt = new Date();
    await this.fileRepository.save(file);

    return { message: 'File moved to trash' };
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

    return { message: 'Folder moved to trash' };
  }

  async restoreFile(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    file.isDeleted = false;
    file.deletedAt = null;
    await this.fileRepository.save(file);

    return { message: 'File restored' };
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

    return { message: 'Folder restored' };
  }

  async deleteFilePermanently(userId: number, id: number) {
    const file = await this.findOne(userId, id);
    const filePath = file.storagePath;

    if (this.storageService.fileExists(filePath)) {
      this.storageService.deleteFile(filePath);
    }

    await this.fileRepository.delete(id);
    await this.usersService.decrementStorageUsed(userId, file.size);

    return { message: 'File deleted permanently' };
  }

  async deleteFolderPermanently(userId: number, id: number) {
    const folder = await this.findFolder(userId, id);
    const file = await this.fileRepository.findOne({ where: { id, userId } });

    await this.folderRepository.delete(id);
    if (file) {
      await this.fileRepository.delete(id);
    }

    return { message: 'Folder deleted permanently' };
  }

  async getTrash(userId: number) {
    const files = await this.fileRepository.find({
      where: { userId, isDeleted: true, isFolder: false },
      order: { deletedAt: 'DESC' },
    });

    const folders = await this.folderRepository.find({
      where: { userId, isDeleted: true },
      order: { deletedAt: 'DESC' },
    });

    return { files, folders };
  }

  async emptyTrash(userId: number) {
    const files = await this.fileRepository.find({
      where: { userId, isDeleted: true, isFolder: false },
    });

    for (const file of files) {
      if (this.storageService.fileExists(file.storagePath)) {
        this.storageService.deleteFile(file.storagePath);
      }
      await this.usersService.decrementStorageUsed(userId, file.size);
    }

    await this.fileRepository.delete({ userId, isDeleted: true });
    await this.folderRepository.delete({ userId, isDeleted: true });

    return { message: 'Trash emptied' };
  }

  async copyFile(userId: number, id: number, targetParentId?: number) {
    const source = await this.findOne(userId, id);
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException('User not found');
    }

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
    file.parentId = targetParentId;
    await this.fileRepository.save(file);
    return file;
  }

  async search(userId: number, query: string) {
    const files = await this.fileRepository
      .createQueryBuilder('file')
      .where('file.userId = :userId', { userId })
      .andWhere('file.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('file.name ILIKE :query', { query: `%${query}%` })
      .orderBy('file.isFolder', 'DESC')
      .addOrderBy('file.name', 'ASC')
      .getMany();

    const folders = await this.folderRepository
      .createQueryBuilder('folder')
      .where('folder.userId = :userId', { userId })
      .andWhere('folder.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('folder.name ILIKE :query', { query: `%${query}%` })
      .orderBy('folder.name', 'ASC')
      .getMany();

    return { files, folders };
  }

  async getStorageInfo(userId: number) {
    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException('User not found');
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
