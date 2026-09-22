import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { FileEntity } from "../entities/file.entity";
import { FolderEntity } from "../entities/folder.entity";
import { RefreshTokenEntity } from "../entities/refresh-token.entity";
import { ShareLinkEntity } from "../entities/share-link.entity";
import { UploadSessionEntity } from "../entities/upload-session.entity";
import { UserEntity } from "../entities/user.entity";
import { StorageService } from "../storage/storage.service";
import { UsersService } from "../users/users.service";
import { UploadsService } from "./uploads.service";

jest.mock(
  "file-type",
  () => ({
    fileTypeFromBuffer: jest.fn().mockResolvedValue(undefined),
  }),
  { virtual: true },
);

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
        UserEntity,
        FileEntity,
        FolderEntity,
        ShareLinkEntity,
        UploadSessionEntity,
        RefreshTokenEntity,
      ],
    });
    await dataSource.initialize();
    const config = new ConfigService({
      STORAGE_PATH: storageRoot,
      MAX_FILE_SIZE: 1024 * 1024,
      MAX_TOTAL_SIZE: 1024 * 1024,
      MAX_CHUNK_SIZE: 1024 * 1024,
      ALLOWED_UPLOAD_MIME_TYPES: "application/octet-stream",
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
    const completed = await dataSource
      .getRepository(UploadSessionEntity)
      .findOneByOrFail({
        uploadId: created.uploadId,
        userId: user.id,
      });
    expect(completed.status).toBe("completed");
  });
});
