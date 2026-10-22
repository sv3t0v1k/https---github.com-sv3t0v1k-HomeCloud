import { SsdUploadsService } from "./ssd-uploads.service";
import { SSD_UPLOAD_WORKSPACE_ID } from "../entities/upload-workspace.entity";
import { UploadWorkspaceEntity } from "../entities/upload-workspace.entity";
import {
  UploadWorkspaceResolver,
  LEGACY_UPLOAD_WORKSPACE,
  LEGACY_UPLOAD_WORKSPACE_ID,
} from "./upload-workspace";
import { parseDatabaseSize } from "../common/database-size";
import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  ConflictException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, MoreThan, Repository, QueryRunner } from "typeorm";
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
import { allocateNamespaceName } from "../files/namespace-name";
import {
  IngressChunkFile,
  cleanupIngressFile,
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
  private readonly workspaceResolver: UploadWorkspaceResolver;
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
    @Optional() private readonly ssdUploads?: SsdUploadsService,
  ) {
    this.workspaceResolver = new UploadWorkspaceResolver(storageService);
    const rawMaxFileSize = configService.get("MAX_FILE_SIZE");
    const rawMaxTotalSize = configService.get("MAX_TOTAL_SIZE");
    const rawMaxChunkSize = configService.get("MAX_CHUNK_SIZE");
    const rawSessionTtl = configService.get("UPLOAD_SESSION_TTL_HOURS");

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

  // Assembly owns an exclusive session lock; short mutations share the fence
  // and retain their existing session-row serialization (including chunk retries).
  private static readonly ASSEMBLY_LOCK_NAMESPACE = 1746825230;

  private async trySessionFence(manager: EntityManager, uploadId: string, transaction: boolean): Promise<boolean> {
    const [row] = await manager.query(
      `SELECT ${transaction ? "pg_try_advisory_xact_lock_shared" : "pg_try_advisory_lock"}($1,hashtext($2)) AS locked`,
      [UploadsService.ASSEMBLY_LOCK_NAMESPACE, uploadId],
    );
    return row?.locked === true;
  }

  private async runnerTransaction<T>(runner: QueryRunner, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    await runner.startTransaction();
    try {
      const result = await fn(runner.manager);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  private async withTransaction<T>(
    fn: (manager: EntityManager) => Promise<T>,
    uploadId?: string,
  ): Promise<T> {
    const runner = this.uploadSessionRepository.manager.connection.createQueryRunner();
    try {
      await runner.connect();
      return await this.runnerTransaction(runner, async manager => {
        if (uploadId && !(await this.trySessionFence(manager, uploadId, true)))
          throw new ConflictException("Upload is being finalized; retry later");
        return fn(manager);
      });
    } finally {
      await runner.release();
    }
  }

  private async withAssemblyFence<T>(uploadId: string, fn: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = this.uploadSessionRepository.manager.connection.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      locked = await this.trySessionFence(runner.manager, uploadId, false);
      if (!locked) throw new ConflictException("Upload is being finalized; retry later");
      return await fn(runner);
    } finally {
      if (locked) {
        try {
          await runner.manager.query(`SELECT pg_advisory_unlock($1,hashtext($2))`,
            [UploadsService.ASSEMBLY_LOCK_NAMESPACE, uploadId]);
        } catch {
          // A pooled connection must never retain a session advisory lock.
          // TypeORM has no public destroy(error) API. Its PostgreSQL release path
          // removes the runner and destroys the underlying pool client.
          await (runner as unknown as { releasePostgresConnection(error: Error): Promise<void> })
            .releasePostgresConnection(new Error("Upload fence connection lost"));
        }
      }
      if (!runner.isReleased) await runner.release();
    }
  }

  private async lockPublicationDestination(manager: EntityManager, userId: number, parentId: number | null): Promise<void> {
    if (parentId == null) return;
    const chain: { id: number; parentId: number | null }[] = await manager.query(
      `WITH RECURSIVE ancestors AS (
        SELECT f.id,f."parentId",ARRAY[f.id] AS path FROM folders f
        JOIN files m ON m."folderId"=f.id AND m."userId"=$2 AND m."isFolder" AND NOT m."isDeleted"
        WHERE f.id=$1 AND f."userId"=$2 AND NOT f."isDeleted"
        UNION ALL
        SELECT f.id,f."parentId",a.path||f.id FROM folders f
        JOIN ancestors a ON a."parentId"=f.id
        JOIN files m ON m."folderId"=f.id AND m."userId"=$2 AND m."isFolder" AND NOT m."isDeleted"
        WHERE f."userId"=$2 AND NOT f."isDeleted" AND NOT f.id=ANY(a.path)
          AND cardinality(a.path)<128
      ) SELECT id,"parentId" FROM ancestors`, [parentId, userId]);
    if (!chain.length || !chain.some(folder => folder.parentId === null))
      throw new NotFoundException("Destination folder unavailable");
    await manager.query(`SELECT id FROM folders WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [chain.map(folder => folder.id)]);
  }

  async createUploadSession(
    userId: number,
    filename: string,
    totalSize: number,
    chunkSize: number,
    parentId?: number,
    expectedSha256?: string,
  ): Promise<UploadSessionEntity> {
    if (this.ssdUploads?.enabled)
      return this.ssdUploads.createUploadSession(userId, filename, totalSize, chunkSize, parentId, expectedSha256);
    if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256))
      throw new BadRequestException("Invalid whole SHA256");
    this.validateFilename(filename);
    if (
      parentId !== undefined &&
      parentId !== null &&
      (!Number.isSafeInteger(parentId) || parentId <= 0)
    ) {
      throw new BadRequestException("Invalid target folder");
    }
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
    let sessionTempDir: string;

    const expiresAt = new Date();
    expiresAt.setMilliseconds(expiresAt.getMilliseconds() + this.sessionTtlMs);

    const savedSession = await this.withTransaction(async (manager) => {
      const workspace = await this.getWorkspace(manager);
      sessionTempDir = this.workspaceResolver.resolve(
        {
          workspaceId: workspace.id,
          uploadId,
          tempPath: path.join(this.workspaceResolver.root(workspace), uploadId),
        },
        workspace,
      );
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
        workspaceId: LEGACY_UPLOAD_WORKSPACE_ID,
        expectedSha256: expectedSha256 ?? null,
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
      await this.resolveSessionWorkspace(savedSession);
      this.assertUploadPath(sessionTempDir!);
      this.workspaceResolver.filesystem().mkdir(sessionTempDir!);
    } catch {
      this.logger.error("Failed to create temp dir for session");
      // Best-effort cleanup of the orphaned session row.
      await this.uploadSessionRepository.delete(savedSession!.id);
      throw new BadRequestException("Failed to prepare upload session");
    }

    return savedSession!;
  }

  private async isSsdSession(userId: number, uploadId: string): Promise<boolean> {
    if (!this.ssdUploads?.enabled) return false;
    const session = await this.uploadSessionRepository.findOne({ where: { userId, uploadId, origin: "owner" } });
    return session?.workspaceId === SSD_UPLOAD_WORKSPACE_ID;
  }

  async getUploadSession(
    userId: number,
    uploadId: string,
  ): Promise<UploadSessionEntity> {
    if (await this.isSsdSession(userId, uploadId)) return this.ssdUploads!.getUploadSession(userId, uploadId);
    const session = await this.uploadSessionRepository.findOne({
      where: { uploadId, userId, origin: "owner" },
    });

    if (!session) {
      throw new NotFoundException("Upload session not found");
    }

    if (session.expiresAt && new Date() > session.expiresAt) {
      throw new BadRequestException("Upload session expired");
    }

    await this.assertLegacyUnreserved(this.uploadSessionRepository.manager, session.id);
    await this.resolveSessionWorkspace(session);
    return session;
  }

  async uploadChunk(
    userId: number,
    uploadId: string,
    chunkIndex: number,
    chunkData: Buffer | IngressChunkFile,
    capability?: import("./ssd-uploads.service").SsdIngressCapability,
  ): Promise<UploadSessionEntity> {
    if (await this.isSsdSession(userId, uploadId))
      return this.ssdUploads!.uploadChunk(userId, uploadId, chunkIndex, chunkData, capability);
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
    let bindingValidated = false;
    let ingressFd: number | undefined;
    const chunkSize = Buffer.isBuffer(chunkData)
      ? chunkData.length
      : chunkData.size;

    try {
      if (!Buffer.isBuffer(chunkData)) {
        ingressPath = this.validateIngressChunk(chunkData);
        ingressFd = this.workspaceResolver.filesystem().open(ingressPath);
        if (fs.fstatSync(ingressFd).size !== chunkSize) throw new BadRequestException("Ingress size changed");
      }
      return await this.withTransaction(async (manager) => {
        const session = await manager.findOne(UploadSessionEntity, {
          where: { uploadId, userId, origin: "owner" },
          lock: { mode: "pessimistic_write" },
        });

        if (!session) {
          throw new NotFoundException("Upload session not found");
        }

        await this.assertLegacyUnreserved(manager, session.id);
        await this.resolveSessionWorkspace(session, manager);
        bindingValidated = true;
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

        this.assertUploadPath(session.tempPath);
        if (ingressPath)
          this.workspaceResolver.assertColocated(
            session.tempPath,
            path.dirname(ingressPath),
          );
        const chunkPath = path.join(session.tempPath, String(chunkIndex));
        const tempPath = chunkPath + "." + uuidv4() + ".tmp";

        // Legacy sessions hydrate only once; new sessions never traverse the prefix.
        if (!session.accountingInitialized)
          await this.hydrateLegacyAccounting(manager, session);
        const incomingHash = Buffer.isBuffer(chunkData)
          ? createHash("sha256").update(chunkData).digest("hex")
          : await this.hashDescriptor(ingressFd!, chunkSize);
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
        let existingFd: number | undefined;
        try {
          this.assertUploadPath(chunkPath);
          existingFd = this.workspaceResolver.filesystem().open(chunkPath, "rw");
          const stats = fs.fstatSync(existingFd);
          diskExists = true;
          if (stats.size !== chunkSize ||
              (await this.hashDescriptor(existingFd, chunkSize)) !== incomingHash) {
            throw new BadRequestException(`Chunk ${chunkIndex} already uploaded with different content`);
          }
          await this.syncDescriptor(existingFd);
          this.assertSameInode(existingFd, chunkPath);
        } catch (error) {
          if (existingFd !== undefined || (error as { code?: string }).code !== "ENOENT") throw error;
        } finally {
          if (existingFd !== undefined) fs.closeSync(existingFd);
        }
        if (!diskExists) {
          // Retain the original inode through sync and publication. Never derive
          // hash authority from a reopened staging name.
          let stagedFd: number | undefined;
          try {
            this.assertUploadPath(tempPath);
            if (Buffer.isBuffer(chunkData)) {
              stagedFd = this.workspaceResolver.filesystem().open(tempPath, "wx");
              await new Promise<void>((resolve, reject) => {
                fs.writeFile(stagedFd!, chunkData, error => error ? reject(error) : resolve());
              });
            } else {
              stagedFd = ingressFd!;
              this.workspaceResolver.filesystem().rename(ingressPath!, tempPath);
              this.assertSameInode(stagedFd, tempPath);
            }
            await this.syncDescriptor(stagedFd);
            this.assertUploadPath(chunkPath);
            this.workspaceResolver.filesystem().rename(tempPath, chunkPath);
            this.assertSameInode(stagedFd, chunkPath);
            await this.syncDirectory(session.tempPath);
          } catch (error) {
            try {
              this.assertUploadPath(tempPath);
              this.workspaceResolver.filesystem().remove(tempPath);
            } catch {
              /* Preserve on identity failure. */
            }
            throw error;
          } finally {
            if (stagedFd !== undefined && Buffer.isBuffer(chunkData)) fs.closeSync(stagedFd);
          }
        }
        if (!record) {
          if (diskExists) await this.syncDirectory(session.tempPath);
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
      }, uploadId);
    } finally {
      if (ingressFd !== undefined) fs.closeSync(ingressFd);
      if (!Buffer.isBuffer(chunkData) && bindingValidated) {
        try {
          this.assertUploadPath(chunkData.path);
          cleanupIngressFile(
            chunkData.path,
            this.storageService.getTempPath(),
            () => this.logger.warn("Failed to clean ingress file"),
            this.workspaceResolver.filesystem(),
          );
        } catch {
          this.logger.warn("Storage unavailable; ingress cleanup deferred");
        }
      }
    }
  }

  private async assertLegacyUnreserved(manager: EntityManager, sessionId: number): Promise<void> {
    // Runtime DI is always present, even with SSD admission disabled. Historical
    // isolated journals remain barriers; legacy FS effects must precede no guard.
    if (!this.ssdUploads) return;
    const pending = await manager.query(
      `SELECT id FROM ssd_finalization_operations WHERE "sessionId"=$1 AND "cleanupState"='pending' LIMIT 1`,
      [sessionId],
    );
    if (pending.length) throw new ServiceUnavailableException("Upload recovery requires operator inspection");
  }

  private async cleanupUnpublishedAssembly(
    manager: EntityManager,
    session: UploadSessionEntity,
  ): Promise<FileEntity | null> {
    await this.assertLegacyUnreserved(manager, session.id);
    if (!session.filename) return null;
    // Snapshot attempt IDs before the database round trip. If this connection
    // loses its fence after that query, a newer worker's fresh attempt cannot
    // enter this cleanup list. A failed query must cause no filesystem deletion.
    this.assertUploadPath(session.tempPath);
    const attempts = fs.existsSync(session.tempPath)
      ? this.workspaceResolver.filesystem().list(session.tempPath)
      : [];
    const committed = await manager.findOne(FileEntity, {
      where: { uploadId: session.uploadId, userId: session.userId },
    });
    // Attempt names are server-generated. Never trust paths supplied by clients.
    for (const entry of attempts) {
      const match = /^\.assembly-([0-9a-f-]{36})$/.exec(entry);
      if (!match) continue;
      const attemptFinal = this.storageService.generateFinalPath(
        session.userId, `${session.uploadId}.${match[1]}`, session.filename,
      );
      if (attemptFinal !== committed?.storagePath) {
        this.assertUploadPath(attemptFinal);
        await fs.promises.unlink(attemptFinal).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      this.assertUploadPath(path.join(session.tempPath, entry));
      this.workspaceResolver.filesystem().remove(path.join(session.tempPath, entry));
    }
    if (committed) return committed;
    // Retain cleanup of pre-refactor interrupted deterministic assemblies.
    const finalPath = this.storageService.generateFinalPath(session.userId, session.uploadId, session.filename);
    try {
      this.assertUploadPath(finalPath);
      await fs.promises.unlink(finalPath);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
    return null;
  }

  private assertSameInode(fd: number, target: string): void {
    const original = fs.fstatSync(fd);
    const current = this.workspaceResolver.filesystem().stat(target);
    if (original.dev !== current.dev || original.ino !== current.ino)
      throw new Error("Upload file identity changed");
  }

  private async syncDescriptor(fd: number): Promise<void> {
    await new Promise<void>((resolve, reject) => fs.fsync(fd, error => error ? reject(error) : resolve()));
  }

  private async hashDescriptor(fd: number, expectedBytes: number): Promise<string> {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = await new Promise<number>((resolve, reject) => {
        fs.read(fd, buffer, 0, Math.min(buffer.length, expectedBytes - offset + 1), offset, (error, bytesRead) =>
          error ? reject(error) : resolve(bytesRead));
      });
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
      if (offset > expectedBytes) throw new BadRequestException("Chunk grew during hashing");
    }
    if (offset !== expectedBytes) throw new BadRequestException("Chunk size changed during hashing");
    return hash.digest("hex");
  }

  private async syncDirectory(directory: string): Promise<void> {
    if (directory === this.storageService.getTempPath() || directory.startsWith(this.storageService.getTempPath() + path.sep)) {
      this.workspaceResolver.filesystem().sync(directory, true);
      return;
    }
    this.assertUploadPath(directory, true, true);
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
    await this.resolveSessionWorkspace(session, manager);
    let count = 0;
    let bytes = 0;
    for (let index = 0; index < session.totalChunks; index++) {
      const chunkPath = path.join(session.tempPath, String(index));
      let stats: fs.Stats;
      try {
        this.assertUploadPath(chunkPath);
        stats = this.workspaceResolver.filesystem().stat(chunkPath);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink())
        throw new BadRequestException("Invalid legacy chunk");
      const fd = this.workspaceResolver.filesystem().open(chunkPath, "rw");
      let digest: string;
      try {
        stats = fs.fstatSync(fd);
        digest = await this.hashDescriptor(fd, stats.size);
        await this.syncDescriptor(fd);
        this.assertSameInode(fd, chunkPath);
      } finally { fs.closeSync(fd); }
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
      ...(this.ssdUploads?.enabled ? { storageMode: "ssd", wholeSha256Required: true } : {}),
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
    let ingressRoot: string;
    try { ingressRoot = this.workspaceResolver.ingress(LEGACY_UPLOAD_WORKSPACE); }
    catch { throw new ServiceUnavailableException("Upload workspace unavailable"); }
    const resolved = path.resolve(chunk.path);
    if (path.dirname(resolved) !== ingressRoot) {
      throw new BadRequestException("Invalid ingress chunk path");
    }
    let stats: fs.Stats;
    try {
      this.assertUploadPath(resolved);
      stats = this.workspaceResolver.filesystem().stat(resolved);
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
    if (await this.isSsdSession(userId, uploadId)) return this.ssdUploads!.completeUpload(userId, uploadId);
    const result = await this.withAssemblyFence(uploadId, async (runner) => {
      const manager = runner.manager;
      const session = await manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId, origin: "owner" },
      });

      if (!session) {
        throw new NotFoundException("Upload session not found");
      }

      await this.assertLegacyUnreserved(manager, session.id);
      await this.resolveSessionWorkspace(session, manager);
      let attemptPath: string | undefined;
      let attemptFinalPath: string | undefined;
      let commitAttempted = false;
      try {
        if (session.expiresAt && new Date() > session.expiresAt) {
          throw new BadRequestException("Upload session expired");
        }

        // If session is already completed, return existing file (idempotent).
        if (session.status === "completed") {
          const existing = await manager.findOne(FileEntity, {
            where: { uploadId, userId, isDeleted: false },
          });
          if (existing) {
            try {
              await this.cleanupUnpublishedAssembly(manager, session);
              this.deleteTempFiles(session.tempPath);
            } catch { /* Committed objects are preserved on cleanup failure. */ }
            return { file: existing, session };
          }
          throw new BadRequestException(
            "Upload already completed but file record missing",
          );
        }

        if (session.status === "aborted") {
          throw new BadRequestException("Upload was aborted");
        }

        if (!["pending", "uploading"].includes(session.status))
          throw new BadRequestException("Invalid upload session state");
        const recovered = await this.cleanupUnpublishedAssembly(manager, session);
        if (recovered) {
          // Preserve recovery of historical File/session status inconsistencies.
          // The existing File was already charged; completing only releases its reservation.
          const repaired = await this.runnerTransaction(runner, async publication => {
            const user = await publication.findOne(UserEntity, {
              where: { id: userId }, lock: { mode: "pessimistic_write" },
            });
            if (!user?.isActive) throw new ForbiddenException("User unavailable");
            await this.lockPublicationDestination(publication, userId, session.parentId ?? null);
            const current = await publication.findOne(UploadSessionEntity, {
              where: { uploadId, userId, origin: "owner" }, lock: { mode: "pessimistic_write" },
            });
            const file = await publication.findOne(FileEntity, { where: { id: recovered.id, userId, uploadId, isDeleted: false } });
            if (!current || !["pending", "uploading"].includes(current.status) ||
                current.parentId !== session.parentId || !file ||
                (file.parentId ?? null) !== (current.parentId ?? null))
              throw new ConflictException("Upload recovery state changed");
            if (current.expiresAt && current.expiresAt <= new Date())
              throw new BadRequestException("Upload session expired");
            await this.assertLegacyUnreserved(publication, current.id);
            current.status = "completed";
            await publication.getRepository(UploadChunkEntity).delete({ sessionId: current.id });
            await publication.save(current);
            return { file, session: current };
          });
          try { this.deleteTempFiles(session.tempPath); } catch { /* Startup cleanup retries. */ }
          return repaired;
        }
        const attemptId = uuidv4();
        attemptPath = path.join(session.tempPath, `.assembly-${attemptId}`);
        attemptFinalPath = this.storageService.generateFinalPath(userId, `${uploadId}.${attemptId}`, session.filename);
        const finalPath = attemptPath;
        this.assertUploadPath(finalPath);

        let actualSize = 0;
        const wholeHash = createHash("sha256");
        const assertUploadPath = this.assertUploadPath.bind(this);
        const completedSession = session;
        const totalChunks = session.totalChunks;
        const tempPath = session.tempPath;
        this.assertUploadPath(tempPath);
        this.assertUploadPath(finalPath);
        const filesystem = this.workspaceResolver.filesystem();
        const writeStream = fs.createWriteStream(finalPath, { flags: "wx" });
        // pipeline can reject before an asynchronous fs.open finishes. A destroy
        // request is not a close: retain the session fence until pending open/I/O
        // and fd close have settled, then remove the unpublished destination.
        let resolveDestinationClosed!: () => void;
        const destinationClosed = new Promise<void>((resolve) => {
          resolveDestinationClosed = resolve;
          writeStream.once("close", resolve);
        });

        try {
          async function* chunkSequence() {
            for (let i = 0; i < totalChunks; i++) {
              const chunkPath = path.join(tempPath, String(i));
              assertUploadPath(chunkPath, false);
              const expectedSize =
                i === totalChunks - 1
                  ? completedSession.totalSize - i * completedSession.chunkSize
                  : completedSession.chunkSize;
              const chunkStream = filesystem.readStream(chunkPath, expectedSize);
              try {
              const chunkStats = fs.fstatSync((chunkStream as fs.ReadStream & { fd: number }).fd);
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
              for await (const bytes of chunkStream) {
                hash.update(bytes);
                wholeHash.update(bytes);
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
              } finally { chunkStream.destroy(); }
            }
          }

          await pipeline(chunkSequence(), writeStream);
        } catch (err) {
          if (!writeStream.destroyed) {
            writeStream.destroy();
          }
          await destinationClosed;
          this.assertUploadPath(finalPath);
          this.assertUploadPath(finalPath);
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
          throw err;
        } finally {
          writeStream.removeListener("close", resolveDestinationClosed);
        }

        // Verify actual assembled size matches declared totalSize.
        if (actualSize !== session.totalSize) {
          this.assertUploadPath(finalPath);
          this.assertUploadPath(finalPath);
          if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
          }
          throw new BadRequestException(
            `Actual file size ${actualSize} does not match declared totalSize ${session.totalSize}`,
          );
        }

        const wholeDigest = wholeHash.digest("hex");
        if (session.expectedSha256 && session.expectedSha256 !== wholeDigest)
          throw new BadRequestException("Whole-file integrity mismatch");

        // MIME detection from header only (memory-safe for large files).
        const HEADER_SIZE = 4100;
        this.assertUploadPath(finalPath, false);
        const stats = fs.statSync(finalPath);
        const headerSize = Math.min(stats.size, HEADER_SIZE);
        const fd = fs.openSync(finalPath, "r");
        const headerBuffer = Buffer.alloc(headerSize);
        fs.readSync(fd, headerBuffer, 0, headerSize, null);
        fs.closeSync(fd);
        // MIME only describes preview capability. Detector failures (including
        // truncated signatures) must never prevent storing otherwise valid bytes.
        let mimeType = "application/octet-stream";
        try {
          const detected = await fileTypeFromBuffer(headerBuffer);
          mimeType =
            detected?.mime ||
            ((await isUtf8PlainText(finalPath))
              ? "text/plain"
              : "application/octet-stream");
        } catch {
          this.logger.warn("MIME metadata detection failed; storing as binary");
        }

        // Durable assembly precedes all publication row locks.
        const finalHandle = await fs.promises.open(finalPath, "r+");
        try { await finalHandle.sync(); } finally { await finalHandle.close(); }
        await this.syncDirectory(session.tempPath);

        const published = await this.runnerTransaction(runner, async publication => {
          // All owner metadata writers/deleters use user -> folder -> session.
          const user = await publication.findOne(UserEntity, {
            where: { id: userId }, lock: { mode: "pessimistic_write" },
          });
          if (!user?.isActive) throw new ForbiddenException("User unavailable");
          await this.lockPublicationDestination(publication, userId, session.parentId ?? null);
          const current = await publication.findOne(UploadSessionEntity, {
            where: { uploadId, userId, origin: "owner" }, lock: { mode: "pessimistic_write" },
          });
          if (!current || current.parentId !== session.parentId ||
              current.workspaceId !== session.workspaceId || current.filename !== session.filename ||
              current.totalSize !== session.totalSize || current.chunkSize !== session.chunkSize ||
              current.expectedSha256 !== session.expectedSha256 ||
              !["pending", "uploading"].includes(current.status))
            throw new ConflictException("Upload session changed during assembly");
          if (current.expiresAt && current.expiresAt <= new Date())
            throw new BadRequestException("Upload session expired");
          await this.assertLegacyUnreserved(publication, current.id);
          await this.resolveSessionWorkspace(current, publication);
          const active = await publication.createQueryBuilder(UploadSessionEntity, "session")
            .select("COALESCE(SUM(session.totalSize),0)", "activeTotal")
            .where("session.userId = :userId", { userId })
            .andWhere("session.status IN (:...statuses)", { statuses: ["pending", "uploading"] })
            .getRawOne();
          if (parseDatabaseSize(parseDatabaseSize(user.storageUsed) + parseDatabaseSize(active?.activeTotal)) > parseDatabaseSize(user.storageQuota))
            throw new ForbiddenException("Storage quota exceeded");
          const chosenName = await allocateNamespaceName(publication, userId, current.parentId, current.filename, "file");
          // Exclusive hard link keeps the attempt discoverable by existing TTL cleanup.
          // Each attempt has a unique object key, including after connection loss.
          this.assertUploadPath(attemptFinalPath!);
          await fs.promises.link(attemptPath!, attemptFinalPath!);
          await this.syncDirectory(path.dirname(attemptFinalPath!));
          const file = publication.create(FileEntity, {
            name: chosenName, ...this.storageService.placementForPath(attemptFinalPath!),
            size: actualSize, mimeType, checksum: session.expectedSha256 ? wholeDigest : undefined,
            isFolder: false, parentId: current.parentId || undefined, userId, uploadId,
          });
          await publication.save(file);
          await this.usersService.updateStorageUsed(userId, actualSize, publication);
          current.status = "completed";
          current.uploadedSize = actualSize;
          current.uploadedCount = current.totalChunks;
          current.accountingInitialized = true;
          await publication.getRepository(UploadChunkEntity).delete({ sessionId: current.id });
          await publication.save(current);
          // From this point a lost COMMIT acknowledgement must preserve the object.
          commitAttempted = true;
          return { file, session: current };
        });
        try { this.deleteTempFiles(session.tempPath); } catch { /* Startup cleanup retries. */ }
        return published;
      } catch (error) {
        // A disconnected old attempt can remove only its own unpublished object.
        // Keep the workspace hard link after uncertain COMMIT for protected recovery.
        if (!commitAttempted && attemptPath) {
          for (const owned of [attemptFinalPath, attemptPath]) {
            if (!owned) continue;
            try {
              this.assertUploadPath(owned);
              await fs.promises.unlink(owned).catch(() => undefined);
            } catch { /* Preserve on storage identity failure. */ }
          }
        }
        throw error;
      }
    });

    return result.file;
  }

  async abortUpload(userId: number, uploadId: string): Promise<void> {
    if (await this.isSsdSession(userId, uploadId)) { await this.ssdUploads!.abortUpload(userId, uploadId); return; }
    await this.withTransaction(async (manager) => {
      const session = await manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId, origin: "owner" },
        lock: { mode: "pessimistic_write" },
      });

      if (!session) {
        throw new NotFoundException("Upload session not found");
      }

      await this.resolveSessionWorkspace(session, manager);
      if (session.status === "completed") {
        throw new BadRequestException("Cannot abort a completed upload");
      }

      // Owned repeated abort also repairs any interrupted filesystem cleanup.
      await this.cleanupUnpublishedAssembly(manager, session);
      this.deleteTempFiles(session.tempPath);

      session.status = "aborted";
      await manager
        .getRepository(UploadChunkEntity)
        .delete({ sessionId: session.id });
      await manager.save(session);
    }, uploadId);
  }

  private validateFilename(filename: string): void {
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      filename === "." ||
      filename === ".." ||
      filename.length > 255 ||
      filename.includes("/") ||
      filename.includes("\\") ||
      [...filename].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })
    ) {
      throw new BadRequestException("Invalid filename");
    }
  }

  /** Public metadata must not expose filesystem paths or ORM relationships. */
  toSessionMetadata(session: UploadSessionEntity) {
    return {
      uploadId: session.uploadId,
      filename: session.filename,
      totalSize: session.totalSize,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      uploadedSize: session.uploadedSize,
      status: session.status,
      expiresAt: session.expiresAt,
      parentId: session.parentId ?? null,
    };
  }

  async reconcileUploadSession(userId: number, uploadId: string) {
    if (await this.isSsdSession(userId, uploadId)) return this.ssdUploads!.reconcileUploadSession(userId, uploadId);
    return this.withTransaction(async (manager) => {
      // Serializes with chunk commit, finalization, abort, and expiry cleanup.
      const session = await manager.findOne(UploadSessionEntity, {
        where: { uploadId, userId, origin: "owner" },
        lock: { mode: "pessimistic_write" },
      });
      if (!session) throw new NotFoundException("Upload session not found");
      await this.resolveSessionWorkspace(session, manager);
      if (
        session.status !== "completed" &&
        session.expiresAt &&
        session.expiresAt <= new Date()
      ) {
        throw new BadRequestException("Upload session expired");
      }
      if (session.status === "completed") {
        const file = await manager.findOne(FileEntity, {
          where: { uploadId, userId },
        });
        if (!file)
          throw new NotFoundException("Completed upload file not found");
        return {
          ...this.toSessionMetadata(session),
          chunks: [],
          file: {
            id: file.id,
            name: file.name,
            size: parseDatabaseSize(file.size),
            mimeType: file.mimeType,
            parentId: file.parentId ?? null,
            uploadId: file.uploadId,
          },
        };
      }
      if (session.status === "aborted") {
        return {
          ...this.toSessionMetadata(session),
          uploadedSize: 0,
          chunks: [],
        };
      }
      if (!session.accountingInitialized)
        await this.hydrateLegacyAccounting(manager, session);
      const records = await manager.getRepository(UploadChunkEntity).find({
        where: { sessionId: session.id },
        order: { chunkIndex: "ASC" },
        take: this.maxUploadChunks,
      });
      const chunks = records.map(({ chunkIndex, byteSize, sha256 }) => ({
        chunkIndex,
        byteSize,
        sha256,
      }));
      return {
        ...this.toSessionMetadata(session),
        uploadedSize: chunks.reduce(
          (sum, chunk) => parseDatabaseSize(sum + chunk.byteSize),
          0,
        ),
        chunks,
      };
    }, uploadId);
  }

  async listUploadSessions(userId: number) {
    const sessions = await this.uploadSessionRepository.find({
      where: {
        userId,
        status: In(["pending", "uploading"]),
        origin: "owner",
        expiresAt: MoreThan(new Date()),
      },
      order: { createdAt: "DESC" },
      take: 200,
    });
    const visible = sessions.filter(session => session.workspaceId !== SSD_UPLOAD_WORKSPACE_ID || this.ssdUploads?.enabled);
    for (const session of visible) {
      if (session.workspaceId === SSD_UPLOAD_WORKSPACE_ID) await this.ssdUploads?.getUploadSession(userId, session.uploadId);
      else await this.resolveSessionWorkspace(session);
    }
    return visible.map((session) => this.toSessionMetadata(session));
  }

  async cleanupExpiredSessions(): Promise<number> {
    const sessions = await this.uploadSessionRepository.find({
      where: [{ status: "pending" }, { status: "uploading" }],
    });
    let cleaned = 0;
    for (const candidate of sessions) {
      if (candidate.workspaceId === SSD_UPLOAD_WORKSPACE_ID) continue;
      cleaned += await this.withTransaction(async (manager) => {
        if (!(await this.trySessionFence(manager, candidate.uploadId, true))) return 0;
        const session = await manager.findOne(UploadSessionEntity, {
          where: { id: candidate.id },
          lock: { mode: "pessimistic_write" },
        });
        if (!session) return 0;
        await this.resolveSessionWorkspace(session, manager);
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
    return cleaned + (this.ssdUploads?.enabled ? await this.ssdUploads.cleanupExpiredSessions() : 0);
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
    const workspace = await this.getWorkspace();
    const tempRoot = this.workspaceResolver.root(workspace);
    const ingressRoot = this.workspaceResolver.ingress(workspace);
    let referenced: Set<string>;
    try {
      const rows = await this.uploadSessionRepository
        .createQueryBuilder("session")
        .select([
          'session.tempPath AS "tempPath"',
          'session.uploadId AS "uploadId"',
          'session.workspaceId AS "workspaceId"',
          "session.status AS status",
        ])
        .getRawMany<UploadSessionEntity>();
      const barriers = this.ssdUploads
        ? await this.uploadSessionRepository.manager.query(
          `SELECT s."tempPath" FROM upload_sessions s JOIN ssd_finalization_operations op ON op."sessionId"=s.id WHERE op."cleanupState"='pending' AND s."workspaceId"=$1`,
          [LEGACY_UPLOAD_WORKSPACE_ID],
        ) : [];
      const reservedPaths = new Set(barriers.map((row: { tempPath: string }) => row.tempPath));
      const resolved = rows.filter(row => row.workspaceId !== SSD_UPLOAD_WORKSPACE_ID).map((row) => ({
        row,
        path: this.workspaceResolver.resolve(row, workspace),
      }));
      referenced = new Set(
        resolved
          .filter(
            ({ row, path }) => row.status === "pending" || row.status === "uploading" || reservedPaths.has(path),
          )
          .map(({ path }) => path),
      );
    } catch {
      this.logger.error("Orphaned temp dir cleanup failed");
      return 0;
    }
    this.assertUploadPath(ingressRoot);
    this.workspaceResolver.filesystem().mkdir(ingressRoot);
    this.cleanupStaleIngressFiles(ingressRoot);

    let cleaned = 0;
    try {
      this.assertUploadPath(tempRoot);
      const entries = this.workspaceResolver.filesystem().list(tempRoot);
      for (const entry of entries) {
        const entryPath = path.join(tempRoot, entry);
        if (path.resolve(entryPath) === ingressRoot) {
          continue;
        }
        this.assertUploadPath(entryPath);
        try { this.workspaceResolver.filesystem().stat(entryPath, true); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code ?? "")) continue;
          throw error;
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
    this.assertUploadPath(ingressRoot);
    for (const name of this.workspaceResolver.filesystem().list(ingressRoot)) {
      const candidate = path.join(ingressRoot, name);
      try {
        this.assertUploadPath(candidate);
        const stats = this.workspaceResolver.filesystem().stat(candidate);
        if (
          (stats.isFile() || stats.isSymbolicLink()) &&
          stats.mtimeMs < cutoff
        ) {
          this.assertUploadPath(candidate);
          cleanupIngressFile(candidate, this.storageService.getTempPath(), undefined, this.workspaceResolver.filesystem());
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
    this.workspaceResolver.close();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private deleteTempFiles(tempPath: string): void {
    this.assertUploadPath(tempPath);
    if (tempPath === this.workspaceResolver.root(LEGACY_UPLOAD_WORKSPACE))
      throw new Error("Temporary root deletion refused");
    this.workspaceResolver.filesystem().remove(tempPath, true);
  }

  private async getWorkspace(
    manager = this.uploadSessionRepository.manager,
    id = LEGACY_UPLOAD_WORKSPACE_ID,
  ): Promise<UploadWorkspaceEntity> {
    const workspace = await manager.findOne(UploadWorkspaceEntity, {
      where: { id },
    });
    try {
      this.workspaceResolver.validate(workspace);
    } catch {
      throw new ServiceUnavailableException("Upload workspace unavailable");
    }
    return workspace!;
  }

  private async resolveSessionWorkspace(
    session: UploadSessionEntity,
    manager = this.uploadSessionRepository.manager,
  ): Promise<string> {
    if (!session.workspaceId)
      throw new ServiceUnavailableException("Upload workspace unavailable");
    const workspace = await this.getWorkspace(manager, session.workspaceId);
    try {
      return this.workspaceResolver.resolve(session, workspace);
    } catch {
      throw new ServiceUnavailableException("Upload workspace unavailable");
    }
  }

  private assertUploadPath(
    target: string,
    write = true,
    directory = false,
  ): string {
    this.workspaceResolver.root(LEGACY_UPLOAD_WORKSPACE);
    if (
      target === this.storageService.getTempPath() ||
      target.startsWith(this.storageService.getTempPath() + path.sep)
    )
      this.workspaceResolver.assertPath(target);
    return this.storageService.assertTrustedPath(target, write, directory);
  }
}
