import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileTypeFromBuffer } from "file-type/core";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly maxFileSize: number;
  private readonly maxChunkSize: number;
  private readonly sessionTtlMs: number;
  private readonly allowedMimeTypes: string[];

  constructor(
    @InjectRepository(UploadSessionEntity)
    private uploadSessionRepository: Repository<UploadSessionEntity>,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    @InjectRepository(FolderEntity)
    private folderRepository: Repository<FolderEntity>,
    private storageService: StorageService,
    private usersService: UsersService,
    configService: { get: (key: string) => string | undefined },
  ) {
    const rawMaxFileSize = configService.get("MAX_FILE_SIZE");
    const rawMaxChunkSize = configService.get("MAX_CHUNK_SIZE");
    const rawSessionTtl = configService.get("UPLOAD_SESSION_TTL_HOURS");
    const rawAllowedMimeTypes = configService.get("ALLOWED_UPLOAD_MIME_TYPES");

    this.maxFileSize = rawMaxFileSize ? Number(rawMaxFileSize) : 0;
    this.maxChunkSize = rawMaxChunkSize
      ? Number(rawMaxChunkSize)
      : 100 * 1024 * 1024;
    this.sessionTtlMs = rawSessionTtl
      ? Number(rawSessionTtl) * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
    this.allowedMimeTypes = rawAllowedMimeTypes
      ? rawAllowedMimeTypes.split(",").map((type) => type.trim())
      : [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "application/pdf",
          "text/plain",
          "application/json",
          "application/javascript",
          "application/xml",
          "application/zip",
          "application/gzip",
          "video/mp4",
          "audio/mpeg",
          "audio/wav",
        ];
  }

  async createUploadSession(
    userId: number,
    filename: string,
    totalSize: number,
    chunkSize: number,
    parentId?: number,
  ): Promise<UploadSessionEntity> {
    if (parentId) {
      const folder = await this.folderRepository.findOne({
        where: { id: parentId, userId },
      });
      if (!folder) {
        throw new ForbiddenException(
          "Target folder not found or access denied",
        );
      }
    }

    if (totalSize <= 0) {
      throw new BadRequestException("Invalid total size");
    }

    if (chunkSize <= 0) {
      throw new BadRequestException("Invalid chunk size");
    }

    if (this.maxChunkSize > 0 && chunkSize > this.maxChunkSize) {
      throw new BadRequestException("Chunk size exceeds allowed maximum");
    }

    if (this.maxFileSize > 0 && totalSize > this.maxFileSize) {
      throw new BadRequestException("File size exceeds allowed maximum");
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new ForbiddenException("User not found");
    }

    const remainingQuota = user.storageQuota - user.storageUsed;
    if (totalSize > remainingQuota) {
      throw new ForbiddenException("Storage quota exceeded");
    }

    const totalChunks = Math.ceil(totalSize / chunkSize);
    if (totalChunks <= 0 || totalChunks > 100000) {
      throw new BadRequestException("Invalid chunk count");
    }

    const uploadId = uuidv4();
    const sessionTempDir = path.join(
      this.storageService.getTempPath(),
      uploadId,
    );

    if (!fs.existsSync(sessionTempDir)) {
      fs.mkdirSync(sessionTempDir, { recursive: true });
    }

    const expiresAt = new Date();
    expiresAt.setMilliseconds(expiresAt.getMilliseconds() + this.sessionTtlMs);

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
      status: "pending",
      expiresAt,
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
      throw new NotFoundException("Upload session not found");
    }

    if (session.expiresAt && new Date() > session.expiresAt) {
      throw new BadRequestException("Upload session expired");
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

    if (session.status === "completed" || session.status === "aborted") {
      throw new BadRequestException(`Upload session is ${session.status}`);
    }

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException("Invalid chunk index");
    }

    const remainingBytes =
      session.totalSize - chunkIndex * session.chunkSize;
    if (remainingBytes <= 0) {
      throw new BadRequestException("Invalid chunk position");
    }

    const maxAllowed =
      chunkIndex === session.totalChunks - 1
        ? remainingBytes
        : session.chunkSize;

    if (chunkData.length > maxAllowed) {
      throw new BadRequestException("Chunk size exceeds allowed limit");
    }

    const chunkPath = path.join(session.tempPath, String(chunkIndex));
    const tempPath = chunkPath + ".tmp";

    fs.writeFileSync(tempPath, chunkData);
    fs.renameSync(tempPath, chunkPath);

    const uploadedChunks = session.uploadedChunks;
    if (!uploadedChunks.includes(chunkIndex)) {
      uploadedChunks.push(chunkIndex);
    }

    const uploadedSize = uploadedChunks.reduce((sum, index) => {
      const chunkFile = path.join(session.tempPath, String(index));
      const chunkSize = fs.existsSync(chunkFile)
        ? fs.statSync(chunkFile).size
        : 0;
      return sum + chunkSize;
    }, 0);

    session.uploadedChunks = uploadedChunks;
    session.uploadedSize = uploadedSize;
    session.status = "uploading";

    return this.uploadSessionRepository.save(session);
  }

  async completeUpload(userId: number, uploadId: string): Promise<FileEntity> {
    const session = await this.getUploadSession(userId, uploadId);

    if (session.status === "completed") {
      throw new BadRequestException("Upload already completed");
    }

    if (session.status === "aborted") {
      throw new BadRequestException("Upload was aborted");
    }

    const uploadedSet = new Set(session.uploadedChunks);
    if (uploadedSet.size !== session.totalChunks) {
      throw new BadRequestException("Not all chunks have been uploaded");
    }

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.tempPath, String(i));
      if (!fs.existsSync(chunkPath)) {
        throw new BadRequestException(`Chunk ${i} is missing`);
      }
    }

    const safeFilename = this.storageService.generateSafeFilename(
      session.filename,
    );
    const finalPath = this.storageService.generatePath(userId, safeFilename);
    const writeStream = fs.createWriteStream(finalPath);

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(session.tempPath, String(i));
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }

    writeStream.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", (err) => reject(err));
    });

    const buffer = fs.readFileSync(finalPath);
    const detected = await fileTypeFromBuffer(buffer);
    const mimeType = detected?.mime || "application/octet-stream";

    if (!this.allowedMimeTypes.includes(mimeType)) {
      this.deleteTempFiles(session.tempPath);
      try {
        fs.unlinkSync(finalPath);
      } catch {
        // file may not exist
      }
      throw new BadRequestException(
        `File type ${mimeType} is not allowed for upload`,
      );
    }

    const queryRunner = this.fileRepository.manager.connection.createQueryRunner();
    await queryRunner.startTransaction();

    let file: FileEntity | undefined;

    try {
      const currentSession = await queryRunner.manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId },
      });

      if (!currentSession || currentSession.status === "completed") {
        throw new BadRequestException("Upload already completed by another request");
      }

      file = this.fileRepository.create({
        name: safeFilename,
        storagePath: finalPath,
        size: session.totalSize,
        mimeType,
        isFolder: false,
        parentId: session.parentId || undefined,
        userId,
      });

      await queryRunner.manager.save(file);
      await this.usersService.updateStorageUsed(userId, session.totalSize);

      currentSession.status = "completed";
      await queryRunner.manager.save(currentSession);

      await queryRunner.commitTransaction();

      this.deleteTempFiles(session.tempPath);

      return file;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
      }
      this.deleteTempFiles(session.tempPath);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async abortUpload(userId: number, uploadId: string): Promise<void> {
    const session = await this.getUploadSession(userId, uploadId);

    if (session.status === "completed") {
      throw new BadRequestException("Cannot abort a completed upload");
    }

    if (session.status === "aborted") {
      throw new BadRequestException("Upload already aborted");
    }

    this.deleteTempFiles(session.tempPath);

    session.status = "aborted";
    await this.uploadSessionRepository.save(session);
  }

  async listUploadSessions(userId: number): Promise<UploadSessionEntity[]> {
    return this.uploadSessionRepository.find({
      where: {
        userId,
        status: "pending",
      } as unknown as { userId: number; status: string },
      order: { createdAt: "DESC" },
    });
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = new Date();
    const expired = await this.uploadSessionRepository.find({
      where: {
        status: "pending",
      } as unknown as { status: string },
    });

    let cleaned = 0;
    for (const session of expired) {
      if (session.expiresAt && session.expiresAt < now) {
        this.deleteTempFiles(session.tempPath);
        await this.uploadSessionRepository.delete(session.id);
        cleaned++;
      }
    }

    return cleaned;
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
    } catch {
      this.logger.warn(`Failed to delete temp files at ${tempPath}`);
    }
  }
}
