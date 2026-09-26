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
import { pipeline } from "stream/promises";
import { fileTypeFromBuffer } from "./file-type.loader";
import { v4 as uuidv4 } from "uuid";
import { ConfigService } from "@nestjs/config";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { EntityManager } from "typeorm";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import {
  IngressChunkFile,
  cleanupIngressFile,
  getIngressRoot,
  parseMaxChunkSize,
} from "./chunk-ingress";

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly maxFileSize: number;
  private readonly maxTotalSize: number;
  private readonly maxChunkSize: number;
  private readonly sessionTtlMs: number;
  private readonly allowedMimeTypes: string[];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly DEFAULT_MAX_FILE_SIZE = 1024 * 1024 * 1024;
  private static readonly DEFAULT_MAX_TOTAL_SIZE = 10 * 1024 * 1024 * 1024;
  private static readonly DEFAULT_SESSION_TTL_HOURS = 24;

  constructor(
    @InjectRepository(UploadSessionEntity)
    private uploadSessionRepository: Repository<UploadSessionEntity>,
    @InjectRepository(FileEntity)
    private fileRepository: Repository<FileEntity>,
    @InjectRepository(FolderEntity)
    private folderRepository: Repository<FolderEntity>,
    private storageService: StorageService,
    private usersService: UsersService,
    private configService: ConfigService,
  ) {
    const rawMaxFileSize = configService.get("MAX_FILE_SIZE");
    const rawMaxTotalSize = configService.get("MAX_TOTAL_SIZE");
    const rawMaxChunkSize = configService.get("MAX_CHUNK_SIZE");
    const rawSessionTtl = configService.get("UPLOAD_SESSION_TTL_HOURS");
    const rawAllowedMimeTypes = configService.get("ALLOWED_UPLOAD_MIME_TYPES");

    this.maxFileSize = this.parseSizeEnv(rawMaxFileSize, "MAX_FILE_SIZE", {
      allowZero: true,
      defaultValue: UploadsService.DEFAULT_MAX_FILE_SIZE,
    });
    this.maxTotalSize = this.parseSizeEnv(rawMaxTotalSize, "MAX_TOTAL_SIZE", {
      allowZero: false,
      defaultValue: UploadsService.DEFAULT_MAX_TOTAL_SIZE,
    });
    this.maxChunkSize = parseMaxChunkSize(rawMaxChunkSize);
    this.sessionTtlMs = this.parseTtlEnv(
      rawSessionTtl,
      "UPLOAD_SESSION_TTL_HOURS",
      {
        defaultValue: UploadsService.DEFAULT_SESSION_TTL_HOURS,
      },
    );

    if (this.maxFileSize > 0 && this.maxTotalSize < this.maxFileSize) {
      throw new BadRequestException(
        "MAX_TOTAL_SIZE must be >= MAX_FILE_SIZE when MAX_FILE_SIZE > 0",
      );
    }

    this.allowedMimeTypes = rawAllowedMimeTypes
      ? rawAllowedMimeTypes.split(",").map((type: string) => type.trim())
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

  private parseSizeEnv(
    raw: unknown,
    envName: string,
    options: { allowZero: boolean; defaultValue: number },
  ): number {
    if (raw === undefined || raw === null) {
      return options.defaultValue;
    }
    const str = String(raw).trim();
    if (str === "") {
      throw new BadRequestException(`${envName} is set but empty`);
    }
    // Reject non-numeric strings like "abc", "1.5", "1e10" (unless it's a safe integer)
    const num = Number(str);
    if (!Number.isFinite(num) || !Number.isSafeInteger(num) || num < 0) {
      throw new BadRequestException(
        `${envName} must be a non-negative safe integer, got "${str}"`,
      );
    }
    // Additional check: reject strings that don't represent the integer exactly
    // (e.g., "1.0" -> 1 is fine, but "1.5" -> NaN already caught above)
    if (!options.allowZero && num === 0) {
      throw new BadRequestException(`${envName} must be > 0`);
    }
    return num;
  }

  private parseTtlEnv(
    raw: unknown,
    envName: string,
    options: { defaultValue: number },
  ): number {
    if (raw === undefined || raw === null) {
      return options.defaultValue * 60 * 60 * 1000;
    }
    const str = String(raw).trim();
    if (str === "") {
      throw new BadRequestException(`${envName} is set but empty`);
    }
    const num = Number(str);
    if (!Number.isFinite(num) || !Number.isSafeInteger(num) || num <= 0) {
      throw new BadRequestException(
        `${envName} must be a positive safe integer (hours), got "${str}"`,
      );
    }
    return num * 60 * 60 * 1000;
  }

  /**
   * Strict validation for request-supplied size fields (totalSize, chunkSize).
   * Rejects NaN, Infinity, fractions, negatives, zero, and unsafe integers.
   */
  private static validateSafePositiveInteger(
    value: unknown,
    label: string,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BadRequestException(
        `${label} must be a finite number, got "${String(value)}"`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new BadRequestException(
        `${label} must be a safe integer, got "${value}"`,
      );
    }
    if (value <= 0) {
      throw new BadRequestException(`${label} must be > 0`);
    }
    return value;
  }

  private async withTransaction<T>(
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const queryRunner =
      this.uploadSessionRepository.manager.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await fn(queryRunner.manager);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
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

    totalSize = UploadsService.validateSafePositiveInteger(
      totalSize,
      "totalSize",
    );
    chunkSize = UploadsService.validateSafePositiveInteger(
      chunkSize,
      "chunkSize",
    );

    if (chunkSize > this.maxChunkSize) {
      throw new BadRequestException("Chunk size exceeds allowed maximum");
    }

    // MAX_FILE_SIZE=0 means "no file size limit" (explicit opt-in).
    if (this.maxFileSize > 0 && totalSize > this.maxFileSize) {
      throw new BadRequestException("File size exceeds allowed maximum");
    }

    if (this.maxTotalSize > 0 && totalSize > this.maxTotalSize) {
      throw new BadRequestException(
        "Total upload size exceeds allowed maximum",
      );
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

    const expiresAt = new Date();
    expiresAt.setMilliseconds(expiresAt.getMilliseconds() + this.sessionTtlMs);

    const savedSession = await this.withTransaction(async (manager) => {
      // Lock the user row to serialize quota checks for this user.
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        lock: { mode: "pessimistic_write" },
      });
      if (!user) {
        throw new ForbiddenException("User not found");
      }

      // Sum totalSize of active (pending/uploading) sessions for this user.
      const activeResult = await manager
        .createQueryBuilder(UploadSessionEntity, "session")
        .select("COALESCE(SUM(session.totalSize), 0)", "activeTotal")
        .where("session.userId = :userId", { userId })
        .andWhere("session.status IN (:...statuses)", {
          statuses: ["pending", "uploading"],
        })
        .getRawOne();
      const activeTotal = Number(activeResult?.activeTotal ?? 0) || 0;

      const quota = user.storageQuota;
      if (quota > 0 && user.storageUsed + activeTotal + totalSize > quota) {
        throw new ForbiddenException("Storage quota exceeded");
      }

      const session = manager.create(UploadSessionEntity, {
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

      return await manager.save(session);
    });

    // Create the temp directory AFTER the transaction commits.
    // This prevents orphaned directories when DB save fails (O-15).
    try {
      if (!fs.existsSync(sessionTempDir)) {
        fs.mkdirSync(sessionTempDir, { recursive: true });
      }
    } catch (err) {
      this.logger.error(
        `Failed to create temp dir for session ${uploadId}: ${(err as Error).message}`,
      );
      // Best-effort cleanup of the orphaned session row.
      await this.uploadSessionRepository.delete(savedSession!.id);
      throw new BadRequestException("Failed to prepare upload session");
    }

    return savedSession!;
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
    chunkData: Buffer | IngressChunkFile,
  ): Promise<UploadSessionEntity> {
    // Validate chunkIndex as a finite safe nonnegative integer.
    if (
      typeof chunkIndex !== "number" ||
      !Number.isFinite(chunkIndex) ||
      !Number.isSafeInteger(chunkIndex) ||
      chunkIndex < 0
    ) {
      throw new BadRequestException(
        `chunkIndex must be a non-negative safe integer, got "${String(chunkIndex)}"`,
      );
    }

    let ingressPath: string | null = null;
    const chunkSize = Buffer.isBuffer(chunkData)
      ? chunkData.length
      : chunkData.size;

    try {
      if (!Buffer.isBuffer(chunkData)) {
        ingressPath = this.validateIngressChunk(chunkData);
      }
      return await this.withTransaction(async (manager) => {
        const session = await manager.findOne(UploadSessionEntity, {
          where: { uploadId, userId },
          lock: { mode: "pessimistic_write" },
        });

        if (!session) {
          throw new NotFoundException("Upload session not found");
        }

        if (session.expiresAt && new Date() > session.expiresAt) {
          throw new BadRequestException("Upload session expired");
        }

        if (session.status === "completed" || session.status === "aborted") {
          throw new BadRequestException(`Upload session is ${session.status}`);
        }

        if (chunkIndex >= session.totalChunks) {
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

        if (chunkSize > maxAllowed) {
          throw new BadRequestException("Chunk size exceeds allowed limit");
        }

        const chunkPath = path.join(session.tempPath, String(chunkIndex));
        const tempPath = chunkPath + ".tmp";

        // Reconcile uploadedChunks with actual files on disk before proceeding.
        // Retain only unique valid indices whose chunk files actually exist.
        // If DB has an index whose file is missing, remove it.
        // If a chunk file exists but its index is absent, add it.
        const dbChunks = Array.from(new Set(session.uploadedChunks || []));
        const validDbChunks = dbChunks.filter((idx) => {
          if (idx < 0 || idx >= session.totalChunks) return false;
          const p = path.join(session.tempPath, String(idx));
          return fs.existsSync(p);
        });
        // Check for orphaned chunk files on disk not reflected in DB.
        const existingDiskChunks: number[] = [];
        for (let i = 0; i < session.totalChunks; i++) {
          const p = path.join(session.tempPath, String(i));
          if (fs.existsSync(p)) {
            existingDiskChunks.push(i);
          }
        }
        const reconciledChunks = Array.from(
          new Set([...validDbChunks, ...existingDiskChunks]),
        ).sort((a, b) => a - b);

        // Recompute uploadedSize from reconciled chunk files.
        let uploadedSize = 0;
        for (const idx of reconciledChunks) {
          const p = path.join(session.tempPath, String(idx));
          try {
            uploadedSize += fs.statSync(p).size;
          } catch {
            // File vanished during stat; ignore (will be cleaned up on next reconcile).
          }
        }

        // Persist reconciled state if it differs from current session state.
        const needsReconcile =
          reconciledChunks.length !== (session.uploadedChunks || []).length ||
          reconciledChunks.some(
            (v, i) => v !== (session.uploadedChunks || [])[i],
          ) ||
          uploadedSize !== session.uploadedSize;
        if (needsReconcile) {
          session.uploadedChunks = reconciledChunks;
          session.uploadedSize = uploadedSize;
          await manager.save(session);
        }

        // Idempotency: if this exact chunk index already exists on disk with
        // matching content, treat the upload as a no-op and return success.
        if (fs.existsSync(chunkPath)) {
          const existingSize = fs.statSync(chunkPath).size;
          if (existingSize === chunkSize) {
            const isEqual = Buffer.isBuffer(chunkData)
              ? await this.fileEqualsBuffer(chunkPath, chunkData)
              : await this.filesEqual(chunkPath, ingressPath!);
            if (isEqual) {
              // Exact duplicate: synchronize DB state and return success.
              session.status = "uploading";
              await manager.save(session);
              return session;
            }
            // Different content with same size — reject to avoid silent overwrite.
            throw new BadRequestException(
              `Chunk ${chunkIndex} already uploaded with different content`,
            );
          }
          // Different size — reject to avoid silent overwrite.
          throw new BadRequestException(
            `Chunk ${chunkIndex} already uploaded with different content`,
          );
        }

        // Atomic write: .tmp then rename to final chunk path.
        // Remove .tmp on any write/rename failure.
        try {
          if (Buffer.isBuffer(chunkData)) {
            await fs.promises.writeFile(tempPath, chunkData);
          } else {
            await fs.promises.rename(ingressPath!, tempPath);
          }
          fs.renameSync(tempPath, chunkPath);
        } catch (writeErr) {
          // Clean up temp file on failure.
          if (fs.existsSync(tempPath)) {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              // Ignore cleanup errors.
            }
          }
          throw writeErr;
        }

        // Update normalized uploadedChunks and uploadedSize.
        const newUploadedChunks = Array.from(
          new Set([...reconciledChunks, chunkIndex]),
        ).sort((a, b) => a - b);
        let newUploadedSize = uploadedSize + chunkSize;
        // Recompute from disk to be absolutely sure (handles edge cases).
        newUploadedSize = 0;
        for (const idx of newUploadedChunks) {
          const p = path.join(session.tempPath, String(idx));
          try {
            newUploadedSize += fs.statSync(p).size;
          } catch {
            // Should not happen for chunks we just verified.
          }
        }

        session.uploadedChunks = newUploadedChunks;
        session.uploadedSize = newUploadedSize;
        session.status = "uploading";

        await manager.save(session);

        return session;
      });
    } finally {
      if (!Buffer.isBuffer(chunkData)) {
        cleanupIngressFile(
          chunkData.path,
          this.storageService.getTempPath(),
          (error) =>
            this.logger.warn(`Failed to clean ingress file: ${error.message}`),
        );
      }
    }
  }

  private validateIngressChunk(chunk: IngressChunkFile): string {
    const ingressRoot = getIngressRoot(this.storageService.getTempPath());
    const resolved = path.resolve(chunk.path);
    if (!resolved.startsWith(ingressRoot + path.sep)) {
      throw new BadRequestException("Invalid ingress chunk path");
    }
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(resolved);
    } catch {
      throw new BadRequestException("Ingress chunk file is missing");
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new BadRequestException("Ingress chunk must be a regular file");
    }
    if (stats.size !== chunk.size || stats.size > this.maxChunkSize) {
      throw new BadRequestException("Invalid ingress chunk size");
    }
    return resolved;
  }

  private async fileEqualsBuffer(
    filePath: string,
    expected: Buffer,
  ): Promise<boolean> {
    const handle = await fs.promises.open(filePath, "r");
    const block = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    try {
      while (offset < expected.length) {
        const { bytesRead } = await handle.read(
          block,
          0,
          Math.min(block.length, expected.length - offset),
          offset,
        );
        if (bytesRead === 0) return false;
        if (
          !block
            .subarray(0, bytesRead)
            .equals(expected.subarray(offset, offset + bytesRead))
        ) {
          return false;
        }
        offset += bytesRead;
      }
      return offset === expected.length;
    } finally {
      await handle.close();
    }
  }

  private async filesEqual(
    leftPath: string,
    rightPath: string,
  ): Promise<boolean> {
    const [left, right] = await Promise.all([
      fs.promises.open(leftPath, "r"),
      fs.promises.open(rightPath, "r"),
    ]);
    const leftBlock = Buffer.allocUnsafe(64 * 1024);
    const rightBlock = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    try {
      for (;;) {
        const [leftRead, rightRead] = await Promise.all([
          left.read(leftBlock, 0, leftBlock.length, offset),
          right.read(rightBlock, 0, rightBlock.length, offset),
        ]);
        if (leftRead.bytesRead !== rightRead.bytesRead) return false;
        if (leftRead.bytesRead === 0) return true;
        if (
          !leftBlock
            .subarray(0, leftRead.bytesRead)
            .equals(rightBlock.subarray(0, rightRead.bytesRead))
        ) {
          return false;
        }
        offset += leftRead.bytesRead;
      }
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  }

  async completeUpload(userId: number, uploadId: string): Promise<FileEntity> {
    let sessionTempPath: string | null = null;
    let finalPathForCleanup: string | null = null;

    try {
      const result = await this.withTransaction(async (manager) => {
        const session = await manager.findOne(UploadSessionEntity, {
          where: { uploadId, userId },
          lock: { mode: "pessimistic_write" },
        });

        if (!session) {
          throw new NotFoundException("Upload session not found");
        }

        // Capture tempPath early for cleanup on any failure.
        sessionTempPath = session.tempPath;

        if (session.expiresAt && new Date() > session.expiresAt) {
          throw new BadRequestException("Upload session expired");
        }

        // If session is already completed, return existing file (idempotent).
        if (session.status === "completed") {
          const existing = await manager.findOne(FileEntity, {
            where: { uploadId, userId },
          });
          if (existing) {
            return { file: existing, session };
          }
          throw new BadRequestException(
            "Upload already completed but file record missing",
          );
        }

        if (session.status === "aborted") {
          throw new BadRequestException("Upload was aborted");
        }

        // Reconcile uploadedChunks with actual files on disk before final checks.
        const dbChunks = Array.from(new Set(session.uploadedChunks || []));
        const validDbChunks = dbChunks.filter((idx) => {
          if (idx < 0 || idx >= session.totalChunks) return false;
          const p = path.join(session.tempPath, String(idx));
          return fs.existsSync(p);
        });
        const existingDiskChunks: number[] = [];
        for (let i = 0; i < session.totalChunks; i++) {
          const p = path.join(session.tempPath, String(i));
          if (fs.existsSync(p)) {
            existingDiskChunks.push(i);
          }
        }
        const reconciledChunks = Array.from(
          new Set([...validDbChunks, ...existingDiskChunks]),
        ).sort((a, b) => a - b);

        let uploadedSize = 0;
        for (const idx of reconciledChunks) {
          const p = path.join(session.tempPath, String(idx));
          try {
            uploadedSize += fs.statSync(p).size;
          } catch {
            // Ignore stat errors.
          }
        }

        const needsReconcile =
          reconciledChunks.length !== (session.uploadedChunks || []).length ||
          reconciledChunks.some(
            (v, i) => v !== (session.uploadedChunks || [])[i],
          ) ||
          uploadedSize !== session.uploadedSize;
        if (needsReconcile) {
          session.uploadedChunks = reconciledChunks;
          session.uploadedSize = uploadedSize;
          await manager.save(session);
        }

        // Verify all chunks are present on disk after reconciliation.
        for (let i = 0; i < session.totalChunks; i++) {
          const chunkPath = path.join(session.tempPath, String(i));
          if (!fs.existsSync(chunkPath)) {
            throw new BadRequestException(`Chunk ${i} is missing`);
          }
        }

        // Check for existing file by uploadId+userId BEFORE assembling.
        const existingFile = await manager.findOne(FileEntity, {
          where: { uploadId, userId },
        });

        // Deterministic final path: userId + uploadId + session.filename (stable).
        // Never use generateSafeFilename output here.
        const finalPath = this.storageService.generateFinalPath(
          userId,
          uploadId,
          session.filename,
        );

        // Capture finalPath for cleanup on failure.
        finalPathForCleanup = finalPath;

        // If session is pending/uploading but file already exists, mark session
        // completed without incrementing quota. Return after commit.
        if (existingFile) {
          session.status = "completed";
          await manager.save(session);
          return { file: existingFile, session, finalPath };
        }

        // No existing file: assemble at deterministic path.
        // Remove any stale partial file from a previous failed attempt.
        if (fs.existsSync(finalPath)) {
          fs.unlinkSync(finalPath);
        }

        let actualSize = 0;
        const totalChunks = session.totalChunks;
        const tempPath = session.tempPath;
        const writeStream = fs.createWriteStream(finalPath, { flags: "wx" });

        try {
          async function* chunkSequence() {
            for (let i = 0; i < totalChunks; i++) {
              const chunkPath = path.join(tempPath, String(i));
              const chunkStats = await fs.promises.lstat(chunkPath);
              if (!chunkStats.isFile()) {
                throw new BadRequestException(
                  `Chunk ${i} is not a regular file`,
                );
              }
              actualSize += chunkStats.size;
              yield* fs.createReadStream(chunkPath);
            }
          }

          await pipeline(chunkSequence(), writeStream);
        } catch (err) {
          if (!writeStream.destroyed) {
            writeStream.destroy();
          }
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
          throw err;
        }

        // Verify actual assembled size matches declared totalSize.
        if (actualSize !== session.totalSize) {
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
          throw new BadRequestException(
            `Actual file size ${actualSize} does not match declared totalSize ${session.totalSize}`,
          );
        }

        // Verify each chunk matches its expected size range.
        for (let i = 0; i < session.totalChunks; i++) {
          const chunkPath = path.join(session.tempPath, String(i));
          const chunkStats = fs.statSync(chunkPath);
          const expectedSize =
            i === session.totalChunks - 1
              ? session.totalSize - i * session.chunkSize
              : session.chunkSize;
          if (chunkStats.size !== expectedSize) {
            if (fs.existsSync(finalPath)) {
              fs.unlinkSync(finalPath);
            }
            throw new BadRequestException(
              `Chunk ${i} size ${chunkStats.size} does not match expected ${expectedSize}`,
            );
          }
        }

        // MIME detection from header only (memory-safe for large files).
        const HEADER_SIZE = 4100;
        const stats = fs.statSync(finalPath);
        const headerSize = Math.min(stats.size, HEADER_SIZE);
        const fd = fs.openSync(finalPath, "r");
        const headerBuffer = Buffer.alloc(headerSize);
        fs.readSync(fd, headerBuffer, 0, headerSize, null);
        fs.closeSync(fd);
        const detected = await fileTypeFromBuffer(headerBuffer);
        const mimeType = detected?.mime || "application/octet-stream";

        if (!this.allowedMimeTypes.includes(mimeType)) {
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
          throw new BadRequestException(
            `File type ${mimeType} is not allowed for upload`,
          );
        }

        // Create the file entity and update storage quota atomically.
        const file = manager.create(FileEntity, {
          name: session.filename,
          storagePath: finalPath,
          size: actualSize,
          mimeType,
          isFolder: false,
          parentId: session.parentId || undefined,
          userId,
          uploadId,
        });

        await manager.save(file);
        await this.usersService.updateStorageUsed(userId, actualSize, manager);

        session.status = "completed";
        await manager.save(session);

        return { file, session, finalPath };
      });

      // Cleanup temp files after successful commit. Never delete committed file.
      try {
        if (sessionTempPath) {
          this.deleteTempFiles(sessionTempPath);
        }
      } catch {
        // File is already committed; do not delete it.
      }

      return result.file;
    } catch (error) {
      // Cleanup temp files and any assembled final file on failure.
      try {
        if (sessionTempPath) {
          this.deleteTempFiles(sessionTempPath);
        }
        if (finalPathForCleanup && fs.existsSync(finalPathForCleanup)) {
          fs.unlinkSync(finalPathForCleanup);
        }
      } catch {
        // Ignore cleanup errors on failure path.
      }
      throw error;
    }
  }

  async abortUpload(userId: number, uploadId: string): Promise<void> {
    await this.withTransaction(async (manager) => {
      const session = await manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId },
        lock: { mode: "pessimistic_write" },
      });

      if (!session) {
        throw new NotFoundException("Upload session not found");
      }

      if (session.status === "completed") {
        throw new BadRequestException("Cannot abort a completed upload");
      }

      if (session.status === "aborted") {
        throw new BadRequestException("Upload already aborted");
      }

      this.deleteTempFiles(session.tempPath);

      session.status = "aborted";
      await manager.save(session);
    });
  }

  async listUploadSessions(userId: number): Promise<UploadSessionEntity[]> {
    return this.uploadSessionRepository.find({
      where: {
        userId,
        status: "pending",
      },
      order: { createdAt: "DESC" },
    });
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = new Date();
    const sessions = await this.uploadSessionRepository.find({
      where: [{ status: "pending" }, { status: "uploading" }],
    });

    let cleaned = 0;
    for (const session of sessions) {
      if (session.expiresAt && session.expiresAt < now) {
        this.deleteTempFiles(session.tempPath);
        await this.uploadSessionRepository.delete(session.id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Clean up orphaned temp directories that have no corresponding DB row.
   * Runs on startup to recover from crashes during session creation (O-15).
   *
   * Classification is performed with a CONSTANT number of DB queries: one
   * `SELECT DISTINCT "tempPath"` fetches every currently referenced temp path
   * into an in-memory Set, and each enumerated filesystem entry is then
   * classified by exact string membership. Query count does not grow with
   * directory count, unlike the previous per-directory `findOne` loop.
   */
  async cleanupOrphanedTempDirs(): Promise<number> {
    const tempRoot = this.storageService.getTempPath();
    if (!fs.existsSync(tempRoot)) {
      return 0;
    }
    const ingressRoot = getIngressRoot(tempRoot);
    fs.mkdirSync(ingressRoot, { recursive: true });
    this.cleanupStaleIngressFiles(ingressRoot);

    let referenced: Set<string>;
    try {
      const rows = await this.uploadSessionRepository
        .createQueryBuilder("session")
        .select("session.tempPath", "tempPath")
        .getRawMany<{ tempPath: string }>();
      referenced = new Set(rows.map((row) => row.tempPath));
    } catch (err) {
      this.logger.error(
        `Orphaned temp dir cleanup failed: ${(err as Error).message}`,
      );
      return 0;
    }

    let cleaned = 0;
    try {
      const entries = fs.readdirSync(tempRoot);
      for (const entry of entries) {
        const entryPath = path.join(tempRoot, entry);
        if (path.resolve(entryPath) === ingressRoot) {
          continue;
        }
        if (!fs.statSync(entryPath).isDirectory()) {
          continue;
        }

        // A directory is orphaned iff no upload_session references its exact
        // tempPath. Exact string membership — no LIKE/prefix matching.
        if (referenced.has(entryPath)) {
          continue;
        }

        this.deleteTempFiles(entryPath);
        cleaned++;
      }
    } catch (err) {
      this.logger.error(
        `Orphaned temp dir cleanup failed: ${(err as Error).message}`,
      );
    }

    return cleaned;
  }

  private cleanupStaleIngressFiles(ingressRoot: string): void {
    const cutoff = Date.now() - this.sessionTtlMs;
    for (const name of fs.readdirSync(ingressRoot)) {
      const candidate = path.join(ingressRoot, name);
      try {
        const stats = fs.lstatSync(candidate);
        if (
          (stats.isFile() || stats.isSymbolicLink()) &&
          stats.mtimeMs < cutoff
        ) {
          cleanupIngressFile(candidate, this.storageService.getTempPath());
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
          this.logger.warn(`Failed to inspect stale ingress file ${candidate}`);
        }
      }
    }
  }

  async onModuleInit(): Promise<void> {
    // Run cleanup on startup to handle sessions left by crashed instances.
    try {
      const cleaned = await this.cleanupOrphanedTempDirs();
      if (cleaned > 0) {
        this.logger.log(
          `Startup cleanup: removed ${cleaned} orphaned temp directories`,
        );
      }
    } catch (err) {
      this.logger.error(`Startup cleanup failed: ${(err as Error).message}`);
    }

    try {
      const cleaned = await this.cleanupExpiredSessions();
      if (cleaned > 0) {
        this.logger.log(
          `Startup cleanup: removed ${cleaned} expired upload sessions`,
        );
      }
    } catch (err) {
      this.logger.error(`Startup cleanup failed: ${(err as Error).message}`);
    }

    // Start periodic cleanup (every 1 hour).
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpiredSessions().catch((err) =>
          this.logger.error(
            `Periodic cleanup failed: ${(err as Error).message}`,
          ),
        );
      },
      60 * 60 * 1000,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private deleteTempFiles(tempPath: string): void {
    try {
      if (!tempPath || !fs.existsSync(tempPath)) {
        return;
      }
      fs.rmSync(tempPath, { recursive: true, force: true });
    } catch {
      this.logger.warn(`Failed to delete temp files at ${tempPath}`);
    }
  }
}
