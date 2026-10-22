import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager, In, LessThanOrEqual } from "typeorm";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadWorkspaceEntity, SSD_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { UserEntity } from "../entities/user.entity";
import { FolderEntity } from "../entities/folder.entity";
import { FileEntity } from "../entities/file.entity";
import { StorageService } from "../storage/storage.service";
import { PreparedSsdWorkspace } from "./prepared-ssd-workspace";
import { SecureFilesystem } from "./secure-filesystem";
import { IngressChunkFile, parseMaxChunkSize } from "./chunk-ingress";
import { PostgresSsdFinalizationStore } from "./ssd-finalization-store";
import { IsolatedSsdFinalizationFilesystem } from "./ssd-finalization-filesystem";
import { SsdCrossFsFinalizer } from "./ssd-cross-fs-finalizer";
import { SsdFinalizationRecovery } from "./ssd-finalization-recovery";
import { checkpointSsdMime } from "./ssd-mime";

export interface SsdIngressCapability {
  root: string;
  destination: string;
  filesystem: SecureFilesystem;
  guard(target: string): void;
  release(): void;
}

/** All payload I/O runs outside transactions. The independent native root flock
 * fences admission, multipart ingress, chunks, cancellation and finalization. */
@Injectable()
export class SsdUploadsService {
  readonly enabled: boolean;
  private readonly logger = new Logger(SsdUploadsService.name);
  private readonly prepared: PreparedSsdWorkspace;
  private readonly capabilities = new WeakMap<SsdIngressCapability, { userId: number; uploadId: string; users: number; releaseRequested: boolean }>();
  private readonly maxChunkSize: number;
  private readonly maxFileSize: number;
  private readonly maxTotalSize: number;
  private readonly maxChunks: number;
  private readonly ttlMs: number;
  private readonly recoveryMode: "manual" | "once";
  private startupAttempted = false;

  constructor(
    private readonly db: DataSource,
    private readonly storage: StorageService,
    config: ConfigService,
    private readonly store: PostgresSsdFinalizationStore,
  ) {
    const flag = config.get("UPLOAD_SSD_ENABLED");
    if (flag !== undefined && flag !== null && flag !== "false" && flag !== "true" && flag !== false && flag !== true)
      throw new Error("UPLOAD_SSD_ENABLED must be true or false");
    this.enabled = flag === "true" || flag === true;
    this.prepared = new PreparedSsdWorkspace(storage); // Does not inspect/open SSD.
    this.maxChunkSize = parseMaxChunkSize(config.get("MAX_CHUNK_SIZE"));
    this.maxFileSize = this.limit(config.get("MAX_FILE_SIZE"), 1099511627776, true);
    this.maxTotalSize = this.limit(config.get("MAX_TOTAL_SIZE"), 2199023255552, true);
    this.maxChunks = this.limit(config.get("MAX_UPLOAD_CHUNKS"), 100000);
    if (this.maxChunks > 2147483647) throw new Error("MAX_UPLOAD_CHUNKS exceeds database capacity");
    this.ttlMs = this.limit(config.get("UPLOAD_SESSION_TTL_HOURS"), 24) * 3600000;
    if (!Number.isSafeInteger(this.ttlMs)) throw new Error("Upload TTL exceeds safe capacity");
    const mode = config.get("UPLOAD_SSD_RECOVERY_MODE") ?? "manual";
    if (mode !== "manual" && mode !== "once") throw new Error("UPLOAD_SSD_RECOVERY_MODE must be manual or once");
    this.recoveryMode = mode;
  }

