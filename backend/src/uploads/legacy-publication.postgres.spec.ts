import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource, QueryRunner } from "typeorm";
import appDataSource from "../data-source";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { StorageLocationEntity, LEGACY_STORAGE_LOCATION } from "../entities/storage-location.entity";
import { UploadWorkspaceEntity, LEGACY_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { FilesService } from "../files/files.service";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { UploadsService } from "./uploads.service";

jest.mock("./file-type.loader", () => ({ fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined) }));

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Operation exceeded 5s: possible deadlock")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describePostgres("Legacy upload publication — real PostgreSQL service races", () => {
  const schema = `publication_${randomUUID().replace(/-/g, "")}`;
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-publication-"));
  let admin: DataSource;
  let source: DataSource;
  let storage: StorageService;
  let uploads: UploadsService;
  let files: FilesService;

  beforeAll(async () => {
    admin = new DataSource({ type: "postgres", url: databaseUrl });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    source = new DataSource({
      type: "postgres", url: databaseUrl, schema, synchronize: true,
      entities: appDataSource.options.entities,
      extra: { max: 8, options: `-c search_path=${schema} -c statement_timeout=4000 -c lock_timeout=3000` },
    });
    await source.initialize();
    await source.getRepository(StorageLocationEntity).save(LEGACY_STORAGE_LOCATION);
    await source.getRepository(UploadWorkspaceEntity).save(LEGACY_UPLOAD_WORKSPACE);
    const config = new ConfigService({ STORAGE_PATH: storageRoot,
      MAX_FILE_SIZE: 1024 * 1024, MAX_TOTAL_SIZE: 1024 * 1024, MAX_CHUNK_SIZE: 1024 * 1024 });
    storage = new StorageService(config);
    const users = new UsersService(source.getRepository(UserEntity));
    uploads = new UploadsService(source.getRepository(UploadSessionEntity), source.getRepository(FileEntity),
      source.getRepository(FolderEntity), storage, users, config);
    files = new FilesService(source.getRepository(FileEntity), source.getRepository(FolderEntity), storage, users);
  }, 30000);

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    uploads?.onModuleDestroy();
    storage?.onModuleDestroy();
    if (source?.isInitialized) await source.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  async function user(quota = 128) {
    return source.getRepository(UserEntity).save({ email: `${randomUUID()}@example.test`, password: "hash",
      storageQuota: quota, storageUsed: 0 });
  }

  async function folder(userId: number, parentId?: number) {
    const mirror = await files.createFolder(userId, randomUUID(), parentId);
    return mirror.folderId!;
  }

  async function staged(userId: number, parentId?: number, filename = "data.bin") {
    const bytes = Buffer.from([0, 255, 128, 42, 17, 0]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const session = await uploads.createUploadSession(userId, filename, bytes.length, 2, parentId, digest);
    // Out-of-order committed chunks exercise the same resume records as owner uploads.
    for (const index of [2, 0, 1]) {
      await uploads.uploadChunk(userId, session.uploadId, index, bytes.subarray(index * 2, (index + 1) * 2));
    }
    return { session, bytes, digest };
  }

  function pauseBeforePublication(session: UploadSessionEntity) {
    const entered = gate();
    const release = gate();
    const internals = uploads as unknown as { syncDirectory(directory: string): Promise<void> };
    const original = internals.syncDirectory.bind(uploads);
    let paused = false;
    const spy = jest.spyOn(internals, "syncDirectory").mockImplementation(async (directory) => {
      await original(directory);
      if (directory === session.tempPath && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    });
    return { entered: bounded(entered.promise), release: release.resolve, restore: () => spy.mockRestore() };
  }

  async function used(userId: number) {
    return Number((await source.getRepository(UserEntity).findOneByOrFail({ id: userId })).storageUsed);
  }

  async function assertPublished(session: UploadSessionEntity, bytes: Buffer, file: FileEntity) {
    expect(fs.readFileSync(file.storagePath)).toEqual(bytes);
    expect(file.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await source.getRepository(FileEntity).countBy({ userId: session.userId, uploadId: session.uploadId })).toBe(1);
    expect((await source.getRepository(UploadSessionEntity).findOneByOrFail({ id: session.id })).status).toBe("completed");
    expect(await source.getRepository(UploadChunkEntity).countBy({ sessionId: session.id })).toBe(0);
    expect(fs.existsSync(session.tempPath)).toBe(false);
  }

  it("publishes ordinary chunks with SHA-256 and replays complete without quota inflation", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const result = await bounded(uploads.completeUpload(owner.id, session.uploadId));
    await assertPublished(session, bytes, result);
    expect((await uploads.completeUpload(owner.id, session.uploadId)).id).toBe(result.id);
    expect(await used(owner.id)).toBe(bytes.length);
  }, 10000);

  it.each(["hard-delete", "empty-trash"] as const)(
    "%s finishes during assembly; complete rejects without resurrecting the target or losing quota", async (mode) => {
      const owner = await user();
      const target = await folder(owner.id);
      const existing = await staged(owner.id, target, "existing.bin");
      const oldFile = await uploads.completeUpload(owner.id, existing.session.uploadId);
      const { session } = await staged(owner.id, target);
      const barrier = pauseBeforePublication(session);
      const completion = uploads.completeUpload(owner.id, session.uploadId).then(
        (file) => ({ file, error: undefined }), (error: unknown) => ({ file: undefined, error }));
      try {
        await barrier.entered;
        // This must finish while assembly owns its fence. With the former row
        // lock, deletion waits for the session and the subsequent user lock cycles.
        if (mode === "empty-trash") {
          await bounded(files.removeFolder(owner.id, target));
          await bounded(files.emptyTrash(owner.id));
        } else {
          await bounded(files.deleteFolderPermanently(owner.id, target));
        }
        expect(await source.getRepository(FolderEntity).findOneBy({ id: target })).toBeNull();
        expect(await used(owner.id)).toBe(0);
        expect(fs.existsSync(oldFile.storagePath)).toBe(false);
        barrier.release();
        const result = await bounded(completion);
        expect(result.file).toBeUndefined();
        expect(result.error).toMatchObject({ status: 404 });
        expect(await source.getRepository(FileEntity).countBy({ uploadId: session.uploadId })).toBe(0);
        expect(await used(owner.id)).toBe(0);
        await uploads.abortUpload(owner.id, session.uploadId);
        expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(128);
        expect(fs.existsSync(session.tempPath)).toBe(false);
      } finally {
        barrier.release();
        await bounded(completion);
        barrier.restore();
      }
    }, 10000,
  );

  it("rejects publication when an ancestor is moved to trash during assembly", async () => {
    const owner = await user();
    const ancestor = await folder(owner.id);
    const target = await folder(owner.id, ancestor);
    const { session } = await staged(owner.id, target);
    const barrier = pauseBeforePublication(session);
    const completion = uploads.completeUpload(owner.id, session.uploadId).catch((error: unknown) => error);
    try {
      await barrier.entered;
      await bounded(files.removeFolder(owner.id, ancestor));
      barrier.release();
      expect(await bounded(completion)).toMatchObject({ status: 404 });
      expect(await source.getRepository(FileEntity).countBy({ uploadId: session.uploadId })).toBe(0);
      expect(await used(owner.id)).toBe(0);
      await uploads.abortUpload(owner.id, session.uploadId);
      expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(128);
    } finally {
      barrier.release();
      await bounded(completion);
      barrier.restore();
    }
  }, 10000);

  it("fences concurrent complete, abort, chunk and reconcile; expiry cleanup skips an active assembly", async () => {
    const owner = await user();
    const { session } = await staged(owner.id);
    const barrier = pauseBeforePublication(session);
    const completion = uploads.completeUpload(owner.id, session.uploadId).catch((error: unknown) => error);
    try {
      await barrier.entered;
      for (const operation of [
        () => uploads.completeUpload(owner.id, session.uploadId),
        () => uploads.abortUpload(owner.id, session.uploadId),
        () => uploads.uploadChunk(owner.id, session.uploadId, 0, Buffer.from([0, 255])),
        () => uploads.reconcileUploadSession(owner.id, session.uploadId),
      ]) await expect(bounded<unknown>(operation())).rejects.toMatchObject({ status: 409 });
      await source.getRepository(UploadSessionEntity).update(session.id, { expiresAt: new Date(0) });
      await bounded(uploads.cleanupExpiredSessions());
      expect(await source.getRepository(UploadSessionEntity).findOneBy({ id: session.id })).not.toBeNull();
      expect(fs.existsSync(session.tempPath)).toBe(true);
      barrier.release();
      expect(await bounded(completion)).toMatchObject({ status: 400 });
      await uploads.cleanupExpiredSessions();
      expect(await source.getRepository(UploadSessionEntity).findOneBy({ id: session.id })).toBeNull();
      expect(fs.existsSync(session.tempPath)).toBe(false);
      expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(128);
    } finally {
      barrier.release();
      await bounded(completion);
      barrier.restore();
    }
  }, 10000);

  it.each(["quota", "inactive-user"] as const)("rechecks %s at publication, retains chunks and releases reservation on repeated abort", async (kind) => {
    const owner = await user();
    const { session } = await staged(owner.id);
    const barrier = pauseBeforePublication(session);
    const completion = uploads.completeUpload(owner.id, session.uploadId).catch((error: unknown) => error);
    try {
      await barrier.entered;
      await source.getRepository(UserEntity).update(owner.id, kind === "quota" ? { storageQuota: 5 } : { isActive: false });
      barrier.release();
      expect(await bounded(completion)).toMatchObject({ status: 403 });
      expect(await used(owner.id)).toBe(0);
      expect(await source.getRepository(UploadChunkEntity).countBy({ sessionId: session.id })).toBe(3);
      expect(fs.readdirSync(session.tempPath).sort()).toEqual(["0", "1", "2"]);
      await uploads.abortUpload(owner.id, session.uploadId);
      await uploads.abortUpload(owner.id, session.uploadId);
      expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(kind === "quota" ? 5 : 128);
      expect(fs.existsSync(session.tempPath)).toBe(false);
    } finally {
      barrier.release();
      await bounded(completion);
      barrier.restore();
    }
  }, 10000);

  it("allocates colliding names atomically for parallel owner completions", async () => {
    const owner = await user();
    const target = await folder(owner.id);
    const first = await staged(owner.id, target, "same.bin");
    const second = await staged(owner.id, target, "same.bin");
    const results = await bounded(Promise.all([
      uploads.completeUpload(owner.id, first.session.uploadId),
      uploads.completeUpload(owner.id, second.session.uploadId),
    ]));
    expect(new Set(results.map((file) => file.name)).size).toBe(2);
    expect(results.map((file) => file.name)).toContain("same.bin");
    expect(new Set(results.map((file) => file.storagePath)).size).toBe(2);
    await assertPublished(first.session, first.bytes, results[0]);
    await assertPublished(second.session, second.bytes, results[1]);
    expect(await used(owner.id)).toBe(first.bytes.length + second.bytes.length);
  }, 10000);

  it("recovers after an injected failure between durable assembly and publication", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const internals = uploads as unknown as { syncDirectory(directory: string): Promise<void> };
    const original = internals.syncDirectory.bind(uploads);
    const failure = jest.spyOn(internals, "syncDirectory").mockImplementation(async (directory) => {
      await original(directory);
      if (directory === session.tempPath) throw new Error("Injected pre-publication interruption");
    });
    await expect(uploads.completeUpload(owner.id, session.uploadId)).rejects.toThrow("Injected pre-publication");
    failure.mockRestore();
    expect(await used(owner.id)).toBe(0);
    expect(await source.getRepository(FileEntity).countBy({ uploadId: session.uploadId })).toBe(0);
    expect(fs.readdirSync(session.tempPath).sort()).toEqual(["0", "1", "2"]);
    const result = await bounded(uploads.completeUpload(owner.id, session.uploadId));
    await assertPublished(session, bytes, result);
    expect(await used(owner.id)).toBe(bytes.length);
  }, 10000);

  it("hard-delete updates the session FK while assembly is paused, reproducing the original lock dependency", async () => {
    const owner = await user();
    const target = await folder(owner.id);
    const { session } = await staged(owner.id, target);
    // Owner sessions cannot carry the production public-share/root FKs. This
    // isolated test-only FK recreates their ON DELETE SET NULL session-row
    // dependency using the real services; it does not qualify the public API.
    // NOT VALID leaves unrelated stale owner parentIds from prior tests alone.
    await source.query(`ALTER TABLE upload_sessions ADD CONSTRAINT publication_test_parent_fk
      FOREIGN KEY ("parentId") REFERENCES folders(id) ON DELETE SET NULL NOT VALID`);
    const barrier = pauseBeforePublication(session);
    const completion = uploads.completeUpload(owner.id, session.uploadId).catch((error: unknown) => error);
    try {
      await barrier.entered;
      await bounded(files.deleteFolderPermanently(owner.id, target));
      expect((await source.getRepository(UploadSessionEntity).findOneByOrFail({ id: session.id })).parentId).toBeNull();
      expect(await source.getRepository(FolderEntity).findOneBy({ id: target })).toBeNull();
      barrier.release();
      expect(await bounded(completion)).toMatchObject({ status: 404 });
      expect(await source.getRepository(FileEntity).countBy({ uploadId: session.uploadId })).toBe(0);
      expect(await used(owner.id)).toBe(0);
      await uploads.abortUpload(owner.id, session.uploadId);
      expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(128);
      expect(fs.existsSync(session.tempPath)).toBe(false);
    } finally {
      barrier.release();
      await bounded(completion);
      barrier.restore();
      await source.query(`ALTER TABLE upload_sessions DROP CONSTRAINT publication_test_parent_fk`);
    }
  }, 10000);

  it("a retry after actual backend termination survives the old attempt unwinding", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const captured: QueryRunner[] = [];
    const createRunner = source.createQueryRunner.bind(source);
    const capture = jest.spyOn(source, "createQueryRunner").mockImplementation((mode) => {
      const runner = createRunner(mode);
      captured.push(runner);
      return runner;
    });
    const barrier = pauseBeforePublication(session);
    const oldCompletion = uploads.completeUpload(owner.id, session.uploadId).then(
      (file) => ({ file, error: undefined }), (error: unknown) => ({ file: undefined, error }));
    try {
      await barrier.entered;
      capture.mockRestore();
      const assemblyRunner = captured.find((runner) => !runner.isReleased && !runner.isTransactionActive);
      expect(assemblyRunner).toBeDefined();
      const connection = (assemblyRunner as QueryRunner & { databaseConnection: { processID: number } }).databaseConnection;
      expect(connection.processID).toBeGreaterThan(0);
      const oldAttempts = fs.readdirSync(session.tempPath).filter((entry) => entry.startsWith(".assembly-"));
      expect(oldAttempts).toHaveLength(1);
      const [{ terminated }] = await admin.query("SELECT pg_terminate_backend($1, 1000) AS terminated", [connection.processID]);
      expect(terminated).toBe(true);
      // No release of the old JS barrier yet: only PostgreSQL released its fence.
      const retry = await bounded(uploads.completeUpload(owner.id, session.uploadId));
      const oldAttemptId = oldAttempts[0].slice(".assembly-".length);
      expect(retry.storagePath).not.toBe(storage.generateFinalPath(owner.id, `${session.uploadId}.${oldAttemptId}`, session.filename));
      await assertPublished(session, bytes, retry);
      barrier.release();
      const oldResult = await bounded(oldCompletion);
      expect(oldResult.file).toBeUndefined();
      expect(oldResult.error).toBeDefined();
      await assertPublished(session, bytes, retry);
      expect(await used(owner.id)).toBe(bytes.length);
    } finally {
      barrier.release();
      await bounded(oldCompletion);
      barrier.restore();
      capture.mockRestore();
    }
  }, 10000);

  it("completes using one pooled PostgreSQL connection without requesting a second connection", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const singleSource = new DataSource({
      type: "postgres", url: databaseUrl, schema, entities: appDataSource.options.entities,
      extra: { max: 1, connectionTimeoutMillis: 2000,
        options: `-c search_path=${schema} -c statement_timeout=4000 -c lock_timeout=3000` },
    });
    const config = new ConfigService({ STORAGE_PATH: storageRoot,
      MAX_FILE_SIZE: 1024 * 1024, MAX_TOTAL_SIZE: 1024 * 1024, MAX_CHUNK_SIZE: 1024 * 1024 });
    const singleStorage = new StorageService(config);
    let singleUploads: UploadsService | undefined;
    try {
      await singleSource.initialize();
      singleUploads = new UploadsService(singleSource.getRepository(UploadSessionEntity),
        singleSource.getRepository(FileEntity), singleSource.getRepository(FolderEntity), singleStorage,
        new UsersService(singleSource.getRepository(UserEntity)), config);
      const result = await bounded(singleUploads.completeUpload(owner.id, session.uploadId));
      await assertPublished(session, bytes, result);
      expect(await used(owner.id)).toBe(bytes.length);
    } finally {
      singleUploads?.onModuleDestroy();
      singleStorage.onModuleDestroy();
      if (singleSource.isInitialized) await singleSource.destroy();
    }
  }, 10000);

  it("repairs a historical pending status with an existing charged File without a second debit", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const first = await uploads.completeUpload(owner.id, session.uploadId);
    // Historical interrupted recovery state: metadata and bytes already belong to owner.
    await source.getRepository(UploadSessionEntity).update(session.id, { status: "uploading" });
    const recovered = await bounded(uploads.completeUpload(owner.id, session.uploadId));
    expect(recovered.id).toBe(first.id);
    await assertPublished(session, bytes, recovered);
    expect(await used(owner.id)).toBe(bytes.length);
  }, 10000);

  it("reclaims an uncommitted linked attempt and its quota reservation after an interrupted COMMIT", async () => {
    const owner = await user();
    const { session } = await staged(owner.id);
    const createRunner = source.createQueryRunner.bind(source);
    const runnerSpy = jest.spyOn(source, "createQueryRunner").mockImplementation((mode) => {
      const runner = createRunner(mode);
      jest.spyOn(runner, "commitTransaction").mockRejectedValue(new Error("Injected failure before COMMIT"));
      return runner;
    });
    await expect(uploads.completeUpload(owner.id, session.uploadId)).rejects.toThrow("before COMMIT");
    runnerSpy.mockRestore();
    expect(await source.getRepository(FileEntity).countBy({ uploadId: session.uploadId })).toBe(0);
    expect(await used(owner.id)).toBe(0);
    const [attempt] = fs.readdirSync(session.tempPath).filter(entry => entry.startsWith(".assembly-"));
    expect(attempt).toBeDefined();
    const unpublished = storage.generateFinalPath(owner.id, `${session.uploadId}.${attempt.slice(".assembly-".length)}`, session.filename);
    expect(fs.existsSync(unpublished)).toBe(true);
    expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(122);
    await source.getRepository(UploadSessionEntity).update(session.id, { expiresAt: new Date(0) });
    await bounded(uploads.cleanupExpiredSessions());
    expect(fs.existsSync(unpublished)).toBe(false);
    expect(fs.existsSync(session.tempPath)).toBe(false);
    expect(await source.getRepository(UploadSessionEntity).countBy({ id: session.id })).toBe(0);
    expect((await uploads.getUploadLimits(owner.id)).quotaRemainingBytes).toBe(128);
  }, 10000);

  it("preserves committed bytes after a lost COMMIT acknowledgement and repairs cleanup on replay", async () => {
    const owner = await user();
    const { session, bytes } = await staged(owner.id);
    const createRunner = source.createQueryRunner.bind(source);
    let injected = false;
    const runnerSpy = jest.spyOn(source, "createQueryRunner").mockImplementation((mode) => {
      const runner: QueryRunner = createRunner(mode);
      const commit = runner.commitTransaction.bind(runner);
      jest.spyOn(runner, "commitTransaction").mockImplementation(async () => {
        await commit();
        if (!injected) {
          injected = true;
          throw new Error("Injected lost COMMIT acknowledgement");
        }
      });
      return runner;
    });
    await expect(uploads.completeUpload(owner.id, session.uploadId)).rejects.toThrow();
    runnerSpy.mockRestore();
    expect(injected).toBe(true);
    const committed = await source.getRepository(FileEntity).findOneByOrFail({ uploadId: session.uploadId });
    expect(fs.readFileSync(committed.storagePath)).toEqual(bytes);
    expect(await used(owner.id)).toBe(bytes.length);
    const replay = await bounded(uploads.completeUpload(owner.id, session.uploadId));
    expect(replay.id).toBe(committed.id);
    await assertPublished(session, bytes, replay);
    expect(await used(owner.id)).toBe(bytes.length);
  }, 10000);
});
