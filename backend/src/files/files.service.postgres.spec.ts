import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UserEntity } from "../entities/user.entity";
import { FilesService } from "./files.service";

const testDatabaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres("FilesService Stage B2 — реальный PostgreSQL", () => {
  const schema = `files_b2_${randomUUID().replace(/-/g, "")}`;
  let admin: DataSource;
  let dataSource: DataSource;
  let service: FilesService;
  const storage = {
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
        UserEntity,
        FileEntity,
        FolderEntity,
        ShareLinkEntity,
        UploadSessionEntity,
        RefreshTokenEntity,
      ],
    });
    await dataSource.initialize();
    service = new FilesService(
      dataSource.getRepository(FileEntity),
      dataSource.getRepository(FolderEntity),
      storage as any,
      users as any,
    );
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
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

  it("удаляет дерево и зеркала с отличающимися id", async () => {
    const user = await createUser();
    const folders = dataSource.getRepository(FolderEntity);
    const files = dataSource.getRepository(FileEntity);
    const root = await folders.save({ name: "root", userId: user.id });
    const child = await folders.save({ name: "child", userId: user.id, parentId: root.id });
    await files.save(files.create({
      name: "offset", storagePath: "/storage/offset", size: 1,
      mimeType: "text/plain", isFolder: false, userId: user.id,
    }));
    const rootMirror = await createMirror(user.id, root.id, "root");
    const childMirror = await createMirror(user.id, child.id, "child");
    const content = await files.save(files.create({
      name: "content", storagePath: "/storage/content", size: 23,
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
      name: "content", storagePath: "/storage/content", size: 42,
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
});
