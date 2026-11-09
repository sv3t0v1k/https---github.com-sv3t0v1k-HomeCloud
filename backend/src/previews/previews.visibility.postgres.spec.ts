import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { DataSource } from "typeorm";

import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { UserEntity } from "../entities/user.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UploadChunkEntity } from "../entities/upload-chunk.entity";
import {
  StorageLocationEntity,
  LEGACY_STORAGE_LOCATION,
} from "../entities/storage-location.entity";
import {
  UploadWorkspaceEntity,
  LEGACY_UPLOAD_WORKSPACE,
} from "../entities/upload-workspace.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { FilesService } from "../files/files.service";
import { PreviewsService } from "./previews.service";

const databaseUrl = process.env.HOMECLOUD_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Thumbnail visibility — PostgreSQL", () => {
  const schema = `thumbnail_${randomUUID().replace(/-/g, "")}`;
  let admin: DataSource;
  let db: DataSource;
  let files: FilesService;
  let previews: PreviewsService;
  let owner: UserEntity;
  let other: UserEntity;
  let imageRoot: string;
  let imagePath: string;
  let imageBytes: Buffer;

  const storage = {
    resolveFilePath: (file: FileEntity) => file.storagePath,
    openReadOnlyFileSecure: (absolute: string) =>
      fs.openSync(
        absolute,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      ),
  };

  beforeAll(async () => {
    admin = new DataSource({ type: "postgres", url: databaseUrl });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);

    db = new DataSource({
      type: "postgres",
      url: databaseUrl,
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
    await db.initialize();

    await db.getRepository(StorageLocationEntity)
      .save(LEGACY_STORAGE_LOCATION);
    await db.getRepository(UploadWorkspaceEntity)
      .save(LEGACY_UPLOAD_WORKSPACE);

    files = new FilesService(
      db.getRepository(FileEntity),
      db.getRepository(FolderEntity),
      storage as unknown as StorageService,
      new UsersService(db.getRepository(UserEntity)),
    );

    previews = new PreviewsService(
      db.getRepository(FileEntity),
      storage as unknown as StorageService,
    );

    imageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hc-visible-"));
    imagePath = path.join(imageRoot, "image.png");
    imageBytes = await sharp({
      create: {
        width: 20,
        height: 12,
        channels: 3,
        background: "#234567",
      },
    }).png().toBuffer();
    fs.writeFileSync(imagePath, imageBytes);
  }, 30_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
    if (imageRoot) {
      fs.rmSync(imageRoot, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE share_links, files, folders, users CASCADE");

    const users = db.getRepository(UserEntity);
    owner = await users.save({
      name: "Owner",
      email: `${randomUUID()}@example.test`,
      password: "hash",
      storageQuota: 100000,
      storageUsed: 0,
    });
    other = await users.save({
      name: "Other",
      email: `${randomUUID()}@example.test`,
      password: "hash",
      storageQuota: 100000,
      storageUsed: 0,
    });
  });

  async function createFolder(
    userId: number,
    parentId: number | null = null,
  ) {
    const folders = db.getRepository(FolderEntity);
    const entries = db.getRepository(FileEntity);

    const folder = await folders.save(folders.create({
      name: `folder-${randomUUID()}`,
      userId,
      parentId,
    }));
    await entries.save(entries.create({
      name: folder.name,
      userId,
      parentId,
      folderId: folder.id,
      isFolder: true,
      isDeleted: false,
      size: 0,
    }));
    return folder;
  }

  async function createImage(parentId: number | null) {
    const entries = db.getRepository(FileEntity);
    return entries.save(entries.create({
      name: "image.png",
      userId: owner.id,
      parentId,
      mimeType: "image/png",
      isFolder: false,
      isDeleted: false,
      size: imageBytes.length,
      storagePath: imagePath,
      storageLocationId: LEGACY_STORAGE_LOCATION.id,
      relativeObjectKey: randomUUID(),
    }));
  }

  async function assertThumbnail(fileId: number) {
    const png = await previews.getThumbnail(owner.id, fileId);
    expect(await sharp(png).metadata()).toMatchObject({
      format: "png",
      width: 20,
      height: 12,
    });
  }

  it("allows an image with active nested ancestors and mirrors", async () => {
    const root = await createFolder(owner.id);
    const nested = await createFolder(owner.id, root.id);
    const image = await createImage(nested.id);

    await assertThumbnail(image.id);
    await expect(previews.getThumbnail(other.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies old preview of an individually deleted file", async () => {
    const image = await createImage(null);

    await expect(previews.getPreview(owner.id, image.id))
      .resolves.toMatchObject({ type: "image", mimeType: "image/png" });

    await files.removeFile(owner.id, image.id);

    await expect(previews.getPreview(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies old preview below a deleted ancestor", async () => {
    const root = await createFolder(owner.id);
    const nested = await createFolder(owner.id, root.id);
    const image = await createImage(nested.id);

    await files.removeFolder(owner.id, root.id);

    await expect(previews.getPreview(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies old preview when a legacy mirror is missing", async () => {
    const root = await createFolder(owner.id);
    const image = await createImage(root.id);

    await db.getRepository(FileEntity).delete({
      userId: owner.id,
      folderId: root.id,
      isFolder: true,
    });

    await expect(previews.getPreview(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies an image after deleting its ancestor, then permits restoration", async () => {
    const root = await createFolder(owner.id);
    const nested = await createFolder(owner.id, root.id);
    const image = await createImage(nested.id);

    await files.removeFolder(owner.id, root.id);

    expect(await db.getRepository(FileEntity)
      .findOneByOrFail({ id: image.id }))
      .toMatchObject({ isDeleted: false });

    await expect(previews.getThumbnail(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);

    await files.restoreFolder(owner.id, root.id);
    await assertThumbnail(image.id);
  });

  it.each(["missing", "deleted", "mismatched"])(
    "denies a folder with a %s mirror",
    async (state) => {
      const root = await createFolder(owner.id);
      const image = await createImage(root.id);
      const entries = db.getRepository(FileEntity);
      const mirror = await entries.findOneByOrFail({
        userId: owner.id,
        folderId: root.id,
        isFolder: true,
      });

      if (state === "missing") {
        await entries.delete({ id: mirror.id });
      } else if (state === "deleted") {
        await entries.update(mirror.id, { isDeleted: true });
      } else {
        await entries.update(mirror.id, { parentId: root.id });
      }

      await expect(previews.getThumbnail(owner.id, image.id))
        .rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it("denies cyclic ancestry", async () => {
    const root = await createFolder(owner.id);
    const nested = await createFolder(owner.id, root.id);
    const image = await createImage(nested.id);

    await db.getRepository(FolderEntity)
      .update(root.id, { parentId: nested.id });
    await db.getRepository(FileEntity)
      .update({ folderId: root.id, isFolder: true }, {
        parentId: nested.id,
      });

    await expect(previews.getThumbnail(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies ancestry crossing into another user's folder", async () => {
    const foreign = await createFolder(other.id);
    const root = await createFolder(owner.id);
    const image = await createImage(root.id);

    await db.getRepository(FolderEntity)
      .update(root.id, { parentId: foreign.id });
    await db.getRepository(FileEntity)
      .update({ folderId: root.id, isFolder: true }, {
        parentId: foreign.id,
      });

    await expect(previews.getThumbnail(owner.id, image.id))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("bounds blocked PostgreSQL reads after abort signal", async () => {
    const image = await createImage(null);
    const blocker = db.createQueryRunner();
    let pending: Promise<Buffer> | undefined;
    let controller: AbortController | undefined;

    await blocker.connect();

    try {
      await blocker.startTransaction();

      // Simulate a concurrent metadata writer holding FOR UPDATE.
      const locked = await blocker.query(
        "SELECT id FROM users WHERE id=$1 FOR UPDATE",
        [owner.id],
      );
      expect(locked).toHaveLength(1);

      controller = new AbortController();
      pending = previews.getThumbnail(
        owner.id,
        image.id,
        controller.signal,
      );

      const settled = pending.then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // Observe the actual PostgreSQL lock wait before aborting.
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [row] = await db.query(
          `SELECT COUNT(*)::int AS total
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query LIKE '%users WHERE id=$1 FOR SHARE%'`,
        );
        if (Number(row.total) > 0) {
          blocked = true;
          break;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 20),
        );
      }

      expect(blocked).toBe(true);
      controller.abort();

      // The slot must remain occupied until PostgreSQL settles.
      const state = previews as unknown as {
        activeThumbnails: number;
      };
      expect(state.activeThumbnails).toBe(1);

      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      expect(outcome.error)
        .toBeInstanceOf(ServiceUnavailableException);
      expect(state.activeThumbnails).toBe(0);
    } finally {
      controller?.abort();
      if (blocker.isTransactionActive) {
        await blocker.rollbackTransaction();
      }
      await blocker.release();
      if (pending) await Promise.allSettled([pending]);
    }

    // Pool connection and processing slot recover.
    await assertThumbnail(image.id);
  }, 20_000);

  it("blocks individual file deletion until thumbnail reading finishes", async () => {
    const image = await createImage(null);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });

    let notify!: () => void;
    const reached = new Promise<void>((resolve) => {
      notify = resolve;
    });

    const target = previews as unknown as {
      readBoundedImage(filePath: string): Promise<Buffer>;
    };
    const originalRead = target.readBoundedImage.bind(previews);

    const spy = jest.spyOn(target, "readBoundedImage")
      .mockImplementation(async (filePath) => {
        notify();
        await hold;
        return originalRead(filePath);
      });

    let thumbnail: Promise<Buffer> | undefined;
    let deletion: Promise<unknown> | undefined;

    try {
      thumbnail = previews.getThumbnail(owner.id, image.id);
      await reached;

      deletion = files.removeFile(owner.id, image.id);

      const deletedEarly = await Promise.race([
        deletion.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100)),
      ]);

      expect(deletedEarly).toBe(false);

      release();
      const png = await thumbnail;
      expect((await sharp(png).metadata()).format).toBe("png");

      await deletion;
      const updated = await db.getRepository(FileEntity)
        .findOneByOrFail({ id: image.id });
      expect(updated.isDeleted).toBe(true);

      await expect(previews.getThumbnail(owner.id, image.id))
        .rejects.toBeInstanceOf(NotFoundException);
    } finally {
      release();
      if (thumbnail && deletion) {
        await Promise.allSettled([thumbnail, deletion]);
      }
      spy.mockRestore();
    }
  }, 20_000);

  it("blocks concurrent folder deletion until image reading finishes", async () => {
    const root = await createFolder(owner.id);
    const image = await createImage(root.id);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });

    let notify!: () => void;
    const reached = new Promise<void>((resolve) => { notify = resolve; });

    const target = previews as unknown as {
      readBoundedImage(filePath: string): Promise<Buffer>;
    };
    const original = target.readBoundedImage.bind(previews);

    const spy = jest.spyOn(target, "readBoundedImage")
      .mockImplementation(async (filePath) => {
        notify();
        await hold;
        return original(filePath);
      });

    let thumbnail: Promise<Buffer> | undefined;
    let deletion: Promise<unknown> | undefined;

    try {
      thumbnail = previews.getThumbnail(owner.id, image.id);
      await reached;
      deletion = files.removeFolder(owner.id, root.id);

      const deletedEarly = await Promise.race([
        deletion.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100)),
      ]);
      expect(deletedEarly).toBe(false);

      release();
      const png = await thumbnail;
      expect((await sharp(png).metadata()).format).toBe("png");

      await deletion;
      await expect(previews.getThumbnail(owner.id, image.id))
        .rejects.toBeInstanceOf(NotFoundException);
    } finally {
      release();
      if (thumbnail && deletion) {
        await Promise.allSettled([thumbnail, deletion]);
      }
      spy.mockRestore();
    }
  }, 20_000);
});
