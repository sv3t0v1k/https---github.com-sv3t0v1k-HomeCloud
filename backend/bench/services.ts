import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DataSource } from "typeorm";
import { RefreshTokenEntity } from "../src/entities/refresh-token.entity";
import { FileEntity } from "../src/entities/file.entity";
import { FolderEntity } from "../src/entities/folder.entity";
import { UserEntity } from "../src/entities/user.entity";
import { ShareLinkEntity } from "../src/entities/share-link.entity";
import { UploadChunkEntity } from "../src/entities/upload-chunk.entity";
import { UploadSessionEntity } from "../src/entities/upload-session.entity";
import { StorageService } from "../src/storage/storage.service";
import { UsersService } from "../src/users/users.service";
import { FilesService } from "../src/files/files.service";
import { UploadsService } from "../src/uploads/uploads.service";
import { SharingService } from "../src/sharing/sharing.service";
import { ConfigService } from "@nestjs/config";

/**
 * Dedicated benchmark identity. All fixture rows are owned by this user so
 * cleanup can target exactly them without touching unrelated data.
 */
export const BENCH_USER_EMAIL = "bench@homecloud.local";
export const BENCH_USER_PASSWORD = "bench-password-2026";
export const BENCH_USER_NAME = "bench";

function benchStoragePath(): string {
  const dir = path.join(os.tmpdir(), `homecloud-bench-storage-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface BenchServices {
  dataSource: DataSource;
  storageService: StorageService;
  usersService: UsersService;
  filesService: FilesService;
  uploadsService: UploadsService;
  sharingService: SharingService;
}

export function buildServices(dataSource: DataSource): BenchServices {
  const configService = new ConfigService({
    STORAGE_PATH: benchStoragePath(),
    MAX_SHARE_SIZE: 100 * 1024 * 1024,
    MAX_FILE_SIZE: 0,
    MAX_TOTAL_SIZE: 10 * 1024 * 1024 * 1024,
    MAX_CHUNK_SIZE: 50 * 1024 * 1024,
    UPLOAD_SESSION_TTL_HOURS: 24,
  });

  const storageService = new StorageService(configService);
  const usersService = new UsersService(dataSource.getRepository(UserEntity));
  const filesService = new FilesService(
    dataSource.getRepository(FileEntity),
    dataSource.getRepository(FolderEntity),
    storageService,
    usersService,
  );
  const uploadsService = new UploadsService(
    dataSource.getRepository(UploadSessionEntity),
    dataSource.getRepository(FileEntity),
    dataSource.getRepository(FolderEntity),
    storageService,
    usersService,
    configService,
  );
  const sharingService = new SharingService(
    dataSource.getRepository(ShareLinkEntity),
    dataSource.getRepository(FileEntity),
    dataSource.getRepository(UserEntity),
    configService,
    storageService,
  );

  return {
    dataSource,
    storageService,
    usersService,
    filesService,
    uploadsService,
    sharingService,
  };
}

export async function createDataSource(databaseUrl: string): Promise<DataSource> {
  const ds = new DataSource({
    type: "postgres",
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    entities: [
      UserEntity,
      FileEntity,
      FolderEntity,
      ShareLinkEntity,
      UploadSessionEntity,
      UploadChunkEntity,
      RefreshTokenEntity,
    ],
  });
  await ds.initialize();
  return ds;
}

export async function closeDataSource(ds: DataSource): Promise<void> {
  await ds.destroy();
}