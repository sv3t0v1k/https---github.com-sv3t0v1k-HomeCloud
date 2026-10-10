import { SecureFilesystem } from "./secure-filesystem";
import { UploadWorkspaceEntity, LEGACY_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { StorageLocationEntity, LEGACY_STORAGE_LOCATION } from "../entities/storage-location.entity";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { UploadsService } from "./uploads.service";

jest.mock("./file-type.loader", () => ({
  fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined),
}));

const testDatabaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("UploadsService — реальный PostgreSQL", () => {
  const schema = `uploads_bigint_${randomUUID().replace(/-/g, "")}`;
  const storageRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "homecloud-uploads-bigint-test-"),
  );
  let admin: DataSource;
  let dataSource: DataSource;
  let service: UploadsService;

  beforeAll(async () => {
    admin = new DataSource({ type: "postgres", url: testDatabaseUrl });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dataSource = new DataSource({
      type: "postgres",
      url: testDatabaseUrl,
      schema,
      synchronize: true,
      extra: { options: `-c search_path=${schema}` },
      entities: [
        StorageLocationEntity,
        UserEntity,
        FileEntity,
        FolderEntity,
        ShareLinkEntity,
        UploadWorkspaceEntity,
        UploadSessionEntity,
        UploadChunkEntity,
        RefreshTokenEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(StorageLocationEntity).save(LEGACY_STORAGE_LOCATION);
    await dataSource.getRepository(UploadWorkspaceEntity).save(LEGACY_UPLOAD_WORKSPACE);
    const config = new ConfigService({
      STORAGE_PATH: storageRoot,
      MAX_FILE_SIZE: 1024 * 1024,
      MAX_TOTAL_SIZE: 1024 * 1024,
      MAX_CHUNK_SIZE: 1024 * 1024,
      ALLOWED_UPLOAD_MIME_TYPES: "application/octet-stream,text/plain",
    });
    service = new UploadsService(
      dataSource.getRepository(UploadSessionEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      new StorageService(config),
      new UsersService(dataSource.getRepository(UserEntity)),
      config,
    );
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it("нормализует BIGINT после reload и завершает upload без ложного size mismatch", async () => {
    const user = await dataSource.getRepository(UserEntity).save({
      email: `${randomUUID()}@example.test`,
      password: "hash",
      name: "Test",
      storageQuota: 1024 * 1024,
      storageUsed: 0,
    });
    const content = Buffer.from("postgres bigint boundary");
    const created = await service.createUploadSession(
      user.id,
      "boundary.bin",
      content.length,
      content.length,
    );
    fs.writeFileSync(path.join(created.tempPath, "0"), content);

    const reloaded = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({
        uploadId: created.uploadId,
        userId: user.id,
      });
    expect(typeof reloaded.totalSize).toBe("number");
    expect(reloaded.totalSize).toBe(content.length);
    expect(typeof reloaded.uploadedSize).toBe("number");
    expect(reloaded.uploadedSize).toBe(0);

    const file = await service.completeUpload(user.id, created.uploadId);
    expect(fs.readFileSync(file.storagePath)).toEqual(content);
    expect(file.storageLocationId).toBe(LEGACY_STORAGE_LOCATION.id);
    expect(file.relativeObjectKey).toBe(path.relative(storageRoot,file.storagePath));
    const completed = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({
        uploadId: created.uploadId,
        userId: user.id,
      });
    expect(completed.status).toBe("completed");
  });
  async function makeUser(quota = 1024 * 1024) {
    return dataSource.getRepository(UserEntity).save({
      email: `${randomUUID()}@example.test`,
      password: "hash",
      name: "Test",
      storageQuota: quota,
      storageUsed: 0,
    });
  }
  function configured(overrides: Record<string, number>) {
    const config = new ConfigService({
      STORAGE_PATH: storageRoot,
      MAX_FILE_SIZE: 1024 * 1024,
      MAX_TOTAL_SIZE: 1024 * 1024,
      MAX_CHUNK_SIZE: 10 * 1024 * 1024,
      ALLOWED_UPLOAD_MIME_TYPES: "application/octet-stream,text/plain",
      ...overrides,
    });
    return new UploadsService(
      dataSource.getRepository(UploadSessionEntity),
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      new StorageService(config),
      new UsersService(dataSource.getRepository(UserEntity)),
      config,
    );
  }

  it.each([
    ["raw.BIN", Buffer.from([0, 255, 3, 4, 128])],
    ["a".repeat(251) + ".BIN", Buffer.from([0, 255, 128])],
    ["report." + "Я".repeat(180), Buffer.from([0, 128, 255])],
    ["unknown.customtype", Buffer.from([0xff, 0x80, 0, 0xa5])],
    ["no-extension", Buffer.from([0, 1, 2])],
    ["misleading.jpg", Buffer.from([0, 1, 2, 255])],
    ["archive.7z", Buffer.from([0x50, 0x4b, 3, 4])],
    ["Русский файл.EXE", Buffer.from([0x4d, 0x5a, 0, 0])],
    ["moderate.bin", Buffer.alloc(256 * 1024, 0xa5)],
  ] as const)("preserves arbitrary bytes and exact filename %s", async (filename, content) => {
    const user = await makeUser(content.length);
    const session = await service.createUploadSession(user.id, filename, content.length, 4096);
    for (let index = 0; index < session.totalChunks; index++) {
      await service.uploadChunk(user.id, session.uploadId, index, content.subarray(index * 4096, (index + 1) * 4096));
    }
    const file = await service.completeUpload(user.id, session.uploadId);
    expect(file.name).toBe(filename);
    expect(file.mimeType).toBe("application/octet-stream");
    expect(file.storageLocationId).toBe(LEGACY_STORAGE_LOCATION.id);
    expect(file.relativeObjectKey).toBe(path.relative(storageRoot,file.storagePath));
    const stored = fs.readFileSync(file.storagePath);
    expect(stored).toEqual(content);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
    expect(Number((await dataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id })).storageUsed)).toBe(content.length);
    expect(await dataSource.getRepository(UploadChunkEntity).countBy({ sessionId: session.id })).toBe(0);
    expect(fs.existsSync(session.tempPath)).toBe(false);
  });

  it("reconciles committed chunks, restricts ownership, and discovers uploading sessions", async () => {
    const user = await makeUser(6);
    const foreign = await makeUser(6);
    const session = await service.createUploadSession(user.id, "resume.bin", 6, 2);
    await service.uploadChunk(user.id, session.uploadId, 1, Buffer.from([0, 255]));
    const snapshot = await service.reconcileUploadSession(user.id, session.uploadId);
    expect(snapshot).toMatchObject({ status: "uploading", uploadedSize: 2, chunks: [{ chunkIndex: 1, byteSize: 2 }] });
    expect(snapshot.chunks[0].sha256).toBe(createHash("sha256").update(Buffer.from([0, 255])).digest("hex"));
    expect(JSON.stringify(snapshot)).not.toContain(storageRoot);
    expect((await service.listUploadSessions(user.id)).map((item) => item.uploadId)).toEqual([session.uploadId]);
    await expect(service.reconcileUploadSession(foreign.id, session.uploadId)).rejects.toThrow("Upload session not found");
    expect(await service.listUploadSessions(foreign.id)).toEqual([]);
    await service.uploadChunk(user.id, session.uploadId, 0, Buffer.from([1, 2]));
    await service.uploadChunk(user.id, session.uploadId, 2, Buffer.from([3, 4]));
    const file = await service.completeUpload(user.id, session.uploadId);
    await dataSource.getRepository(UploadSessionEntity).update(session.id, { expiresAt: new Date(0) });
    const completed = await service.reconcileUploadSession(user.id, session.uploadId);
    expect(completed).toMatchObject({ status: "completed", chunks: [], file: { id: file.id, size: 6 } });
    expect((await service.getUploadLimits(user.id)).quotaRemainingBytes).toBe(0);
  });

  it("hides expired sessions and cleanup releases their reservations and chunks", async () => {
    const user = await makeUser(4);
    const session = await service.createUploadSession(user.id, "stale.bin", 4, 2);
    await service.uploadChunk(user.id, session.uploadId, 0, Buffer.from([0, 255]));
    await dataSource.getRepository(UploadSessionEntity).update(session.id, { expiresAt: new Date(0) });
    expect(await service.listUploadSessions(user.id)).toEqual([]);
    await expect(service.reconcileUploadSession(user.id, session.uploadId)).rejects.toThrow("expired");
    await service.cleanupExpiredSessions();
    expect((await service.getUploadLimits(user.id)).quotaRemainingBytes).toBe(4);
    expect(await dataSource.getRepository(UploadChunkEntity).countBy({ sessionId: session.id })).toBe(0);
    expect(fs.existsSync(session.tempPath)).toBe(false);
  });

  it("aborting one session preserves sibling progress and only releases its reservation", async () => {
    const user = await makeUser(8);
    const first = await service.createUploadSession(user.id, "cancel.bin", 4, 2);
    const sibling = await service.createUploadSession(user.id, "keep.bin", 4, 2);
    await service.uploadChunk(user.id, first.uploadId, 0, Buffer.from([0, 255]));
    await service.uploadChunk(user.id, sibling.uploadId, 0, Buffer.from([1, 2]));
    await service.abortUpload(user.id, first.uploadId);
    expect((await service.getUploadLimits(user.id)).quotaRemainingBytes).toBe(4);
    expect(await service.reconcileUploadSession(user.id, sibling.uploadId)).toMatchObject({ uploadedSize: 2, chunks: [{ chunkIndex: 0 }] });
    expect(await service.reconcileUploadSession(user.id, first.uploadId)).toMatchObject({ status: "aborted", uploadedSize: 0, chunks: [] });
    await service.uploadChunk(user.id, sibling.uploadId, 1, Buffer.from([3, 4]));
    const file = await service.completeUpload(user.id, sibling.uploadId);
    expect(fs.readFileSync(file.storagePath)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(await dataSource.getRepository(UploadChunkEntity).countBy({ sessionId: first.id })).toBe(0);
    expect(fs.existsSync(first.tempPath)).toBe(false);
  });

  it.each([1, 2, 3, 7])(
    "streams tiny/exact/chunk+1/multichunk %i-byte uploads",
    async (size) => {
      const user = await makeUser(size);
      const session = await service.createUploadSession(
        user.id,
        "matrix.txt",
        size,
        2,
      );
      const content = Buffer.alloc(size, 0x61);
      for (let index = 0; index < session.totalChunks; index++) {
        await service.uploadChunk(
          user.id,
          session.uploadId,
          index,
          content.subarray(index * 2, (index + 1) * 2),
        );
      }
      const file = await service.completeUpload(user.id, session.uploadId);
      expect(fs.readFileSync(file.storagePath)).toEqual(content);
    expect(file.storageLocationId).toBe(LEGACY_STORAGE_LOCATION.id);
    expect(file.relativeObjectKey).toBe(path.relative(storageRoot,file.storagePath));
      expect(
        Number(
          (
            await dataSource
              .getRepository(UserEntity)
              .findOneByOrFail({ id: user.id })
          ).storageUsed,
        ),
      ).toBe(size);
    },
  );

  it("hydrates a preserved legacy session only once without rewriting legacy JSONB", async () => {
    const user = await makeUser();
    const created = await service.createUploadSession(
      user.id,
      "legacy.txt",
      3,
      2,
    );
    fs.writeFileSync(path.join(created.tempPath, "0"), "ab");
    await dataSource
      .getRepository(UploadSessionEntity)
      .update(created.id, {
        accountingInitialized: false,
        uploadedSize: 2,
        uploadedChunks: [0],
      });
    await service.uploadChunk(user.id, created.uploadId, 1, Buffer.from("c"));
    await service.uploadChunk(user.id, created.uploadId, 1, Buffer.from("c"));
    const loaded = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({ id: created.id });
    expect(loaded.uploadedSize).toBe(3);
    expect(loaded.uploadedCount).toBe(2);
    expect(loaded.accountingInitialized).toBe(true);
    const [raw] = await dataSource.query(
      'SELECT "uploadedChunks" FROM upload_sessions WHERE id = $1',
      [created.id],
    );
    expect(raw.uploadedChunks).toEqual([0]);
    expect(
      await dataSource
        .getRepository(UploadChunkEntity)
        .countBy({ sessionId: created.id }),
    ).toBe(2);
    const row = await dataSource
      .getRepository(UploadChunkEntity)
      .findOneByOrFail({ sessionId: created.id, chunkIndex: 0 });
    await expect(
      dataSource.getRepository(UploadChunkEntity).insert(row),
    ).rejects.toThrow();
    expect(
      fs
        .readFileSync(
          (await service.completeUpload(user.id, created.uploadId)).storagePath,
        )
        .toString(),
    ).toBe("abc");
  });

  it("представляет ровно 50 ГиБ и 5120 chunks без bigint/string потери и без giant файла", async () => {
    const size = 53687091200;
    const user = await makeUser(size);
    const large = configured({
      MAX_FILE_SIZE: 1099511627776,
      MAX_TOTAL_SIZE: 2199023255552,
    });
    const created = await large.createUploadSession(
      user.id,
      "50gib.bin",
      size,
      10485760,
    );
    const loaded = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({ id: created.id });
    expect(loaded.totalSize).toBe(size);
    expect(loaded.totalChunks).toBe(5120);
    expect(loaded.uploadedSize).toBe(0);
    expect(loaded.uploadedChunks).toBeUndefined();
    expect(loaded.accountingInitialized).toBe(true);
    await expect(
      large.createUploadSession(user.id, "over-quota", 1, 1),
    ).rejects.toThrow("quota");
    await large.abortUpload(user.id, created.uploadId);
  });

  it.each([1023, 1024])(
    "accepts inclusive configured per-file boundary %i",
    async (size) => {
      const user = await makeUser(2048);
      const limited = configured({ MAX_FILE_SIZE: 1024, MAX_TOTAL_SIZE: 2048 });
      const session = await limited.createUploadSession(
        user.id,
        "limit.bin",
        size,
        1024,
      );
      expect(session.totalSize).toBe(size);
      await limited.abortUpload(user.id, session.uploadId);
    },
  );
  it("rejects limit+1 and quota0 before creating disk state", async () => {
    const limited = configured({ MAX_FILE_SIZE: 1024, MAX_TOTAL_SIZE: 2048 });
    const user = await makeUser(2048);
    await expect(
      limited.createUploadSession(user.id, "limit.bin", 1025, 1024),
    ).rejects.toThrow("File size");
    const zero = await makeUser(0);
    await expect(
      limited.createUploadSession(zero.id, "zero.bin", 1, 1),
    ).rejects.toThrow("quota");
  });

  it("enforces aggregate active reservations independently from stored usage and file cap", async () => {
    const user = await makeUser(4096);
    const limited = configured({ MAX_FILE_SIZE: 2048, MAX_TOTAL_SIZE: 1024 });
    const first = await limited.createUploadSession(
      user.id,
      "first.bin",
      600,
      600,
    );
    await expect(
      limited.createUploadSession(user.id, "second.bin", 425, 425),
    ).rejects.toThrow("Total upload size");
    const exact = await limited.createUploadSession(
      user.id,
      "exact.bin",
      424,
      424,
    );
    await limited.abortUpload(user.id, first.uploadId);
    await limited.abortUpload(user.id, exact.uploadId);
  });

  it("serializes concurrent exact retries and out-of-order chunks without double accounting", async () => {
    const user = await makeUser();
    const session = await service.createUploadSession(
      user.id,
      "order.txt",
      5,
      2,
    );
    await service.uploadChunk(user.id, session.uploadId, 2, Buffer.from("e"));
    await Promise.all([
      service.uploadChunk(user.id, session.uploadId, 0, Buffer.from("ab")),
      service.uploadChunk(user.id, session.uploadId, 0, Buffer.from("ab")),
    ]);
    await expect(
      service.uploadChunk(user.id, session.uploadId, 0, Buffer.from("xx")),
    ).rejects.toThrow("different content");
    await service.uploadChunk(user.id, session.uploadId, 1, Buffer.from("cd"));
    const loaded = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({ id: session.id });
    expect(loaded.uploadedCount).toBe(3);
    expect(loaded.uploadedSize).toBe(5);
    expect(
      await dataSource
        .getRepository(UploadChunkEntity)
        .countBy({ sessionId: session.id }),
    ).toBe(3);
    const file = await service.completeUpload(user.id, session.uploadId);
    expect(fs.readFileSync(file.storagePath).toString()).toBe("abcde");
    expect(
      await dataSource
        .getRepository(UploadChunkEntity)
        .countBy({ sessionId: session.id }),
    ).toBe(0);
    expect(fs.existsSync(session.tempPath)).toBe(false);
    expect(
      Number(
        (
          await dataSource
            .getRepository(UserEntity)
            .findOneByOrFail({ id: user.id })
        ).storageUsed,
      ),
    ).toBe(5);
  });

  it("recovers an atomic file orphan and repairs a missing published file without counter inflation", async () => {
    const user = await makeUser();
    const session = await service.createUploadSession(
      user.id,
      "crash.txt",
      4,
      4,
    );
    const chunkPath = path.join(session.tempPath, "0");
    fs.writeFileSync(chunkPath, "data");
    await service.uploadChunk(
      user.id,
      session.uploadId,
      0,
      Buffer.from("data"),
    );
    fs.unlinkSync(chunkPath);
    await expect(
      service.uploadChunk(user.id, session.uploadId, 0, Buffer.from("xxxx")),
    ).rejects.toThrow("different content");
    await service.uploadChunk(
      user.id,
      session.uploadId,
      0,
      Buffer.from("data"),
    );
    const loaded = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({ id: session.id });
    expect(loaded.uploadedCount).toBe(1);
    expect(loaded.uploadedSize).toBe(4);
    const file = await service.completeUpload(user.id, session.uploadId);
    expect(fs.readFileSync(file.storagePath).toString()).toBe("data");
  });

  it("detects durable chunk corruption at finalization while preserving retryable chunks and quota", async () => {
    const user = await makeUser();
    const session = await service.createUploadSession(
      user.id,
      "tamper.txt",
      4,
      4,
    );
    await service.uploadChunk(
      user.id,
      session.uploadId,
      0,
      Buffer.from("data"),
    );
    fs.writeFileSync(path.join(session.tempPath, "0"), "xxxx");
    await expect(
      service.completeUpload(user.id, session.uploadId),
    ).rejects.toThrow("integrity mismatch");
    expect(fs.existsSync(session.tempPath)).toBe(true);
    expect(
      await dataSource
        .getRepository(FileEntity)
        .countBy({ uploadId: session.uploadId }),
    ).toBe(0);
    expect(
      Number(
        (
          await dataSource
            .getRepository(UserEntity)
            .findOneByOrFail({ id: user.id })
        ).storageUsed,
      ),
    ).toBe(0);
    fs.writeFileSync(path.join(session.tempPath, "0"), "data");
    await service.completeUpload(user.id, session.uploadId);
  });

  it("cancel and stale cleanup remove durable rows and recheck sessions under lock", async () => {
    const user = await makeUser();
    const cancelled = await service.createUploadSession(
      user.id,
      "cancel.txt",
      4,
      4,
    );
    await service.uploadChunk(
      user.id,
      cancelled.uploadId,
      0,
      Buffer.from("data"),
    );
    await service.abortUpload(user.id, cancelled.uploadId);
    expect(fs.existsSync(cancelled.tempPath)).toBe(false);
    expect(
      await dataSource
        .getRepository(UploadChunkEntity)
        .countBy({ sessionId: cancelled.id }),
    ).toBe(0);
    const expired = await service.createUploadSession(
      user.id,
      "stale.txt",
      4,
      4,
    );
    await service.uploadChunk(
      user.id,
      expired.uploadId,
      0,
      Buffer.from("data"),
    );
    await dataSource
      .getRepository(UploadSessionEntity)
      .update(expired.id, { expiresAt: new Date(Date.now() - 1000) });
    expect(await service.cleanupExpiredSessions()).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(expired.tempPath)).toBe(false);
    expect(
      await dataSource
        .getRepository(UploadSessionEntity)
        .findOneBy({ id: expired.id }),
    ).toBeNull();
    expect(
      await dataSource
        .getRepository(UploadChunkEntity)
        .countBy({ sessionId: expired.id }),
    ).toBe(0);
  });

  async function workspaceIntegritySnapshot() {
    return Promise.all(["users", "files", "upload_sessions", "upload_chunks"].map(
      (table) => dataSource.query(`SELECT * FROM "${table}" ORDER BY ${table === "upload_chunks" ? '"sessionId", "chunkIndex"' : "id"}`),
    ));
  }

  async function expectWorkspaceUnavailable(target: UploadsService, userId: number,
    session: UploadSessionEntity, ingressPath: string) {
    const operations = [
      () => target.getUploadSession(userId, session.uploadId),
      () => target.listUploadSessions(userId),
      () => target.reconcileUploadSession(userId, session.uploadId),
      () => target.uploadChunk(userId, session.uploadId, 1, { path: ingressPath, size: 2 }),
      () => target.completeUpload(userId, session.uploadId),
      () => target.abortUpload(userId, session.uploadId),
      () => target.cleanupExpiredSessions(),
      () => target.cleanupOrphanedTempDirs(),
      () => target.createUploadSession(userId, "blocked.bin", 2, 2),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ status: 503 });
    }
  }

  it("fails closed across the lifecycle after workspace DB identity substitution without changing reservations or bytes", async () => {
    const user = await makeUser(32);
    const session = await service.createUploadSession(user.id, "workspace-bound.bin", 4, 2);
    await service.uploadChunk(user.id, session.uploadId, 0, Buffer.from("ok"));
    const ingressRoot = path.join(storageRoot, ".tmp", "multipart-ingress");
    fs.mkdirSync(ingressRoot, { recursive: true });
    const ingressPath = path.join(ingressRoot, randomUUID());
    fs.writeFileSync(ingressPath, "go");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(ingressPath, stale, stale);
    const ingressMtimeBefore = fs.statSync(ingressPath).mtimeMs;
    const chunkPath = path.join(session.tempPath, "0");
    const before = await workspaceIntegritySnapshot();
    const inode = fs.statSync(chunkPath).ino;
    try {
      // synchronize fixtures have no production immutability trigger; the
      // exact-migration suite separately proves that operator writes are blocked.
      await dataSource.getRepository(UploadWorkspaceEntity).update(
        LEGACY_UPLOAD_WORKSPACE.id, { mountKey: "substituted-storage" },
      );
      await expectWorkspaceUnavailable(service, user.id, session, ingressPath);
      expect(await workspaceIntegritySnapshot()).toEqual(before);
      expect(fs.readFileSync(chunkPath, "utf8")).toBe("ok");
      expect(fs.statSync(chunkPath).ino).toBe(inode);
      expect(fs.readFileSync(ingressPath, "utf8")).toBe("go");
      expect(fs.statSync(ingressPath).mtimeMs).toBe(ingressMtimeBefore);
    } finally {
      await dataSource.getRepository(UploadWorkspaceEntity).update(
        LEGACY_UPLOAD_WORKSPACE.id, { mountKey: LEGACY_UPLOAD_WORKSPACE.mountKey },
      );
      fs.rmSync(ingressPath, { force: true });
      await service.abortUpload(user.id, session.uploadId);
    }
  });

  it("rejects ingress adoption EXDEV without copy, preserves confirmed binary chunks and accounting, and permits retry", async () => {
    const user = await makeUser(32);
    const session = await service.createUploadSession(user.id, "exdev.bin", 4, 2);
    const bytes = Buffer.from([0, 255, 128, 0]);
    const ingressRoot = path.join(storageRoot, ".tmp", "multipart-ingress");
    fs.mkdirSync(ingressRoot, { recursive: true });
    const ingress = path.join(ingressRoot, randomUUID());
    await service.uploadChunk(user.id, session.uploadId, 0, bytes.subarray(0, 2));
    const firstChunk = path.join(session.tempPath, "0");
    const inode = fs.statSync(firstChunk).ino;
    fs.writeFileSync(ingress, bytes.subarray(2));
    const before = await workspaceIntegritySnapshot();
    const copy = jest.spyOn(fs.promises, "copyFile");
    const syncCopy = jest.spyOn(jest.requireActual<typeof fs>("node:fs"), "copyFileSync");
    const rename = jest.spyOn(SecureFilesystem.prototype, "rename").mockImplementationOnce(() => { throw Object.assign(new Error("Cross-device link"), { code: "EXDEV" }); });
    try {
      await expect(service.uploadChunk(user.id, session.uploadId, 1, { path: ingress, size: 2 }))
        .rejects.toMatchObject({ code: "EXDEV" });
      expect(rename).toHaveBeenCalledWith(ingress, expect.stringMatching(/1\..*\.tmp$/));
      expect(copy).not.toHaveBeenCalled();
      expect(syncCopy).not.toHaveBeenCalled();
      expect(await workspaceIntegritySnapshot()).toEqual(before);
      expect(fs.statSync(firstChunk).ino).toBe(inode);
      expect(fs.readFileSync(firstChunk)).toEqual(bytes.subarray(0, 2));
      expect(fs.readdirSync(session.tempPath)).toEqual(["0"]);
      expect(fs.existsSync(ingress)).toBe(false); // Unconfirmed request ingress is normally cleaned.
      rename.mockRestore();
      fs.writeFileSync(ingress, bytes.subarray(2));
      await service.uploadChunk(user.id, session.uploadId, 1, { path: ingress, size: 2 });
      const file = await service.completeUpload(user.id, session.uploadId);
      expect(fs.readFileSync(file.storagePath)).toEqual(bytes);
      expect(Number((await dataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id })).storageUsed)).toBe(4);
    } finally {
      rename.mockRestore(); copy.mockRestore(); syncCopy.mockRestore();
      fs.rmSync(ingress, { force: true });
      await dataSource.getRepository(FileEntity).delete({ uploadId: session.uploadId, userId: user.id });
      await dataSource.getRepository(UploadSessionEntity).delete(session.id);
      await dataSource.getRepository(UserEntity).delete(user.id);
      fs.rmSync(session.tempPath, { recursive: true, force: true });
    }
  });

  it("resumes binary chunks after the same workspace returns and explicit service restart without fallback or accounting loss", async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-workspace-return-"));
    const tempRoot = path.join(isolatedRoot, ".tmp");
    const savedRoot = path.join(isolatedRoot, "preserved-workspace");
    fs.mkdirSync(tempRoot);
    const config = new ConfigService({ STORAGE_PATH: isolatedRoot,
      MAX_FILE_SIZE: 1024, MAX_TOTAL_SIZE: 1024, MAX_CHUNK_SIZE: 2 });
    const instances: { uploads: UploadsService; storage: StorageService }[] = [];
    const start = () => {
      const storage = new StorageService(config);
      const uploads = new UploadsService(
        dataSource.getRepository(UploadSessionEntity), dataSource.getRepository(FileEntity),
        dataSource.getRepository(FolderEntity), storage,
        new UsersService(dataSource.getRepository(UserEntity)), config);
      instances.push({ uploads, storage });
      return uploads;
    };
    const user = await makeUser(32);
    let session: UploadSessionEntity | undefined;
    try {
      const original = start();
      session = await original.createUploadSession(user.id, "returned.bin", 4, 2);
      const bytes = Buffer.from([0, 255, 128, 0]);
      await original.uploadChunk(user.id, session.uploadId, 0, bytes.subarray(0, 2));
      const firstChunk = path.join(session.tempPath, "0");
      const inode = fs.statSync(firstChunk).ino;
      const before = await workspaceIntegritySnapshot();
      fs.renameSync(tempRoot, savedRoot);
      fs.mkdirSync(tempRoot); // Empty underlying directory must never become a fallback.
      await expect(original.getUploadSession(user.id, session.uploadId)).rejects.toMatchObject({ status: 503 });
      await expect(original.uploadChunk(user.id, session.uploadId, 1, bytes.subarray(2))).rejects.toMatchObject({ status: 503 });
      expect(await workspaceIntegritySnapshot()).toEqual(before);
      expect(fs.readdirSync(tempRoot)).toEqual([]);
      fs.rmdirSync(tempRoot);
      fs.renameSync(savedRoot, tempRoot);
      await expect(original.getUploadSession(user.id, session.uploadId)).rejects.toMatchObject({ status: 503 });
      original.onModuleDestroy();
      const resumed = start(); // Explicit restart releases the sticky workspace refusal.
      const reloaded = await resumed.getUploadSession(user.id, session.uploadId);
      expect(reloaded.workspaceId).toBe(LEGACY_UPLOAD_WORKSPACE.id);
      expect(reloaded.uploadedSize).toBe(2);
      expect(reloaded.uploadedCount).toBe(1);
      expect(fs.statSync(firstChunk).ino).toBe(inode);
      expect(fs.readFileSync(firstChunk)).toEqual(bytes.subarray(0, 2));
      expect(await workspaceIntegritySnapshot()).toEqual(before);
      await resumed.uploadChunk(user.id, session.uploadId, 1, bytes.subarray(2));
      const file = await resumed.completeUpload(user.id, session.uploadId);
      expect(fs.readFileSync(file.storagePath)).toEqual(bytes);
      expect(Number((await dataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id })).storageUsed)).toBe(4);
      expect((await dataSource.getRepository(UploadSessionEntity).findOneByOrFail({ id: session.id })).workspaceId)
        .toBe(LEGACY_UPLOAD_WORKSPACE.id);
    } finally {
      for (const instance of instances) {
        instance.uploads.onModuleDestroy();
        instance.storage.onModuleDestroy();
      }
      if (session) {
        await dataSource.getRepository(FileEntity).delete({ uploadId: session.uploadId, userId: user.id });
        await dataSource.getRepository(UploadSessionEntity).delete(session.id);
      }
      await dataSource.getRepository(UserEntity).delete(user.id);
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it.each(["missing", "replacement"])(
    "fails closed after initialized legacy workspace root %s without mutating either filesystem or DB", async (kind) => {
      const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-workspace-service-"));
      const tempRoot = path.join(isolatedRoot, ".tmp");
      const preservedRoot = path.join(isolatedRoot, ".tmp-preserved");
      fs.mkdirSync(tempRoot);
      const config = new ConfigService({ STORAGE_PATH: isolatedRoot,
        MAX_FILE_SIZE: 1024, MAX_TOTAL_SIZE: 1024, MAX_CHUNK_SIZE: 2 });
      const isolatedService = new UploadsService(
        dataSource.getRepository(UploadSessionEntity),
        dataSource.getRepository(FileEntity),
        dataSource.getRepository(FolderEntity),
        new StorageService(config),
        new UsersService(dataSource.getRepository(UserEntity)), config,
      );
      const user = await makeUser(32);
      let session: UploadSessionEntity | undefined;
      try {
        session = await isolatedService.createUploadSession(user.id, "root-bound.bin", 4, 2);
        await isolatedService.uploadChunk(user.id, session.uploadId, 0, Buffer.from("ok"));
        const ingressRoot = path.join(tempRoot, "multipart-ingress");
        fs.mkdirSync(ingressRoot);
        const ingressPath = path.join(ingressRoot, randomUUID());
        fs.writeFileSync(ingressPath, "go");
        const before = await workspaceIntegritySnapshot();
        const inode = fs.statSync(path.join(session.tempPath, "0")).ino;
        fs.renameSync(tempRoot, preservedRoot);
        if (kind === "replacement") {
          fs.mkdirSync(tempRoot);
          fs.mkdirSync(path.join(tempRoot, "multipart-ingress"));
          fs.writeFileSync(path.join(tempRoot, "replacement-marker"), "keep");
          fs.writeFileSync(ingressPath, "replacement-ingress");
        }
        await expectWorkspaceUnavailable(isolatedService, user.id, session, ingressPath);
        expect(await workspaceIntegritySnapshot()).toEqual(before);
        const preservedChunk = path.join(preservedRoot, session.uploadId, "0");
        expect(fs.readFileSync(preservedChunk, "utf8")).toBe("ok");
        expect(fs.statSync(preservedChunk).ino).toBe(inode);
        expect(fs.readFileSync(path.join(preservedRoot, "multipart-ingress", path.basename(ingressPath)), "utf8")).toBe("go");
        const replacement = kind === "replacement";
        expect(fs.existsSync(tempRoot)).toBe(replacement);
        const replacementBytes = replacement ? [
          fs.readFileSync(path.join(tempRoot, "replacement-marker"), "utf8"),
          fs.readFileSync(ingressPath, "utf8"),
        ] : [];
        expect(replacementBytes).toEqual(replacement ? ["keep", "replacement-ingress"] : []);
      } finally {
        isolatedService.onModuleDestroy();
        if (session) await dataSource.getRepository(UploadSessionEntity).delete(session.id);
        await dataSource.getRepository(UserEntity).delete(user.id);
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
      }
    },
  );

});
