import { UploadWorkspaceEntity, LEGACY_UPLOAD_WORKSPACE } from "../entities/upload-workspace.entity";
import { StorageLocationEntity, LEGACY_STORAGE_LOCATION } from "../entities/storage-location.entity";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigService } from "@nestjs/config";
import { DataSource, EntityManager } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { FilesService } from "./files.service";
import { FileCopyAdmissionService } from "./file-copy-admission.service";
import { FileCopyAdmission1792831300000 } from "../migrations/1792831300000-FileCopyAdmission";

const testDatabaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("FilesService Stage B2 — реальный PostgreSQL", () => {
  const schema = `files_b2_${randomUUID().replace(/-/g, "")}`;
  let admin: DataSource;
  let dataSource: DataSource;
  let service: FilesService;
  let copyService: FilesService;
  let copyStorage: StorageService;
  let copyRoot: string;
  const storage = {
    resolveFilePath: (file: { storagePath: string }) => file.storagePath,
    deleteFile: jest.fn(),
  };
  const users = {
    decrementStorageUsed: jest.fn(),
  };

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
    const migrationRunner = dataSource.createQueryRunner();
    try {
      await migrationRunner.connect();
      await migrationRunner.startTransaction();
      await new FileCopyAdmission1792831300000().up(migrationRunner);
      await migrationRunner.commitTransaction();
    } catch (error) {
      if (migrationRunner.isTransactionActive) {
        await migrationRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await migrationRunner.release();
    }
    service = new FilesService(
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storage as any,
      users as any,
      new FileCopyAdmissionService(dataSource),
    );
    copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "homecloud-copy-pg-"));
    copyStorage = new StorageService(
      new ConfigService({ STORAGE_PATH: copyRoot }),
    );
    copyService = new FilesService(
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      copyStorage,
      new UsersService(dataSource.getRepository(UserEntity)),
      new FileCopyAdmissionService(dataSource),
    );
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
    if (copyRoot) fs.rmSync(copyRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await dataSource.query("DELETE FROM file_copy_operations");
    await dataSource.getRepository(FileEntity).createQueryBuilder().delete().execute();
    await dataSource.getRepository(FolderEntity).createQueryBuilder().delete().execute();
    await dataSource.getRepository(UserEntity).createQueryBuilder().delete().execute();
    jest.clearAllMocks();
  });

  async function createUser() {
    return dataSource.getRepository(UserEntity).save({
      email: `${randomUUID()}@example.test`,
      password: "hash",
      name: "Test",
      storageQuota: 10_000,
      storageUsed: 0,
    });
  }

  async function createMirror(
    userId: number,
    folderId: number,
    name: string,
  ): Promise<FileEntity> {
    const repository = dataSource.getRepository(FileEntity);
    return repository.save(repository.create({
      name,
      size: 0,
      mimeType: "application/zip",
      isFolder: true,
      isDeleted: false,
      parentId: null,
      folderId,
      userId,
    }));
  }

  describe("GS-1A: реальный PostgreSQL", () => {
    it("ищет LIKE-символы буквально, без чужих и удалённых записей", async () => {
      const owner = await createUser();
      const other = await createUser();
      const files = dataSource.getRepository(FileEntity);
      const folders = dataSource.getRepository(FolderEntity);

      async function addFile(userId: number, name: string, isDeleted = false) {
        const key = randomUUID();
        return files.save(files.create({
          name,
          storagePath: `/storage/${key}`,
          storageLocationId: LEGACY_STORAGE_LOCATION.id,
          relativeObjectKey: key,
          size: 1,
          mimeType: "text/plain",
          isFolder: false,
          isDeleted,
          userId,
        }));
      }

      await addFile(owner.id, "100%_!.txt");
      await addFile(owner.id, "100ABC!.txt");
      await addFile(owner.id, "100%_!-deleted.txt", true);
      await addFile(other.id, "100%_!-other.txt");

      const matchingFolder = await folders.save({ name: "100%_!-folder", userId: owner.id });
      await createMirror(owner.id, matchingFolder.id, matchingFolder.name);
      await folders.save({ name: "100ABC!-folder", userId: owner.id });
      await folders.save({ name: "100%_!-other", userId: other.id });
      await folders.save({
        name: "100%_!-deleted",
        userId: owner.id,
        isDeleted: true,
      });

      const result = await service.search(owner.id, "100%_!", 20, 0);

      expect(result.files.map((item) => item.name)).toEqual(["100%_!.txt"]);
      expect(result.folders.map((item) => item.name)).toEqual([
        "100%_!-folder",
      ]);
    });

    it("сохраняет границы доступа для legacy-папки без зеркала", async () => {
      const owner = await createUser();
      const other = await createUser();
      const folders = dataSource.getRepository(FolderEntity);
      const files = dataSource.getRepository(FileEntity);

      const legacy = await folders.save({
        name: "match-legacy",
        userId: owner.id,
      });
      const normal = await folders.save({
        name: "match-normal",
        userId: owner.id,
      });
      await createMirror(owner.id, normal.id, normal.name);

      const nested = await folders.save({
        name: "match-nested",
        userId: owner.id,
        parentId: legacy.id,
      });
      await createMirror(owner.id, nested.id, nested.name);

      const broken = await folders.save({
        name: "match-broken",
        userId: owner.id,
      });
      const brokenMirror = await createMirror(owner.id, broken.id, broken.name);
      await files.update({ id: brokenMirror.id }, { isDeleted: true });

      const brokenChild = await folders.save({
        name: "match-broken-child",
        userId: owner.id,
        parentId: broken.id,
      });
      await createMirror(owner.id, brokenChild.id, brokenChild.name);


      const deleted = await folders.save({
        name: "match-deleted",
        userId: owner.id,
        parentId: legacy.id,
        isDeleted: true,
      });

      async function addFile(userId: number, parentId: number, name: string) {
        const key = randomUUID();
        return files.save(files.create({
          name, userId, parentId,
          storagePath: `/storage/${key}`,
          storageLocationId: LEGACY_STORAGE_LOCATION.id,
          relativeObjectKey: key,
          size: 1,
          mimeType: "text/plain",
          isFolder: false,
        }));
      }

      await addFile(owner.id, legacy.id, "match-owned.txt");
      await addFile(owner.id, nested.id, "match-nested.txt");
      await addFile(owner.id, brokenChild.id, "match-broken-child.txt");
      await addFile(other.id, legacy.id, "match-foreign.txt");
      await addFile(owner.id, deleted.id, "match-hidden.txt");
      await addFile(owner.id, normal.id, "match-normal.txt");

      const result = await service.search(owner.id, "match", 50, 0);

      expect(result.folders.map(item => item.name)).toEqual(["match-normal"]);
      expect(result.files.map(item => item.name)).toEqual([
        "match-normal.txt",
      ]);

      const foreign = await service.search(other.id, "match", 50, 0);
      expect(foreign.files).toEqual([]);
      expect(foreign.folders).toEqual([]);

      await expect(service.findFolder(owner.id, legacy.id))
        .rejects.toThrow("Folder mirror not found");
      await expect(service.findFolder(owner.id, broken.id))
        .rejects.toThrow("Folder mirror not found");
    });

    it("измеряет поиск по широкому и глубокому дереву", async () => {
      const owner = await createUser();
      const folders = dataSource.getRepository(FolderEntity);

      const root = await folders.save({
        name: "perf-root",
        userId: owner.id,
      });
      await createMirror(owner.id, root.id, root.name);

      await dataSource.query(
        `INSERT INTO folders ("name", "userId", "parentId")
         SELECT 'perf-item-' || n, $1, $2
         FROM generate_series(1, 3000) AS g(n)`,
        [owner.id, root.id],
      );

      await dataSource.query(
        `INSERT INTO files ("name", "userId", "isFolder",
                            "folderId", "size")
         SELECT name, $1, true, id, 0
         FROM folders
         WHERE "userId" = $1 AND "parentId" = $2`,
        [owner.id, root.id],
      );

      // Воспроизводим индекс из production-миграции.
      await dataSource.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "uq_files_folderId"
         ON "files"("folderId")
         WHERE "folderId" IS NOT NULL`,
      );

      // Отдельная цепочка глубиной 80 уровней.
      let deepParentId = root.id;
      for (let depth = 1; depth <= 80; depth++) {
        const nested = await folders.save({
          name: `perf-depth-${depth}`,
          userId: owner.id,
          parentId: deepParentId,
        });
        await createMirror(owner.id, nested.id, nested.name);
        deepParentId = nested.id;
      }

      await dataSource.query("ANALYZE folders");
      await dataSource.query("ANALYZE files");

      const spy = jest.spyOn(EntityManager.prototype, "query");
      let result: Awaited<ReturnType<FilesService["search"]>>;
      let captured: [string, unknown[]] | undefined;

      try {
        result = await service.search(owner.id, "perf-item", 50, 0);
        captured = spy.mock.calls.find(([sql]) =>
          sql.includes("WITH RECURSIVE visible_folders")
        ) as [string, unknown[]] | undefined;
      } finally {
        spy.mockRestore();
      }

      expect(result.folders).toHaveLength(50);
      expect(result.files).toHaveLength(0);
      expect(result.hasMore).toBe(true);

      if (!captured) throw new Error("Search SQL not captured");

      const plans = await dataSource.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured[0]}`,
        captured[1],
      );

      const plan = plans[0]["QUERY PLAN"][0];

      console.info("GS-1A PostgreSQL performance:", JSON.stringify({
        folders: 3081,
        depth: 80,
        pageSize: 50,
        planningMs: plan["Planning Time"],
        executionMs: plan["Execution Time"],
        sharedHitBlocks: plan.Plan["Shared Hit Blocks"],
      }));
    }, 30000);

    it("сбрасывает statement_timeout после отмены транзакции", async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();

      try {
        const before = await runner.query("SHOW statement_timeout");
        await runner.startTransaction();

        try {
          await runner.query("SET LOCAL statement_timeout = '25ms'");
          await expect(
            runner.query("SELECT pg_sleep(0.1)")
          ).rejects.toMatchObject({
            driverError: { code: "57014" },
          });
        } finally {
          await runner.rollbackTransaction();
        }

        expect(await runner.query("SHOW statement_timeout")).toEqual(before);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it.each(["global", "legacy"])("отменяет реальный %s поиск по SQL timeout и восстанавливает соединение", async (mode) => {
      const owner = await createUser();
      const lock = dataSource.createQueryRunner();
      await lock.connect();
      await lock.startTransaction();
      const before = await dataSource.query("SHOW statement_timeout");
      try {
        await lock.query("LOCK TABLE files IN ACCESS EXCLUSIVE MODE");
        const pending = mode === "global"
          ? service.search(owner.id, "match")
          : service.findAll(owner.id, undefined, "match");
        await expect(pending).rejects.toMatchObject({
          status: 503, message: "Search temporarily unavailable",
        });
      } finally {
        await lock.rollbackTransaction();
        await lock.release();
      }
      expect(await dataSource.query("SHOW statement_timeout")).toEqual(before);
      expect((await service.search(owner.id, "match")).files).toEqual([]);
    }, 10000);

    it("ограничивает старый поиск текущей папкой, буквальным ILIKE и безопасной страницей", async () => {
      const owner = await createUser();
      const other = await createUser();
      const folders = dataSource.getRepository(FolderEntity);
      const folder = await folders.save({ name: "visible", userId: owner.id });
      await createMirror(owner.id, folder.id, folder.name);
      const files = dataSource.getRepository(FileEntity);
      async function add(userId: number, name: string, parentId: number | null, isDeleted = false) {
        const key = randomUUID();
        return files.save(files.create({ name, userId, parentId, isDeleted,
          storagePath: `/private/${key}`, storageLocationId: LEGACY_STORAGE_LOCATION.id,
          relativeObjectKey: key, size: 1, mimeType: "text/plain", isFolder: false }));
      }
      await add(owner.id, "100%_!-root", null);
      await add(other.id, "100%_!-other", folder.id);
      await add(owner.id, "100%_!-deleted", folder.id, true);
      await add(owner.id, "100ABC!-wildcard", folder.id);
      for (let n = 0; n < 55; n++) await add(owner.id, `100%_!-${String(n).padStart(2, "0")}`, folder.id);
      const first = await service.findAll(owner.id, folder.id, "100%_!");
      expect(first).toHaveLength(20);
      expect(first[0]).toMatchObject({ name: "100%_!-00", isFolder: false, isDeleted: false, isStarred: false });
      const all = await service.findAll(owner.id, folder.id, "100%_!", false, 50);
      expect(all).toHaveLength(50);
      const tail = await service.findAll(owner.id, folder.id, "100%_!", false, 50, 50);
      expect(tail.map(file => file.name)).toEqual(Array.from({ length: 5 }, (_, n) => `100%_!-${50 + n}`));
      expect(JSON.stringify(all)).not.toMatch(/storagePath|relativeObjectKey|storageLocationId|userId/);
      expect((await service.findAll(owner.id, undefined, "100%_!")).map(file => file.name)).toEqual(["100%_!-root"]);
      await files.update({ folderId: folder.id, isFolder: true }, { isDeleted: true });
      expect(await service.findAll(owner.id, folder.id, "100%_!")).toEqual([]);
      await files.update({ folderId: folder.id, isFolder: true }, { isDeleted: false });
      await folders.update(folder.id, { isDeleted: true });
      expect(await service.findAll(owner.id, folder.id, "100%_!")).toEqual([]);
    });

    it("соблюдает limit, offset и стабильную сортировку", async () => {
      const owner = await createUser();
      const files = dataSource.getRepository(FileEntity);
      const folders = dataSource.getRepository(FolderEntity);

      for (let index = 3; index >= 0; index--) {
        const key = randomUUID();
        await files.save(files.create({
          name: `item-${index}`,
          storagePath: `/storage/${key}`,
          storageLocationId: LEGACY_STORAGE_LOCATION.id,
          relativeObjectKey: key,
          size: 1,
          mimeType: "text/plain",
          isFolder: false,
          userId: owner.id,
        }));
        const folder = await folders.save({
          name: `item-${index}`,
          userId: owner.id,
        });
        await createMirror(owner.id, folder.id, folder.name);
      }

      const result = await service.search(owner.id, "item", 2, 2);

      expect(result.files).toEqual([]);
      expect(result.folders.map((item) => item.name)).toEqual([
        "item-2", "item-3",
      ]);
      expect(result).toMatchObject({ limit: 2, offset: 2, hasMore: true });
      const next = await service.search(owner.id, "item", 2, 4);
      expect(next.folders).toEqual([]);
      expect(next.files.map((item) => item.name)).toEqual(["item-0", "item-1"]);
    });

    it("скрывает потомков удалённой папки и внутренние поля", async () => {
      const owner = await createUser();
      const folders = dataSource.getRepository(FolderEntity);
      const files = dataSource.getRepository(FileEntity);
      const deleted = await folders.save({ name: "hidden-root", userId: owner.id, isDeleted: true });
      const child = await folders.save({ name: "match-child", userId: owner.id, parentId: deleted.id });
      await createMirror(owner.id, child.id, child.name);
      const visible = await folders.save({ name: "match-visible", userId: owner.id });
      await createMirror(owner.id, visible.id, visible.name);
      const hiddenKey = randomUUID();
      await files.save(files.create({ name: "match-hidden.txt", userId: owner.id,
        parentId: child.id, storagePath: `/storage/${hiddenKey}`,
        storageLocationId: LEGACY_STORAGE_LOCATION.id, relativeObjectKey: hiddenKey,
        size: 1, mimeType: "text/plain", isFolder: false }));
      const visibleKey = randomUUID();
      await files.save(files.create({ name: "match-visible.txt", userId: owner.id,
        parentId: visible.id, storagePath: `/storage/${visibleKey}`,
        storageLocationId: LEGACY_STORAGE_LOCATION.id, relativeObjectKey: visibleKey,
        size: 1, mimeType: "text/plain", isFolder: false }));

      const result = await service.search(owner.id, "match", 20, 0);
      expect(result.folders.map((item) => item.name)).toEqual(["match-visible"]);
      expect(result.files.map((item) => item.name)).toEqual(["match-visible.txt"]);
      expect(result.hasMore).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/storagePath|relativeObjectKey|storageLocationId|userId/);
    });
  });

  it("удаляет дерево и зеркала с отличающимися id", async () => {
    const user = await createUser();
    const folders = dataSource.getRepository(FolderEntity);
    const files = dataSource.getRepository(FileEntity);
    const root = await folders.save({ name: "root", userId: user.id });
    const child = await folders.save({ name: "child", userId: user.id, parentId: root.id });
    await files.save(files.create({
      name: "offset", storagePath: "/storage/offset", storageLocationId: LEGACY_STORAGE_LOCATION.id, relativeObjectKey: "offset", size: 1,
      mimeType: "text/plain", isFolder: false, userId: user.id,
    }));
    const rootMirror = await createMirror(user.id, root.id, "root");
    const childMirror = await createMirror(user.id, child.id, "child");
    const content = await files.save(files.create({
      name: "content", storagePath: "/storage/content", storageLocationId: LEGACY_STORAGE_LOCATION.id, relativeObjectKey: "content", size: 23,
      mimeType: "text/plain", isFolder: false,
      parentId: child.id, userId: user.id,
    }));
    expect(rootMirror.id).not.toBe(root.id);
    expect(childMirror.id).not.toBe(child.id);

    await service.deleteFolderPermanently(user.id, root.id);

    expect(await folders.count()).toBe(0);
    expect(await files.findBy({ id: rootMirror.id })).toEqual([]);
    expect(await files.findBy({ id: childMirror.id })).toEqual([]);
    expect(await files.findBy({ id: content.id })).toEqual([]);
    expect(users.decrementStorageUsed).toHaveBeenCalledWith(
      user.id,
      23,
      expect.anything(),
    );
    expect(storage.deleteFile).toHaveBeenCalledWith("/storage/content");
  });

  it("откатывает удаление дерева при отсутствующем зеркале", async () => {
    const user = await createUser();
    const folders = dataSource.getRepository(FolderEntity);
    const root = await folders.save({ name: "root", userId: user.id });

    await expect(
      service.deleteFolderPermanently(user.id, root.id),
    ).rejects.toThrow("Folder mirror not found");

    expect(await folders.findOneBy({ id: root.id })).not.toBeNull();
    expect(users.decrementStorageUsed).not.toHaveBeenCalled();
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });

  it("emptyTrash удаляет всё дерево и считает файл только один раз", async () => {
    const user = await createUser();
    const folders = dataSource.getRepository(FolderEntity);
    const files = dataSource.getRepository(FileEntity);
    const root = await folders.save({
      name: "root", userId: user.id, isDeleted: true, deletedAt: new Date(),
    });
    const child = await folders.save({ name: "child", userId: user.id, parentId: root.id });
    const rootMirror = await createMirror(user.id, root.id, "root");
    rootMirror.isDeleted = true;
    rootMirror.deletedAt = new Date();
    await files.save(rootMirror);
    await createMirror(user.id, child.id, "child");
    await files.save(files.create({
      name: "content", storagePath: "/storage/content", storageLocationId: LEGACY_STORAGE_LOCATION.id, relativeObjectKey: "content", size: 42,
      mimeType: "text/plain", isFolder: false,
      isDeleted: true, deletedAt: new Date(), parentId: child.id, userId: user.id,
    }));

    await service.emptyTrash(user.id);

    expect(await folders.count()).toBe(0);
    expect(await files.count()).toBe(0);
    expect(users.decrementStorageUsed).toHaveBeenCalledWith(
      user.id,
      42,
      expect.anything(),
    );
    expect(storage.deleteFile).toHaveBeenCalledTimes(1);
  });

  // SECURE_COPY_PG_RACE_REGRESSION_V1
  async function createCopyRegressionSource() {
    const user = await createUser();
    const sourcePath = copyStorage.generatePath(
      user.id,
      `copy-regression-${randomUUID()}.bin`,
    );
    fs.writeFileSync(sourcePath, Buffer.alloc(100, 0x42));

    const files = dataSource.getRepository(FileEntity);
    const source = await files.save(files.create({
      name: "copy-regression.bin",
      ...copyStorage.placementForPath(sourcePath),
      size: 100,
      mimeType: "application/octet-stream",
      isFolder: false,
      userId: user.id,
    }));

    return { user, source, sourcePath, files };
  }



  it("B01: quota exhausted before physical copy", async () => {
    const { user, source, sourcePath, files } =
      await createCopyRegressionSource();

    await dataSource.getRepository(UserEntity).update(user.id, {
      storageQuota: 100,
      storageUsed: 100,
    });

    const physicalCopy = jest.spyOn(copyStorage, "copyOpenedFileSecure");

    try {
      await expect(copyService.copyFile(user.id, source.id)).rejects.toThrow(
        "Storage quota exceeded",
      );

      // The physical copy must never begin without quota.
      expect(physicalCopy).not.toHaveBeenCalled();

      expect(await files.countBy({ userId: user.id })).toBe(1);

      expect(fs.readdirSync(path.dirname(sourcePath))).toEqual([
        path.basename(sourcePath),
      ]);

      const owner = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: user.id });

      expect(Number(owner.storageUsed)).toBe(100);
    } finally {
      physicalCopy.mockRestore();
    }
  });

  // SECURE_COPY_CANCEL_POSTGRES_V1
  it("cancels after physical copying without changing PostgreSQL quota", async () => {
    const { user, source, sourcePath, files } =
      await createCopyRegressionSource();

    const cancellation = new AbortController();
    const actualCopy =
      copyStorage.copyOpenedFileSecure.bind(copyStorage);
    let physicalCopyFinished = false;

    const spy = jest.spyOn(
      copyStorage,
      "copyOpenedFileSecure",
    ).mockImplementation(async (...args) => {
      const lease = await actualCopy(...args);
      physicalCopyFinished = true;
      cancellation.abort();
      return lease;
    });

    try {
      await expect(
        copyService.copyFile(
          user.id, source.id, undefined, cancellation.signal,
        ),
      ).rejects.toThrow("File copy cancelled");
    } finally {
      spy.mockRestore();
    }

    expect(physicalCopyFinished).toBe(true);
    expect(await files.countBy({ userId: user.id })).toBe(1);

    const owner = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });

    expect(Number(owner.storageUsed)).toBe(0);
    expect(fs.readdirSync(path.dirname(sourcePath)))
      .toEqual([path.basename(sourcePath)]);
    expect(fs.readFileSync(sourcePath))
      .toEqual(Buffer.alloc(100, 0x42));
  });

  it("rolls back real PostgreSQL metadata on cancellation before COMMIT", async () => {
    const { user, source, sourcePath, files } =
      await createCopyRegressionSource();

    const cancellation = new AbortController();
    const actualCopy =
      copyStorage.copyOpenedFileSecure.bind(copyStorage);
    const actualFactory =
      dataSource.createQueryRunner.bind(dataSource);

    let physicalCopyFinished = false;
    let interceptedSave = false;
    let completedSave = false;

    const copySpy = jest.spyOn(
      copyStorage,
      "copyOpenedFileSecure",
    ).mockImplementation(async (...args) => {
      const lease = await actualCopy(...args);
      physicalCopyFinished = true;
      return lease;
    });

    const factorySpy = jest.spyOn(
      dataSource,
      "createQueryRunner",
    ).mockImplementation((...args) => {
      const runner = actualFactory(...args);

      if (physicalCopyFinished && !interceptedSave) {
        interceptedSave = true;

        const originalSave = runner.manager.save.bind(
          runner.manager,
        ) as (...values: unknown[]) => Promise<unknown>;

        runner.manager.save = (
          async (...values: unknown[]) => {
            const saved = await originalSave(...values);
            completedSave = true;
            cancellation.abort();
            return saved;
          }
        ) as typeof runner.manager.save;
      }

      return runner;
    });

    try {
      await expect(
        copyService.copyFile(
          user.id, source.id, undefined, cancellation.signal,
        ),
      ).rejects.toThrow("File copy cancelled");
    } finally {
      factorySpy.mockRestore();
      copySpy.mockRestore();
    }

    expect(physicalCopyFinished).toBe(true);
    expect(interceptedSave).toBe(true);
    expect(completedSave).toBe(true);

    expect(await files.countBy({ userId: user.id })).toBe(1);

    const owner = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });

    expect(Number(owner.storageUsed)).toBe(0);
    expect(fs.readdirSync(path.dirname(sourcePath)))
      .toEqual([path.basename(sourcePath)]);
    expect(fs.readFileSync(sourcePath))
      .toEqual(Buffer.alloc(100, 0x42));

    expect(await dataSource.query("SELECT 1 AS healthy"))
      .toEqual([{ healthy: 1 }]);
  });

  it("preserves a real committed copy when cancellation arrives after COMMIT", async () => {
    const { user, source, sourcePath, files } =
      await createCopyRegressionSource();

    const cancellation = new AbortController();
    const actualCopy =
      copyStorage.copyOpenedFileSecure.bind(copyStorage);
    const actualFactory =
      dataSource.createQueryRunner.bind(dataSource);

    let physicalCopyFinished = false;
    let committed = false;
    let interceptedCommit = false;

    const copySpy = jest.spyOn(
      copyStorage,
      "copyOpenedFileSecure",
    ).mockImplementation(async (...args) => {
      const lease = await actualCopy(...args);
      physicalCopyFinished = true;
      return lease;
    });

    const factorySpy = jest.spyOn(
      dataSource,
      "createQueryRunner",
    ).mockImplementation((...args) => {
      const runner = actualFactory(...args);

      if (physicalCopyFinished && !interceptedCommit) {
        interceptedCommit = true;
        const realCommit = runner.commitTransaction.bind(runner);

        runner.commitTransaction = async () => {
          await realCommit();
          committed = true;
          cancellation.abort();
        };
      }

      return runner;
    });

    let copied: FileEntity;

    try {
      copied = await copyService.copyFile(
        user.id, source.id, undefined, cancellation.signal,
      );
    } finally {
      factorySpy.mockRestore();
      copySpy.mockRestore();
    }

    expect(committed).toBe(true);
    expect(cancellation.signal.aborted).toBe(true);

    expect(await files.countBy({ userId: user.id })).toBe(2);

    const owner = await dataSource
      .getRepository(UserEntity)
      .findOneByOrFail({ id: user.id });

    expect(Number(owner.storageUsed)).toBe(100);

    expect(fs.readFileSync(copied.storagePath))
      .toEqual(Buffer.alloc(100, 0x42));
    expect(fs.readFileSync(sourcePath))
      .toEqual(Buffer.alloc(100, 0x42));
  });

  // SECURE_COPY_AMBIGUOUS_COMMIT_PG_V1
  it.each(["before", "after"] as const)(
    "secure-copy handles %s COMMIT acknowledgement failure",
    async (phase) => {
      const { user, source, sourcePath, files } =
        await createCopyRegressionSource();

      const realCopy = copyStorage.copyOpenedFileSecure.bind(copyStorage);
      const realFactory = dataSource.createQueryRunner.bind(dataSource);

      let physicalCopyCompleted = false;
      const targetedRunners: ReturnType<
        DataSource["createQueryRunner"]
      >[] = [];

      const copySpy = jest.spyOn(
        copyStorage,
        "copyOpenedFileSecure",
      ).mockImplementation(async (fd, size, destination) => {
        const lease = await realCopy(fd, size, destination);
        physicalCopyCompleted = true;
        return lease;
      });

      const factorySpy = jest.spyOn(
        dataSource,
        "createQueryRunner",
      ).mockImplementation((...args) => {
        const runner = realFactory(...args);

        if (physicalCopyCompleted && targetedRunners.length === 0) {
          targetedRunners.push(runner);
          const actualCommit = runner.commitTransaction.bind(runner);

          runner.commitTransaction = async () => {
            if (phase === "after") {
              await actualCommit();
            }
            throw new Error(`simulated-${phase}-commit-fault`);
          };
        }

        return runner;
      });

      try {
        await expect(
          copyService.copyFile(user.id, source.id),
        ).rejects.toThrow(`simulated-${phase}-commit-fault`);
      } finally {
        factorySpy.mockRestore();
        copySpy.mockRestore();
      }

      expect(physicalCopyCompleted).toBe(true);
      expect(targetedRunners).toHaveLength(1);
      expect(targetedRunners[0].isTransactionActive).toBe(false);

      const expectedCopies = phase === "after" ? 1 : 0;

      expect(await files.countBy({ userId: user.id }))
        .toBe(1 + expectedCopies);

      const actualOwner = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: user.id });

      expect(Number(actualOwner.storageUsed))
        .toBe(expectedCopies * 100);
      const operations = await dataSource.query(
        `SELECT state FROM file_copy_operations
         WHERE "userId" = $1`,
        [user.id],
      );

      expect(operations).toHaveLength(1);
      expect(operations[0].state).toBe(
        phase === "after" ? "committed" : "released",
      );


      expect(fs.readdirSync(path.dirname(sourcePath)))
        .toHaveLength(1 + expectedCopies);

      expect(fs.readFileSync(sourcePath))
        .toEqual(Buffer.alloc(100, 0x42));

      // Verify that the pool still works after an interrupted COMMIT.
      expect(await dataSource.query("SELECT 1 AS healthy"))
        .toEqual([{ healthy: 1 }]);
    },
    15000,
  );

  it("secure-copy rejects a source inside a deleted folder", async () => {
    const { user, source, sourcePath, files } =
      await createCopyRegressionSource();

    const folder = await copyService.createFolder(
      user.id,
      "hidden-copy-parent",
    );
    const folderId = folder.folderId!;
    await files.update(source.id, { parentId: folderId });
    await copyService.removeFolder(user.id, folderId);

    const originalCount = await files.countBy({ userId: user.id });

    await expect(
      copyService.copyFile(user.id, source.id),
    ).rejects.toThrow();

    expect(await files.countBy({ userId: user.id }))
      .toBe(originalCount);
    expect(fs.readFileSync(sourcePath))
      .toEqual(Buffer.alloc(100, 0x42));
    expect(fs.readdirSync(path.dirname(sourcePath)))
      .toEqual([path.basename(sourcePath)]);
  });

  it.each(["source", "destination"] as const)(
    "secure-copy refuses %s deletion during physical I/O",
    async (victim) => {
      const { user, source, sourcePath, files } =
        await createCopyRegressionSource();

      const destination = await copyService.createFolder(
        user.id,
        `copy-race-${victim}`,
      );
      const targetId = destination.folderId!;
      const initialCount = await files.countBy({ userId: user.id });

      let signalStarted!: () => void;
      let resumeCopy!: () => void;

      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const pause = new Promise<void>((resolve) => {
        resumeCopy = resolve;
      });

      const nativeCopy =
        copyStorage.copyOpenedFileSecure.bind(copyStorage);

      const spy = jest.spyOn(
        copyStorage,
        "copyOpenedFileSecure",
      ).mockImplementation(async (...args) => {
        signalStarted();
        await pause;
        return nativeCopy(...args);
      });

      // Attach rejection handling immediately to avoid an unhandled
      // promise rejection while PostgreSQL changes the source/destination.
      const outcome = copyService.copyFile(
        user.id,
        source.id,
        targetId,
      ).then(
        () => null,
        (error: unknown) => error,
      );

      try {
        await started;

        if (victim === "source") {
          await copyService.removeFile(user.id, source.id);
        } else {
          await copyService.removeFolder(user.id, targetId);
        }
      } finally {
        resumeCopy();
        spy.mockRestore();
      }

      const error = await outcome;
      expect(error).toBeInstanceOf(Error);

      // The partially written destination must not survive rollback.
      expect(await files.countBy({ userId: user.id }))
        .toBe(initialCount);
      expect(fs.readdirSync(path.dirname(sourcePath)))
        .toEqual([path.basename(sourcePath)]);
      expect(fs.readFileSync(sourcePath))
        .toEqual(Buffer.alloc(100, 0x42));

      const actual = await dataSource
        .getRepository(UserEntity)
        .findOneByOrFail({ id: user.id });

      expect(Number(actual.storageUsed)).toBe(0);
    },
    15000,
  );

  it("конкурирующие копии атомарно резервируют квоту", async () => {
    const user = await dataSource.getRepository(UserEntity).save({
      email: `${randomUUID()}@example.test`,
      password: "hash",
      name: "Copy race",
      storageQuota: 150,
      storageUsed: 0,
    });
    const sourcePath = copyStorage.generatePath(user.id, "source.bin");
    fs.writeFileSync(sourcePath, Buffer.alloc(100, 7));
    const files = dataSource.getRepository(FileEntity);
    const source = await files.save(
      files.create({
        name: "source.bin",
        ...copyStorage.placementForPath(sourcePath),
        size: 100,
        mimeType: "application/octet-stream",
        isFolder: false,
        userId: user.id,
      }),
    );

    const results = await Promise.allSettled([
      copyService.copyFile(user.id, source.id),
      copyService.copyFile(user.id, source.id),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      Number(
        (await dataSource.getRepository(UserEntity).findOneByOrFail({ id: user.id }))
          .storageUsed,
      ),
    ).toBe(100);
    expect(await files.countBy({ userId: user.id })).toBe(2);
    expect(fs.readdirSync(path.dirname(sourcePath))).toHaveLength(2);
    const placement = { storageLocationId: source.storageLocationId, relativeObjectKey: source.relativeObjectKey, storagePath: source.storagePath };
    const destination = await copyService.createFolder(user.id, "destination");
    await copyService.updateFile(user.id, source.id, { name: "renamed.BIN" });
    await copyService.moveFile(user.id, source.id, destination.folderId!);
    await copyService.removeFile(user.id, source.id);
    await copyService.restoreFile(user.id, source.id);
    expect(await files.findOneByOrFail({ id: source.id })).toMatchObject({ ...placement, name: "renamed.BIN", parentId: destination.folderId, isDeleted: false });
    const copy = (results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<FileEntity>).value;
    expect(copy.storageLocationId).toBe(LEGACY_STORAGE_LOCATION.id);
    expect(copy.relativeObjectKey).toBe(path.relative(copyRoot,copy.storagePath));
    await copyService.deleteFilePermanently(user.id,copy.id);
    expect(fs.existsSync(copy.storagePath)).toBe(false);
    expect(fs.readFileSync(sourcePath)).toEqual(Buffer.alloc(100,7));

  });
});
