import { DataSource } from "typeorm";
import { UserEntity } from "./src/entities/user.entity";
import { FileEntity } from "./src/entities/file.entity";
import { FolderEntity } from "./src/entities/folder.entity";
import { ShareLinkEntity } from "./src/entities/share-link.entity";
import { UploadSessionEntity } from "./src/entities/upload-session.entity";
import { RefreshTokenEntity } from "./src/entities/refresh-token.entity";

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
  migrations: [__dirname + "/src/migrations/*{.ts,.js}"],
});