  private limit(raw: unknown, fallback: number, zero = false): number {
    const value = raw === undefined || raw === null ? fallback : Number(raw);
    if (String(raw).trim() === "" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
      throw new BadRequestException("Invalid SSD upload limit");
    return value;
  }
  private requireEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("SSD uploads are disabled");
  }
  private active(session: UploadSessionEntity): void {
    if (!["pending", "uploading"].includes(session.status)) throw new BadRequestException(`Upload session is ${session.status}`);
    if (session.expiresAt && session.expiresAt <= new Date()) throw new BadRequestException("Upload session expired");
  }
  private async workspace(): Promise<UploadWorkspaceEntity> {
    this.requireEnabled();
    const record = await this.db.getRepository(UploadWorkspaceEntity).findOneBy({ id: SSD_UPLOAD_WORKSPACE.id });
    if (!record || Object.entries(SSD_UPLOAD_WORKSPACE).some(([key, value]) => record[key as keyof UploadWorkspaceEntity] !== value))
      throw new ServiceUnavailableException("SSD workspace is not enrolled");
    return record;
  }
  private async lock(): Promise<{ root: string; filesystem: SecureFilesystem; release(): void }> {
    const record = await this.workspace();
    let fd: number | undefined;
    try {
      const root = this.prepared.root(record);
      const filesystem = this.prepared.filesystem(record);
      const expected = filesystem.stat(root, true);
      fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const actual = fs.fstatSync(fd);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("SSD root changed");
      filesystem.lock(fd);
      const owned = fd;
      fd = undefined;
      let released = false;
      return { root, filesystem, release: () => { if (!released) { released = true; fs.closeSync(owned); } } };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw new ServiceUnavailableException("SSD workspace unavailable or busy", { cause: error });
    }
  }
  private async ownedSession(userId: number, uploadId: string): Promise<UploadSessionEntity> {
    this.requireEnabled();
    const session = await this.db.getRepository(UploadSessionEntity).findOneBy({ userId, uploadId, workspaceId: SSD_UPLOAD_WORKSPACE.id, origin: "owner" });
    if (!session) throw new NotFoundException("Upload session not found");
    return session;
  }
  async getUploadSession(userId: number, uploadId: string): Promise<UploadSessionEntity> {
    const session = await this.ownedSession(userId, uploadId);
    if (!session.expectedSha256 || session.expectedSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(session.expectedSha256))
      throw new ServiceUnavailableException("SSD session has no durable whole-file SHA256");
    const record = await this.workspace();
    this.prepared.resolve(session, record);
    return session;
  }
  private async capacity(root: string, additional: number): Promise<void> {
    const [totals] = await this.db.query(`SELECT COALESCE(SUM("totalSize"-"uploadedSize") FILTER (WHERE "workspaceId"=$1),0)::text remaining, COALESCE(SUM("totalSize"),0)::text hdd FROM upload_sessions WHERE status IN ('pending','uploading')`, [SSD_UPLOAD_WORKSPACE.id]);
    const free = (target: string): bigint => { const stat = fs.statfsSync(target, { bigint: true }); return stat.bavail * stat.bsize; };
    if (free(root) < BigInt(totals.remaining) + BigInt(additional) + BigInt(this.maxChunkSize) ||
      free(this.storage.getStoragePath()) < BigInt(totals.hdd) + BigInt(additional) + BigInt(this.maxChunkSize))
      throw new ServiceUnavailableException("Insufficient SSD or HDD capacity");
  }
  private async durable(manager: EntityManager): Promise<void> {
    await manager.query("SET LOCAL synchronous_commit=on");
    const [settings] = await manager.query("SELECT current_setting('fsync') fsync,current_setting('full_page_writes') pages");
    if (settings.fsync !== "on" || settings.pages !== "on") throw new ServiceUnavailableException("Durable database settings required");
  }
  async createUploadSession(userId: number, filename: string, totalSize: number, chunkSize: number, parentId?: number | null, expectedSha256?: string): Promise<UploadSessionEntity> {
    this.requireEnabled();
    if (typeof filename !== "string" || !filename.trim() || [".", ".."].includes(filename) || filename.length > 255 || filename.includes("/") || filename.includes("\\") || [...filename].some((character) => { const code = character.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); })) throw new BadRequestException("Invalid filename");
    if (!expectedSha256 || expectedSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new BadRequestException("SSD uploads require whole-file SHA256");
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > this.maxChunkSize || (this.maxFileSize && totalSize > this.maxFileSize) || Math.ceil(totalSize / chunkSize) > this.maxChunks) throw new BadRequestException("Invalid upload size");
    if (parentId !== undefined && parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0)) throw new BadRequestException("Invalid target folder");
    const capability = await this.lock();
    let session: UploadSessionEntity | undefined;
    try {
      await this.capacity(capability.root, totalSize);
      const uploadId = randomUUID();
      session = await this.db.transaction(async (manager) => {
        await this.durable(manager);
        const user = await manager.findOne(UserEntity, { where: { id: userId }, lock: { mode: "pessimistic_write" } });
        if (!user) throw new ForbiddenException("User not found");
        const [reservation] = await manager.query(`SELECT COALESCE(SUM("totalSize"),0)::text bytes FROM upload_sessions WHERE "userId"=$1 AND status IN ('pending','uploading')`, [userId]);
        const active = BigInt(reservation.bytes);
        if (BigInt(user.storageUsed) + active + BigInt(totalSize) > BigInt(user.storageQuota)) throw new BadRequestException("Storage quota exceeded");
        if (this.maxTotalSize && active + BigInt(totalSize) > BigInt(this.maxTotalSize)) throw new BadRequestException("Active upload limit exceeded");
        if (parentId && !(await manager.findOne(FolderEntity, { where: { id: parentId, userId, isDeleted: false } }))) throw new ForbiddenException("Target folder unavailable");
        return manager.save(manager.create(UploadSessionEntity, { userId, uploadId, filename, totalSize, chunkSize, totalChunks: Math.ceil(totalSize / chunkSize), uploadedSize: 0, uploadedCount: 0, accountingInitialized: true, workspaceId: SSD_UPLOAD_WORKSPACE.id, tempPath: path.join(capability.root, uploadId), expectedSha256, parentId: parentId ?? null, status: "pending", expiresAt: new Date(Date.now() + this.ttlMs) }));
      });
      capability.filesystem.mkdir(session.tempPath);
      capability.filesystem.sync(session.tempPath, true);
      capability.filesystem.sync(capability.root, true);
      return session;
    } catch (error) {
      // Never delete an uncheckpointed directory. Its terminal row is retained.
      if (session) await this.db.getRepository(UploadSessionEntity).update({ id: session.id }, { status: "aborted" }).catch(() => this.logger.error("SSD admission compensation pending"));
      throw error;
    } finally { capability.release(); }
  }
  async acquireIngress(userId: number, uploadId: string): Promise<SsdIngressCapability> {
    const lock = await this.lock();
    try {
      const session = await this.getUploadSession(userId, uploadId);
      this.active(session);
      await this.requireUnreserved(session.id);
      await this.capacity(lock.root, 0);
      const destination = this.prepared.ingress(SSD_UPLOAD_WORKSPACE);
      lock.filesystem.mkdir(destination);
      lock.filesystem.sync(lock.root, true);
      const capability: SsdIngressCapability = {
        ...lock, destination,
        guard: (target) => {
          if (!this.capabilities.has(capability) || path.dirname(target) !== destination || target !== path.resolve(target)) throw new BadRequestException("Invalid SSD ingress capability");
          this.storage.assertPreparedSsdPath(target);
        },
        release: () => {
          const state = this.capabilities.get(capability);
          if (!state) return;
          state.releaseRequested = true;
          if (state.users === 0) { this.capabilities.delete(capability); lock.release(); }
        },
      };
      this.capabilities.set(capability, { userId, uploadId, users: 0, releaseRequested: false });
      return capability;
    } catch (error) { lock.release(); throw error; }
  }
  private async requireUnreserved(sessionId: number, manager: EntityManager = this.db.manager): Promise<void> {
    const rows = await manager.query(`SELECT id FROM ssd_finalization_operations WHERE "sessionId"=$1 AND "cleanupState"='pending'`, [sessionId]);
    if (rows.length) throw new ServiceUnavailableException("Upload finalization is reserved; recovery required");
  }
  private async digest(fd: number, expectedSize: number): Promise<string> {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size !== expectedSize) throw new BadRequestException("Chunk size or type changed");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < expectedSize;) {
      const count = await new Promise<number>((resolve, reject) => fs.read(fd, buffer, 0, Math.min(buffer.length, expectedSize - offset), offset, (error, count) => error ? reject(error) : resolve(count)));
      if (!count) throw new BadRequestException("Truncated chunk");
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== stats.dev || after.ino !== stats.ino || after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || after.ctimeMs !== stats.ctimeMs) throw new BadRequestException("Chunk changed while hashing");
    return hash.digest("hex");
  }
  async uploadChunk(userId: number, uploadId: string, chunkIndex: number, data: Buffer | IngressChunkFile, capability?: SsdIngressCapability): Promise<UploadSessionEntity> {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new BadRequestException("Invalid chunk index");
    let owned = false;
    if (capability) {
      const binding = this.capabilities.get(capability);
      if (!binding || binding.releaseRequested || binding.userId !== userId || binding.uploadId !== uploadId) throw new BadRequestException("Invalid SSD ingress ownership");
    } else { capability = await this.acquireIngress(userId, uploadId); owned = true; }
    const capabilityState = this.capabilities.get(capability)!;
    capabilityState.users++;
    let fd: number | undefined;
    let targetFd: number | undefined;
    try {
      const session = await this.getUploadSession(userId, uploadId);
      this.active(session); await this.requireUnreserved(session.id);
      const size = Buffer.isBuffer(data) ? data.length : data.size;
      const expected = chunkIndex === session.totalChunks - 1 ? session.totalSize - chunkIndex * session.chunkSize : session.chunkSize;
      if (chunkIndex >= session.totalChunks || size !== expected || size > this.maxChunkSize) throw new BadRequestException("Chunk size does not match expected size");
      let sha256: string;
      if (Buffer.isBuffer(data)) sha256 = createHash("sha256").update(data).digest("hex");
      else { capability.guard(data.path); fd = capability.filesystem.open(data.path); sha256 = await this.digest(fd, size); }
      const record = await this.db.getRepository(UploadChunkEntity).findOneBy({ sessionId: session.id, chunkIndex });
      if (record && (record.sha256 !== sha256 || record.byteSize !== size)) throw new BadRequestException("Chunk already uploaded with different content");
      const target = path.join(session.tempPath, String(chunkIndex));
      let exists = false;
      try {
        targetFd = capability.filesystem.open(target, "rw"); exists = true;
        if (await this.digest(targetFd, size) !== sha256) throw new BadRequestException("Untrusted existing chunk");
        fs.fsyncSync(targetFd);
      } catch (error) { if (exists || (error as { code?: string }).code !== "ENOENT") throw error; }
      if (!exists) {
        if (Buffer.isBuffer(data)) {
          targetFd = capability.filesystem.open(target, "wx");
          await new Promise<void>((resolve, reject) => fs.writeFile(targetFd!, data, (error) => error ? reject(error) : resolve()));
          fs.fsyncSync(targetFd);
        } else {
          fs.fsyncSync(fd!);
          capability.filesystem.rename(data.path, target);
          const current = capability.filesystem.stat(target), original = fs.fstatSync(fd!);
          if (current.dev !== original.dev || current.ino !== original.ino) throw new BadRequestException("Ingress identity changed");
          capability.filesystem.sync(capability.destination, true);
        }
      }
      capability.filesystem.sync(session.tempPath, true);
      return await this.db.transaction(async (manager) => {
        await this.durable(manager);
        const current = await manager.findOne(UploadSessionEntity, { where: { id: session.id, workspaceId: SSD_UPLOAD_WORKSPACE.id }, lock: { mode: "pessimistic_write" } });
        if (!current) throw new NotFoundException("Upload session not found");
        this.active(current); await this.requireUnreserved(current.id, manager);
        const repository = manager.getRepository(UploadChunkEntity);
        const previous = await repository.findOneBy({ sessionId: current.id, chunkIndex });
        if (previous && (previous.sha256 !== sha256 || previous.byteSize !== size)) throw new BadRequestException("Chunk manifest changed");
        if (!previous) {
          await repository.insert({ sessionId: current.id, chunkIndex, byteSize: size, sha256 });
          current.uploadedCount++; current.uploadedSize += size;
        }
        current.status = "uploading";
        return manager.save(current);
      });
    } finally {
      if (targetFd !== undefined) fs.closeSync(targetFd);
      if (fd !== undefined) {
        try { capability.filesystem.removeOwned((data as IngressChunkFile).path, fd); }
        catch (error) { if ((error as { code?: string }).code !== "ENOENT") this.logger.warn("SSD ingress cleanup retained"); }
        fs.closeSync(fd);
      }
      if (owned) capability.release();
      capabilityState.users--;
      if (capabilityState.releaseRequested) capability.release();
    }
  }
  private filesystem(): IsolatedSsdFinalizationFilesystem {
    return new IsolatedSsdFinalizationFilesystem(this.storage, this.prepared, SSD_UPLOAD_WORKSPACE);
  }
  private async finalizationAttempt<T>(attempt: () => Promise<T>): Promise<T> {
    try { return await attempt(); }
    catch (error) {
      // Classify only known nonblocking locks/slot contention. Corruption and
      // ambiguous commit errors retain their identity and recovery semantics.
      let cause: unknown = error;
      for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
        const failure = cause as { code?: string; message?: string; cause?: unknown };
        if (failure.code === "EWOULDBLOCK" || failure.code === "EAGAIN" || failure.message === "Isolated finalizer is busy")
          throw new ServiceUnavailableException("SSD finalization is busy", { cause: error });
        cause = failure.cause;
      }
      throw error;
    }
  }
  private recovery(id: string) {
    return this.finalizationAttempt(() => new SsdFinalizationRecovery(this.store, this.filesystem(), (fd, operation) => checkpointSsdMime(this.store, fd, operation)).recover(id));
  }
  async completeUpload(userId: number, uploadId: string): Promise<FileEntity> {
    const session = await this.ownedSession(userId, uploadId);
    const [operation] = await this.db.query(`SELECT id FROM ssd_finalization_operations WHERE "userId"=$1 AND "uploadId"=$2`, [userId, uploadId]);
    if (operation) {
      const outcome = await this.store.lookup(operation.id);
      // A cleaned commit receipt releases the temporary filesystem dependency.
      // Replays must survive missing SSD and subsequent ordinary File lifecycle.
      if (outcome.operation.cleanupState === "cleaned") {
        if (!outcome.file) throw new NotFoundException("Completed upload file not found");
        return outcome.file;
      }
      const file = await this.recovery(operation.id);
      if (!file) throw new ServiceUnavailableException("Finalization outcome unavailable");
      return file;
    }
    await this.getUploadSession(userId, uploadId);
    this.active(session);
    if (session.uploadedCount !== session.totalChunks || session.uploadedSize !== session.totalSize) throw new BadRequestException("Upload is incomplete");
    await this.capacity(this.prepared.root(await this.workspace()), 0);
    const file = await this.finalizationAttempt(() => new SsdCrossFsFinalizer(this.store, this.filesystem(), (fd, operation) => checkpointSsdMime(this.store, fd, operation)).finalize({ userId, uploadId, expectedSha256: session.expectedSha256! }));
    const [committed] = await this.db.query(`SELECT id FROM ssd_finalization_operations WHERE "userId"=$1 AND "uploadId"=$2`, [userId, uploadId]);
    if (committed) {
      try { await this.recovery(committed.id); }
      catch { this.logger.warn("Committed SSD upload cleanup pending"); }
    }
    return file;
  }
  async abortUpload(userId: number, uploadId: string, expiredOnly = false): Promise<void> {
    const lock = await this.lock();
    try {
      const session = await this.getUploadSession(userId, uploadId);
      await this.db.transaction(async (manager) => {
        await this.durable(manager);
        const current = await manager.findOne(UploadSessionEntity, { where: { id: session.id }, lock: { mode: "pessimistic_write" } });
        if (!current) throw new NotFoundException("Upload session not found");
        if (expiredOnly && (!current.expiresAt || current.expiresAt > new Date())) return;
        if (current.status === "completed") throw new BadRequestException("Cannot abort a completed upload");
        await this.requireUnreserved(current.id, manager);
        current.status = "aborted"; await manager.save(current);
      });
      const current = await this.db.getRepository(UploadSessionEntity).findOneByOrFail({ id: session.id });
      if (current.status !== "aborted") return;
      const chunks = await this.db.getRepository(UploadChunkEntity).find({ where: { sessionId: session.id }, order: { chunkIndex: "ASC" }, take: this.maxChunks });
      for (const chunk of chunks) {
        const target = path.join(session.tempPath, String(chunk.chunkIndex));
        let fd: number | undefined;
        try {
          fd = lock.filesystem.open(target);
          if (await this.digest(fd, chunk.byteSize) !== chunk.sha256) throw new Error("Chunk ownership mismatch");
          lock.filesystem.removeOwned(target, fd);
          lock.filesystem.sync(session.tempPath, true);
          await this.db.getRepository(UploadChunkEntity).delete({ sessionId: session.id, chunkIndex: chunk.chunkIndex });
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") this.logger.warn("Cancelled SSD chunk retained for inspection");
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      lock.filesystem.sync(session.tempPath, true);
      // Unknown names and directory identity are retained; never recursive delete.
    } finally { lock.release(); }
  }
  private metadata(session: UploadSessionEntity) {
    return { uploadId: session.uploadId, filename: session.filename, totalSize: session.totalSize, chunkSize: session.chunkSize, totalChunks: session.totalChunks, uploadedSize: session.uploadedSize, status: session.status, expiresAt: session.expiresAt, parentId: session.parentId ?? null };
  }
  async reconcileUploadSession(userId: number, uploadId: string) {
    const session = await this.ownedSession(userId, uploadId);
    if (session.status === "completed") {
      const file = await this.db.getRepository(FileEntity).findOneBy({ userId, uploadId });
      if (!file) throw new NotFoundException("Completed upload file not found");
      return { ...this.metadata(session), chunks: [], file: { id: file.id, name: file.name, size: Number(file.size), mimeType: file.mimeType, parentId: file.parentId ?? null, uploadId: file.uploadId } };
    }
    if (session.status === "aborted") return { ...this.metadata(session), uploadedSize: 0, chunks: [] };
    await this.getUploadSession(userId, uploadId);
    this.active(session);
    const chunks = await this.db.getRepository(UploadChunkEntity).find({ where: { sessionId: session.id }, order: { chunkIndex: "ASC" }, take: this.maxChunks });
    return { ...this.metadata(session), chunks: chunks.map(({ chunkIndex, byteSize, sha256 }) => ({ chunkIndex, byteSize, sha256 })) };
  }
  async listUploadSessions(userId: number) {
    this.requireEnabled();
    const sessions = await this.db.getRepository(UploadSessionEntity).find({ where: { userId, workspaceId: SSD_UPLOAD_WORKSPACE.id, status: In(["pending", "uploading"]) }, order: { createdAt: "DESC" } });
    return sessions.map((session) => this.metadata(session));
  }
  async cleanupExpiredSessions(): Promise<number> {
    if (!this.enabled) return 0;
    const sessions = await this.db.getRepository(UploadSessionEntity).find({ where: { workspaceId: SSD_UPLOAD_WORKSPACE.id, status: In(["pending", "uploading"]), expiresAt: LessThanOrEqual(new Date()) }, take: 128 });
    let cleaned = 0;
    for (const session of sessions) {
      try { await this.abortUpload(session.userId, session.uploadId, true); cleaned++; }
      catch { this.logger.warn("Expired SSD upload retained; busy or recovery required"); }
    }
    return cleaned;
  }
  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.startupAttempted || this.recoveryMode !== "once") return;
    this.startupAttempted = true;
    // One bounded pass. Historical journals rejected by SSD store remain barriers.
    const rows = await this.db.query(`SELECT id FROM ssd_finalization_operations WHERE "cleanupState"='pending' ORDER BY id LIMIT 128`);
    for (const row of rows) {
      try { await this.recovery(row.id); }
      catch { this.logger.warn("SSD startup recovery retained operation for inspection"); }
    }
  }
  onModuleDestroy(): void { this.prepared.close(); }
}
