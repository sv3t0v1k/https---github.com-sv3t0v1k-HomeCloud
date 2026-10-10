import { DataSource } from "typeorm";
import { StorageLocationEntity } from "./entities/storage-location.entity";
import { UserEntity } from "./entities/user.entity";
import { FileEntity } from "./entities/file.entity";
import { FolderEntity } from "./entities/folder.entity";
import { ShareLinkEntity } from "./entities/share-link.entity";
import { UploadWorkspaceEntity } from "./entities/upload-workspace.entity";
import { UploadSessionEntity } from "./entities/upload-session.entity";
import { UploadChunkEntity } from "./entities/upload-chunk.entity";
import { DownloadCapabilityEntity } from "./entities/download-capability.entity";
import { RefreshTokenEntity } from "./entities/refresh-token.entity";

export default new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [
    StorageLocationEntity,
    UserEntity,
    FileEntity,
    FolderEntity,
    ShareLinkEntity,
    UploadWorkspaceEntity,
    UploadSessionEntity,
    UploadChunkEntity,
    DownloadCapabilityEntity,
    RefreshTokenEntity,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
});
