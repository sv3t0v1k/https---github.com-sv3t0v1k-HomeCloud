import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { FilesService } from "./files.service";
import { SharingService } from "../sharing/sharing.service";
import { PreviewsService } from "../previews/previews.service";
import { UsersService } from "../users/users.service";
import { StorageService } from "../storage/storage.service";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase(
  "Failure/security: two-user ownership with real PostgreSQL",
  () => {
    const schema = `security_${randomUUID().replace(/-/g, "")}`;
    let admin: DataSource;
    let database: DataSource;
    let files: FilesService;
    let shares: SharingService;
    let previews: PreviewsService;
    let attacker: UserEntity;
    let owner: UserEntity;
    let folder: FolderEntity;
    let file: FileEntity;
    let share: ShareLinkEntity;
    const storage = {
      deleteFile: jest.fn(),
      copyFile: jest.fn(),
      fileExists: jest.fn(),
    };

    beforeAll(async () => {
      admin = new DataSource({ type: "postgres", url: databaseUrl });
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      database = new DataSource({
        type: "postgres",
        url: databaseUrl,
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
      await database.initialize();
      const users = new UsersService(database.getRepository(UserEntity));
      files = new FilesService(
        database.getRepository(FileEntity),
        database.getRepository(FolderEntity),
        storage as unknown as StorageService,
        users,
      );
      shares = new SharingService(
        database.getRepository(ShareLinkEntity),
        database.getRepository(FileEntity),
        database.getRepository(UserEntity),
        new ConfigService({}),
        storage as unknown as StorageService,
      );
      previews = new PreviewsService(
        database.getRepository(FileEntity),
        storage as unknown as StorageService,
      );
    }, 30000);

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
    });

    beforeEach(async () => {
      await database.query(
        "TRUNCATE share_links, files, folders, users CASCADE",
      );
      const users = database.getRepository(UserEntity);
      owner = await users.save({
        email: `${randomUUID()}@example.test`,
        password: "hash",
        name: "Owner",
        storageQuota: 1000,
        storageUsed: 7,
      });
      attacker = await users.save({
        email: `${randomUUID()}@example.test`,
        password: "hash",
        name: "Attacker",
        storageQuota: 1000,
        storageUsed: 0,
      });
      folder = await database
        .getRepository(FolderEntity)
        .save({ name: "private-folder", userId: owner.id });
      const repository = database.getRepository(FileEntity);
      await repository.save({
        name: folder.name,
        userId: owner.id,
        folderId: folder.id,
        isFolder: true,
        size: 0,
      });
      file = await repository.save({
        name: "private.txt",
        userId: owner.id,
        parentId: folder.id,
        storagePath: "/disposable/private.txt",
        mimeType: "text/plain",
        size: 7,
      });
      share = await shares.createShareLink(owner.id, file.id, {});
      jest.clearAllMocks();
    });

    async function assertOwnerUnchanged() {
      expect(
        await database
          .getRepository(FileEntity)
          .findOneByOrFail({ id: file.id }),
      ).toMatchObject({
        name: "private.txt",
        userId: owner.id,
        isDeleted: false,
        parentId: folder.id,
        size: "7",
      });
      expect(
        await database
          .getRepository(FolderEntity)
          .findOneByOrFail({ id: folder.id }),
      ).toMatchObject({
        name: "private-folder",
        userId: owner.id,
        isDeleted: false,
      });
      expect(
        await database
          .getRepository(UserEntity)
          .findOneByOrFail({ id: owner.id }),
      ).toMatchObject({ storageUsed: "7" });
      expect(
        await database
          .getRepository(ShareLinkEntity)
          .findOneByOrFail({ id: share.id }),
      ).toMatchObject({ isActive: true, downloadCount: "0" });
      expect(storage.deleteFile).not.toHaveBeenCalled();
      expect(storage.copyFile).not.toHaveBeenCalled();
      expect(storage.fileExists).not.toHaveBeenCalled();
    }

    it.each([
      "detail",
      "rename",
      "move",
      "copy",
      "delete",
      "restore",
      "permanent-delete",
      "preview",
      "thumbnail",
      "create-share",
    ])("denies foreign file %s before side effects", async (operation) => {
      const calls: Record<string, () => Promise<unknown>> = {
        detail: () => files.findOne(attacker.id, file.id),
        rename: () =>
          files.updateFile(attacker.id, file.id, { name: "stolen.txt" }),
        move: () => files.updateFile(attacker.id, file.id, { parentId: null }),
        copy: () => files.copyFile(attacker.id, file.id),
        delete: () => files.removeFile(attacker.id, file.id),
        restore: () => files.restoreFile(attacker.id, file.id),
        "permanent-delete": () =>
          files.deleteFilePermanently(attacker.id, file.id),
        preview: () => previews.getPreview(attacker.id, file.id),
        thumbnail: () => previews.getThumbnail(attacker.id, file.id),
        "create-share": () => shares.createShareLink(attacker.id, file.id, {}),
      };
      await expect(calls[operation]()).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await assertOwnerUnchanged();
    });

    it.each(["detail", "rename", "delete", "restore", "permanent-delete"])(
      "denies foreign folder %s",
      async (operation) => {
        const calls: Record<string, () => Promise<unknown>> = {
          detail: () => files.findFolder(attacker.id, folder.id),
          rename: () =>
            files.updateFolder(attacker.id, folder.id, { name: "stolen" }),
          delete: () => files.removeFolder(attacker.id, folder.id),
          restore: () => files.restoreFolder(attacker.id, folder.id),
          "permanent-delete": () =>
            files.deleteFolderPermanently(attacker.id, folder.id),
        };
        await expect(calls[operation]()).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await assertOwnerUnchanged();
      },
    );

    it("denies foreign parent context before upload/folder metadata creation", async () => {
      await expect(
        files.assertFolderOwnership(attacker.id, folder.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        files.createFolder(attacker.id, "injected", folder.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await database.getRepository(FolderEntity).count()).toBe(1);
      await assertOwnerUnchanged();
    });

    it("keeps listing, trash and owner share listing isolated and denies revoke", async () => {
      expect(await files.findAll(attacker.id)).toEqual([]);
      expect(await files.findFolders(attacker.id)).toEqual([]);
      expect(await files.getTrash(attacker.id)).toEqual({
        files: [],
        folders: [],
      });
      expect(await shares.listUserShares(attacker.id)).toEqual([]);
      await expect(
        shares.revokeShare(attacker.id, share.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      await assertOwnerUnchanged();
    });
  },
);
