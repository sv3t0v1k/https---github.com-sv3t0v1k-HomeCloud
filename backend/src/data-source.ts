import { DataSource } from "typeorm";
import { UserEntity } from "./entities/user.entity";
import { FileEntity } from "./entities/file.entity";
import { FolderEntity } from "./entities/folder.entity";
import { ShareLinkEntity } from "./entities/share-link.entity";
import { UploadSessionEntity } from "./entities/upload-session.entity";
import { RefreshTokenEntity } from "./entities/refresh-token.entity";

export default new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [
    UserEntity,
    FileEntity,
    FolderEntity,
    ShareLinkEntity,
    UploadSessionEntity,
    RefreshTokenEntity,
  ],
  migrations: [__dirname + "/migrations/*{.ts,.js}"],
});
