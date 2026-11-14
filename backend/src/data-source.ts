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
import { PublicShareOperationEntity } from "./entities/public-share-operation.entity";
import { assertInheritedRootFence } from "./uploads/inherited-root-fence";

class FencedDataSource extends DataSource {
  async initialize(): Promise<this> {
    // The datasource is also loaded by CLI aliases and absolute CLI paths
    // that do not match entrypoint's supported command forms. Require the
    // kernel fence before any production connection can mutate the schema.
    if (process.platform === "linux") {
      assertInheritedRootFence();
    }
    return super.initialize();
  }
}

export default new FencedDataSource({
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
    PublicShareOperationEntity,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
});
