import { parseDatabaseSize } from "../common/database-size";
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
import { createHash } from "crypto";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { pipeline } from "stream/promises";
import { fileTypeFromBuffer } from "./file-type.loader";
import { isUtf8PlainText } from "./utf8-plain-text";
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
  private readonly maxUploadChunks: number;
  private readonly sessionTtlMs: number;
  private readonly allowedMimeTypes: string[];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly DEFAULT_MAX_FILE_SIZE = 1099511627776;
  private static readonly DEFAULT_MAX_TOTAL_SIZE = 2199023255552;
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
      allowZero: true,
      defaultValue: UploadsService.DEFAULT_MAX_TOTAL_SIZE,
    });
    this.maxChunkSize = parseMaxChunkSize(rawMaxChunkSize);
    this.maxUploadChunks = this.parseSizeEnv(
      configService.get("MAX_UPLOAD_CHUNKS"),
      "MAX_UPLOAD_CHUNKS",
      { allowZero: false, defaultValue: 100000 },
    );
    if (this.maxUploadChunks > 2147483647)
      throw new BadRequestException(
        "MAX_UPLOAD_CHUNKS exceeds database integer capacity",
      );
    this.sessionTtlMs = this.parseTtlEnv(
      rawSessionTtl,
      "UPLOAD_SESSION_TTL_HOURS",
      {
        defaultValue: UploadsService.DEFAULT_SESSION_TTL_HOURS,
      },
    );

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
    if (totalChunks <= 0 || totalChunks > this.maxUploadChunks) {
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
      const activeTotal = parseDatabaseSize(activeResult?.activeTotal);
      if (
        this.maxTotalSize > 0 &&
        parseDatabaseSize(activeTotal + totalSize) > this.maxTotalSize
      ) {
        throw new BadRequestException(
          "Total upload size exceeds allowed maximum",
        );
      }

      const quota = parseDatabaseSize(user.storageQuota);
      const used = parseDatabaseSize(user.storageUsed);
      const reserved = parseDatabaseSize(used + activeTotal);
      const nextUsed = parseDatabaseSize(reserved + totalSize);
      if (nextUsed > quota) {
        throw new ForbiddenException("Storage quota exceeded");
      }

      const session = manager.create(UploadSessionEntity, {
        uploadId,
        filename,
        totalSize,
        chunkSize,
        totalChunks,
        uploadedCount: 0,
        accountingInitialized: true,
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
    } catch {
      this.logger.error("Failed to create temp dir for session");
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

        if (chunkSize !== maxAllowed) {
          throw new BadRequestException(
            "Chunk size does not match expected size",
          );
        }

        const chunkPath = path.join(session.tempPath, String(chunkIndex));
        const tempPath = chunkPath + "." + uuidv4() + ".tmp";

        // Legacy sessions hydrate only once; new sessions never traverse the prefix.
        if (!session.accountingInitialized)
          await this.hydrateLegacyAccounting(manager, session);
        const incomingHash = Buffer.isBuffer(chunkData)
          ? createHash("sha256").update(chunkData).digest("hex")
          : await this.hashFile(ingressPath!);
        const record = await manager.getRepository(UploadChunkEntity).findOne({
          where: { sessionId: session.id, chunkIndex },
        });
        if (
          record &&
          (record.byteSize !== chunkSize || record.sha256 !== incomingHash)
        ) {
          throw new BadRequestException(
            `Chunk ${chunkIndex} already uploaded with different content`,
          );
        }
        let diskExists = false;
        try {
          const stats = await fs.promises.lstat(chunkPath);
          diskExists = true;
          if (
            !stats.isFile() ||
            stats.isSymbolicLink() ||
            stats.size !== chunkSize ||
            (await this.hashFile(chunkPath)) !== incomingHash
          ) {
            throw new BadRequestException(
              `Chunk ${chunkIndex} already uploaded with different content`,
            );
          }
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        if (!diskExists) {
          // Sync contents before publication and sync the directory before DB commit.
          // A crash before metadata commit leaves an atomic orphan, recovered by retry/finalize.
          try {
            if (Buffer.isBuffer(chunkData))
              await fs.promises.writeFile(tempPath, chunkData, { flag: "wx" });
            else await fs.promises.rename(ingressPath!, tempPath);
            const handle = await fs.promises.open(tempPath, "r+");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            await fs.promises.rename(tempPath, chunkPath);
            await this.syncDirectory(session.tempPath);
          } catch (error) {
            await fs.promises.unlink(tempPath).catch(() => undefined);
            throw error;
          }
        }
        if (!record) {
          if (diskExists) {
            const handle = await fs.promises.open(chunkPath, "r+");
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            await this.syncDirectory(session.tempPath);
          }
          await manager.getRepository(UploadChunkEntity).insert({
            sessionId: session.id,
            chunkIndex,
            byteSize: chunkSize,
            sha256: incomingHash,
          });
          session.uploadedCount = (session.uploadedCount || 0) + 1;
          session.uploadedSize = parseDatabaseSize(
            session.uploadedSize + chunkSize,
          );
        }
        session.status = "uploading";
        await manager.save(session);
        return session;
      });
    } finally {
      if (!Buffer.isBuffer(chunkData)) {
        cleanupIngressFile(
          chunkData.path,
          this.storageService.getTempPath(),
          () => this.logger.warn("Failed to clean ingress file"),
        );
      }
    }
  }

  private async cleanupUnpublishedAssembly(
    manager: EntityManager,
    session: UploadSessionEntity,
  ): Promise<void> {
    if (!session.filename) return;
    const committed = await manager.findOne(FileEntity, {
      where: { uploadId: session.uploadId, userId: session.userId },
    });
    if (committed) return;
    const finalPath = this.storageService.generateFinalPath(
      session.userId,
      session.uploadId,
      session.filename,
    );
    try {
      await fs.promises.unlink(finalPath);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const bytes of fs.createReadStream(filePath)) hash.update(bytes);
    return hash.digest("hex");
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.promises.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async hydrateLegacyAccounting(
    manager: EntityManager,
    session: UploadSessionEntity,
  ): Promise<void> {
    let count = 0;
    let bytes = 0;
    for (let index = 0; index < session.totalChunks; index++) {
      const chunkPath = path.join(session.tempPath, String(index));
      let stats: fs.Stats;
      try {
        stats = await fs.promises.lstat(chunkPath);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new BadRequestException("Invalid legacy chunk");
      const digest = await this.hashFile(chunkPath);
      const handle = await fs.promises.open(chunkPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await manager.getRepository(UploadChunkEntity).upsert(
        {
          sessionId: session.id,
          chunkIndex: index,
          byteSize: stats.size,
          sha256: digest,
        },
        ["sessionId", "chunkIndex"],
      );
      bytes = parseDatabaseSize(bytes + stats.size);
      count++;
    }
    await this.syncDirectory(session.tempPath);
    session.uploadedCount = count;
    session.uploadedSize = bytes;
    session.accountingInitialized = true;
    await manager.save(session);
  }

  async getUploadLimits(userId: number) {
    const user = await this.usersService.findById(userId);
    if (!user) throw new ForbiddenException("User not found");
    const active = await this.uploadSessionRepository
      .createQueryBuilder("session")
      .select("COALESCE(SUM(session.totalSize), 0)", "activeTotal")
      .where("session.userId = :userId", { userId })
      .andWhere("session.status IN (:...statuses)", {
        statuses: ["pending", "uploading"],
      })
      .getRawOne();
    const activeTotal = parseDatabaseSize(active?.activeTotal);
    const quota = parseDatabaseSize(user.storageQuota);
    const used = parseDatabaseSize(user.storageUsed);
    const quotaRemainingBytes = Math.max(
      0,
      quota - parseDatabaseSize(used + activeTotal),
    );
    const remainingActiveBytes =
      this.maxTotalSize > 0
        ? Math.max(0, this.maxTotalSize - activeTotal)
        : null;
    const maxFileBytes = this.maxFileSize > 0 ? this.maxFileSize : null;
    return {
      maxFileBytes,
      maxActiveBytes: this.maxTotalSize || null,
      maxChunkBytes: this.maxChunkSize,
      maxChunks: this.maxUploadChunks,
      remainingActiveBytes,
      quotaRemainingBytes,
      effectiveMaxFileBytes: Math.min(
        maxFileBytes ?? Number.MAX_SAFE_INTEGER,
        remainingActiveBytes ?? Number.MAX_SAFE_INTEGER,
        quotaRemainingBytes,
        this.maxUploadChunks * this.maxChunkSize,
        Number.MAX_SAFE_INTEGER,
      ),
    };
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

  async completeUpload(userId: number, uploadId: string): Promise<FileEntity> {
    let sessionTempPath: string | null = null;
    let finalPathForCleanup: string | null = null;

    const result = await this.withTransaction(async (manager) => {
      const session = await manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId },
        lock: { mode: "pessimistic_write" },
      });

      if (!session) {
        throw new NotFoundException("Upload session not found");
      }

      sessionTempPath = session.tempPath;
      try {
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

        // If session is pending/uploading but file already exists, mark session
        // completed without incrementing quota. Return after commit.
        if (existingFile) {
          session.status = "completed";
          await manager.save(session);
          return { file: existingFile, session, finalPath };
        }

        finalPathForCleanup = finalPath;

        // No existing file: assemble at deterministic path.
        // Remove any stale partial file from a previous failed attempt.
        if (fs.existsSync(finalPath)) {
          fs.unlinkSync(finalPath);
        }

        let actualSize = 0;
        const completedSession = session;
        const totalChunks = session.totalChunks;
        const tempPath = session.tempPath;
        const writeStream = fs.createWriteStream(finalPath, { flags: "wx" });

        try {
          async function* chunkSequence() {
            for (let i = 0; i < totalChunks; i++) {
              const chunkPath = path.join(tempPath, String(i));
              const chunkStats = await fs.promises.lstat(chunkPath);
              const expectedSize =
                i === totalChunks - 1
                  ? completedSession.totalSize - i * completedSession.chunkSize
                  : completedSession.chunkSize;
              if (
                !chunkStats.isFile() ||
                chunkStats.isSymbolicLink() ||
                chunkStats.size !== expectedSize
              ) {
                throw new BadRequestException(
                  `Chunk ${i} size does not match expected ${expectedSize}`,
                );
              }
              const record = await manager
                .getRepository(UploadChunkEntity)
                .findOne({
                  where: { sessionId: completedSession.id, chunkIndex: i },
                });
              const hash = createHash("sha256");
              for await (const bytes of fs.createReadStream(chunkPath)) {
                hash.update(bytes);
                actualSize += (bytes as Buffer).length;
                yield bytes;
              }
              const digest = hash.digest("hex");
              if (
                record &&
                (record.byteSize !== expectedSize || record.sha256 !== digest)
              ) {
                throw new BadRequestException(`Chunk ${i} integrity mismatch`);
              }
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

        // MIME detection from header only (memory-safe for large files).
        const HEADER_SIZE = 4100;
        const stats = fs.statSync(finalPath);
        const headerSize = Math.min(stats.size, HEADER_SIZE);
        const fd = fs.openSync(finalPath, "r");
        const headerBuffer = Buffer.alloc(headerSize);
        fs.readSync(fd, headerBuffer, 0, headerSize, null);
        fs.closeSync(fd);
        const detected = await fileTypeFromBuffer(headerBuffer);
        // Signature detection remains authoritative. Unsigned content is plain
        // text only after strict, bounded-memory validation of the entire file.
        const mimeType =
          detected?.mime ||
          ((await isUtf8PlainText(finalPath))
            ? "text/plain"
            : "application/octet-stream");

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

        const finalHandle = await fs.promises.open(finalPath, "r+");
        try {
          await finalHandle.sync();
        } finally {
          await finalHandle.close();
        }
        await this.syncDirectory(path.dirname(finalPath));
        session.status = "completed";
        session.uploadedSize = actualSize;
        session.uploadedCount = session.totalChunks;
        session.accountingInitialized = true;
        await manager
          .getRepository(UploadChunkEntity)
          .delete({ sessionId: session.id });
        await manager.save(session);
        return { file, session, finalPath };
      } catch (error) {
        // Still holding the session lock: preserve retryable chunks and remove
        // only this attempt's unpublished assembly before rollback.
        if (finalPathForCleanup)
          await fs.promises.unlink(finalPathForCleanup).catch(() => undefined);
        throw error;
      }
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

      await this.cleanupUnpublishedAssembly(manager, session);
      this.deleteTempFiles(session.tempPath);

      session.status = "aborted";
      await manager
        .getRepository(UploadChunkEntity)
        .delete({ sessionId: session.id });
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
    const sessions = await this.uploadSessionRepository.find({
      where: [{ status: "pending" }, { status: "uploading" }],
    });
    let cleaned = 0;
    for (const candidate of sessions) {
      cleaned += await this.withTransaction(async (manager) => {
        const session = await manager.findOne(UploadSessionEntity, {
          where: { id: candidate.id },
          lock: { mode: "pessimistic_write" },
        });
        if (!session) return 0;
        const terminal =
          session.status === "completed" || session.status === "aborted";
        const expired = session.expiresAt && session.expiresAt < new Date();
        if (!terminal && !expired) return 0;
        await this.cleanupUnpublishedAssembly(manager, session);
        this.deleteTempFiles(session.tempPath);
        await manager
          .getRepository(UploadChunkEntity)
          .delete({ sessionId: session.id });
        if (!terminal) await manager.delete(UploadSessionEntity, session.id);
        return terminal ? 0 : 1;
      });
    }
    return cleaned;
  }

  /**
   * Clean up orphaned temp directories that have no corresponding DB row.
   * Runs on startup to recover from crashes during session creation (O-15).
   *
   * Classification is performed with a CONSTANT number of DB queries: one
   * `SELECT "tempPath"` fetches active session temp paths
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
        .where("session.status IN (:...statuses)", {
          statuses: ["pending", "uploading"],
        })
        .getRawMany<{ tempPath: string }>();
      referenced = new Set(rows.map((row) => row.tempPath));
    } catch {
      this.logger.error("Orphaned temp dir cleanup failed");
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

        // Keep active session directories. Terminal sessions cannot accept chunks,
        // so their leftover directories are safe to reclaim after a crash.
        if (referenced.has(entryPath)) {
          continue;
        }

        this.deleteTempFiles(entryPath);
        cleaned++;
      }
    } catch {
      this.logger.error("Orphaned temp dir cleanup failed");
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
          this.logger.warn("Failed to inspect stale ingress file");
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
    } catch {
      this.logger.error("Startup cleanup failed");
    }

    try {
      const cleaned = await this.cleanupExpiredSessions();
      if (cleaned > 0) {
        this.logger.log(
          `Startup cleanup: removed ${cleaned} expired upload sessions`,
        );
      }
    } catch {
      this.logger.error("Startup cleanup failed");
    }

    // Start periodic cleanup (every 1 hour).
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpiredSessions().catch(() =>
          this.logger.error("Periodic cleanup failed"),
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
      this.logger.warn("Failed to delete temp files at");
    }
  }
}
