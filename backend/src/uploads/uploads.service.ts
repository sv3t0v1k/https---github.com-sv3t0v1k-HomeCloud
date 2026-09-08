import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { UploadSessionEntity } from '../entities/upload-session.entity';
import { FileEntity } from '../entities/file.entity';
import { StorageService } from '../storage/storage.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectRepository(UploadSessionEntity)
    private uploadSessionRepository: Repository<UploadSessionEntity>,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    private storageService: StorageService,
    private usersService: UsersService,
  ) {}

  async createUploadSession(
    userId: number,
    filename: string,
    totalSize: number,
    chunkSize: number,
    parentId?: number,
  ): Promise<UploadSessionEntity> {
    const uploadId = uuidv4();
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const sessionTempDir = path.join(
      this.storageService.getTempPath(),
      uploadId,
    );

    if (!fs.existsSync(sessionTempDir)) {
      fs.mkdirSync(sessionTempDir, { recursive: true });
    }

    const session = this.uploadSessionRepository.create({
      uploadId,
      filename,
      totalSize,
      chunkSize,
      totalChunks,
      uploadedChunks: [],
      uploadedSize: 0,
      tempPath: sessionTempDir,
      parentId,
      status: 'pending',
      userId,
    });

    return this.uploadSessionRepository.save(session);
  }

  async getUploadSession(
    userId: number,
    uploadId: string,
  ): Promise<UploadSessionEntity> {
    const session = await this.uploadSessionRepository.findOne({
      where: { uploadId, userId },
    });

    if (!session) {
      throw new NotFoundException('Upload session not found');
    }

    return session;
  }

  async uploadChunk(
    userId: number,
    uploadId: string,
    chunkIndex: number,
    chunkData: Buffer,
  ): Promise<UploadSessionEntity> {
    const session = await this.getUploadSession(userId, uploadId);

    if (session.status === 'completed' || session.status === 'aborted') {
      throw new BadRequestException(
        `Upload session is ${session.status}`,
      );
    }

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException('Invalid chunk index');
    }

    const chunkPath = path.join(session.tempPath, String(chunkIndex));
    fs.writeFileSync(chunkPath, chunkData);

    const uploadedChunks = session.uploadedChunks;
    if (!uploadedChunks.includes(chunkIndex)) {
      uploadedChunks.push(chunkIndex);
    }

    const uploadedSize = uploadedChunks.reduce((sum, index) => {
      const chunkPath = path.join(session.tempPath, String(index));
      const chunkSize = fs.existsSync(chunkPath)
        ? fs.statSync(chunkPath).size
        : 0;
      return sum + chunkSize;
    }, 0);

    session.uploadedChunks = uploadedChunks;
    session.uploadedSize = uploadedSize;
    session.status = 'uploading';

    return this.uploadSessionRepository.save(session);
  }

  async completeUpload(
    userId: number,
    uploadId: string,
  ): Promise<FileEntity> {
    const session = await this.getUploadSession(userId, uploadId);

    if (session.status === 'completed') {
      throw new BadRequestException('Upload already completed');
    }

    if (session.status === 'aborted') {
      throw new BadRequestException('Upload was aborted');
    }

    if (session.uploadedChunks.length !== session.totalChunks) {
      throw new BadRequestException('Not all chunks have been uploaded');
    }

    const safeFilename = this.storageService.generateSafeFilename(
      session.filename,
    );
    const finalPath = this.storageService.generatePath(userId, safeFilename);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.tempPath, String(i));
      if (!fs.existsSync(chunkPath)) {
        throw new BadRequestException(`Chunk ${i} is missing`);
      }
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }

    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });

    const ext = path.extname(session.filename).toLowerCase();
    const mimeType = this.getMimeType(ext);

    const file = this.fileRepository.create({
      name: safeFilename,
      storagePath: finalPath,
      size: session.totalSize,
      mimeType,
      isFolder: false,
      parentId: session.parentId || undefined,
      userId,
    });

    await this.fileRepository.save(file);
    await this.usersService.updateStorageUsed(userId, session.totalSize);

    session.status = 'completed';
    await this.uploadSessionRepository.save(session);

    this.deleteTempFiles(session.tempPath);

    return file;
  }

  async abortUpload(
    userId: number,
    uploadId: string,
  ): Promise<void> {
    const session = await this.getUploadSession(userId, uploadId);

    if (session.status === 'completed') {
      throw new BadRequestException('Cannot abort a completed upload');
    }

    if (session.status === 'aborted') {
      throw new BadRequestException('Upload already aborted');
    }

    this.deleteTempFiles(session.tempPath);

    session.status = 'aborted';
    await this.uploadSessionRepository.save(session);
  }

  async listUploadSessions(
    userId: number,
  ): Promise<UploadSessionEntity[]> {
    return this.uploadSessionRepository.find({
      where: {
        userId,
        status: ['pending', 'uploading'] as any,
      },
      order: { createdAt: 'DESC' },
    });
  }

  private deleteTempFiles(tempPath: string): void {
    try {
      if (fs.existsSync(tempPath)) {
        const entries = fs.readdirSync(tempPath);
        for (const entry of entries) {
          const entryPath = path.join(tempPath, entry);
          fs.unlinkSync(entryPath);
        }
        fs.rmdirSync(tempPath);
      }
    } catch (error) {
      this.logger.warn(`Failed to delete temp files at ${tempPath}`);
    }
  }

  private getMimeType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }
}
